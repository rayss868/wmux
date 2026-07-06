/**
 * migrateToEventLog — 부팅 마이그레이션 게이트(순수 로직) (envelope-design §6).
 *
 * PR2 범위: 감지→변환→검증→활성의 **순수** 결정 로직 + 워터마크 판정 + reseed 프리미티브.
 * 데몬 배선(index.ts 삽입·서비스 교체)은 PR3/4 — 여기선 레거시 상태 읽기·genesis 검증·로그
 * append를 전부 **주입**받아 서비스 의존을 갖지 않는다.
 *
 * 불변식(스펙 문면):
 *   - 변환은 레거시 channels.json을 **READ만** 한다(§6.1-2). 실패 시 manifest 미기록 →
 *     다음 부트가 재감지·재시도(멱등). **데이터 손실 0**(§6.1 실패 롤백 안전).
 *   - 순서 불변식(§6.1-2): genesis(durable) → machine-id(durable) → 빈 세그먼트(+dir fsync)
 *     → 검증 → **manifest(durable) write = 완료 표지**. manifest가 machineId를 참조하므로
 *     machine-id durable이 반드시 선행.
 *   - genesis "불변" 계약(§6.2)은 manifest 활성 이후 발효 — 완결 전 재시도 덮어쓰기는 위반 아님.
 *   - 다운그레이드 감지는 **워터마크(lamport+stateHash)**(§6.4c). stateHash는 워터마크 필드
 *     자신을 제외한 정준 직렬화 해시 — 구 데몬의 load→save 왕복이 lamport 값을 보존해
 *     lamport 단독으론 전진을 감지 못하기 때문(구 데몬은 hash를 재계산할 줄 모른다).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';

import {
  EMPTY_CHANNEL_STATE,
  type ChannelState,
} from '../../shared/channels';
import {
  makeEnvelope,
  type AuthContext,
  type EventOrigin,
  type EventEnvelopeDraft,
} from '../../shared/eventlog';
import {
  resolveMachineId,
  recoverMachineIdFromRecords,
} from '../../shared/machineId';
import {
  SnapshotStore,
  SNAPSHOT_DIRNAME,
  GENESIS_CHANNEL_REF,
  CHANNEL_PROJECTION_REF,
  reseedRef,
} from './SnapshotStore';
import {
  EVENTLOG_FORMAT_VERSION,
  readManifest,
  writeManifest,
  type EventLogManifest,
} from './EventLogManifest';

// AppendOnlyLog(PR1)의 세그먼트 명명 관례와 동일해야 한다(부트 스캔이 이 이름을 인식).
const SEGMENT_RE = /^(\d{8})\.ndjson$/;

function segmentName(n: number): string {
  return `${String(n).padStart(8, '0')}.ndjson`;
}

// ── 워터마크(§6.4c) ────────────────────────────────────────────────────

/** channels.json에 dual-write가 심는 워터마크(§6.4c). 순서 비관여, 다운그레이드 감지 전용. */
export interface EventLogWatermark {
  /** 이 파일에 마지막으로 반영된 로그 hwm. */
  lamport: number;
  /** 워터마크 필드 자신을 제외한 상태 직렬화의 해시. */
  stateHash: string;
}

const WATERMARK_KEY = 'eventLogWatermark';

/**
 * 정준 직렬화: 객체 키를 재귀 정렬(배열 순서는 보존). 구 데몬의 load→save 왕복이 키 순서를
 * 어떻게 두든 해시가 **내용에만** 의존하도록 한다.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(o).sort()) {
      out[key] = canonicalize(o[key]);
    }
    return out;
  }
  return value;
}

/** 워터마크 필드를 뗀 상태 사본(해시·reseed projection용). */
function stripWatermark(state: unknown): unknown {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return state;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
    if (k === WATERMARK_KEY) continue;
    out[k] = v;
  }
  return out;
}

