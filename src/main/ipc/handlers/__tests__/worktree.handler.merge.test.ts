// worktree 머지 세션 op(start/status/discard) 핸들러 테스트 — 실제 임시 repo.
// 충돌 경로를 쓰면 verify(npm)를 타지 않아 결정적이고, 세션 레지스트리·락 키·
// 격리 integration 워크트리 생성/제거 라이프사이클을 IPC 표면으로 검증한다.
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

// main(main2 커밋) + feat 워크트리(main2와 충돌하는 feat 커밋). 둘은 f.txt에서 충돌.
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
  // feat: f.txt를 FEAT로.
  g(repo, ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(repo, 'f.txt'), 'FEAT\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'feat']);
  g(repo, ['checkout', '-q', 'main']);
  // main2: f.txt를 MAIN으로(feat와 충돌).
  writeFileSync(join(repo, 'f.txt'), 'MAIN\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'main2']);
  // feat를 linked 워크트리로 체크아웃(source).
  const featWt = join(base, 'feat-wt');
  g(repo, ['worktree', 'add', '-q', featWt, 'feat']);
  return { base, repo, featWt, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe('worktree.handler — 머지 세션(충돌 경로) start/status/discard', () => {
  let scn: ReturnType<typeof makeConflictScenario>;
  beforeEach(() => {
    captured.clear();
    registerWorktreeHandlers();
    scn = makeConflictScenario();
  });
  afterEach(() => scn.cleanup());

  it('start(충돌) → conflicted + integration 생성 → discard로 정리', async () => {
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

    // status도 같은 세션(conflicted)을 돌려준다.
    const st = (await status({}, scn.repo)) as MergeStatusResult;
    expect(st.ok).toBe(true);
    if (st.ok) expect(st.status?.phase).toBe('conflicted');

    // 동시 start는 거부(세션 존재 추적).
    const dup = (await start({}, scn.repo, scn.featWt)) as MergeStartResult;
    expect(dup.ok).toBe(false);

    // discard → integration 제거, 세션 소멸(status null).
    const integrationPath = s.status.integrationPath;
    const d = (await discard({}, scn.repo)) as MergeActionResult;
    expect(d.ok).toBe(true);
    expect(existsSync(integrationPath)).toBe(false);
    const st2 = (await status({}, scn.repo)) as MergeStatusResult;
    expect(st2.ok).toBe(true);
    if (st2.ok) expect(st2.status).toBeNull();
  });

  it('start — 타겟(base)이 dirty면 전제조건 실패로 거부', async () => {
    // main 워크트리를 dirty하게.
    writeFileSync(join(scn.repo, 'dirty.txt'), 'x\n');
    const start = captured.get(IPC.WORKTREE_MERGE_START)!;
    const s = (await start({}, scn.repo, scn.featWt)) as MergeStartResult;
    expect(s.ok).toBe(false);
  });
});
