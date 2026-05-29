/**
 * RCA A6 — control-pipe connect retry + error classification.
 *
 * DaemonClient.connect() was a SINGLE-SHOT net.createConnection: on any error
 * or timeout it resolved(false) with no retry. On Windows, AV scans and handle
 * contention cause transient named-pipe EPERM/ECONNRESET constantly — so a 50ms
 * blip was treated identically to a dead daemon, turning a momentary hiccup into
 * a full control-pipe disconnect cascade (which can re-trigger the reconcile
 * path). wmux-client.ts already retried + fell back; DaemonClient did not.
 *
 * This module holds the retry policy as a pure, dependency-injected function
 * (no electron/net import) so it can be unit-tested in isolation, mirroring
 * reconnectPtyWithRetry. The classification rule is the crux: only ENOENT /
 * ECONNREFUSED mean the daemon is genuinely absent (don't retry); everything
 * else is transient and worth a bounded retry.
 */

export interface ConnectAttemptResult {
  ok: boolean;
  /** The socket error code (EPERM/ECONNREFUSED/ENOENT/…) when ok === false. */
  code?: string;
  /** True when the attempt hit the per-attempt connect timeout. */
  timedOut?: boolean;
}

export type ConnectFailureClass = 'permanent' | 'transient';

/**
 * ENOENT (pipe/socket absent) and ECONNREFUSED (nothing listening) mean the
 * daemon is genuinely not present — retrying is pointless, return fast.
 * Everything else (EPERM / ECONNRESET / EPIPE / ETIMEDOUT / a timeout / an
 * unknown code) is a transient Windows named-pipe condition worth a retry.
 */
export function classifyConnectFailure(
  code: string | undefined,
  timedOut: boolean | undefined,
): ConnectFailureClass {
  if (timedOut) return 'transient';
  if (code === 'ENOENT' || code === 'ECONNREFUSED') return 'permanent';
  return 'transient';
}

/**
 * Bounded backoff. Kept small (sum 1.7s) so connect's internal retry does not
 * compound badly with DaemonRespawnController's whole-respawn backoff. The only
 * way to approach the worst case (4 × the 5s per-attempt timeout) is a pipe that
 * repeatedly accepts-then-hangs, which is not the EPERM/ECONNRESET blip this
 * guards against — those fail fast via the 'error' event.
 */
export const DAEMON_CONNECT_BACKOFFS_MS = [200, 500, 1000];

export interface ConnectRetryDeps {
  /** Perform one connect attempt. */
  attempt: () => Promise<ConnectAttemptResult>;
  /** Sleep between retries. Injectable so tests don't wait real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Bail early (return true) if a concurrent path already connected. */
  isConnected?: () => boolean;
  /** Optional structured logger. */
  log?: (message: string) => void;
  /** Override the backoff schedule (default DAEMON_CONNECT_BACKOFFS_MS). */
  backoffsMs?: number[];
}

/**
 * Retry a connect attempt with bounded backoff, stopping immediately (fast
 * false) on a PERMANENT failure and retrying TRANSIENT failures.
 */
export async function connectWithRetry(deps: ConnectRetryDeps): Promise<boolean> {
  const backoffs = deps.backoffsMs ?? DAEMON_CONNECT_BACKOFFS_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isConnected = deps.isConnected ?? (() => false);
  const log = deps.log ?? (() => { /* silent by default */ });

  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    if (isConnected()) return true; // a concurrent connect won the race
    const result = await deps.attempt();
    if (result.ok) return true;

    if (classifyConnectFailure(result.code, result.timedOut) === 'permanent') {
      log(`permanent connect failure code=${result.code ?? '?'} — daemon not present, no retry`);
      return false;
    }

    if (attempt < backoffs.length) {
      log(
        `transient connect failure ${result.timedOut ? 'timeout' : 'code=' + (result.code ?? '?')} — retry ${attempt + 1}/${backoffs.length} after ${backoffs[attempt]}ms`,
      );
      await sleep(backoffs[attempt]);
    }
  }
  log(`connect exhausted ${backoffs.length} retries`);
  return false;
}
