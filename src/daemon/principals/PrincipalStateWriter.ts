// ─── PrincipalStateWriter ─────────────────────────────────────────────
// Persists PrincipalState (principals.json) to disk. Structure follows
// ChannelStateWriter exactly (saveImmediate / saveDebounced / load /
// flush / flushSync / dispose) — see the top of that file for the
// concurrency model.
//
// Like channels, it writes its own file (principals.json): registry
// corruption does not spill into session/channel state.
//
// Load-time cleanup:
//   - Stale pane-agent records whose lastSeenAt is past the TTL (default 7d)
//     are pruned. (The liveness backfill itself is the PrincipalService
//     constructor's job — same placement as the lastReadSeq backfill in the
//     ChannelService constructor.)

import path from 'node:path';
import {
  atomicReadJSONSync,
  atomicWriteJSON,
  atomicWriteJSONSync,
  createMigrator,
  PRINCIPAL_STATE_REGISTRY,
} from '../util/atomicWrite';
import { AsyncQueue } from '../util/AsyncQueue';
import {
  EMPTY_PRINCIPAL_STATE,
  PRINCIPAL_STALE_TTL_HOURS_DEFAULT,
  type PrincipalState,
} from '../../shared/principals';

const DEBOUNCE_MS = 30_000;
const QUEUE_KEY = 'principal-state';

export class PrincipalStateWriter {
  private filePath: string;
  private readonly staleTtlHours: number;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingState: PrincipalState | null = null;
  private readonly queue = new AsyncQueue();
  private immediateEpoch = 0;
  private lastImmediateState: PrincipalState | null = null;

  constructor(
    baseDir: string,
    staleTtlHours: number = PRINCIPAL_STALE_TTL_HOURS_DEFAULT,
  ) {
    this.filePath = path.join(baseDir, 'principals.json');
    this.staleTtlHours = staleTtlHours;

    this.queue.setSyncFallback(QUEUE_KEY, () => {
      if (this.pendingState !== null) {
        atomicWriteJSONSync(this.filePath, this.pendingState, {
          validate: PrincipalStateWriter.isPrincipalState,
          rotationEnabled: true,
        });
        this.pendingState = null;
      }
    });
  }

  /** Synchronous save for structural changes (new/delete/liveness transition). Returns false on failure. */
  saveImmediate(state: PrincipalState): boolean {
    this.immediateEpoch++;
    this.lastImmediateState = state;
    this.queue.clear();
    try {
      atomicWriteJSONSync(this.filePath, state, {
        validate: PrincipalStateWriter.isPrincipalState,
        rotationEnabled: true,
      });
      this.pendingState = null;
      return true;
    } catch (err) {
      console.error('[PrincipalStateWriter] Failed to save state:', err);
      return false;
    }
  }

  /** For frequent changes like lastSeenAt refresh — coalesced over 30s. */
  saveDebounced(state: PrincipalState): void {
    this.pendingState = state;

    if (this.debounceTimer !== null) {
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const snapshot = this.pendingState;
      if (snapshot === null) return;

      void this.queue.enqueue(QUEUE_KEY, async () => {
        const payload = this.pendingState;
        if (payload === null) return;
        const epochAtStart = this.immediateEpoch;
        try {
          await atomicWriteJSON(this.filePath, payload, {
            validate: PrincipalStateWriter.isPrincipalState,
            rotationEnabled: true,
          });
          // Race recovery against saveImmediate — same as ChannelStateWriter.
          if (
            this.immediateEpoch !== epochAtStart &&
            this.lastImmediateState !== null
          ) {
            try {
              atomicWriteJSONSync(this.filePath, this.lastImmediateState, {
                validate: PrincipalStateWriter.isPrincipalState,
                rotationEnabled: true,
              });
            } catch (err) {
              console.error(
                '[PrincipalStateWriter] Failed to restore superseded immediate save:',
                err,
              );
            }
          }
          if (this.pendingState === payload) {
            this.pendingState = null;
          }
        } catch (err) {
          console.error(
            '[PrincipalStateWriter] Failed to save state (async):',
            err,
          );
        }
      });
    }, DEBOUNCE_MS);
  }

  /**
   * Load from disk + stale TTL cleanup. Parse/validation failures go through
   * `.bak` recovery and ultimately degrade to an empty state (the registry is
   * derivable info, so loss is not catastrophic — it is restored by renderer
   * re-registration).
   */
  load(): PrincipalState {
    const migrator = createMigrator<PrincipalState>(
      PRINCIPAL_STATE_REGISTRY,
      this.filePath,
    );

    let state: PrincipalState | null = null;
    try {
      state = atomicReadJSONSync<PrincipalState>(this.filePath, {
        validate: PrincipalStateWriter.isPrincipalState,
        migrator,
      });
    } catch (err) {
      console.error('[PrincipalStateWriter] Failed to load state:', err);
    }

    if (!state) {
      return { ...EMPTY_PRINCIPAL_STATE, principals: [] };
    }

    // TTL cleanup of stale pane-agent records — prevents dead coordinates
    // from piling up indefinitely. human/external records are not pruned
    // (human:me is permanent, external gets a separate lifetime policy in R4).
    const now = Date.now();
    const cutoffMs = this.staleTtlHours * 60 * 60 * 1000;
    state.principals = state.principals.filter((p) => {
      if (p.kind !== 'pane-agent') return true;
      if (p.liveness !== 'stale') return true;
      return now - p.lastSeenAt < cutoffMs;
    });

    return state;
  }

  /** Write any pending debounce immediately. */
  flush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingState !== null) {
      this.saveImmediate(this.pendingState);
    }
  }

  /** Synchronous drain for the process-exit path — same order as ChannelStateWriter.flushSync. */
  flushSync(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.queue.flushSync();
    if (this.pendingState !== null) {
      const state = this.pendingState;
      this.pendingState = null;
      try {
        atomicWriteJSONSync(this.filePath, state, {
          validate: PrincipalStateWriter.isPrincipalState,
          rotationEnabled: true,
        });
      } catch (err) {
        console.error(
          '[PrincipalStateWriter] flushSync immediate write failed:',
          err,
        );
      }
    }
  }

  /** On daemon shutdown, clear timers + flush any remaining state. */
  dispose(): void {
    this.flush();
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /**
   * Type guard — ChannelStateWriter convention: validate version + container,
   * then spot-check only the first row. Row corruption fails the whole
   * validation → leads to `.bak` recovery.
   */
  private static isPrincipalState(parsed: unknown): parsed is PrincipalState {
    if (typeof parsed !== 'object' || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;

    if (typeof obj['version'] !== 'number') return false;
    if (!Array.isArray(obj['principals'])) return false;

    const rows = obj['principals'] as unknown[];
    if (rows.length > 0 && !isValidPrincipalRow(rows[0])) return false;

    return true;
  }
}

/** Spot-check the minimal PrincipalRecord shape. Optional fields are not checked (additive convention). */
function isValidPrincipalRow(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const p = row as Record<string, unknown>;
  return (
    typeof p['id'] === 'string' &&
    (p['kind'] === 'human' || p['kind'] === 'pane-agent' || p['kind'] === 'external') &&
    typeof p['display'] === 'string' &&
    (p['liveness'] === 'live' || p['liveness'] === 'stale') &&
    typeof p['createdAt'] === 'number' &&
    typeof p['lastSeenAt'] === 'number'
  );
}
