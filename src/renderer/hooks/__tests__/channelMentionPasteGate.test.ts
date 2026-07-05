import { describe, it, expect } from 'vitest';
import {
  isMentionPasteBusy,
  createPasteGateState,
  notePtyOutput,
  prunePasteGateState,
  UNKNOWN_STATUS_GRACE_MS,
  OUTPUT_QUIET_MS,
  MAX_UNKNOWN_HOLD_MS,
} from '../channelMentionPasteGate';

describe('isMentionPasteBusy', () => {
  it('busy for running / awaiting_input (paste would corrupt the turn)', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy('running', 'p', 0, s)).toBe(true);
    expect(isMentionPasteBusy('awaiting_input', 'p', 0, s)).toBe(true);
  });

  it('not busy for waiting / complete / idle / any other known status', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy('waiting', 'p', 0, s)).toBe(false);
    expect(isMentionPasteBusy('complete', 'p', 0, s)).toBe(false);
    expect(isMentionPasteBusy('idle', 'p', 0, s)).toBe(false);
  });

  // The 2026-07-05 bug: an idle-since-attach agent's status stays undefined, and
  // the old gate held the mention forever. Grace-then-deliver is the fix.
  it('holds unknown status during the grace window, then delivers', () => {
    const s = createPasteGateState();
    // First observation at t=0 arms the grace clock and holds.
    expect(isMentionPasteBusy(undefined, 'p', 0, s)).toBe(true);
    // Still within the window → still held.
    expect(isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS - 1, s)).toBe(true);
    // At/after the window → deliver (agent is quiet = idle).
    expect(isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS, s)).toBe(false);
    expect(isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS + 5000, s)).toBe(false);
  });

  it('grace clock is per-pty (one pane resolving does not release another)', () => {
    const s = createPasteGateState();
    isMentionPasteBusy(undefined, 'a', 0, s);
    isMentionPasteBusy(undefined, 'b', 1000, s);
    // 'a' passed its window; 'b' has not.
    expect(isMentionPasteBusy(undefined, 'a', UNKNOWN_STATUS_GRACE_MS, s)).toBe(false);
    expect(isMentionPasteBusy(undefined, 'b', UNKNOWN_STATUS_GRACE_MS, s)).toBe(true);
  });

  it('a running agent within grace stays held (transient post-attach window)', () => {
    const s = createPasteGateState();
    // Unknown at attach → held.
    expect(isMentionPasteBusy(undefined, 'p', 0, s)).toBe(true);
    // 'running' broadcast lands before the grace elapses → still busy, and the
    // grace clock is cleared so a later flap re-arms fresh.
    expect(isMentionPasteBusy('running', 'p', 1000, s)).toBe(true);
    expect(s.firstUnknownAt.has('p')).toBe(false);
  });

  it('resets the grace clock when status resolves then goes unknown again', () => {
    const s = createPasteGateState();
    isMentionPasteBusy(undefined, 'p', 0, s); // arm at 0
    isMentionPasteBusy('waiting', 'p', 500, s); // resolve → clears clock
    // Unknown again at t=1000 re-arms; grace measured from 1000, not 0.
    expect(isMentionPasteBusy(undefined, 'p', 1000, s)).toBe(true);
    expect(isMentionPasteBusy(undefined, 'p', 1000 + UNKNOWN_STATUS_GRACE_MS - 1, s)).toBe(true);
    expect(isMentionPasteBusy(undefined, 'p', 1000 + UNKNOWN_STATUS_GRACE_MS, s)).toBe(false);
  });

  it('honors a custom grace window', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy(undefined, 'p', 0, s, 100)).toBe(true);
    expect(isMentionPasteBusy(undefined, 'p', 100, s, 100)).toBe(false);
  });

  // The 2026-07-05 mid-turn paste race (Codex+Claude CRITICAL): grace alone is
  // leaky. A slow/thinking background agent stays at unknown status past the
  // grace (its bursts miss ActivityMonitor's threshold) but keeps emitting; the
  // output-quiet gate must hold it. A truly idle agent's output is stale, so it
  // still delivers.
  it('unknown past grace with NO output history delivers (idle case)', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy(undefined, 'p', 0, s)).toBe(true); // arm grace
    // Grace elapsed, lastOutputAt never stamped → both gates clear → deliver.
    expect(isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS, s)).toBe(false);
  });

  it('unknown past grace but RECENTLY output stays busy (race fix)', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy(undefined, 'p', 0, s)).toBe(true); // arm grace at 0
    // Agent emits at t=grace (a slow think tick).
    notePtyOutput(s, 'p', UNKNOWN_STATUS_GRACE_MS);
    // Grace elapsed, but last output is only 500ms ago (< quiet) → HELD.
    expect(
      isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS + 500, s),
    ).toBe(true);
    // Boundary: exactly quietMs since last output → no longer < quiet → deliver.
    expect(
      isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS + OUTPUT_QUIET_MS, s),
    ).toBe(false);
  });

  it('unknown past grace with STALE output delivers (quiet bar cleared)', () => {
    const s = createPasteGateState();
    expect(isMentionPasteBusy(undefined, 'p', 0, s)).toBe(true); // arm grace
    notePtyOutput(s, 'p', 100); // a lone early cursor query
    // Grace elapsed AND last output is far older than quietMs → deliver.
    expect(
      isMentionPasteBusy(undefined, 'p', UNKNOWN_STATUS_GRACE_MS + OUTPUT_QUIET_MS + 1, s),
    ).toBe(false);
  });

  it('honors a custom quiet window', () => {
    const s = createPasteGateState();
    isMentionPasteBusy(undefined, 'p', 0, s, 100); // arm grace (custom 100ms)
    notePtyOutput(s, 'p', 100);
    // grace(100) elapsed at t=150; last output 50ms ago, quiet=80 → still held.
    expect(isMentionPasteBusy(undefined, 'p', 150, s, 100, 80)).toBe(true);
    // t=200: last output 100ms ago ≥ quiet(80) → deliver.
    expect(isMentionPasteBusy(undefined, 'p', 200, s, 100, 80)).toBe(false);
  });

  it('notePtyOutput ignores an empty pty id', () => {
    const s = createPasteGateState();
    notePtyOutput(s, '', 100);
    expect(s.lastOutputAt.has('')).toBe(false);
    expect(s.lastOutputAt.size).toBe(0);
  });

  it('delivers past the hard ceiling even while output stays recent (never-deliver guard)', () => {
    const s = createPasteGateState();
    // Arm the grace clock at t=0.
    isMentionPasteBusy(undefined, 'p', 0, s);
    // A pathological pane keeps emitting sub-quiet output: stamp output near the
    // ceiling so the quiet gate alone (recent output) would hold it busy.
    notePtyOutput(s, 'p', MAX_UNKNOWN_HOLD_MS - 1000);
    // Just before the ceiling, recent output still holds it busy.
    expect(isMentionPasteBusy(undefined, 'p', MAX_UNKNOWN_HOLD_MS - 500, s)).toBe(true);
    // At the ceiling, deliver regardless of still-recent output (fail-safe).
    expect(isMentionPasteBusy(undefined, 'p', MAX_UNKNOWN_HOLD_MS, s)).toBe(false);
  });

  it('honors a custom max-hold ceiling', () => {
    const s = createPasteGateState();
    isMentionPasteBusy(undefined, 'p', 0, s);
    notePtyOutput(s, 'p', 900);
    // Custom ceiling 1000ms: recent output at t=900 would normally hold, but the
    // ceiling forces delivery at t=1000 (grace 500, quiet 2000, maxHold 1000).
    expect(isMentionPasteBusy(undefined, 'p', 999, s, 500, 2000, 1000)).toBe(true);
    expect(isMentionPasteBusy(undefined, 'p', 1000, s, 500, 2000, 1000)).toBe(false);
  });

  it('prunePasteGateState drops dead ptys from both maps, keeps live ones', () => {
    const s = createPasteGateState();
    // Arm grace clocks for two ptys.
    isMentionPasteBusy(undefined, 'live', 0, s);
    isMentionPasteBusy(undefined, 'dead', 0, s);
    // Stamp output for both.
    notePtyOutput(s, 'live', 10);
    notePtyOutput(s, 'dead', 10);
    expect(s.firstUnknownAt.has('dead')).toBe(true);
    expect(s.lastOutputAt.has('dead')).toBe(true);

    prunePasteGateState(s, new Set(['live']));

    // Dead pty gone from BOTH maps; live pty untouched.
    expect(s.firstUnknownAt.has('dead')).toBe(false);
    expect(s.lastOutputAt.has('dead')).toBe(false);
    expect(s.firstUnknownAt.has('live')).toBe(true);
    expect(s.lastOutputAt.has('live')).toBe(true);
  });
});
