// E0 컨포먼스 하니스 — M1 녹화기 (스펙: engine-core-decision-2026-07-09.md §5-1)
//
// 스크립트 주도 녹화 라이브러리. 산출물 3종:
//   - recording.bin  raw 바이트(워크로드가 낸 결정적 바이트열)
//   - events.jsonl   초기 geometry·resize·reflow_mode 트레일(단조 증가 바이트 오프셋)
//   - meta.json      seed·워크로드 스크립트 해시·거버넌스 필드
//
// ── PTY 왕복과 결정성의 관계(설계 판단, 스펙 §5-1 "합성 제너레이터 우선"·"2회 동일 바이트") ──
// node-pty(제품 dependency 기존재)로 실제 PTY를 스폰해 **초기 geometry 적용·resize 실행을 실기로
// 실증**한다(macOS forkpty 경로). 다만 recording.bin의 바이트 **정본**은 PTY 슬레이브를 되돌아
// 나온 에코가 아니라 워크로드 제너레이터가 산출한 합성 바이트열이다. 이유:
//   1) 라인 discipline(ONLCR·에코·ISIG 등)이 합성 바이트를 비결정·비의도적으로 변형할 수 있어
//      "동일 스크립트 2회 = 동일 바이트" 불변을 깨거나 워크로드 의도와 어긋나게 만든다.
//   2) 우리가 검증하려는 것은 "터미널 에뮬레이터가 이 바이트열을 어떻게 그리드로 해석하는가"이며,
//      그 입력은 PTY master가 자식에게 write하는 바이트가 아니라 자식이 master로 write하는 바이트다.
//      합성 워크로드에서 후자는 곧 우리가 만든 바이트열이다(자식은 순수 passthrough여야 함).
// 그래서 recorder는 PTY를 스폰해 geometry/resize를 실제로 적용하되, recording.bin은 워크로드
// 바이트를 결정적으로 기록한다. 실 CLI 녹화(cli-recording 모드)에서는 자식 출력을 채집한다 —
// 그 경우 비결정성은 불가피하므로 커밋 코퍼스로 승격하지 않는다(D4 거버넌스).

import { spawn, type IPty } from 'node-pty';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';
import type { Geometry, RecordingEvent, RecordingMeta } from './types';
import type { Workload } from './workloads';
import { SeededRng } from './workloads';

/** recording.bin에 대한 sha256 hex. 동일 스크립트 2회 녹화 = 동일 해시 검증에 쓰인다. */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** events.jsonl 직렬화: 이벤트당 한 줄 JSON. */
export function serializeEvents(events: readonly RecordingEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** events.jsonl 파싱(재생 측이 쓴다). 빈 줄은 건너뛴다. */
export function parseEvents(text: string): RecordingEvent[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RecordingEvent);
}

/**
 * PTY를 실제로 스폰해 초기 geometry를 적용하고 trail의 resize 이벤트를 순서대로 실행한다.
 * 자식은 순수 passthrough(cat 계열)여야 하며, 이 함수는 "PTY 왕복이 실기로 성립함"을 실증하는
 * 것이 목적이다(반환값은 쓰지 않는다 — 정본 바이트는 워크로드가 산출). 자식 프로세스는 즉시
 * 종료·정리한다. macOS/Linux는 openpty(forkpty), Windows는 conpty — 여기서는 win 전용 가정 없음.
 *
 * ── 에러 승격(R8) ──────────────────────────────────────────────────────────
 * 이전에는 spawn/resize/exit 실패를 삼켰다(best-effort). 그러나 이 함수는 게이트④·코퍼스 생성
 * 경로에서 호출되므로, 실패를 삼키면 "geometry 경로가 실제로 동작함"이라는 실증이 조용히 무력화된다.
 * 그래서 spawn 실패·resize 실패·비정상 exit(0이 아닌 코드 또는 시그널)를 **throw로 승격**한다 —
 * 테스트 실패로 드러나 CI가 잡는다. 정상 종료(cat이 kill로 SIGHUP/SIGTERM 받는 것)는 정상 정리로
 * 간주한다(kill로 우리가 유도한 종료이므로).
 */
