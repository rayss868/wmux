import { useEffect, useRef, useState } from 'react';
import { usePlugins, refreshPlugins } from './usePlugins';
import { onPanelOpenRequest } from './pluginFrameRegistry';
import PluginFrame from './PluginFrame';
import { tokenAttrs } from '../themes';
import type { PluginHostPluginSummary } from '../../shared/pluginHost';

export function declaresEventsCapability(plugin: PluginHostPluginSummary): boolean {
  return plugin.capabilities.some(
    (c) => c === 'events.subscribe' || c.startsWith('events.subscribe:'),
  );
}

/**
 * Sidebar plugin panel host (B-1 `ui.sidebar` contribution point).
 *
 * Mount gate: only `trusted` plugins get an iframe. `unconfirmed` plugins
 * render an approve-to-enable flow through the standard ApprovalQueue
 * prompt; the host never mounts un-approved plugin DOM.
 *
 * Activation: panels are collapsed by default and the iframe mounts on
 * first expand. Two things auto-expand a panel:
 *   - `onStartup` in the manifest's activationEvents (once, when the
 *     plugin list first loads)
 *   - a palette command targeting a plugin whose frame isn't mounted
 *     (pluginFrameRegistry panel-open request; the queued command flushes
 *     when the frame registers)
 */
export default function PluginPanels() {
  const { plugins } = usePlugins();
  const [openPanels, setOpenPanels] = useState<Record<string, boolean>>({});
  const startupApplied = useRef(false);

  // onStartup activation — applied once when summaries first arrive.
  useEffect(() => {
    if (startupApplied.current || plugins.length === 0) return;
    startupApplied.current = true;
    const toOpen = plugins.filter(
      (p) => p.trustStatus === 'trusted'
        && p.contributes.sidebar
        && p.activationEvents.includes('onStartup'),
    );
    if (toOpen.length === 0) return;
    setOpenPanels((prev) => {
      const next = { ...prev };
      for (const p of toOpen) next[p.name] = true;
      return next;
    });
  }, [plugins]);

  // Palette command → expand the target panel so its frame mounts.
  useEffect(() => onPanelOpenRequest((pluginName) => {
    setOpenPanels((prev) => (prev[pluginName] ? prev : { ...prev, [pluginName]: true }));
  }), []);

  const sidebarPlugins = plugins.filter(
    (p) => p.contributes.sidebar && p.trustStatus !== 'denied',
  );
  if (sidebarPlugins.length === 0) return null;

  return (
    <div className="border-t border-[var(--bg-surface)]" {...tokenAttrs('bgSurface', 'border')}>
      {sidebarPlugins.map((plugin) => {
        const sidebar = plugin.contributes.sidebar;
        if (!sidebar) return null;
        const open = openPanels[plugin.name] === true;
        return (
          <div key={plugin.name}>
            <button
              className="w-full flex items-center justify-between px-4 py-1.5 text-[11px] font-mono text-[var(--text-subtle)] hover:text-[var(--text-main)] transition-colors"
              onClick={() => setOpenPanels((prev) => ({ ...prev, [plugin.name]: !open }))}
              title={plugin.description ?? plugin.name}
              {...tokenAttrs('textSub', 'text')}
            >
              <span className="truncate">{sidebar.title}</span>
              <span>{open ? '▾' : '▸'}</span>
            </button>
            {open && (
              plugin.trustStatus === 'trusted' ? (
                <div style={{ height: 200 }}>
                  <PluginFrame
                    pluginName={plugin.name}
                    entry={sidebar.entry}
                    forwardEvents={declaresEventsCapability(plugin)}
                  />
                </div>
              ) : (
                <div className="px-4 py-2 text-[10px] text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                  <button
                    className="underline hover:text-[var(--text-main)] transition-colors"
                    onClick={() => {
                      // Opens the standard PermissionApprovalDialog; on
                      // approve the trust store flips to trusted and the
                      // refreshed list mounts the iframe.
                      void window.electronAPI.plugins
                        .requestApproval(plugin.name)
                        .then(() => refreshPlugins())
                        .catch(() => { /* prompt dismissed / queue unavailable */ });
                    }}
                  >
                    approve to enable
                  </button>
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
