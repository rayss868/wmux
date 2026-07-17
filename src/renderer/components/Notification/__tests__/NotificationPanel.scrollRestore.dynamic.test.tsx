// @vitest-environment jsdom
//
// Dynamic interaction test for the notification panel scroll-position restore
// (cmux parity). The panel unmounts when hidden, so renderToStaticMarkup can't
// exercise the close→reopen lifecycle; this mounts the REAL store-wired
// <NotificationPanel/> and drives visibility toggles + scroll events.
//
// Behavior under test:
//   - Reopening the panel restores the scroll offset it had when closed.
//   - If new notifications arrived while the panel was closed, reopening
//     snaps to the top so the newest entries (list is newest-first) show.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import NotificationPanel, {
  panelScrollMemory,
  resolveRestoredScrollTop,
} from '../NotificationPanel';
import { useStore } from '../../../stores';
import type { Notification } from '../../../../shared/types';

const NOW = 1_700_000_000_000;

const mkNotif = (id: string, partial: Partial<Notification> = {}): Notification => ({
  id,
  workspaceId: partial.workspaceId ?? 'ws-1',
  type: partial.type ?? 'info',
  title: partial.title ?? `Notif ${id}`,
  body: partial.body ?? `body ${id}`,
  timestamp: partial.timestamp ?? NOW,
  read: partial.read ?? false,
  ...partial,
});

let container: HTMLDivElement;
let root: Root;

const listEl = (): HTMLDivElement | null =>
  container.querySelector('[data-notification-list]');

const flushRaf = async (): Promise<void> => {
  // The panel defers focus + scroll restore to requestAnimationFrame; two
  // frames give both queued callbacks time to land.
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
};

const setPanelVisible = (visible: boolean): void => {
  act(() => {
    useStore.setState((s) => {
      s.notificationPanelVisible = visible;
    });
  });
};

const scrollListTo = (top: number): void => {
  const el = listEl();
  if (!el) throw new Error('notification list not rendered');
  act(() => {
    el.scrollTop = top; // jsdom stores the value (no layout clamping)
    el.dispatchEvent(new Event('scroll'));
  });
};

beforeEach(() => {
  panelScrollMemory.scrollTop = 0;
  panelScrollMemory.newestId = null;
  useStore.setState((s) => {
    s.notifications = [
      mkNotif('n-old', { timestamp: NOW - 2000, read: true }),
      mkNotif('n-mid', { timestamp: NOW - 1000, read: true }),
      mkNotif('n-new', { timestamp: NOW, read: true }),
    ];
    s.notificationPanelVisible = false;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(NotificationPanel));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useStore.setState((s) => {
    s.notifications = [];
    s.notificationPanelVisible = false;
  });
});

describe('resolveRestoredScrollTop (pure)', () => {
  it('restores the saved offset when the newest notification is unchanged', () => {
    expect(
      resolveRestoredScrollTop({ scrollTop: 123, newestId: 'n-new' }, 'n-new'),
    ).toBe(123);
  });

  it('snaps to top when a newer notification arrived while closed', () => {
    expect(
      resolveRestoredScrollTop({ scrollTop: 123, newestId: 'n-new' }, 'n-newer'),
    ).toBe(0);
  });

  it('snaps to top when the list was cleared while closed', () => {
    expect(
      resolveRestoredScrollTop({ scrollTop: 123, newestId: 'n-new' }, null),
    ).toBe(0);
  });
});

describe('NotificationPanel scroll restore (jsdom)', () => {
  it('restores the scroll offset on reopen when nothing new arrived', async () => {
    setPanelVisible(true);
    await flushRaf();

    scrollListTo(240);
    setPanelVisible(false);
    expect(listEl()).toBeNull(); // panel fully unmounts when hidden

    setPanelVisible(true);
    await flushRaf();

    expect(listEl()?.scrollTop).toBe(240);
  });

  it('snaps to top on reopen when a new notification arrived while closed', async () => {
    setPanelVisible(true);
    await flushRaf();

    scrollListTo(240);
    setPanelVisible(false);

    act(() => {
      useStore.setState((s) => {
        s.notifications.push(mkNotif('n-fresh', { timestamp: NOW + 1000 }));
      });
    });

    setPanelVisible(true);
    await flushRaf();

    expect(listEl()?.scrollTop).toBe(0);
    // Memory is re-anchored so a scroll-less close→reopen stays at top
    // instead of resurrecting the stale pre-snap offset.
    expect(panelScrollMemory.scrollTop).toBe(0);
    expect(panelScrollMemory.newestId).toBe('n-fresh');
  });

  it('does NOT snap to top for notifications that arrive while the panel is open', async () => {
    setPanelVisible(true);
    await flushRaf();

    scrollListTo(150);
    act(() => {
      useStore.setState((s) => {
        s.notifications.push(mkNotif('n-live', { timestamp: NOW + 500 }));
      });
    });
    setPanelVisible(false);

    setPanelVisible(true);
    await flushRaf();

    // The arrival was observed while open, so reopen restores the offset.
    expect(listEl()?.scrollTop).toBe(150);
  });
});
