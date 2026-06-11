// ui.decoratePane — plugin-host pane decoration RPC (B-1).
//
// Decorations are DATA rendered by the host (a small badge on the pane
// header area), never plugin DOM inside a pane. Capability gating
// (`ui.pane-decoration`) happens in the shared enforcement path via
// methodCapabilityMap; this handler only validates/sanitizes the payload
// and forwards it to the renderer.
//
// Identity: the decoration is keyed by the caller's clientName so two
// plugins can decorate the same pane independently and clearing is scoped
// to the caller. Envelope-less callers are rejected — an anonymous
// decoration could neither be attributed nor cleared.

import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { IPC } from '../../../shared/constants';

type GetWindow = () => BrowserWindow | null;

export interface PluginPaneDecoration {
  plugin: string;
  paneId: string;
  /** null clears this plugin's decoration on the pane. */
  badge: string | null;
  tooltip?: string;
  /** Theme-token color name — the renderer maps it to a CSS variable.
   *  A free-form CSS color is deliberately not accepted. */
  color?: 'accent' | 'red' | 'yellow' | 'green' | 'blue';
}

const MAX_BADGE_CHARS = 12;
const MAX_TOOLTIP_CHARS = 256;
const VALID_COLORS = new Set(['accent', 'red', 'yellow', 'green', 'blue']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

export function registerUiPluginRpc(router: RpcRouter, getWindow: GetWindow): void {
  router.register('ui.decoratePane', (params, ctx) => {
    const plugin = ctx?.clientName;
    if (!plugin) {
      throw new Error('ui.decoratePane: requires a plugin identity (clientName)');
    }
    const paneId = params['paneId'];
    if (typeof paneId !== 'string' || paneId.length === 0 || paneId.length > 64) {
      throw new Error('ui.decoratePane: invalid paneId');
    }

    const rawBadge = params['badge'];
    let badge: string | null;
    if (rawBadge === null || rawBadge === undefined) {
      badge = null;
    } else if (typeof rawBadge === 'string') {
      badge = rawBadge.replace(CONTROL_CHARS, '').slice(0, MAX_BADGE_CHARS).trim();
      if (badge.length === 0) badge = null;
    } else {
      throw new Error('ui.decoratePane: badge must be a string or null');
    }

    let tooltip: string | undefined;
    if (params['tooltip'] !== undefined) {
      if (typeof params['tooltip'] !== 'string') {
        throw new Error('ui.decoratePane: tooltip must be a string');
      }
      tooltip = params['tooltip'].replace(CONTROL_CHARS, '').slice(0, MAX_TOOLTIP_CHARS);
    }

    let color: PluginPaneDecoration['color'];
    if (params['color'] !== undefined) {
      if (typeof params['color'] !== 'string' || !VALID_COLORS.has(params['color'])) {
        throw new Error('ui.decoratePane: color must be one of accent|red|yellow|green|blue');
      }
      color = params['color'] as PluginPaneDecoration['color'];
    }

    const decoration: PluginPaneDecoration = {
      plugin,
      paneId,
      badge,
      ...(tooltip !== undefined ? { tooltip } : {}),
      ...(color !== undefined ? { color } : {}),
    };

    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PLUGIN_PANE_DECORATION, decoration);
    }
    return Promise.resolve({ applied: badge !== null, cleared: badge === null });
  });
}
