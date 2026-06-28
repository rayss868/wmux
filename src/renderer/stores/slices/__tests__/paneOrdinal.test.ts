import { describe, it, expect, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createWorkspace, type Pane, type Workspace, type SessionData } from '../../../../shared/types';
import { getLeafPanes } from '../../../../shared/paneUtils';

// Combined pane + workspace store: ordinal stability is a property of the
// interaction between splitPane/closePane (paneSlice) and loadSession/
// duplicateWorkspace (workspaceSlice), so we mount both on one immer store.
type ComboState = WorkspaceSlice & PaneSlice & {
  zoomedPaneId: string | null;
  pushToast: ReturnType<typeof vi.fn>;
  multiviewIds: string[];
  sidebarVisible: boolean;
};

function createComboStore(workspaces?: Workspace[], activeId?: string, nextWorkspaceOrdinal = 2) {
  const seed = workspaces ?? [createWorkspace('Test', 1)];
  return create<ComboState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
      workspaces: seed,
      activeWorkspaceId: activeId ?? seed[0].id,
      nextWorkspaceOrdinal,
      zoomedPaneId: null,
      pushToast: vi.fn(),
      multiviewIds: [],
      sidebarVisible: false,
    })),
  );
}

function ordinalsOf(ws: Workspace): number[] {
  return getLeafPanes(ws.rootPane)
    .map((l) => l.ordinal ?? -1)
    .sort((a, b) => a - b);
}

describe('pane ordinal allocation', () => {
  it('createWorkspace seeds the root leaf at ordinal 1 with nextPaneOrdinal 2', () => {
    const store = createComboStore();
    const ws = store.getState().workspaces[0];
    expect(ordinalsOf(ws)).toEqual([1]);
    expect(ws.nextPaneOrdinal).toBe(2);
    expect(ws.wsOrdinal).toBe(1);
  });

  it('splitPane assigns the next per-workspace ordinal and advances the counter', () => {
    const store = createComboStore();
    const rootId = store.getState().workspaces[0].rootPane.id;

    store.getState().splitPane(rootId, 'horizontal');

    const ws = store.getState().workspaces[0];
    expect(ordinalsOf(ws)).toEqual([1, 2]);
    expect(ws.nextPaneOrdinal).toBe(3);
  });

  it('★critical: does NOT recycle a closed pane ordinal on the next split', () => {
    const store = createComboStore();
    const rootId = store.getState().workspaces[0].rootPane.id;

    // split → new pane gets ordinal 2
    store.getState().splitPane(rootId, 'horizontal');
    let ws = store.getState().workspaces[0];
    const newLeaf = getLeafPanes(ws.rootPane).find((l) => l.ordinal === 2)!;
    expect(newLeaf).toBeTruthy();

    // close the new pane → ordinal 2 is "freed", but the high-water stays at 3
    store.getState().closePane(newLeaf.id);
    ws = store.getState().workspaces[0];
    expect(ordinalsOf(ws)).toEqual([1]);
    expect(ws.nextPaneOrdinal).toBe(3);

    // split again → must allocate 3, NEVER reuse 2 (auto names stay stable)
    store.getState().splitPane(ws.rootPane.id, 'horizontal');
    ws = store.getState().workspaces[0];
    expect(ordinalsOf(ws)).toEqual([1, 3]);
    expect(ws.nextPaneOrdinal).toBe(4);
  });

  it('preserves ordinals + counter across a session round-trip (loadSession)', () => {
    const store = createComboStore();
    const rootId = store.getState().workspaces[0].rootPane.id;
    store.getState().splitPane(rootId, 'horizontal'); // 1, 2
    const second = getLeafPanes(store.getState().workspaces[0].rootPane).find((l) => l.ordinal === 2)!;
    store.getState().splitPane(second.id, 'vertical'); // 1, 2, 3
    const saved = store.getState().workspaces[0];
    expect(ordinalsOf(saved)).toEqual([1, 2, 3]);
    expect(saved.nextPaneOrdinal).toBe(4);

    // Persist as plain JSON-equivalent data, then load into a fresh store.
    const sessionData: SessionData = {
      workspaces: structuredClone(store.getState().workspaces),
      activeWorkspaceId: store.getState().activeWorkspaceId,
      sidebarVisible: false,
      nextWorkspaceOrdinal: store.getState().nextWorkspaceOrdinal,
    };
    const fresh = createComboStore();
    fresh.getState().loadSession(sessionData);
    const restored = fresh.getState().workspaces[0];
    expect(ordinalsOf(restored)).toEqual([1, 2, 3]);
    expect(restored.nextPaneOrdinal).toBe(4);
    expect(restored.wsOrdinal).toBe(saved.wsOrdinal);
  });

  it('backfills missing ordinals from a pre-P2 session (checklist F)', () => {
    const ws = createWorkspace('Old', 1);
    // Simulate a pre-P2 session: no ordinal fields anywhere.
    delete ws.wsOrdinal;
    delete ws.nextPaneOrdinal;
    const strip = (p: Pane): void => {
      if (p.type === 'leaf') delete p.ordinal;
      else p.children.forEach(strip);
    };
    strip(ws.rootPane);

    const fresh = createComboStore();
    fresh.getState().loadSession({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: false,
    });
    const loaded = fresh.getState().workspaces[0];
    expect(ordinalsOf(loaded)).toEqual([1]);
    expect(loaded.wsOrdinal).toBe(1);
    expect(loaded.nextPaneOrdinal).toBe(2);
    expect(fresh.getState().nextWorkspaceOrdinal).toBe(2);
  });

  it('numbers a duplicated workspace fresh 1..n, not the source ordinals', () => {
    const store = createComboStore();
    const rootId = store.getState().workspaces[0].rootPane.id;
    // Make the source non-contiguous: split (→2), close 2, split (→3) ⇒ [1, 3].
    store.getState().splitPane(rootId, 'horizontal');
    let ws = store.getState().workspaces[0];
    const leaf2 = getLeafPanes(ws.rootPane).find((l) => l.ordinal === 2)!;
    store.getState().closePane(leaf2.id);
    ws = store.getState().workspaces[0];
    store.getState().splitPane(ws.rootPane.id, 'horizontal');
    ws = store.getState().workspaces[0];
    expect(ordinalsOf(ws)).toEqual([1, 3]);

    store.getState().duplicateWorkspace(ws.id);
    const clone = store.getState().workspaces[1];
    // Fresh DFS renumber → contiguous 1..n, independent of the source's [1, 3].
    expect(ordinalsOf(clone)).toEqual([1, 2]);
    expect(clone.nextPaneOrdinal).toBe(3);
    expect(clone.wsOrdinal).toBe(2); // from the global counter (source was 1)
  });
});
