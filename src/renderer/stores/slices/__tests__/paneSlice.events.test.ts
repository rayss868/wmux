import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';

// Capture publisher calls — paneSlice imports from this module.
const publishCalls: Array<{ fn: string; args: unknown[] }> = [];
vi.mock('../../../events/publisher', () => ({
  publishPaneCreated: (...args: unknown[]) => { publishCalls.push({ fn: 'pane.created', args }); },
  publishPaneClosed: (...args: unknown[]) => { publishCalls.push({ fn: 'pane.closed', args }); },
  publishPaneFocused: (...args: unknown[]) => { publishCalls.push({ fn: 'pane.focused', args }); },
  publishPaneMetadataChanged: (...args: unknown[]) => { publishCalls.push({ fn: 'pane.metadata.changed', args }); },
}));

type TestState = PaneSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
};

function createTestStore() {
  const ws = createWorkspace('Test');
  return create<TestState>()(
    immer((...args) => ({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
    }))
  );
}

describe('paneSlice — event publication', () => {
  let store: ReturnType<typeof createTestStore>;
  let wsId: string;
  let rootPaneId: string;

  beforeEach(() => {
    publishCalls.length = 0;
    store = createTestStore();
    const ws = store.getState().workspaces[0];
    wsId = ws.id;
    rootPaneId = ws.rootPane.id;
  });

  describe('splitPane', () => {
    it('publishes pane.created for the new sibling', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const created = publishCalls.find((c) => c.fn === 'pane.created');
      expect(created).toBeDefined();
      expect(created?.args[0]).toBe(wsId);
      // args: (wsId, newPaneId, branchId)
      expect(typeof created?.args[1]).toBe('string');
      expect(typeof created?.args[2]).toBe('string');
    });

    it('publishes pane.focused when active pane changes', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const focused = publishCalls.find((c) => c.fn === 'pane.focused');
      expect(focused).toBeDefined();
      // (wsId, newActiveId, previousActiveId)
      expect(focused?.args[0]).toBe(wsId);
      expect(focused?.args[2]).toBe(rootPaneId);
    });
  });

  describe('closePane', () => {
    it('publishes pane.closed for the dropped leaf', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const newPaneId = store.getState().workspaces[0].activePaneId;
      publishCalls.length = 0; // reset so we only see closePane events

      store.getState().closePane(newPaneId);
      const closed = publishCalls.find((c) => c.fn === 'pane.closed');
      expect(closed).toBeDefined();
      expect(closed?.args).toEqual([wsId, newPaneId]);
    });

    it('publishes pane.focused when active changes after close', () => {
      store.getState().splitPane(rootPaneId, 'horizontal');
      const newPaneId = store.getState().workspaces[0].activePaneId;
      publishCalls.length = 0;

      store.getState().closePane(newPaneId);
      const focused = publishCalls.find((c) => c.fn === 'pane.focused');
      expect(focused).toBeDefined();
    });
  });

  describe('setActivePane', () => {
    it('publishes pane.focused only when paneId actually changes', () => {
      // Split so we have two leaves to swap between.
      store.getState().splitPane(rootPaneId, 'horizontal');
      const newPaneId = store.getState().workspaces[0].activePaneId;
      publishCalls.length = 0;

      // No-op: setting the already-active pane.
      store.getState().setActivePane(newPaneId);
      expect(publishCalls.filter((c) => c.fn === 'pane.focused')).toHaveLength(0);

      // Real change.
      store.getState().setActivePane(rootPaneId);
      const focused = publishCalls.find((c) => c.fn === 'pane.focused');
      expect(focused).toBeDefined();
      expect(focused?.args[0]).toBe(wsId);
      expect(focused?.args[1]).toBe(rootPaneId);
      expect(focused?.args[2]).toBe(newPaneId);
    });

    it('does not publish when paneId is unknown', () => {
      store.getState().setActivePane('does-not-exist');
      expect(publishCalls.filter((c) => c.fn === 'pane.focused')).toHaveLength(0);
    });
  });

  describe('setPaneMetadata', () => {
    it('publishes pane.metadata.changed with the merged metadata', () => {
      store.getState().setPaneMetadata(rootPaneId, { label: 'Backend' });
      const event = publishCalls.find((c) => c.fn === 'pane.metadata.changed');
      expect(event).toBeDefined();
      expect(event?.args[0]).toBe(wsId);
      expect(event?.args[1]).toBe(rootPaneId);
      expect((event?.args[2] as { label?: string }).label).toBe('Backend');
    });

    it('does not publish on size-cap rejection', () => {
      const huge = 'x'.repeat(10_000);
      try {
        store.getState().setPaneMetadata(rootPaneId, { custom: { blob: huge } });
      } catch { /* expected */ }
      expect(publishCalls.filter((c) => c.fn === 'pane.metadata.changed')).toHaveLength(0);
    });
  });
});
