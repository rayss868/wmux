import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { resolveExecuteApproval } from '../../utils/executeApproval';

/**
 * Approval prompt for `a2a_task_send` requests with `execute: true`.
 * Without this gate, any external MCP caller could spawn an unattended
 * Claude CLI in `--permission-mode bypassPermissions` mode in our workspace.
 */
export default function ExecuteApprovalDialog() {
  const approval = useStore((s) => s.pendingExecuteApproval);
  const workspaces = useStore((s) => s.workspaces);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!approval) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [approval]);

  if (!approval) return null;

  const senderName = workspaces.find((w) => w.id === approval.senderWorkspaceId)?.name ?? approval.senderWorkspaceId ?? 'unknown sender';
  const receiverName = workspaces.find((w) => w.id === approval.receiverWorkspaceId)?.name ?? approval.receiverWorkspaceId ?? 'unknown receiver';
  // Same-workspace execute (an agent asking to spawn an autonomous agent in its
  // OWN workspace). The default "remote A2A caller … in this workspace" wording
  // implies an inter-workspace handoff and reads as harmless; be explicit so the
  // user isn't social-engineered into waving through a self-spawned bypass agent.
  const sameWs = !!approval.senderWorkspaceId && approval.senderWorkspaceId === approval.receiverWorkspaceId;
  const remainingMs = Math.max(0, approval.expiresAt - now);
  const remainingSec = Math.ceil(remainingMs / 1000);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.65)' }}
      role="alertdialog"
      aria-labelledby="execute-approval-title"
    >
      <div
        className="flex flex-col gap-4 p-5 rounded-xl"
        style={{
          width: 460,
          maxWidth: '90vw',
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--accent-red)',
          boxShadow: '0 25px 60px rgba(0,0,0,0.75)',
        }}
      >
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--accent-red)', fontSize: 18 }}>⚠</span>
          <p
            id="execute-approval-title"
            className="text-sm font-semibold font-mono"
            style={{ color: 'var(--text-main)' }}
          >
            Background execution requested
          </p>
        </div>
        <p className="text-xs" style={{ color: 'var(--text-sub)' }}>
          {sameWs ? (
            <>
              An agent in <span style={{ color: 'var(--accent-red)' }}>this workspace</span> wants to spawn
              another autonomous Claude CLI with{' '}
              <span style={{ color: 'var(--accent-red)' }}>bypassPermissions</span> in the same workspace.
            </>
          ) : (
            <>
              A remote A2A caller wants to spawn a Claude CLI with{' '}
              <span style={{ color: 'var(--accent-red)' }}>bypassPermissions</span> in this workspace.
            </>
          )}
        </p>
        <div
          className="text-xs font-mono flex flex-col gap-1 p-3 rounded-md"
          style={{ backgroundColor: 'var(--bg-mantle)', color: 'var(--text-sub2)' }}
        >
          <div><span style={{ color: 'var(--text-subtle)' }}>from:</span> {senderName}</div>
          <div><span style={{ color: 'var(--text-subtle)' }}>to:</span> {receiverName}</div>
          {approval.cwd ? (
            <div><span style={{ color: 'var(--text-subtle)' }}>cwd:</span> {approval.cwd}</div>
          ) : null}
          <div><span style={{ color: 'var(--text-subtle)' }}>task:</span> {approval.taskId}</div>
        </div>
        <div
          className="text-xs font-mono p-3 rounded-md whitespace-pre-wrap break-words"
          style={{
            backgroundColor: 'var(--bg-surface)',
            color: 'var(--text-main)',
            maxHeight: 160,
            overflowY: 'auto',
          }}
        >
          {approval.messagePreview || '<empty message>'}
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
            auto-deny in {remainingSec}s
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => resolveExecuteApproval(false)}
              className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-subtle)' }}
            >
              Deny
            </button>
            <button
              onClick={() => resolveExecuteApproval(true)}
              className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{ backgroundColor: 'var(--accent-red)', color: 'var(--bg-base)' }}
            >
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
