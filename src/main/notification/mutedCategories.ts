import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '../../shared/types';

/**
 * Main-side mirror of the renderer's muted notification categories (#516).
 *
 * The category mute lives in the renderer store, and the notification policy
 * that enforces it (useNotificationPolicy) runs there too — which is fine for
 * every notification that reaches a live renderer. It is NOT fine for the
 * `dispatchNotification` fallback: with no window, or a window whose listener
 * hasn't confirmed it's subscribed, main shows a direct OS toast without ever
 * consulting the renderer. That is exactly the situation (app in the tray,
 * mid-reload) where an unwanted banner is most annoying.
 *
 * So the renderer mirrors the set over IPC.MUTED_NOTIFICATION_CATEGORIES —
 * the same shape `toastEnabled` has always used via IPC.TOAST_ENABLED — on
 * session load and on every toggle. Values are whitelisted here because this
 * crosses an IPC boundary: a compromised or buggy renderer must not be able
 * to park arbitrary strings in main's state.
 *
 * Default: nothing muted. If the renderer never reports (crash before load),
 * the fallback stays as loud as it was before this feature — failing open is
 * correct for a notification the user might be waiting on.
 */
let muted: ReadonlySet<NotificationCategory> = new Set();

export function setMutedNotificationCategories(categories: unknown): void {
  if (!Array.isArray(categories)) return;
  muted = new Set(
    categories.filter((c): c is NotificationCategory =>
      typeof c === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(c),
    ),
  );
}

/**
 * True when this notification's category is muted. Uncategorized
 * notifications (category undefined) are never muted — a mute must not
 * silence an event we couldn't classify.
 */
export function isCategoryMuted(category: NotificationCategory | undefined): boolean {
  return category !== undefined && muted.has(category);
}
