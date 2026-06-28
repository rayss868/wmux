import { describe, it, expect, beforeEach } from 'vitest';
import {
  isNudgeRateLimited,
  recordNudge,
  clearNudgesFor,
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
