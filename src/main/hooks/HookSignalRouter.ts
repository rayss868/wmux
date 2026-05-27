// HookSignalRouter — dedup arbiter between deterministic hook signals
// (from integrations/<agent>/bin/wmux-bridge.mjs) and heuristic
// AgentDetector emissions (regex-driven, in src/main/pty/AgentDetector.ts).
//
// The Iron Rule: hook signal wins. AgentDetector is the fallback path
// for environments where the plugin isn't installed. When both fire
// within a 10s window, the second one is suppressed.
//
// ASCII timing diagrams:
//
//   Hook arrives first, detector follows within 10s
//   t0: hook    → ledger.set(slug:ptyId = {kind, ts: t0, source:'hook'})
//                  → emit notification
//   t0+200ms: detector → ledger lookup → source='hook', kind matches,
//                                         ts within window → DEDUP, no emit
//
//   Detector arrives first, hook follows within 10s
//   t0: detector → ledger.set(slug:ptyId = {kind, ts: t0, source:'detector'})
//                   → emit notification
//   t0+50ms: hook → ledger lookup → kind matches, ts within window → DEDUP
//                   → still records latency (the value of the hook is
//                     measurement here, not user-visible emission)
//
//   Hook arrives, but no detector ever fires (plugin-only path)
//   t0: hook    → emit
//   t0+1m: hook again (different kind) → emit again
//
//   Detector arrives, no plugin installed
//   t0: detector → emit
//   This is the legacy heuristic behavior, unchanged from pre-plugin wmux.

import type {
  AgentSignal,
  AgentSignalKind,
} from '../../../integrations/shared/signal-types';
import type { AgentSlug } from '../pty/AgentDetector';
import type { SignalLatencyMeter } from './SignalLatencyMeter';

/** Default dedup window. 10s chosen by eng review 2026-05-22 after measuring
 *  typical (hook-fire → detector-prompt-render) gap (≤2s observed). Wide
 *  margin keeps the dedup robust without making cross-turn collisions
 *  likely (a single agent turn is bounded well over 10s in practice). */
export const DEFAULT_DEDUP_WINDOW_MS = 10_000;

/** Ledger entry. Source field is what lets us implement the Iron Rule
 *  ("hook wins") asymmetrically — a detector emission gets suppressed
 *  by a later hook signal, but only if the recorded source was 'hook'. */
interface LedgerEntry {
  kind: AgentSignalKind;
  ts: number;
  source: 'hook' | 'detector';
}

/**
 * Decision returned to the caller. `emit` means the caller should
 * proceed to call sendNotification (or its slice action), `dedup` means
 * the caller should drop this event. Latency is always recorded
 * regardless of decision because health observation is independent of
 * user-visible dispatch.
 */
export type RouteDecision = 'emit' | 'dedup';

/**
 * Wiring: HookSignalRouter is constructed once in main/index.ts and
 * shared across:
 *   - `src/main/pipe/handlers/hooks.rpc.ts` (calls recordHook on every
 *     bridge signal)
 *   - `src/main/pty/PTYBridge.ts` (calls recordDetector before every
 *     AgentDetector-driven sendNotification)
 *
 * No singleton; the wiring layer holds the reference. Tests construct
 * their own instance.
 */
export class HookSignalRouter {
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly latencyMeter: SignalLatencyMeter;
  private readonly windowMs: number;

  constructor(deps: { latencyMeter: SignalLatencyMeter; dedupWindowMs?: number }) {
    this.latencyMeter = deps.latencyMeter;
    this.windowMs = deps.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  }

