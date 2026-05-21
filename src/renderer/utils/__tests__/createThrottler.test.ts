import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createThrottler } from '../createThrottler';

describe('createThrottler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('first try() returns true', () => {
    const t = createThrottler(2000);
    expect(t.try()).toBe(true);
  });

  it('second try() within the window returns false', () => {
    const t = createThrottler(2000);

    expect(t.try()).toBe(true);
    vi.advanceTimersByTime(1999);
    expect(t.try()).toBe(false);
  });

  it('try() after the window elapsed returns true again and re-anchors', () => {
    const t = createThrottler(2000);

    expect(t.try()).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(t.try()).toBe(true);

    // The successful call above is the new anchor — immediately retrying is throttled.
    expect(t.try()).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(t.try()).toBe(true);
  });

  it('two throttler instances keep independent state', () => {
    const a = createThrottler(1000);
    const b = createThrottler(1000);

    expect(a.try()).toBe(true);
    // b has never fired — it must still start fresh.
    expect(b.try()).toBe(true);

    vi.advanceTimersByTime(500);
    expect(a.try()).toBe(false);
    expect(b.try()).toBe(false);
  });

  it('cancel() resets state so the next try() returns true immediately', () => {
    const t = createThrottler(2000);

    expect(t.try()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(t.try()).toBe(false);

    t.cancel();
    expect(t.try()).toBe(true);
  });

  it('cancel() does not make the throttler permanently open', () => {
    const t = createThrottler(2000);

    t.cancel();
    expect(t.try()).toBe(true);

    // Subsequent calls within the new window are still throttled.
    expect(t.try()).toBe(false);
    vi.advanceTimersByTime(1999);
    expect(t.try()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(t.try()).toBe(true);
  });

  it('zero-ms throttle: every try() returns true', () => {
    const t = createThrottler(0);

    expect(t.try()).toBe(true);
    expect(t.try()).toBe(true);
    expect(t.try()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(t.try()).toBe(true);
  });
});
