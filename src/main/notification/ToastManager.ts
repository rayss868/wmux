import { Notification, BrowserWindow, app } from 'electron';
import { isWindows, isMac } from '../../shared/platform';

export class ToastManager {
  enabled = true;
  private flashingWindow: BrowserWindow | null = null;
  private focusHandler: (() => void) | null = null;

  show(title: string, body: string): void {
    if (!this.enabled) return;

    // Only show toast when app is not focused
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) return;

    if (!Notification.isSupported()) return;

    const notification = new Notification({
      title,
      body,
      silent: false,
    });

    notification.on('click', () => {
      // Bring app to front when toast is clicked
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });

    notification.show();

    // OS-aware "attract attention" behavior:
    //   - Windows: flashFrame(true) until window regains focus, then flashFrame(false).
    //   - macOS:   one-shot dock bounce (Apple HIG; no listener needed — bounce is fire-and-forget).
    //   - Linux:   the Notification API itself is sufficient; no additional taskbar API.
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (isWindows) {
        win.flashFrame(true);
        if (this.flashingWindow !== win) {
          // Remove previous listener to prevent accumulation
          if (this.flashingWindow && this.focusHandler) {
            this.flashingWindow.removeListener('focus', this.focusHandler);
          }
          this.flashingWindow = win;
          this.focusHandler = () => { win.flashFrame(false); };
          win.on('focus', this.focusHandler);
        }
      } else if (isMac) {
        // app.dock is only defined on darwin; optional-chain guards against
        // theoretical undefined (e.g. headless test envs).
        app.dock?.bounce('informational');
      }
      // Linux: intentionally no-op beyond the Notification.show() above.
    }
  }
}
