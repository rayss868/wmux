import type { BrowserWindow } from 'electron';
import { sendNotification, type NotificationPayload } from './sendNotification';
import { toastManager, type ToastFocusContext } from './ToastManager';
import { isRendererNotificationListenerReady } from './rendererNotificationReadiness';
import { isCategoryMuted } from './mutedCategories';

/**
 * Single entry point for "surface a notification to the user".
 *
 * Before this helper, every emitter (detector paths in PTYBridge /
 * DaemonNotificationRouter, OSC 9/777/99, supervision events, notify RPC,
 * hook signals) hand-rolled a `sendNotification(...)` + `toastManager.show(...)`
 * pair — except the hook path, which only ever called sendNotification, so
 * hook-sourced completions (the CANONICAL "turn finished" signal) never
 * produced an OS toast. Meanwhile ToastManager suppressed on "any window
 * focused" while the renderer policy separately suppressed on "active
 * surface", so the two layers disagreed about visibility and their
 * intersection produced fully silent completions.
 *
 * New contract:
 *   - Renderer alive AND its notification listener confirmed subscribed →
 *     send ONLY the IPC notification. The renderer's notification policy
 *     (useNotificationPolicy.ts) is the single decision point for every
 *     surface, INCLUDING the OS toast: it emits an `osToast` action when the
 *     window is unfocused, which round-trips back to main over
 *     IPC.NOTIFICATION_OS_TOAST → toastManager.showDirect().
 *   - No renderer window, OR a window that exists but hasn't confirmed its
 *     listener is live (teardown, early boot, mid-reload crash recovery —
 *     `webContents.send` reaching an unmounted/reloading page is a silent
 *     no-op, codex review catch round 1) → fall back to a DIRECT toast via
 *     `showDirect` (not the focus-suppressing `show()`, codex review catch
 *     round 2): a window that's OS-focused but mid-reload shows the user a
 *     blank/reloading page, not the notification — `show()`'s "focused =
 *     already looking at it, stay quiet" assumption is exactly backwards
 *     here, and it would otherwise re-introduce the same silent-loss bug
 *     for a focused-but-not-ready window (readiness gate says "fall back",
 *     but the fallback itself would then also drop it). For a genuinely
 *     absent window this is behaviorally identical to `show()` anyway
 *     (`BrowserWindow.getFocusedWindow()` is trivially null with no window
 *     open, so `show()`'s own check never suppressed this case either).
 *
 * `focus` is the toast click context (pane jump target). Callers that know
 * the originating pane pass `{ ptyId }`; app-level events pass
 * `{ workspaceId }`. Defaults to the payload's routing hints.
 */
export function dispatchNotification(
  win: BrowserWindow | null,
  ptyId: string | null,
  payload: NotificationPayload,
  focus?: ToastFocusContext,
): void {
  if (win && !win.isDestroyed() && isRendererNotificationListenerReady()) {
    sendNotification(win, ptyId, payload);
    return;
  }
  // The renderer's policy is unreachable here, so apply the one gate it would
  // have applied that main can know about: the mirrored per-category mute
  // (#516). Without this, muting a category went quiet inside the app but
  // still banner-ed the desktop whenever the window was closed to the tray —
  // the exact case the mute exists for.
  if (isCategoryMuted(payload.category)) return;
  toastManager.showDirect(
    payload.title,
    payload.body,
    focus ?? { ptyId, workspaceId: payload.workspaceId ?? null },
  );
}
