import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerSurfaceRpc } from '../surface.rpc';

const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

function register(): RpcRouter {
  const router = new RpcRouter();
  registerSurfaceRpc(router, (() => null) as () => BrowserWindow | null);
  return router;
}

// #236 follow-up — surface.new previously dropped params entirely, scoping
// every caller to the on-screen workspace. The handler must now forward an
// explicit workspaceId/shell/cwd so a multi-agent caller targets its OWN
// workspace (renderer fails closed on an unknown explicit id; covered by dogfood).
describe('surface.rpc — new (workspaceId scoping)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendToRendererMock.mockResolvedValue({ ptyId: 'pty-1' });
  });

  it('forwards an explicit workspaceId / shell / cwd to the renderer', async () => {
    const router = register();
    const r = await router.dispatch({
      id: '1',
      method: 'surface.new',
      params: { workspaceId: 'ws-2', shell: 'pwsh', cwd: '/tmp/x' },
    });
    expect(r.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'surface.new',
      { workspaceId: 'ws-2', shell: 'pwsh', cwd: '/tmp/x' },
    );
  });

  it('omits workspaceId when not provided (renderer falls back to active ws)', async () => {
    const router = register();
    await router.dispatch({ id: '2', method: 'surface.new', params: {} });
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'surface.new', {});
  });

  it('rejects a non-string workspaceId', async () => {
    const router = register();
    const r = await router.dispatch({
      id: '3',
      method: 'surface.new',
      params: { workspaceId: 123 },
    });
    expect(r.ok).toBe(false);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });
});

describe('surface.rpc — focus/close forward the surface id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendToRendererMock.mockResolvedValue({ ok: true });
  });

  it('surface.focus forwards { id }', async () => {
    const router = register();
    await router.dispatch({ id: '1', method: 'surface.focus', params: { id: 's-1' } });
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'surface.focus', { id: 's-1' });
  });

  it('surface.close forwards { id }', async () => {
    const router = register();
    await router.dispatch({ id: '2', method: 'surface.close', params: { id: 's-2' } });
    expect(sendToRendererMock).toHaveBeenCalledWith(expect.any(Function), 'surface.close', { id: 's-2' });
  });

  it('surface.focus rejects a missing id', async () => {
    const router = register();
    const r = await router.dispatch({ id: '3', method: 'surface.focus', params: {} });
    expect(r.ok).toBe(false);
  });
});
