// ─── Deck Git tab — the workspace's git surface (worktrees v1) ───────────────
//
// Repo context = the active pane's live cwd (OSC 7-tracked surface.cwd),
// normalized to its worktree toplevel by diff:resolveRepo — the same
// resolution the workspace-diff palette command uses. Pull-only: fetch on
// mount / workspace switch / manual refresh / after each mutation. git is the
// source of truth on disk, so there is nothing to persist or push here.
//
// Actions per worktree row: "Open" (new workspace whose startupCwd is the
// worktree) and "Remove" (`git worktree remove`, no --force — a dirty
// worktree is refused by git itself and the stderr is surfaced as-is).
// The main worktree shows a badge instead of Remove.
//
// Design contract (DESIGN.md): monochrome glyphs only, paths in mono, and at
// most ONE amber point — the dot marking the worktree the active pane is in.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { StoreState } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { Pane, PaneLeaf } from '../../../shared/types';
import type { WorktreeEntry } from '../../../shared/worktreeParse';
import { PrSection } from './PrSection';

// 활성 워크스페이스의 활성 pane → 활성 surface cwd (팔레트 Show Git Diff와 동일 규칙).
// 셀렉터로도 재사용(store 상태에서 원시 문자열로 수렴 — 리렌더 최소화).
function selectActivePaneCwd(state: StoreState): string {
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return '';
  const findLeaf = (pane: Pane): PaneLeaf | null => {
    if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
    for (const child of pane.children) {
      const found = findLeaf(child);
      if (found) return found;
    }
    return null;
  };
  const leaf = findLeaf(ws.rootPane);
  const surface = leaf?.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  return surface?.cwd || ws.profile?.startupCwd || state.startupDirectory || '';
}

