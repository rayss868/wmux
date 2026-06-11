import { usePlugins } from './usePlugins';
import PluginFrame from './PluginFrame';

/**
 * Status-bar widget host (B-1 `ui.statusbar` contribution point). Mounts
 * one fixed-size sandboxed iframe per trusted plugin that contributes a
 * widget. Same trust gate as PluginPanels: trusted-only, denied hidden,
 * unconfirmed not mounted (status bar has no room for placeholders).
 */
export default function PluginStatusBarWidgets({ alignment }: { alignment: 'left' | 'right' }) {
  const { plugins } = usePlugins();
  const widgets = plugins.filter(
    (p) =>
      p.trustStatus === 'trusted' &&
      p.contributes.statusbar &&
      (p.contributes.statusbar.alignment ?? 'right') === alignment,
  );
  if (widgets.length === 0) return null;
  return (
    <>
      {widgets.map((plugin) => {
        const statusbar = plugin.contributes.statusbar;
        if (!statusbar) return null;
        return (
          <div key={plugin.name} style={{ width: 120, height: 20, overflow: 'hidden' }} title={plugin.name}>
            <PluginFrame pluginName={plugin.name} entry={statusbar.entry} />
          </div>
        );
      })}
    </>
  );
}
