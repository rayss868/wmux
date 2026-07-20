import { describe, expect, it } from 'vitest';
import { createWorkspace, type PaneLeaf, type Workspace } from '../../../../shared/types';
import { createSurfaceSlice } from '../surfaceSlice';

type TestState = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  surfaceAgent: Record<string, { name: string; status: string }>;
  surfaceActivity: Record<string, string>;
};

function createHarness() {
  const workspace = createWorkspace('Test');
  const state: TestState = {
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    surfaceAgent: {},
    surfaceActivity: {},
  };

  const set = (updater: (state: TestState) => void) => {
    updater(state);
  };

  const slice = createSurfaceSlice(set as never, (() => state) as never, {} as never);
  return { state, slice };
}

describe('surfaceSlice.addSurface — workspace targeting (#236)', () => {
  it('lands the surface in a background workspace when workspaceId is given', () => {
    const { state, slice } = createHarness();
    const ws1 = state.workspaces[0];
    const ws2 = createWorkspace('Background');
    state.workspaces.push(ws2);

    slice.addSurface(ws2.rootPane.id, 'pty-bg', 'pwsh', 'D:\\bg', ws2.id);

    const ws2Pane = state.workspaces.find((w) => w.id === ws2.id)!.rootPane;
    if (ws2Pane.type !== 'leaf') throw new Error('expected leaf');
    // 터미널 + 자동 세트(Git·Review) = 3 (시안 A — 워크스페이스 첫 터미널에 세트 동반)
    expect(ws2Pane.surfaces).toHaveLength(3);
    expect(ws2Pane.surfaces[0].ptyId).toBe('pty-bg');
    expect(ws2Pane.surfaces.map((s) => s.surfaceType)).toEqual(
      expect.arrayContaining(['git', 'review']),
    );
    // 터미널이 활성 유지(세트는 배경 탭)
    expect(ws2Pane.activeSurfaceId).toBe(ws2Pane.surfaces[0].id);

    // ws1 (the active ws) must NOT receive the surface.
    const ws1Pane = ws1.rootPane;
    if (ws1Pane.type !== 'leaf') throw new Error('expected leaf');
    expect(ws1Pane.surfaces).toHaveLength(0);
    expect(state.activeWorkspaceId).toBe(ws1.id);
  });

  it('defaults to the active workspace when workspaceId is omitted (back-compat)', () => {
    const { state, slice } = createHarness();
    slice.addSurface(state.workspaces[0].rootPane.id, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    // 터미널 + 자동 Git·Review 세트
    expect(pane.surfaces).toHaveLength(3);
    expect(pane.surfaces[0].ptyId).toBe('pty-1');
    // git surface는 터미널 시작 cwd를 repo base로 캡처
    expect(pane.surfaces.find((s) => s.surfaceType === 'git')?.cwd).toBe('C:\\a');
  });
});

describe('surfaceSlice.addDiffSurface — J2 4번째 서피스', () => {
  it('diff 서피스는 ptyId="" + surfaceType="diff" + taskId 영속(PTY 자가생성 방지 불변식)', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addDiffSurface(paneId, 'wtask-42', 'My Diff');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(1);
    const s = pane.surfaces[0];
    expect(s.surfaceType).toBe('diff');
    // PTY 없음 — 복원 시 자가생성 경로에 걸리지 않음(스펙 §1 성공기준).
    expect(s.ptyId).toBe('');
    expect(s.diffTaskId).toBe('wtask-42');
    expect(s.title).toBe('My Diff');
    expect(pane.activeSurfaceId).toBe(s.id);
  });

  it('같은 taskId 재요청 시 새 탭 대신 기존 탭 전환', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addDiffSurface(paneId, 'wtask-1');
    slice.addDiffSurface(paneId, 'wtask-2');
    slice.addDiffSurface(paneId, 'wtask-1'); // 중복.
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(2); // 3개가 아니라 2개.
    const first = pane.surfaces.find((s) => s.diffTaskId === 'wtask-1')!;
    expect(pane.activeSurfaceId).toBe(first.id); // 첫 탭으로 전환됨.
  });

  it('workspaceId로 백그라운드 워크스페이스 타겟팅', () => {
    const { state, slice } = createHarness();
    const ws2 = createWorkspace('BG');
    state.workspaces.push(ws2);
    slice.addDiffSurface(ws2.rootPane.id, 'wtask-bg', undefined, ws2.id);
    const bgPane = state.workspaces.find((w) => w.id === ws2.id)!.rootPane;
    if (bgPane.type !== 'leaf') throw new Error('expected leaf');
    expect(bgPane.surfaces).toHaveLength(1);
    expect(bgPane.surfaces[0].diffTaskId).toBe('wtask-bg');
  });
});

