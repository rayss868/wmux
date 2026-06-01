// ─── Pane-tree traversal helpers (pure) ──────────────────────────────────────
// Extracted from useNotificationListener.ts (TODOS "findSurfaceByPtyId /
// findActiveLeaf dedup"). These are pure functions over the Pane tree with no
// React / store dependencies, so they live here and are shared by every
// notification/metadata routing path. Behavior is byte-for-byte identical to
// the previous in-file copies — the listener's regression tests (R1-R4) lock
// the routing semantics, so any change here must preserve them exactly.

import type { Pane, PaneLeaf } from '../../shared/types';

/**
 * Locate the surface that owns a given ptyId anywhere in a pane tree.
 * Returns the owning surface id + the leaf pane id, or null if no surface in
 * the tree is bound to `ptyId`.
 */
export function findSurfaceByPtyId(
  root: Pane,
  ptyId: string,
): { surfaceId: string; paneId: string } | null {
  if (root.type === 'leaf') {
    const surface = root.surfaces.find((s) => s.ptyId === ptyId);
    if (surface) return { surfaceId: surface.id, paneId: root.id };
    return null;
  }
  for (const child of root.children) {
    const found = findSurfaceByPtyId(child, ptyId);
    if (found) return found;
  }
  return null;
}

/**
 * Find the active leaf pane in a tree — the leaf whose id matches
 * `activePaneId`. Returns null when the active pane is not a leaf in this tree
 * (or the tree has no such id).
 */
export function findActiveLeaf(pane: Pane, activePaneId: string): PaneLeaf | null {
  if (pane.type === 'leaf') return pane.id === activePaneId ? pane : null;
  for (const child of pane.children) {
    const found = findActiveLeaf(child, activePaneId);
    if (found) return found;
  }
  return null;
}