/** §6.4c: 워터마크 필드 자신을 제외한 상태의 정준 직렬화 해시. */
export function computeStateHash(state: unknown): string {
  const json = JSON.stringify(canonicalize(stripWatermark(state)));
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * dual-write가 channels.json에 심는 워터마크 스탬프(PR3 사용, PR2는 계약 테스트).
 * 반환은 새 객체 — 입력을 변형하지 않는다.
 */
export function stampWatermark<T extends object>(
  state: T,
  lamport: number,
): T & { eventLogWatermark: EventLogWatermark } {
  const stateHash = computeStateHash(state);
  return {
    ...state,
    eventLogWatermark: { lamport, stateHash },
  } as T & { eventLogWatermark: EventLogWatermark };
}

function extractWatermark(state: unknown): EventLogWatermark | null {
  if (state === null || typeof state !== 'object') return null;
  const wm = (state as Record<string, unknown>)[WATERMARK_KEY];
  if (wm === null || typeof wm !== 'object') return null;
  const w = wm as Record<string, unknown>;
  if (typeof w['lamport'] !== 'number' || typeof w['stateHash'] !== 'string') {
    return null;
  }
  return { lamport: w['lamport'], stateHash: w['stateHash'] };
}

/** 워터마크 부트 판정(§6.4c). */
export type WatermarkVerdict =
  | { kind: 'unchanged'; watermark: EventLogWatermark }
  | {
      kind: 'downgrade-write';
      reason: 'hash-mismatch' | 'absent';
      previous: EventLogWatermark | null;
    };

/**
 * §6.4c 부트 판정: stateHash 일치 → 무변경(정상 재시작, reseed 없음 — 오발동 0).
 * 불일치 또는 워터마크 부재(구 데몬이 신 포맷 도입 전으로 되돌린 케이스) → 구-데몬 쓰기 증거 → reseed.
 */
export function evaluateWatermark(state: unknown): WatermarkVerdict {
  const wm = extractWatermark(state);
  if (wm === null) {
    return { kind: 'downgrade-write', reason: 'absent', previous: null };
  }
  const actual = computeStateHash(state);
  if (actual === wm.stateHash) {
    return { kind: 'unchanged', watermark: wm };
  }
  return { kind: 'downgrade-write', reason: 'hash-mismatch', previous: wm };
}

// ── 감지(§6.1-1 3분기) ─────────────────────────────────────────────────

export type MigrationDetection =
  | { kind: 'active'; manifest: EventLogManifest }
  | { kind: 'migrate' } // (a) 세그먼트 0개 — first-boot 또는 레거시 마이그레이션
  | { kind: 'reconstruct-manifest' } // (b) 빈 세그먼트 + genesis 유효 — 재구성만
  | { kind: 'quarantine-and-migrate'; segments: string[] }; // (c) 그 외 비정상 — 격리 후 재시도

export interface DetectOptions {
  eventsDir: string;
  /** genesis 재로드 검증(§6.1-3). PR3: ChannelStateWriter.isChannelState. */
  validateProjection: (data: unknown) => boolean;
}

/**
 * manifest 존재 시 → active(로그 모드). 부재 시 §6.1-1 3분기:
 *   (a) 세그먼트 0개 → migrate
 *   (b) 세그먼트 전부 빈 것 + genesis 검증 성공 → reconstruct-manifest(재변환 없음)
 *   (c) 그 외(비어있지-않은 세그먼트, 또는 빈 세그먼트인데 genesis 부재/손상) → quarantine 후 재시도
 * fail-safe: 설명 불가능한 상태에서 조용히 로그 모드로 진행하지 않는다(§6.1-1 (c) 근거).
 */
export function detectMigrationState(opts: DetectOptions): MigrationDetection {
  const manifest = readManifest(opts.eventsDir);
  if (manifest) return { kind: 'active', manifest };

  const segFiles = listSegmentFiles(opts.eventsDir);
  if (segFiles.length === 0) {
    return { kind: 'migrate' };
  }
  const allEmpty = segFiles.every((f) =>
    isFileEmpty(path.join(opts.eventsDir, f)),
  );
  if (allEmpty && genesisValid(opts.eventsDir, opts.validateProjection)) {
    return { kind: 'reconstruct-manifest' };
  }
  return { kind: 'quarantine-and-migrate', segments: segFiles };
}

// ── 변환→검증→활성(§6.1) ───────────────────────────────────────────────

export interface MigrateOptions {
  eventsDir: string;
  /** 레거시 상태 읽기(PR3: () => channelStateWriter.load()). null = channels.json 부재(first-boot). */
  readLegacyState: () => ChannelState | null;
  /** genesis 재로드 검증(§6.1-3). PR3: ChannelStateWriter.isChannelState. */
  validateProjection: (data: unknown) => boolean;
  /**
   * A(3모델 패널): 마이그레이션 완결 직후, 워터마크 스탬프된 레거시 상태를 channels.json에
   * 되쓰는 훅. **PR3 배선 계약: ChannelStateWriter durable 저장에 연결하라.** 이 되쓰기가
   * 없으면 첫 dual-write 전 부트의 evaluateWatermark가 absent→downgrade로 오발동한다
   * (pristine 창). 훅 미주입(레거시 호출자) 시에도 반환값 legacyStamped로 저장 의무가
   * 호출자에게 전달된다. 훅 실패는 완결을 되돌리지 않는다(manifest가 이미 표지 — warn만).
   */
  writeLegacyStamped?: (
    stamped: ChannelState & { eventLogWatermark: EventLogWatermark },
  ) => void;
  clock?: () => number;
}

export interface MigrateResult {
  detection: MigrationDetection['kind'];
  manifest: EventLogManifest;
  machineId: string;
  /** (c) 분기에서 격리된 세그먼트 경로(보존, 삭제 아님). */
  quarantined: string[];
  /**
   * A: 워터마크 스탬프된 레거시 상태(변환·재구성 완결 경로에서 생성). 호출자는 이를
   * channels.json에 durable 저장해야 pristine 창이 닫힌다(훅이 이미 수행했어도 동일 값).
   */
  legacyStamped?: ChannelState & { eventLogWatermark: EventLogWatermark };
}

/** 변환 실패 = 마이그레이션 중단(레거시 무손상). manifest 미기록 → 다음 부트가 재시도. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * 부팅 마이그레이션 게이트(§6.1). 감지 결과에 따라 변환/재구성/격리+변환/무동작(active)을 수행.
 * manifest durable write가 완료 표지이므로, 그 전 어느 지점의 크래시도 재시도로 멱등하게 흡수된다.
 */
export function runMigration(opts: MigrateOptions): MigrateResult {
  const detection = detectMigrationState({
    eventsDir: opts.eventsDir,
    validateProjection: opts.validateProjection,
  });

  if (detection.kind === 'active') {
    // §6.1-4 직후 크래시(manifest 있음, 첫 append 전) → 재마이그레이션 미발생.
    return {
      detection: 'active',
      manifest: detection.manifest,
      machineId: detection.manifest.machineId,
      quarantined: [],
    };
  }
  if (detection.kind === 'reconstruct-manifest') {
    return reconstructManifest(opts);
  }
  if (detection.kind === 'quarantine-and-migrate') {
    const quarantined = quarantineSegments(opts.eventsDir, opts.clock ?? Date.now);
    // G②(§6.1-1(c)): 격리는 보존이지 복구가 아니다 — 수동 복구 대상임을 명시 고지.
    console.warn(
      `[migrateToEventLog] 커밋 세그먼트 격리됨 — events/quarantine/ 수동 복구 대상: ${quarantined.join(', ')}`,
    );
    return convertAndActivate(opts, quarantined);
  }
  // detection.kind === 'migrate'
  return convertAndActivate(opts, []);
}

/** (b) 빈 세그먼트 + genesis 유효 → 재변환 없이 manifest만 재구성해 완결(§6.1-1 (b)). */
function reconstructManifest(opts: MigrateOptions): MigrateResult {
  const store = snapshotStoreFor(opts.eventsDir);
  const genesis = store.load<ChannelState>(
    GENESIS_CHANNEL_REF,
    opts.validateProjection,
    { preserveOnCorruption: true }, // G①: genesis는 read 경로도 이동 금지(§6.2)
  );
  if (!genesis) {
    // 판정 후 경합으로 genesis가 사라진 극단 — fail-safe로 재변환.
    return convertAndActivate(opts, []);
  }
  const machineId = resolveMachineIdFor(opts.eventsDir); // 기존 값 재사용(§6.1-1 멱등)
  const manifest: EventLogManifest = {
    formatVersion: EVENTLOG_FORMAT_VERSION,
    machineId,
    genesisRef: GENESIS_CHANNEL_REF,
    reseedRefs: [],
    snapshotLamport: genesis.snapshotLamport,
    activeSegment: highestSegmentNum(opts.eventsDir),
  };
  writeManifest(opts.eventsDir, manifest);
  // A: (b)도 완결 경로 — pristine 창을 동일하게 닫는다. 재변환은 아니므로 레거시 읽기는
  // 훅이 있을 때만(스탬프 목적 READ, 기존 "재변환 없음" 계약과 별개 축). 실패는 warn만
  // (manifest가 이미 완료 표지 — 되돌리지 않는다).
  let legacyStamped:
    | (ChannelState & { eventLogWatermark: EventLogWatermark })
    | undefined;
  if (opts.writeLegacyStamped) {
    try {
      const legacy = opts.readLegacyState() ?? EMPTY_CHANNEL_STATE;
      legacyStamped = stampWatermark(
        stripWatermark(legacy) as ChannelState,
        manifest.snapshotLamport,
      );
      opts.writeLegacyStamped(legacyStamped);
    } catch (err) {
      console.warn(
        '[migrateToEventLog] 재구성 후 워터마크 스탬프 실패(완결 유지, 첫 dual-write까지 pristine 창 잔존):',
        err,
      );
    }
  }
  return {
    detection: 'reconstruct-manifest',
    manifest,
    machineId,
    quarantined: [],
    legacyStamped,
  };
}

/** 2~4단계: 변환(genesis+machine-id+빈 세그먼트) → 검증 → 활성(manifest). */
function convertAndActivate(
  opts: MigrateOptions,
  quarantined: string[],
): MigrateResult {
  // 2단계 변환 — 레거시 READ만(레거시 무손상). 예외는 중단으로 승격(manifest 미기록).
  let legacy: ChannelState | null;
  try {
    legacy = opts.readLegacyState();
  } catch (err) {
    throw new MigrationError(
      `레거시 상태 읽기 실패 — 마이그레이션 중단(레거시 무손상): ${String(err)}`,
    );
  }
  const projection: ChannelState = legacy ?? EMPTY_CHANNEL_STATE;

  const store = snapshotStoreFor(opts.eventsDir);
  // 1. genesis durable write(snapshotLamport=0) — projection 내용 검증 동반.
  store.writeDurableSync(
    GENESIS_CHANNEL_REF,
    projection,
    0,
    opts.validateProjection,
  );

  // 2. machine-id durable(기존 있으면 재사용) — **manifest 전에**(순서 불변식 §6.1-2).
  const machineId = resolveMachineIdFor(opts.eventsDir);

  // 3. 빈 로그 세그먼트 + 디렉토리 fsync(§6.1-2). 재시도면 기존 세그먼트 재사용(멱등).
  const activeSegment = ensureEmptySegment(opts.eventsDir);

  // 4. 검증: 방금 쓴 genesis를 재로드해 라운드트립 확인(§6.1-3). 실패=중단(레거시 무손상).
  const check = store.load<ChannelState>(
    GENESIS_CHANNEL_REF,
    opts.validateProjection,
    { preserveOnCorruption: true }, // G①: genesis는 read 경로도 이동 금지(§6.2)
  );
  if (!check) {
    throw new MigrationError(
      'genesis 재로드 검증 실패 — 마이그레이션 중단(manifest 미기록, 레거시 무손상)',
    );
  }

  // 5. 활성: manifest durable write = "마이그레이션 완료" 원자적 표지(§6.1-4).
  const manifest: EventLogManifest = {
    formatVersion: EVENTLOG_FORMAT_VERSION,
    machineId,
    genesisRef: GENESIS_CHANNEL_REF,
    reseedRefs: [],
    snapshotLamport: 0,
    activeSegment,
  };
  writeManifest(opts.eventsDir, manifest);

  // 6. A(3모델 패널): 완결 직후 레거시에 워터마크 스탬프(lamport 0 = genesis 베이스라인) —
  // 첫 dual-write 전 부트의 absent 오발동(pristine 창)을 닫는다. 훅 실패는 완결을
  // 되돌리지 않는다(warn — 다음 dual-write가 스탬프를 회복).
  const legacyStamped = stampWatermark(projection, 0);
  if (opts.writeLegacyStamped) {
    try {
      opts.writeLegacyStamped(legacyStamped);
    } catch (err) {
      console.warn(
        '[migrateToEventLog] 마이그레이션 후 워터마크 스탬프 실패(완결 유지, 첫 dual-write까지 pristine 창 잔존):',
        err,
      );
    }
  }

  return {
    detection: quarantined.length > 0 ? 'quarantine-and-migrate' : 'migrate',
    manifest,
    machineId,
    quarantined,
    legacyStamped,
  };
}

// ── reseed(§6.4c) ──────────────────────────────────────────────────────

export interface ReseedOptions {
  eventsDir: string;
  manifest: EventLogManifest;
  /** 구-데몬 쓰기가 반영된 현재 channels.json 상태(워터마크 필드 포함 가능). */
  downgradeState: ChannelState;
  /** 로그 append(PR3: AppendOnlyLog.append 바인딩). 마커 lamport 발급을 위해 선행 호출. */
  append: (draft: EventEnvelopeDraft) => Promise<boolean>;
  /** 현재 lamport hwm 읽기(PR3: () => log.lamportHwm). race 어서션(D)과 마커 lamport 확정에 사용. */
  lamportHwm: () => number;
  origin: Omit<EventOrigin, 'seq'>;
  authContext: AuthContext;
  validateProjection: (data: unknown) => boolean;
  /**
   * A(3모델 패널): reseed 완결 시 markerLamport로 스탬프된 레거시 상태를 channels.json에
   * 되쓰는 훅(PR3: ChannelStateWriter durable 저장). 이 되쓰기가 없으면 stale 워터마크가
   * 다음 부트마다 같은 hash-mismatch를 재검출해 reseed-{n}이 부트마다 증식한다.
   */
  writeLegacyStamped?: (
    stamped: ChannelState & { eventLogWatermark: EventLogWatermark },
  ) => void;
  /** 재작성할 활성 projection 스냅샷 참조명(§6.4c ③). 기본 channel.json. */
  activeProjectionRef?: string;
  clock?: () => number;
}

export interface ReseedResult {
  /** 완결 여부(마커+스냅샷+manifest 전부). false면 스냅샷·manifest 부작용 0 — 다음 부트 재시도. */
  ok: boolean;
  /** ok=false의 사유. append-failed = 마커 미커밋 / lamport-race = 부트-단독 전제 위반(D). */
  failReason?: 'append-failed' | 'lamport-race';
  reseedRef: string;
  markerLamport: number;
  stateHash: string;
  manifest: EventLogManifest;
  /** A: markerLamport로 스탬프된 레거시 상태 — 호출자가 저장해야 reseed 재검출 루프가 닫힌다. */
  legacyStamped?: ChannelState & { eventLogWatermark: EventLogWatermark };
}

/**
 * 다운그레이드 재-시드(§6.4c). reseed는 **스냅샷**이 상태를 운반하고 로그엔 **마커**만 남긴다
 * (요약 델타만으론 최신 스냅샷 손상 시 구-데몬 구간을 복구 불가하기 때문).
 *
 * 순서(계약): 마커의 lamport가 스냅샷의 snapshotLamport이므로 **마커를 먼저 append**해 lamport를
 * 확정한 뒤 reseed·활성 스냅샷을 쓰고, **manifest write로 원자적 완료**(§6.1-4 동형). 스펙 §6.4c의
 * 나열 순서(스냅샷①/마커②)는 lamport 의존성을 만족시키려면 마커 선행으로 정정된다.
 *
 * 전제(코드로 강제 — D): **부트 단독 실행**. 동시 append가 끼면 hwm이 마커의 lamport가 아니게
 * 되어 reseed snapshotLamport가 마커 이후 이벤트를 건너뛴다(replay 유실) → before+1 어서션
 * 위반 시 중단(failReason='lamport-race', 스냅샷·manifest 미기록 — 다음 부트 재시도).
 */
export async function performReseed(opts: ReseedOptions): Promise<ReseedResult> {
  const clock = opts.clock ?? Date.now;
  const store = snapshotStoreFor(opts.eventsDir);
  const activeRef = opts.activeProjectionRef ?? CHANNEL_PROJECTION_REF;

  // reseed projection = 구-데몬 쓰기 반영분에서 워터마크 필드 제거(순수 도메인 상태).
  const cleanState = stripWatermark(opts.downgradeState) as ChannelState;
  const stateHash = computeStateHash(opts.downgradeState);

  const n = opts.manifest.reseedRefs.length + 1;
  const ref = reseedRef(n);
  const failResult = (
    failReason: 'append-failed' | 'lamport-race',
  ): ReseedResult => ({
    ok: false,
    failReason,
    reseedRef: ref,
    markerLamport: 0,
    stateHash,
    manifest: opts.manifest,
  });

  // 마커 먼저 append → lamport 확정. 마커 payload는 감지 사실을 감사 가능하게 남긴다.
  const marker: EventEnvelopeDraft = makeEnvelope({
    domain: 'channel',
    payload: {
      kind: 'legacy-reseed',
      reseedNumber: n,
      stateHash,
      detectedAt: clock(),
    },
    origin: opts.origin,
    authContext: opts.authContext,
  });
  const before = opts.lamportHwm(); // D: race 어서션 기준점
  const appended = await opts.append(marker);
  if (!appended) {
    // 마커 커밋 실패 → 정본에 감지 사실이 안 남으면 무성 폐기 위반 → reseed 중단(재시도 대상).
    return failResult('append-failed');
  }
  const markerLamport = opts.lamportHwm();
  if (markerLamport !== before + 1) {
    // D: 부트-단독 전제 위반(동시 append 개입) — hwm이 마커의 lamport라는 보장이 깨졌다.
    // 이대로 진행하면 snapshotLamport가 마커 이후 이벤트를 건너뛰어 replay 유실 → 중단.
    console.warn(
      `[migrateToEventLog] reseed lamport race 감지(before=${before}, after=${markerLamport}) — 중단, 다음 부트 재시도`,
    );
    return failResult('lamport-race');
  }

  // reseed 스냅샷(genesis급 immutable) + 활성 projection 스냅샷 재작성 — 둘 다 snapshotLamport=markerLamport.
  store.writeDurableSync(ref, cleanState, markerLamport, opts.validateProjection);
  store.writeDurableSync(
    activeRef,
    cleanState,
    markerLamport,
    opts.validateProjection,
  );

  // manifest 갱신(durable) = 완료 표지. reseedRefs 확장 + snapshotLamport 전진 → 이후 replay는
  // lamport > markerLamport만 적용(reseed 이전 이벤트와 이중 적용 없음, §6.4c).
  const manifest: EventLogManifest = {
    ...opts.manifest,
    reseedRefs: [...opts.manifest.reseedRefs, ref],
    snapshotLamport: markerLamport,
  };
  writeManifest(opts.eventsDir, manifest);

  // A: stale 워터마크 갱신 — markerLamport로 재스탬프해 되쓴다. 실패는 warn만(완결 유지;
  // 미갱신 시 다음 부트가 1회 더 reseed하고 그때 재시도된다 — 무한 증식과 구별되는 관측 가능 잔여).
  const legacyStamped = stampWatermark(cleanState, markerLamport);
  if (opts.writeLegacyStamped) {
    try {
      opts.writeLegacyStamped(legacyStamped);
    } catch (err) {
      console.warn(
        '[migrateToEventLog] reseed 후 워터마크 재스탬프 실패(완결 유지, 다음 부트 재검출 1회 잔여):',
        err,
      );
    }
  }

  return {
    ok: true,
    reseedRef: ref,
    markerLamport,
    stateHash,
    manifest,
    legacyStamped,
  };
}

// ── 내부 헬퍼 ──────────────────────────────────────────────────────────

function snapshotStoreFor(eventsDir: string): SnapshotStore {
  return new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
}

function genesisValid(
  eventsDir: string,
  validateProjection: (d: unknown) => boolean,
): boolean {
  // G①: 감지 단계의 genesis 검사도 read 경로 이동 금지(§6.2 불변 계약).
  return (
    snapshotStoreFor(eventsDir).load(GENESIS_CHANNEL_REF, validateProjection, {
      preserveOnCorruption: true,
    }) !== null
  );
}

function resolveMachineIdFor(eventsDir: string): string {
  return resolveMachineId(eventsDir, {
    recoverFromRecords: () =>
      recoverMachineIdFromRecords(scanSegmentRecords(eventsDir)),
  });
}

/** §8 부분 소실 복구용: 살아있는 세그먼트에서 machineId를 실을 레코드를 긁는다. */
function scanSegmentRecords(
  eventsDir: string,
): Array<{ origin?: { machineId?: unknown } }> {
  const out: Array<{ origin?: { machineId?: unknown } }> = [];
  for (const f of listSegmentFiles(eventsDir)) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(eventsDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as { origin?: { machineId?: unknown } });
      } catch {
        break; // 최초 불량에서 중단(전방 스캔 관례)
      }
    }
  }
  return out;
}

