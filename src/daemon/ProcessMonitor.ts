/**
 * Monitors child process liveness by periodically checking PID status.
 * No Electron dependencies — uses only Node.js APIs.
 *
 * Uses a single batched tasklist call (on Windows) to check all watched PIDs
 * at once, instead of spawning one process per session.
 */
export class ProcessMonitor {
  private watchedPids: Map<string, { pid: number; onDead: () => void }> = new Map();
  private batchInterval: NodeJS.Timeout | null = null;
  private batchRunning = false;

  private static readonly CHECK_INTERVAL_MS = 5000;

  /** Check whether a process with the given PID is still alive (individual check). */
  static async isAlive(pid: number): Promise<boolean> {
    if (process.platform === 'win32') {
      // process.kill(pid, 0) is unreliable on Windows — always returns true.
      // Use tasklist which is available on all Windows versions.
      try {
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);
        const pathMod = require('path');
        const systemRoot = process.env.SystemRoot || 'C:\\Windows';
        const tasklist = pathMod.join(systemRoot, 'System32', 'tasklist.exe');
        const { stdout } = await execFileAsync(
          tasklist,
          ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
          { encoding: 'utf-8', timeout: 3000, windowsHide: true },
        );
        return (stdout as string).includes(`"${pid}"`);
      } catch {
        return false;
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Positively confirm a PID is dead. Returns true ONLY when the liveness
   * probe SUCCEEDS and reports the PID absent. THROWS when the probe itself
   * fails (tasklist timeout/error) so the caller can tell "confirmed dead"
   * from "couldn't check" and defer rather than kill.
   *
   * This is the critical distinction `isAlive` collapses: `isAlive` returns
   * `false` on a probe error, conflating an unreachable/slow tasklist with a
   * genuinely dead process. On machines where tasklist intermittently times
   * out, that false negative makes the watch loop fire onDead for LIVE
   * sessions (observed: powershell panes "exit -1" with exitCode=null while
   * the process is still running). The kill gate must require positive proof.
   */
  static async isDefinitelyDead(pid: number): Promise<boolean> {
    if (process.platform === 'win32') {
      const { execFile } = require('child_process');
      const { promisify } = require('util');
      const execFileAsync = promisify(execFile);
      const pathMod = require('path');
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const tasklist = pathMod.join(systemRoot, 'System32', 'tasklist.exe');
      // No catch: a timeout/error rejects, and the caller treats a rejection
      // as "unknown — do not kill". A clean run that lacks the PID is the only
      // path to a confirmed death.
      const { stdout } = await execFileAsync(
        tasklist,
        ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'],
        { encoding: 'utf-8', timeout: 3000, windowsHide: true },
      );
      return !(stdout as string).includes(`"${pid}"`);
    }
    // POSIX: kill(pid, 0) is reliable. ESRCH ⇒ dead; EPERM ⇒ alive (not ours).
    try {
      process.kill(pid, 0);
      return false; // signal delivered ⇒ alive
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true; // no such process
      return false; // EPERM or other ⇒ exists / can't prove dead
    }
  }

  /**
   * Batch-check all given PIDs in a single tasklist call (Windows).
   * Returns the set of PIDs that are alive.
   */
  static async batchCheckAlive(pids: number[]): Promise<Set<number>> {
    const alive = new Set<number>();
    if (pids.length === 0) return alive;

    if (process.platform === 'win32') {
      try {
        const { execFile } = require('child_process');
        const { promisify } = require('util');
        const execFileAsync = promisify(execFile);
        const pathMod = require('path');
        const systemRoot = process.env.SystemRoot || 'C:\\Windows';
        const tasklist = pathMod.join(systemRoot, 'System32', 'tasklist.exe');
        // Single call: get full process list in CSV format (no filter)
        const { stdout } = await execFileAsync(
          tasklist,
          ['/fo', 'csv', '/nh'],
          { encoding: 'utf-8', timeout: 10000, windowsHide: true },
        );
        // Build a set of all running PIDs from the output
        const pidSet = new Set(pids);
        const lines = (stdout as string).split('\n');
        for (const line of lines) {
          // CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
          const match = line.match(/^"[^"]*","(\d+)"/);
          if (match) {
            const runningPid = parseInt(match[1], 10);
            if (pidSet.has(runningPid)) {
              alive.add(runningPid);
            }
          }
        }
      } catch {
        // On failure, fall back to individual checks
        for (const pid of pids) {
          if (await ProcessMonitor.isAlive(pid)) {
            alive.add(pid);
          }
        }
      }
    } else {
      // Non-Windows: use process.kill(pid, 0) for each
      for (const pid of pids) {
        try {
          process.kill(pid, 0);
          alive.add(pid);
        } catch {
          // not alive
        }
      }
    }
    return alive;
  }

  /** Start monitoring a process. Calls onDead when the process is no longer alive. */
  watch(sessionId: string, pid: number, onDead: () => void): void {
    // Clear any existing watcher for this session
    this.unwatch(sessionId);
    this.watchedPids.set(sessionId, { pid, onDead });
    this.ensureBatchInterval();
    // Immediate first check so a PID that is already dead at watch() time
    // doesn't have to wait CHECK_INTERVAL_MS for the first interval tick.
    // batchRunning guards against concurrent overlap with a running cycle.
    void this.runBatchCheck();
  }

  /** Stop monitoring a specific session. */
  unwatch(sessionId: string): void {
    this.watchedPids.delete(sessionId);
    // Stop the batch interval if nothing is being watched
    if (this.watchedPids.size === 0 && this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
  }

  /** Stop monitoring all sessions. */
  unwatchAll(): void {
    this.watchedPids.clear();
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
    this.batchRunning = false;
  }

  /** Ensure a single batch interval is running. */
  private ensureBatchInterval(): void {
    if (this.batchInterval) return;
    this.batchInterval = setInterval(() => {
      this.runBatchCheck();
    }, ProcessMonitor.CHECK_INTERVAL_MS);
    if (this.batchInterval.unref) {
      this.batchInterval.unref();
    }
  }

  /** Run one batch check cycle. */
  private runBatchCheck(): void {
    if (this.batchRunning) return; // skip if previous check still in flight
    if (this.watchedPids.size === 0) return;

    this.batchRunning = true;

    // Snapshot the current watch list
    const entries = Array.from(this.watchedPids.entries());
    const pids = entries.map(([, v]) => v.pid);

    void ProcessMonitor.batchCheckAlive(pids)
      .then(async (aliveSet) => {
        // Collect every session the batch reports dead, then re-verify each one
        // via a second, independent `tasklist /fi PID eq <pid>` call. The batch
        // path uses the unfiltered process list (`tasklist /fo csv /nh`); any
        // truncation, locale mismatch, or transient empty stdout in that single
        // call would otherwise mark every watched PID dead in one cycle and
        // cascade-fire onDead for every session simultaneously. The per-PID
        // re-verify uses different command arguments and an independent
        // execFile invocation, so a parse failure in one is highly unlikely
        // to repeat in the other.
        const apparentlyDead: Array<[string, { pid: number; onDead: () => void }]> = [];
        for (const entry of entries) {
          const [sessionId, info] = entry;
          if (!this.watchedPids.has(sessionId)) continue;
          if (!aliveSet.has(info.pid)) apparentlyDead.push(entry);
        }

        if (apparentlyDead.length === 0) return;

        for (const [sessionId, { pid, onDead }] of apparentlyDead) {
          // Skip if unwatched during async re-verification
          if (!this.watchedPids.has(sessionId)) continue;

          let confirmedDead = false;
          try {
            // Require POSITIVE proof of death. isDefinitelyDead throws when the
            // probe itself fails (tasklist timeout), so a slow/unreachable
            // tasklist can NEVER be read as "dead" — it falls into the catch
            // and defers. (Previously this used `!isAlive(pid)`, which returns
            // false on a probe error and thus mis-fired onDead for live
            // sessions whenever tasklist timed out — the "powershell exit -1 /
            // exitCode=null" false death.)
            confirmedDead = await ProcessMonitor.isDefinitelyDead(pid);
          } catch {
            // Probe failed (timeout/error): cannot confirm death. Defer to the
            // next cycle rather than killing a possibly-live session. Better to
            // leave a watcher in place for one extra tick than to mass-kill
            // live sessions when the OS is having a bad five seconds.
            confirmedDead = false;
          }

          if (!confirmedDead) continue;
          if (!this.watchedPids.has(sessionId)) continue;
          this.unwatch(sessionId);
          onDead();
        }
      })
      .catch(() => {
        // Batch check failed entirely — skip this cycle
      })
      .finally(() => {
        this.batchRunning = false;
      });
  }
}
