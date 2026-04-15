import { useState, useCallback } from 'react';
import { useStore } from '../../stores';
import WorkspaceItem from './WorkspaceItem';
import PresetPicker from './PresetPicker';
import type { Pane, PaneLeaf, Surface } from '../../../shared/types';
import { useT } from '../../hooks/useT';

// Pane 트리에서 모든 leaf를 수집
function collectLeaves(pane: Pane): PaneLeaf[] {
  if (pane.type === 'leaf') return [pane];
  return pane.children.flatMap(collectLeaves);
}

// Pane 트리에서 모든 leaf의 PTY를 dispose
function disposeAllPtys(pane: Pane) {
  if (pane.type === 'leaf') {
    for (const s of pane.surfaces) {
      if (s.ptyId) window.electronAPI.pty.dispose(s.ptyId);
    }
  } else {
    for (const child of pane.children) disposeAllPtys(child);
  }
}

export default function Sidebar() {
  const t = useT();
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const addWorkspace = useStore((s) => s.addWorkspace);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const reorderWorkspace = useStore((s) => s.reorderWorkspace);
  const toggleMultiviewWorkspace = useStore((s) => s.toggleMultiviewWorkspace);
  const multiviewIds = useStore((s) => s.multiviewIds);
  const toggleFileTree = useStore((s) => s.toggleFileTree);
  const fileTreeVisible = useStore((s) => s.fileTreeVisible);
  const company = useStore((s) => s.company);

  const [pickerOpen, setPickerOpen] = useState(false);
  const togglePicker = useCallback(() => setPickerOpen((v) => !v), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  const handleCtrlSelect = (wsId: string) => {
    toggleMultiviewWorkspace(wsId);
  };

  const handleCopySessionInfo = async (wsId: string) => {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;

    const leaves = collectLeaves(ws.rootPane);
    const meta = ws.metadata;

    const lines: string[] = [
      `# wmux Workspace: "${ws.name}"`,
      `- Workspace ID: ${ws.id}`,
      '',
      '## Panes',
    ];

    let paneIndex = 1;
    for (const leaf of leaves) {
      const isActive = leaf.id === ws.activePaneId;
      for (const s of leaf.surfaces) {
        const surfaceType = s.surfaceType || 'terminal';
        const activeTag = isActive ? '[ACTIVE] ' : '';

        if (surfaceType === 'browser') {
          lines.push(`${paneIndex}. ${activeTag}Browser`);
          lines.push(`   - Surface ID: ${s.id}`);
          if (s.browserUrl) lines.push(`   - URL: ${s.browserUrl}`);
        } else {
          lines.push(`${paneIndex}. ${activeTag}Terminal — ${s.shell || 'unknown'}`);
          lines.push(`   - Surface ID: ${s.id}`);
          lines.push(`   - PTY ID: ${s.ptyId}`);
          const cwd = meta?.cwd || s.cwd;
          if (cwd) lines.push(`   - CWD: ${cwd}`);
          if (meta?.gitBranch) lines.push(`   - Git: ${meta.gitBranch}`);
        }
        lines.push('');
        paneIndex++;
      }
    }

    lines.push('## MCP Control');
    lines.push('- Send command: terminal_send({ text: "..." })');
    lines.push('- Target specific terminal: terminal_send({ text: "...", ptyId: "<pty-id>" })');
    lines.push('- Navigate browser: browser_navigate({ url: "...", surfaceId: "<surface-id>" })');
    lines.push('- List all surfaces: surface_list()');

    await window.clipboardAPI.writeText(lines.join('\n'));

    // Toast feedback
    const toast = document.createElement('div');
    toast.textContent = t('workspace.copied');
    toast.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);background:var(--bg-surface);color:var(--text-main);padding:4px 12px;border-radius:4px;font-size:12px;z-index:9999;opacity:0;transition:opacity .2s';
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 200); }, 1500);
  };

  const handleClose = (wsId: string) => {
    // 삭제 전 해당 워크스페이스의 모든 PTY 정리
    const ws = workspaces.find((w) => w.id === wsId);
    if (ws) disposeAllPtys(ws.rootPane);

    removeWorkspace(wsId);
  };

  return (
    <div className={`flex flex-col h-full bg-[var(--bg-mantle)] ${sidebarPosition === 'right' ? 'border-l' : 'border-r'} border-[var(--bg-surface)]`} style={{ width: 240 }}>
      {/* Header */}
      <div className="relative flex items-center justify-between px-4 py-3 border-b border-[var(--bg-surface)]">
        <span className="text-sm font-bold text-[var(--text-main)] tracking-widest font-mono">WMUX</span>
        <div className="flex items-center gap-1.5">
          {/* File tree button hidden - feature unstable
          <button
            className={`text-sm leading-none transition-colors ${fileTreeVisible ? 'text-[var(--accent-blue)]' : 'text-[var(--text-subtle)] hover:text-[var(--accent-green)]'}`}
            onClick={() => toggleFileTree()}
            title={t('sidebar.fileTreeTooltip') || 'Toggle file tree'}
          >
            {'\u{1F4C1}'}
          </button>
          */}
          <button
            className="text-[var(--text-subtle)] hover:text-[var(--accent-green)] text-lg leading-none transition-colors"
            onClick={togglePicker}
            title={t('sidebar.newWorkspaceTooltip')}
            data-onboarding-target="add-workspace"
          >
            +
          </button>
        </div>
        {pickerOpen && <PresetPicker onClose={closePicker} />}
      </div>

      {/* Workspace list */}
      <div className="flex-1 overflow-y-auto py-2 space-y-0.5">
        {workspaces.map((ws, i) => (
          <WorkspaceItem
            key={ws.id}
            workspace={ws}
            isActive={ws.id === activeWorkspaceId}
            isMultiview={multiviewIds.includes(ws.id)}
            index={i}
            onSelect={() => setActiveWorkspace(ws.id)}
            onCtrlSelect={() => handleCtrlSelect(ws.id)}
            onRename={(name) => renameWorkspace(ws.id, name)}
            onClose={() => handleClose(ws.id)}
            onCopyInfo={() => handleCopySessionInfo(ws.id)}
            onReorder={reorderWorkspace}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--bg-surface)] text-[10px] font-mono text-[var(--text-muted)]">
        <span>{workspaces.length} {t('sidebar.workspaces')}</span>
        <button
          className="text-[var(--text-muted)] hover:text-[var(--text-main)] transition-colors"
          onClick={() => useStore.getState().toggleSidebar()}
          title={t('sidebar.hideTooltip')}
        >
          ◀
        </button>
      </div>
    </div>
  );
}
