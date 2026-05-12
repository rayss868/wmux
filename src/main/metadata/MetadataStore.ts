// === wmux MetadataStore (M0-a) ===
//
// Authoritative store for PaneMetadata in the main process. Replaces the
// renderer paneSlice as the metadata source of truth (M0-d removes the
// renderer write path; M0-b re-points the RPC handlers here).
//
// This module is INTENTIONALLY isolated in M0-a — handler wiring, paneSlice
// mirror conversion, and SessionManager persistence integration land in
// later M0 PRs. M0-a ships the store + its unit tests; no call sites change.
//
// Design contract: docs/internal/m0-design.md
// Wire contract:   docs/PROTOCOL.md §1
//
// Concurrency model:
//   - Single-threaded JS = automatic serialization across set() calls
//     (race #5 in the design doc).
//   - The synchronous critical section (validate → check version → merge →
//     bump version → commit → emit) holds across one `set()` invocation,
//     so two concurrent callers observe a monotonic version sequence
//     without locking.
//   - Persistence is handled in M0-e via SessionManager.hydrate/serialize.
//     M0-a exposes the API (`hydrate`, `serialize`, `migrate`) but does
//     not yet wire it into the dump path.

import type { PaneMetadata } from '../../shared/types';
import {
  PANE_METADATA_MAX_BYTES,
  PANE_METADATA_LABEL_MAX,
  PANE_METADATA_ROLE_MAX,
  PANE_METADATA_STATUS_MAX,
  PANE_METADATA_CUSTOM_KEY_MAX,
  PANE_METADATA_CUSTOM_MAX_ENTRIES,
} from '../../shared/types';
import { eventBus as defaultEventBus, EventBus } from '../events/EventBus';

// === Public types ===

export type MergeMode = 'merge' | 'replace' | 'replaceShared';

export interface SetOptions {
  mergeMode?: MergeMode;
  expectedVersion?: number;
  /**
   * Workspace this write is scoped to. Used as the `workspaceId` on the
   * emitted `pane.metadata.changed` event. If omitted, falls back to the
   * workspaceId remembered from a prior set() on this pane. If neither
   * is known, the event is skipped (the store still commits — this only
   * matters for the event surface).
   */
  workspaceId?: string;
}

export type SetResult =
  | { ok: true; version: number; metadata: PaneMetadata }
  | { ok: false; error: 'VERSION_CONFLICT'; currentVersion: number };

export interface MetadataEntry {
  metadata: PaneMetadata;
  version: number;
}

export interface SnapshotEntry {
  paneId: string;
  workspaceId: string;
  metadata: PaneMetadata;
  version: number;
}

export interface Snapshot {
  asOfSeq: number;
  bootId: string;
  entries: SnapshotEntry[];
}

export const METADATA_SCHEMA_VERSION = 1 as const;

export interface PersistedShape {
  schema_version: typeof METADATA_SCHEMA_VERSION;
  entries: SnapshotEntry[];
}

// === Internal ===

interface InternalEntry {
  metadata: PaneMetadata;
  version: number;
  /** Remembered for event emission on subsequent set/clear/onPaneDeleted. */
  workspaceId: string;
}

function cloneMetadata(meta: PaneMetadata): PaneMetadata {
  const out: PaneMetadata = {};
  if (meta.label !== undefined) out.label = meta.label;
  if (meta.role !== undefined) out.role = meta.role;
  if (meta.status !== undefined) out.status = meta.status;
  if (meta.custom !== undefined) out.custom = { ...meta.custom };
  if (meta.updatedAt !== undefined) out.updatedAt = meta.updatedAt;
  return out;
}

function isEmptyMetadata(meta: PaneMetadata): boolean {
  return (
    meta.label === undefined &&
    meta.role === undefined &&
    meta.status === undefined &&
    (meta.custom === undefined || Object.keys(meta.custom).length === 0)
  );
}

// === Store ===

export class MetadataStore {
  private readonly bus: EventBus;
  private readonly map = new Map<string, InternalEntry>();

  constructor(opts?: { eventBus?: EventBus }) {
    this.bus = opts?.eventBus ?? defaultEventBus;
  }

  /**
   * Reads the latest committed metadata + version for a pane.
   * Returns `{ metadata: {}, version: 0 }` when no metadata has ever been
   * set on this paneId — `version: 0` is the "never written" sentinel.
   */
  get(paneId: string): MetadataEntry {
    const entry = this.map.get(paneId);
    if (!entry) return { metadata: {}, version: 0 };
    return { metadata: cloneMetadata(entry.metadata), version: entry.version };
  }

