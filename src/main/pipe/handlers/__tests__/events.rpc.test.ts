import { beforeEach, describe, expect, it } from 'vitest';
import { RpcRouter } from '../../RpcRouter';
import { registerEventsRpc } from '../events.rpc';
import { eventBus } from '../../../events/EventBus';

function setupRouter(): RpcRouter {
  const router = new RpcRouter();
  registerEventsRpc(router);
  return router;
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
