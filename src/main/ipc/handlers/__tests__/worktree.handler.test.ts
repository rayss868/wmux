// worktree:list / add / remove 핸들러 테스트 — 실제 임시 git repo로 왕복 검증.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';

const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

import { registerWorktreeHandlers } from '../worktree.handler';
import { IPC } from '../../../../shared/constants';
import type { WorktreeEntry } from '../../../../shared/worktreeParse';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): { base: string; repo: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'wmux-wth-'));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@t']);
  g(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'base']);
  return { base, repo, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

type ListRes = { ok: boolean; repoPath?: string; worktrees?: WorktreeEntry[]; error?: string };
type MutRes = { ok: boolean; worktreePath?: string; error?: string };

describe('worktree.handler — list/add/remove 왕복', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    captured.clear();
    registerWorktreeHandlers();
    scn = makeRepo();
  });
  afterEach(() => scn.cleanup());

  it('add(새 브랜치) → list에 나타남 → remove → list에서 사라짐', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;

    const a = (await add({}, scn.repo, 'feat/x')) as MutRes;
    expect(a.ok).toBe(true);
    // 관례 위치: <repo부모>/<repo이름>-worktrees/<branch-dir>.
    expect(dirname(a.worktreePath!)).toBe(join(dirname(scn.repo), `${basename(scn.repo)}-worktrees`));
    expect(existsSync(a.worktreePath!)).toBe(true);

    const l = (await list({}, scn.repo)) as ListRes;
    expect(l.ok).toBe(true);
    expect(l.worktrees!.map((w) => w.branch)).toContain('feat/x');

    const r = (await remove({}, scn.repo, a.worktreePath!)) as MutRes;
    expect(r.ok).toBe(true);
    const l2 = (await list({}, scn.repo)) as ListRes;
    expect(l2.worktrees!.map((w) => w.branch)).not.toContain('feat/x');
  });

  it('add — 기존 브랜치는 -b 없이 체크아웃', async () => {
    g(scn.repo, ['branch', 'existing']);
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const a = (await add({}, scn.repo, 'existing')) as MutRes;
    expect(a.ok).toBe(true);
    const head = g(a.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    expect(head).toBe('existing');
  });

  it('add — 위험 브랜치명(-플래그·traversal) fail-soft 거부', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    for (const bad of ['--force', 'a..b', 'a b']) {
      const r = (await add({}, scn.repo, bad)) as MutRes;
      expect(r.ok).toBe(false);
    }
  });

  it('remove — dirty 워크트리는 git 거부 사유를 그대로 표면화(--force 없음)', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;
    const a = (await add({}, scn.repo, 'feat/dirty')) as MutRes;
    writeFileSync(join(a.worktreePath!, 'junk.txt'), 'x\n');
    const r = (await remove({}, scn.repo, a.worktreePath!)) as MutRes;
    expect(r.ok).toBe(false);
    expect(existsSync(a.worktreePath!)).toBe(true); // 워크트리 보존.
  });

  it('remove — 목록에 없는 임의 경로·본 워크트리 거부', async () => {
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;
    const arb = (await remove({}, scn.repo, join(scn.base, 'not-a-worktree'))) as MutRes;
    expect(arb.ok).toBe(false);
    expect(arb.error).toContain('not a listed worktree');
    const main = (await remove({}, scn.repo, scn.repo)) as MutRes;
    expect(main.ok).toBe(false);
    expect(main.error).toContain('main worktree');
  });

  it('list — linked worktree 컨텍스트에서도 mainPath는 본 repo(dogfood 회귀)', async () => {
    const add = captured.get(IPC.WORKTREE_ADD)!;
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const a = (await add({}, scn.repo, 'feat/ctx')) as MutRes;
    expect(a.ok).toBe(true);
    // 링크드 워크트리 "안에서" 목록을 열면: repoPath=자기 자신, mainPath=본 repo.
    const r = (await list({}, a.worktreePath!)) as ListRes & { mainPath?: string };
    expect(r.ok).toBe(true);
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    expect(norm(r.repoPath!)).toBe(norm(a.worktreePath!));
    expect(norm(r.mainPath!)).toBe(norm(scn.repo));
    // 본 워크트리 remove는 어느 컨텍스트에서도 거부.
    const remove = captured.get(IPC.WORKTREE_REMOVE)!;
    const m = (await remove({}, a.worktreePath!, scn.repo)) as MutRes;
    expect(m.ok).toBe(false);
    expect(m.error).toContain('main worktree');
  });

  it('list — 비-git 경로는 fail-soft', async () => {
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const plain = join(scn.base, 'plain');
    mkdirSync(plain);
    const r = (await list({}, plain)) as ListRes;
    expect(r.ok).toBe(false);
  });

  it('list — 서브디렉토리 경로도 toplevel로 정규화해 성공', async () => {
    mkdirSync(join(scn.repo, 'sub'));
    const list = captured.get(IPC.WORKTREE_LIST)!;
    const r = (await list({}, join(scn.repo, 'sub'))) as ListRes;
    expect(r.ok).toBe(true);
    expect(r.worktrees!.length).toBeGreaterThanOrEqual(1);
  });
});
