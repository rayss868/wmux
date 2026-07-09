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
// ── 다층 스크럽(D4 + §6.E + R7 보강) ──
// 실세션 유래 바이트에는 자격증명이 섞일 수 있다. 승격(커밋) 경로는 없고 로컬 보관뿐이지만,
// at-rest에서도 secret을 남기지 않도록 다층으로 지운다:
//   1) key=value 형태: (?i)(api[_-]?key|token|secret|password|passwd|pwd)=<값>
//   2) AWS 계열 대문자 스네이크 credential env: AWS_SECRET_ACCESS_KEY=... 등(R7).
//   3) URL userinfo: scheme://user:pass@host 의 자격증명(R7).
//   4) JSON/colon 형식: "secret": "..." / "api_key": "..." 등(R7).
//   5) PEM 블록: -----BEGIN ... PRIVATE KEY----- ... -----END ...-----(R7).
//   6) 알려진 토큰 프리픽스: sk-/ghp_/gho_/xox... 로 시작하는 토큰(R7).
//   7) Bearer 토큰: Authorization: Bearer <토큰> / 단독 Bearer <토큰>.
//   8) OSC 52 클립보드 페이로드(ESC ] 52 ; ... ST) — base64 클립보드 유출 벡터.
//   9) base64 고엔트로피 휴리스틱: 길이 ≥32의 base64 유사 토큰 중 Shannon 엔트로피가 높은 것.

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 스크럽 시 secret을 대체하는 마커. secret-span 표시(§6.E at-rest 취급). */
const REDACTED = '[[REDACTED]]';

/** key=value 자격증명(대소문자 무시). 값은 공백·제어문자 전까지. */
const KV_RE = /((?:api[_-]?key|token|secret|password|passwd|pwd))=\S+/gi;

/**
 * AWS 계열 대문자 스네이크 credential env(R7). AWS_SECRET_ACCESS_KEY·AWS_ACCESS_KEY_ID·
 * AWS_SESSION_TOKEN 등 "대문자 스네이크 + (SECRET|ACCESS|SESSION|PRIVATE|CREDENTIAL) + KEY/TOKEN/ID"
 * 형태를 넓게 잡는다. 값은 = 뒤 공백/제어문자 전까지.
 */
const AWS_ENV_RE =
  /\b([A-Z][A-Z0-9]*_(?:SECRET|ACCESS|SESSION|PRIVATE|CREDENTIAL|CREDENTIALS)_[A-Z0-9_]*(?:KEY|TOKEN|ID))=\S+/g;

/**
 * URL userinfo 자격증명(R7). scheme://user:pass@host 의 user:pass 를 지운다(호스트는 보존).
 * scheme는 영문+숫자+[.+-], user/pass는 @·/ 전까지(제어문자 제외).
 */
// eslint-disable-next-line no-control-regex
const URL_USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@\x00-\x1f]+):([^\s/@\x00-\x1f]+)@/g;

/**
 * JSON/colon 형식 자격증명(R7). "secret": "..." / "api_key": "..." / 'token': '...' 등.
 * 키는 secret/password/passwd/pwd/token/api_key/apikey/access_key/private_key(대소문자 무시).
 */