describe('surfaceSlice.addWorkspaceDiffSurface — 워크스페이스 diff 서피스', () => {
  it('ptyId="" + surfaceType="diff" + diffRepoPath 영속(diffTaskId 없음)', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addWorkspaceDiffSurface(paneId, 'D:\\proj\\repo', 'diff: repo');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(1);
    const s = pane.surfaces[0];
    expect(s.surfaceType).toBe('diff');
    // PTY 없음 — 복원 시 자가생성 경로에 걸리지 않음(diffTaskId 서피스와 동일 불변식).
    expect(s.ptyId).toBe('');
    expect(s.diffRepoPath).toBe('D:\\proj\\repo');
    expect(s.diffTaskId).toBeUndefined();
    expect(s.title).toBe('diff: repo');
    expect(pane.activeSurfaceId).toBe(s.id);
  });

  it('같은 repoPath 재요청 시 새 탭 대신 기존 탭 전환', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addWorkspaceDiffSurface(paneId, 'D:\\a');
    slice.addWorkspaceDiffSurface(paneId, 'D:\\b');
    slice.addWorkspaceDiffSurface(paneId, 'D:\\a'); // 중복.
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(2);
    const first = pane.surfaces.find((s) => s.diffRepoPath === 'D:\\a')!;
    expect(pane.activeSurfaceId).toBe(first.id);
  });

  it('태스크 diff(diffTaskId)와 워크스페이스 diff(diffRepoPath)는 서로 dedup되지 않음', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addDiffSurface(paneId, 'wtask-1');
    slice.addWorkspaceDiffSurface(paneId, 'D:\\repo');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(2);
  });
});

describe('surfaceSlice.updateSurfaceCwd', () => {
  it('updates the cwd of the surface bound to a ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\start');

    slice.updateSurfaceCwd('pty-1', 'D:\\proj\\api');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].cwd).toBe('D:\\proj\\api');
  });

  it('only touches the surface that owns the ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    slice.addSurface(paneId, 'pty-2', 'pwsh', 'C:\\b');

    slice.updateSurfaceCwd('pty-2', 'D:\\moved');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces.find((s) => s.ptyId === 'pty-1')?.cwd).toBe('C:\\a');
    expect(pane.surfaces.find((s) => s.ptyId === 'pty-2')?.cwd).toBe('D:\\moved');
  });

  it('is a no-op for an empty or unknown ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');

    slice.updateSurfaceCwd('', 'D:\\nope');
    slice.updateSurfaceCwd('ghost', 'D:\\nope');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].cwd).toBe('C:\\a');
  });
});

describe('surfaceSlice.updateSurfaceTitle', () => {
  it('renames the surface with the given id (the tab "mark")', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.updateSurfaceTitle(surfaceId, 'api-server');

    expect(pane.surfaces[0].title).toBe('api-server');
  });
});

describe('surfaceSlice.updateSurfaceTitleByPty', () => {
  it('sets the title of the terminal surface bound to a ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');

    slice.updateSurfaceTitleByPty('pty-1', 'claude: feature-x');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].title).toBe('claude: feature-x');
  });

  it('is a no-op for an unknown ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane0 = state.workspaces[0].rootPane;
    if (pane0.type !== 'leaf') throw new Error('expected leaf pane');
    const before = pane0.surfaces[0].title;

    slice.updateSurfaceTitleByPty('ghost', 'nope');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].title).toBe(before);
  });

  it('is ignored once the surface title is locked by a manual rename', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.updateSurfaceTitle(surfaceId, 'my-name'); // manual rename → locks
    slice.updateSurfaceTitleByPty('pty-1', 'shell-set'); // must be ignored

    expect(pane.surfaces[0].title).toBe('my-name');
    expect(pane.surfaces[0].titleLocked).toBe(true);
  });
});

