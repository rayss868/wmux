// dispatchNotification — the single entry point for user-visible
// notifications. Contract under test:
//   - renderer window alive → IPC notification ONLY (the renderer policy
//     owns every surface decision, including the OS toast via the osToast
//     action round-trip)
//   - window gone/destroyed → legacy direct toast fallback so the event
//     isn't lost, carrying the click-jump focus context
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  toastShow: vi.fn(),
}));

vi.mock('electron', () => ({}));

vi.mock('../sendNotification', () => ({
  sendNotification: mocks.sendNotification,
}));

vi.mock('../ToastManager', () => ({
  toastManager: { show: mocks.toastShow, enabled: true },
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
});

describe('dispatchNotification', () => {
  it('window alive → sendNotification only, no direct toast', () => {
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
});
