// @vitest-environment jsdom
//
// 시안 A — GitTab이 중앙 페인 surface로 렌더될 때 prop cwd를 repo base로 우선
// 사용하는지 검증한다. 활성 pane의 cwd(예: 빈 유틸 surface의 '')를 읽으면 repo가
// 틀어지므로, 생성 시 캡처된 surface.cwd를 prop으로 주입하는 경로가 이긴다.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act, type FC } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { GitTab } from '../GitTab';
import type { SessionData, Workspace } from '../../../../shared/types';

// 활성 pane의 cwd — prop이 우선한다면 resolveRepo는 이 값이 아니라 prop을 받아야 한다.
function makeWs(activeCwd: string): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'leaf',
      type: 'leaf',
      activeSurfaceId: 's1',
      surfaces: [{ id: 's1', ptyId: 'pty-1', title: 't', shell: 'bash', cwd: activeCwd, surfaceType: 'terminal' }],
    },
    activePaneId: 'leaf',
  } as unknown as Workspace;
}

let container: HTMLDivElement;
let root: Root;
const resolveRepo = vi.fn((cwd: string) => Promise.resolve({ ok: true as const, repoPath: cwd }));

beforeEach(() => {
  resolveRepo.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    diff: { resolveRepo },
    worktree: {
      list: (repoPath: string) =>
        Promise.resolve({ ok: true, repoPath, mainPath: repoPath, worktrees: [] }),
      add: vi.fn(),
      remove: vi.fn(),
    },
  };
  const data: SessionData = {
    workspaces: [makeWs('/active/pane/cwd')],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
  act(() => useStore.getState().loadSession(data));
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

describe('GitTab — prop cwd가 repo base로 우선', () => {
  it('prop cwd가 있으면 활성 pane cwd 대신 그 값으로 repo를 해석한다', async () => {
    act(() => root.render(createElement(GitTab as FC<{ cwd?: string }>, { cwd: '/central/surface/repo' })));
    await flush();
    expect(resolveRepo).toHaveBeenCalledWith('/central/surface/repo');
    expect(resolveRepo).not.toHaveBeenCalledWith('/active/pane/cwd');
  });

  it('prop cwd가 없으면 활성 pane cwd로 폴백한다(덱 하위호환)', async () => {
    act(() => root.render(createElement(GitTab)));
    await flush();
    expect(resolveRepo).toHaveBeenCalledWith('/active/pane/cwd');
  });
});
