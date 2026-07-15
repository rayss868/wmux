// Tracks whether the renderer's notification IPC listener is actually
// attached — a live BrowserWindow does not imply a live listener (deferred
// initial load, mid-reload crash recovery, or a renderer that hasn't mounted
// yet all leave `webContents.send` reaching nobody).
//
// Module-level state, mirroring the ToastManager singleton pattern: main has
// exactly one renderer window, so one flag is sufficient. `markNotReady` is
// wired to every webContents navigation-start event (any reload, for any
// reason); `markReady` is called once per `useNotificationListener` mount
// (see IPC.NOTIFICATION_LISTENER_READY) — so the flag correctly flips back
// to false for the entire crash → reload → remount window, and back to true
// the instant React re-subscribes.
let ready = false;

export function markRendererNotificationListenerReady(): void {
  ready = true;
}

export function markRendererNotificationListenerNotReady(): void {
  ready = false;
}

export function isRendererNotificationListenerReady(): boolean {
  return ready;
}
