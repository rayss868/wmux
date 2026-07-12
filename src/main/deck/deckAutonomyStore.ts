// ─── Command Deck — per-workspace autonomy capabilities (event-push) ─────────
//
// The event-push loop lets a pane lifecycle change (agent.stop /
// agent.awaiting_input) WAKE a workspace's orchestrator into a fresh turn. What
// that turn is ALLOWED to do is gated here, per workspace, fail-closed.
//
// Three capabilities, from harmless to dangerous (decision 2 of
// plans/orchestrator-event-push-2026-07-12.md):
//   - summarize            (default ON)  — open a turn that reports state and
//                                          stops. Cannot touch a pane.
//   - continueInstruction  (default OFF) — the brain may send a follow-up
//                                          instruction into a pane.
//   - approvalPress        (default OFF) — the brain may press y/1/2/3 on an
//                                          approval prompt.
//
// FAIL-CLOSED: a missing/corrupt file, an unknown workspace, or a torn entry
// all resolve to DEFAULT_AUTONOMY (summarize on, the two dangerous caps off).
// This mirrors channelsTabVisible (#413): the safe posture is the one you fall
// back to when anything is uncertain.
//
// HARD RULE ENFORCED ELSEWHERE (CommanderEventCoalescer): a `regex`-source
// awaiting_input is NEVER auto-approvable regardless of approvalPress — only a
// deterministic hook-source block may drive a press. This store only says
// whether the CAPABILITY is on; the coalescer's prompt builder still refuses a
// detector-sourced approval.
//
// One JSON file (`deck-autonomy.json`) in the wmux data dir, atomic-written and
// WMUX_DATA_SUFFIX-isolated — the same storage shape as deck-schedules.json /
// deck-commander.json.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';

export interface WorkspaceAutonomy {
  /** Open a turn that reports fleet state and stops. Default on. */
  summarize: boolean;
  /** Brain may send a follow-up instruction into a pane. Default off. */
  continueInstruction: boolean;
  /** Brain may press y/1/2/3 on an approval prompt. Default off. */
  approvalPress: boolean;
}

/** Fail-closed default: report state, touch nothing. */
export const DEFAULT_AUTONOMY: Readonly<WorkspaceAutonomy> = {
  summarize: true,
  continueInstruction: false,
  approvalPress: false,
};

/** Same workspace-id shape the deck handler validates before keying maps. */
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function getDeckAutonomyPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-autonomy.json');
}

/** Coerce one raw entry to a WorkspaceAutonomy, defaulting every field
 *  fail-closed. A non-boolean `summarize` still defaults ON (harmless); the two
 *  dangerous caps default OFF unless the stored value is EXACTLY `true`. */
function sanitizeEntry(raw: unknown): WorkspaceAutonomy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AUTONOMY };
  const o = raw as Record<string, unknown>;
  return {
    summarize: o.summarize === false ? false : true,
    continueInstruction: o.continueInstruction === true,
    approvalPress: o.approvalPress === true,
  };
}

type AutonomyFile = Record<string, WorkspaceAutonomy>;

/** Load the whole map; a missing/corrupt file is an empty map (every workspace
 *  then resolves to DEFAULT). Bad keys are dropped. */
function loadAll(dir?: string): AutonomyFile {
  let raw: unknown;
  try {
    raw = atomicReadJSONSync<unknown>(getDeckAutonomyPath(dir));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: AutonomyFile = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!WORKSPACE_ID_RE.test(k)) continue;
    out[k] = sanitizeEntry(v);
  }
  return out;
}

/** The one read the coalescer needs: resolve a workspace's caps, fail-closed to
 *  DEFAULT on any doubt (bad id, missing entry, torn file). Never throws. */
export function loadWorkspaceAutonomy(workspaceId: string, dir?: string): WorkspaceAutonomy {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return { ...DEFAULT_AUTONOMY };
  try {
    const all = loadAll(dir);
    return all[workspaceId] ?? { ...DEFAULT_AUTONOMY };
  } catch {
    return { ...DEFAULT_AUTONOMY };
  }
}

/** Read every stored entry (for a Settings panel). Workspaces with no entry are
 *  simply absent — the caller renders them as DEFAULT. */
export function loadDeckAutonomy(dir?: string): AutonomyFile {
  return loadAll(dir);
}

/** Merge a partial update into one workspace's caps and persist. Returns the
 *  resolved caps after the merge. A bad workspaceId is a no-op that returns
 *  DEFAULT (never writes a bad key). */
export async function setWorkspaceAutonomy(
  workspaceId: string,
  patch: Partial<WorkspaceAutonomy>,
  dir?: string,
): Promise<WorkspaceAutonomy> {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return { ...DEFAULT_AUTONOMY };
  const all = loadAll(dir);
  const current = all[workspaceId] ?? { ...DEFAULT_AUTONOMY };
  const next: WorkspaceAutonomy = {
    summarize: typeof patch.summarize === 'boolean' ? patch.summarize : current.summarize,
    continueInstruction:
      typeof patch.continueInstruction === 'boolean'
        ? patch.continueInstruction
        : current.continueInstruction,
    approvalPress:
      typeof patch.approvalPress === 'boolean' ? patch.approvalPress : current.approvalPress,
  };
  all[workspaceId] = next;
  await atomicWriteJSON(getDeckAutonomyPath(dir), all);
  return next;
}
