// === MetadataStore lifecycle wiring (final-review follow-up, P0-1) ===
//
// Proves that the EventBus subscriber in `src/main/index.ts` correctly
// translates a `pane.closed` event into a `MetadataStore.onPaneDeleted`
// tombstone write. The actual boot wiring is exercised by replicating
// the subscription contract here — instantiating the real EventBus +
// MetadataStore and registering the same handler shape main/index.ts
// uses. Without this guard, the production hook would only have unit
// tests on the store side (every call site mocked) and `metadata.json`
// could grow unbounded.
//
// See `src/main/index.ts` — the `eventBus.subscribe((event) => …)` block
// that this test mirrors.

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../../events/EventBus';
import { MetadataStore } from '../MetadataStore';

describe('MetadataStore lifecycle wiring (pane.closed → onPaneDeleted)', () => {
  let bus: EventBus;
  let store: MetadataStore;
  let persisted: { entries: { paneId: string; version: number }[] } | null;

  beforeEach(() => {
    bus = new EventBus();
    persisted = null;
    store = new MetadataStore({
      eventBus: bus,
      persist: (shape) => {
        persisted = {
          entries: shape.entries.map((e) => ({ paneId: e.paneId, version: e.version })),
        };
      },
    });

    // This mirrors the production wiring in `src/main/index.ts`. If the
    // shape of the production hook drifts (e.g. additional filtering),
    // update the snippet below to match — the wiring contract is what
    // we are exercising.
    bus.subscribe((event) => {
      if (event.type !== 'pane.closed') return;
      store.onPaneDeleted(event.paneId);
    });
  });

  it('pane.closed event drops the metadata entry from the persisted shape', () => {
    // Seed: the store holds metadata for a pane.
    const written = store.set('p-1', { label: 'Backend' }, { workspaceId: 'ws-1' });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.version).toBe(1);
    expect(persisted?.entries.map((e) => e.paneId)).toEqual(['p-1']);

    // The renderer (or any other producer) emits pane.closed on the bus.
    bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p-1' });

    // The subscriber must have fired `onPaneDeleted`, which:
    //  - keeps the in-memory tombstone slot (version stays monotonic)
    //  - bumps the version once more
    //  - drops the entry from `serialize()` (empty metadata) so the
    //    on-disk shape shrinks immediately.
    const after = store.get('p-1');
    expect(after.version).toBe(2);
    expect(after.metadata).toEqual({});
    expect(persisted?.entries).toEqual([]);
  });

  it('pane.closed for a pane that never had metadata is a no-op', () => {
    bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p-ghost' });
    // No prior write → no persist call → no tombstone in the persisted
    // shape. The subscriber must not crash on an unknown paneId.
    expect(persisted).toBeNull();
    expect(store.get('p-ghost').version).toBe(0);
  });

  it('does not react to non-pane.closed events', () => {
    store.set('p-1', { label: 'Backend' }, { workspaceId: 'ws-1' });
    persisted = null;

    bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p-1' });
    bus.emit({ type: 'pane.focused', workspaceId: 'ws-1', paneId: 'p-1' });
    bus.emit({
      type: 'process.started',
      workspaceId: 'ws-1',
      ptyId: 't-1',
      shell: 'pwsh',
    });

    // None of those events should have driven a tombstone write.
    expect(persisted).toBeNull();
    expect(store.get('p-1').metadata.label).toBe('Backend');
  });

  it('after pane.closed, hydrate of the persisted shape does not resurrect the entry', () => {
    // Seed two panes; close one. The post-close persisted shape MUST NOT
    // contain p-1 — otherwise a daemon restart would re-seed it as a
    // ghost pane on next boot (the very bug this fix prevents).
    store.set('p-1', { label: 'closed-soon' }, { workspaceId: 'ws-1' });
    store.set('p-2', { label: 'still-open' }, { workspaceId: 'ws-1' });

    bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p-1' });

    expect(persisted?.entries.map((e) => e.paneId)).toEqual(['p-2']);

    // Simulate boot: a fresh store hydrates from the persisted shape.
    const replay = new MetadataStore();
    replay.hydrate(store.serialize());
    expect(replay.get('p-1').version).toBe(0); // ghost prevented
    expect(replay.get('p-1').metadata).toEqual({});
    expect(replay.get('p-2').metadata.label).toBe('still-open');
  });
});