function listSegmentFiles(eventsDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(eventsDir);
  } catch {
    return [];
  }
  return entries.filter((n) => SEGMENT_RE.test(n)).sort();
}

function isFileEmpty(p: string): boolean {
  try {
    return fs.statSync(p).size === 0;
  } catch {
    return true;
  }
}

function highestSegmentNum(eventsDir: string): number {
  const files = listSegmentFiles(eventsDir);
  if (files.length === 0) return 1;
  return Math.max(...files.map((f) => Number(SEGMENT_RE.exec(f)![1])));
}

/**
 * 빈 세그먼트 존재 보장(§6.1-2). 없으면 00000001 생성. 기존 세그먼트는 **전부 빈 것일 때만**
 * 재사용한다(B③ 방어심층): 비어있지-않은 세그먼트를 활성으로 채택하면 그 외래 이벤트
 * (lamport>0)가 genesis 위 replay에 적용된다 — (c) 경로에선 quarantineSegments의 잔존 0
 * 검증이 선차단하지만, 어떤 경로로든 이 지점에 도달한 비정상은 중단이 정답이다.
 */
function ensureEmptySegment(eventsDir: string): number {
  fs.mkdirSync(eventsDir, { recursive: true });
  const files = listSegmentFiles(eventsDir);
  if (files.length > 0) {
    for (const f of files) {
      if (!isFileEmpty(path.join(eventsDir, f))) {
        throw new MigrationError(
          `비어있지-않은 세그먼트(${f})를 활성으로 채택 불가 — 마이그레이션 중단(레거시 무손상)`,
        );
      }
    }
    return highestSegmentNum(eventsDir);
  }
  const seg = path.join(eventsDir, segmentName(1));
  const fd = fs.openSync(seg, 'a'); // 생성 + append 개방
  fs.closeSync(fd);
  fsyncDir(eventsDir); // 디렉토리 엔트리 내구화(§6.1-2)
  return 1;
}

