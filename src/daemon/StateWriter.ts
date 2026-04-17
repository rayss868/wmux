import fs from 'node:fs';
import path from 'node:path';
import type { DaemonState } from './types';
import {
  atomicReadJSONSync,
  atomicWriteJSONSync,
} from './util/atomicWrite';

const DEBOUNCE_MS = 30_000;

/**
 * Persists DaemonState (sessions.json) to disk using the shared
 * atomic-write helpers in `./util/atomicWrite`. The public API
 * (saveImmediate / saveDebounced / load / flush / dispose) is frozen
 * so T2 can layer AsyncQueue onto the debounce path without changing
 * call sites.
 */
export class StateWriter {
  private filePath: string;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingState: DaemonState | null = null;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, 'sessions.json');
  }

  /** Immediately write state to disk (session create/destroy/state change). */
  saveImmediate(state: DaemonState): void {
    try {
      atomicWriteJSONSync(this.filePath, state);

      // Clear pending since we just saved
      this.pendingState = null;
    } catch (err) {
      console.error('[StateWriter] Failed to save state:', err);
    }
  }

  /** Debounced save — coalesces frequent updates (e.g. lastActivity) over 30s. */
  saveDebounced(state: DaemonState): void {
    this.pendingState = state;

    if (this.debounceTimer !== null) {
      return; // Timer already running; state will be picked up when it fires
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.pendingState !== null) {
        this.saveImmediate(this.pendingState);
      }
    }, DEBOUNCE_MS);
  }

  /** Load state from disk. Falls back to .bak on failure. Prunes expired DEAD sessions. */
  load(): DaemonState {
    const empty: DaemonState = { version: 1, sessions: [] };

    let state: DaemonState | null = null;
    try {
      state = atomicReadJSONSync<DaemonState>(this.filePath, {
        validate: StateWriter.isDaemonState,
      });
    } catch (err) {
      console.error('[StateWriter] Failed to load state:', err);
    }

    if (!state) {
      return empty;
    }

    // Prune DEAD sessions that exceeded their TTL
    state.sessions = state.sessions.filter((s) => {
      if (s.state !== 'dead') return true;
      const deadSince = new Date(s.lastActivity).getTime();
      const ttlMs = s.deadTtlHours * 60 * 60 * 1000;
      return Date.now() - deadSince < ttlMs;
    });

    return state;
  }

  /** Flush pending debounce — if there is pending state, write it immediately. */
  flush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingState !== null) {
      this.saveImmediate(this.pendingState);
    }
  }

  /** Clean up timers (daemon shutdown). Flushes pending state first. */
  dispose(): void {
    this.flush();
  }

  /** Get the path where a session's scrollback buffer should be dumped. */
  getBufferDumpPath(sessionId: string): string {
    return path.join(path.dirname(this.filePath), 'buffers', `${sessionId}.buf`);
  }

  /** Ensure the buffers/ directory exists. */
  ensureBufferDir(): void {
    const dir = path.join(path.dirname(this.filePath), 'buffers');
    if (!fs.existsSync(dir)) {
      // Note: mode is no-op on Windows; use icacls for NTFS ACLs
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** Remove orphaned .buf files not referenced by any session. */
  cleanOrphanedBuffers(activeIds: Set<string>): void {
    const dir = path.join(path.dirname(this.filePath), 'buffers');
    if (!fs.existsSync(dir)) return;
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.buf')) continue;
        const id = file.replace(/\.buf$/, '');
        if (!activeIds.has(id)) {
          try { fs.unlinkSync(path.join(dir, file)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /**
   * Type guard used by the shared atomic-read helper. Validates the
   * minimum required shape; full schema validation lives in Wave 3.
   */
  private static isDaemonState(parsed: unknown): parsed is DaemonState {
    if (typeof parsed !== 'object' || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;

    if (typeof obj['version'] !== 'number') return false;
    if (!Array.isArray(obj['sessions'])) return false;

    // Validate each session has minimum required fields
    for (const s of obj['sessions'] as unknown[]) {
      if (typeof s !== 'object' || s === null) return false;
      const sess = s as Record<string, unknown>;
      if (typeof sess['id'] !== 'string') return false;
      if (typeof sess['state'] !== 'string') return false;
    }

    return true;
  }
}
