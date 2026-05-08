// === wmux EventBus ===
//
// In-memory ring buffer that captures pane/process lifecycle events and lets
// external clients pull them via `events.poll(cursor)`. Single global ring of
// RING_CAPACITY events; workspace scoping is done at poll time.
//
// Workflow:
//   - Producers (paneSlice via IPC, PTYBridge directly) call `eventBus.emit(...)`
//     with a partial event; EventBus stamps `seq` + `ts` and stores it.
//   - Consumers call `eventBus.poll(cursor)` with the seq of their last seen
//     event; the bus returns all events with `seq > cursor` matching the
//     filter, plus the new cursor and a `resync` flag if the caller drifted
//     past the ring window.

import type {
  WmuxEvent,
  WmuxEventType,
} from '../../shared/events';
import { RING_CAPACITY, POLL_DEFAULT_MAX } from '../../shared/events';

export interface EmitInput {
  type: WmuxEventType;
  workspaceId: string;
  // Type-specific fields are passed through unchanged.
  [k: string]: unknown;
}

export interface PollOptions {
  types?: readonly WmuxEventType[];
  workspaceId?: string;
  max?: number;
}

export interface PollResult {
  events: WmuxEvent[];
  nextCursor: number;
  resync?: true;
}

export class EventBus {
  private readonly buf: (WmuxEvent | undefined)[] = new Array(RING_CAPACITY);
  private head = 0;        // next write index
  private nextSeq = 1;     // monotonic
  private size = 0;        // number of valid entries

  emit(input: EmitInput): WmuxEvent {
    const event = {
      ...input,
      seq: this.nextSeq++,
      ts: Date.now(),
    } as WmuxEvent;

    this.buf[this.head] = event;
    this.head = (this.head + 1) % RING_CAPACITY;
    if (this.size < RING_CAPACITY) this.size++;
    return event;
  }

  /**
   * Lowest seq still present in the ring. Useful for stale-cursor detection.
   * Returns 0 when the ring is empty.
   */
  oldestSeq(): number {
    if (this.size === 0) return 0;
    // The oldest entry sits at (head - size + RING_CAPACITY) % RING_CAPACITY.
    const oldestIdx = (this.head - this.size + RING_CAPACITY) % RING_CAPACITY;
    return this.buf[oldestIdx]?.seq ?? 0;
  }

  /**
   * Latest seq written. 0 when the ring is empty. Used as the next cursor
   * for callers who want "everything from now on".
   */
  latestSeq(): number {
    return this.nextSeq - 1;
  }

  poll(cursor: number, opts?: PollOptions): PollResult {
    const max = Math.max(1, Math.min(opts?.max ?? POLL_DEFAULT_MAX, RING_CAPACITY));
    const typeFilter = opts?.types && opts.types.length > 0 ? new Set(opts.types) : null;
    const wsFilter = opts?.workspaceId;

    const oldest = this.oldestSeq();
    // The caller's next-expected event has seq = cursor + 1. If that's lower
    // than the oldest event still in the ring, they've drifted and lost
    // events — flag resync so the caller can reconcile via pane.list.
    const resync = oldest > 0 && cursor + 1 < oldest ? true : undefined;
    const effectiveCursor = resync ? oldest - 1 : cursor;

    // Walk from oldest to newest in seq order.
    const out: WmuxEvent[] = [];
    if (this.size > 0) {
      const start = (this.head - this.size + RING_CAPACITY) % RING_CAPACITY;
      for (let i = 0; i < this.size; i++) {
        const idx = (start + i) % RING_CAPACITY;
        const ev = this.buf[idx];
        if (!ev) continue;
        if (ev.seq <= effectiveCursor) continue;
        if (typeFilter && !typeFilter.has(ev.type)) continue;
        if (wsFilter && ev.workspaceId !== wsFilter) continue;
        out.push(ev);
        if (out.length >= max) break;
      }
    }

    const nextCursor = out.length > 0
      ? out[out.length - 1].seq
      : Math.max(effectiveCursor, this.latestSeq());

    return resync ? { events: out, nextCursor, resync } : { events: out, nextCursor };
  }

  /** Clear all events. Test-only; not exposed to RPC. */
  reset(): void {
    for (let i = 0; i < this.buf.length; i++) this.buf[i] = undefined;
    this.head = 0;
    this.nextSeq = 1;
    this.size = 0;
  }
}

// Module-level singleton — main process only.
export const eventBus = new EventBus();
