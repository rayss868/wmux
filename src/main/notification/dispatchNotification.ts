import type { BrowserWindow } from 'electron';
import { sendNotification, type NotificationPayload } from './sendNotification';
import { toastManager, type ToastFocusContext } from './ToastManager';

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
 *   - Renderer alive → send ONLY the IPC notification. The renderer's
 *     notification policy (useNotificationPolicy.ts) is the single decision
 *     point for every surface, INCLUDING the OS toast: it emits an `osToast`
 *     action when the window is unfocused, which round-trips back to main
 *     over IPC.NOTIFICATION_OS_TOAST → toastManager.showDirect().
 *   - No renderer window (teardown, early boot) → fall back to the legacy
 *     direct toast so the event isn't lost entirely. `show()` keeps its
 *     focused-window suppression, which is trivially satisfied here (a
 *     destroyed/absent window is never focused).
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
  if (win && !win.isDestroyed()) {
    sendNotification(win, ptyId, payload);
    return;
  }
  toastManager.show(
    payload.title,
    payload.body,
    focus ?? { ptyId, workspaceId: payload.workspaceId ?? null },
  );
}
