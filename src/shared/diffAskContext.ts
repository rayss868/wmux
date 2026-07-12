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

  const fenced = hunkBody ? `\n\`\`\`diff\n${hunkBody}\n\`\`\`` : '';
  const full = `${head}${fenced}\n\n${question}`;
  // 렌더러에서도 쓰이므로 Buffer 대신 TextEncoder(양쪽 전역)로 바이트 계산.
  if (new TextEncoder().encode(full).length <= DIFF_ASK_CONTEXT_CAP) return full;
  // 캡 초과 — hunk 본문 생략(경로+헤더는 유지, 오케가 pane/파일에서 직접 읽게).
  return `${head}\n(hunk body omitted — over ${DIFF_ASK_CONTEXT_CAP / 1024}KB; read the file directly)\n\n${question}`;
}
