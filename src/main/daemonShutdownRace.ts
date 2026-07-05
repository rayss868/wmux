// Side-effect-free helper for racing daemon.shutdown against a budget.
//
// Phase A — A3 (before-quit) and A5 (session-end / WM_ENDSESSION) both need
// to send daemon.shutdown via the control RPC, wait up to a bounded time for
// the daemon to dump RingBuffers atomically, then fall back to the existing
// detach-only path if the daemon does not finish in time.
//
// The default timeout is calibrated by the T5 dynamic test (Task #15);
// callers pass a measured value. Until that measurement lands, callers pass
// the documented placeholder of 4 s for before-quit and 1 s for session-end.

export interface DaemonShutdownRaceResult {
  ok: boolean;
  /** Reason for the failure, if any. Useful for log breadcrumbs. */
  error?: string;
  /** B′ additive from the daemon's shutdown ack: false means the suspended
   *  state save failed (recovery degrades to periodic snapshots); undefined
   *  when a pre-B′ daemon doesn't report the field or the race failed. */
  stateSaved?: boolean;
}

// Minimal client shape used here. Decouples this helper from DaemonClient so
// tests can pass a tiny stub instead of bootstrapping a real net pipe.
export interface DaemonShutdownClient {
  rpc: (
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ) => Promise<unknown>;
}

export async function raceDaemonShutdown(
  client: DaemonShutdownClient,
  timeoutMs: number,
): Promise<DaemonShutdownRaceResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const ack = await Promise.race([
      client.rpc('daemon.shutdown', {}, { timeoutMs }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`daemon.shutdown race timeout (${timeoutMs}ms)`)),
          timeoutMs,
        );
      }),
    ]);
    // Surface the B′ `stateSaved` additive when the daemon reports it —
    // only an explicit boolean passes through (pre-B′ daemons omit it).
    const reported = (ack as { stateSaved?: unknown } | null | undefined)?.stateSaved;
    return { ok: true, ...(typeof reported === 'boolean' ? { stateSaved: reported } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
