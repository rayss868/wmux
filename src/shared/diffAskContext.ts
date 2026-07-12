// diff → 오케스트레이터 질문의 컨텍스트 블록 조립 (순수 함수).
//
// 설계 근거(plan): composePrompt seam은 ambient 상태 전용이고 거기 실으면
// transcript에 컨텍스트가 안 보여 "모든 주장은 증거로부터 1클릭" 계약을
// 깬다. 채널 경유는 coalescer 지연이 낀다. 그래서 사용자 질문 앞에 구조화
// 블록을 붙인 단일 deck:send 메시지가 정답 — 이 함수가 그 블록을 만든다.
//
// hunk 본문은 ``` 펜스로 감싼다: 오케스트레이터 그라운딩 관례상 터미널/diff
// 유래 텍스트는 데이터로 표시(지시로 오독 방지). 전체 캡(8KB) 초과 시 hunk
// 본문을 통째로 생략하고 경로+헤더만 남긴다 — 부분 절단된 diff는 오독 위험이
// 더 크다(모양은 완전한데 내용이 잘린 상태).

export const DIFF_ASK_CONTEXT_CAP = 8 * 1024;

export interface DiffAskInput {
  /** repo 식별 라벨 — 워크스페이스 모드는 repoPath, 태스크 모드는 worktreePath. */
  readonly repoLabel: string;
  readonly branch: string;
  readonly file: string;
  /** hunk 단위 질문이 아니면 ''(파일 단위 질문). */
  readonly hunkHeader: string;
  /** hunk 본문(라인 배열 원문 join). 캡 초과 시 생략된다. */
  readonly hunkBody: string;
  readonly question: string;
}

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

// UTF-8 바이트 캡으로 안전 절단 — 멀티바이트 문자를 쪼개지 않는다.
function truncateBytes(s: string, cap: number): string {
  if (byteLen(s) <= cap) return s;
  let out = s;
  // 문자 단위로 줄여가며 바이트 캡 이하로(표시/프롬프트용이라 정밀 최적화 불요).
  while (out.length > 0 && byteLen(out) > cap) {
    out = out.slice(0, Math.max(0, Math.floor(out.length * 0.95)) || out.length - 1);
  }
  return out;
}

// hunk 본문을 감쌀 펜스 길이 — 본문 안의 최장 백틱 런보다 1 길게(CommonMark
// 규칙). 그래야 본문에 ``` 라인이 있어도 fence가 조기 종료되지 않는다(Codex P2).
function fenceFor(body: string): string {
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function buildDiffAskContext(input: DiffAskInput): string {
  const { repoLabel, branch, file, hunkHeader, hunkBody, question } = input;
  const head = [
    '[diff question]',
    `repo: ${repoLabel}`,
    branch ? `branch: ${branch}` : null,
    `file: ${file}`,
    hunkHeader ? `hunk: ${hunkHeader}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  const fence = fenceFor(hunkBody);
  const fenced = hunkBody ? `\n${fence}diff\n${hunkBody}\n${fence}` : '';
  const full = `${head}${fenced}\n\n${question}`;
  if (byteLen(full) <= DIFF_ASK_CONTEXT_CAP) return full;
  // 캡 초과 — hunk 본문 생략(경로+헤더는 유지, 오케가 pane/파일에서 직접 읽게).
  // 그래도 초과하면(경로/질문 자체가 큼) 최종적으로 바이트 캡으로 절단(Codex P3).
  const fallback = `${head}\n(hunk body omitted — over ${DIFF_ASK_CONTEXT_CAP / 1024}KB; read the file directly)\n\n${question}`;
  return truncateBytes(fallback, DIFF_ASK_CONTEXT_CAP);
}
