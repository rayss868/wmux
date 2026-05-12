import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerPaneRpc } from '../pane.rpc';
import { PANE_METADATA_MAX_BYTES } from '../../../../shared/types';
import { EventBus } from '../../../events/EventBus';
import { MetadataStore } from '../../../metadata/MetadataStore';

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

/**
 * Setup helper for M0-b metadata tests. Injects a fresh MetadataStore so
 * each test gets a clean slate without poking the module-level singleton.
 */
function setupWithStore(): { router: RpcRouter; store: MetadataStore } {
  const win = {} as BrowserWindow;
  const router = new RpcRouter();
  const store = new MetadataStore({ eventBus: new EventBus() });
  registerPaneRpc(router, () => win, { store });
  return { router, store };
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
    // === M0-b: paneId-present path writes to MetadataStore directly ===

    it('writes a sanitized patch to MetadataStore with merge=true by default (paneId path)', async () => {
      const { router, store } = setupWithStore();
      const res = await router.dispatch({
        id: 'rpc-1',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', label: 'Backend', role: 'service' },
      });

      expect(res.ok).toBe(true);
      // sendToRenderer is NOT called for paneId-present writes (M0-b).
      expect(sendToRendererMock).not.toHaveBeenCalled();
      // The store committed the sanitized patch.
      const entry = store.get('pane-x');
      expect(entry.version).toBe(1);
      expect(entry.metadata.label).toBe('Backend');
      expect(entry.metadata.role).toBe('service');
    });

    it('honors merge=false (mergeMode=replace) when caller passes it (paneId path)', async () => {
      const { router, store } = setupWithStore();
      // Seed with prior metadata so 'replace' has something to discard.
      store.set('pane-x', { label: 'Old', role: 'svc' }, { workspaceId: 'ws-1' });

      await router.dispatch({
        id: 'rpc-2',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', status: 'idle', merge: false },
      });

      const entry = store.get('pane-x');
      // 'replace' wipes label/role and only status survives.
      expect(entry.metadata.label).toBeUndefined();
      expect(entry.metadata.role).toBeUndefined();
      expect(entry.metadata.status).toBe('idle');
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it("reply preserves v2.x shape — no 'version' field yet (M0-f adds it)", async () => {
      const { router } = setupWithStore();
      const res = await router.dispatch({
        id: 'rpc-shape',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', label: 'X' },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const result = res.result as { ok: boolean; paneId: string; metadata: unknown; version?: number };
        expect(result.ok).toBe(true);
        expect(result.paneId).toBe('pane-x');
        expect(result.metadata).toBeDefined();
        expect(result.version).toBeUndefined();   // v2.x compat; M0-f exposes version
      }
    });

    it('subsequent setMetadata writes bump version monotonically (paneId path)', async () => {
      const { router, store } = setupWithStore();
      await router.dispatch({
        id: 'v1', method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', label: 'A' },
      });
      await router.dispatch({
        id: 'v2', method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', status: 'running' },
      });
      const entry = store.get('pane-x');
      expect(entry.version).toBe(2);
      expect(entry.metadata.label).toBe('A');
      expect(entry.metadata.status).toBe('running');
    });

    it('rejects with a descriptive error when the merged shape blows the byte cap', async () => {
      const { router } = setupWithStore();
      const huge = 'x'.repeat(PANE_METADATA_MAX_BYTES);
      const res = await router.dispatch({
        id: 'rpc-cap',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-x', workspaceId: 'ws-1', custom: { blob: huge } },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/exceeds/);
    });

    // === Legacy fallback: paneId omitted → renderer resolves active leaf ===

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

    it('resolves active leaf via pane.resolveActiveLeaf IPC when paneId is omitted', async () => {
      // M0-b: paneId-absent path asks the renderer for the active leaf id
      // (read-only — no paneSlice write) and then commits the metadata
      // through MetadataStore. Codex P1 regression guard: a write here is
      // visible to a subsequent paneId-present read.
      const { router, store } = setupWithStore();
      sendToRendererMock.mockResolvedValueOnce({
        paneId: 'pane-active',
        workspaceId: 'ws-active',
      });
      const res = await router.dispatch({
        id: 'rpc-8',
        method: 'pane.setMetadata',
        params: { label: 'Active' },
      });
      expect(res.ok).toBe(true);
      // sendToRenderer was called for the resolve, not for a write.
      expect(sendToRendererMock).toHaveBeenCalledTimes(1);
      const [, method, payload] = sendToRendererMock.mock.calls[0];
      expect(method).toBe('pane.resolveActiveLeaf');
      expect(payload).toEqual({ workspaceId: undefined });
      // MetadataStore committed under the resolved paneId.
      const entry = store.get('pane-active');
      expect(entry.version).toBe(1);
      expect(entry.metadata.label).toBe('Active');
    });

    // === Codex P1 regression: read-after-write across paneId modes ===

    it('paneId-absent write then paneId-present read returns the committed metadata (P1 fix)', async () => {
      const { router, store } = setupWithStore();
      sendToRendererMock.mockResolvedValueOnce({
        paneId: 'pane-resolved',
        workspaceId: 'ws-1',
      });
      // Step 1: paneId-absent write — resolver returns pane-resolved.
      await router.dispatch({
        id: 'step1',
        method: 'pane.setMetadata',
        params: { label: 'WritesThrough' },
      });
      // Step 2: paneId-present read — must see the write.
      const res = await router.dispatch({
        id: 'step2',
        method: 'pane.getMetadata',
        params: { paneId: 'pane-resolved' },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        const result = res.result as { paneId: string; metadata: { label?: string } };
        expect(result.paneId).toBe('pane-resolved');
        expect(result.metadata.label).toBe('WritesThrough');
      }
      // Store reflects the same.
      expect(store.get('pane-resolved').metadata.label).toBe('WritesThrough');
    });

    // === Codex P2 regression: workspaceId remembered across paneId-only writes ===

    it('remembers workspaceId across writes — later paneId-only call still emits scoped event (P2 fix)', async () => {
      const { router, store } = setupWithStore();
      // First write establishes workspaceId on the entry.
      await router.dispatch({
        id: 'first',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-1', workspaceId: 'ws-A', label: 'one' },
      });
      // Second write omits workspaceId — must NOT erase the remembered scope.
      await router.dispatch({
        id: 'second',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-1', status: 'running' },
      });
      // Snapshot still has the original workspaceId tag.
      const snap = store.snapshot();
      const entry = snap.entries.find((e) => e.paneId === 'pane-1');
      expect(entry?.workspaceId).toBe('ws-A');
    });
  });

  describe('pane.getMetadata', () => {
    it('reads from MetadataStore when paneId is provided (no renderer round-trip)', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-x', { label: 'Backend' }, { workspaceId: 'ws-1' });

      const res = await router.dispatch({
        id: 'rpc-9',
        method: 'pane.getMetadata',
        params: { paneId: 'pane-x' },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result).toEqual({
          paneId: 'pane-x',
          metadata: expect.objectContaining({ label: 'Backend' }),
        });
      }
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it('reply preserves v2.x shape — no version field (M0-f adds it)', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-x', { label: 'Y' }, { workspaceId: 'ws-1' });
      const res = await router.dispatch({
        id: 'rpc-9b',
        method: 'pane.getMetadata',
        params: { paneId: 'pane-x' },
      });
      if (res.ok) {
        const result = res.result as { paneId: string; metadata: unknown; version?: number };
        expect(result.version).toBeUndefined();
      }
    });

    it('returns empty metadata for a pane that has never been written', async () => {
      const { router } = setupWithStore();
      const res = await router.dispatch({
        id: 'rpc-9c',
        method: 'pane.getMetadata',
        params: { paneId: 'pane-unknown' },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result).toEqual({ paneId: 'pane-unknown', metadata: {} });
      }
    });

    it('resolves active leaf via pane.resolveActiveLeaf IPC when paneId is omitted', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-active', { label: 'Hello' }, { workspaceId: 'ws-1' });
      sendToRendererMock.mockResolvedValueOnce({
        paneId: 'pane-active',
        workspaceId: 'ws-1',
      });
      const res = await router.dispatch({
        id: 'rpc-10',
        method: 'pane.getMetadata',
        params: {},
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result).toEqual({
          paneId: 'pane-active',
          metadata: expect.objectContaining({ label: 'Hello' }),
        });
      }
      const [, method] = sendToRendererMock.mock.calls[0];
      expect(method).toBe('pane.resolveActiveLeaf');
    });
  });

  describe('pane.clearMetadata', () => {
    it('clears via MetadataStore when paneId is provided (no renderer round-trip)', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-x', { label: 'Backend' }, { workspaceId: 'ws-1' });

      const res = await router.dispatch({
        id: 'rpc-11',
        method: 'pane.clearMetadata',
        params: { paneId: 'pane-x' },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result).toEqual({ ok: true, paneId: 'pane-x' });
      }
      // Store entry is cleared but version stays monotonic (clear bumped to v2).
      const after = store.get('pane-x');
      expect(after.version).toBe(2);
      expect(after.metadata).toEqual({});
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it('resolves active leaf via pane.resolveActiveLeaf IPC when paneId is omitted', async () => {
      const { router, store } = setupWithStore();
      store.set('pane-active', { label: 'X' }, { workspaceId: 'ws-1' });
      sendToRendererMock.mockResolvedValueOnce({
        paneId: 'pane-active',
        workspaceId: 'ws-1',
      });
      const res = await router.dispatch({
        id: 'rpc-11b',
        method: 'pane.clearMetadata',
        params: {},
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result).toEqual({ ok: true, paneId: 'pane-active' });
      }
      // Metadata cleared via MetadataStore, not via renderer paneSlice.
      expect(store.get('pane-active').metadata).toEqual({});
      const [, method] = sendToRendererMock.mock.calls[0];
      expect(method).toBe('pane.resolveActiveLeaf');
    });
  });

  describe('review fixes', () => {
    it('1.1 — workspaceId scopes the MetadataStore write (M0-b paneId path)', async () => {
      const { router, store } = setupWithStore();
      await router.dispatch({
        id: 'rpc-fix-1',
        method: 'pane.setMetadata',
        params: { workspaceId: 'ws-caller', paneId: 'pane-y', label: 'X' },
      });
      // The store remembers the workspaceId on the entry so subsequent
      // events emit with the right scope.
      const entry = store.get('pane-y');
      expect(entry.metadata.label).toBe('X');
      // sendToRenderer NOT called because paneId was provided.
      expect(sendToRendererMock).not.toHaveBeenCalled();
    });

    it('1.1 — forwards workspaceId on resolveActiveLeaf for getMetadata + clearMetadata', async () => {
      const { router } = setupWithStore();
      sendToRendererMock.mockResolvedValue({
        paneId: 'pane-caller-active',
        workspaceId: 'ws-caller',
      });
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
      // Both round-trip to the renderer for active-leaf resolution scoped to
      // the caller's workspace, then MetadataStore handles the read/clear.
      expect(getCall[1]).toBe('pane.resolveActiveLeaf');
      expect(getCall[2]).toEqual({ workspaceId: 'ws-caller' });
      expect(clearCall[1]).toBe('pane.resolveActiveLeaf');
      expect(clearCall[2]).toEqual({ workspaceId: 'ws-caller' });
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
      const { router } = setupWithStore();
      const custom: Record<string, string> = {};
      for (let i = 0; i < 32; i++) custom[`k${i}`] = 'v';
      const res = await router.dispatch({
        id: 'rpc-fix-8',
        method: 'pane.setMetadata',
        params: { paneId: 'pane-z', workspaceId: 'ws-1', custom },
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

    // === M0-c: MetadataStore snapshot inject into pane.list panes[] ===

    it('panes carry metadata + version joined from MetadataStore (M0-c)', async () => {
      const { router, store } = setupWithStore();
      // Seed the store with metadata for pane-meta.
      const setResult = store.set(
        'pane-meta',
        { label: 'Backend', role: 'service' },
        { workspaceId: 'ws-1' },
      );
      expect(setResult.ok).toBe(true);

      // Renderer returns the pane tree; metadata is injected by the handler.
      sendToRendererMock.mockResolvedValueOnce([
        { id: 'pane-meta', surfaceCount: 1, active: true },
      ]);

      const res = await router.dispatch({
        id: 'rpc-list-m0c-1',
        method: 'pane.list',
        params: { workspaceId: 'ws-1' },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        const result = res.result as {
          asOfSeq: number;
          bootId: string;
          panes: Array<{
            id: string;
            metadata: { label?: string; role?: string };
            version: number;
          }>;
        };
        expect(result.panes).toHaveLength(1);
        const pane = result.panes[0];
        const stored = store.get('pane-meta');
        expect(pane.version).toBe(stored.version);
        expect(pane.metadata.label).toBe(stored.metadata.label);
        expect(pane.metadata.role).toBe(stored.metadata.role);
      }
    });

    it('panes without a store entry get metadata: {} and version: 0 (M0-c)', async () => {
      const { router } = setupWithStore();
      sendToRendererMock.mockResolvedValueOnce([
        { id: 'pane-unknown', surfaceCount: 1, active: true },
      ]);

      const res = await router.dispatch({
        id: 'rpc-list-m0c-2',
        method: 'pane.list',
        params: {},
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        const result = res.result as {
          panes: Array<{ id: string; metadata: Record<string, unknown>; version: number }>;
        };
        expect(result.panes).toHaveLength(1);
        expect(result.panes[0].id).toBe('pane-unknown');
        expect(result.panes[0].metadata).toEqual({});
        expect(result.panes[0].version).toBe(0);
      }
    });
  });
});
