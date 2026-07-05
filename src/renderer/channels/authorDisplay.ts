// ─── Channel sender identity display (identity audit 1a) ─────────────────
//
// The transcript used to render `memberName` alone — a free-form string the
// SENDER supplies on every post (MCP `channel_post` `member_name`). Every
// Claude Code pane passes the same product name, so multiple agents collapsed
// into one indistinguishable "Claude Code" author. The forgery-resistant
// disambiguators the daemon already persists on the message — `memberId`
// (the pane auto-name, e.g. "w26-1(claude)") and `workspaceId` — were never
// shown. This module derives the author line from those stored fields:
//
//   agent → primary = memberName (fallback memberId), chip = memberId
//           (skipped when the primary already carries it)
//   human → primary = the localized "Me" (substituted by the component),
//           chip = the workspace name (every GUI seat shares the reserved
//           'local-ui' member id, so the workspace IS the seat's identity)
//
// Server-owned roster names (remediation plan Phase 1b) will replace the
// free-form primary later; this layer is schema-free and works on history.

export interface ChannelAuthorDisplay {
  kind: 'human' | 'agent';
  /** Primary author label. Empty for a human sender — the component
   *  substitutes the localized "Me" (i18n stays out of this module). */
  primary: string;
  /** Muted identity chip: the pane memberId for agents, the workspace name
   *  for humans. null when it would only repeat the primary label. */
  chip: string | null;
  /** Stable per-workspace hue (0-359) for the author color badge. */
  hue: number;
}

/** The reserved GUI member id (one human seat per workspace). Matches the
 *  daemon's reserved identity — see a2a.channel.rpc.ts (pipe spoof reject). */
const HUMAN_MEMBER_ID = 'local-ui';

/** Deterministic workspaceId → hue. The same workspace always renders the
 *  same badge color across sessions; distinct workspaces usually differ. */
export function workspaceHue(workspaceId: string): number {
  let h = 0;
  for (let i = 0; i < workspaceId.length; i++) {
    h = (h * 31 + workspaceId.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/** Shorten an opaque id for display when no name resolves ("ws-72ca48f2…"). */
function shortId(id: string): string {
  return id.length > 11 ? `${id.slice(0, 11)}…` : id;
}

/**
 * Derive the transcript author line for one message. `memberName` is typed
 * `string` in the schema, but live data contains `null` (legacy renderer
 * posts) — treated as absent rather than rendered as a blank author line.
 */
export function formatChannelAuthor(
  message: { workspaceId: string; memberId: string; memberName?: string | null },
  resolveWorkspaceName: (workspaceId: string) => string | undefined,
): ChannelAuthorDisplay {
  const hue = workspaceHue(message.workspaceId);
  const memberId = typeof message.memberId === 'string' ? message.memberId.trim() : '';
  const memberName = typeof message.memberName === 'string' ? message.memberName.trim() : '';

  // Keyed on memberId ONLY: memberName is sender-supplied free text, so an
  // agent naming itself "local-ui" must NOT render as the human seat (the
  // pipe rejects that name, but the display layer pins it too; ship review).
  if (memberId === HUMAN_MEMBER_ID) {
    const ws = resolveWorkspaceName(message.workspaceId)?.trim();
    return { kind: 'human', primary: '', chip: ws || shortId(message.workspaceId), hue };
  }

  const primary = memberName || memberId || shortId(message.workspaceId);
  // Skip the chip when the primary already carries the pane identity — e.g.
  // memberName "w16-1(claude)" with memberId "w16-1" (live naming drift).
  const chip = memberId && !primary.includes(memberId) ? memberId : null;
  return { kind: 'agent', primary, chip, hue };
}

export interface RosterMemberLabel {
  /** Primary roster label. Empty for the viewer's own row — the component
   *  substitutes the localized "Me". */
  primary: string;
  /** Append the " · <workspace>" suffix. Skipped when the primary already
   *  IS the workspace label (a non-self human seat). */
  showWorkspaceSuffix: boolean;
}

/**
 * Roster row label (identity audit C-A3). Keying on `memberId ===
 * selfMemberId` alone mislabels EVERY workspace's GUI seat as "Me" — they
 * all share the reserved member id. Only the viewer's own (workspace,
 * member) row is "Me"; another workspace's human seat reads as that
 * workspace's name.
 */
export function rosterMemberLabel(
  member: { workspaceId: string; memberId: string },
  selfWorkspaceId: string | null,
  selfMemberId: string,
  workspaceLabel: string,
): RosterMemberLabel {
  const isSelf = member.workspaceId === selfWorkspaceId && member.memberId === selfMemberId;
  if (isSelf) return { primary: '', showWorkspaceSuffix: true };
  if (member.memberId === selfMemberId) {
    // Another workspace's human seat — the workspace is its identity.
    return { primary: workspaceLabel, showWorkspaceSuffix: false };
  }
  return { primary: member.memberId, showWorkspaceSuffix: true };
}
