// E0 컨포먼스 하니스 — M1 보조: .buf 채굴기 (스펙: engine-core-decision-2026-07-09.md §5-1·§3 D4)
//
// {stateDir}/buffers/*.buf(RingBuffer.dumpToFile 산출물)를 읽어 다층 스크럽 후 **로컬 전용**으로
// 출력한다. 커밋 절대 금지(.gitignore에 core/harness/corpus-local/ 등재 — D4 거버넌스).
//
// ── .buf의 성질(RingBuffer.ts 실물 확인) ──
// .buf는 원형 버퍼의 **tail만** 보존한다. geometry·초기 상태·resize 트레일이 전혀 없다. 즉
// 결정적 재현의 정본이 될 수 없다(그 역할은 녹화기 recorder.ts). 채굴 산출물의 용도는:
//   (a) mid-stream 강건성 케이스 — 시퀀스 중간이 잘린 입력을 코어가 무크래시로 흡수하는지.
//   (b) 퍼저 시드(§5-4) — 실세션 유래 바이트 분포로 퍼저 커버리지를 넓힌다.
// 두 용도 모두 "정확한 그리드 정답"을 요구하지 않으므로 geometry 부재가 문제되지 않는다.
//
// ── 다층 스크럽(D4 + §6.E) ──
// 실세션 유래 바이트에는 자격증명이 섞일 수 있다. 승격(커밋) 경로는 없고 로컬 보관뿐이지만,
// at-rest에서도 secret을 남기지 않도록 다층으로 지운다:
//   1) key=value 형태: (?i)(api[_-]?key|token|secret|password|passwd|pwd)=<값>
//   2) Bearer 토큰: Authorization: Bearer <토큰> / 단독 Bearer <토큰>
//   3) OSC 52 클립보드 페이로드(ESC ] 52 ; ... ST) — base64 클립보드 유출 벡터.
//   4) base64 고엔트로피 휴리스틱: 길이 ≥32의 base64 유사 토큰 중 Shannon 엔트로피가 높은 것.

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 스크럽 시 secret을 대체하는 마커. secret-span 표시(§6.E at-rest 취급). */
const REDACTED = '[[REDACTED]]';

/** key=value 자격증명(대소문자 무시). 값은 공백·제어문자 전까지. */
const KV_RE = /((?:api[_-]?key|token|secret|password|passwd|pwd))=\S+/gi;

/** Bearer 토큰(Authorization 헤더 또는 단독). */
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/-]+=*/g;

/**
 * OSC 52 클립보드 시퀀스. ESC ] 52 ; <target> ; <base64> (BEL | ESC \).
 * 페이로드(base64) 전체를 지운다 — 클립보드 유출 방지.
 */
// eslint-disable-next-line no-control-regex
const OSC52_RE = /\x1b\]52;[^;]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** base64 유사 토큰(길이 ≥32). 엔트로피로 2차 판정. */
const BASE64_CANDIDATE_RE = /[A-Za-z0-9+/]{32,}={0,2}/g;

/** Shannon 엔트로피(비트/문자). 고엔트로피 = 랜덤 시크릿 가능성. */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** base64 고엔트로피 휴리스틱 임계값(비트/문자). 4.0 이상이면 랜덤성 높음(자연어는 대개 <3.5). */
const ENTROPY_THRESHOLD = 4.0;

/**
 * 다층 스크럽. 입력은 raw 바이트(제어문자 포함), 출력도 바이트. OSC 52는 바이트 레벨에서,
 * 나머지는 latin1 문자열 왕복으로 처리한다(바이트↔문자 1:1 보존 인코딩).
 */
export function scrub(input: Uint8Array): Uint8Array {
  // latin1(binary)은 0..255를 1:1로 문자에 대응 → 정규식 치환 후 바이트 복원이 안전.
  let s = Buffer.from(input).toString('latin1');

  // 1) OSC 52 페이로드 제거(제어문자 포함 매칭).
  s = s.replace(OSC52_RE, (m) => {
    // 시퀀스 골격은 남기되 페이로드만 마킹: ESC ] 52 ; <target> ; [[REDACTED]] ST.
    const head = m.slice(0, m.indexOf(';', m.indexOf(';') + 1) + 1); // "ESC]52;<target>;"
    const term = m.endsWith('\x07') ? '\x07' : '\x1b\\';
    return head + REDACTED + term;
  });

  // 2) key=value 자격증명.
  s = s.replace(KV_RE, (_m, key: string) => `${key}=${REDACTED}`);

  // 3) Bearer 토큰.
  s = s.replace(BEARER_RE, `Bearer ${REDACTED}`);

  // 4) base64 고엔트로피 휴리스틱.
  s = s.replace(BASE64_CANDIDATE_RE, (m) => (shannonEntropy(m) >= ENTROPY_THRESHOLD ? REDACTED : m));

  return new Uint8Array(Buffer.from(s, 'latin1'));
}

export interface MinedSeed {
  readonly sourceFile: string;
  readonly bytes: Uint8Array;
}

/**
 * buffers/ 디렉토리의 *.buf를 모두 읽어 스크럽한다. tmp 동반 파일(.tmp.<hex>)은 건너뛴다
 * (RingBuffer 원자적 덤프의 중간 산물 — RingBuffer.isTmpFile 규약과 동일한 접미사).
 */
export function mineBufferDir(bufferDir: string): MinedSeed[] {
  let entries: string[];
  try {
    entries = readdirSync(bufferDir);
  } catch {
    return []; // 디렉토리 부재 — 채굴할 게 없음.
  }
  const out: MinedSeed[] = [];
  for (const name of entries) {
    if (!name.endsWith('.buf')) continue;
    if (/\.tmp\.[0-9a-f]+$/.test(name)) continue; // 원자적 덤프 중간 산물 스킵.
    const full = path.join(bufferDir, name);
    const raw = readFileSync(full);
    out.push({ sourceFile: full, bytes: scrub(new Uint8Array(raw)) });
  }
  return out;
}

/**
 * 채굴 산출물을 **로컬 전용** 디렉토리에 기록한다. 이 경로는 .gitignore에 등재되어 있어 절대
 * 커밋되지 않는다. 파일명은 원본 세션 id를 그대로 쓰되 .seed.bin 확장자로 mid-stream/퍼저
 * 시드임을 표시한다.
 */
export const LOCAL_CORPUS_DIR_NAME = 'corpus-local';

export function writeMinedSeeds(outLocalDir: string, seeds: readonly MinedSeed[]): string[] {
  mkdirSync(outLocalDir, { recursive: true });
  const written: string[] = [];
  for (const s of seeds) {
    const base = path.basename(s.sourceFile).replace(/\.buf$/, '');
    const dest = path.join(outLocalDir, `${base}.seed.bin`);
    writeFileSync(dest, s.bytes, { mode: 0o600 }); // at-rest 취급(0600).
    written.push(dest);
  }
  return written;
}
