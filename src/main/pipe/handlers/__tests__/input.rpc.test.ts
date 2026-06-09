import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerInputRpc } from '../input.rpc';
import type { PTYManager } from '../../../pty/PTYManager';

// Mock the renderer bridge so we can drive input.findOwnerWorkspace (the
// ownership oracle assertWorkspaceOwnsPty consults) and input.readScreen (the
// viewport read) without a real BrowserWindow.
const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;
const fakePty = {} as PTYManager;

function setup(): RpcRouter {
  const router = new RpcRouter();
  registerInputRpc(router, fakePty, () => fakeWindow);
  return router;
}

// Regression guard for issue #163: input.readScreen was the lone terminal-IO
// handler missing assertWorkspaceOwnsPty, letting a caller that names another
// workspace + a foreign ptyId read that workspace's viewport.
describe('input.readScreen — cross-workspace ownership (issue #163)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an explicit-ptyId read owned by a different workspace, before any viewport read', async () => {
    sendToRendererMock.mockImplementation((_w: unknown, method: string) => {
      if (method === 'input.findOwnerWorkspace') {
        // The ptyId genuinely belongs to the victim ws (the crux of the bug).
        return Promise.resolve({ workspaceId: 'ws-victim' });
      }
      return Promise.resolve({ ptyId: 'daemon-victim', text: 'SECRET' });
    });

    const res = await setup().dispatch({
      id: '1',
      method: 'input.readScreen',
      params: { workspaceId: 'ws-attacker', ptyId: 'daemon-victim' },
    });

    expect(res.ok).toBe(false);
    // The ownership check ran...
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.findOwnerWorkspace',
      { ptyId: 'daemon-victim' },
    );
    // ...and the viewport read never happened (assert-before-read).
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.anything(),
    );
  });

  it('allows a read when the caller workspace owns the ptyId', async () => {
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, params?: { ptyId?: string }) => {
        if (method === 'input.findOwnerWorkspace') return Promise.resolve({ workspaceId: 'ws-A' });
        return Promise.resolve({ ptyId: params?.ptyId ?? 'daemon-A', text: 'mine' });
      },
    );

    const res = await setup().dispatch({
      id: '2',
      method: 'input.readScreen',
      params: { workspaceId: 'ws-A', ptyId: 'daemon-A' },
    });

    expect(res.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.readScreen',
      expect.objectContaining({ ptyId: 'daemon-A' }),
    );
  });

  it('skips the ownership check for internal callers that pass no workspaceId (CLI/UI)', async () => {
    sendToRendererMock.mockImplementation(
      (_w: unknown, method: string, params?: { ptyId?: string }) => {
        if (method === 'input.findOwnerWorkspace') {
          return Promise.reject(new Error('findOwnerWorkspace must not be called for internal callers'));
        }
        return Promise.resolve({ ptyId: params?.ptyId ?? 'daemon-A', text: 'cli' });
      },
    );

    const res = await setup().dispatch({
      id: '3',
      method: 'input.readScreen',
      params: { ptyId: 'daemon-A' },
    });

    expect(res.ok).toBe(true);
    expect(sendToRendererMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'input.findOwnerWorkspace',
      expect.anything(),
    );
  });
});
