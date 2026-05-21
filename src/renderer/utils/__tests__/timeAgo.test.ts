import { describe, it, expect } from 'vitest';
import { timeAgo } from '../timeAgo';

// All cases pin `now` explicitly so the test is deterministic across timezones
// and clock drift. The function under test is pure given (timestamp, now).
const NOW = 1_700_000_000_000;

describe('timeAgo', () => {
  it('returns "just now" for diff < 60s', () => {
    expect(timeAgo(NOW - 0, NOW)).toBe('just now');
    expect(timeAgo(NOW - 1_000, NOW)).toBe('just now');
    expect(timeAgo(NOW - 59_999, NOW)).toBe('just now');
  });

  it('returns "{n}m ago" for diff in [60s, 60m)', () => {
    expect(timeAgo(NOW - 60_001, NOW)).toBe('1m ago');
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(timeAgo(NOW - 59 * 60_000, NOW)).toBe('59m ago');
  });

  it('returns "{n}h ago" for diff in [60m, 24h)', () => {
    expect(timeAgo(NOW - 60 * 60_000, NOW)).toBe('1h ago');
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(timeAgo(NOW - 23 * 3_600_000, NOW)).toBe('23h ago');
  });

  it('returns "{n}d ago" for diff in [24h, 7d)', () => {
    expect(timeAgo(NOW - 24 * 3_600_000, NOW)).toBe('1d ago');
    expect(timeAgo(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
    expect(timeAgo(NOW - 6 * 86_400_000, NOW)).toBe('6d ago');
  });

  it('returns a local date string for diff >= 7d', () => {
    const oldTs = NOW - 7 * 86_400_000;
    const expected = new Date(oldTs).toLocaleDateString();
    expect(timeAgo(oldTs, NOW)).toBe(expected);

    const veryOld = NOW - 365 * 86_400_000;
    expect(timeAgo(veryOld, NOW)).toBe(new Date(veryOld).toLocaleDateString());
  });

  // ─── Boundary tests ───────────────────────────────────────────────────────

  it('treats diff = 0 as "just now"', () => {
    expect(timeAgo(NOW, NOW)).toBe('just now');
  });

  it('treats diff = exactly 60_000 as "1m ago" (boundary)', () => {
    expect(timeAgo(NOW - 60_000, NOW)).toBe('1m ago');
  });

  it('treats diff = exactly 3_600_000 as "1h ago" (boundary)', () => {
    expect(timeAgo(NOW - 3_600_000, NOW)).toBe('1h ago');
  });

  it('treats diff = exactly 86_400_000 as "1d ago" (boundary)', () => {
    expect(timeAgo(NOW - 86_400_000, NOW)).toBe('1d ago');
  });

  it('treats diff = exactly 7 * 86_400_000 as date string (boundary)', () => {
    const ts = NOW - 7 * 86_400_000;
    expect(timeAgo(ts, NOW)).toBe(new Date(ts).toLocaleDateString());
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  it('treats future timestamps (negative diff, clock skew) as "just now"', () => {
    expect(timeAgo(NOW + 1_000, NOW)).toBe('just now');
    expect(timeAgo(NOW + 60_000, NOW)).toBe('just now');
    expect(timeAgo(NOW + 999_999_999, NOW)).toBe('just now');
  });

  it('uses Date.now() as the default reference', () => {
    // We can't pin Date.now() but we can assert the call shape: a fresh
    // timestamp returns "just now".
    const result = timeAgo(Date.now());
    expect(result).toBe('just now');
  });
});
