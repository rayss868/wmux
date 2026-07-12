// `git worktree list --porcelain` 파서 + 워크트리 GUI 입력 검증 (순수 함수).
//
// company/WorktreeManager의 파서와 별개 구현이다 — 그쪽은 유료 모듈(company)
// 내부 타입에 결박돼 있고 동결 상태라 건드리지 않는다(레이어·정책 양쪽 이유).
// 이 파서는 porcelain 블록 계약을 더 넓게 커버한다: detached / bare /
// locked(+사유) / prunable까지 — GUI가 "왜 이 워크트리를 못 지우는가"를
// 표시하려면 이 플래그들이 필요하다.
//
// porcelain 계약(git-worktree(1)): 워크트리당 한 블록, 빈 줄 구분.
//   worktree <path>          — 항상 첫 줄(절대경로)
//   HEAD <oid>               — bare가 아니면 존재
//   branch refs/heads/<name> — attached일 때만; detached면 대신 `detached` 라인
//   bare / detached          — 무값 불리언 라인
//   locked [<reason>] / prunable [<reason>] — 값이 있을 수도 없을 수도 있음

export interface WorktreeEntry {
  /** 워크트리 절대경로 (porcelain 원문 — 슬래시 구분자일 수 있음). */
  readonly path: string;
  readonly headOid: string;
  /** attached 브랜치 이름(refs/heads/ 제거). detached·bare면 null. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  /** locked면 사유 문자열(사유 없으면 ''), 아니면 null. */
  readonly locked: string | null;
  /** prunable이면 사유 문자열(없으면 ''), 아니면 null. */
  readonly prunable: string | null;
}

export function parseWorktreePorcelain(raw: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const block of raw.split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    let path = '';
    let headOid = '';
    let branch: string | null = null;
    let detached = false;
    let bare = false;
    let locked: string | null = null;
    let prunable: string | null = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) headOid = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line === 'detached') detached = true;
      else if (line === 'bare') bare = true;
      else if (line === 'locked') locked = '';
      else if (line.startsWith('locked ')) locked = line.slice('locked '.length);
      else if (line === 'prunable') prunable = '';
      else if (line.startsWith('prunable ')) prunable = line.slice('prunable '.length);
    }
    if (!path) continue;
    out.push({ path, headOid, branch, detached, bare, locked, prunable });
  }
  return out;
}

/**
 * git ref(브랜치명) 검증 — 플래그 주입('-' 시작)·traversal('..')·제어문자 차단.
 * company WorktreeManager.validateGitRef와 동일 규칙(정책 계약이라 규칙만 복제).
 * 통과 시 trim된 값을 반환, 실패 시 사유 문자열을 담아 throw 대신 null 계약이
 * 아닌 Error를 던진다(호출부 IPC 핸들러가 fail-soft로 강등).
 */
export function validateGitRef(ref: string): string {
  const trimmed = (ref ?? '').trim();
  if (!trimmed) throw new Error('branch must not be empty');
  if (trimmed.startsWith('-')) throw new Error("branch must not start with '-'");
  if (trimmed.includes('..')) throw new Error("branch must not contain '..'");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw new Error('branch must not contain control characters');
  if (/[\s~^:?*[\\]/.test(trimmed)) throw new Error('branch contains invalid ref characters');
  if (trimmed.endsWith('/') || trimmed.endsWith('.lock')) throw new Error('branch has an invalid suffix');
  if (trimmed.length > 200) throw new Error('branch is too long (max 200 characters)');
  return trimmed;
}

/** 브랜치명 → 워크트리 디렉토리 leaf 이름(경로 안전 문자만). */
export function branchToDirName(branch: string): string {
  return branch.replace(/[/\\:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
}
