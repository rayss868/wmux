// dispatchNotification — the single entry point for user-visible
// notifications. Contract under test:
//   - renderer window alive AND its listener confirmed ready → IPC
//     notification ONLY (the renderer policy owns every surface decision,
//     including the OS toast via the osToast action round-trip)
//   - window gone/destroyed, OR alive but NOT confirmed ready (deferred
//     load, mid-reload crash recovery — codex review catch round 1) →
//     legacy direct toast fallback via showDirect (NOT the focus-
//     suppressing show() — codex review catch round 2: a window that's
//     OS-focused but mid-reload shows a blank page, not the notification,
//     so show()'s "focused = already looking, stay quiet" assumption is
//     backwards there) so the event isn't lost, carrying the click-jump
//     focus context
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  toastShow: vi.fn(),
  listenerReady: true,
}));

vi.mock('electron', () => ({}));

vi.mock('../sendNotification', () => ({
  sendNotification: mocks.sendNotification,
}));

vi.mock('../ToastManager', () => ({
  // dispatchNotification's fallback calls showDirect (not show) — see the
  // module doc above for why. Both point at the same spy since these tests
  // only care that a direct, non-suppressing toast fired.
  toastManager: { show: mocks.toastShow, showDirect: mocks.toastShow, enabled: true },
}));

vi.mock('../rendererNotificationReadiness', () => ({
  isRendererNotificationListenerReady: () => mocks.listenerReady,
}));

import { dispatchNotification } from '../dispatchNotification';

function makeWin(destroyed = false): BrowserWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
}

beforeEach(() => {
  mocks.sendNotification.mockReset();
  mocks.toastShow.mockReset();
  mocks.listenerReady = true; // most tests want the "happy path" default
});

describe('dispatchNotification', () => {
  it('window alive + listener ready → sendNotification only, no direct toast', () => {
    const win = makeWin();
    dispatchNotification(win, 'pty-1', { type: 'agent', title: 't', body: 'b' }, { ptyId: 'pty-1' });

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledWith(win, 'pty-1', {
      type: 'agent', title: 't', body: 'b',
    });
    expect(mocks.toastShow).not.toHaveBeenCalled();
  });

  it('no window → direct toast fallback with the provided focus context', () => {
    dispatchNotification(null, 'pty-1', { type: 'agent', title: 't', body: 'b' }, { ptyId: 'pty-1' });

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.toastShow).toHaveBeenCalledWith('t', 'b', { ptyId: 'pty-1' });
  });

  it('destroyed window counts as no window', () => {
    dispatchNotification(makeWin(true), null, { type: 'info', title: 't', body: 'b', workspaceId: 'ws-1' });

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.toastShow).toHaveBeenCalledTimes(1);
  });

  it('fallback focus context defaults to ptyId + payload workspaceId when none is given', () => {
    dispatchNotification(null, null, { type: 'info', title: 't', body: 'b', workspaceId: 'ws-1' });

    expect(mocks.toastShow).toHaveBeenCalledWith('t', 'b', { ptyId: null, workspaceId: 'ws-1' });
  });

  // Codex review catch (2026-07-15): a live BrowserWindow does not imply a
  // live listener. During deferred initial load, mid-reload crash recovery
  // (mainWindow.reload()), or any window whose content hasn't mounted
  // useNotificationListener yet, webContents.send() reaches nobody — the
  // pre-fix code trusted "window exists" alone and silently lost the
  // notification in exactly the scenario this whole refactor exists to fix.
  it('window alive but listener NOT confirmed ready → falls back to direct toast (not silently lost)', () => {
    mocks.listenerReady = false;
    const win = makeWin();
    dispatchNotification(win, 'pty-1', { type: 'agent', title: 't', body: 'b' }, { ptyId: 'pty-1' });

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.toastShow).toHaveBeenCalledTimes(1);
    expect(mocks.toastShow).toHaveBeenCalledWith('t', 'b', { ptyId: 'pty-1' });
  });

  it('window alive, not ready, AND no explicit focus context → still falls back using payload-derived context', () => {
    mocks.listenerReady = false;
    const win = makeWin();
    dispatchNotification(win, 'pty-2', { type: 'info', title: 't', body: 'b', workspaceId: 'ws-2' });

    expect(mocks.toastShow).toHaveBeenCalledWith('t', 'b', { ptyId: 'pty-2', workspaceId: 'ws-2' });
  });
});
