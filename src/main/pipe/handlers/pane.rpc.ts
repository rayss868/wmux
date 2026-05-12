import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import {
  PANE_METADATA_MAX_BYTES,
  PANE_METADATA_LABEL_MAX,
  PANE_METADATA_ROLE_MAX,
  PANE_METADATA_STATUS_MAX,
  PANE_METADATA_CUSTOM_KEY_MAX,
  PANE_METADATA_CUSTOM_MAX_ENTRIES,
} from '../../../shared/types';
import { eventBus } from '../../events/EventBus';
import { metadataStore, type MergeMode, type MetadataStore } from '../../metadata/MetadataStore';

type GetWindow = () => BrowserWindow | null;

interface MetadataPatchInput {
  label?: unknown;
  role?: unknown;
  status?: unknown;
  custom?: unknown;
}

interface SanitizedPatch {
  label?: string;
  role?: string;
  status?: string;
  custom?: Record<string, string>;
}

function sanitizeMetadataPatch(input: MetadataPatchInput): SanitizedPatch | { error: string } {
  const out: SanitizedPatch = {};

  if (input.label !== undefined) {
    if (typeof input.label !== 'string') return { error: '"label" must be a string' };
    if (input.label.length > PANE_METADATA_LABEL_MAX) {
      return { error: `"label" exceeds ${PANE_METADATA_LABEL_MAX} chars` };
    }
    out.label = input.label;
  }
  if (input.role !== undefined) {
    if (typeof input.role !== 'string') return { error: '"role" must be a string' };
    if (input.role.length > PANE_METADATA_ROLE_MAX) {
      return { error: `"role" exceeds ${PANE_METADATA_ROLE_MAX} chars` };
    }
    out.role = input.role;
  }
  if (input.status !== undefined) {
    if (typeof input.status !== 'string') return { error: '"status" must be a string' };
    if (input.status.length > PANE_METADATA_STATUS_MAX) {
      return { error: `"status" exceeds ${PANE_METADATA_STATUS_MAX} chars` };
    }
    out.status = input.status;
  }
  if (input.custom !== undefined) {
    if (
      typeof input.custom !== 'object' ||
      input.custom === null ||
      Array.isArray(input.custom)
    ) {
      return { error: '"custom" must be an object of string→string' };
    }
    const entries = Object.entries(input.custom);
    if (entries.length > PANE_METADATA_CUSTOM_MAX_ENTRIES) {
      return { error: `"custom" exceeds ${PANE_METADATA_CUSTOM_MAX_ENTRIES} entries` };
    }
    const custom: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (k.length === 0) {
        return { error: '"custom" key cannot be empty' };
      }
      if (k.length > PANE_METADATA_CUSTOM_KEY_MAX) {
        return { error: `"custom" key exceeds ${PANE_METADATA_CUSTOM_KEY_MAX} chars` };
      }
      if (typeof v !== 'string') {
        return { error: `"custom.${k}" must be a string` };
      }
      custom[k] = v;
    }
    out.custom = custom;
  }

  // Hard cap on serialized size — prevents bloated session.json.
  if (JSON.stringify(out).length > PANE_METADATA_MAX_BYTES) {
    return { error: `metadata exceeds ${PANE_METADATA_MAX_BYTES} bytes` };
  }
  return out;
}

/**
 * Options for registerPaneRpc — exposed so tests can inject a fresh
 * MetadataStore instance instead of the module-level singleton.
 */
export interface PaneRpcOptions {
  store?: MetadataStore;
}

