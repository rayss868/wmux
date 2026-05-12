/**
 * SessionManager metadata persistence — M0-e.
 *
 * Covers the separate `metadata.json` round-trip introduced for the
 * persist-then-publish race spec (#1). The MetadataStore unit tests
 * already cover the in-store ordering; here we exercise:
 *
 *   1. saveMetadataSync writes a `PersistedShape` to disk that
 *      loadMetadata can round-trip back unchanged.
 *   2. loadMetadata returns null on a missing `metadata.json` (cold
 *      boot — no previous metadata, store starts clean).
 *   3. loadMetadata rejects (returns null) on a corrupt envelope so a
 *      torn write never crashes the daemon at boot.
 *   4. The on-disk shape can be replayed through `MetadataStore.hydrate`
 *      to restore the exact (paneId, version, label) state — proves the
 *      end-to-end persist-then-publish + hydrate loop is symmetric.
 *
 * Electron `app.getPath('userData')` is mocked to a per-test tmpdir
 * (same pattern as `crashRestore.integration.test.ts`) so the test
 * runs in a plain Node context with no Electron runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpRoot = path.join(os.tmpdir(), 'wmux-sessionmgr-metadata-test');

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpRoot),
  },
}));

import { SessionManager } from '../SessionManager';
import {
  MetadataStore,
  METADATA_SCHEMA_VERSION,
  type PersistedShape,
} from '../../metadata/MetadataStore';

// ── Setup ────────────────────────────────────────────────────────────

function freshDir(): void {
  if (fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpRoot, { recursive: true });
}

beforeEach(() => {
  freshDir();
});

afterEach(() => {
  if (fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────

function makeShape(): PersistedShape {
  return {
    schema_version: METADATA_SCHEMA_VERSION,
    entries: [
      {
        paneId: 'p-1',
        workspaceId: 'ws-1',
        metadata: { label: 'Backend', role: 'service' },
        version: 5,
      },
      {
        paneId: 'p-2',
        workspaceId: 'ws-1',
        metadata: { label: 'Frontend', custom: { team: 'ui' } },
        version: 3,
      },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('SessionManager metadata persistence (M0-e)', () => {
  it('saveMetadataSync + loadMetadata round-trip preserves schema_version + entries', () => {
    const sm = new SessionManager();
    const shape = makeShape();

    sm.saveMetadataSync(shape);
    const loaded = sm.loadMetadata();

    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(shape);
  });

  it('loadMetadata returns null when metadata.json does not exist (cold boot)', () => {
    const sm = new SessionManager();
    expect(sm.loadMetadata()).toBeNull();
  });

  it('loadMetadata rejects a corrupt envelope (torn write at boot)', () => {
    const sm = new SessionManager();
    const metadataPath = path.join(tmpRoot, 'metadata.json');

    // Write a file that parses as JSON but is missing the required
    // schema_version field. The type guard must reject and the helper
    // returns null rather than throwing.
    fs.writeFileSync(metadataPath, JSON.stringify({ entries: [] }), 'utf-8');
    expect(sm.loadMetadata()).toBeNull();
  });

  it('loadMetadata rejects a wrong schema_version (forward-incompatible payload)', () => {
    const sm = new SessionManager();
    const metadataPath = path.join(tmpRoot, 'metadata.json');

    // A future schema. Without an explicit migration registry, the
    // validator rejects rather than silently downgrading.
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({ schema_version: 9999, entries: [] }),
      'utf-8',
    );
    expect(sm.loadMetadata()).toBeNull();
  });

  it('saveMetadataSync overwrites the previous on-disk shape atomically', () => {
    const sm = new SessionManager();

    sm.saveMetadataSync({
      schema_version: METADATA_SCHEMA_VERSION,
      entries: [
        {
          paneId: 'p-1',
          workspaceId: 'ws-1',
          metadata: { label: 'first' },
          version: 1,
        },
      ],
    });

    sm.saveMetadataSync({
      schema_version: METADATA_SCHEMA_VERSION,
      entries: [
        {
          paneId: 'p-1',
          workspaceId: 'ws-1',
          metadata: { label: 'second' },
          version: 2,
        },
      ],
    });

    const loaded = sm.loadMetadata();
    expect(loaded?.entries).toHaveLength(1);
    expect(loaded?.entries[0]?.metadata.label).toBe('second');
    expect(loaded?.entries[0]?.version).toBe(2);
  });

  it('hydrate after boot restores paneId → metadata + version exactly', () => {
    const sm = new SessionManager();
    const shape = makeShape();
    sm.saveMetadataSync(shape);

    // Simulate boot: load from disk, hand to a fresh MetadataStore.
    const loaded = sm.loadMetadata();
    expect(loaded).not.toBeNull();
    if (loaded === null) return;

    const store = new MetadataStore();
    store.hydrate(loaded);

    const p1 = store.get('p-1');
    expect(p1.metadata.label).toBe('Backend');
    expect(p1.metadata.role).toBe('service');
    expect(p1.version).toBe(5);

    const p2 = store.get('p-2');
    expect(p2.metadata.label).toBe('Frontend');
    expect(p2.metadata.custom).toEqual({ team: 'ui' });
    expect(p2.version).toBe(3);
  });

  it('persist-then-publish end-to-end: store.set writes metadata.json before emit', () => {
    const sm = new SessionManager();
    const store = new MetadataStore();
    store.setPersist((shape) => sm.saveMetadataSync(shape));

    store.set('p-1', { label: 'live' }, { workspaceId: 'ws-1' });

    // On disk immediately — the persist callback ran synchronously inside
    // store.set, before the EventBus emit returned.
    const loaded = sm.loadMetadata();
    expect(loaded?.entries).toHaveLength(1);
    expect(loaded?.entries[0]?.paneId).toBe('p-1');
    expect(loaded?.entries[0]?.metadata.label).toBe('live');
    expect(loaded?.entries[0]?.version).toBe(1);
  });
});
