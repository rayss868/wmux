// ─── R2 lifecycle cleanup hooks tests ───────────────────────────────
// Verifies that pane close (closePane) and workspace delete (removeWorkspace)
// fire the channel-membership purge + principal cleanup with the correct
// coordinates. The daemon-call thunks (purgeMembershipDaemon etc.) belong to the
// channels slice, so they are stubbed here — "when, and with which arguments, it
// is called" is this test's contract.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import { panePrincipalId } from '../../../../shared/principals';

vi.mock('../../../events/publisher', () => ({
  publishPaneCreated: () => {},
  publishPaneClosed: () => {},
  publishPaneFocused: () => {},
  publishWorkspaceMetadataChanged: () => {},
  publishA2aTask: () => {},
}));

const purgeCalls: unknown[][] = [];
const removeCalls: unknown[][] = [];
const staleCalls: unknown[][] = [];

const cleanupStubs = {
  purgeMembershipDaemon: async (...args: unknown[]) => { purgeCalls.push(args); },
  principalRemoveDaemon: async (...args: unknown[]) => { removeCalls.push(args); },
  principalMarkStaleWorkspaceDaemon: async (...args: unknown[]) => { staleCalls.push(args); },
};

type TestState = PaneSlice & WorkspaceSlice & typeof cleanupStubs;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
      ...cleanupStubs,
    }))
  );
}

describe('R2 lifecycle cleanup hooks', () => {
  let store: ReturnType<typeof createTestStore>;
  let wsId: string;

  beforeEach(() => {
    purgeCalls.length = 0;
    removeCalls.length = 0;
    staleCalls.length = 0;
    store = createTestStore();
    wsId = store.getState().workspaces[0].id;
  });

  describe('closePane', () => {
    it('closing a live agent pane fires purge + remove with that pane\'s principal coordinate', () => {
      const rootId = store.getState().workspaces[0].rootPane.id;
      store.getState().splitPane(rootId, 'horizontal');
      // After the split, make the second of the two leaves an agent pane.
      const ws = store.getState().workspaces[0];
      const root = ws.rootPane;
      if (root.type !== 'branch') throw new Error('split failed');
      const target = root.children[1];
      if (target.type !== 'leaf') throw new Error('unexpected tree');
      const targetId = target.id;
      store.setState((s) => {
        const w = s.workspaces[0];
        if (w.rootPane.type !== 'branch') return;
        const leaf = w.rootPane.children.find((c) => c.id === targetId);
        if (leaf?.type === 'leaf') {
          // A new pane has no surface yet (before PTY spawn) — inject an agent surface.
          leaf.surfaces.push({
            id: 'sf-agent-1',
            surfaceType: 'terminal',
            ptyId: 'pty-agent-1',
          } as unknown as (typeof leaf.surfaces)[number]);
        }
        s.surfaceAgent['pty-agent-1'] = { name: 'Claude Code', status: 'running', slug: 'claude' };
      });

      store.getState().closePane(targetId, wsId);

      const expected = panePrincipalId(wsId, targetId);
      // purge twice: principal-coordinate match + legacy-row auxiliary (autoName memberId) match.
      expect(purgeCalls).toHaveLength(2);
      expect(purgeCalls[0]).toEqual([{ workspaceId: wsId, principalId: expected }]);
      const aux = purgeCalls[1][0] as { workspaceId: string; memberId?: string };
      expect(aux.workspaceId).toBe(wsId);
      expect(aux.memberId).toMatch(/^w\d+-\d+\(claude\)$/); // autoName format
      expect(removeCalls).toEqual([[expected]]);
    });

    it('closing a pane with no agent does not fire a purge', () => {
      const rootId = store.getState().workspaces[0].rootPane.id;
      store.getState().splitPane(rootId, 'horizontal');
      const root = store.getState().workspaces[0].rootPane;
      if (root.type !== 'branch') throw new Error('split failed');

      store.getState().closePane(root.children[1].id, wsId);

      expect(purgeCalls).toHaveLength(0);
      expect(removeCalls).toHaveLength(0);
    });
  });

  describe('removeWorkspace', () => {
    it('deleting a workspace fires a whole-ws purge + principal stale', () => {
      store.setState((s) => {
        s.workspaces.push(createWorkspace('Second') as Workspace);
      });
      const secondId = store.getState().workspaces[1].id;

      store.getState().removeWorkspace(secondId);

      expect(purgeCalls).toEqual([[{ workspaceId: secondId }]]);
      expect(staleCalls).toEqual([[secondId]]);
    });

    it('the last workspace is not deleted, so no purge is fired either', () => {
      store.getState().removeWorkspace(wsId);
      expect(purgeCalls).toHaveLength(0);
      expect(staleCalls).toHaveLength(0);
    });
  });
});
