import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../EventBus';
import { RING_CAPACITY } from '../../../shared/events';

// Note: existing tests that check `nextCursor` semantics remain valid. The
// review fixes (5a bootId, 5a cursor>latest resync, 1a cursor advance under
// filter, 2a priorCursor+droppedCount) add new behavior on top.

describe('EventBus', () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus();
  });

  describe('emit + poll', () => {
    it('emits with monotonic seq + ts', () => {
      const a = bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      const b = bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(b.ts).toBeGreaterThanOrEqual(a.ts);
    });

    it('returns events newer than cursor', () => {
      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });
      bus.emit({ type: 'pane.focused', workspaceId: 'ws-1', paneId: 'p2' });

      const r = bus.poll(1);
      expect(r.events.map((e) => e.seq)).toEqual([2, 3]);
      expect(r.nextCursor).toBe(3);
      expect(r.resync).toBeUndefined();
    });

    it('returns empty + nextCursor=latestSeq when caller is up to date', () => {
      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });

      const r = bus.poll(2);
      expect(r.events).toEqual([]);
      expect(r.nextCursor).toBe(2);
    });

    it('cursor=0 replays everything still in the ring', () => {
      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });
      const r = bus.poll(0);
      expect(r.events.map((e) => e.seq)).toEqual([1, 2]);
    });
  });

  describe('ring overflow', () => {
    it('drops oldest when capacity exceeded; oldestSeq advances', () => {
      // Fill to capacity + 5 extras.
      for (let i = 0; i < RING_CAPACITY + 5; i++) {
        bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: `p${i}` });
      }
      expect(bus.latestSeq()).toBe(RING_CAPACITY + 5);
      // Oldest seq should be 6 (1..5 evicted).
      expect(bus.oldestSeq()).toBe(6);

      const r = bus.poll(0);
      // cursor=0 < oldestSeq-1=5 → resync flag fires.
      expect(r.resync).toBe(true);
      // Returns up to 256 events by default; at most RING_CAPACITY in the ring.
      expect(r.events.length).toBeLessThanOrEqual(256);
      // First returned event should be at or after oldestSeq.
      expect(r.events[0].seq).toBeGreaterThanOrEqual(6);
    });

    it('resync fires only when cursor < oldestSeq - 1', () => {
      // Capacity-1 events; ring not yet wrapped.
      for (let i = 0; i < RING_CAPACITY; i++) {
        bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: `p${i}` });
      }
      // Now wrap by 3.
      for (let i = 0; i < 3; i++) {
        bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: `p${i}` });
      }
      expect(bus.oldestSeq()).toBe(4);

      // Caller's cursor=3 → cursor < oldestSeq (4) but cursor === oldestSeq-1 → no resync.
      const noResync = bus.poll(3);
      expect(noResync.resync).toBeUndefined();

      // cursor=2 → strictly older than oldestSeq-1 → resync.
      const resync = bus.poll(2);
      expect(resync.resync).toBe(true);
    });
  });

  describe('filters', () => {
    it('type filter narrows results', () => {
      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });
      bus.emit({ type: 'process.started', workspaceId: 'ws-1', ptyId: 't1', shell: 'pwsh' });

      const r = bus.poll(0, { types: ['process.started'] });
      expect(r.events).toHaveLength(1);
      expect(r.events[0].type).toBe('process.started');
      // nextCursor is the seq of the matched event, not latest.
      expect(r.nextCursor).toBe(3);
    });

    it('workspaceId filter scopes to one workspace', () => {
      bus.emit({ type: 'pane.created', workspaceId: 'ws-A', paneId: 'pA' });
      bus.emit({ type: 'pane.created', workspaceId: 'ws-B', paneId: 'pB' });
      bus.emit({ type: 'pane.closed', workspaceId: 'ws-A', paneId: 'pA' });

      const r = bus.poll(0, { workspaceId: 'ws-A' });
      expect(r.events.map((e) => e.workspaceId)).toEqual(['ws-A', 'ws-A']);
    });

    it('combined type + workspace filter', () => {
      bus.emit({ type: 'pane.created', workspaceId: 'ws-A', paneId: 'p' });
      bus.emit({ type: 'pane.closed', workspaceId: 'ws-A', paneId: 'p' });
      bus.emit({ type: 'pane.created', workspaceId: 'ws-B', paneId: 'p' });

      const r = bus.poll(0, { types: ['pane.created'], workspaceId: 'ws-A' });
      expect(r.events).toHaveLength(1);
      expect(r.events[0].workspaceId).toBe('ws-A');
    });
  });

  describe('max', () => {
    it('caps result count at max', () => {
      for (let i = 0; i < 10; i++) {
        bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: `p${i}` });
      }
      const r = bus.poll(0, { max: 3 });
      expect(r.events).toHaveLength(3);
      expect(r.nextCursor).toBe(3); // last returned seq
    });
  });

  describe('reset', () => {
    it('clears the ring and resets seq counter', () => {
      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });
      expect(bus.latestSeq()).toBe(2);
      bus.reset();
      expect(bus.latestSeq()).toBe(0);
      expect(bus.poll(0).events).toEqual([]);
    });
  });

  describe('bootId (review fix 5a)', () => {
    it('exposes a stable bootId on every poll response', () => {
      const r1 = bus.poll(0);
      const r2 = bus.poll(0);
      expect(r1.bootId).toBe(r2.bootId);
      expect(typeof r1.bootId).toBe('string');
      expect(r1.bootId.length).toBeGreaterThan(0);
    });

    it('two EventBus instances have different bootIds', () => {
      const a = new EventBus();
      const b = new EventBus();
      expect(a.bootId).not.toBe(b.bootId);
    });
  });

  describe('priorCursor + droppedCount (review fix 2a)', () => {
    it('echoes priorCursor regardless of cursor validity', () => {
      const r = bus.poll(42);
      expect(r.priorCursor).toBe(42);
    });

    it('reports droppedCount when cursor drifted past the ring', () => {
      for (let i = 0; i < RING_CAPACITY + 10; i++) {
        bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: `p${i}` });
      }
      // oldest = 11. Caller cursor = 5 → missed 5..10 (6 events).
      const r = bus.poll(5);
      expect(r.resync).toBe(true);
      expect(r.droppedCount).toBe(5); // oldest - cursor - 1 = 11 - 5 - 1
    });

    it('omits droppedCount when no drift', () => {
      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      const r = bus.poll(0);
      expect(r.droppedCount).toBeUndefined();
      expect(r.resync).toBeUndefined();
    });
  });

  describe('cursor ahead of latest (review fix 5a)', () => {
    it('triggers resync when cursor > latestSeq (daemon-restart smell)', () => {
      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      // latestSeq=1; caller is 999 ahead — only possible after a daemon restart.
      const r = bus.poll(999);
      expect(r.resync).toBe(true);
      // After resync we serve from oldest forward.
      expect(r.events).toHaveLength(1);
    });
  });

  describe('garbage cursor inputs (review fix follow-up — defensive)', () => {
    it('Number.MAX_SAFE_INTEGER triggers resync, not silent zero events', () => {
      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });

      const r = bus.poll(Number.MAX_SAFE_INTEGER);
      expect(r.resync).toBe(true);
      // After resync we get all remaining events from oldest forward.
      expect(r.events.length).toBe(2);
    });

    it('extremely large but finite cursor still triggers resync via cursor>latest', () => {
      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      const r = bus.poll(1e15);
      expect(r.resync).toBe(true);
    });
  });

  describe('cursor advances under filter (review fix 1a)', () => {
    it('does not re-scan filter no-matches on subsequent polls', () => {
      // 50 pane events, then 5 process events.
      for (let i = 0; i < 50; i++) {
        bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: `p${i}` });
      }
      for (let i = 0; i < 5; i++) {
        bus.emit({ type: 'process.started', workspaceId: 'ws-1', ptyId: `t${i}`, shell: 'pwsh' });
      }

      // First poll for process.* — gets 5 matches but cursor must advance
      // past the 50 pane events too, otherwise next poll re-scans them.
      const r1 = bus.poll(0, { types: ['process.started'] });
      expect(r1.events).toHaveLength(5);
      expect(r1.nextCursor).toBe(55); // last scanned (or latest), NOT 55 vs 5

      // No new events. Second poll should return empty without re-scanning
      // the 50 pane.created entries.
      const r2 = bus.poll(r1.nextCursor, { types: ['process.started'] });
      expect(r2.events).toEqual([]);
      expect(r2.nextCursor).toBe(55);
    });

    it('preserves catch-up semantics when max truncates the page', () => {
      for (let i = 0; i < 10; i++) {
        bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: `p${i}` });
      }
      // max=3 — caller still has 7 events to pick up. Cursor must be the
      // last DELIVERED seq, not latest, so the next poll catches up.
      const r1 = bus.poll(0, { max: 3 });
      expect(r1.events).toHaveLength(3);
      expect(r1.nextCursor).toBe(3);

      const r2 = bus.poll(r1.nextCursor, { max: 3 });
      expect(r2.events.map((e) => e.seq)).toEqual([4, 5, 6]);
    });
  });

  describe('subscribe (final-review follow-up P0-1)', () => {
    it('invokes subscribers synchronously with the committed event', () => {
      const seen: { seq: number; type: string }[] = [];
      bus.subscribe((ev) => seen.push({ seq: ev.seq, type: ev.type }));

      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });

      expect(seen).toEqual([
        { seq: 1, type: 'pane.created' },
        { seq: 2, type: 'pane.closed' },
      ]);
    });

    it('unsubscribe stops future delivery without affecting other subscribers', () => {
      const a: number[] = [];
      const b: number[] = [];
      const unsubA = bus.subscribe((ev) => a.push(ev.seq));
      bus.subscribe((ev) => b.push(ev.seq));

      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      unsubA();
      bus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });

      expect(a).toEqual([1]);
      expect(b).toEqual([1, 2]);
    });

    it('throwing subscriber does not block other subscribers or suppress poll delivery', () => {
      const seen: number[] = [];
      bus.subscribe(() => {
        throw new Error('boom');
      });
      bus.subscribe((ev) => seen.push(ev.seq));

      // emit must not throw — the synchronous fan-out swallows subscriber errors.
      expect(() => {
        bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      }).not.toThrow();

      expect(seen).toEqual([1]);
      // The throwing subscriber must NOT have prevented the event from
      // being committed to the ring; a poll-only client still sees it.
      const r = bus.poll(0);
      expect(r.events.map((e) => e.seq)).toEqual([1]);
    });

    it('reset() clears subscribers (test-isolation guarantee)', () => {
      const seen: number[] = [];
      bus.subscribe((ev) => seen.push(ev.seq));
      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
      expect(seen).toEqual([1]);

      bus.reset();
      bus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p2' });
      expect(seen).toEqual([1]); // unchanged — subscriber dropped on reset
    });
  });
});