function pathLeaf(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

interface WorktreeBridge {
  list: (repoPath: string) => Promise<
    | { ok: true; repoPath: string; mainPath: string; worktrees: WorktreeEntry[] }
    | { ok: false; error: string }
  >;
  add: (repoPath: string, branch: string) => Promise<
    { ok: true; worktreePath: string } | { ok: false; error: string }
  >;
  remove: (repoPath: string, worktreePath: string) => Promise<
    { ok: true; worktreePath: string } | { ok: false; error: string }
  >;
}

function getBridges(): { worktree: WorktreeBridge | null; resolveRepo: ((cwd: string) => Promise<{ ok: true; repoPath: string } | { ok: false }>) | null } {
  const api = (
    window as unknown as {
      electronAPI?: { worktree?: WorktreeBridge; diff?: { resolveRepo?: (cwd: string) => Promise<{ ok: true; repoPath: string } | { ok: false }> } };
    }
  ).electronAPI;
  return { worktree: api?.worktree ?? null, resolveRepo: api?.diff?.resolveRepo ?? null };
}

export function GitTab({ cwd }: { cwd?: string } = {}): React.ReactElement {
  const t = useT();
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  // 활성 pane cwd를 reactive 구독 — 같은 워크스페이스에서 다른 repo pane으로
  // 포커스가 옮겨가도 재조회되도록 load의 dep으로 쓴다(Codex P2). 단 중앙 surface로
  // 렌더될 땐 prop cwd(생성 시 캡처된 surface.cwd)가 repo base로 우선한다 — 자기
  // 빈 cwd를 활성 pane에서 읽어 repo가 틀어지는 문제를 막는다. prop 미제공(덱 하위
  // 호환) 시에만 selectActivePaneCwd 폴백.
  const activePaneCwd = useStore(selectActivePaneCwd);
  const activeCwd = cwd ?? activePaneCwd;
  const pushToast = useStore((s) => s.pushToast);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  // 본(main) 워크트리 경로 — "main" 배지·Remove 숨김 기준. 현재 워크트리
  // (dot 기준)와 별개다: linked worktree에서 열면 둘이 다르다(dogfood 실측).
  const [mainPath, setMainPath] = useState<string>('');
  const [currentWorktree, setCurrentWorktree] = useState<string>('');
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState('');
  const [busy, setBusy] = useState(false);
  // Monotonic load token — 빠른 repo(pane cwd) 전환 시 늦게 도착한 이전 응답이
  // 새 결과를 덮지 않게 한다(ReviewTab:97 패턴 복제). 최신 load()만 commit.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    const { worktree, resolveRepo } = getBridges();
    if (!worktree || !resolveRepo) {
      if (seq !== loadSeq.current) return;
      setError('bridge unavailable');
      setLoading(false);
      return;
    }
    const cwd = activeCwd;
    const resolved = cwd ? await resolveRepo(cwd) : ({ ok: false } as const);
    if (seq !== loadSeq.current) return; // superseded by a newer load
    if (!resolved.ok) {
      setRepoPath(null);
      setWorktrees([]);
      setLoading(false);
      return;
    }
    setCurrentWorktree(resolved.repoPath);
    const res = await worktree.list(resolved.repoPath);
    if (seq !== loadSeq.current) return; // superseded by a newer load
    if (!res.ok) {
      setError(res.error);
      setRepoPath(null);
      setWorktrees([]);
    } else {
      setRepoPath(res.repoPath);
      setMainPath(res.mainPath);
      setWorktrees(res.worktrees);
    }
    setLoading(false);
  }, [activeCwd]);

  // 탭 마운트 시 + 활성 워크스페이스/pane cwd 변경 시 재조회(pull-only).
  // load가 activeCwd에 의존하므로 pane 포커스 전환도 여기서 재조회된다.
  useEffect(() => {
    void load();
  }, [load, activeWorkspaceId]);

  const handleCreate = useCallback(async () => {
    const branch = newBranch.trim();
    if (!branch || !repoPath || busy) return;
    const { worktree } = getBridges();
    if (!worktree) return;
    setBusy(true);
    // try/finally: IPC가 {ok:false} 대신 reject해도 busy가 풀리도록(Codex P2).
    try {
      const res = await worktree.add(repoPath, branch);
      if (!res.ok) {
        pushToast({ level: 'warn', message: `${t('git.createFailed')}: ${res.error}` });
        return;
      }
      setNewBranch('');
      void load();
    } catch (e) {
      pushToast({ level: 'warn', message: `${t('git.createFailed')}: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [newBranch, repoPath, busy, pushToast, t, load]);

  const handleRemove = useCallback(
    async (wt: WorktreeEntry) => {
      if (!repoPath || busy) return;
      if (!window.confirm(`${t('git.removeConfirm')}\n${wt.path}`)) return;
      const { worktree } = getBridges();
      if (!worktree) return;
      setBusy(true);
      try {
        const res = await worktree.remove(repoPath, wt.path);
        if (!res.ok) {
          // dirty 워크트리 등 — git의 거부 사유를 그대로 표면화(--force 미제공).
          pushToast({ level: 'warn', message: `${t('git.removeFailed')}: ${res.error}` });
          return;
        }
        void load();
      } catch (e) {
        pushToast({ level: 'warn', message: `${t('git.removeFailed')}: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setBusy(false);
      }
    },
    [repoPath, busy, pushToast, t, load],
  );

  const handleOpen = useCallback((wt: WorktreeEntry) => {
    const st = useStore.getState();
    st.addWorkspace(wt.branch ?? pathLeaf(wt.path));
    // addWorkspace가 새 ws를 활성화하므로 activeWorkspaceId = 새 ws. 새 pane의
    // 터미널은 profile.startupCwd에서 스폰된다(스폰 시 tolerant 폴백 내장).
    const fresh = useStore.getState();
    fresh.setWorkspaceProfile(fresh.activeWorkspaceId, { startupCwd: wt.path });
  }, []);

  // diff 서피스 열기 — 워크트리 path는 이미 toplevel이라 resolveRepo 불요,
  // 팔레트 "Show Git Diff"와 동일 결과(같은 repoPath면 기존 탭 전환 dedup 포함).
  // 활성 워크스페이스의 활성 leaf pane에 탭을 얹는다.
  const handleDiff = useCallback((targetPath: string) => {
    const st = useStore.getState();
    const ws = st.workspaces.find((w) => w.id === st.activeWorkspaceId);
    if (!ws) return;
    const findLeaf = (pane: Pane): PaneLeaf | null => {
      if (pane.type === 'leaf') return pane.id === ws.activePaneId ? pane : null;
      for (const child of pane.children) {
        const found = findLeaf(child);
        if (found) return found;
      }
      return null;
    };
    const leaf = findLeaf(ws.rootPane);
    if (!leaf) return;
    st.addWorkspaceDiffSurface(leaf.id, targetPath, `diff: ${pathLeaf(targetPath)}`);
  }, []);

  const norm = (p: string) => p.replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();
  const isMain = (wt: WorktreeEntry) => mainPath !== '' && norm(wt.path) === norm(mainPath);
  const isCurrent = (wt: WorktreeEntry) => currentWorktree !== '' && norm(wt.path) === norm(currentWorktree);

  return (
    <div data-git-tab className="flex flex-col flex-1 min-h-0 text-[12px]">
      {/* Pull Requests 섹션 — gh 기반(미설치/비GitHub은 안내문으로 강등). */}
      <PrSection repoPath={repoPath} />
      {/* 워크트리 섹션 헤더 — 36px 크롬 행. */}
      <div
        className="flex items-center gap-2 h-9 px-3 shrink-0 border-b border-[var(--bg-surface)]"
        style={{ borderColor: 'var(--border-soft)' }}
        {...tokenAttrs('bgSurface', 'border')}
      >
        <span className="font-semibold text-[var(--text-main)]" {...tokenAttrs('textMain', 'text')}>
          {t('git.worktrees') || 'Worktrees'}
        </span>
        {repoPath && (
          <span
            className="font-mono text-[10.5px] text-[var(--text-muted)] truncate"
            title={repoPath}
            {...tokenAttrs('textMuted', 'text')}
          >
            {pathLeaf(repoPath)}
          </span>
        )}
        <div className="flex-1" />
        {/* 현재 repo(활성 pane의 워크트리) diff — 팔레트 커맨드의 버튼 진입점. */}
        {repoPath && (
          <button
            type="button"
            onClick={() => handleDiff(currentWorktree || repoPath)}
            title={t('git.diffDesc') || 'Open the diff view for this repo'}
            data-git-diff-current
            className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-sub)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] ${FOCUS_RING}`}
            {...tokenAttrs('textSub', 'text')}
          >
            {t('git.diff') || 'Diff'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void load()}
          title={t('git.refresh') || 'Refresh'}
          aria-label={t('git.refresh') || 'Refresh'}
          className={`flex items-center justify-center w-6 h-6 rounded text-[var(--text-muted)] hover:text-[var(--text-sub)] transition-colors ${FOCUS_RING}`}
          {...tokenAttrs('textMuted', 'text')}
        >
          {/* monochrome refresh glyph */}
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M12 7a5 5 0 11-1.5-3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M12 1v2.6H9.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* 본문 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="px-3 py-4 text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
            {t('git.loading') || 'Loading…'}
          </div>
        )}
        {!loading && error && (
          <div className="px-3 py-4 text-[var(--text-muted)] break-all" {...tokenAttrs('textMuted', 'text')}>
            {error}
          </div>
        )}
        {!loading && !error && !repoPath && (
          <div className="px-3 py-4 text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
            {t('git.noRepo') || 'Not a git repository — focus a pane inside a repo.'}
          </div>
        )}
        {!loading && !error && repoPath && (
          <ul data-git-worktree-list>
            {worktrees.map((wt) => (
              <li
                key={wt.path}
                className="group flex items-center gap-2 px-3 h-9 border-b border-[var(--bg-surface)] hover:bg-[rgba(var(--bg-surface-rgb),0.5)]"
                style={{ borderColor: 'var(--border-soft)' }}
              >
                {/* 현재(활성 pane이 속한) 워크트리만 amber 1포인트. */}
                <span
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    isCurrent(wt) ? 'bg-[var(--accent)]' : 'bg-[var(--bg-overlay)]'
                  }`}
                  {...(isCurrent(wt) ? tokenAttrs('accent', 'bg') : {})}
                />
                <div className="flex flex-col min-w-0 flex-1 leading-tight">
                  <span className="text-[var(--text-main)] truncate" {...tokenAttrs('textMain', 'text')}>
                    {wt.branch ?? `(${t('git.detached') || 'detached'} ${wt.headOid.slice(0, 7)})`}
                  </span>
                  <span
                    className="font-mono text-[10px] text-[var(--text-muted)] truncate"
                    title={wt.path}
                    {...tokenAttrs('textMuted', 'text')}
                  >
                    {pathLeaf(wt.path)}
                    {wt.locked !== null && ` · ${t('git.locked') || 'locked'}`}
                    {wt.prunable !== null && ` · ${t('git.prunable') || 'prunable'}`}
                  </span>
                </div>
                {/* 이 워크트리의 diff 서피스 열기(경로=toplevel 그대로). */}
                <button
                  type="button"
                  onClick={() => handleDiff(wt.path)}
                  className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] opacity-0 group-hover:opacity-100 transition-opacity ${FOCUS_RING}`}
                  title={t('git.diffDesc') || 'Open the diff view for this worktree'}
                  {...tokenAttrs('textMuted', 'text')}
                >
                  {t('git.diff') || 'Diff'}
                </button>
                <button
                  type="button"
                  onClick={() => handleOpen(wt)}
                  className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] opacity-0 group-hover:opacity-100 transition-opacity ${FOCUS_RING}`}
                  title={t('git.openDesc') || 'Open as a new workspace'}
                  {...tokenAttrs('textMuted', 'text')}
                >
                  {t('git.open') || 'Open'}
                </button>
                {isMain(wt) ? (
                  <span className="text-[10px] text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                    {t('git.main') || 'main'}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleRemove(wt)}
                    disabled={busy}
                    className={`px-1.5 py-0.5 rounded text-[10.5px] text-[var(--text-muted)] hover:text-[var(--accent-red,#f87171)] border border-[var(--bg-surface)] opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-40 ${FOCUS_RING}`}
                    title={t('git.removeDesc') || 'Remove worktree (refused if dirty)'}
                    {...tokenAttrs('textMuted', 'text')}
                  >
                    {t('git.remove') || 'Remove'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 새 워크트리 — 브랜치명 입력 한 줄(관례 위치는 main이 도출). */}
      {repoPath && (
        <div
          className="flex items-center gap-1.5 h-9 px-2 shrink-0 border-t border-[var(--bg-surface)]"
          style={{ borderColor: 'var(--border-soft)' }}
          {...tokenAttrs('bgSurface', 'border')}
        >
          <input
            type="text"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            placeholder={t('git.newBranchPlaceholder') || 'new branch name…'}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent font-mono text-[11px] text-[var(--text-main)] placeholder-[var(--text-muted)] outline-none px-1"
            {...tokenAttrs('textMain', 'text')}
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={busy || !newBranch.trim()}
            className={`px-2 py-0.5 rounded text-[10.5px] text-[var(--text-sub)] hover:text-[var(--text-main)] border border-[var(--bg-surface)] disabled:opacity-40 ${FOCUS_RING}`}
            {...tokenAttrs('textSub', 'text')}
          >
            {t('git.create') || 'Create'}
          </button>
        </div>
      )}
    </div>
  );
}

export default GitTab;
