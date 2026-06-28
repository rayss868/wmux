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

/** Forget a pane's nudge history. MUST be called when a pty is torn down (pane /
 *  surface close) — otherwise (a) dead-pty entries accumulate (leak) and (b) a
 *  REUSED ptyId would inherit the dead pane's count and start rate-limited,
 *  silently suppressing a fresh pane's legit mentions (GLM review P1). */
export function clearNudgesFor(ptyId: string): void {
  stamps.delete(ptyId);
}

/** Test seam. */
export function __resetNudgeRateLimitForTests(): void {
  stamps.clear();
}

/** Exposed for tests / tuning visibility. */
export const NUDGE_RATE_LIMIT = { MAX_NUDGES, WINDOW_MS } as const;
