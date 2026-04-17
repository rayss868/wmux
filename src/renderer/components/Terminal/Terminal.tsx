import { useRef, useEffect, useState, useCallback } from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import { useStore } from '../../stores';
import { useIpc } from '../../hooks/useIpc';
import ViCopyMode from './ViCopyMode';
import SearchBar from './SearchBar';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  ptyId?: string;
  shell?: string;
  cwd?: string;
  onPtyCreated?: (ptyId: string) => void;
  /** True when this surface tab is the selected tab inside its pane. */
  isActive?: boolean;
  /** True when the parent workspace is the currently visible workspace.
   *  False when the workspace is hidden via display:none in AppLayout.
   *  Defaults to true so callers that don't use the all-workspaces rendering
   *  pattern continue to work without changes. */
  isWorkspaceVisible?: boolean;
  /** If set, scrollback content will be restored from this file on mount */
  scrollbackFile?: string;
}

export default function TerminalComponent({ ptyId: externalPtyId, shell, cwd, onPtyCreated, isActive = true, isWorkspaceVisible = true, scrollbackFile }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ptyId, setPtyId] = useState<string | null>(externalPtyId || null);
  const creatingRef = useRef(false);
  const [restoring, setRestoring] = useState(!!scrollbackFile);

  const viCopyModeActive = useStore((s) => s.viCopyModeActive);
  const setViCopyModeActive = useStore((s) => s.setViCopyModeActive);
  const searchBarVisible = useStore((s) => s.searchBarVisible);
  const setSearchBarVisible = useStore((s) => s.setSearchBarVisible);
  const { invoke: ipcInvoke } = useIpc();
  // Keep the invoker stable across re-renders without re-triggering the PTY
  // creation effect below.
  const ipcInvokeRef = useRef(ipcInvoke);
  ipcInvokeRef.current = ipcInvoke;

  // Hide restoring overlay when first data arrives
  const handleFirstData = useCallback(() => setRestoring(false), []);

  // Fallback: hide restoring overlay after 3 seconds even if no data arrives
  useEffect(() => {
    if (!restoring) return;
    const timer = setTimeout(() => setRestoring(false), 3000);
    return () => clearTimeout(timer);
  }, [restoring]);

  useEffect(() => {
    console.log(`[Terminal] useEffect: externalPtyId=${externalPtyId}, scrollbackFile=${scrollbackFile}`);
    if (externalPtyId) {
      console.log(`[Terminal] Using existing ptyId: ${externalPtyId}`);
      setPtyId(externalPtyId);
      return;
    }

    if (creatingRef.current) return;
    creatingRef.current = true;

    let cancelled = false;

    // Estimate initial terminal size from container so the shell banner
    // is formatted for the actual viewport, preventing cursor misalignment.
    const container = containerRef.current;
    let cols: number | undefined;
    let rows: number | undefined;
    if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
      const fontSize = useStore.getState().terminalFontSize || 13;
      const fontFamily = useStore.getState().terminalFontFamily || 'Cascadia Code';
      const padding = 8;

      // Measure actual character dimensions using a canvas probe instead of
      // hardcoded ratios, so CJK fonts and varying DPI are handled correctly.
      let charWidth: number;
      let lineHeight: number;
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        ctx.font = `${fontSize}px '${fontFamily}', Consolas, 'Courier New', 'Malgun Gothic', monospace`;
        charWidth = ctx.measureText('W').width;
        lineHeight = fontSize * 1.2;
      } catch {
        charWidth = fontSize * 0.6;
        lineHeight = fontSize * 1.2;
      }

      cols = Math.max(2, Math.floor((container.offsetWidth - padding) / charWidth));
      rows = Math.max(2, Math.floor((container.offsetHeight - padding) / lineHeight));
    }

    const workspaceId = useStore.getState().activeWorkspaceId;
    console.log(`[Terminal] Creating new PTY: shell=${shell}, cwd=${cwd}, cols=${cols}, rows=${rows}, ws=${workspaceId}`);
    void ipcInvokeRef.current<{ id: string }>(() =>
      window.electronAPI.pty.create({ shell, cwd, cols, rows, workspaceId })
    ).then((result) => {
      if (!result.ok) {
        // Toast surfaced by useIpc (e.g. DAEMON_DISCONNECTED). Nothing to do.
        return;
      }
      if (cancelled) {
        // 이미 unmount됨 — PTY 정리
        window.electronAPI.pty.dispose(result.data.id);
        return;
      }
      setPtyId(result.data.id);
      onPtyCreated?.(result.data.id);
    });

    return () => { cancelled = true; };
  }, [externalPtyId, shell, cwd]); // onPtyCreated 제거 (stale closure 방지)

  // isVisible = workspace is shown AND this surface tab is the active one.
  // useTerminal uses this to skip fit() when the container is display:none.
  const isVisible = isWorkspaceVisible && isActive;
  const { terminal: terminalRef, findNext, findPrevious, clearSearch } = useTerminal(containerRef, { ptyId, isVisible, scrollbackFile, onFirstData: scrollbackFile ? handleFirstData : undefined });

  const showViCopyMode = viCopyModeActive && isActive && terminalRef.current !== null;
  const showSearchBar = searchBarVisible && isActive;

  const handleCloseSearch = () => {
    clearSearch();
    setSearchBarVisible(false);
  };

  return (
    <div
      style={{
        display: isActive ? 'flex' : 'none',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        position: 'relative',
      }}
    >
      {/* Session restore overlay */}
      {restoring && (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] text-sm font-mono z-10 pointer-events-none">
          Restoring session...
        </div>
      )}

      {/* xterm mount point */}
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', padding: '4px' }}
      />

      {/* Search bar overlay */}
      {showSearchBar && (
        <SearchBar
          onFindNext={findNext}
          onFindPrevious={findPrevious}
          onClose={handleCloseSearch}
        />
      )}

      {/* Vi Copy Mode overlay — rendered inside the relative wrapper */}
      {showViCopyMode && terminalRef.current && (
        <ViCopyMode
          terminal={terminalRef.current}
          onExit={() => setViCopyModeActive(false)}
        />
      )}
    </div>
  );
}
