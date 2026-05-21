import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { timeAgo } from '../../utils/timeAgo';
import type { Notification, NotificationType } from '../../../shared/types';

// ─── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Sort notifications by timestamp DESC (newest first). Pure for tests.
 */
export function sortNotificationsDesc(notifications: Notification[]): Notification[] {
  return [...notifications].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Map a NotificationType to a screen-reader friendly noun.
 * Kept as literal English; no i18n keys exist yet for these (DESIGN D5 + scope hygiene).
 */
export function notifTypeName(type: NotificationType): string {
  switch (type) {
    case 'agent': return 'agent';
    case 'error': return 'error';
    case 'warning': return 'warning';
    default: return 'info';
  }
}

/**
 * Build the screen-reader announce string for a notification row.
 * Shape: "{typeName}, {title}, {timeAgo}, {read|unread}"
 */
export function buildNotifAriaLabel(notif: Notification, now: number = Date.now()): string {
  const typeName = notifTypeName(notif.type);
  const rel = timeAgo(notif.timestamp, now);
  const state = notif.read ? 'read' : 'unread';
  return `${typeName}, ${notif.title}, ${rel}, ${state}`;
}

/**
 * Resolve a global mark-all-read action. T2 introduces a top-level
 * `markAllRead` slice action; until that lands, fall back to iterating every
 * workspace and calling the per-workspace action. Either way, every loaded
 * notification ends up read.
 */
type MarkAllReadResolver = {
  markAllRead?: () => void;
  markAllReadForWorkspace: (workspaceId: string) => void;
  notifications: Notification[];
};
export function runGlobalMarkAllRead(state: MarkAllReadResolver): void {
  if (typeof state.markAllRead === 'function') {
    state.markAllRead();
    return;
  }
  const wsIds = new Set<string>();
  for (const n of state.notifications) wsIds.add(n.workspaceId);
  for (const id of wsIds) state.markAllReadForWorkspace(id);
}

/**
 * Emoji icon for a notification type. NOT updated as part of T10 (DESIGN D9
 * scope hygiene); kept here so the view function stays pure and renderable.
 */
function typeIcon(type: string): string {
  switch (type) {
    case 'agent': return '🤖';
    case 'error': return '❌';
    case 'warning': return '⚠️';
    default: return 'ℹ️';
  }
}

// ─── Pure view (exported for tests) ───────────────────────────────────────────

export interface NotificationPanelViewProps {
  notifications: Notification[];     // pre-sorted (DESC) by caller
  unreadCount: number;
  dialogLabel: string;               // t('notification.title') equivalent
  emptyLabel: string;                // t('notification.empty')
  toggleHintLabel: string;           // t('notification.toggle')
  markAllReadLabel: string;          // t('notification.markAllRead')
  clearLabel: string;                // t('notification.clear')
  onNotifClick: (notif: Notification) => void;
  onNotifKeyDown: (e: React.KeyboardEvent, notif: Notification) => void;
  onClose: () => void;
  onMarkAllRead: () => void;         // global
  onMarkWorkspaceRead: () => void;   // active workspace only
  onClear: () => void;
  firstUnreadRef?: React.Ref<HTMLDivElement>;
  markAllReadBtnRef?: React.Ref<HTMLButtonElement>;
}

/**
 * Stateless presentation. Receives all data + handlers via props.
 * Safe to renderToStaticMarkup without any store wiring.
 */
export function NotificationPanelView(props: NotificationPanelViewProps): ReactElement {
  const {
    notifications, unreadCount, dialogLabel, emptyLabel, toggleHintLabel,
    markAllReadLabel, clearLabel,
    onNotifClick, onNotifKeyDown, onClose,
    onMarkAllRead, onMarkWorkspaceRead, onClear,
    firstUnreadRef, markAllReadBtnRef,
  } = props;

  const firstUnreadIdx = notifications.findIndex((n) => !n.read);

  return (
    <div
      role="dialog"
      aria-label={dialogLabel}
      className="fixed right-0 top-0 h-full w-80 bg-[var(--bg-mantle)] border-l border-[var(--bg-surface)] z-50 flex flex-col shadow-2xl notification-panel-enter"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--bg-surface)]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[var(--text-main)]">{dialogLabel}</span>
          {unreadCount > 0 && (
            <span className="bg-[var(--accent-blue)] text-[var(--bg-base)] text-[10px] font-bold px-1.5 py-0.5 rounded-full">
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {notifications.length > 0 && (
            <>
              {/* Global mark-all-read (T2). Placed FIRST per plan. */}
              <button
                ref={markAllReadBtnRef}
                className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors"
                onClick={onMarkAllRead}
                aria-label="Mark all read"
              >
                {markAllReadLabel}
              </button>
              {/* Per-workspace mark-all-read (legacy behavior). */}
              <button
                className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors"
                onClick={onMarkWorkspaceRead}
                aria-label="Mark workspace read"
              >
                Mark workspace read
              </button>
              <button
                className="text-[10px] text-[var(--text-subtle)] hover:text-[var(--accent-red)] transition-colors"
                onClick={onClear}
              >
                {clearLabel}
              </button>
            </>
          )}
          <button
            className="text-[var(--text-subtle)] hover:text-[var(--text-main)] text-sm transition-colors"
            onClick={onClose}
            aria-label="Close notifications"
          >
            ✕
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
            {emptyLabel}
          </div>
        ) : (
          notifications.map((notif, idx) => (
            <div
              key={notif.id}
              ref={idx === firstUnreadIdx ? firstUnreadRef : undefined}
              role="button"
              tabIndex={0}
              aria-label={buildNotifAriaLabel(notif)}
              className={`px-4 py-3 border-b border-[rgba(var(--bg-surface-rgb),0.5)] cursor-pointer hover:bg-[rgba(var(--bg-surface-rgb),0.3)] transition-colors ${
                notif.read ? 'opacity-60' : ''
              }`}
              onClick={() => onNotifClick(notif)}
              onKeyDown={(e) => onNotifKeyDown(e, notif)}
            >
              <div className="flex items-start gap-2">
                <span className="text-xs mt-0.5">{typeIcon(notif.type)}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-medium truncate ${notif.read ? 'text-[var(--text-subtle)]' : 'text-[var(--text-main)]'}`}>
                      {notif.title}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 ml-2">
                      {timeAgo(notif.timestamp)}
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--text-sub2)] mt-0.5 truncate">{notif.body}</p>
                </div>
                {!notif.read && (
                  <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-blue)] mt-1.5 flex-shrink-0" />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-[var(--bg-surface)] text-[10px] text-[var(--text-muted)]">
        {toggleHintLabel}
      </div>
    </div>
  );
}

// ─── Container (store-wired) ──────────────────────────────────────────────────

export default function NotificationPanel() {
  const t = useT();
  const notifications = useStore((s) => s.notifications);
  const notificationPanelVisible = useStore((s) => s.notificationPanelVisible);
  const toggleNotificationPanel = useStore((s) => s.toggleNotificationPanel);
  const markRead = useStore((s) => s.markRead);
  const markAllReadForWorkspace = useStore((s) => s.markAllReadForWorkspace);
  const clearNotifications = useStore((s) => s.clearNotifications);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);

  const firstUnreadRef = useRef<HTMLDivElement>(null);
  const markAllReadBtnRef = useRef<HTMLButtonElement>(null);

  const sorted = useMemo(() => sortNotificationsDesc(notifications), [notifications]);
  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  // ─── Esc to close ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!notificationPanelVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleNotificationPanel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [notificationPanelVisible, toggleNotificationPanel]);

  // ─── Initial focus: first unread, else markAllRead button (D5) ─────────────
  // Defer with requestAnimationFrame so the enter animation has flipped the
  // panel into the visible DOM tree before we move focus.
  useEffect(() => {
    if (!notificationPanelVisible) return;
    const raf = requestAnimationFrame(() => {
      if (firstUnreadRef.current) {
        firstUnreadRef.current.focus();
      } else if (markAllReadBtnRef.current) {
        markAllReadBtnRef.current.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [notificationPanelVisible]);

  if (!notificationPanelVisible) return null;

  const handleNotifClick = (notif: Notification) => {
    markRead(notif.id);
    if (notif.workspaceId !== activeWorkspaceId) {
      setActiveWorkspace(notif.workspaceId);
    }
  };

  const handleNotifKey = (e: React.KeyboardEvent, notif: Notification) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleNotifClick(notif);
    }
  };

  const handleGlobalMarkAllRead = () => {
    // Resolve at click time so we pick up T2's slice action if/when it lands
    // without breaking when it hasn't. See runGlobalMarkAllRead for the
    // resolver contract — the action is invoked through the live store state.
    runGlobalMarkAllRead(useStore.getState() as unknown as MarkAllReadResolver);
  };

  return (
    <NotificationPanelView
      notifications={sorted}
      unreadCount={unreadCount}
      dialogLabel={t('notification.title')}
      emptyLabel={t('notification.empty')}
      toggleHintLabel={t('notification.toggle')}
      markAllReadLabel={t('notification.markAllRead')}
      clearLabel={t('notification.clear')}
      onNotifClick={handleNotifClick}
      onNotifKeyDown={handleNotifKey}
      onClose={toggleNotificationPanel}
      onMarkAllRead={handleGlobalMarkAllRead}
      onMarkWorkspaceRead={() => markAllReadForWorkspace(activeWorkspaceId)}
      onClear={clearNotifications}
      firstUnreadRef={firstUnreadRef}
      markAllReadBtnRef={markAllReadBtnRef}
    />
  );
}
