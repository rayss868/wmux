import { describe, it, expect, beforeEach } from 'vitest';
import {
  isNudgeRateLimited,
  recordNudge,
  clearNudgesFor,
  shouldWarnLoopSuspect,
  __resetNudgeRateLimitForTests,
  NUDGE_RATE_LIMIT,
} from '../channelMentionRateLimit';

const { MAX_NUDGES, WINDOW_MS } = NUDGE_RATE_LIMIT;

describe('channelMentionRateLimit (A5 auto-nudge cap)', () => {
  beforeEach(() => {
    __resetNudgeRateLimitForTests();
  });

  it('allows up to MAX_NUDGES, then rate-limits within the window', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_NUDGES; i++) {
      expect(isNudgeRateLimited('pty-A', t0 + i)).toBe(false);
      recordNudge('pty-A', t0 + i);
    }
    expect(isNudgeRateLimited('pty-A', t0 + MAX_NUDGES)).toBe(true);
  });

  it('clears once the window passes (burst subsides → auto-nudge resumes)', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-A', t0);
    expect(isNudgeRateLimited('pty-A', t0)).toBe(true);
    expect(isNudgeRateLimited('pty-A', t0 + WINDOW_MS + 1)).toBe(false);
  });

  it('is per-pane (one runaway pane does not throttle another)', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-A', t0);
    expect(isNudgeRateLimited('pty-A', t0)).toBe(true);
    expect(isNudgeRateLimited('pty-B', t0)).toBe(false);
  });

  it('clearNudgesFor frees the entry so a reused ptyId starts fresh (no stale cap, no leak)', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-A', t0);
    expect(isNudgeRateLimited('pty-A', t0)).toBe(true);
    clearNudgesFor('pty-A'); // pane/surface closed → ptyId may be reused
    expect(isNudgeRateLimited('pty-A', t0)).toBe(false);
  });
});

describe('shouldWarnLoopSuspect (2f: one-shot loop-suspect signal)', () => {
  beforeEach(() => {
    __resetNudgeRateLimitForTests();
  });

  it('stays quiet while the pane is under the rate limit', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_NUDGES - 1; i++) recordNudge('pty-A', t0);
    expect(isNudgeRateLimited('pty-A', t0)).toBe(false);
    expect(shouldWarnLoopSuspect('pty-A', t0)).toBe(false);
  });

  it('warns once on the first rate-limited observation, then stays quiet in the window', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-A', t0);
    expect(isNudgeRateLimited('pty-A', t0)).toBe(true);
    // first over-limit observation → true, exactly once
    expect(shouldWarnLoopSuspect('pty-A', t0)).toBe(true);
    // repeat calls within the same limited window → false
    expect(shouldWarnLoopSuspect('pty-A', t0)).toBe(false);
    expect(shouldWarnLoopSuspect('pty-A', t0 + 1)).toBe(false);
    expect(shouldWarnLoopSuspect('pty-A', t0 + WINDOW_MS - 1)).toBe(false);
  });

  it('re-arms after the window clears (un-limited path) and warns again on a fresh burst', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-A', t0);
    expect(shouldWarnLoopSuspect('pty-A', t0)).toBe(true);

    // Old stamps age out → pane observed un-limited → warning re-arms.
    const t1 = t0 + WINDOW_MS + 1;
    expect(isNudgeRateLimited('pty-A', t1)).toBe(false);
    expect(shouldWarnLoopSuspect('pty-A', t1)).toBe(false);

    // A fresh burst rate-limits the pane again → warns again (new window).
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-A', t1);
    expect(isNudgeRateLimited('pty-A', t1)).toBe(true);
    expect(shouldWarnLoopSuspect('pty-A', t1)).toBe(true);
    expect(shouldWarnLoopSuspect('pty-A', t1)).toBe(false);
  });

  it('re-arms via the WINDOW_MS fallback even with no un-limited call in the gap', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-A', t0);
    expect(shouldWarnLoopSuspect('pty-A', t0)).toBe(true);

    // Never poll during the un-limited gap; a new burst trips the cap a full
    // window later. The time-based fallback still re-arms the one-shot signal.
    const t1 = t0 + WINDOW_MS + 1;
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-A', t1);
    expect(isNudgeRateLimited('pty-A', t1)).toBe(true);
    expect(shouldWarnLoopSuspect('pty-A', t1)).toBe(true);
  });

  it('clearNudgesFor wipes the warned bookkeeping (reused ptyId warns fresh)', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-A', t0);
    expect(shouldWarnLoopSuspect('pty-A', t0)).toBe(true);
    expect(shouldWarnLoopSuspect('pty-A', t0)).toBe(false);

    clearNudgesFor('pty-A'); // pane/surface closed → clears stamps AND warned state
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-A', t0);
    expect(shouldWarnLoopSuspect('pty-A', t0)).toBe(true);
  });

  it('is per-pane (a loop on one pane does not consume the warning for another)', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-A', t0);
    for (let i = 0; i < MAX_NUDGES; i++) recordNudge('pty-B', t0);
    expect(shouldWarnLoopSuspect('pty-A', t0)).toBe(true);
    expect(shouldWarnLoopSuspect('pty-A', t0)).toBe(false);
    expect(shouldWarnLoopSuspect('pty-B', t0)).toBe(true);
  });
});
