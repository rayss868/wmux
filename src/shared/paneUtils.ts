import type { Pane, PaneLeaf, PaneBranch } from './types';

/** Find a leaf pane by ID */
export function findLeaf(root: Pane, id: string): PaneLeaf | null {
  if (root.type === 'leaf' && root.id === id) return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findLeaf(child, id);
      if (found) return found;
    }
  }
  return null;
}

/** Find any pane (leaf or branch) by ID */
export function findPane(root: Pane, id: string): Pane | null {
  if (root.id === id) return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findPane(child, id);
      if (found) return found;
    }
  }
  return null;
}

/** Find the parent branch of a pane by ID */
export function findParent(root: Pane, id: string): PaneBranch | null {
  if (root.type === 'branch') {
    for (const child of root.children) {
      if (child.id === id) return root;
      const found = findParent(child, id);
      if (found) return found;
    }
  }
  return null;
}

/** Collect all leaf IDs from a pane tree */
export function collectLeafIds(pane: Pane): string[] {
  if (pane.type === 'leaf') return [pane.id];
  return pane.children.flatMap(collectLeafIds);
}

/** Collect all leaf panes from a pane tree */
export function getLeafPanes(root: Pane): PaneLeaf[] {
  if (root.type === 'leaf') return [root];
  return root.children.flatMap(getLeafPanes);
}
