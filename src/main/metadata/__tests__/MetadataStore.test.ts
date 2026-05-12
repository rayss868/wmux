// === MetadataStore unit tests (M0-a) ===
//
// Covers CRUD + version monotonicity, mergeMode semantics, optimistic
// concurrency (expectedVersion), snapshot/hydrate/serialize/migrate,
// onPaneDeleted, validation guards, and EventBus emission shape.
//
// EventBus is injected per-test so emit() interactions can be observed
// in isolation from the module-level singleton.

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../../events/EventBus';
import {
  MetadataStore,
  METADATA_SCHEMA_VERSION,
  type PersistedShape,
} from '../MetadataStore';
import {
  PANE_METADATA_LABEL_MAX,
  PANE_METADATA_CUSTOM_MAX_ENTRIES,
  PANE_METADATA_MAX_BYTES,
} from '../../../shared/types';

describe('MetadataStore', () => {
  let bus: EventBus;
  let store: MetadataStore;

  beforeEach(() => {
    bus = new EventBus();
    store = new MetadataStore({ eventBus: bus });
  });

  // ===========================================================================
  // CRUD + version
  // ===========================================================================

  describe('get + set + clear + version', () => {
    it('get on empty pane returns version 0 with empty metadata', () => {
      const result = store.get('p-1');
      expect(result.version).toBe(0);
      expect(result.metadata).toEqual({});
    });

    it('first set bumps version 0 → 1 and returns merged metadata', () => {
      const result = store.set('p-1', { label: 'Backend' }, { workspaceId: 'ws-1' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.version).toBe(1);
      expect(result.metadata.label).toBe('Backend');

      const read = store.get('p-1');
      expect(read.version).toBe(1);
      expect(read.metadata.label).toBe('Backend');
    });

    it('clear on a pane with metadata bumps version + empties the shape', () => {
      store.set('p-1', { label: 'Backend', role: 'service' }, { workspaceId: 'ws-1' });
      const result = store.clear('p-1');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.version).toBe(2);
      expect(result.metadata).toEqual({});

      const read = store.get('p-1');
      expect(read.metadata.label).toBeUndefined();
      expect(read.metadata.role).toBeUndefined();
      // Version stays at 2 (post-clear), monotonic across the lifecycle.
      expect(read.version).toBe(2);
    });

    it('clear on a never-written pane is a no-op (no event, version 0)', () => {
      const beforeCursor = bus.latestSeq();
      const result = store.clear('p-never');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.version).toBe(0);
      expect(bus.latestSeq()).toBe(beforeCursor); // no event emitted
    });

    it('onPaneDeleted keeps the version counter monotonic for recycled IDs', () => {
      store.set('p-recycle', { label: 'First' }, { workspaceId: 'ws-1' }); // v1
      store.set('p-recycle', { status: 'running' }, { workspaceId: 'ws-1' }); // v2
      store.onPaneDeleted('p-recycle');                                       // v3 (empty)

      // The pane is "deleted" but the entry slot lingers so a recycled
      // paneId in the same daemon run can't trick subscribers into seeing
      // a fake version reset.
      const afterDelete = store.get('p-recycle');
      expect(afterDelete.version).toBe(3);
      expect(afterDelete.metadata).toEqual({});

      // A new write under the recycled id starts from v3 + 1 = v4.
      const writeAfter = store.set('p-recycle', { label: 'Recycled' }, { workspaceId: 'ws-1' });
      expect(writeAfter.ok).toBe(true);
      if (writeAfter.ok) expect(writeAfter.version).toBe(4);
    });
  });

  // ===========================================================================
  // mergeMode
  // ===========================================================================

  describe('mergeMode', () => {
    beforeEach(() => {
      store.set(
        'p-1',
        {
          label: 'Backend',
          role: 'service',
          custom: { 'orchestrator.taskId': 'T-1', 'qa.status': 'pending' },
        },
        { workspaceId: 'ws-1' },
      );
    });

    it("'merge' (default) patches top-level + deep-merges custom one level", () => {
      const result = store.set(
        'p-1',
        { status: 'running', custom: { 'qa.status': 'passing', 'dashboard.live': 'true' } },
        { workspaceId: 'ws-1' },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.metadata.label).toBe('Backend');     // preserved
      expect(result.metadata.role).toBe('service');      // preserved
      expect(result.metadata.status).toBe('running');    // patched
      expect(result.metadata.custom).toEqual({
        'orchestrator.taskId': 'T-1',                    // preserved
        'qa.status': 'passing',                          // overwritten
        'dashboard.live': 'true',                        // added
      });
    });

    it("'replace' fully overwrites — patch shape is the new shape", () => {
      const result = store.set(
        'p-1',
        { status: 'fresh' },
        { mergeMode: 'replace', workspaceId: 'ws-1' },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.metadata.label).toBeUndefined();
      expect(result.metadata.role).toBeUndefined();
      expect(result.metadata.status).toBe('fresh');
      expect(result.metadata.custom).toBeUndefined();
    });

    it("'replaceShared' replaces top-level shared fields but preserves custom", () => {
      const result = store.set(
        'p-1',
        { label: 'NewLabel', status: 'fresh' },
        { mergeMode: 'replaceShared', workspaceId: 'ws-1' },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.metadata.label).toBe('NewLabel');
      expect(result.metadata.role).toBeUndefined();      // dropped — replaceShared discards omitted shared fields
      expect(result.metadata.status).toBe('fresh');
      expect(result.metadata.custom).toEqual({
        'orchestrator.taskId': 'T-1',
        'qa.status': 'pending',
      });                                                // preserved
    });

    it("'replaceShared' silently ignores patch.custom — substrate guarantee against namespace clobber", () => {
      // A misbehaving (or naive) caller sends shared fields + their own
      // custom map. The substrate must NOT let that overwrite another
      // tool's namespaced state — that's the whole point of replaceShared.
      const result = store.set(
        'p-1',
        {
          label: 'Owned',
          custom: { 'attacker.steal': 'true' },          // ← attempt to clobber
        },
        { mergeMode: 'replaceShared', workspaceId: 'ws-1' },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.metadata.label).toBe('Owned');
      // base.custom survives wholesale; patch.custom is dropped.
      expect(result.metadata.custom).toEqual({
        'orchestrator.taskId': 'T-1',
        'qa.status': 'pending',
      });
      // attacker key MUST NOT land.
      expect(result.metadata.custom?.['attacker.steal']).toBeUndefined();
    });

    it('version is bumped on the post-merge shape, regardless of mode', () => {
      // p-1 is at v1 after the beforeEach.
      const replace = store.set('p-1', {}, { mergeMode: 'replace', workspaceId: 'ws-1' });
      expect(replace.ok).toBe(true);
      if (replace.ok) expect(replace.version).toBe(2);

      const merge = store.set('p-1', { label: 'A' }, { workspaceId: 'ws-1' });
      expect(merge.ok).toBe(true);
      if (merge.ok) expect(merge.version).toBe(3);

      const replaceShared = store.set(
        'p-1',
        { role: 'r' },
        { mergeMode: 'replaceShared', workspaceId: 'ws-1' },
      );
      expect(replaceShared.ok).toBe(true);
      if (replaceShared.ok) expect(replaceShared.version).toBe(4);
    });
  });

  // ===========================================================================
  // Optimistic concurrency
  // ===========================================================================

  describe('expectedVersion (optimistic concurrency)', () => {
    it('without expectedVersion always commits regardless of current version', () => {
      store.set('p-1', { label: 'A' }, { workspaceId: 'ws-1' }); // v1
      store.set('p-1', { label: 'B' }, { workspaceId: 'ws-1' }); // v2
      const result = store.set('p-1', { label: 'C' }, { workspaceId: 'ws-1' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.version).toBe(3);
    });

    it('with matching expectedVersion commits and bumps', () => {
      store.set('p-1', { label: 'A' }, { workspaceId: 'ws-1' }); // v1
      const result = store.set(
        'p-1',
        { label: 'B' },
        { workspaceId: 'ws-1', expectedVersion: 1 },
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.version).toBe(2);
    });

    it('with mismatched expectedVersion returns VERSION_CONFLICT + currentVersion (no mutation)', () => {
      store.set('p-1', { label: 'A' }, { workspaceId: 'ws-1' }); // v1
      store.set('p-1', { label: 'B' }, { workspaceId: 'ws-1' }); // v2

      const beforeCursor = bus.latestSeq();
      const result = store.set(
        'p-1',
        { label: 'C' },
        { workspaceId: 'ws-1', expectedVersion: 1 },          // stale
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('VERSION_CONFLICT');
      expect(result.currentVersion).toBe(2);

      // Mutation did NOT happen.
      const read = store.get('p-1');
      expect(read.version).toBe(2);
      expect(read.metadata.label).toBe('B');

      // Event was NOT emitted.
      expect(bus.latestSeq()).toBe(beforeCursor);
    });

    it('expectedVersion: 0 on a never-written pane commits as the first write', () => {
      const result = store.set(
        'p-fresh',
        { label: 'Hello' },
        { workspaceId: 'ws-1', expectedVersion: 0 },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.version).toBe(1);
        expect(result.metadata.label).toBe('Hello');
      }
    });

    it('set reply echoes version that subsequent get reproduces (idempotence anchor)', () => {
      const a = store.set('p-1', { label: 'A' }, { workspaceId: 'ws-1' });
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      const fromGet = store.get('p-1');
      expect(fromGet.version).toBe(a.version);
      expect(fromGet.metadata.label).toBe('A');
    });
  });

  // ===========================================================================
  // Validation + size caps
  // ===========================================================================

  describe('validation', () => {
    it('rejects label exceeding PANE_METADATA_LABEL_MAX', () => {
      const long = 'x'.repeat(PANE_METADATA_LABEL_MAX + 1);
      expect(() =>
        store.set('p-1', { label: long }, { workspaceId: 'ws-1' }),
      ).toThrow(/"label" exceeds/);
    });

    it('rejects custom with more than PANE_METADATA_CUSTOM_MAX_ENTRIES entries', () => {
      const custom: Record<string, string> = {};
      for (let i = 0; i <= PANE_METADATA_CUSTOM_MAX_ENTRIES; i++) {
        custom[`k${i}`] = 'v';
      }
      expect(() =>
        store.set('p-1', { custom }, { workspaceId: 'ws-1' }),
      ).toThrow(/"custom" exceeds/);
    });

    it('rejects cumulative merge writes that grow custom past the entry cap', () => {
      // Each individual patch stays under the cap, but accumulated state
      // crosses it. The post-merge check must catch this — otherwise the
      // contract documented in stability.md is meaningless.
      const half = Math.ceil(PANE_METADATA_CUSTOM_MAX_ENTRIES / 2);
      const first: Record<string, string> = {};
      const second: Record<string, string> = {};
      for (let i = 0; i < half; i++) first[`a${i}`] = 'v';
      for (let i = 0; i < half + 1; i++) second[`b${i}`] = 'v'; // pushes past cap when merged
      store.set('p-1', { custom: first }, { workspaceId: 'ws-1' });
      expect(() =>
        store.set('p-1', { custom: second }, { workspaceId: 'ws-1' }),
      ).toThrow(/"custom" exceeds/);
    });

    it('size cap check runs AFTER updatedAt is appended (boundary safety)', () => {
      // sanitize() does not enforce the byte cap; the post-merge check does.
      // The codex P2 #2 fix moved that check to run after updatedAt is appended
      // so the cap reflects the actual stored shape.
      //
      // Envelope arithmetic for {custom:{k:VALUE}}:
      //   raw overhead         = {"custom":{"k":""}}             → 18 bytes
      //   updatedAt overhead   = ,"updatedAt":1234567890123       → ~25 bytes (13-digit ts)
      // We pick value = MAX_BYTES - 30 so that:
      //   pre-updatedAt JSON size  = MAX_BYTES - 12 (would have passed the old check)
      //   post-updatedAt JSON size = MAX_BYTES + 13 (must throw with the fix)
      const value = 'x'.repeat(PANE_METADATA_MAX_BYTES - 30);
      expect(() =>
        store.set('p-1', { custom: { k: value } }, { workspaceId: 'ws-1' }),
      ).toThrow(/exceeds .* bytes/);
    });

    it('rejects merged shape exceeding PANE_METADATA_MAX_BYTES', () => {
      // Build a payload right at the cap by stuffing custom values.
      // The cap is on JSON.stringify(merged); we craft custom entries
      // that drive the merged size past the limit.
      const bigValue = 'x'.repeat(Math.floor(PANE_METADATA_MAX_BYTES / 4));
      const custom: Record<string, string> = {};
      for (let i = 0; i < 8; i++) custom[`k${i}`] = bigValue;
      expect(() =>
        store.set('p-1', { custom }, { workspaceId: 'ws-1' }),
      ).toThrow(/exceeds .* bytes/);
    });

    it('does not bump version on validation failure', () => {
      store.set('p-1', { label: 'A' }, { workspaceId: 'ws-1' }); // v1
      const beforeCursor = bus.latestSeq();
      expect(() =>
        store.set('p-1', { label: 'x'.repeat(PANE_METADATA_LABEL_MAX + 1) }, { workspaceId: 'ws-1' }),
      ).toThrow();
      expect(store.get('p-1').version).toBe(1);   // unchanged
      expect(bus.latestSeq()).toBe(beforeCursor); // no event emitted
    });
  });

  // ===========================================================================
  // Snapshot
  // ===========================================================================

  describe('snapshot', () => {
    it('returns asOfSeq matching EventBus.latestSeq() at the snapshot moment', () => {
      store.set('p-1', { label: 'A' }, { workspaceId: 'ws-1' });
      store.set('p-2', { label: 'B' }, { workspaceId: 'ws-1' });
      const snap = store.snapshot();
      expect(snap.asOfSeq).toBe(bus.latestSeq());
      expect(snap.bootId).toBe(bus.bootId);
    });

    it('returns one entry per pane with the current metadata + version', () => {
      store.set('p-1', { label: 'A' }, { workspaceId: 'ws-1' });
      store.set('p-1', { role: 'r' }, { workspaceId: 'ws-1' });
      store.set('p-2', { label: 'B' }, { workspaceId: 'ws-2' });

      const snap = store.snapshot();
      const byPane = new Map(snap.entries.map((e) => [e.paneId, e]));
      expect(byPane.get('p-1')?.version).toBe(2);
      expect(byPane.get('p-1')?.metadata.label).toBe('A');
      expect(byPane.get('p-1')?.metadata.role).toBe('r');
      expect(byPane.get('p-2')?.version).toBe(1);
      expect(byPane.get('p-2')?.workspaceId).toBe('ws-2');
    });
  });

  // ===========================================================================
  // Persistence (hydrate / serialize / migrate)
  // ===========================================================================

  describe('hydrate + serialize + migrate', () => {
    it('serialize → hydrate roundtrip preserves state across a fresh store', () => {
      store.set('p-1', { label: 'A', role: 'svc' }, { workspaceId: 'ws-1' });
      store.set('p-2', { custom: { tier: 'prod' } }, { workspaceId: 'ws-2' });
      const dump = store.serialize();

      const bus2 = new EventBus();
      const store2 = new MetadataStore({ eventBus: bus2 });
      store2.hydrate(dump);

      expect(store2.get('p-1').version).toBe(1);
      expect(store2.get('p-1').metadata.label).toBe('A');
      expect(store2.get('p-2').metadata.custom?.tier).toBe('prod');
    });

    it('serialize drops entries whose metadata has been cleared (compact dumps)', () => {
      store.set('p-keep', { label: 'K' }, { workspaceId: 'ws-1' });
      store.set('p-drop', { label: 'D' }, { workspaceId: 'ws-1' });
      store.clear('p-drop');

      const dump = store.serialize();
      const paneIds = dump.entries.map((e) => e.paneId);
      expect(paneIds).toContain('p-keep');
      expect(paneIds).not.toContain('p-drop');
    });

    it('migrate is identity at the current schema version', () => {
      const input: PersistedShape = {
        schema_version: METADATA_SCHEMA_VERSION,
        entries: [
          {
            paneId: 'p-1',
            workspaceId: 'ws-1',
            metadata: { label: 'A' },
            version: 1,
          },
        ],
      };
      const out = store.migrate(input, METADATA_SCHEMA_VERSION);
      expect(out).toBe(input); // identity at current schema
    });

    it('migrate throws on unknown schema versions', () => {
      const bogus = { schema_version: 99, entries: [] } as unknown as PersistedShape;
      expect(() => store.migrate(bogus, METADATA_SCHEMA_VERSION)).toThrow(
        /unsupported metadata schema_version/,
      );
    });
  });

  // ===========================================================================
  // Event emission
  // ===========================================================================

  describe('EventBus emission', () => {
    it('set emits pane.metadata.changed with version + workspaceId', () => {
      store.set('p-1', { label: 'A' }, { workspaceId: 'ws-1' });
      const polled = bus.poll(0);
      const ev = polled.events.find((e) => e.type === 'pane.metadata.changed');
      expect(ev).toBeDefined();
      if (!ev || ev.type !== 'pane.metadata.changed') return;
      expect(ev.workspaceId).toBe('ws-1');
      expect(ev.paneId).toBe('p-1');
      expect(ev.metadata.label).toBe('A');
      expect(ev.version).toBe(1);
    });

    it('clear emits pane.metadata.changed with empty metadata + bumped version', () => {
      store.set('p-1', { label: 'A' }, { workspaceId: 'ws-1' });
      const before = bus.latestSeq();
      store.clear('p-1');
      const polled = bus.poll(before);
      const ev = polled.events.find((e) => e.type === 'pane.metadata.changed');
      expect(ev).toBeDefined();
      if (!ev || ev.type !== 'pane.metadata.changed') return;
      expect(ev.metadata).toEqual({});
      expect(ev.version).toBe(2);
    });

    it('VERSION_CONFLICT does not emit', () => {
      store.set('p-1', { label: 'A' }, { workspaceId: 'ws-1' });
      const before = bus.latestSeq();
      store.set('p-1', { label: 'B' }, { workspaceId: 'ws-1', expectedVersion: 99 });
      expect(bus.latestSeq()).toBe(before);
    });

    it('omits event when no workspaceId is known (in-memory commit still happens)', () => {
      // set without workspaceId AND no prior entry to remember one from
      const before = bus.latestSeq();
      const result = store.set('p-orphan', { label: 'Orphan' });
      expect(result.ok).toBe(true);
      // No event emitted because the store has no workspaceId to scope it to.
      expect(bus.latestSeq()).toBe(before);
      // But the in-memory commit happened.
      expect(store.get('p-orphan').metadata.label).toBe('Orphan');
    });
  });

  // ===========================================================================
  // Persist-then-publish (M0-e)
  // ===========================================================================

  describe('persist-then-publish (M0-e)', () => {
    /**
     * Wraps an EventBus to record an "emit" marker in the shared trace
     * the moment `bus.emit` is called from inside the store. The store
     * also calls the wrapped EventBus's `latestSeq()` from `snapshot()`,
     * so we narrow the trace to emits only (those are the publish step
     * the race spec talks about).
     */
    function traceBus(trace: string[]): EventBus {
      const inner = new EventBus();
      const real = inner.emit.bind(inner);
      inner.emit = ((input: Parameters<EventBus['emit']>[0]) => {
        trace.push('emit');
        return real(input);
      }) as EventBus['emit'];
      return inner;
    }

    it('persist runs before emit on set()', () => {
      const order: string[] = [];
      const localBus = traceBus(order);
      const s = new MetadataStore({
        eventBus: localBus,
        persist: () => order.push('persist'),
      });
      s.set('p-1', { label: 'x' }, { workspaceId: 'ws-1' });
      expect(order).toEqual(['persist', 'emit']);
    });

    it('persist runs before emit on clear()', () => {
      const order: string[] = [];
      const localBus = traceBus(order);
      const s = new MetadataStore({ eventBus: localBus });
      // Seed without persist so the initial set() does not pollute the
      // trace we want to assert on (clear-time ordering only).
      s.set('p-1', { label: 'x' }, { workspaceId: 'ws-1' });
      order.length = 0;

      s.setPersist(() => order.push('persist'));
      s.clear('p-1');
      expect(order).toEqual(['persist', 'emit']);
    });

    it('persist failure suppresses emit but keeps the in-memory commit (race spec #1)', () => {
      const order: string[] = [];
      const localBus = traceBus(order);
      const s = new MetadataStore({
        eventBus: localBus,
        persist: () => {
          throw new Error('disk full');
        },
      });
      const result = s.set('p-1', { label: 'x' }, { workspaceId: 'ws-1' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.version).toBe(1);
      // No emit — subscribers must not observe a state we could not
      // durably record.
      expect(order).toEqual([]);
      // In-memory state still has the write; next hydrate replaces it
      // with whatever was last successfully persisted.
      expect(s.get('p-1').metadata.label).toBe('x');
    });

    it('persist failure on clear() also suppresses emit', () => {
      const order: string[] = [];
      const localBus = traceBus(order);
      let persistCount = 0;
      const s = new MetadataStore({
        eventBus: localBus,
        // First persist succeeds (set), second persist throws (clear).
        persist: () => {
          persistCount += 1;
          if (persistCount === 2) throw new Error('disk full');
        },
      });
      s.set('p-1', { label: 'x' }, { workspaceId: 'ws-1' });
      expect(order).toEqual(['emit']);
      s.clear('p-1');
      // Emit suppressed on the failing clear; the in-memory state is
      // still cleared (matches the documented commit-but-no-publish path).
      expect(order).toEqual(['emit']);
      expect(s.get('p-1').metadata).toEqual({});
    });

    it('setPersist late-binds the callback', () => {
      const order: string[] = [];
      const localBus = traceBus(order);
      const s = new MetadataStore({ eventBus: localBus });

      // First write — no persist wired yet, so emit fires immediately.
      s.set('p-1', { label: 'first' }, { workspaceId: 'ws-1' });
      expect(order).toEqual(['emit']);

      // Wire persist; the next write must now go persist → emit.
      s.setPersist(() => order.push('persist'));
      s.set('p-1', { label: 'second' }, { workspaceId: 'ws-1' });
      expect(order).toEqual(['emit', 'persist', 'emit']);
    });
  });
});
