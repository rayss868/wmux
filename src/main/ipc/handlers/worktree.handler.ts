// Deck Git 탭 — 워크트리 GUI main 핸들러 (list / add / remove).
//
// 렌더러-전용 IPC 표면(파이프 RpcRouter 미노출 — channelLocal/fanout과 동일
// trust basis). git이 디스크 정본이라 캐시·영속 상태가 없다: 데몬 재시작·앱
// 재시작 무영향, 매 호출이 fresh `git worktree ...` 실행.
//
// 안전 계약:
//  - add: 브랜치명은 validateGitRef(플래그 주입·traversal·제어문자 차단),
//    경로는 명시 인자 없이 관례 위치(<repo부모>/<repo이름>-worktrees/<branch>)로
//    핸들러가 도출한다 — 렌더러가 임의 디스크 경로를 지정할 수 없다.
//  - remove: `git worktree remove` 그대로 — dirty 워크트리는 git 자신이 거부하고
//    그 stderr를 사용자에게 표면화한다. --force는 v1 미제공(careful 원칙).
//  - 모든 실패는 { ok:false, error }로 강등(fail-soft 표시 표면).
import { ipcMain } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { git } from '../../git/git';
import {
  parseWorktreePorcelain,
  validateGitRef,
  branchToDirName,
  type WorktreeEntry,
} from '../../../shared/worktreeParse';

export type WorktreeListResult =
  | {
      ok: true;
      /** 호출 컨텍스트의 worktree toplevel(현재 워크트리 — GUI의 "현재" dot 기준). */
      repoPath: string;
      /** 본(main) 워크트리 경로 — porcelain 첫 블록(git 계약: main이 항상 먼저). */
      mainPath: string;
      worktrees: WorktreeEntry[];
    }
  | { ok: false; error: string };

export type WorktreeMutateResult =
  | { ok: true; worktreePath: string }
  | { ok: false; error: string };

// repo 단위 뮤텍스 — diff.handler.withRepoLock과 동형 복제(additive 원칙:
// 그쪽 인스턴스는 diff 채택 직렬화 전용이라 큐를 공유하지 않는다).
const repoChains = new Map<string, Promise<unknown>>();
function withRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoChains.get(repoKey) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  repoChains.set(
    repoKey,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// cwd(서브디렉토리 가능) → 자기 worktree toplevel. 비-git이면 null.
async function resolveToplevel(cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', '--show-toplevel'], cwd);
  const top = r.code === 0 ? r.stdout.trim() : '';
  return top || null;
}

// 경로 정규화 — 파일시스템 대소문자 정책 반영(Codex P2). Windows/macOS는
// case-insensitive라 lowercase, POSIX(case-sensitive)는 원형 유지: 그래야
// `/repo/Foo`와 `/repo/foo`가 서로 다른 워크트리로 올바로 구분된다.
function normPath(p: string): string {
  const trimmed = resolve(p).replace(/[/\\]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? trimmed.toLowerCase() : trimmed;
}

// 본 워크트리(main) = `git worktree list --porcelain` 첫 블록(git 계약).
// cwd가 linked worktree여도 여기서 본 repo를 얻는다.
async function resolveMainWorktree(top: string): Promise<string> {
  const r = await git(['worktree', 'list', '--porcelain'], top);
  if (r.code !== 0) return top;
  return parseWorktreePorcelain(r.stdout)[0]?.path ?? top;
}

async function listWorktrees(repoPath: string): Promise<WorktreeListResult> {
  const top = await resolveToplevel(repoPath);
  if (!top) return { ok: false, error: 'not a git repository' };
  const r = await git(['worktree', 'list', '--porcelain'], top);
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) };
  const worktrees = parseWorktreePorcelain(r.stdout);
  // dogfood가 잡은 실버그: top은 "호출한 워크트리"의 toplevel이지 본 repo가
  // 아니다(linked worktree에서 열면 자기 자신). 본 워크트리는 porcelain 첫
  // 블록이 계약이므로 그걸로 mainPath를 분리해 내려준다.
  return { ok: true, repoPath: top, mainPath: worktrees[0]?.path ?? top, worktrees };
}

