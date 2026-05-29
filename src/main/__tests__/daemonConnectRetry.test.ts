import { describe, it, expect, vi } from 'vitest';
import {
  connectWithRetry,
  classifyConnectFailure,
  DAEMON_CONNECT_BACKOFFS_MS,
  type ConnectAttemptResult,
} from '../daemonConnectRetry';

// RCA A6 — control-pipe connect retry. The bug: a single transient Windows
// named-pipe blip (EPERM/ECONNRESET from AV scan / handle contention) was
// treated as a dead daemon. These tests lock in: retry transient, fail fast on
// genuinely-absent (ENOENT/ECONNREFUSED), bounded retries.

const noSleep = () => Promise.resolve();
const noLog = () => { /* silent */ };

describe('classifyConnectFailure', () => {
  it('ENOENT and ECONNREFUSED are permanent (daemon absent)', () => {
    expect(classifyConnectFailure('ENOENT', false)).toBe('permanent');
    expect(classifyConnectFailure('ECONNREFUSED', false)).toBe('permanent');
  });
  it('EPERM / ECONNRESET / unknown / timeout are transient', () => {
    expect(classifyConnectFailure('EPERM', false)).toBe('transient');
    expect(classifyConnectFailure('ECONNRESET', false)).toBe('transient');
    expect(classifyConnectFailure('EPIPE', false)).toBe('transient');
    expect(classifyConnectFailure(undefined, false)).toBe('transient');
    expect(classifyConnectFailure('ENOENT', true)).toBe('transient'); // a timeout always retries
  });
});

describe('connectWithRetry', () => {
  const ok = (): ConnectAttemptResult => ({ ok: true });
  const err = (code: string): ConnectAttemptResult => ({ ok: false, code });
  const timeout = (): ConnectAttemptResult => ({ ok: false, timedOut: true });

  it('succeeds on the first attempt → true, no retry', async () => {
    const attempt = vi.fn(async () => ok());
    const r = await connectWithRetry({ attempt, sleep: noSleep, log: noLog });
    expect(r).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('permanent failure (ENOENT) → false, exactly one attempt (no retry)', async () => {
    const attempt = vi.fn(async () => err('ENOENT'));
    const sleep = vi.fn(noSleep);
    const r = await connectWithRetry({ attempt, sleep, log: noLog });
    expect(r).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('permanent failure (ECONNREFUSED) → false fast', async () => {
    const attempt = vi.fn(async () => err('ECONNREFUSED'));
    const r = await connectWithRetry({ attempt, sleep: noSleep, log: noLog });
    expect(r).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('transient (EPERM) then success → true, retried', async () => {
    let n = 0;
    const attempt = vi.fn(async () => (++n === 1 ? err('EPERM') : ok()));
    const sleep = vi.fn(noSleep);
    const r = await connectWithRetry({ attempt, sleep, log: noLog });
    expect(r).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('transient timeout then success → true', async () => {
    let n = 0;
    const attempt = vi.fn(async () => (++n === 1 ? timeout() : ok()));
    const r = await connectWithRetry({ attempt, sleep: noSleep, log: noLog });
    expect(r).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('all transient → exhausts the backoff budget then false', async () => {
    const attempt = vi.fn(async () => err('ECONNRESET'));
    const r = await connectWithRetry({ attempt, sleep: noSleep, log: noLog });
    expect(r).toBe(false);
    // initial attempt + one per backoff slot
    expect(attempt).toHaveBeenCalledTimes(DAEMON_CONNECT_BACKOFFS_MS.length + 1);
  });

  it('isConnected() already true → returns true without attempting (concurrent win)', async () => {
    const attempt = vi.fn(async () => ok());
    const r = await connectWithRetry({ attempt, isConnected: () => true, sleep: noSleep, log: noLog });
    expect(r).toBe(true);
    expect(attempt).not.toHaveBeenCalled();
  });
});
