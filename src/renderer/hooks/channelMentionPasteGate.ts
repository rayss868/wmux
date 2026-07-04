// ─── Channel-mention paste gate — unknown-status grace window ────────────────
//
// RCA 2026-07-05 (idle-since-attach delivery block): the mention flush skips a
// pane whose agent is BUSY. Busy is read from `surfaceAgent[ptyId].status`,
// which AgentDetector only sets when a status PATTERN flows through the pty
// output (e.g. Claude's "bypass permissions on" idle-prompt fragment → 'waiting').
//
// An agent that has been idle since its pty attached never re-emits that pattern
// — it just sits emitting cursor-position queries — so its status stays
// `undefined`. The old gate treated `undefined` as busy FOREVER (fail-closed),
// relying on the agent's next Stop to flush the queued mention. But a
// continuously-idle agent never Stops, so the mention was stuck until an
// unrelated repaint (observed: splitting the pane) forced Claude to redraw the
// idle prompt, which finally emitted 'waiting'. Cross-workspace mentions to a
// background pane are exactly this case: the pane never gets focus, never
// repaints, never delivers.
//
// The fail-closed WAS load-bearing for one real window: right after attach a
// genuinely-running agent's first 'running' broadcast may not have landed yet,
// and pasting into a running agent corrupts its turn. That window is transient
// (a running agent produces output → ActivityMonitor 'active' → 'running' within
// ~1 output burst). So we keep fail-closed for a short GRACE period after the
// first unknown observation, then treat persistent-unknown as idle and deliver.
// A status that stays `undefined` past the grace means the agent produced no
// activity = quiet/idle, which is paste-safe.
//
// Known statuses are unchanged: 'running'/'awaiting_input' busy, everything else
// (including 'waiting'/'complete'/'idle') paste-safe immediately.

/** Paste is unsafe while the agent is actively producing ('running') or blocked
 *  on a confirmation prompt ('awaiting_input') — those defer to the agent's
 *  Stop. 'waiting' (turn ended, ready for input), 'complete', 'idle' are all
 *  paste-safe (deliver immediately). */
export const PASTE_UNSAFE_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'awaiting_input',
]);

/** Default grace window before a persistently-unknown status is treated as idle.
 *  Comfortably longer than the ~1-2s post-attach window in which a running
 *  agent's first 'running' broadcast lands, short enough that a real idle-pane
 *  mention delivers within a few poll ticks instead of never. */
export const UNKNOWN_STATUS_GRACE_MS = 4000;

/** Per-pty first-unknown-observation timestamps. Effect-scoped, mutated in place
 *  by `isMentionPasteBusy` so the grace clock survives across poll ticks. */
export interface PasteGateState {
  firstUnknownAt: Map<string, number>;
}

export function createPasteGateState(): PasteGateState {
  return { firstUnknownAt: new Map() };
}

/**
 * Should a queued mention be HELD (agent busy) rather than pasted into `ptyId`?
 *
 * @param status  live `surfaceAgent[ptyId]?.status` (undefined = unknown)
 * @param ptyId   target pty
 * @param now     current epoch ms (Date.now())
 * @param state   mutable grace tracker (see PasteGateState)
 * @param graceMs grace window for unknown status
 *
 * Side effect: records/clears the pty's first-unknown timestamp in `state`.
 */
export function isMentionPasteBusy(
  status: string | undefined,
  ptyId: string,
  now: number,
  state: PasteGateState,
  graceMs: number = UNKNOWN_STATUS_GRACE_MS,
): boolean {
  if (status != null) {
    // Known status resolved — clear any grace clock so a later re-attach that
    // goes unknown again starts a fresh window.
    state.firstUnknownAt.delete(ptyId);
    return PASTE_UNSAFE_STATUSES.has(status);
  }
  // Unknown: hold during the grace window, then deliver.
  const first = state.firstUnknownAt.get(ptyId);
  if (first == null) {
    state.firstUnknownAt.set(ptyId, now);
    return true;
  }
  return now - first < graceMs;
}