  /**
   * Single synchronous critical section.
   *
   *   1. validate(patch)         → throws on invalid input (no version bump)
   *   2. concurrency check       → returns VERSION_CONFLICT on mismatch
   *   3. compute merged shape    → mergeMode semantics
   *   4. enforce MAX_BYTES       → throws if post-merge exceeds cap
   *   5. bump version            → currentVersion + 1
   *   6. commit in-memory        → map.set(paneId, ...)
   *   7. emit event              → EventBus.emit('pane.metadata.changed')
   *
   * Persistence (step 6.5 in the design doc — persist-then-publish) lands
   * in M0-b/e. M0-a sequences commit → emit synchronously.
   */
  set(
    paneId: string,
    patch: Partial<PaneMetadata>,
    opts: SetOptions = {},
  ): SetResult {
    const sanitized = this.sanitize(patch);
    const mode: MergeMode = opts.mergeMode ?? 'merge';

    const existing = this.map.get(paneId);
    const currentVersion = existing?.version ?? 0;

    if (opts.expectedVersion !== undefined && opts.expectedVersion !== currentVersion) {
      return { ok: false, error: 'VERSION_CONFLICT', currentVersion };
    }

    const merged = this.merge(existing?.metadata ?? {}, sanitized, mode);
    if (JSON.stringify(merged).length > PANE_METADATA_MAX_BYTES) {
      throw new Error(`metadata exceeds ${PANE_METADATA_MAX_BYTES} bytes`);
    }

    merged.updatedAt = Date.now();
    const newVersion = currentVersion + 1;
    const workspaceId = opts.workspaceId ?? existing?.workspaceId ?? '';

    this.map.set(paneId, {
      metadata: merged,
      version: newVersion,
      workspaceId,
    });

    if (workspaceId) {
      this.bus.emit({
        type: 'pane.metadata.changed',
        workspaceId,
        paneId,
        metadata: cloneMetadata(merged),
        version: newVersion,
      });
    }

    return {
      ok: true,
      version: newVersion,
      metadata: cloneMetadata(merged),
    };
  }

  /**
   * Drops all metadata for a pane while keeping the version counter
   * monotonic. Always succeeds (no concurrency check — clear is idempotent).
   * Emits `pane.metadata.changed` with empty metadata + bumped version.
   *
   * If the pane has no prior entry, returns version 0 without bumping
   * (no event emitted — there was nothing to clear).
   */
  clear(paneId: string): SetResult {
    const existing = this.map.get(paneId);
    if (!existing) {
      return { ok: true, version: 0, metadata: {} };
    }

    const newVersion = existing.version + 1;
    const workspaceId = existing.workspaceId;
    const cleared: PaneMetadata = {};

    this.map.set(paneId, {
      metadata: cleared,
      version: newVersion,
      workspaceId,
    });

    if (workspaceId) {
      this.bus.emit({
        type: 'pane.metadata.changed',
        workspaceId,
        paneId,
        metadata: {},
        version: newVersion,
      });
    }

    return { ok: true, version: newVersion, metadata: {} };
  }

  /**
   * Atomic snapshot of the store + the EventBus seq watermark.
   * Used by `pane.list` (M0-c) so external clients can reconcile their
   * cached state against a known consistent point.
   *
   * Single-threaded JS guarantees that `latestSeq()` and the map iteration
   * happen in the same task — no concurrent emit() can land between them.
   */
  snapshot(): Snapshot {
    const entries: SnapshotEntry[] = [];
    for (const [paneId, entry] of this.map.entries()) {
      entries.push({
        paneId,
        workspaceId: entry.workspaceId,
        metadata: cloneMetadata(entry.metadata),
        version: entry.version,
      });
    }
    return {
      asOfSeq: this.bus.latestSeq(),
      bootId: this.bus.bootId,
      entries,
    };
  }

  /**
   * Replaces the in-memory store with the given persisted shape. Called by
   * SessionManager on app boot (M0-e). Drops any in-memory entries first.
   * Unknown schema versions throw — callers can catch and fall back to a
   * clean store.
   *
   * No events are emitted by hydrate(); subscribers learn about state via
   * the next pane.list call after boot.
   */
  hydrate(serialized: PersistedShape): void {
    const migrated = this.migrate(serialized, METADATA_SCHEMA_VERSION);
    this.map.clear();
    for (const entry of migrated.entries) {
      this.map.set(entry.paneId, {
        metadata: cloneMetadata(entry.metadata),
        version: entry.version,
        workspaceId: entry.workspaceId,
      });
    }
  }

  /**
   * Returns the persistable shape of the store. Cleared entries (metadata
   * with no fields set) are dropped to keep session.json compact —
   * race #4 (paneId recycle) is in-process only; once a session is dumped
   * and re-hydrated, a recycled paneId starts at version 0 again.
   * In practice this never triggers because wmux paneIds are random UUIDs.
   */
  serialize(): PersistedShape {
    const entries: SnapshotEntry[] = [];
    for (const [paneId, entry] of this.map.entries()) {
      if (isEmptyMetadata(entry.metadata)) continue;
      entries.push({
        paneId,
        workspaceId: entry.workspaceId,
        metadata: cloneMetadata(entry.metadata),
        version: entry.version,
      });
    }
    return {
      schema_version: METADATA_SCHEMA_VERSION,
      entries,
    };
  }

  /**
   * Migrates a persisted shape to a target schema version. Phase 1 ships
   * at schema 1 so this is currently identity-or-throw. Migration table
   * grows in v3.1+ as schema evolves.
   */
  migrate(input: PersistedShape, to: typeof METADATA_SCHEMA_VERSION): PersistedShape {
    if (input.schema_version === to) return input;
    throw new Error(`unsupported metadata schema_version: ${String(input.schema_version)}`);
  }

