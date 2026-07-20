// Handler tests for worktree merge-session ops (start/status/discard) — real temp repo.
// The conflict path skips verify (npm), so it's deterministic, and it verifies the
// session registry, lock keys, and the isolated integration worktree
// create/remove lifecycle through the IPC surface.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import type { MergeStartResult, MergeStatusResult, MergeActionResult } from '../worktree.handler';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// main (main2 commit) + feat worktree (feat commit that conflicts with main2). They conflict on f.txt.
function makeConflictScenario(): { base: string; repo: string; featWt: string; cleanup: () => void } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-wtm-')));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@t']);
  g(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'f.txt'), 'a\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'base']);
  // feat: change f.txt to FEAT.
  g(repo, ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(repo, 'f.txt'), 'FEAT\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'feat']);
  g(repo, ['checkout', '-q', 'main']);
  // main2: change f.txt to MAIN (conflicts with feat).
  writeFileSync(join(repo, 'f.txt'), 'MAIN\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'main2']);
  // Check out feat as a linked worktree (source).
  const featWt = join(base, 'feat-wt');
  g(repo, ['worktree', 'add', '-q', featWt, 'feat']);
  return { base, repo, featWt, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe('worktree.handler — merge session (conflict path) start/status/discard', () => {
  let scn: ReturnType<typeof makeConflictScenario>;
  beforeEach(() => {
    captured.clear();
    registerWorktreeHandlers();
    scn = makeConflictScenario();
  });
  afterEach(() => scn.cleanup());

  it('start(conflict) → conflicted + integration created → cleaned up by discard', async () => {
    const start = captured.get(IPC.WORKTREE_MERGE_START)!;
    const status = captured.get(IPC.WORKTREE_MERGE_STATUS)!;
    const discard = captured.get(IPC.WORKTREE_MERGE_DISCARD)!;

    const s = (await start({}, scn.repo, scn.featWt)) as MergeStartResult;
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.status.phase).toBe('conflicted');
    expect(s.status.conflicts).toEqual(['f.txt']);
    expect(s.status.baseBranch).toBe('main');
    expect(existsSync(s.status.integrationPath)).toBe(true);

    // status also returns the same session (conflicted).
    const st = (await status({}, scn.repo)) as MergeStatusResult;
    expect(st.ok).toBe(true);
    if (st.ok) expect(st.status?.phase).toBe('conflicted');

    // A concurrent start is rejected (session-existence tracking).
    const dup = (await start({}, scn.repo, scn.featWt)) as MergeStartResult;
    expect(dup.ok).toBe(false);

    // discard → removes integration, session gone (status null).
    const integrationPath = s.status.integrationPath;
    const d = (await discard({}, scn.repo)) as MergeActionResult;
    expect(d.ok).toBe(true);
    expect(existsSync(integrationPath)).toBe(false);
    const st2 = (await status({}, scn.repo)) as MergeStatusResult;
    expect(st2.ok).toBe(true);
    if (st2.ok) expect(st2.status).toBeNull();
  });

  it('start — rejected by a precondition failure when the target (base) is dirty', async () => {
    // Make the main worktree dirty.
    writeFileSync(join(scn.repo, 'dirty.txt'), 'x\n');
    const start = captured.get(IPC.WORKTREE_MERGE_START)!;
    const s = (await start({}, scn.repo, scn.featWt)) as MergeStartResult;
    expect(s.ok).toBe(false);
  });
});
