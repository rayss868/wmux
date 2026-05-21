import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createNotificationSlice, type NotificationSlice } from '../notificationSlice';
import type { Workspace, Pane } from '../../../../shared/types';

// Test store mirrors uiSlice.test.ts pattern: minimal slice + cross-slice
// fields seeded via setState. notificationSlice reads state.workspaces, so we
// expose it on the test type without composing the full workspaceSlice.
type TestState = NotificationSlice & {
  workspaces: Workspace[];
};

function makePane(id = 'pane-1'): Pane {
  return {
    id,
    type: 'leaf',
    surfaces: [],
    activeSurfaceId: '',
  };
}

function makeWorkspace(id: string, name = id): Workspace {
  return {
    id,
    name,
    rootPane: makePane(`${id}-root`),
    activePaneId: `${id}-root`,
  };
}

function createTestStore(workspaces: Workspace[] = []) {
  const store = create<TestState>()(
    immer((...args) => ({
      workspaces,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createNotificationSlice(...args),
    }))
  );
  return store;
}

// ─── REGRESSION: existing behavior locked down before extension ──────────

describe('NotificationSlice — addNotification (regression)', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore([makeWorkspace('ws-a')]);
  });

  // R1
  it('pushes a notification with generated id, timestamp, and read=false', () => {
    const before = Date.now();
    store.getState().addNotification({
      workspaceId: 'ws-a',
      type: 'info',
      title: 'hello',
      body: 'world',
    });
    const after = Date.now();

    const list = store.getState().notifications;
    expect(list).toHaveLength(1);
    const n = list[0];
    expect(n.id).toMatch(/^notif-/);
    expect(n.read).toBe(false);
    expect(n.timestamp).toBeGreaterThanOrEqual(before);
    expect(n.timestamp).toBeLessThanOrEqual(after);
    expect(n.title).toBe('hello');
    expect(n.body).toBe('world');
    expect(n.type).toBe('info');
    expect(n.workspaceId).toBe('ws-a');
  });

  // R2
  it('sets lastNotification on the matching workspace metadata', () => {
    const before = Date.now();
    store.getState().addNotification({
      workspaceId: 'ws-a',
      type: 'info',
      title: 't',
      body: 'b',
    });
    const ws = store.getState().workspaces.find((w) => w.id === 'ws-a');
    expect(ws?.metadata?.lastNotification).toBeGreaterThanOrEqual(before);
  });

  // R3
  it('is a no-op for workspace lookup when workspaceId is unknown (no throw)', () => {
    expect(() =>
      store.getState().addNotification({
        workspaceId: 'ws-missing',
        type: 'info',
        title: 't',
        body: 'b',
      })
    ).not.toThrow();
    // The notification itself is still appended; only the workspace metadata
    // update is skipped because the workspace doesn't exist.
    expect(store.getState().notifications).toHaveLength(1);
    expect(store.getState().workspaces).toHaveLength(1);
    expect(store.getState().workspaces[0].metadata?.lastNotification).toBeUndefined();
  });
});

describe('NotificationSlice — cap eviction (regression)', () => {
  // R4: cap eviction — push 500 with mix → 501st evicts OLDEST READ entry.
  it('evicts the oldest read entry when capacity exceeds 500', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);

    // Seed 500 unread, then mark entries at index 100 and 200 as read.
    for (let i = 0; i < 500; i++) {
      store.getState().addNotification({
        workspaceId: 'ws-a',
        type: 'info',
        title: `t${i}`,
        body: `b${i}`,
      });
    }
    expect(store.getState().notifications).toHaveLength(500);

    const idAt100 = store.getState().notifications[100].id;
    const idAt200 = store.getState().notifications[200].id;
    store.getState().markRead(idAt100);
    store.getState().markRead(idAt200);

    // Push the 501st — eviction should drop idAt100 (oldest read).
    store.getState().addNotification({
      workspaceId: 'ws-a',
      type: 'info',
      title: 'overflow',
      body: 'evict me',
    });

    const list = store.getState().notifications;
    expect(list).toHaveLength(500);
    expect(list.find((n) => n.id === idAt100)).toBeUndefined();
    // The other read entry survives.
    expect(list.find((n) => n.id === idAt200)).toBeDefined();
  });

  // R5: all unread → 501st falls back to shift() (oldest first).
  it('falls back to shifting the oldest entry when all are unread', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);

    for (let i = 0; i < 500; i++) {
      store.getState().addNotification({
        workspaceId: 'ws-a',
        type: 'info',
        title: `t${i}`,
        body: `b${i}`,
      });
    }
    const oldestId = store.getState().notifications[0].id;
    const secondId = store.getState().notifications[1].id;

    store.getState().addNotification({
      workspaceId: 'ws-a',
      type: 'info',
      title: 'overflow',
      body: 'evict oldest',
    });

    const list = store.getState().notifications;
    expect(list).toHaveLength(500);
    expect(list.find((n) => n.id === oldestId)).toBeUndefined();
    // What was previously the second-oldest is now at index 0.
    expect(list[0].id).toBe(secondId);
  });
});

describe('NotificationSlice — markRead (regression)', () => {
  // R6
  it('flips read=true for the matched id and is a no-op for missing ids', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.getState().addNotification({
      workspaceId: 'ws-a', type: 'info', title: 'a', body: 'a',
    });
    store.getState().addNotification({
      workspaceId: 'ws-a', type: 'info', title: 'b', body: 'b',
    });
    const [first, second] = store.getState().notifications;

    store.getState().markRead(first.id);
    const after = store.getState().notifications;
    expect(after.find((n) => n.id === first.id)?.read).toBe(true);
    expect(after.find((n) => n.id === second.id)?.read).toBe(false);

    expect(() => store.getState().markRead('notif-does-not-exist')).not.toThrow();
    const final = store.getState().notifications;
    expect(final.find((n) => n.id === first.id)?.read).toBe(true);
    expect(final.find((n) => n.id === second.id)?.read).toBe(false);
  });
});

