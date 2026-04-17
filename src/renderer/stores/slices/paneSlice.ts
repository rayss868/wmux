import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Pane, PaneLeaf, PaneBranch, Workspace } from '../../../shared/types';
import { createLeafPane, generateId } from '../../../shared/types';

export interface PaneSlice {
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical', workspaceId?: string) => void;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  focusPaneDirection: (direction: 'up' | 'down' | 'left' | 'right') => void;
}

function findPane(root: Pane, id: string): Pane | null {
  if (root.id === id) return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findPane(child, id);
      if (found) return found;
    }
  }
  return null;
}

function findParent(root: Pane, id: string): PaneBranch | null {
  if (root.type === 'branch') {
    for (const child of root.children) {
      if (child.id === id) return root;
      const found = findParent(child, id);
      if (found) return found;
    }
  }
  return null;
}

function collectLeafIds(pane: Pane): string[] {
  if (pane.type === 'leaf') return [pane.id];
  return pane.children.flatMap(collectLeafIds);
}

function getLeafPanes(root: Pane): PaneLeaf[] {
  if (root.type === 'leaf') return [root];
  return root.children.flatMap(getLeafPanes);
}

export const createPaneSlice: StateCreator<StoreState, [['zustand/immer', never]], [], PaneSlice> = (set, get) => ({
  splitPane: (paneId, direction, workspaceId) => set((state: StoreState) => {
    const targetWsId = workspaceId || state.activeWorkspaceId;
    const ws = state.workspaces.find((w: Workspace) => w.id === targetWsId);
    if (!ws) return;

    const targetPane = findPane(ws.rootPane, paneId);
    if (!targetPane || targetPane.type !== 'leaf') return;

    const newPane = createLeafPane();
    const branch: PaneBranch = {
      id: generateId('pane'),
      type: 'branch',
      direction,
      children: [{ ...targetPane }, newPane],
      sizes: [50, 50],
    };

    // Replace target with branch
    const parent = findParent(ws.rootPane, paneId);
    if (parent) {
      const idx = parent.children.findIndex((c) => c.id === paneId);
      if (idx !== -1) {
        parent.children[idx] = branch;
      }
    } else {
      // Target is the root
      ws.rootPane = branch;
    }

    ws.activePaneId = newPane.id;
  }),

  closePane: (paneId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;

    const parent = findParent(ws.rootPane, paneId);
    if (!parent) {
      // Can't close root pane, but can clear its surfaces
      return;
    }

    const idx = parent.children.findIndex((c) => c.id === paneId);
    if (idx === -1) return;

    parent.children.splice(idx, 1);

    if (parent.children.length === 1) {
      // Collapse: replace parent with the remaining child
      const remaining = parent.children[0];
      const grandParent = findParent(ws.rootPane, parent.id);
      if (grandParent) {
        const parentIdx = grandParent.children.findIndex((c) => c.id === parent.id);
        if (parentIdx !== -1) {
          grandParent.children[parentIdx] = remaining;
        }
      } else {
        // Parent was root
        ws.rootPane = remaining;
      }
    }

    // Update active pane
    const leaves = getLeafPanes(ws.rootPane);
    if (leaves.length > 0 && !leaves.some((l) => l.id === ws.activePaneId)) {
      ws.activePaneId = leaves[0].id;
    }
  }),

  setActivePane: (paneId) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    if (findPane(ws.rootPane, paneId)) {
      ws.activePaneId = paneId;
    }
  }),

  focusPaneDirection: (direction) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;

    const leaves = getLeafPanes(ws.rootPane);
    if (leaves.length <= 1) return;

    // Helper: get first leaf in a subtree (leftmost/topmost)
    const firstLeaf = (pane: Pane): PaneLeaf => {
      if (pane.type === 'leaf') return pane;
      return firstLeaf(pane.children[0]);
    };

    // Helper: get last leaf in a subtree (rightmost/bottommost)
    const lastLeaf = (pane: Pane): PaneLeaf => {
      if (pane.type === 'leaf') return pane;
      return lastLeaf(pane.children[pane.children.length - 1]);
    };

    // Tree-based spatial navigation
    const navigate = (paneId: string, dir: 'up' | 'down' | 'left' | 'right'): string | null => {
      const parent = findParent(ws.rootPane, paneId);
      if (!parent) return null; // at root

      const idx = parent.children.findIndex(c => c.id === paneId);
      const isAligned =
        (parent.direction === 'horizontal' && (dir === 'left' || dir === 'right')) ||
        (parent.direction === 'vertical' && (dir === 'up' || dir === 'down'));

      if (isAligned) {
        const delta = (dir === 'right' || dir === 'down') ? 1 : -1;
        const nextIdx = idx + delta;
        if (nextIdx >= 0 && nextIdx < parent.children.length) {
          // Move to adjacent sibling — descend to nearest leaf
          const sibling = parent.children[nextIdx];
          const leaf = delta > 0 ? firstLeaf(sibling) : lastLeaf(sibling);
          return leaf.id;
        }
      }

      // Direction not aligned or no sibling in that direction — go up
      return navigate(parent.id, dir);
    };

    const targetId = navigate(ws.activePaneId, direction);
    if (targetId) {
      ws.activePaneId = targetId;
    }
  }),
});
