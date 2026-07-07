/**
 * EventLogManifest — 이벤트 로그 manifest read/write (envelope-design §2.1·§6.1).
 *
 * 계약 요약(스펙 문면):
 *   - manifest는 **durable 전용**(§2.3 D13). write는 core.ts의 durable 옵션 위에만 얹는다 —
 *     fsync 없는 rename이 전원손실에 비내구면 재부트가 레거시를 재감지·재마이그레이션하고,
 *     그 사이 fsync로 커밋된 마이그레이션-후 이벤트가 고아화된다(패널 A1).
 *   - manifest write = "마이그레이션 완료"의 원자적 표지(§6.1-4). 부트는 manifest를 **힌트**로만
 *     쓰고 실체는 세그먼트 스캔이 정본(D15) — 이중 방어.
 *   - additive-only: 필드 추가만 허용(옵셔널). 기존 필드 제거·개명·의미변경 금지(디스크 계약).
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJSONSync, atomicReadJSONSync } from '../util/atomicWrite';

/** 현 manifest 포맷 세대. 스키마 마이그레이션 시에만 bump(부트마다 불변). */
export const EVENTLOG_FORMAT_VERSION = 1;

/**
 * daemon.ping의 `eventLogFormatVersion` additive 필드(§6.4a). 로그가 durable 활성
 * (active = 활성 manifest.formatVersion)이면 필드를 싣고, 비활성(active=undefined —
 * 레거시 폴백/마이그레이션 미완, channelEventLogDeps null 경로)이면 필드를 뺀다.
 * **필드 부재 = pre-envelope 데몬 = 레거시 세대**: B′(#342) 자동 교체 로직이 "자기가
 * 모르는 formatVersion 데몬을 만나면 재사용·교체 안 하고 fail-closed"하는 판정 입력이다
 * (B′ 판정 로직 자체는 PR5 밖 — ping이 값을 노출하는 것까지가 PR5 몫).
 */
export function pingFormatVersionField(
  active: number | undefined,
): { eventLogFormatVersion?: number } {
  return active !== undefined ? { eventLogFormatVersion: active } : {};
}

const MANIFEST_FILE = 'manifest.json';

/**
 * 이벤트 로그 manifest(§2.1). 부트 힌트이자 마이그레이션 완료 표지.
 *
 * additive-only 관례: 미래 필드는 옵셔널로만 추가한다(구 manifest 파싱 붕괴 방지).
 */
export interface EventLogManifest {
  /** 포맷 세대(§6.4a: daemon.ping이 additive 노출할 값). */
  formatVersion: number;
  /** §8: 설치 생애 영구 불변 machineId. manifest가 이 값을 참조하므로 machine-id durable이 선행. */
  machineId: string;
  /** §6.2 D14: genesis 스냅샷 참조명(snapshot/ 기준 상대). 영구 불변. */
  genesisRef: string;
  /** §6.4c: reseed 스냅샷 참조명 목록(genesis급 불변). 다운그레이드 감지마다 additive 확장. */
  reseedRefs: string[];
  /** §5: 활성 projection 스냅샷의 baseline lamport. 부트 replay는 이 값 초과만 적용. */
  snapshotLamport: number;
  /** §2.8·§3: 활성 세그먼트 번호. **힌트일 뿐** — 실체와 다르면 스캔 결과로 재작성(D15). */
  activeSegment: number;
}

/** `events/manifest.json` 경로. */
export function manifestPath(eventsDir: string): string {
  return path.join(eventsDir, MANIFEST_FILE);
}

/**
 * manifest 구조 가드. 필수 필드 존재·타입만 확인하고 **추가 필드는 거부하지 않는다**
 * (additive-only — 미래 세대가 쓴 필드를 구 코드가 조용히 통과시켜야 한다).
 */
export function isEventLogManifest(v: unknown): v is EventLogManifest {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['formatVersion'] !== 'number') return false;
  if (typeof o['machineId'] !== 'string' || o['machineId'].length === 0) {
    return false;
  }
  if (typeof o['genesisRef'] !== 'string' || o['genesisRef'].length === 0) {
    return false;
  }
  if (!Array.isArray(o['reseedRefs'])) return false;
  for (const r of o['reseedRefs']) {
    if (typeof r !== 'string') return false;
  }
  if (typeof o['snapshotLamport'] !== 'number') return false;
  if (typeof o['activeSegment'] !== 'number') return false;
  return true;
}

/**
 * manifest 로드(primary→.bak 폴백은 atomicReadJSONSync 내장). 부재/손상이면 null.
 * 손상 시에도 파일을 **이동하지 않는다**(quarantineOnCorruption:false) — manifest는
 * 로그 모드 활성의 완료 표지라, read-time 격리로 소멸하면 다음 부트가 "부재"로
 * 오분류해 재마이그레이션(로그-only 커밋 퇴행)한다. 부재/손상의 구분은
 * manifestFileExists가 담당한다(패널 델타).
 */
export function readManifest(eventsDir: string): EventLogManifest | null {
  return atomicReadJSONSync<EventLogManifest>(manifestPath(eventsDir), {
    validate: isEventLogManifest,
    quarantineOnCorruption: false,
  });
}

/**
 * manifest 파일 실존 여부(primary 또는 .bak) — 파싱 성공과 무관. "존재하나 판독
 * 불가"(손상)를 "부재"와 구분하는 물증: 손상 manifest는 과거 로그-모드 활성의
 * 증거이므로 재마이그레이션 대상이 아니라 fail-closed·수동 복구 대상이다.
 */
export function manifestFileExists(eventsDir: string): boolean {
  const p = manifestPath(eventsDir);
  return fs.existsSync(p) || fs.existsSync(`${p}.bak`);
}

/**
 * manifest durable write(§2.3·§6.1-4). tmp write→tmp fsync→rename→dir fsync.
 * validate로 자기 구조를 재확인해 깨진 manifest가 완료 표지로 남지 않게 한다.
 */
export function writeManifest(
  eventsDir: string,
  manifest: EventLogManifest,
): void {
  atomicWriteJSONSync(manifestPath(eventsDir), manifest, {
    durable: true,
    validate: isEventLogManifest,
  });
}
