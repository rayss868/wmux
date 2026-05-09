import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerPaneRpc } from '../pane.rpc';
import { PANE_METADATA_MAX_BYTES } from '../../../../shared/types';

const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

const fakeWindow = {} as BrowserWindow;

function setupRouter(): RpcRouter {
  const router = new RpcRouter();
  registerPaneRpc(router, () => fakeWindow);
  return router;
}

describe('pane.rpc — metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendToRendererMock.mockResolvedValue({ ok: true });
  });

  describe('pane.setMetadata', () => {
    it('forwards a sanitized patch with merge=true by default', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-1',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-x', label: 'Backend', role: 'service' },
      });

      expect(res.ok).toBe(true);
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);
      const [, method, payload] = sendToRendererMock.mock.calls[0];
      expect(method).toBe('pane.setMetadata');
      expect(payload).toMatchObject({
        paneId: 'pane-x',
        merge: true,
        patch: { label: 'Backend', role: 'service' },
      });
    });

    it('honors merge=false when caller passes it', async () => {
      const router = setupRouter();
      await router.dispatch({
        id: 'rpc-2',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-x', status: 'idle', merge: false },
      });

      const [, , payload] = sendToRendererMock.mock.calls[0];
      expect(payload).toMatchObject({ merge: false, patch: { status: 'idle' } });
    });

    it('rejects when label exceeds 64 chars', async () => {
      const router = setupRouter();
      const longLabel = 'a'.repeat(65);
      const res = await router.dispatch({
        id: 'rpc-3',
        method: 'pane.setMetadata',
        params: { label: longLabel },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/label/);
      }
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it('rejects when status exceeds 128 chars', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-4',
        method: 'pane.setMetadata',
        params: { status: 's'.repeat(129) },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/status/);
    });

    it('rejects non-string values inside custom map', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-5',
        method: 'pane.setMetadata',
        params: { custom: { count: 42 } as unknown as Record<string, string> },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/custom\.count/);
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it('rejects when custom is an array, not an object', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-6',
        method: 'pane.setMetadata',
        params: { custom: ['nope'] as unknown as Record<string, string> },
      });

      expect(res.ok).toBe(false);
    });

    it('rejects oversized payload over 8KB cap', async () => {
      const router = setupRouter();
      const huge = 'x'.repeat(PANE_METADATA_MAX_BYTES + 50);
      const res = await router.dispatch({
        id: 'rpc-7',
        method: 'pane.setMetadata',
        params: { custom: { blob: huge } },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/exceeds/);
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it('forwards undefined paneId so renderer falls back to active pane', async () => {
      const router = setupRouter();
      await router.dispatch({
        id: 'rpc-8',
        method: 'pane.setMetadata',
        params: { label: 'Active' },
      });
      const [, , payload] = sendToRendererMock.mock.calls[0];
      expect(payload.paneId).toBeUndefined();
    });
  });

  describe('pane.getMetadata', () => {
    it('forwards paneId to renderer', async () => {
      const router = setupRouter();
      sendToRendererMock.mockResolvedValueOnce({
        paneId: 'pane-x',
        metadata: { label: 'Backend' },
      });

      const res = await router.dispatch({
        id: 'rpc-9',
        method: 'pane.getMetadata',
        params: { paneId: 'pane-x' },
      });

      expect(res.ok).toBe(true);
      expect(sendToRendererMock).toHaveBeenCalledWith(
        expect.any(Function),
        'pane.getMetadata',
        { paneId: 'pane-x' },
      );
    });

    it('passes undefined paneId through when omitted', async () => {
      const router = setupRouter();
      await router.dispatch({
        id: 'rpc-10',
        method: 'pane.getMetadata',
        params: {},
      });
      const [, , payload] = sendToRendererMock.mock.calls[0];
      expect(payload.paneId).toBeUndefined();
    });
  });

  describe('pane.clearMetadata', () => {
    it('forwards paneId to renderer', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-11',
        method: 'pane.clearMetadata',
        params: { paneId: 'pane-x' },
      });
      expect(res.ok).toBe(true);
      const [, method, payload] = sendToRendererMock.mock.calls[0];
      expect(method).toBe('pane.clearMetadata');
      expect(payload).toEqual({ paneId: 'pane-x', workspaceId: undefined });
    });
  });

  describe('review fixes', () => {
    it('1.1 — forwards workspaceId for setMetadata so cross-workspace writes are scoped', async () => {
      const router = setupRouter();
      await router.dispatch({
        id: 'rpc-fix-1',
        method: 'pane.setMetadata',
        params: { workspaceId: 'ws-caller', paneId: 'pane-y', label: 'X' },
      });
      const [, , payload] = sendToRendererMock.mock.calls[0];
      expect(payload.workspaceId).toBe('ws-caller');
    });

    it('1.1 — forwards workspaceId for getMetadata + clearMetadata', async () => {
      const router = setupRouter();
      await router.dispatch({
        id: 'rpc-fix-2',
        method: 'pane.getMetadata',
        params: { workspaceId: 'ws-caller' },
      });
      await router.dispatch({
        id: 'rpc-fix-3',
        method: 'pane.clearMetadata',
        params: { workspaceId: 'ws-caller' },
      });
      const getCall = sendToRendererMock.mock.calls[0];
      const clearCall = sendToRendererMock.mock.calls[1];
      expect(getCall[2]).toEqual({ paneId: undefined, workspaceId: 'ws-caller' });
      expect(clearCall[2]).toEqual({ paneId: undefined, workspaceId: 'ws-caller' });
    });

    it('1.2 — rejects role exceeding 64 chars', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-fix-4',
        method: 'pane.setMetadata',
        params: { role: 'r'.repeat(65) },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/role/);
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it('1.3 — rejects empty custom key', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-fix-5',
        method: 'pane.setMetadata',
        params: { custom: { '': 'value' } },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/empty/);
    });

    it('1.3 — rejects custom key exceeding 64 chars', async () => {
      const router = setupRouter();
      const res = await router.dispatch({
        id: 'rpc-fix-6',
        method: 'pane.setMetadata',
        params: { custom: { ['k'.repeat(65)]: 'value' } },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/key exceeds/);
    });

    it('1.3 — rejects custom maps with > 32 entries', async () => {
      const router = setupRouter();
      const custom: Record<string, string> = {};
      for (let i = 0; i < 33; i++) custom[`k${i}`] = 'v';
      const res = await router.dispatch({
        id: 'rpc-fix-7',
        method: 'pane.setMetadata',
        params: { custom },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/32 entries/);
    });

    it('1.3 — accepts custom map at exactly the entry limit', async () => {
      const router = setupRouter();
      const custom: Record<string, string> = {};
      for (let i = 0; i < 32; i++) custom[`k${i}`] = 'v';
      const res = await router.dispatch({
        id: 'rpc-fix-8',
        method: 'pane.setMetadata',
        params: { custom },
      });
      expect(res.ok).toBe(true);
    });
  });

  describe('pane.list snapshot wrapper (review fix 2b + 5a)', () => {
    it('wraps the renderer response with asOfSeq + bootId', async () => {
      sendToRendererMock.mockResolvedValueOnce([
        { id: 'p1', surfaceCount: 1, active: true },
      ]);

      const router = setupRouter();
      const res = await router.dispatch({ id: 'rpc-list-1', method: 'pane.list', params: {} });

      expect(res.ok).toBe(true);
      if (res.ok) {
        const result = res.result as { asOfSeq: number; bootId: string; panes: unknown[] };
        expect(typeof result.asOfSeq).toBe('number');
        expect(typeof result.bootId).toBe('string');
        expect(result.bootId.length).toBeGreaterThan(0);
        expect(result.panes).toHaveLength(1);
      }
    });

    it('forwards workspaceId param to the renderer', async () => {
      sendToRendererMock.mockResolvedValueOnce([]);
      const router = setupRouter();
      await router.dispatch({
        id: 'rpc-list-2',
        method: 'pane.list',
        params: { workspaceId: 'ws-target' },
      });
      const [, method, payload] = sendToRendererMock.mock.calls[0];
      expect(method).toBe('pane.list');
      expect(payload).toMatchObject({ workspaceId: 'ws-target' });
    });
  });
});
