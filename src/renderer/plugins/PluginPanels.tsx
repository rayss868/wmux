import { useState } from 'react';
import { usePlugins, refreshPlugins } from './usePlugins';
import PluginFrame from './PluginFrame';
import { tokenAttrs } from '../themes';

/**
 * Sidebar plugin panel host (B-1 `ui.sidebar` contribution point).
 *
 * Mount gate: only `trusted` plugins get an iframe. `unconfirmed` plugins
 * render a passive placeholder — approval flows through the existing
 * Phase 2.2 prompt the first time the plugin's RPC is rejected, or via the
 * trust DB; the host never mounts un-approved plugin DOM.
 *
 * Activation: panels are collapsed by default and the iframe mounts on
 * first expand (lazy `onStartup`-equivalent), so a dormant plugin costs
 * nothing.
 */
export default function PluginPanels() {
  const { plugins } = usePlugins();
  const [openPanels, setOpenPanels] = useState<Record<string, boolean>>({});

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
                  <PluginFrame pluginName={plugin.name} entry={sidebar.entry} />
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