/**
 * (c) 분기: 비정상 세그먼트를 events/quarantine/으로 **격리(보존, 삭제 아님)**. 이름 충돌은
 * 클록 접미로 회피. §2.1 레이아웃의 quarantine/ 좌표를 따른다(read-time corrupted/와 목적 구분).
 *
 * B(3모델 패널): 격리 실패는 **중단**이다(best-effort 금지) — 실패를 삼키고 재변환을 진행하면
 * 격리 못 한 비어있지-않은 세그먼트가 활성으로 채택돼 외래 이벤트가 genesis 위 replay에
 * 적용된다(검증 단계는 genesis만 재로드해 못 잡음). 중단 시 레거시·세그먼트 무손상,
 * manifest 미기록 → 다음 부트 재시도.
 */
function quarantineSegments(eventsDir: string, clock: () => number): string[] {
  const qdir = path.join(eventsDir, 'quarantine');
  try {
    fs.mkdirSync(qdir, { recursive: true });
  } catch (err) {
    throw new MigrationError(
      `quarantine 디렉토리 생성 실패 — 마이그레이션 중단(레거시 무손상): ${String(err)}`,
    );
  }
  const moved: string[] = [];
  const ts = clock();
  for (const f of listSegmentFiles(eventsDir)) {
    const dest = path.join(qdir, `${f}.${ts}.bak`);
    try {
      fs.renameSync(path.join(eventsDir, f), dest);
    } catch (err) {
      throw new MigrationError(
        `세그먼트 격리 실패(${f}) — 마이그레이션 중단(레거시·세그먼트 무손상): ${String(err)}`,
      );
    }
    moved.push(dest);
  }
  fsyncDir(eventsDir);
  // B②: 격리 후 잔존 0 검증 — 잔존이 있으면 재변환의 빈-세그먼트 전제가 깨진다.
  const residual = listSegmentFiles(eventsDir);
  if (residual.length > 0) {
    throw new MigrationError(
      `격리 후 세그먼트 잔존(${residual.join(', ')}) — 마이그레이션 중단(레거시 무손상)`,
    );
  }
  return moved;
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return; // §2.3 win32 잔여
  let fd = -1;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // best-effort — 디렉토리 fsync 미지원 파일시스템은 §2.3 수용 잔여
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* noop */
      }
    }
  }
}