async function addWorktree(repoPath: string, branch: string): Promise<WorktreeMutateResult> {
  let safeBranch: string;
  try {
    safeBranch = validateGitRef(branch);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const top = await resolveToplevel(repoPath);
  if (!top) return { ok: false, error: 'not a git repository' };
  // 경로 도출 기준 = 본(main) 워크트리(Codex P2). linked worktree에서 열면
  // top이 그 worktree 자신이라 `<linked>-worktrees`가 되던 버그를 막는다.
  const mainWt = await resolveMainWorktree(top);
  return withRepoLock(normPath(mainWt), async () => {
    // 관례 위치: <main부모>/<main이름>-worktrees/<branch-dir>. 오너의 실사용
    // 관례(D:\wmux-worktrees\*)와 동형 — repo 안이 아니라 형제 디렉토리라
    // 워크트리가 자기 repo의 untracked 노이즈가 되지 않는다.
    const parent = join(dirname(mainWt), `${basename(mainWt)}-worktrees`);
    const wtPath = resolve(parent, branchToDirName(safeBranch));
    if (existsSync(wtPath)) {
      return { ok: false, error: `path already exists: ${wtPath}` };
    }
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    // 브랜치 해석 3분기(Codex P2 — remote-only 브랜치 보존):
    //  ① 로컬 브랜치 존재 → 체크아웃.
    //  ② 아니면 --guess-remote 시도 → origin/<branch>가 있으면 그걸 추적하는
    //     로컬 브랜치를 만든다(강제 -b가 remote를 무시하고 새 브랜치를 만드는
    //     것 방지). remote 매칭이 없으면 실패.
    //  ③ ②가 실패하면 -b로 HEAD에서 새 브랜치 생성.
    const local = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${safeBranch}`], mainWt);
    if (local.code === 0) {
      const r = await git(['worktree', 'add', wtPath, safeBranch], mainWt);
      if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) };
      return { ok: true, worktreePath: wtPath };
    }
    const guess = await git(['worktree', 'add', '--guess-remote', wtPath, safeBranch], mainWt);
    if (guess.code === 0) return { ok: true, worktreePath: wtPath };
    const created = await git(['worktree', 'add', '-b', safeBranch, wtPath], mainWt);
    if (created.code !== 0) return { ok: false, error: created.stderr.slice(0, 300) };
    return { ok: true, worktreePath: wtPath };
  });
}

async function removeWorktree(repoPath: string, worktreePath: string): Promise<WorktreeMutateResult> {
  const top = await resolveToplevel(repoPath);
  if (!top) return { ok: false, error: 'not a git repository' };
  // 렌더러가 넘기는 경로는 직전 list 결과에서 온 값이지만, 신뢰하지 않고
  // 실제 워크트리 목록에 있는 경로인지 재검증한다(임의 경로 인자 차단).
  const listed = await git(['worktree', 'list', '--porcelain'], top);
  if (listed.code !== 0) return { ok: false, error: listed.stderr.slice(0, 300) };
  const entries = parseWorktreePorcelain(listed.stdout);
  const target = entries.find((e) => normPath(e.path) === normPath(worktreePath));
  if (!target) return { ok: false, error: 'not a listed worktree of this repository' };
  // 본 워크트리(porcelain 첫 블록) 제거 거부.
  const mainPath = entries[0]?.path ?? top;
  if (normPath(target.path) === normPath(mainPath)) {
    return { ok: false, error: 'cannot remove the main worktree' };
  }
  // 활성(호출 컨텍스트) 워크트리 제거 거부(Codex P2): git은 clean 워크트리를
  // 그 자신의 cwd에서도 제거해준다 — 사용자가 지금 서 있는 워크트리를 지워
  // pane cwd가 사라지는 상황을 막는다. top = 활성 pane의 toplevel.
  if (normPath(target.path) === normPath(top)) {
    return { ok: false, error: 'cannot remove the worktree you are currently in' };
  }
  return withRepoLock(normPath(top), async () => {
    // --force 없음: dirty/잠김 워크트리는 git이 거부하며 그 사유를 그대로 표면화.
    const r = await git(['worktree', 'remove', target.path], top);
    if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) };
    return { ok: true, worktreePath: target.path };
  });
}

export function registerWorktreeHandlers(): () => void {
  ipcMain.removeHandler(IPC.WORKTREE_LIST);
  ipcMain.handle(
    IPC.WORKTREE_LIST,
    wrapHandler(IPC.WORKTREE_LIST, async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown) => {
      if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
      return listWorktrees(repoPath);
    }),
  );

  ipcMain.removeHandler(IPC.WORKTREE_ADD);
  ipcMain.handle(
    IPC.WORKTREE_ADD,
    wrapHandler(
      IPC.WORKTREE_ADD,
      async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, branch: unknown) => {
        if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
        if (typeof branch !== 'string' || !branch) return { ok: false, error: 'branch required' };
        return addWorktree(repoPath, branch);
      },
    ),
  );

  ipcMain.removeHandler(IPC.WORKTREE_REMOVE);
  ipcMain.handle(
    IPC.WORKTREE_REMOVE,
    wrapHandler(
      IPC.WORKTREE_REMOVE,
      async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, worktreePath: unknown) => {
        if (typeof repoPath !== 'string' || !repoPath) return { ok: false, error: 'repoPath required' };
        if (typeof worktreePath !== 'string' || !worktreePath) return { ok: false, error: 'worktreePath required' };
        return removeWorktree(repoPath, worktreePath);
      },
    ),
  );

  return () => {
    ipcMain.removeHandler(IPC.WORKTREE_LIST);
    ipcMain.removeHandler(IPC.WORKTREE_ADD);
    ipcMain.removeHandler(IPC.WORKTREE_REMOVE);
  };
}
