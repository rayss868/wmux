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

export function registerPaneRpc(router: RpcRouter, getWindow: GetWindow): void {
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
   * pane.setMetadata — set descriptive metadata on a leaf pane.
   * params: { paneId?, workspaceId?, label?, role?, status?, custom?, merge? }
   * External MCP callers SHOULD pass workspaceId so writes stay scoped to the
   * caller's workspace and don't get hijacked to whichever ws the user is
   * currently viewing. paneId omitted → active pane in the targeted workspace.
   * merge defaults to true (patch-style); false replaces the metadata object.
   */
  router.register('pane.setMetadata', (params) => {
    const paneId = typeof params['paneId'] === 'string' ? params['paneId'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    const merge = params['merge'] !== false; // default true

    const sanitized = sanitizeMetadataPatch(params as MetadataPatchInput);
    if ('error' in sanitized) {
      return Promise.reject(new Error(`pane.setMetadata: ${sanitized.error}`));
    }
    return sendToRenderer(getWindow, 'pane.setMetadata', {
      paneId,
      workspaceId,
      patch: sanitized,
      merge,
    });
  });

  /**
   * pane.getMetadata — read metadata for a leaf pane.
   * params: { paneId?, workspaceId? } — omitted workspaceId → active workspace.
   */
  router.register('pane.getMetadata', (params) => {
    const paneId = typeof params['paneId'] === 'string' ? params['paneId'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    return sendToRenderer(getWindow, 'pane.getMetadata', { paneId, workspaceId });
  });

  /**
   * pane.clearMetadata — drop all metadata for a leaf pane.
   * params: { paneId?, workspaceId? }
   */
  router.register('pane.clearMetadata', (params) => {
    const paneId = typeof params['paneId'] === 'string' ? params['paneId'] : undefined;
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
    return sendToRenderer(getWindow, 'pane.clearMetadata', { paneId, workspaceId });
  });
}
