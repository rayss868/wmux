import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../EventBus';
import { RING_CAPACITY } from '../../../shared/events';

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
});
