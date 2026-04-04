import type { TeamMember, MemberStatus } from '../../types';

interface CompanyMemberItemProps {
  member: TeamMember;
  isLead: boolean;
  pendingMessageCount?: number;
  onSelect?: () => void;
}

function StatusDot({ status }: { status: MemberStatus }) {
  switch (status) {
    case 'running':
      return (
        <span className="relative flex w-1.5 h-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: 'var(--accent-blue)' }} />
          <span className="relative inline-flex rounded-full w-1.5 h-1.5" style={{ backgroundColor: 'var(--accent-blue)' }} />
        </span>
      );
    case 'complete':
      return <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: 'var(--accent-green)' }} />;
    case 'error':
      return <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: 'var(--accent-red)' }} />;
    case 'waiting':
      return <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: 'var(--accent-yellow)' }} />;
    case 'stuck':
      return <span className="w-1.5 h-1.5 rounded-full inline-block animate-pulse" style={{ backgroundColor: 'var(--accent-red)' }} />;
    case 'idle':
    default:
      return <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: 'var(--text-muted)' }} />;
  }
}

const STATUS_LABELS: Record<MemberStatus, string> = {
  idle: 'Idle',
  running: 'Running',
  complete: 'Complete',
  error: 'Error',
  waiting: 'Waiting',
  stuck: 'Stuck',
  pooled: 'Pooled',
};

const STATUS_COLORS: Record<MemberStatus, string> = {
  idle: 'var(--text-muted)',
  running: 'var(--accent-blue)',
  complete: 'var(--accent-green)',
  error: 'var(--accent-red)',
  waiting: 'var(--accent-yellow)',
  stuck: 'var(--accent-red)',
  pooled: 'var(--accent-blue)',
};

/** Abbreviate a preset slug into a 2–4 char badge label. */
function presetShortLabel(preset: string): string {
  const parts = preset.split('-');
  if (parts.length === 1) return preset.slice(0, 3).toUpperCase();
  if (parts.length === 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return parts
    .slice(0, 3)
    .map((p) => p[0]!)
    .join('')
    .toUpperCase();
}

export default function CompanyMemberItem({
  member,
  isLead,
  pendingMessageCount = 0,
  onSelect,
}: CompanyMemberItemProps) {
  const statusLabel = STATUS_LABELS[member.status] ?? 'Idle';
  const statusColor = STATUS_COLORS[member.status] ?? 'var(--text-muted)';
  const shortLabel = presetShortLabel(member.preset);
  const isProvisioned = !!member.workspaceId && !!member.ptyId;

  return (
    <div
      className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer rounded transition-colors ${
        isProvisioned ? 'hover:bg-[rgba(255,255,255,0.04)]' : 'opacity-50'
      }`}
      onClick={onSelect}
      title={isProvisioned ? `Go to ${member.name} — ${statusLabel}` : `${member.name} — not provisioned`}
    >
      {/* lead star */}
      {isLead ? (
        <span className="text-[9px] shrink-0" style={{ color: 'var(--accent-yellow)' }}>{'\u2605'}</span>
      ) : (
        <span className="w-2.5 shrink-0" />
      )}

      {/* status dot */}
      <span className="shrink-0 flex items-center">
        <StatusDot status={member.status} />
      </span>

      {/* name */}
      <span
        className={`text-[11px] font-mono flex-1 truncate ${isLead ? 'font-bold' : ''}`}
        style={{ color: 'var(--text-main)' }}
      >
        {member.name}
      </span>

      {/* pending badge */}
      {pendingMessageCount > 0 && (
        <span
          className="shrink-0 min-w-[16px] h-4 px-1 rounded-full text-[8px] font-mono font-bold flex items-center justify-center"
          style={{ backgroundColor: 'var(--accent-blue)', color: 'var(--bg-base)' }}
        >
          {pendingMessageCount > 9 ? '9+' : pendingMessageCount}
        </span>
      )}

      {/* preset label */}
      <span
        className="shrink-0 text-[8px] font-mono px-1 py-px rounded"
        style={{
          backgroundColor: 'var(--bg-surface)',
          color: statusColor,
          border: '1px solid var(--bg-overlay)',
        }}
        title={member.preset.replace(/-/g, ' ')}
      >
        {shortLabel}
      </span>
    </div>
  );
}
