// Unit tests for deck.resolvePaneRoute (P3b codex P1, M1.5 confinement) —
// the commander brain's route resolution. Token-gated: only a live commander
// token (minted by main for the brain subprocess) may resolve a pane's
// owning workspace, and ONLY for panes inside the token's own workspace;
// everything else fails closed.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerDeckRpc } from '../deck.rpc';
import {
  mintCommanderToken,
  __resetCommanderTrustForTesting,
} from '../../../deck/commanderTrust';

const { sendToRendererMock } = vi.hoisted(() => ({ sendToRendererMock: vi.fn() }));
vi.mock('../_bridge', () => ({ sendToRenderer: sendToRendererMock }));

const fakeWindow = {} as BrowserWindow;

function setup(): RpcRouter {
  const router = new RpcRouter();
  registerDeckRpc(router, () => fakeWindow);
  return router;
}

describe('deck.resolvePaneRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetCommanderTrustForTesting();
  });

  it('resolves a pane owned by the token workspace', async () => {
    const token = mintCommanderToken('ws-owner');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-owner' });

    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-9' },
    });

    expect(res.ok).toBe(true);
    expect((res as { result: unknown }).result).toEqual({ workspaceId: 'ws-owner' });
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      'input.findOwnerWorkspace',
      { ptyId: 'pty-9' },
    );
  });

  it("fails closed on a pane owned by ANOTHER workspace (M1.5 confinement)", async () => {
    const token = mintCommanderToken('ws-mine');
    sendToRendererMock.mockResolvedValue({ workspaceId: 'ws-other' });

    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-9' },
    });

    expect(res.ok).toBe(false);
  });

  it('fails closed for a token minted with an empty workspace binding', async () => {
    const token = mintCommanderToken('');
    const res = await setup().dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-9' },
    });
    expect(res.ok).toBe(false);
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('rejects a missing/unknown token BEFORE consulting the renderer', async () => {
    mintCommanderToken('ws-1'); // a live token exists, but the caller presents another
    const router = setup();

    for (const params of [
      { ptyId: 'pty-9' },
      { token: 'guessed', ptyId: 'pty-9' },
      { token: 42, ptyId: 'pty-9' },
    ]) {
      const res = await router.dispatch({
        id: 'x',
        method: 'deck.resolvePaneRoute',
        params: params as Record<string, unknown>,
      });
      expect(res.ok).toBe(false);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('fails closed on a missing ptyId and on an unowned pane', async () => {
    const token = mintCommanderToken('ws-1');
    const router = setup();

    const noPty = await router.dispatch({
      id: '1',
      method: 'deck.resolvePaneRoute',
      params: { token },
    });
    expect(noPty.ok).toBe(false);

    sendToRendererMock.mockResolvedValue({ workspaceId: null });
    const unowned = await router.dispatch({
      id: '2',
      method: 'deck.resolvePaneRoute',
      params: { token, ptyId: 'pty-ghost' },
    });
    expect(unowned.ok).toBe(false);
  });
});