const JSON_KV_RE =
  /(["']?(?:api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret|password|passwd|pwd|token)["']?\s*:\s*)["'][^"']*["']/gi;

/** PEM 개인키 블록(R7). -----BEGIN ... PRIVATE KEY----- ... -----END ... PRIVATE KEY-----. */
const PEM_RE = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g;

/**
 * 알려진 토큰 프리픽스(R7). sk-(OpenAI 계열)·ghp_/gho_/ghs_/ghr_(GitHub PAT)·xox[baprs]-(Slack).
 * 프리픽스 뒤 토큰 본문(영숫자·_·-)까지 지운다.
 */
const TOKEN_PREFIX_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsru]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{8,})/g;

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

  // 순서 주의: 구조가 뚜렷한 패턴(PEM·URL·JSON·프리픽스·헤더)을 먼저 지우고, 마지막에 base64
  // 고엔트로피 휴리스틱을 돌린다(구조 패턴이 남긴 골격/키를 휴리스틱이 오탐하지 않도록).

  // 1) OSC 52 페이로드 제거(제어문자 포함 매칭). 골격은 남기고 페이로드만 마킹.
  s = s.replace(OSC52_RE, (m) => {
    const head = m.slice(0, m.indexOf(';', m.indexOf(';') + 1) + 1); // "ESC]52;<target>;"
    const term = m.endsWith('\x07') ? '\x07' : '\x1b\\';
    return head + REDACTED + term;
  });

  // 2) PEM 개인키 블록 전체(R7).
  s = s.replace(PEM_RE, REDACTED);

  // 3) URL userinfo(user:pass@) — user:pass만 지우고 scheme·host 골격 보존(R7).
  s = s.replace(URL_USERINFO_RE, (_m, scheme: string) => `${scheme}${REDACTED}@`);

  // 4) JSON/colon 형식 "key": "..."(R7) — 키/구두점 보존, 값만 마킹.
  s = s.replace(JSON_KV_RE, (_m, keyPart: string) => `${keyPart}"${REDACTED}"`);

  // 5) key=value 자격증명(소문자 계열).
  s = s.replace(KV_RE, (_m, key: string) => `${key}=${REDACTED}`);

  // 6) AWS 계열 대문자 스네이크 credential env(R7).
  s = s.replace(AWS_ENV_RE, (_m, key: string) => `${key}=${REDACTED}`);

  // 7) 알려진 토큰 프리픽스(sk-/ghp_/gho_/xox…)(R7).
  s = s.replace(TOKEN_PREFIX_RE, REDACTED);

  // 8) Bearer 토큰.
  s = s.replace(BEARER_RE, `Bearer ${REDACTED}`);

  // 9) base64 고엔트로피 휴리스틱(마지막 — 나머지가 못 잡은 랜덤 시크릿 포괄).
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

/** 저장소 내 고정 로컬 코퍼스 디렉토리(core/harness/corpus-local/) — .gitignore 등재 경로(R7). */
export const LOCAL_CORPUS_DIR = path.join(__dirname, LOCAL_CORPUS_DIR_NAME);

/** 저장소 루트(core/harness의 두 단계 위). 격리 가드가 "repo 내 비-ignored 경로" 판별에 쓴다. */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 격리 가드(R7): 채굴 산출물이 저장소 내 비-ignored 경로로 새어 커밋되는 것을 원천 차단한다.
 * 허용: (a) 고정 로컬 코퍼스 디렉토리(LOCAL_CORPUS_DIR) 하위 (b) 저장소 **바깥** 경로(테스트의
 * os.tmpdir 등). 거부: 저장소 내부이면서 LOCAL_CORPUS_DIR 하위가 아닌 경로(예: corpus/, src/).
 */
function assertIsolatedOutDir(outLocalDir: string): void {
  const resolved = path.resolve(outLocalDir);
  const insideLocalCorpus =
    resolved === LOCAL_CORPUS_DIR || resolved.startsWith(LOCAL_CORPUS_DIR + path.sep);
  const insideRepo = resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep);
  if (insideRepo && !insideLocalCorpus) {
    throw new Error(
      `[miner] 격리 위반: 채굴 산출물은 ${LOCAL_CORPUS_DIR}(또는 저장소 바깥)에만 쓸 수 있다. ` +
        `거부된 경로: ${resolved} (저장소 내 비-ignored 경로 — 커밋 위험)`,
    );
  }
}

export function writeMinedSeeds(
  seeds: readonly MinedSeed[],
  outLocalDir: string = LOCAL_CORPUS_DIR,
): string[] {
  assertIsolatedOutDir(outLocalDir); // R7: repo 내 비-ignored 경로 거부.
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