  /**
   * Record a hook-bridge signal. Returns `emit` when the caller should
   * proceed to fan-out, `dedup` when a recent detector emission already
   * covered the same (slug, ptyId, kind) tuple.
   *
   * Latency is always recorded because the bridge gave us a fire-time
   * we can measure against, regardless of whether we suppress emission.
   * That data feeds the Settings "Plugin signal health" card and tells
   * the user "the hook IS firing, dedup just won this round."
   *
   * @param signal Validated AgentSignal envelope (caller MUST have
   *               passed isAgentSignal already).
   * @param ptyId  Resolved ptyId from `cwd` lookup in hooks.rpc.
   * @param now    Optional override for test determinism.
   */
  recordHook(signal: AgentSignal, ptyId: string, now: number = Date.now()): RouteDecision {
    // NOTE: latency is NOT recorded here. The caller is responsible for
    // calling getLatencyMeter().recordSignal directly. This split exists
    // so non-emit kinds (PostToolUse / SessionStart) can record latency
    // without touching the dedup ledger — see hooks.rpc.ts for the wiring.
    const key = this.key(signal.agent, ptyId, signal.kind);
    const recent = this.ledger.get(key);
    // Hook beats detector only when the prior record was a detector emit
    // of the SAME kind within the window. Different kinds always emit
    // (a Stop hook after a SubagentStop detector is a distinct event).
    if (
      recent &&
      recent.source === 'detector' &&
      recent.kind === signal.kind &&
      now - recent.ts < this.windowMs
    ) {
      // Detector already emitted. Hook is the canonical-but-redundant
      // event. Update the ledger to 'hook' for downstream queries that
      // care about provenance.
      this.ledger.set(key, { kind: signal.kind, ts: now, source: 'hook' });
      return 'dedup';
    }
    // Either no prior record or prior was a different kind / stale —
    // emit and overwrite ledger.
    this.ledger.set(key, { kind: signal.kind, ts: now, source: 'hook' });
    return 'emit';
  }

  /**
   * Record an AgentDetector emission and ask whether to proceed. Called
   * BEFORE sendNotification by PTYBridge's onEvent handler.
   *
   * Suppresses (`dedup`) when any recent emission for the same
   * (agent, pty, kind) tuple exists within the dedup window, regardless
   * of source. Two cases this covers:
   *   1. hook → detector: hook is canonical, detector is redundant.
   *   2. detector → detector: e.g. Aider emits "Applied edit to ..."
   *      (status='complete') and then "aider> " (status='waiting') for
   *      a single turn; both collapse to `kind: 'agent.stop'` and would
   *      otherwise stream two `decision:'emit'` lifecycle events for one
   *      turn — orchestrators filtering on emit would run follow-up
   *      twice. Codex round-3 catch.
   *
   * Different kinds (e.g. detector saw "waiting" prompt, hook fired
   * Stop) still emit independently — those are different user-visible
   * events. Different (slug, ptyId) tuples are independent too.
   *
   * The ledger is NOT refreshed on dedup, so a third same-kind emission
   * 8s into the original 10s window still defers (no rolling window
   * extension). Refreshing only happens on `emit`.
   */
  recordDetector(
    slug: AgentSlug,
    kind: AgentSignalKind,
    ptyId: string,
    now: number = Date.now(),
  ): RouteDecision {
    const key = this.key(slug, ptyId, kind);
    const recent = this.ledger.get(key);
    if (
      recent &&
      recent.kind === kind &&
      now - recent.ts < this.windowMs
    ) {
      return 'dedup';
    }
    this.ledger.set(key, { kind, ts: now, source: 'detector' });
    return 'emit';
  }

  /** Expose the latency meter so callers can query stats without
   *  needing the meter reference directly. */
  getLatencyMeter(): SignalLatencyMeter {
    return this.latencyMeter;
  }

  /** Test-only: clear all dedup state. Latency meter is independent. */
  resetForTests(): void {
    this.ledger.clear();
  }

  /**
   * Drop every ledger entry for a given ptyId. Called from PTYBridge's
   * cleanupInstance when a PTY is disposed (UI close, MCP destroy, exit)
   * so the ledger doesn't accumulate dead-ptyId entries over a long
   * daemon lifetime.
   *
   * Keys are formed as `${slug}:${ptyId}:${kind}` in `key()`. ptyIds are
   * UUIDs in production and never contain `:`, so the substring check
   * `:${ptyId}:` is unambiguous; agent slugs and signal kinds are bound
   * to a finite enum that also never contains `:`.
   *
   * Returns the number of entries removed (testing aid, not a contract).
   */
  dropPty(ptyId: string): number {
    if (!ptyId) return 0;
    const needle = `:${ptyId}:`;
    let removed = 0;
    for (const k of this.ledger.keys()) {
      if (k.includes(needle)) {
        this.ledger.delete(k);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Ledger key includes `kind` (codex review round 2, P1 #7). Without it,
   * an `agent.activity` event would overwrite a recent `agent.stop`
   * entry on the same (slug, ptyId), defeating dedup for the case where
   * the user actually cares about (stop arriving while a fresh activity
   * was the last write). Per-kind ledgers cost a few extra entries per
   * pty in exchange for correctness.
   */
  private key(slug: string, ptyId: string, kind?: AgentSignalKind): string {
    return kind ? `${slug}:${ptyId}:${kind}` : `${slug}:${ptyId}`;
  }
}
