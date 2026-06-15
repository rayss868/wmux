import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerEventsRpc } from '../events.rpc';
import { eventBus } from '../../../events/EventBus';

// registerHandlers.ts imports `electron` at module top-level (ipcMain,
// BrowserWindow). Mock it so we can import the pure a2a.task trust-boundary
// predicate (buildA2aTaskEmitInput) without standing up Electron — the same
// pattern 20+ main-process suites use. We only need the names that exist on
// the module surface to satisfy the import; nothing here is invoked.
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeAllListeners: vi.fn() },
  app: { getPath: vi.fn(() => ''), on: vi.fn() },
}));

import { buildA2aTaskEmitInput } from '../../../ipc/registerHandlers';
import type { A2aTaskEvent } from '../../../../shared/events';

function setupRouter(): RpcRouter {
  const router = new RpcRouter();
  registerEventsRpc(router);
  return router;
}

/**
 * Emit an a2a.task onto the ring through the SAME allow-listed shape the
 * publish trust boundary (registerHandlers onEventsPublish) produces. Using
 * buildA2aTaskEmitInput keeps the test honest: if the boundary's validation
 * rejects the input, nothing is emitted and the assertion sees zero events —
 * exactly the production behavior.
 */
function publishA2aTask(input: Record<string, unknown>): boolean {
  const emit = buildA2aTaskEmitInput(input);
  if (!emit) return false;
  eventBus.emit(emit);
  return true;
}

async function pollEvents(
  router: RpcRouter,
  params: Record<string, unknown>,
): Promise<Array<{ type: string; kind?: string; from?: string; to?: string }>> {
  const res = await router.dispatch({ id: 'p', method: 'events.poll', params });
  if (!res.ok) throw new Error('poll dispatch failed');
  return (res.result as { events: Array<{ type: string; kind?: string }> }).events;
}

describe('events.rpc — events.poll', () => {
  beforeEach(() => {
    eventBus.reset();
  });

  it('returns events with cursor and types defaults', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });

    const router = setupRouter();
    const res = await router.dispatch({ id: '1', method: 'events.poll', params: {} });

    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as { events: unknown[]; nextCursor: number };
      expect(result.events).toHaveLength(2);
      expect(result.nextCursor).toBe(2);
    }
  });

  it('honors cursor param', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit({ type: 'pane.closed', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit({ type: 'pane.focused', workspaceId: 'ws-1', paneId: 'p2' });

    const router = setupRouter();
    const res = await router.dispatch({ id: '2', method: 'events.poll', params: { cursor: 1 } });

    if (res.ok) {
      const result = res.result as { events: { seq: number }[] };
      expect(result.events.map((e) => e.seq)).toEqual([2, 3]);
    }
  });

  it('honors workspaceId scope', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-A', paneId: 'pA' });
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-B', paneId: 'pB' });
    eventBus.emit({ type: 'pane.focused', workspaceId: 'ws-A', paneId: 'pA' });

    const router = setupRouter();
    const res = await router.dispatch({ id: '3', method: 'events.poll', params: { workspaceId: 'ws-A' } });

    if (res.ok) {
      const result = res.result as { events: { workspaceId: string }[] };
      expect(result.events.every((e) => e.workspaceId === 'ws-A')).toBe(true);
    }
  });

  it('honors types filter and drops unknown types silently', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit({ type: 'process.started', workspaceId: 'ws-1', ptyId: 't1', shell: 'pwsh' });

    const router = setupRouter();
    const res = await router.dispatch({
      id: '4',
      method: 'events.poll',
      params: { types: ['process.started', 'not-a-real-type'] },
    });

    if (res.ok) {
      const result = res.result as { events: { type: string }[] };
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('process.started');
    }
  });

  it('accepts agent.lifecycle filter (new event type)', async () => {
    eventBus.emit({
      type: 'agent.lifecycle',
      workspaceId: 'ws-1',
      ptyId: 'pty-1',
      kind: 'agent.stop',
      source: 'hook',
      agent: 'claude',
      decision: 'emit',
    });
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p-other' });

    const router = setupRouter();
    const res = await router.dispatch({
      id: 'lifecycle',
      method: 'events.poll',
      params: { types: ['agent.lifecycle'] },
    });

    if (res.ok) {
      const result = res.result as { events: { type: string; source?: string }[] };
      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({ type: 'agent.lifecycle', source: 'hook' });
    }
  });

  it('accepts workspace.metadata.changed filter (pre-existing gap closed)', async () => {
    eventBus.emit({
      type: 'workspace.metadata.changed',
      workspaceId: 'ws-1',
      metadata: { cwd: '/repo' },
      patch: { cwd: '/repo' },
    });

    const router = setupRouter();
    const res = await router.dispatch({
      id: 'wsmeta',
      method: 'events.poll',
      params: { types: ['workspace.metadata.changed'] },
    });

    if (res.ok) {
      const result = res.result as { events: { type: string }[] };
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('workspace.metadata.changed');
    }
  });

  it('clamps cursor to non-negative integer', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });

    const router = setupRouter();
    const res = await router.dispatch({
      id: '5',
      method: 'events.poll',
      params: { cursor: -50 },
    });

    if (res.ok) {
      const result = res.result as { events: unknown[] };
      // Negative cursor clamps to 0, so we still get the event.
      expect(result.events).toHaveLength(1);
    }
  });

  it('honors max param', async () => {
    for (let i = 0; i < 5; i++) {
      eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: `p${i}` });
    }

    const router = setupRouter();
    const res = await router.dispatch({
      id: '6',
      method: 'events.poll',
      params: { max: 2 },
    });

    if (res.ok) {
      const result = res.result as { events: unknown[] };
      expect(result.events).toHaveLength(2);
    }
  });

  it('exposes bootId + priorCursor on every response (review fixes 5a, 2a)', async () => {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });

    const router = setupRouter();
    const res = await router.dispatch({
      id: 'fix-1',
      method: 'events.poll',
      params: { cursor: 7 },
    });

    if (res.ok) {
      const result = res.result as { bootId: string; priorCursor: number };
      expect(typeof result.bootId).toBe('string');
      expect(result.bootId.length).toBeGreaterThan(0);
      expect(result.priorCursor).toBe(7);
    }
  });
});

