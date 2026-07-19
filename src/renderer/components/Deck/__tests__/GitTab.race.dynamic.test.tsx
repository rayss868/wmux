// @vitest-environment jsdom
//
// GitTab load() 경쟁 가드 회귀 테스트(loadSeq 모노토닉 토큰). 빠른 repo(pane cwd)
// 전환 시 늦게 도착한 이전 응답이 새 결과를 덮으면 안 된다 — 늦은 repo-A 응답이
// 먼저 커밋된 repo-B 워크트리를 덮지 않는지 확인한다. 패키징 UI는 자동화 불가라
// 이 jsdom 하네스가 검증면이다.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { GitTab } from '../GitTab';
import type { SessionData, Workspace } from '../../../../shared/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const listDeferreds = new Map<string, Deferred<unknown>>();

function makeWs(cwd: string): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'leaf',
      type: 'leaf',
      activeSurfaceId: 's1',
      surfaces: [{ id: 's1', ptyId: 'pty-1', title: 't', shell: 'bash', cwd, surfaceType: 'terminal' }],
    },
    activePaneId: 'leaf',
  } as unknown as Workspace;
}

function seed(cwd: string): void {
  const data: SessionData = { workspaces: [makeWs(cwd)], activeWorkspaceId: 'ws-1', sidebarVisible: true };
  act(() => useStore.getState().loadSession(data));
}

function wtResult(repoPath: string, branch: string) {
  return {
    ok: true,
    repoPath,
    mainPath: repoPath,
    worktrees: [{ path: repoPath, branch, headOid: '0000000', locked: null, prunable: null }],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  listDeferreds.clear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    diff: { resolveRepo: (cwd: string) => Promise.resolve({ ok: true, repoPath: cwd }) },
    worktree: {
      list: (repoPath: string) => {
        const d = deferred<unknown>();
        listDeferreds.set(repoPath, d);
        return d.promise;
      },
      add: vi.fn(),
      remove: vi.fn(),
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('GitTab load() race guard', () => {
  it('a late repo-A response does not overwrite the newer repo-B roster', async () => {
    seed('/repoA');
    act(() => root.render(createElement(GitTab)));
    await flush(); // load(A) → list('/repoA') pending

    // pane cwd 전환 → load(B) 재실행.
    act(() => useStore.setState({ workspaces: [makeWs('/repoB')] }));
    await flush(); // load(B) → list('/repoB') pending

    expect(listDeferreds.has('/repoA')).toBe(true);
    expect(listDeferreds.has('/repoB')).toBe(true);

    // 새 것(B) 먼저 커밋.
    act(() => listDeferreds.get('/repoB')!.resolve(wtResult('/repoB', 'branch-B')));
    await flush();
    expect(container.querySelector('[data-git-worktree-list]')?.textContent).toContain('branch-B');

    // 늦은 A 응답 — 가드가 막아 B를 덮지 않아야 한다.
    act(() => listDeferreds.get('/repoA')!.resolve(wtResult('/repoA', 'branch-A')));
    await flush();
    const list = container.querySelector('[data-git-worktree-list]')?.textContent ?? '';
    expect(list).toContain('branch-B');
    expect(list).not.toContain('branch-A');
  });
});