async function exercisePty(initial: Geometry, resizes: readonly Geometry[]): Promise<void> {
  // 순수 passthrough 자식: 표준입력을 그대로 표준출력으로. macOS `cat`은 인자 없으면 stdin→stdout.
  // 결정성·라인discipline 이슈로 이 출력을 정본으로 쓰지 않음(위 설계 주석) — geometry/resize 실증만.
  const shell = platform() === 'win32' ? 'cmd.exe' : 'cat';
  let child: IPty;
  try {
    child = spawn(shell, [], {
      name: 'xterm-256color',
      cols: initial.cols,
      rows: initial.rows,
      cwd: process.cwd(),
      env: { ...process.env } as { [key: string]: string },
    });
  } catch (e) {
    // R8: spawn 실패를 삼키지 않고 승격 — geometry 실증이 조용히 무력화되는 것을 막는다.
    throw new Error(`[recorder] PTY spawn 실패(${shell}): ${String(e)}`);
  }

  // onExit를 kill 이전에 배선해 종료의 코드/시그널을 검증한다(R8). node-pty 실측 시맨틱(macOS):
  // 우리가 kill로 유도한 종료 = {exitCode:0, signal:1(SIGHUP)} — 시그널이 존재한다. 자식이 스스로
  // 비정상 코드로 죽으면 = {exitCode≠0, signal:0} — 시그널이 없다. 그래서 "exitCode≠0 && 시그널
  // 부재"를 비정상 exit로 승격한다(우리 kill은 시그널을 남기므로 오탐 없음).
  const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    child.onExit(({ exitCode, signal }) => resolve({ exitCode, signal }));
  });

  try {
    // resize를 초기 geometry에서 순서대로 적용 — PTY의 실제 resize 경로를 밟는다.
    for (const g of resizes) {
      child.resize(g.cols, g.rows);
    }
  } catch (e) {
    // R8: resize 실패도 승격. 정리는 시도하되 원 에러를 던진다.
    try {
      child.kill();
    } catch {
      /* 정리 실패는 원 에러를 가리지 않도록 무시. */
    }
    throw new Error(`[recorder] PTY resize 실패: ${String(e)}`);
  }

  // 자식을 즉시 종료. cat은 stdin EOF에서 종료하므로 kill로 확정 회수.
  child.kill();

  // onExit 코드 검증(R8): 비정상 자기 종료(시그널 없이 비정상 코드)면 승격.
  const { exitCode, signal } = await exited;
  if (exitCode !== 0 && !signal) {
    throw new Error(`[recorder] PTY 비정상 exit: code=${exitCode} signal=${signal ?? 'none'}`);
  }
}

/** 녹화 산출물 파일명(코퍼스 케이스 디렉토리 안). */
export const RECORDING_BIN = 'recording.bin';
export const EVENTS_JSONL = 'events.jsonl';
export const META_JSON = 'meta.json';

export interface RecordResult {
  readonly bytes: Uint8Array;
  readonly events: RecordingEvent[];
  readonly meta: RecordingMeta;
}

/**
 * 워크로드 1개를 녹화한다(파일 쓰기 없이 산출물만 반환 — 결정성 검증·테스트에 쓰기 좋다).
 * PTY를 실제 스폰해 geometry/resize를 실증한 뒤, 정본 바이트/트레일/메타를 구성한다.
 *
 * @param seed 워크로드 PRNG 시드(합성 워크로드는 시드 고정 → 동일 바이트).
 */
export async function record(workload: Workload, seed = 0): Promise<RecordResult> {
  const rng = new SeededRng(seed);
  const bytes = workload.build(rng);

  // 트레일 구성: init(선두) + 워크로드가 정의한 resize/reflow 이벤트.
  const trail = workload.trail(bytes);
  const events: RecordingEvent[] = [
    { type: 'init', byteOffset: 0, geometry: workload.initialGeometry, reflowMode: workload.reflowMode },
    ...trail,
  ];

  // byteOffset 단조 증가·범위 불변식 검증(스펙 §5-1 "단조 바이트 오프셋").
  let prev = -1;
  for (const e of events) {
    if (e.byteOffset < prev) {
      throw new Error(`[recorder] byteOffset이 단조 증가하지 않음: ${e.byteOffset} < ${prev}`);
    }
    if (e.byteOffset < 0 || e.byteOffset > bytes.length) {
      throw new Error(`[recorder] byteOffset 범위 위반: ${e.byteOffset} (0..${bytes.length})`);
    }
    prev = e.byteOffset;
  }

  // PTY 왕복 실증(geometry 적용 + resize 실행). 정본 바이트에는 영향 없음.
  const resizes = trail.filter((e): e is Extract<RecordingEvent, { type: 'resize' }> => e.type === 'resize').map((e) => e.geometry);
  await exercisePty(workload.initialGeometry, resizes);

  const meta: RecordingMeta = {
    workloadName: workload.name,
    seed,
    workloadHash: sha256Hex(bytes),
    synthetic: true,
    createdVia: 'synthetic-generator',
    initialGeometry: workload.initialGeometry,
  };

  return { bytes, events, meta };
}

/** 녹화 산출물을 코퍼스 디렉토리(outDir/{workloadName}/)에 기록한다. */
export function writeRecording(outDir: string, result: RecordResult): string {
  const caseDir = path.join(outDir, result.meta.workloadName);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(path.join(caseDir, RECORDING_BIN), result.bytes);
  writeFileSync(path.join(caseDir, EVENTS_JSONL), serializeEvents(result.events));
  writeFileSync(path.join(caseDir, META_JSON), JSON.stringify(result.meta, null, 2) + '\n');
  return caseDir;
}