describe('surfaceSlice.updateBrowserUrl', () => {
  function harnessWithBrowser() {
    const h = createHarness();
    const paneId = h.state.workspaces[0].rootPane.id;
    h.slice.addBrowserSurface(paneId, 'https://start.example', 'persist:wmux-default');
    const pane = h.state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    return { ...h, pane, surfaceId: pane.surfaces[0].id };
  }

  it('persists the navigated URL on the browser surface', () => {
    const { pane, slice, surfaceId } = harnessWithBrowser();

    slice.updateBrowserUrl(surfaceId, 'http://localhost:5173/app');

    expect(pane.surfaces[0].browserUrl).toBe('http://localhost:5173/app');
  });

  it('ignores non-http(s) URLs (about:blank must not survive into the session)', () => {
    const { pane, slice, surfaceId } = harnessWithBrowser();

    slice.updateBrowserUrl(surfaceId, 'about:blank');
    slice.updateBrowserUrl(surfaceId, 'devtools://devtools/x');

    expect(pane.surfaces[0].browserUrl).toBe('https://start.example');
  });

  it('ignores terminal surfaces and unknown surface ids', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');

    slice.updateBrowserUrl(pane.surfaces[0].id, 'http://localhost:1');
    slice.updateBrowserUrl('ghost', 'http://localhost:1');

    expect(pane.surfaces[0].browserUrl).toBeUndefined();
  });
});

describe('surfaceSlice.setActiveSurface', () => {
  it('targets the active workspace when no workspaceId is given', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', '');
    slice.addSurface(paneId, 'pty-2', 'pwsh', '');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');

    slice.setActiveSurface(paneId, pane.surfaces[0].id);

    expect(pane.activeSurfaceId).toBe(pane.surfaces[0].id);
  });

  it('targets a non-active workspace via the workspaceId parameter', () => {
    const { state, slice } = createHarness();
    const other = createWorkspace('Other');
    state.workspaces.push(other);
    slice.addBrowserSurface(other.rootPane.id, 'https://x.example', undefined, other.id);
    const pane = other.rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    pane.surfaces.push({ ...pane.surfaces[0], id: 'surface-second' });

    slice.setActiveSurface(pane.id, pane.surfaces[0].id, other.id);

    expect(pane.activeSurfaceId).toBe(pane.surfaces[0].id);
    expect(state.activeWorkspaceId).not.toBe(other.id);
  });
});

describe('surfaceSlice.closeSurface', () => {
  it('targets the active workspace when no workspaceId is given', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', '');
    slice.addSurface(paneId, 'pty-2', 'pwsh', '');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const firstId = pane.surfaces[0].id;

    slice.closeSurface(paneId, firstId);

    // pty-2 터미널 + 자동 Git·Review 세트(첫 addSurface에서 동반 생성)
    expect(pane.surfaces).toHaveLength(3);
    expect(pane.surfaces.find((s) => s.id === firstId)).toBeUndefined();
  });

  it('targets a non-active workspace via the workspaceId parameter', () => {
    const { state, slice } = createHarness();
    const other = createWorkspace('Other');
    state.workspaces.push(other);
    slice.addBrowserSurface(other.rootPane.id, 'https://x.example', undefined, other.id);
    const pane = other.rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.closeSurface(pane.id, surfaceId, other.id);

    expect(pane.surfaces).toHaveLength(0);
    expect(state.activeWorkspaceId).not.toBe(other.id);
  });

  it('is a no-op for a non-active workspace pane without the workspaceId parameter', () => {
    // Documents WHY callers must thread workspaceId: the pane lookup runs
    // inside one workspace tree, so a background-workspace pane silently
    // no-ops instead of closing (the browser.close asymmetry).
    const { state, slice } = createHarness();
    const other = createWorkspace('Other');
    state.workspaces.push(other);
    slice.addBrowserSurface(other.rootPane.id, 'https://x.example', undefined, other.id);
    const pane = other.rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');

    slice.closeSurface(pane.id, pane.surfaces[0].id);

    expect(pane.surfaces).toHaveLength(1);
  });
});

