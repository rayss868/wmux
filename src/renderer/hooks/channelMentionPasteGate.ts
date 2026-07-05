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
// RCA 2026-07-05 (mid-turn paste race, Codex+Claude CRITICAL): grace ALONE is a
// leaky gate. A background agent that is genuinely thinking / emitting tokens
// SLOWLY can sit at status `undefined` past the grace — its output bursts stay
// under ActivityMonitor's 2000-byte/3s threshold, so no 'running' broadcast ever
// lands — and the grace-only gate then pastes MID-TURN and corrupts the turn.
// The naive fix ("any raw pty output = busy") reintroduces the c8b3bf9 bug: an
// idle agent still emits sparse output (cursor-position queries), so raw-output
// gating would hold an idle mention forever. So we require BOTH gates to clear:
//   - GRACE (4s) since first-unknown, AND
//   - OUTPUT-QUIET (2s) since the pty's last observed output.
// A thinking agent repaints its status line on a ~1s timer, so it never crosses
// the 2s quiet bar → held. A truly idle agent emits only rare queries, clears
// the quiet bar → delivered. The last-output timestamps are fed by a global
// pty-data listener (see useChannelsEventSubscription) and pruned per-pty via
// prunePasteGateState so the maps can't leak dead ptys.
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

/** Second gate for a persistently-unknown pty: how long the pty must have been
 *  QUIET (no observed output) before an unknown-status mention delivers. A
 *  thinking agent repaints its status line on a ~1s cadence and never crosses
 *  this bar; a truly idle agent emits only sparse cursor queries and does.
 *  Conservative default — dogfood-tuning target (RCA 2026-07-05, Codex+Claude
 *  mid-turn-paste race). */
export const OUTPUT_QUIET_MS = 2000;

/** Hard ceiling on holding a persistently-unknown mention. After this long at
 *  unknown status the mention delivers even if output is still recent — bounds
 *  the output-quiet gate so a perpetual-unknown, never-quiet pane (an idle
 *  prompt with a live clock/ticker, or a TUI AgentDetector can't classify)
 *  can't pin a mention forever. Generous so a normal thinking agent (which
 *  resolves to a known status or goes quiet first) never hits it; past it the
 *  failure mode is "delivered late", not "silently never delivered" (RCA
 *  2026-07-05, 2-model never-deliver consensus: Codex CRITICAL + Claude). */
export const MAX_UNKNOWN_HOLD_MS = 45000;

/** Per-pty grace/quiet trackers. Effect-scoped, mutated in place so the clocks
 *  survive across poll ticks.
 *   - firstUnknownAt: first-unknown-observation timestamp (grace clock),
 *     mutated by `isMentionPasteBusy`.
 *   - lastOutputAt: last observed pty output timestamp (quiet clock), stamped by
 *     `notePtyOutput` from a global pty-data listener. Both are pruned by
 *     `prunePasteGateState` so dead ptys can't leak. */
export interface PasteGateState {
  firstUnknownAt: Map<string, number>;
  lastOutputAt: Map<string, number>;
}

export function createPasteGateState(): PasteGateState {
  return { firstUnknownAt: new Map(), lastOutputAt: new Map() };
}

/** Record that `ptyId` just produced output at `now`. Fed by the renderer's
 *  global pty-data listener; a no-op for an empty id (app-level frames). */
export function notePtyOutput(state: PasteGateState, ptyId: string, now: number): void {
  if (!ptyId) return;
  state.lastOutputAt.set(ptyId, now);
}

/** Drop grace/quiet entries for ptys no longer in `livePtyIds` (leaf-pane
 *  sweep). Bounds both maps to live panes — without this a churned pty's
 *  timestamps live forever (3-model consensus map-leak fix). */
export function prunePasteGateState(state: PasteGateState, livePtyIds: Set<string>): void {
  for (const id of state.firstUnknownAt.keys()) {
    if (!livePtyIds.has(id)) state.firstUnknownAt.delete(id);
  }
  for (const id of state.lastOutputAt.keys()) {
    if (!livePtyIds.has(id)) state.lastOutputAt.delete(id);
  }
}

/**
 * Should a queued mention be HELD (agent busy) rather than pasted into `ptyId`?
 *
 * @param status  live `surfaceAgent[ptyId]?.status` (undefined = unknown)
 * @param ptyId   target pty
 * @param now     current epoch ms (Date.now())
 * @param state   mutable grace/quiet tracker (see PasteGateState)
 * @param graceMs grace window for unknown status
 * @param quietMs output-quiet window an unknown pty must clear to deliver
 *
 * Side effect: records/clears the pty's first-unknown timestamp in `state`.
 * The quiet clock (`lastOutputAt`) is READ here but owned by `notePtyOutput` /
 * `prunePasteGateState` — this function never writes it.
 */
export function isMentionPasteBusy(
  status: string | undefined,
  ptyId: string,
  now: number,
  state: PasteGateState,
  graceMs: number = UNKNOWN_STATUS_GRACE_MS,
  quietMs: number = OUTPUT_QUIET_MS,
  maxHoldMs: number = MAX_UNKNOWN_HOLD_MS,
): boolean {
  if (status != null) {
    // Known status resolved — clear any grace clock so a later re-attach that
    // goes unknown again starts a fresh window. lastOutputAt is left to prune.
    state.firstUnknownAt.delete(ptyId);
    return PASTE_UNSAFE_STATUSES.has(status);
  }
  // Unknown: hold during the grace window.
  const first = state.firstUnknownAt.get(ptyId);
  if (first == null) {
    state.firstUnknownAt.set(ptyId, now);
    return true;
  }
  if (now - first < graceMs) return true;
  // Hard ceiling: never hold an unknown-status mention forever. A pane stuck at
  // unknown that keeps emitting sub-quiet output (idle prompt with a live
  // clock/ticker) would otherwise pin the output-quiet gate below busy every
  // tick — a silent never-deliver. Past the ceiling we deliver regardless; the
  // failure mode flips from "mention lost, no signal" to "mention delivered
  // late" (3-model review 2026-07-05: Codex CRITICAL + Claude fallback).
  if (now - first >= maxHoldMs) return false;
  // Grace elapsed, under the ceiling. Second gate: a slow/thinking agent whose
  // bursts stay under ActivityMonitor's threshold sits at unknown past the grace
  // but keeps emitting — hold it while its last output is still recent (mid-turn
  // race). A truly idle pty's last output is old (only rare cursor queries its
  // live CPR responder answers), so it clears the quiet bar and delivers.
  const lastOut = state.lastOutputAt.get(ptyId);
  if (lastOut != null && now - lastOut < quietMs) return true;
  return false;
}