// === A2A dual-party scoping — the make-or-break security suite ===
//
// An a2a.task involves TWO workspaces (from=sender, to=receiver). Its base
// workspaceId === from. The events.poll dual-party post-filter must make it
// visible to ONLY from and to, NEVER a third workspace, and NEVER an unscoped
// (workspaceId-less) poll. These cases drive the real EventBus + the real
// events.poll handler.
describe('events.rpc — a2a.task dual-party scoping', () => {
  const FROM = 'ws-sender';
  const TO = 'ws-receiver';
  const THIRD = 'ws-unrelated';

  beforeEach(() => {
    eventBus.reset();
  });

  /**
   * Seed a created + updated pair for the FROM→TO task, plus a non-a2a event
   * owned by FROM (to prove the strict path for other types is untouched).
   */
  function seedPair(): void {
    // created (kind:'created'), base workspaceId stamped === FROM by the boundary.
    expect(
      publishA2aTask({ type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'submitted', kind: 'created' }),
    ).toBe(true);
    // updated receipt (kind:'updated').
    expect(
      publishA2aTask({ type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'working', kind: 'updated' }),
    ).toBe(true);
    // A NON-a2a event with workspaceId === FROM — must stay strictly FROM-scoped.
    eventBus.emit({ type: 'pane.created', workspaceId: FROM, paneId: 'p-from' });
  }

  it('case 1: sender (poll workspaceId = from) sees the a2a.task created + updated', async () => {
    seedPair();
    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: FROM });
    const a2a = events.filter((e) => e.type === 'a2a.task');
    expect(a2a.map((e) => e.kind)).toEqual(['created', 'updated']);
  });

  it('case 2: receiver (poll workspaceId = to) sees the a2a.task created + updated', async () => {
    seedPair();
    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: TO });
    const a2a = events.filter((e) => e.type === 'a2a.task');
    // The receiver MUST see `created` even though the event's base
    // workspaceId === from (the dual-party `to` key + the no-strict-wsFilter
    // poll path make this work end-to-end).
    expect(a2a.map((e) => e.kind)).toEqual(['created', 'updated']);
    // And every a2a event the receiver sees is genuinely addressed to it.
    expect(a2a.every((e) => (e as A2aTaskEvent).to === TO)).toBe(true);
  });

  it('case 3: third party (unrelated workspaceId) sees NEITHER (zero a2a.task)', async () => {
    seedPair();
    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: THIRD });
    expect(events.filter((e) => e.type === 'a2a.task')).toHaveLength(0);
  });

  it('case 4: a non-a2a event with workspaceId === from is NOT leaked to a poller whose workspaceId = to', async () => {
    seedPair();
    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: TO });
    // The strict path for non-a2a types is untouched: a pane.created owned by
    // FROM must never reach the TO poller.
    const paneEvents = events.filter((e) => e.type === 'pane.created');
    expect(paneEvents).toHaveLength(0);
    // (And the sender DOES still see its own pane.created — sanity.)
    const senderEvents = await pollEvents(router, { workspaceId: FROM });
    expect(senderEvents.some((e) => e.type === 'pane.created')).toBe(true);
  });

  it('case 5: unscoped poll (no workspaceId) returns ZERO a2a.task events (plugin-host leak guard)', async () => {
    seedPair();
    const router = setupRouter();
    // No workspaceId — mimics the plugin-host forwarding poll. The `!!caller &&`
    // clause must unconditionally withhold every a2a.task.
    const events = await pollEvents(router, {});
    expect(events.filter((e) => e.type === 'a2a.task')).toHaveLength(0);
    // The unscoped poll still receives non-a2a events (strict path: no caller →
    // pass-through), proving the withholding is a2a-specific, not a blanket drop.
    expect(events.some((e) => e.type === 'pane.created')).toBe(true);
  });

  // === Regression locks requested by the security review (PASS_WITH_NITS) ===

  // Test A — per-event discrimination. The dual-party filter matches each
  // event's OWN from/to; it is NOT "deliver any a2a.task to anyone who is a
  // party to SOME task on the ring". Three distinct tasks share one ring; the
  // poller (THIRD) is the receiver of exactly one of them and must see only
  // that one — never the other two, even though they all carry type a2a.task.
  it('case A: dual-party filter discriminates per-event (THIRD sees only the task addressed to it)', async () => {
    const D = 'ws-d';
    const E = 'ws-e';
    // task1: FROM → TO          (THIRD is not a party)
    expect(
      publishA2aTask({ type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'submitted', kind: 'created' }),
    ).toBe(true);
    // task2: FROM → THIRD        (THIRD is the `to` — the ONLY one it may see)
    expect(
      publishA2aTask({ type: 'a2a.task', from: FROM, to: THIRD, taskId: 't2', state: 'submitted', kind: 'created' }),
    ).toBe(true);
    // task3: D → E               (two workspaces unrelated to THIRD)
    expect(
      publishA2aTask({ type: 'a2a.task', from: D, to: E, taskId: 't3', state: 'submitted', kind: 'created' }),
    ).toBe(true);

    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: THIRD });
    const a2a = events.filter((e) => e.type === 'a2a.task') as A2aTaskEvent[];
    // Exactly task2 — and proven by identity, not just count: every delivered
    // event is the FROM→THIRD pair. task1 (FROM→TO) and task3 (D→E) are absent.
    expect(a2a).toHaveLength(1);
    expect(a2a[0].taskId).toBe('t2');
    expect(a2a[0].from).toBe(FROM);
    expect(a2a[0].to).toBe(THIRD);
    // Belt-and-suspenders: NONE of the foreign pairs leaked in.
    expect(a2a.some((e) => e.taskId === 't1')).toBe(false);
    expect(a2a.some((e) => e.taskId === 't3')).toBe(false);
  });

  // Test B — max-truncation cursor correctness. A regression that "fixes"
  // throughput by recomputing nextCursor AFTER the post-filter could rewind
  // the cursor (the post-filter strips foreign events, so the last *delivered*
  // event sits behind the last *scanned* one). Rewinding risks either a
  // re-delivery loop or — if combined with `max` truncation — a permanent miss
  // of the one event the poller actually wants. We seed N foreign-pair events
  // ahead of a single addressed one and page through with max:1, threading the
  // server's nextCursor. The poller must (1) never see a foreign event,
  // (2) eventually receive its event, (3) observe a monotonic (never-rewinding)
  // cursor, and (4) terminate within a bounded number of polls.
  it('case B: max-truncation pages past foreign a2a.task events without rewinding the cursor or missing the addressed one', async () => {
    const Y = 'ws-y';
    const X = 'ws-x';
    const N = 5;
    // N foreign-pair events the poller (X) must NEVER receive...
    for (let i = 0; i < N; i++) {
      expect(
        publishA2aTask({ type: 'a2a.task', from: 'ws-d', to: 'ws-e', taskId: `f${i}`, state: 'submitted', kind: 'created' }),
      ).toBe(true);
    }
    // ...followed by the ONE event addressed to X (Y → X).
    expect(
      publishA2aTask({ type: 'a2a.task', from: Y, to: X, taskId: 'addressed', state: 'submitted', kind: 'created' }),
    ).toBe(true);

    const router = setupRouter();
    let cursor = 0;
    let prevCursor = 0;
    let sawAddressed = false;
    const maxIterations = N + 3; // bound the loop; fail loudly if X never gets its event
    let iterations = 0;

    for (; iterations < maxIterations; iterations++) {
      const res = await router.dispatch({
        id: `B${iterations}`,
        method: 'events.poll',
        params: { workspaceId: X, max: 1, cursor },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) break;
      const result = res.result as {
        events: A2aTaskEvent[];
        nextCursor: number;
      };

      // (1) A foreign D→E event must NEVER be delivered to X.
      for (const e of result.events) {
        if (e.type === 'a2a.task') {
          expect(e.to).toBe(X);
          expect(e.taskId).toBe('addressed');
          sawAddressed = true;
        }
      }

      // (3) Cursor is strictly non-decreasing across polls — it never rewinds.
      expect(result.nextCursor).toBeGreaterThanOrEqual(prevCursor);
      prevCursor = result.nextCursor;

      // Termination guard against a stuck cursor: if the page is empty AND the
      // cursor stopped advancing, we have drained the ring — stop looping.
      if (result.events.length === 0 && result.nextCursor === cursor) {
        cursor = result.nextCursor;
        break;
      }
      cursor = result.nextCursor;
      if (sawAddressed) break; // (2) got it — no reason to keep paging
    }

    // (2) X eventually received its single addressed event...
    expect(sawAddressed).toBe(true);
    // (4) ...within the bound (the loop did not exhaust its iteration budget,
    // which would signal a stuck/rewinding cursor that never makes progress).
    expect(iterations).toBeLessThan(maxIterations);
  });

  // Test C — receiver delivery rides the dual-party `to` key, NOT an accidental
  // strict `workspaceId === to` match. The event's BASE workspaceId is stamped
  // === from, so a strict `workspaceId === caller` arm (the non-a2a path) would
  // NEVER match for the receiver. Asserting the delivered event's base
  // workspaceId is FROM (≠ TO, the caller) proves it arrived through the `to`
  // branch specifically — strengthening case 2, which checks `to === TO` but
  // not that the base workspaceId differs from the caller.
  it('case C: receiver gets the event via the dual-party `to` key (delivered base workspaceId === from, not the caller)', async () => {
    expect(
      publishA2aTask({ type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'submitted', kind: 'created' }),
    ).toBe(true);

    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: TO });
    const a2a = events.filter((e) => e.type === 'a2a.task') as A2aTaskEvent[];
    expect(a2a).toHaveLength(1);
    // The receiver (caller === TO) got it, but the base workspaceId is FROM —
    // a strict `workspaceId === caller` filter could not have matched it. The
    // ONLY path that delivers it is the dual-party `to === caller` arm.
    expect(a2a[0].workspaceId).toBe(FROM);
    expect(a2a[0].workspaceId).not.toBe(TO);
    expect(a2a[0].to).toBe(TO);
  });

  // Publish trust boundary: onEventsPublish (via buildA2aTaskEmitInput) rejects
  // an a2a.task with missing/empty from or to — NO ring entry is created.
  it('onEventsPublish rejects an a2a.task with missing/empty from or to (no ring entry)', async () => {
    // Missing `to`.
    expect(publishA2aTask({ type: 'a2a.task', from: FROM, taskId: 't1', state: 'submitted', kind: 'created' })).toBe(false);
    // Empty `to`.
    expect(publishA2aTask({ type: 'a2a.task', from: FROM, to: '', taskId: 't1', state: 'submitted', kind: 'created' })).toBe(false);
    // Missing `from`.
    expect(publishA2aTask({ type: 'a2a.task', to: TO, taskId: 't1', state: 'submitted', kind: 'created' })).toBe(false);
    // Empty `from`.
    expect(publishA2aTask({ type: 'a2a.task', from: '', to: TO, taskId: 't1', state: 'submitted', kind: 'created' })).toBe(false);
    // Missing taskId is also rejected (scope key must be well-formed).
    expect(publishA2aTask({ type: 'a2a.task', from: FROM, to: TO, state: 'submitted', kind: 'created' })).toBe(false);

    // The ring is empty — none of the rejected publishes created an entry.
    const router = setupRouter();
    const events = await pollEvents(router, { workspaceId: FROM });
    expect(events.filter((e) => e.type === 'a2a.task')).toHaveLength(0);

    // Sanity: a well-formed publish IS accepted and lands a ring entry. The
    // server-side stamp sets workspaceId === from regardless of any supplied
    // workspaceId (here a hostile renderer claims THIRD — it is ignored).
    expect(
      publishA2aTask({
        type: 'a2a.task', from: FROM, to: TO, taskId: 't1', state: 'submitted', kind: 'created',
        workspaceId: THIRD, // hostile override — must be ignored
        extraField: 'should-not-ride-through', // must not be spread onto the event
      }),
    ).toBe(true);
    const after = await pollEvents(setupRouter(), { workspaceId: FROM });
    const a2a = after.filter((e) => e.type === 'a2a.task');
    expect(a2a).toHaveLength(1);
    expect((a2a[0] as A2aTaskEvent).workspaceId).toBe(FROM); // stamped, not THIRD
    expect((a2a[0] as unknown as Record<string, unknown>)['extraField']).toBeUndefined();
  });
});