describe('NotificationSlice — markAllReadForWorkspace (regression)', () => {
  // R7
  it('flips read=true only for notifications matching the given workspaceId', () => {
    const store = createTestStore([makeWorkspace('ws-a'), makeWorkspace('ws-b')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a1', body: '' });
    store.getState().addNotification({ workspaceId: 'ws-b', type: 'info', title: 'b1', body: '' });
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a2', body: '' });

    store.getState().markAllReadForWorkspace('ws-a');

    const list = store.getState().notifications;
    expect(list.filter((n) => n.workspaceId === 'ws-a').every((n) => n.read)).toBe(true);
    expect(list.filter((n) => n.workspaceId === 'ws-b').every((n) => !n.read)).toBe(true);
  });
});

describe('NotificationSlice — clearNotifications (regression)', () => {
  // R8
  it('empties the notifications array', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a', body: '' });
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'b', body: '' });
    expect(store.getState().notifications).toHaveLength(2);

    store.getState().clearNotifications();
    expect(store.getState().notifications).toEqual([]);
  });
});

// ─── NEW BEHAVIOR ────────────────────────────────────────────────────────

describe('NotificationSlice — markAllRead (new)', () => {
  // N1
  it('flips read=true on every notification regardless of workspaceId', () => {
    const store = createTestStore([makeWorkspace('ws-a'), makeWorkspace('ws-b')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a', body: '' });
    store.getState().addNotification({ workspaceId: 'ws-b', type: 'info', title: 'b', body: '' });
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'warning', title: 'c', body: '' });

    store.getState().markAllRead();

    expect(store.getState().notifications.every((n) => n.read)).toBe(true);
  });

  // N2
  it('is idempotent on already-read items', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a', body: '' });
    store.getState().markAllRead();
    expect(store.getState().notifications.every((n) => n.read)).toBe(true);

    // Second call must not throw and must leave the state still all-read.
    store.getState().markAllRead();
    expect(store.getState().notifications.every((n) => n.read)).toBe(true);
    expect(store.getState().notifications).toHaveLength(1);
  });
});

describe('NotificationSlice — jumpToUnread (new)', () => {
  // N3
  it('returns the workspaceId of the most-recent unread notification', () => {
    const store = createTestStore([makeWorkspace('ws-a'), makeWorkspace('ws-b')]);
    // Seed three with explicit timestamps so we control ordering.
    store.setState((s) => {
      s.notifications = [
        { id: 'n1', workspaceId: 'ws-a', type: 'info', title: 'a', body: '', timestamp: 100, read: false },
        { id: 'n2', workspaceId: 'ws-b', type: 'info', title: 'b', body: '', timestamp: 300, read: false },
        { id: 'n3', workspaceId: 'ws-a', type: 'info', title: 'c', body: '', timestamp: 200, read: false },
      ];
    });

    expect(store.getState().jumpToUnread()).toBe('ws-b');
    // Selector must not mutate state.
    expect(store.getState().notifications.every((n) => !n.read)).toBe(true);
  });

  // N4
  it('returns null when no unread notifications exist', () => {
    const store = createTestStore([makeWorkspace('ws-a')]);
    expect(store.getState().jumpToUnread()).toBeNull();

    store.getState().addNotification({ workspaceId: 'ws-a', type: 'info', title: 'a', body: '' });
    store.getState().markAllRead();
    expect(store.getState().jumpToUnread()).toBeNull();
  });

  // N5
  it('skips notifications whose workspace was deleted from state.workspaces', () => {
    // ws-a exists, ws-gone does not. The newer unread points at ws-gone and
    // must be ignored; jumpToUnread should fall back to the ws-a entry.
    const store = createTestStore([makeWorkspace('ws-a')]);
    store.setState((s) => {
      s.notifications = [
        { id: 'n1', workspaceId: 'ws-a', type: 'info', title: 'a', body: '', timestamp: 100, read: false },
        { id: 'n2', workspaceId: 'ws-gone', type: 'info', title: 'g', body: '', timestamp: 500, read: false },
      ];
    });

    expect(store.getState().jumpToUnread()).toBe('ws-a');

    // If every unread entry points at a dead workspace, the selector returns null.
    store.setState((s) => {
      s.notifications = [
        { id: 'n3', workspaceId: 'ws-gone', type: 'info', title: 'g', body: '', timestamp: 500, read: false },
      ];
    });
    expect(store.getState().jumpToUnread()).toBeNull();
  });

  // N6
  it('breaks ties by highest timestamp — most-recent wins', () => {
    const store = createTestStore([makeWorkspace('ws-a'), makeWorkspace('ws-b'), makeWorkspace('ws-c')]);
    store.setState((s) => {
      s.notifications = [
        { id: 'n1', workspaceId: 'ws-a', type: 'info', title: '', body: '', timestamp: 999, read: false },
        { id: 'n2', workspaceId: 'ws-b', type: 'info', title: '', body: '', timestamp: 1000, read: false },
        { id: 'n3', workspaceId: 'ws-c', type: 'info', title: '', body: '', timestamp: 1001, read: false },
        { id: 'n4', workspaceId: 'ws-a', type: 'info', title: '', body: '', timestamp: 998, read: false },
      ];
    });

    expect(store.getState().jumpToUnread()).toBe('ws-c');
  });
});
