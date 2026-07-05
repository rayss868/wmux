// 4d (channels remediation) — boot-time agent-candidate seeding.
//
// Symptom: right after `npm start`, live (recovered) agent panes in
// workspaces the user has not VISITED yet never show up in the "Add an
// agent pane" roster picker or the @-mention candidates. Candidate
// eligibility is gated on `surfaceAgent[ptyId]?.name`, and that map is
// populated only by live agent detection (banner gate → session:agent →
// useNotificationListener), which fires on terminal output — an unvisited
// workspace produces none.
//
// Fix: at boot hydration (the same pty.list pass that seeds supervision /
// resume state), ask the daemon's AgentDetector directly for each session
// that has no surfaceAgent entry yet (`metadata.resolveAgent`, the same
// authoritative pull the running-status backfill uses) and seed the map.
// Live detection later overwrites the seed (setSurfaceAgent keeps newer
// names/statuses), so a stale seed self-heals on visit.
//
// Pure decision logic lives here (repo precedent: planChannelMessageDelivery,
// authorDisplay) so the seeding rules are unit-testable without mounting
// AppLayout.

import type { AgentSlug } from '../../shared/events';

const AGENT_SLUGS: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'gemini',
  'aider',
  'opencode',
  'copilot',
] satisfies AgentSlug[]);

/** Narrow a daemon-reported agent name to a known slug (the detector's
 *  `lastAgent` IS the slug — 'claude', 'codex', … — but type it defensively:
 *  an unknown future value seeds the name without a slug, so the auto-name
 *  suffix simply stays generic instead of lying). */
export function asAgentSlug(name: string): AgentSlug | undefined {
  return AGENT_SLUGS.has(name) ? (name as AgentSlug) : undefined;
}

/**
 * Which hydrated sessions need a boot-time agent-identity pull? Only those
 * with NO detected name yet — a live detection (or a previous seed) must
 * never be re-queried or overwritten by a slower boot pull.
 */
export function planAgentCandidateSeed(
  sessionIds: readonly string[],
  surfaceAgent: Readonly<Record<string, { name: string } | undefined>>,
): string[] {
  return sessionIds.filter((id) => id.length > 0 && !surfaceAgent[id]?.name);
}
