import type { BrowserWindow } from 'electron';

/**
 * Minimal slice of BrowserWindow the flashFrame plumbing touches. Kept as a
 * structural interface so the unit tests can pass a plain `{ isDestroyed,
 * flashFrame, on }` object without dragging in the full Electron type tree.
 */
export interface FlashFrameWindow {
  isDestroyed(): boolean;
  flashFrame(flag: boolean): void;
  on(event: 'focus', listener: () => void): unknown;
}

/**
 * Build the `window:flashFrame` IPC handler.
 *
 * T6 of the Notification System Expansion — the renderer-side
 * `useNotificationListener` calls this when a notification arrives while
 * the BrowserWindow is unfocused, to recall the user's attention via the
 * Windows taskbar attention flash. On macOS this maps to dock bounce, on
 * Linux to whatever the WM exposes (usually a no-op on tiling WMs).
 *
 * CEO stamp A7 invariant — Electron throws on `flashFrame` after the
 * window is destroyed (e.g. during app shutdown). Every call is guarded
 * by `isDestroyed()`, and a null window (e.g. main never finished
 * `createWindow()`) is treated the same way: silently ignored.
 *
 * Pulled out as a factory so the focus-listener and the IPC entry-point
 * share one code path, and so unit tests can drive it with a stub
 * BrowserWindow without spinning up a real Electron harness.
 */
export function createFlashFrameHandler(
  getWindow: () => FlashFrameWindow | null,
): (on: boolean) => void {
  return (on: boolean): void => {
    const win = getWindow();
    if (!win) return;
    if (win.isDestroyed()) return;
    win.flashFrame(Boolean(on));
  };
}

/**
 * Wire the `'focus'` auto-clear listener onto a BrowserWindow.
 *
 * If a renderer-driven flash is active and the user focuses the window,
 * the flash is cleared automatically — the renderer is not required to
 * send a follow-up `flashFrame(false)`. Guarded by `isDestroyed()` for
 * the same reason as the IPC handler.
 *
 * Returns `void`. Electron windows tear down via `destroy()`, which
 * severs all listeners — there is no separate disposer to call. The
 * helper is named `attach*` to match siblings like `attachWindowEvents`,
 * not to imply a returned cleanup handle.
 */
export function attachFlashFrameAutoClear(win: FlashFrameWindow): void {
  win.on('focus', () => {
    if (win.isDestroyed()) return;
    win.flashFrame(false);
  });
}
