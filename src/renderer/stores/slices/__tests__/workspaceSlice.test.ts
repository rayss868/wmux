import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';

// Minimal store satisfying WorkspaceSlice + the pieces of UISlice the
// setActiveWorkspace logic touches (multiviewIds). We don't pull in the
// real UISlice to keep the test isolated to setActiveWorkspace behavior.
type TestState = WorkspaceSlice & {
  multiviewIds: string[];
};

function createTestStore(initialWorkspaces: Workspace[], activeId: string, multiviewIds: string[] = []) {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // Override the slice's defaults AFTER spreading. createWorkspaceSlice
      // initializes workspaces with a fresh "Workspace 1" — we replace those
      // with our test fixtures here.
      workspaces: initialWorkspaces,
      activeWorkspaceId: activeId,
      multiviewIds,
    }))
  );
}

describe('WorkspaceSlice.setActiveWorkspace', () => {
  let wsA: Workspace;
  let wsB: Workspace;
  let wsC: Workspace;

  beforeEach(() => {
    wsA = createWorkspace('A');
    wsB = createWorkspace('B');
    wsC = createWorkspace('C');
  });

  it('switches active workspace when target exists', () => {
    const store = createTestStore([wsA, wsB], wsA.id);
    store.getState().setActiveWorkspace(wsB.id);
    expect(store.getState().activeWorkspaceId).toBe(wsB.id);
  });

  it('ignores unknown workspace ids', () => {
    const store = createTestStore([wsA], wsA.id);
    store.getState().setActiveWorkspace('does-not-exist');
    expect(store.getState().activeWorkspaceId).toBe(wsA.id);
  });

  // Regression: 멀티뷰 상태에서 다른 탭을 눌러도 화면이 안 바뀌던 버그.
  // Cause: AppLayout renders the multiview grid whenever multiviewIds.length
  // >= 2, regardless of activeWorkspaceId. So plain-clicking a non-multiview
  // tab updated activeWorkspaceId silently while the layout kept showing the
  // old grid. Fix: setActiveWorkspace exits multiview when the target isn't
  // part of it.
  it('exits multiview when switching to a workspace not in the multiview set', () => {
    const store = createTestStore(
      [wsA, wsB, wsC],
      wsA.id,
      [wsA.id, wsB.id], // multiview = A + B
    );
    store.getState().setActiveWorkspace(wsC.id); // C is NOT in multiview

    expect(store.getState().activeWorkspaceId).toBe(wsC.id);
    expect(store.getState().multiviewIds).toEqual([]);
  });

  it('keeps multiview intact when switching to a workspace already in it', () => {
    const store = createTestStore(
      [wsA, wsB, wsC],
      wsA.id,
      [wsA.id, wsB.id],
    );
    store.getState().setActiveWorkspace(wsB.id); // B IS in multiview

    expect(store.getState().activeWorkspaceId).toBe(wsB.id);
    expect(store.getState().multiviewIds).toEqual([wsA.id, wsB.id]);
  });

  it('does not touch multiview when fewer than 2 ids are present', () => {
    const store = createTestStore(
      [wsA, wsB],
      wsA.id,
      [], // multiview inactive
    );
    store.getState().setActiveWorkspace(wsB.id);

    expect(store.getState().activeWorkspaceId).toBe(wsB.id);
    expect(store.getState().multiviewIds).toEqual([]);
  });

  it('ignores unknown ids without disturbing multiview', () => {
    const store = createTestStore(
      [wsA, wsB],
      wsA.id,
      [wsA.id, wsB.id],
    );
    store.getState().setActiveWorkspace('ghost');
    expect(store.getState().activeWorkspaceId).toBe(wsA.id);
    expect(store.getState().multiviewIds).toEqual([wsA.id, wsB.id]);
  });
});
