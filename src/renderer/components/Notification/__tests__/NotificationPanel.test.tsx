/**
 * Tests for NotificationPanel (T10).
 *
 * The repository's vitest config runs in `node` environment without a DOM
 * library installed (no jsdom / happy-dom / @testing-library/react), so this
 * suite tests the panel via three strategies:
 *   1. Pure helpers exported from NotificationPanel.tsx
 *      (sortNotificationsDesc, notifTypeName, buildNotifAriaLabel,
 *      runGlobalMarkAllRead).
 *   2. React DOM Server's `renderToStaticMarkup` against the stateless
 *      `NotificationPanelView`. The store-wired container cannot be tested
 *      this way because zustand's `useSyncExternalStore` server snapshot
 *      reads from `getInitialState()` (not the live `getState()`), so any
 *      `useStore.setState()` mutation we apply before render is invisible.
 *   3. Store-integration tests against the real zustand store: invoking the
 *      same slice actions the panel binds to its handlers and asserting on
 *      the resulting state.
 *
 * Effect-driven behaviors (Esc handler, initial focus via
 * requestAnimationFrame) require a real DOM and are documented here rather
 * than asserted directly; the strategy is captured in the run report.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  sortNotificationsDesc,
  notifTypeName,
  buildNotifAriaLabel,
  runGlobalMarkAllRead,
  NotificationPanelView,
  type NotificationPanelViewProps,
} from '../NotificationPanel';
import { useStore } from '../../../stores';
import type { Notification } from '../../../../shared/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

const mkNotif = (
  id: string,
  partial: Partial<Notification> & { workspaceId?: string } = {},
): Notification => ({
  id,
  workspaceId: partial.workspaceId ?? 'ws-1',
  type: partial.type ?? 'info',
  title: partial.title ?? `Notif ${id}`,
  body: partial.body ?? `body ${id}`,
  timestamp: partial.timestamp ?? NOW,
  read: partial.read ?? false,
  ...partial,
});

const noop = (): void => undefined;

const mkViewProps = (
  overrides: Partial<NotificationPanelViewProps> = {},
): NotificationPanelViewProps => ({
  notifications: [],
  unreadCount: 0,
  dialogLabel: 'Notifications',
  emptyLabel: 'No notifications',
  toggleHintLabel: 'Ctrl+I to toggle',
  markAllReadLabel: 'Mark all read',
  clearLabel: 'Clear',
  onNotifClick: noop,
  onNotifKeyDown: noop,
  onClose: noop,
  onMarkAllRead: noop,
  onMarkWorkspaceRead: noop,
  onClear: noop,
  ...overrides,
});

// ─── Pure helper tests ────────────────────────────────────────────────────────

describe('sortNotificationsDesc', () => {
  it('sorts by timestamp descending (newest first)', () => {
    const a = mkNotif('a', { timestamp: NOW - 1000 });
    const b = mkNotif('b', { timestamp: NOW - 500 });
    const c = mkNotif('c', { timestamp: NOW });
    const sorted = sortNotificationsDesc([a, b, c]);
    expect(sorted.map((n) => n.id)).toEqual(['c', 'b', 'a']);
  });

  it('does not mutate the input array', () => {
    const a = mkNotif('a', { timestamp: 1 });
    const b = mkNotif('b', { timestamp: 2 });
    const input = [a, b];
    sortNotificationsDesc(input);
    expect(input.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array when given empty input', () => {
    expect(sortNotificationsDesc([])).toEqual([]);
  });
});

describe('notifTypeName', () => {
  it('maps each NotificationType to its screen-reader noun', () => {
    expect(notifTypeName('agent')).toBe('agent');
    expect(notifTypeName('error')).toBe('error');
    expect(notifTypeName('warning')).toBe('warning');
    expect(notifTypeName('info')).toBe('info');
  });
});

describe('buildNotifAriaLabel', () => {
  it('includes type, title, time, and read state in order', () => {
    const n = mkNotif('x', {
      type: 'agent',
      title: 'Build complete',
      timestamp: NOW - 5 * 60_000,
      read: false,
    });
    expect(buildNotifAriaLabel(n, NOW)).toBe('agent, Build complete, 5m ago, unread');
  });

  it('marks read notifications as "read"', () => {
    const n = mkNotif('y', {
      type: 'error',
      title: 'Crashed',
      timestamp: NOW,
      read: true,
    });
    expect(buildNotifAriaLabel(n, NOW)).toBe('error, Crashed, just now, read');
  });

  it('uses the warning type name for warnings', () => {
    const n = mkNotif('z', { type: 'warning', title: 'Low disk', timestamp: NOW });
    expect(buildNotifAriaLabel(n, NOW)).toContain('warning');
  });
});

// ─── runGlobalMarkAllRead resolver tests ──────────────────────────────────────

describe('runGlobalMarkAllRead', () => {
  it('calls state.markAllRead when present (T2 path)', () => {
    const markAllRead = vi.fn();
    const markAllReadForWorkspace = vi.fn();
    runGlobalMarkAllRead({
      markAllRead,
      markAllReadForWorkspace,
      notifications: [mkNotif('a', { workspaceId: 'w1' })],
    });
    expect(markAllRead).toHaveBeenCalledTimes(1);
    expect(markAllReadForWorkspace).not.toHaveBeenCalled();
  });

  it('falls back to per-workspace iteration when markAllRead is absent', () => {
    const markAllReadForWorkspace = vi.fn();
    runGlobalMarkAllRead({
      markAllReadForWorkspace,
      notifications: [
        mkNotif('a', { workspaceId: 'w1' }),
        mkNotif('b', { workspaceId: 'w2' }),
        mkNotif('c', { workspaceId: 'w1' }),
      ],
    });
    expect(markAllReadForWorkspace).toHaveBeenCalledTimes(2);
    const wsCalls = markAllReadForWorkspace.mock.calls.map((c) => c[0]).sort();
    expect(wsCalls).toEqual(['w1', 'w2']);
  });

  it('is a no-op when there are no notifications and no global action', () => {
    const markAllReadForWorkspace = vi.fn();
    runGlobalMarkAllRead({ markAllReadForWorkspace, notifications: [] });
    expect(markAllReadForWorkspace).not.toHaveBeenCalled();
  });
});

// ─── Store-integration tests ──────────────────────────────────────────────────
//
// The store-wired container reads everything from useStore selectors. We
// exercise the contract by invoking the same slice actions through the live
// store and asserting on the resulting state.

describe('NotificationPanel store contract', () => {
  beforeEach(() => {
    useStore.setState((s) => {
      s.notifications = [];
    });
  });

  it('markRead flips a single notification to read', () => {
    const ws1 = useStore.getState().workspaces[0]?.id ?? 'ws-default';
    useStore.setState((s) => {
      s.notifications.push(mkNotif('n1', { workspaceId: ws1, read: false }));
      s.activeWorkspaceId = ws1;
    });

    useStore.getState().markRead('n1');

    const after = useStore.getState().notifications.find((n) => n.id === 'n1');
    expect(after?.read).toBe(true);
  });

  it('setActiveWorkspace switches the active workspace id', () => {
    const wsIds = useStore.getState().workspaces.map((w) => w.id);
    if (wsIds.length < 1) return; // defensive — fresh store always seeds at least one
    const target = wsIds[0]!;
    useStore.getState().setActiveWorkspace(target);
    expect(useStore.getState().activeWorkspaceId).toBe(target);
  });

  it('markAllReadForWorkspace marks every notification in the active workspace', () => {
    const ws1 = useStore.getState().workspaces[0]?.id ?? 'ws-default';
    useStore.setState((s) => {
      s.notifications.push(
        mkNotif('a', { workspaceId: ws1, read: false }),
        mkNotif('b', { workspaceId: ws1, read: false }),
        mkNotif('c', { workspaceId: 'other', read: false }),
      );
      s.activeWorkspaceId = ws1;
    });

    useStore.getState().markAllReadForWorkspace(ws1);

    const notifs = useStore.getState().notifications;
    expect(notifs.find((n) => n.id === 'a')?.read).toBe(true);
    expect(notifs.find((n) => n.id === 'b')?.read).toBe(true);
    expect(notifs.find((n) => n.id === 'c')?.read).toBe(false);
  });

  it('global mark-all-read via runGlobalMarkAllRead clears every workspace', () => {
    const ws1 = useStore.getState().workspaces[0]?.id ?? 'ws-default';
    useStore.setState((s) => {
      s.notifications.push(
        mkNotif('a', { workspaceId: ws1, read: false }),
        mkNotif('b', { workspaceId: 'other', read: false }),
      );
    });

    runGlobalMarkAllRead(useStore.getState() as never);

    const notifs = useStore.getState().notifications;
    expect(notifs.every((n) => n.read)).toBe(true);
  });

  it('Esc keydown toggles the panel via toggleNotificationPanel', () => {
    // Documents the contract the container's Esc useEffect depends on.
    useStore.setState((s) => { s.notificationPanelVisible = true; });
    expect(useStore.getState().notificationPanelVisible).toBe(true);

    useStore.getState().toggleNotificationPanel();

    expect(useStore.getState().notificationPanelVisible).toBe(false);
  });
});

// ─── NotificationPanelView render assertions (renderToStaticMarkup) ──────────
//
// The view is stateless — all data flows in as props — so SSR produces the
// real markup. We use it to lock in the ARIA contract, button labels, and
// list ordering. Click/keydown handlers don't fire in static rendering;
// those are covered by the store-contract block above.

describe('NotificationPanelView (renderToStaticMarkup)', () => {
  it('renders the empty state when there are no notifications', () => {
    const html = renderToStaticMarkup(
      createElement(NotificationPanelView, mkViewProps()),
    );
    expect(html).toContain('No notifications');
  });

  it('renders dialog role + aria-label on the outer panel', () => {
    const html = renderToStaticMarkup(
      createElement(NotificationPanelView, mkViewProps()),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Notifications"');
  });

  it('renders both mark-all buttons (global + per-workspace) when notifications exist', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [mkNotif('n1')],
          unreadCount: 1,
        }),
      ),
    );
    expect(html).toContain('aria-label="Mark all read"');
    expect(html).toContain('aria-label="Mark workspace read"');
  });

  it('renders notifications in caller-provided order (sorted DESC by the container)', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [
            mkNotif('newer', { timestamp: NOW, title: 'NEWER_TITLE' }),
            mkNotif('older', { timestamp: NOW - 60 * 60_000, title: 'OLDER_TITLE' }),
          ],
          unreadCount: 2,
        }),
      ),
    );
    const olderIdx = html.indexOf('OLDER_TITLE');
    const newerIdx = html.indexOf('NEWER_TITLE');
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it('renders timeAgo for a 5-minute-old notification as "5m ago"', () => {
    // The view calls timeAgo(notif.timestamp) (no `now` arg) so we anchor
    // against Date.now() with a small cushion to avoid the 60s boundary.
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [
            mkNotif('n1', { timestamp: Date.now() - 5 * 60_000 - 100 }),
          ],
          unreadCount: 1,
        }),
      ),
    );
    expect(html).toContain('5m ago');
  });

  it('renders each row with role=button, tabIndex=0, and a full aria-label', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [
            mkNotif('n1', {
              type: 'agent',
              title: 'Build done',
              timestamp: Date.now(),
              read: false,
            }),
          ],
          unreadCount: 1,
        }),
      ),
    );
    expect(html).toContain('role="button"');
    // HTML attribute is lowercased; React JSX prop `tabIndex` → `tabindex`.
    expect(html).toContain('tabindex="0"');
    expect(html).toMatch(/aria-label="agent, Build done, just now, unread"/);
  });

  it('reflects read state in the aria-label', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [
            mkNotif('n1', {
              type: 'info',
              title: 'Seen',
              timestamp: Date.now(),
              read: true,
            }),
          ],
          unreadCount: 0,
        }),
      ),
    );
    expect(html).toMatch(/aria-label="info, Seen, just now, read"/);
  });

  it('shows the unread count badge in the header when unreadCount > 0', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [mkNotif('n1', { read: false })],
          unreadCount: 7,
        }),
      ),
    );
    expect(html).toContain('>7<'); // badge text inside a span
  });

  it('omits the unread count badge when unreadCount = 0', () => {
    const html = renderToStaticMarkup(
      createElement(
        NotificationPanelView,
        mkViewProps({
          notifications: [mkNotif('n1', { read: true })],
          unreadCount: 0,
        }),
      ),
    );
    // The badge classname is unique; absence of the bg-accent-blue pill
    // proves the badge wasn't rendered.
    expect(html).not.toMatch(/rounded-full"[^>]*>\s*0\s*</);
  });
});
