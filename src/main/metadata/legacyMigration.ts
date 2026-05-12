// === Legacy PaneLeaf.metadata → MetadataStore migration (M0-f follow-up) ===
//
// v2.8.x persisted pane metadata inline on `PaneLeaf.metadata` inside
// `session.json`. M0-e split metadata out into a dedicated `metadata.json`
// file owned by `MetadataStore`. On the first boot after upgrade,
// `metadata.json` does not exist yet — without this migration:
//
//   - `pane.list` already falls back to the renderer-provided
//     `PaneLeaf.metadata` (M0-c P2 fix), so list views look correct.
//   - `pane.getMetadata` reads MetadataStore directly and would return
//     `{ metadata: {}, version: 0 }`, hiding the user's saved label/role
//     /status/custom from any client that targets a specific pane.
//   - The next merge-mode `pane.setMetadata` would start from that empty
//     base and silently drop every legacy field the user thought was
//     persisted.
//
// This helper walks `SessionData` and produces the `SnapshotEntry[]` shape
// `MetadataStore.hydrate()` consumes. The boot path in `src/main/index.ts`
// calls it ONLY when `sessionManager.loadMetadata()` returns null, then
// hydrates the store and immediately persists — so the second boot reads
// `metadata.json` and never hits this code path again.

import type { Pane, PaneLeaf, PaneMetadata, SessionData } from '../../shared/types';
import type { SnapshotEntry } from './MetadataStore';

/**
 * Walks the SessionData and collects every leaf pane that has non-empty
 * metadata. Used by the v2.8.x → v2.9.0 migration on first boot after
 * upgrade, when `metadata.json` does not yet exist.
 *
 * Version starts at 1 — `MetadataStore` treats 0 as the "never written"
 * sentinel, so we must NOT pretend the migrated entries have version 0
 * or `pane.getMetadata` on a never-touched-post-migration pane would
 * report a stale base for optimistic-concurrency checks. The next write
 * bumps to 2 as expected.
 */
export function collectLegacyMetadata(session: SessionData): SnapshotEntry[] {
  const out: SnapshotEntry[] = [];
  for (const ws of session.workspaces) {
    walkLeaves(ws.rootPane, (leaf) => {
      const meta = leaf.metadata;
      if (!meta || isEmpty(meta)) return;
      out.push({
        paneId: leaf.id,
        workspaceId: ws.id,
        // Defensive clone — `hydrate()` clones again, but we don't want
        // a future mutation on `session.workspaces[].rootPane` to bleed
        // into the snapshot we're staging.
        metadata: {
          ...(meta.label !== undefined && { label: meta.label }),
          ...(meta.role !== undefined && { role: meta.role }),
          ...(meta.status !== undefined && { status: meta.status }),
          ...(meta.updatedAt !== undefined && { updatedAt: meta.updatedAt }),
          ...(meta.custom !== undefined && { custom: { ...meta.custom } }),
        },
        version: 1,
      });
    });
  }
  return out;
}

function walkLeaves(root: Pane, cb: (leaf: PaneLeaf) => void): void {
  if (root.type === 'leaf') {
    cb(root);
    return;
  }
  for (const child of root.children) walkLeaves(child, cb);
}

/**
 * `PaneLeaf.metadata` is optional and tooling sometimes wrote `{}` (or
 * an object with only `updatedAt`) instead of clearing the field. Treat
 * those as "nothing to migrate" so we don't pollute the store with
 * empty entries that `serialize()` would just drop on the next persist.
 */
function isEmpty(m: PaneMetadata): boolean {
  return (
    !m.label &&
    !m.role &&
    !m.status &&
    (!m.custom || Object.keys(m.custom).length === 0)
  );
}