describe('events.rpc — notifications.read opt-in gate', () => {
  beforeEach(() => {
    eventBus.reset();
  });

  function emitMixed() {
    eventBus.emit({ type: 'pane.created', workspaceId: 'ws-1', paneId: 'p1' });
    eventBus.emit({
      type: 'notification.received', workspaceId: 'ws-1', ptyId: 't1',
      source: 'osc9', title: null, body: 'hello',
    });
  }

  function routerWithTrust(declared: string[] | undefined): RpcRouter {
    const router = new RpcRouter();
    registerEventsRpc(router, async (name) =>
      name === 'declared-plugin'
        ? {
            name, status: 'trusted' as const, firstSeen: 1, lastSeen: 1,
            ...(declared ? { declaredCapabilities: declared } : {}),
          }
        : undefined,
    );
    return router;
  }

  it('filters notification.received for a declared plugin without notifications.read', async () => {
    emitMixed();
    const router = routerWithTrust(['events.subscribe']);
    const res = await router.dispatch({
      id: 'n1', method: 'events.poll', params: {}, clientName: 'declared-plugin',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const result = res.result as { events: Array<{ type: string }> };
      expect(result.events.map((e) => e.type)).toEqual(['pane.created']);
    }
  });

  it('delivers notification.received when notifications.read is declared (bare or glob)', async () => {
    for (const cap of ['notifications.read', 'notifications.read:ws-*']) {
      eventBus.reset();
      emitMixed();
      const router = routerWithTrust(['events.subscribe', cap]);
      const res = await router.dispatch({
        id: 'n2', method: 'events.poll', params: {}, clientName: 'declared-plugin',
      });
      if (res.ok) {
        const result = res.result as { events: Array<{ type: string }> };
        expect(result.events.map((e) => e.type)).toEqual(['pane.created', 'notification.received']);
      }
    }
  });

  it('grandfathers callers without a declaration or without an identity envelope', async () => {
    emitMixed();
    const router = routerWithTrust(undefined);
    // Declared identity but no declaredCapabilities → grandfathered.
    const declared = await router.dispatch({
      id: 'n3', method: 'events.poll', params: {}, clientName: 'declared-plugin',
    });
    if (declared.ok) {
      expect((declared.result as { events: unknown[] }).events).toHaveLength(2);
    }
    // No clientName at all → grandfathered.
    const anonymous = await router.dispatch({ id: 'n4', method: 'events.poll', params: {} });
    if (anonymous.ok) {
      expect((anonymous.result as { events: unknown[] }).events).toHaveLength(2);
    }
  });

  it('an explicit notification.received types request returns nothing when unentitled', async () => {
    emitMixed();
    const router = routerWithTrust(['events.subscribe']);
    const res = await router.dispatch({
      id: 'n5', method: 'events.poll',
      params: { types: ['notification.received'] }, clientName: 'declared-plugin',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.result as { events: unknown[] }).events).toHaveLength(0);
    }
  });
});
