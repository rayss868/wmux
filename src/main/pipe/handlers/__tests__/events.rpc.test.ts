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
});
