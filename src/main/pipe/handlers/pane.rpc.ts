import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';

type GetWindow = () => BrowserWindow | null;

export function registerPaneRpc(router: RpcRouter, getWindow: GetWindow): void {
  /**
   * pane.list — returns all panes (leaf nodes) of the current workspace
   */
  router.register('pane.list', (_params) =>
    sendToRenderer(getWindow, 'pane.list'),
  );

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
