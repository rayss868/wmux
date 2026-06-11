import { useEffect } from 'react';
import { useStore } from '../stores';

/**
 * Subscribes to the `ui.decoratePane` push channel (B-1) and writes
 * decorations into uiSlice. Mounted once from AppLayout — the subscription
 * is app-global, not per-pane.
 */
export function usePaneDecorationChannel(): void {
  useEffect(() => {
    const unsubscribe = window.electronAPI.plugins.onPaneDecoration((d) => {
      if (!d || typeof d.plugin !== 'string' || typeof d.paneId !== 'string') return;
      useStore.getState().setPluginPaneDecoration(
        d.plugin,
        d.paneId,
        d.badge === null
          ? null
          : {
              badge: d.badge,
              ...(d.tooltip !== undefined ? { tooltip: d.tooltip } : {}),
              ...(d.color !== undefined ? { color: d.color } : {}),
            },
      );
    });
    return unsubscribe;
  }, []);
}