describe('surfaceSlice browser partition state', () => {
  it('stores the provided partition on new browser surfaces', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;

    slice.addBrowserSurface(paneId, 'https://example.com', 'persist:wmux-login');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].browserPartition).toBe('persist:wmux-login');
  });

  it('updates browser partitions across surfaces when a new profile is applied', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;

    slice.addBrowserSurface(paneId, 'https://one.example', 'persist:wmux-default');
    slice.addBrowserSurface(paneId, 'https://two.example', 'persist:wmux-default');
    slice.updateBrowserPartition('persist:wmux-login');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces.every((surface) => surface.browserPartition === 'persist:wmux-login')).toBe(true);
  });
});

describe('surfaceSlice.closeSurface — surfaceAgent cleanup (Part A leak-prevention)', () => {
  it('clears the surfaceAgent entry for the closed surface ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces.find((s) => s.ptyId === 'pty-1')!.id;
    state.surfaceAgent['pty-1'] = { name: 'Claude Code', status: 'running' };

    slice.closeSurface(paneId, surfaceId);

    expect(state.surfaceAgent['pty-1']).toBeUndefined();
  });
});

describe('surfaceSlice.closeSurface — surfaceActivity cleanup (Fleet activity teardown)', () => {
  it('clears the surfaceActivity entry for the closed surface ptyId (the OTHER real teardown site)', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces.find((s) => s.ptyId === 'pty-1')!.id;
    state.surfaceActivity['pty-1'] = '✎ fleet.ts';

    slice.closeSurface(paneId, surfaceId);

    expect(state.surfaceActivity['pty-1']).toBeUndefined();
  });

  it('leaves activity for other surfaces untouched when one closes', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    slice.addSurface(paneId, 'pty-2', 'pwsh', 'C:\\b');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId1 = pane.surfaces.find((s) => s.ptyId === 'pty-1')!.id;
    state.surfaceActivity['pty-1'] = '$ build';
    state.surfaceActivity['pty-2'] = '✎ keep.ts';

    slice.closeSurface(paneId, surfaceId1);

    expect(state.surfaceActivity['pty-1']).toBeUndefined();
    expect(state.surfaceActivity['pty-2']).toBe('✎ keep.ts');
  });
});

describe('surfaceSlice.addUtilitySurface — 시안 A Git·Review 중앙 surface', () => {
  it('신규 git surface를 생성하고 인자 cwd를 surface.cwd에 캡처한다', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;

    slice.addUtilitySurface('git', paneId, '/repo/base');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(1);
    expect(pane.surfaces[0].surfaceType).toBe('git');
    expect(pane.surfaces[0].cwd).toBe('/repo/base');
    expect(pane.surfaces[0].ptyId).toBe('');
    expect(pane.activeSurfaceId).toBe(pane.surfaces[0].id);
  });

  it('같은 kind가 이미 열려 있으면 중복 생성하지 않고 그 탭으로 전환(같은 페인)', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;

    slice.addUtilitySurface('review', paneId);
    slice.addUtilitySurface('review', paneId);

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces.filter((s) => s.surfaceType === 'review')).toHaveLength(1);
  });

  it('워크스페이스 전체 leaf를 순회해 dedupe — 다른 페인에 열려 있으면 그 페인+서피스로 전환', () => {
    const { state, slice } = createHarness();
    const ws = state.workspaces[0];
    // rootPane을 두 leaf를 가진 branch로 재구성한다.
    const leftLeaf: PaneLeaf = { id: 'pane-left', type: 'leaf', surfaces: [], activeSurfaceId: '' };
    const rightLeaf: PaneLeaf = { id: 'pane-right', type: 'leaf', surfaces: [], activeSurfaceId: '' };
    ws.rootPane = {
      id: 'branch-root',
      type: 'branch',
      direction: 'horizontal',
      children: [leftLeaf, rightLeaf],
    };
    ws.activePaneId = 'pane-right';

    // 먼저 왼쪽 페인에 git을 연다.
    slice.addUtilitySurface('git', 'pane-left', '/repo/a');
    const existingSurfaceId = leftLeaf.surfaces[0].id;

    // 오른쪽 페인에서 다시 git 진입 → 신규 생성 대신 왼쪽 페인+서피스로 전환.
    slice.addUtilitySurface('git', 'pane-right', '/repo/b');

    expect(leftLeaf.surfaces).toHaveLength(1);
    expect(rightLeaf.surfaces).toHaveLength(0);
    expect(ws.activePaneId).toBe('pane-left');
    expect(leftLeaf.activeSurfaceId).toBe(existingSurfaceId);
  });
});
