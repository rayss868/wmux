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

    ProcessMonitor.batchCheckAlive(pids)
      .then((aliveSet) => {
        for (const [sessionId, { pid, onDead }] of entries) {
          // Only fire callback if still being watched (could have been unwatched during check)
          if (!this.watchedPids.has(sessionId)) continue;
          if (!aliveSet.has(pid)) {
            this.unwatch(sessionId);
            onDead();
          }
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
