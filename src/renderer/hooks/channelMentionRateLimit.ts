// ─── Per-pane auto-nudge rate cap (A5: ping-pong loop termination) ───────────
//
// A2A dogfooding: two agents greeting each other (A @B, B @A, A @B, ...) had no
// termination — each mention auto-nudged the other, who replied, forever. A true
// "mention chain depth" can't be tracked because agents post freely (an outgoing
// channel_post carries no link to the mention that prompted it), so there's no
// reliable per-message lineage to count.
//
// The tractable loop-breaker is a per-pane RATE cap on AUTO-nudges: if a pane has
// been auto-nudged MAX_NUDGES times within WINDOW_MS, further auto-nudges to it
// are suppressed. The mention is NOT lost — it stays queued in the inbox and the
// agent can still pull it via a2a_task_query; only the automatic paste is
// withheld, which is what breaks a runaway bounce. Once the burst subsides (the
// window clears) auto-nudges resume.

const MAX_NUDGES = 5;
const WINDOW_MS = 60_000;

/** ptyId → recent auto-nudge timestamps (ms), pruned to the window lazily. */
const stamps = new Map<string, number[]>();

/** True if this pane has already received MAX_NUDGES auto-nudges within the last
 *  WINDOW_MS — i.e. suppress the next one to break a runaway loop. `now` is
 *  injectable for deterministic tests. */
export function isNudgeRateLimited(ptyId: string, now: number = Date.now()): boolean {
  const arr = stamps.get(ptyId);
  if (!arr) return false;
  const cutoff = now - WINDOW_MS;
  let recent = 0;
  for (const t of arr) if (t > cutoff) recent++;
  return recent >= MAX_NUDGES;
}

/** Record that an auto-nudge was delivered to this pane (prunes old stamps). */
export function recordNudge(ptyId: string, now: number = Date.now()): void {
  const cutoff = now - WINDOW_MS;
  const arr = (stamps.get(ptyId) ?? []).filter((t) => t > cutoff);
  arr.push(now);
  stamps.set(ptyId, arr);
}

// ─── Loop-suspect warning signal (one-shot per rate-limit window) ────────────
//
// The rate cap above BOUNDS a ping-pong bounce but never TERMINATES it: while
// two agents keep mentioning each other the pane stays rate-limited and the
// mentions keep queuing in the inbox. `shouldWarnLoopSuspect` gives the UI one
// de-duplicated signal ("this pane looks stuck in a mention loop") so a human
// can intervene, without spamming a toast on every suppressed nudge.
//
// HARD termination (a mention-chain depth cap that would forcibly cut the loop)
// is DELIBERATELY NOT IMPLEMENTED here. A blunt chain cap cannot tell a runaway
// greeting bounce apart from a legitimate long agent-to-agent orchestration
// chain, so auto-killing it would break real multi-agent workflows. The product
// decision on whether/how to hard-stop is deferred (remediation plan 2f); for
// now we only surface the warning and leave termination to the human.

/** ptyId → timestamp (ms) of the last loop-suspect warning emitted for the
 *  current rate-limit window. Sole purpose: de-dupe the one-shot signal. */
const warnedAt = new Map<string, number>();

/** True exactly ONCE per rate-limit window for a pane: the first observation
 *  that the pane is rate-limited (`isNudgeRateLimited` → true) since it was last
 *  un-limited. Repeat calls while the pane stays limited return false, so the
 *  caller fires a single toast per bounce instead of one per suppressed nudge.
 *
 *  Re-arms (so a later bounce warns again) when EITHER holds, whichever first:
 *   • the pane is observed un-limited again — the burst subsided, window ended; or
 *   • WINDOW_MS has elapsed since the last warning — a fallback so the signal
 *     still re-arms even if the caller never polled during the un-limited gap.
 *  (While limited, auto-nudges are suppressed so no new stamps are recorded; a
 *  pane therefore cannot stay continuously limited past WINDOW_MS, so the two
 *  conditions agree in practice and never double-warn a single window.)
 *
 *  Pure read of the rate-limit state: it inspects `isNudgeRateLimited` and only
 *  mutates its own `warnedAt` bookkeeping — it never records a nudge or touches
 *  `stamps`. `now` is injectable for deterministic tests. */
export function shouldWarnLoopSuspect(ptyId: string, now: number = Date.now()): boolean {
  if (!isNudgeRateLimited(ptyId, now)) {
    // Window ended (or never started) → re-arm for the next bounce.
    warnedAt.delete(ptyId);
    return false;
  }
  const last = warnedAt.get(ptyId);
  if (last !== undefined && now - last < WINDOW_MS) return false;
  warnedAt.set(ptyId, now);
  return true;
}

/** Forget a pane's nudge history. MUST be called when a pty is torn down (pane /
 *  surface close) — otherwise (a) dead-pty entries accumulate (leak) and (b) a
 *  REUSED ptyId would inherit the dead pane's count and start rate-limited,
 *  silently suppressing a fresh pane's legit mentions (GLM review P1). */
export function clearNudgesFor(ptyId: string): void {
  stamps.delete(ptyId);
  warnedAt.delete(ptyId); // also drop the one-shot loop-suspect bookkeeping
}

/** Test seam. */
export function __resetNudgeRateLimitForTests(): void {
  stamps.clear();
  warnedAt.clear();
}

/** Exposed for tests / tuning visibility. */
export const NUDGE_RATE_LIMIT = { MAX_NUDGES, WINDOW_MS } as const;
