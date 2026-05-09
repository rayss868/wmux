import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerPaneRpc } from '../pane.rpc';

const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

function register(): RpcRouter {
  const router = new RpcRouter();
  registerPaneRpc(router, (() => null) as () => BrowserWindow | null);
  return router;
}

describe('pane.rpc — search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendToRendererMock.mockResolvedValue({
      resultShapeVersion: 1,
      results: [],
      truncated: false,
      totalMatches: 0,
      workspaceId: 'ws-1',
    });
  });

  it('forwards a valid query to the renderer', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '1',
      method: 'pane.search',
      params: { query: 'foo' },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledTimes(1);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'pane.search',
      { query: 'foo' },
    );
  });

  it('forwards the regex flag when provided as a boolean', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '2',
      method: 'pane.search',
      params: { query: 'foo', regex: true },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'pane.search',
      { query: 'foo', regex: true },
    );
  });

  it('omits regex from forwarded payload when caller did not provide it', async () => {
    const router = register();
    await router.dispatch({
      id: '3',
      method: 'pane.search',
      params: { query: 'foo' },
    });

    const forwardedPayload = sendToRendererMock.mock.calls[0][2] as Record<string, unknown>;
    expect(forwardedPayload).toEqual({ query: 'foo' });
    expect('regex' in forwardedPayload).toBe(false);
  });

  it('forwards regex: false explicitly when caller provided it', async () => {
    const router = register();
    await router.dispatch({
      id: '4',
      method: 'pane.search',
      params: { query: 'foo', regex: false },
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'pane.search',
      { query: 'foo', regex: false },
    );
  });

  it('rejects an empty query', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '5',
      method: 'pane.search',
      params: { query: '' },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatch(/non-empty/);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('rejects a missing query (params has no `query` key)', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '6',
      method: 'pane.search',
      params: {},
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatch(/string/);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('rejects a non-string query', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '7',
      method: 'pane.search',
      params: { query: 42 as unknown as string },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatch(/string/);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean regex flag (e.g. string "true")', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '8',
      method: 'pane.search',
      params: { query: 'x', regex: 'true' as unknown as boolean },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatch(/boolean/);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  // C1 — workspaceId forwarding. The main handler must thread the caller's
  // workspaceId through so the renderer scopes the search to that workspace
  // (not whichever the user happens to be viewing).
  it('forwards workspaceId when caller provides it (C1)', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '10',
      method: 'pane.search',
      params: { query: 'foo', workspaceId: 'ws-caller' },
    });

    expect(response.ok).toBe(true);
    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'pane.search',
      { query: 'foo', workspaceId: 'ws-caller' },
    );
  });

  it('forwards workspaceId together with regex when both are provided (C1)', async () => {
    const router = register();
    await router.dispatch({
      id: '11',
      method: 'pane.search',
      params: { query: 'foo', regex: true, workspaceId: 'ws-caller' },
    });

    expect(sendToRendererMock).toHaveBeenCalledWith(
      expect.any(Function),
      'pane.search',
      { query: 'foo', regex: true, workspaceId: 'ws-caller' },
    );
  });

  it('omits workspaceId from forwarded payload when caller did not provide it (C1)', async () => {
    const router = register();
    await router.dispatch({
      id: '12',
      method: 'pane.search',
      params: { query: 'foo' },
    });

    const forwardedPayload = sendToRendererMock.mock.calls[0][2] as Record<string, unknown>;
    expect('workspaceId' in forwardedPayload).toBe(false);
  });

  it('rejects a non-string workspaceId (C1)', async () => {
    const router = register();
    const response = await router.dispatch({
      id: '13',
      method: 'pane.search',
      params: { query: 'foo', workspaceId: 42 as unknown as string },
    });

    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error).toMatch(/string/);
    }
    expect(sendToRendererMock).not.toHaveBeenCalled();
  });

  it('returns the renderer response payload to the caller', async () => {
    const router = register();
    const fakeResponse = {
      resultShapeVersion: 1,
      results: [
        {
          paneId: 'p1',
          surfaceId: 's1',
          ptyId: 'pty1',
          lineIdx: 5,
          physicalBaseY: 5,
          text: 'matched line',
          contextBefore: [],
          contextAfter: [],
        },
      ],
      truncated: false,
      totalMatches: 1,
      workspaceId: 'ws-1',
    };
    sendToRendererMock.mockResolvedValueOnce(fakeResponse);

    const response = await router.dispatch({
      id: '9',
      method: 'pane.search',
      params: { query: 'matched' },
    });

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.result).toEqual(fakeResponse);
    }
  });
});
