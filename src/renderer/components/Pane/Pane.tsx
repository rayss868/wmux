import { useCallback, useEffect, useState, useMemo } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import type { PaneLeaf, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import TerminalComponent from '../Terminal/Terminal';
import BrowserPanel from '../Browser/BrowserPanel';
import EditorPanel from '../Editor/EditorPanel';
import SurfaceTabs from './SurfaceTabs';
import { ErrorBoundary } from '../ErrorBoundary';
import { withDefaultShell } from '../../utils/ptyCreateOptions';

interface PaneProps {
  pane: PaneLeaf;
  // The workspace this leaf pane belongs to. Required so SurfaceTabs can
  // build a drag-export payload that names the correct workspace even in
  // multiview, where useStore(activeWorkspaceId) would pick the focused
  // tile and mis-attribute drags from sibling tiles (codex P1).
  workspace: Workspace;
  isActive: boolean;
  isWorkspaceVisible?: boolean;
}

/**
 * Ring state produced by the T8 notification listener policy and stored in
 * paneSlice's `paneNotificationRing[paneId]`. `flash` is a one-shot 500ms
 * transition (newly arrived); `glow` is the steady "still unseen" indicator.
 */
export type PaneRingState = 'flash' | 'glow' | null | undefined;

/**
 * Pure className composer for the pane container. Extracted so the wiring
 * is testable without mounting the full Pane (Terminal / SurfaceTabs pull
 * in xterm.js, electronAPI mocks, etc).
 *
 * Toggle model (OPTION C — see T11 brief):
 *   - `notificationRingEnabled` gates the LEGACY unread-count pulse (callers
 *     fold this into `hasUnread` before passing it in).
 *   - `paneRingEnabled` gates the NEW state-machine flash/glow visual. When
 *     it's false (or undefined while T5 is unmerged) the flash/glow classes
 *     are dropped regardless of `ringState`.
 */
export function composePaneClassName(opts: {
  hasUnread: boolean;
  ringState: PaneRingState;
  paneRingEnabled: boolean;
  flashing: boolean;
}): string {
  const { hasUnread, ringState, paneRingEnabled, flashing } = opts;
  const classes = ['flex', 'flex-col', 'h-full', 'w-full', 'relative', 'box-border'];
  if (hasUnread) classes.push('notification-ring');
  if (paneRingEnabled && ringState === 'flash') classes.push('pane-ring-flash');
  if (paneRingEnabled && ringState === 'glow') classes.push('pane-ring-glow');
  if (flashing) classes.push('pane-flash');
  return classes.join(' ');
}

export default function PaneComponent({ pane, workspace, isActive, isWorkspaceVisible = true }: PaneProps) {
  const t = useT();
  const [flashing, setFlashing] = useState(false);
  const setActivePane = useStore((s) => s.setActivePane);
  const setActiveSurface = useStore((s) => s.setActiveSurface);
  const addSurface = useStore((s) => s.addSurface);
  const closeSurface = useStore((s) => s.closeSurface);
  const updateSurfacePtyId = useStore((s) => s.updateSurfacePtyId);
  const markRead = useStore((s) => s.markRead);

  // count만 가져와 불필요한 배열 참조 안정성 문제 방지
  const unreadCount = useStore((s) =>
    s.notifications.filter(
      (n) => !n.read && pane.surfaces.some((surf) => surf.id === n.surfaceId),
    ).length,
  );
  const notificationRingEnabled = useStore((s) => s.notificationRingEnabled);
  const hasUnread = !isActive && unreadCount > 0 && notificationRingEnabled;

  // ─── T11: new state-machine ring (driven by T8 listener policy) ──────────
  // T3/T5 slice additions land separately. We read defensively so this
  // component compiles & behaves sanely before those merges (ringState
  // collapses to undefined → no class applied). Post-T5, `paneRingEnabled`
  // becomes a real user-visible toggle; until then we default to true so
  // the new visual is available as soon as the listener starts dispatching.
  const ringState = useStore((s) => {
    const map = (s as unknown as { paneNotificationRing?: Record<string, PaneRingState> }).paneNotificationRing;
    return map ? map[pane.id] : undefined;
  });
  const paneRingEnabled = useStore((s) => {
    const flag = (s as unknown as { paneRingEnabled?: boolean }).paneRingEnabled;
    return flag === undefined ? true : flag;
  });

  // Ctrl+Shift+H: flash the active pane
  useEffect(() => {
    if (!isActive) return;
    const handler = () => {
      setFlashing(true);
      setTimeout(() => setFlashing(false), 500);
    };
    document.addEventListener('wmux:flash-pane', handler);
    return () => document.removeEventListener('wmux:flash-pane', handler);
  }, [isActive]);

  const handleClick = useCallback(() => {
    setActivePane(pane.id);
    // 최신 state에서 직접 읽어 stale closure 방지
    const { notifications } = useStore.getState();
    const surfaceIds = new Set(pane.surfaces.map((s) => s.id));
    for (const n of notifications) {
      if (!n.read && n.surfaceId !== undefined && surfaceIds.has(n.surfaceId)) {
        markRead(n.id);
      }
    }
  }, [pane.id, pane.surfaces, setActivePane, markRead]);

  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const defaultShell = useStore((s) => s.defaultShell);
  const { invoke: ipcInvoke } = useIpc();
  const handleAddSurface = useCallback(async () => {
    const result = await ipcInvoke<{ id: string }>(() =>
      window.electronAPI.pty.create(withDefaultShell({ workspaceId: activeWorkspaceId }, defaultShell))
    );
    if (result.ok) {
      addSurface(pane.id, result.data.id, 'Terminal', '');
    }
    // On failure, useIpc already surfaced a toast. No-op here.
  }, [pane.id, addSurface, activeWorkspaceId, defaultShell, ipcInvoke]);

  const closePane = useStore((s) => s.closePane);

  const handleCloseSurface = useCallback((surfaceId: string) => {
    const surface = pane.surfaces.find((s) => s.id === surfaceId);
    if (surface?.ptyId) {
      window.electronAPI.pty.dispose(surface.ptyId);
    }
    closeSurface(pane.id, surfaceId);

    // 마지막 Surface가 닫히면 Pane도 자동 제거
    if (pane.surfaces.length <= 1) {
      closePane(pane.id);
    }
  }, [pane.id, pane.surfaces, closeSurface, closePane]);

  return (
    <div
      className={composePaneClassName({ hasUnread, ringState, paneRingEnabled, flashing })}
      style={{
        border: `1px solid ${isActive ? 'var(--accent-cursor)' : 'var(--bg-surface)'}`,
      }}
      onClick={handleClick}
      data-onboarding-target="pane-area"
    >
      <ErrorBoundary name="pane">
      <SurfaceTabs
        surfaces={pane.surfaces}
        activeSurfaceId={pane.activeSurfaceId}
        workspace={workspace}
        paneId={pane.id}
        onSelect={(surfaceId) => setActiveSurface(pane.id, surfaceId)}
        onClose={handleCloseSurface}
        onAdd={handleAddSurface}
      />

      <SplitSurfaceView
        pane={pane}
        activeSurfaceId={pane.activeSurfaceId}
        isWorkspaceVisible={isWorkspaceVisible}
        onCloseSurface={handleCloseSurface}
        onPtyCreated={(surfaceId, ptyId) => updateSurfacePtyId(pane.id, surfaceId, ptyId)}
        emptyMessage={t('pane.empty')}
      />
      </ErrorBoundary>
    </div>
  );
}

/** Renders surfaces with a resizable split when both terminals and browsers coexist */
function SplitSurfaceView({
  pane,
  activeSurfaceId,
  isWorkspaceVisible,
  onCloseSurface,
  onPtyCreated,
  emptyMessage,
}: {
  pane: PaneLeaf;
  activeSurfaceId: string;
  isWorkspaceVisible: boolean;
  onCloseSurface: (id: string) => void;
  onPtyCreated: (surfaceId: string, ptyId: string) => void;
  emptyMessage: string;
}) {
  const terminals = useMemo(
    () => pane.surfaces.filter((s) => !s.surfaceType || s.surfaceType === 'terminal'),
    [pane.surfaces],
  );
  const browsers = useMemo(
    () => pane.surfaces.filter((s) => s.surfaceType === 'browser'),
    [pane.surfaces],
  );

  const hasBoth = terminals.length > 0 && browsers.length > 0;

  if (pane.surfaces.length === 0) {
    return (
      <div className="flex-1 relative overflow-hidden flex items-center justify-center text-[var(--text-muted)] text-sm">
        {emptyMessage}
      </div>
    );
  }

  // Only terminals or only browsers — no split needed
  if (!hasBoth) {
    return (
      <div className="flex-1 relative overflow-hidden">
        {pane.surfaces.map((surface) =>
          surface.surfaceType === 'editor' ? (
            <EditorPanel
              key={surface.id}
              filePath={surface.editorFilePath || ''}
              isActive={surface.id === activeSurfaceId}
              surfaceId={surface.id}
            />
          ) : surface.surfaceType === 'browser' ? (
            <BrowserPanel
              key={`${surface.id}:${surface.browserPartition || 'persist:wmux-default'}`}
              surfaceId={surface.id}
              initialUrl={surface.browserUrl || 'https://google.com'}
              partition={surface.browserPartition || 'persist:wmux-default'}
              isActive={surface.id === activeSurfaceId}
              onClose={() => onCloseSurface(surface.id)}
            />
          ) : (
            <TerminalComponent
              key={surface.id}
              ptyId={surface.ptyId || undefined}
              isActive={surface.id === activeSurfaceId}
              isWorkspaceVisible={isWorkspaceVisible}
              onPtyCreated={(ptyId) => onPtyCreated(surface.id, ptyId)}
              scrollbackFile={surface.scrollbackFile}
            />
          ),
        )}
      </div>
    );
  }

  // Both terminals and browsers exist — resizable split
  return (
    <div className="flex-1 relative overflow-hidden">
      <Group orientation="horizontal" className="h-full w-full" resizeTargetMinimumSize={{ coarse: 37, fine: 16 }}>
        {/* Terminal panel */}
        <Panel defaultSize={50} minSize={20}>
          <div className="h-full w-full relative overflow-hidden">
            {terminals.map((surface) => (
              <TerminalComponent
                key={surface.id}
                ptyId={surface.ptyId || undefined}
                isActive={surface.id === activeSurfaceId}
                isWorkspaceVisible={isWorkspaceVisible}
                onPtyCreated={(ptyId) => onPtyCreated(surface.id, ptyId)}
                scrollbackFile={surface.scrollbackFile}
              />
            ))}
          </div>
        </Panel>

        <Separator className="w-1.5 bg-[var(--bg-surface)] hover:bg-[var(--accent-blue)] transition-colors cursor-col-resize" />

        {/* Browser panel */}
        <Panel defaultSize={50} minSize={20}>
          <div className="h-full w-full relative overflow-hidden">
            {browsers.map((surface) => (
              <BrowserPanel
                key={`${surface.id}:${surface.browserPartition || 'persist:wmux-default'}`}
                surfaceId={surface.id}
                initialUrl={surface.browserUrl || 'https://google.com'}
                partition={surface.browserPartition || 'persist:wmux-default'}
                isActive={surface.id === activeSurfaceId}
                onClose={() => onCloseSurface(surface.id)}
              />
            ))}
          </div>
        </Panel>
      </Group>
    </div>
  );
}