  /**
   * Called when a pane is destroyed (M0-e adds the IPC for the renderer
   * to signal this). Clears the metadata but keeps the entry slot so the
   * version counter remains monotonic — protects race #4 in case the same
   * paneId is ever recycled within one daemon run.
   *
   * Emits a final `pane.metadata.changed` event with empty metadata + the
   * bumped version so subscribers can drop their mirror entry cleanly.
   */
  onPaneDeleted(paneId: string): void {
    const existing = this.map.get(paneId);
    if (!existing) return;

    const newVersion = existing.version + 1;
    const workspaceId = existing.workspaceId;

    this.map.set(paneId, {
      metadata: {},
      version: newVersion,
      workspaceId,
    });

    if (workspaceId) {
      this.bus.emit({
        type: 'pane.metadata.changed',
        workspaceId,
        paneId,
        metadata: {},
        version: newVersion,
      });
    }
  }

  /** Test-only: drops all state. Not exposed via RPC or MCP. */
  reset(): void {
    this.map.clear();
  }

  // === Internals ===

  private sanitize(input: Partial<PaneMetadata>): Partial<PaneMetadata> {
    const out: Partial<PaneMetadata> = {};
    if (input.label !== undefined) {
      if (typeof input.label !== 'string') throw new Error('"label" must be a string');
      if (input.label.length > PANE_METADATA_LABEL_MAX) {
        throw new Error(`"label" exceeds ${PANE_METADATA_LABEL_MAX} chars`);
      }
      out.label = input.label;
    }
    if (input.role !== undefined) {
      if (typeof input.role !== 'string') throw new Error('"role" must be a string');
      if (input.role.length > PANE_METADATA_ROLE_MAX) {
        throw new Error(`"role" exceeds ${PANE_METADATA_ROLE_MAX} chars`);
      }
      out.role = input.role;
    }
    if (input.status !== undefined) {
      if (typeof input.status !== 'string') throw new Error('"status" must be a string');
      if (input.status.length > PANE_METADATA_STATUS_MAX) {
        throw new Error(`"status" exceeds ${PANE_METADATA_STATUS_MAX} chars`);
      }
      out.status = input.status;
    }
    if (input.custom !== undefined) {
      if (
        typeof input.custom !== 'object' ||
        input.custom === null ||
        Array.isArray(input.custom)
      ) {
        throw new Error('"custom" must be an object of string→string');
      }
      const entries = Object.entries(input.custom);
      if (entries.length > PANE_METADATA_CUSTOM_MAX_ENTRIES) {
        throw new Error(`"custom" exceeds ${PANE_METADATA_CUSTOM_MAX_ENTRIES} entries`);
      }
      const custom: Record<string, string> = {};
      for (const [k, v] of entries) {
        if (k.length === 0) throw new Error('"custom" key cannot be empty');
        if (k.length > PANE_METADATA_CUSTOM_KEY_MAX) {
          throw new Error(`"custom" key exceeds ${PANE_METADATA_CUSTOM_KEY_MAX} chars`);
        }
        if (typeof v !== 'string') throw new Error(`"custom.${k}" must be a string`);
        custom[k] = v;
      }
      out.custom = custom;
    }
    return out;
  }

  private merge(
    base: PaneMetadata,
    patch: Partial<PaneMetadata>,
    mode: MergeMode,
  ): PaneMetadata {
    if (mode === 'replace') {
      // Full overwrite: only patch fields survive.
      const result: PaneMetadata = {};
      if (patch.label !== undefined) result.label = patch.label;
      if (patch.role !== undefined) result.role = patch.role;
      if (patch.status !== undefined) result.status = patch.status;
      if (patch.custom !== undefined) result.custom = { ...patch.custom };
      return result;
    }

    if (mode === 'replaceShared') {
      // Replace top-level shared fields wholesale; preserve custom from base
      // unless patch explicitly provides one.
      const result: PaneMetadata = {};
      if (base.custom !== undefined) result.custom = { ...base.custom };
      if (patch.label !== undefined) result.label = patch.label;
      if (patch.role !== undefined) result.role = patch.role;
      if (patch.status !== undefined) result.status = patch.status;
      if (patch.custom !== undefined) result.custom = { ...patch.custom };
      return result;
    }

    // 'merge' — patch-style with one-level deep-merge on custom.
    const result: PaneMetadata = {
      ...(base.label !== undefined && { label: base.label }),
      ...(base.role !== undefined && { role: base.role }),
      ...(base.status !== undefined && { status: base.status }),
    };
    if (base.custom !== undefined) result.custom = { ...base.custom };

    if (patch.label !== undefined) result.label = patch.label;
    if (patch.role !== undefined) result.role = patch.role;
    if (patch.status !== undefined) result.status = patch.status;
    if (patch.custom !== undefined) {
      result.custom = { ...(result.custom ?? {}), ...patch.custom };
    }
    return result;
  }
}

// Module-level singleton — main process only.
export const metadataStore = new MetadataStore();