export function registerPaneRpc(
  router: RpcRouter,
  getWindow: GetWindow,
  opts: PaneRpcOptions = {},
): void {
  const store = opts.store ?? metadataStore;
  /**
   * pane.list — returns all panes (leaf nodes) of the current workspace,
   * wrapped in a snapshot envelope. `asOfSeq` is the EventBus seq at the
   * moment of the snapshot — clients reconciling after a `resync` should
   * drain events with `seq > asOfSeq`. `bootId` invalidates cached state
   * across daemon restarts (mismatch ⇒ drop ALL caches, including pane ids).
   *
   * Wire shape: `{ asOfSeq: number, bootId: string, panes: PaneListEntry[] }`.
   */
  router.register('pane.list', async (params) => {
    const panes = await sendToRenderer(getWindow, 'pane.list', params);
    return {
      asOfSeq: eventBus.latestSeq(),
      bootId: eventBus.bootId,
      panes,
    };
  });

  /**
   * pane.focus — focuses a specific pane
   * params: { id: string }
   */
  router.register('pane.focus', (params) => {
    if (typeof params['id'] !== 'string') {
      return Promise.reject(new Error('pane.focus: missing required param "id"'));
    }
    return sendToRenderer(getWindow, 'pane.focus', { id: params['id'] });
  });

  /**
   * pane.split — splits the active pane
   * params: { direction: 'horizontal' | 'vertical' }
   */
  router.register('pane.split', (params) => {
    const direction = params['direction'];
    if (direction !== 'horizontal' && direction !== 'vertical') {
      return Promise.reject(
        new Error('pane.split: "direction" must be "horizontal" or "vertical"'),
      );
    }
    return sendToRenderer(getWindow, 'pane.split', { direction });
  });

  /**
   * Resolves the target pane for a metadata RPC. When the caller provides
   * `paneId`, we use it directly. When `paneId` is omitted, we ask the
   * renderer for the active leaf via the internal `pane.resolveActiveLeaf`
   * channel — read-only; paneSlice is not mutated. The result feeds into
   * MetadataStore, which remains the sole writer on the metadata surface.
   */
  async function resolveTarget(
    paneId: string | undefined,
    workspaceId: string | undefined,
  ): Promise<{ paneId: string; workspaceId: string | undefined }> {
    if (paneId) return { paneId, workspaceId };
    const resolved = (await sendToRenderer(getWindow, 'pane.resolveActiveLeaf', {
      workspaceId,
    })) as { paneId?: string; workspaceId?: string; error?: string };
    if (resolved.error || !resolved.paneId) {
      throw new Error(resolved.error ?? 'unable to resolve active leaf pane');
    }
    return {
      paneId: resolved.paneId,
      workspaceId: workspaceId ?? resolved.workspaceId,
    };
  }

  /**
   * pane.setMetadata — set descriptive metadata on a leaf pane.
   * params: { paneId?, workspaceId?, label?, role?, status?, custom?, merge? }
   *
   * M0-b: MetadataStore is the sole writer for metadata. If the caller
   * omits paneId, the handler resolves the active leaf via the internal
   * `pane.resolveActiveLeaf` channel (renderer answers with the leaf id;
   * no paneSlice write happens) and then commits via MetadataStore.set().
   * paneSlice now sees ZERO metadata writes from the RPC path — M0-d will
   * formalize this by removing the slice's setter.
   *
   * Wire shape is preserved from v2.x. The new `version` field on the reply
   * (and `expectedVersion` / `mergeMode` on params) lands with M0-f.
   *
   * External MCP callers SHOULD pass workspaceId so writes stay scoped to
   * the caller's workspace and don't get hijacked to whichever ws the user
   * is currently viewing.
   * merge defaults to true (patch-style); false replaces the metadata object.
   */
  router.register('pane.setMetadata', async (params) => {
    const paneId = typeof params['paneId'] === 'string' ? params['paneId'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    const merge = params['merge'] !== false; // default true

    const sanitized = sanitizeMetadataPatch(params as MetadataPatchInput);
    if ('error' in sanitized) {
      throw new Error(`pane.setMetadata: ${sanitized.error}`);
    }

    let target: { paneId: string; workspaceId: string | undefined };
    try {
      target = await resolveTarget(paneId, workspaceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pane.setMetadata: ${msg}`);
    }

    const mergeMode: MergeMode = merge ? 'merge' : 'replace';
    let result;
    try {
      // Passing workspaceId through unchanged (including undefined) lets
      // MetadataStore fall back to the pane's remembered workspaceId, so a
      // legacy paneId-only call doesn't clear the scope established by an
      // earlier write.
      result = store.set(target.paneId, sanitized, {
        mergeMode,
        workspaceId: target.workspaceId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pane.setMetadata: ${msg}`);
    }
    if (!result.ok) {
      // v2.x wire has no expectedVersion, so VERSION_CONFLICT is
      // unreachable today. Still report it cleanly if M0-f's wire add
      // lands a caller in this branch with expectedVersion.
      throw new Error(
        `pane.setMetadata: ${result.error} (currentVersion=${result.currentVersion})`,
      );
    }
    // v2.x-compatible reply shape: { ok, paneId, metadata }. The version
    // field lands in M0-f. Internal callers that already speak the M0
    // API can read it from `store.get(paneId).version`.
    return { ok: true, paneId: target.paneId, metadata: result.metadata };
  });

  /**
   * pane.getMetadata — read metadata for a leaf pane.
   * params: { paneId?, workspaceId? } — omitted paneId resolves to the
   * active leaf via the same `pane.resolveActiveLeaf` channel setMetadata
   * uses, so reads always see the latest MetadataStore state for the same
   * pane that a subsequent write would target.
   */
  router.register('pane.getMetadata', async (params) => {
    const paneId = typeof params['paneId'] === 'string' ? params['paneId'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;

    let target: { paneId: string; workspaceId: string | undefined };
    try {
      target = await resolveTarget(paneId, workspaceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pane.getMetadata: ${msg}`);
    }

    const entry = store.get(target.paneId);
    // v2.x-compatible reply shape: { paneId, metadata }. M0-f adds version.
    return { paneId: target.paneId, metadata: entry.metadata };
  });

  /**
   * pane.clearMetadata — drop all metadata for a leaf pane.
   * params: { paneId?, workspaceId? }
   *
   * Same resolution as setMetadata. The renderer is consulted only to
   * resolve the active leaf; the actual clear happens against MetadataStore.
   */
  router.register('pane.clearMetadata', async (params) => {
    const paneId = typeof params['paneId'] === 'string' ? params['paneId'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;

    let target: { paneId: string; workspaceId: string | undefined };
    try {
      target = await resolveTarget(paneId, workspaceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pane.clearMetadata: ${msg}`);
    }

    const result = store.clear(target.paneId);
    return result.ok
      ? { ok: true, paneId: target.paneId }
      : { ok: false, paneId: target.paneId, error: result.error };
  });

  /**
   * pane.search — cross-pane search across a workspace's live panes
   * params: { query: string, regex?: boolean, workspaceId?: string }
   *
   * The `workspaceId` (when present) is forwarded so the renderer handler
   * (C1 fix) can scope the search to the CALLING workspace rather than
   * whichever workspace the user happens to be viewing in the UI. Internal
   * renderer callers omit it and the handler falls back to the active
   * workspace. Cross-workspace search is deferred to v2 (D9).
   */
  router.register('pane.search', (params) => {
    if (typeof params['query'] !== 'string' || params['query'].length === 0) {
      return Promise.reject(new Error('pane.search: "query" must be a non-empty string'));
    }
    const regex = params['regex'];
    if (regex !== undefined && typeof regex !== 'boolean') {
      return Promise.reject(new Error('pane.search: "regex" must be a boolean if provided'));
    }
    const workspaceId = params['workspaceId'];
    if (workspaceId !== undefined && typeof workspaceId !== 'string') {
      return Promise.reject(
        new Error('pane.search: "workspaceId" must be a string if provided'),
      );
    }
    return sendToRenderer(getWindow, 'pane.search', {
      query: params['query'],
      ...(regex !== undefined && { regex }),
      ...(workspaceId !== undefined && { workspaceId }),
    });
  });
}
