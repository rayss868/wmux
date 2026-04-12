import { useState, useEffect, useMemo } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import type { Pane, PaneLeaf } from '../../../shared/types';

/** Resolve the ptyId of the active pane's active surface */
function getActivePtyId(rootPane: Pane | undefined, activePaneId: string): string | null {
  if (!rootPane) return null;
  const findLeaf = (pane: Pane): PaneLeaf | null => {
    if (pane.type === 'leaf') return pane.id === activePaneId ? pane : null;
    for (const child of pane.children) {
      const found = findLeaf(child);
      if (found) return found;
    }
    return null;
  };
  const leaf = findLeaf(rootPane);
  if (!leaf) return null;
  const surface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  return surface?.ptyId ?? null;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function StatusBar() {
  const t = useT();
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId);
  const unreadCount = useStore((s) => s.notifications.filter((n) => !n.read).length);
  const toggleSettingsPanel = useStore((s) => s.toggleSettingsPanel);
  const tokenDataByPty = useStore((s) => s.tokenDataByPty);

  // Company 모드 비용 정보
  const sidebarMode = useStore((s) => s.sidebarMode);
  const totalCost = useStore((s) => s.company?.totalCostEstimate ?? 0);
  const sessionStartTime = useStore((s) => s.sessionStartTime);

  const [time, setTime] = useState(new Date());
  const [memUsage, setMemUsage] = useState('');
  const [sessionMin, setSessionMin] = useState(0);

  // Update clock every second
  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date());
      if (sessionStartTime) {
        setSessionMin(Math.floor((Date.now() - sessionStartTime) / 60_000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

  // Update memory usage every 5 seconds
  useEffect(() => {
    const update = () => {
      const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
      if (perf.memory) {
        setMemUsage(`${Math.round(perf.memory.usedJSHeapSize / 1024 / 1024)}MB`);
      }
    };
    update();
    const timer = setInterval(update, 5000);
    return () => clearInterval(timer);
  }, []);

  const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const branch = activeWs?.metadata?.gitBranch;
  const isCompanyMode = sidebarMode === 'company';

  // Token/cost for the active pane
  const activePtyId = useMemo(
    () => getActivePtyId(activeWs?.rootPane, activeWs?.activePaneId ?? ''),
    [activeWs?.rootPane, activeWs?.activePaneId],
  );
  const activeTokenData = activePtyId ? tokenDataByPty[activePtyId] : undefined;

  return (
    <div className="flex items-center justify-between h-6 px-3 border-b border-[var(--bg-surface)] text-[10px] text-[var(--text-muted)] shrink-0 select-none font-mono" style={{ backgroundColor: 'var(--bg-mantle)' }}>
      {/* Left: workspace + branch */}
      <div className="flex items-center gap-3">
        <span className="text-[var(--text-main)] font-medium">{activeWs?.name || 'wmux'}</span>
        {branch && (
          <span>
            <span className="text-[var(--accent-yellow)]">⎇</span> {branch}
          </span>
        )}
        {/* Company 모드 배지 */}
        {isCompanyMode && (
          <span className="text-[8px] font-mono px-1.5 py-px bg-[var(--bg-surface)] text-[var(--accent-blue)] rounded">
            {t('statusBar.company')}
          </span>
        )}
      </div>

      {/* Right: status indicators */}
      <div className="flex items-center gap-3">
        {/* Company 모드일 때 비용 표시 */}
        {isCompanyMode && (
          <span className="text-[var(--text-sub2)]" title={t('statusBar.session', { min: sessionMin })}>
            ~${totalCost.toFixed(2)}
          </span>
        )}
        {activeTokenData && activeTokenData.totalCost > 0 && (
          <span className="text-[var(--text-sub2)]" title={`Input: ${formatTokenCount(activeTokenData.inputTokens)} / Output: ${formatTokenCount(activeTokenData.outputTokens)}`}>
            {'\u26A1'} {formatTokenCount(activeTokenData.totalTokens)} tokens {'\u00B7'} ${activeTokenData.totalCost.toFixed(2)}
          </span>
        )}
        {unreadCount > 0 && (
          <span className="text-[var(--accent-blue)]">
            ● {unreadCount}
          </span>
        )}
        {memUsage && <span>{memUsage}</span>}
        <span>{timeStr}</span>
        <button
          onClick={toggleSettingsPanel}
          className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors ml-1"
          title={t('statusBar.settingsTooltip')}
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
