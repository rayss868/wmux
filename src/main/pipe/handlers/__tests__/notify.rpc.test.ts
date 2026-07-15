import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks — vi.mock factories are hoisted above the imports below.
const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  toastManagerShow: vi.fn(),
}));

vi.mock('electron', () => ({}));

vi.mock('../../../notification/sendNotification', () => ({
  sendNotification: mocks.sendNotification,
}));

vi.mock('../../../notification/ToastManager', () => ({
  ToastManager: class { show = mocks.toastManagerShow; },
  // Module-level singleton consumed by dispatchNotification's no-window
  // fallback (and re-exported by notify.rpc for legacy importers).
  toastManager: { show: mocks.toastManagerShow, enabled: true },
}));

import { RpcRouter } from '../../RpcRouter';
import { registerNotifyRpc } from '../notify.rpc';

function setupRouter(opts: { window?: boolean } = {}) {
  const router = new RpcRouter();
  const win = opts.window === false
    ? null
    : { isDestroyed: () => false, webContents: { send: vi.fn() } };
  registerNotifyRpc(router, () => win as never);
  return { router, win };
}

describe('notify.rpc', () => {
  beforeEach(() => {
    mocks.sendNotification.mockReset();
    mocks.toastManagerShow.mockReset();
  });

  it('rejects when title is missing', async () => {
    const { router } = setupRouter();
    const res = await router.dispatch({ id: '1', method: 'notify', params: { body: 'b' } });
    expect(res.ok).toBe(false);
  });

  it('rejects when body is missing', async () => {
    const { router } = setupRouter();
    const res = await router.dispatch({ id: '2', method: 'notify', params: { title: 't' } });
    expect(res.ok).toBe(false);
  });

  it('REGRESSION (R6): workspaceId is OPTIONAL — CLI without workspaceId still succeeds', () => {
    // Backward compat for `wmux notify --title X --body Y` from the CLI:
    // before this fix, requiring workspaceId would break every CLI call.
    return setupRouter().router.dispatch({
      id: '3', method: 'notify', params: { title: 't', body: 'b' },
    }).then((res) => {
      expect(res.ok).toBe(true);
      expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
      const [, ptyId, payload] = mocks.sendNotification.mock.calls[0];
      expect(ptyId).toBeNull();
      expect(payload).toMatchObject({ title: 't', body: 'b', type: 'info' });
      expect(payload.workspaceId).toBeUndefined();
    });
  });

  it('forwards workspaceId when provided (MCP path with precise routing)', async () => {
    const { router } = setupRouter();
    const res = await router.dispatch({
      id: '4', method: 'notify',
      params: { title: 't', body: 'b', type: 'agent', workspaceId: 'ws-7' },
    });
    expect(res.ok).toBe(true);
    const [, ptyId, payload] = mocks.sendNotification.mock.calls[0];
    expect(ptyId).toBeNull();
    expect(payload).toMatchObject({ title: 't', body: 'b', type: 'agent', workspaceId: 'ws-7' });
  });

  it('falls back to "info" type when type is missing or invalid', async () => {
    const { router } = setupRouter();
    await router.dispatch({ id: '5', method: 'notify', params: { title: 't', body: 'b', type: 'unknown' } });
    const [, , payload] = mocks.sendNotification.mock.calls[0];
    expect(payload.type).toBe('info');
  });

  it('window alive → NO direct OS toast (renderer policy owns the osToast decision)', async () => {
    const { router } = setupRouter();
    await router.dispatch({ id: '6', method: 'notify', params: { title: 't', body: 'b' } });
    // dispatchNotification sends only the IPC notification when a renderer
    // exists; the renderer's policy emits an `osToast` action (unfocused
    // window) which round-trips over IPC.NOTIFICATION_OS_TOAST. A second
    // main-side toast here would double-announce.
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.toastManagerShow).not.toHaveBeenCalled();
  });

  it('no window → direct OS toast fallback carries the workspaceId click context (X2 pane jump)', async () => {
    const { router } = setupRouter({ window: false });
    await router.dispatch({
      id: '7', method: 'notify',
      params: { title: 't', body: 'b', workspaceId: 'ws-7' },
    });
    // No renderer to decide — the event must not be lost, so the legacy
    // direct toast fires with the click-jump context.
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.toastManagerShow).toHaveBeenCalledWith('t', 'b', { workspaceId: 'ws-7' });
  });
});
