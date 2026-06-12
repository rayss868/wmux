// ─── Browser-pane actions (store/DOM binder) ─────────────────────────────────
// Thin bindings of the pure browserPane.ts algorithm to the real zustand
// store, document CustomEvents and electronAPI. Kept separate so the pure
// module stays importable from node-env vitest. Do NOT import this file from
// tests.

import { useStore } from '../stores';
import { findSurfaceByPtyId } from './paneTraversal';
import {
  BROWSER_NAVIGATE_EVENT,
  openUrlInBrowserPaneImpl,
  resolveTerminalUrlAction,
  type BrowserNavigateDetail,
  type OpenUrlOptions,
  type OpenUrlResult,
} from './browserPane';

/** Open (or reuse) a browser pane showing `url`. See openUrlInBrowserPaneImpl. */
export function openUrlInBrowserPane(url?: string, opts: OpenUrlOptions = {}): OpenUrlResult {
  return openUrlInBrowserPaneImpl(url, opts, {
    getState: () => useStore.getState(),
    dispatchNavigate: (detail: BrowserNavigateDetail) =>
      document.dispatchEvent(new CustomEvent<BrowserNavigateDetail>(BROWSER_NAVIGATE_EVENT, { detail })),
  });
}

/**
 * Route a URL clicked inside a terminal (web-links addon or the link context
 * menu). Smart policy: localhost → browser pane, everything else → system
 * browser; Ctrl/Cmd inverts. The owning workspace is resolved explicitly or
 * by ptyId reverse lookup — in multiview the clicked terminal may belong to a
 * non-active tile, where activeWorkspaceId would lie.
 */
export function openTerminalUrl(
  url: string,
  opts: { modifierHeld?: boolean; ptyId?: string; workspaceId?: string } = {},
): void {
  if (resolveTerminalUrlAction(url, opts.modifierHeld === true) === 'external') {
    void window.electronAPI.shell.openExternal(url);
    return;
  }

  let workspaceId = opts.workspaceId;
  if (!workspaceId && opts.ptyId) {
    const state = useStore.getState();
    for (const ws of state.workspaces) {
      if (findSurfaceByPtyId(ws.rootPane, opts.ptyId)) {
        workspaceId = ws.id;
        break;
      }
    }
  }

  const result = openUrlInBrowserPane(url, { workspaceId });
  // pane-cap already surfaced its own toast; any other failure falls back to
  // the system browser so the click never dies silently.
  if (!result.ok && result.error !== 'pane-cap') {
    void window.electronAPI.shell.openExternal(url);
  }
}
