import { describe, it, expect } from 'vitest';
import {
  isMentionPasteBusy,
  createPasteGateState,
  UNKNOWN_STATUS_GRACE_MS,
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
});
