// ─── Command Deck — orchestrator scheduler (P3d) ─────────────────────────────
//
// The tick loop that turns persisted schedules (deckScheduleStore) into
// orchestrator turns. Main-process, transport-free: it takes a `runTurn`
// callback (deck.handler wires it to the commander manager) and injectable
// clock/timer deps so tests drive it deterministically.
//
// Semantics:
//   - one tick every TICK_MS (and one immediately on start): fire every due,
//     enabled schedule IN SERIES (the manager is one-turn-at-a-time anyway).
//   - a `busy` reject leaves the schedule due — it retries next tick after the
//     human's (or another schedule's) turn finishes. ok/error consume the
//     occurrence: repeats advance past now (no catch-up storms after sleep),
//     one-shots flip to disabled but stay listed.
//   - store writes are read-modify-write per fire against the CURRENT file so
//     a schedule edited mid-turn isn't clobbered by a stale in-memory copy.

import {
  loadDeckSchedules,
  saveDeckSchedules,
  dueSchedules,
  advanceAfterRun,
  type DeckSchedule,
} from './deckScheduleStore';

export const DECK_SCHEDULER_TICK_MS = 30_000;

/** The prompt prefix that tells the brain (and the human reading the thread)
 *  this turn was fired by a schedule, not typed. */
export function scheduledPrompt(s: DeckSchedule): string {
  return `[Scheduled task] ${s.prompt}`;
}

export interface DeckSchedulerDeps {
  /** Fire one orchestrator turn. Resolves with the accept/reject verdict —
   *  the same shape CommanderSessionManager.send returns. */
  runTurn: (prompt: string) => Promise<{ ok: boolean; code?: string }>;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /** Store dir override (tests). */
  dir?: string;
}

export class DeckScheduler {
  private readonly deps: Required<Pick<DeckSchedulerDeps, 'runTurn'>> &
    Omit<DeckSchedulerDeps, 'runTurn'>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: DeckSchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    const setI = this.deps.setIntervalFn ?? setInterval;
    this.timer = setI(() => void this.tick(), DECK_SCHEDULER_TICK_MS);
    // Electron main must never be kept alive by the scheduler.
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    (this.deps.clearIntervalFn ?? clearInterval)(this.timer);
    this.timer = null;
  }

  /** One pass: fire every due schedule in series. Re-entrancy guarded — a slow
   *  turn spanning multiple ticks must not double-fire. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = (this.deps.now ?? Date.now)();
      const due = dueSchedules(loadDeckSchedules(this.deps.dir), now);
      for (const s of due) {
        let result: 'ok' | 'busy' | 'error';
        try {
          const r = await this.deps.runTurn(scheduledPrompt(s));
          result = r.ok ? 'ok' : r.code === 'busy' ? 'busy' : 'error';
        } catch {
          result = 'error';
        }
        // Read-modify-write against the CURRENT store: the schedule may have
        // been edited or deleted while the turn ran.
        const fresh = loadDeckSchedules(this.deps.dir);
        const idx = fresh.findIndex((x) => x.id === s.id);
        if (idx === -1) continue; // deleted mid-turn — nothing to advance
        fresh[idx] = advanceAfterRun(fresh[idx], result, (this.deps.now ?? Date.now)());
        await saveDeckSchedules(fresh, this.deps.dir);
        // A busy manager will reject every remaining due schedule this tick
        // too — stop early and let the next tick retry the rest.
        if (result === 'busy') break;
      }
    } finally {
      this.ticking = false;
    }
  }
}
