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

import { randomUUID } from 'node:crypto';
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
  /** Caller's cursor as received — echoes back so clients can log drops. */
  priorCursor: number;
  /**
   * Stable identifier for this main-process run. Mismatch across polls means
   * the daemon restarted under the caller and ALL cached state (pane ids,
   * pty ids, cursors) must be discarded. Always present.
   */
  bootId: string;
  /** Number of events the caller missed before this poll, when known. */
  droppedCount?: number;
  /** True when the caller's cursor drifted past the ring (or jumped ahead). */
  resync?: true;
}

/**
 * Synchronous post-emit hook. Runs after the event has been committed to
 * the ring (so a subscriber that throws cannot prevent the event from being
 * polled by other clients), but inside the same JS task as `emit()` so
 * downstream side effects observe the new state immediately.
 *
 * Hooks are best-effort: a throw is caught and logged, never propagated.
 * Subscribers MUST NOT call `emit()` from inside a hook (re-entrancy is
 * not protected and the seq order would be opaque).
 */
export type EventBusSubscriber = (event: WmuxEvent) => void;

export class EventBus {
  private readonly buf: (WmuxEvent | undefined)[] = new Array(RING_CAPACITY);
  private head = 0;        // next write index
  private nextSeq = 1;     // monotonic
  private size = 0;        // number of valid entries
  /** UUID stamped at construction. Invalidates client caches on daemon restart. */
  readonly bootId: string = randomUUID();

  /**
   * Synchronous post-emit hooks. The store-tombstone wiring in
   * `src/main/index.ts` is the canonical example: when a `pane.closed`
   * event lands on the bus, `MetadataStore.onPaneDeleted(paneId)` runs in
   * the same task so the metadata.json file shrinks immediately and the
   * hydrated store never resurrects ghost panes on next boot.
   */
  private readonly subscribers: EventBusSubscriber[] = [];

  emit(input: EmitInput): WmuxEvent {
    const event = {
      ...input,
      seq: this.nextSeq++,
      ts: Date.now(),
    } as WmuxEvent;

    this.buf[this.head] = event;
    this.head = (this.head + 1) % RING_CAPACITY;
    if (this.size < RING_CAPACITY) this.size++;

    // Synchronous fan-out to in-process subscribers. The event is already
    // committed to the ring above, so a throwing subscriber cannot suppress
    // the event for `events.poll` consumers. We swallow + log to keep the
    // emit side effect-free from the caller's perspective.
    if (this.subscribers.length > 0) {
      for (const sub of this.subscribers) {
        try {
          sub(event);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[EventBus] subscriber threw on emit:', err);
        }
      }
    }
    return event;
  }

  /**
   * Register a synchronous subscriber that runs after every successful
   * `emit()`. Returns an unsubscribe function. Multiple subscribers run
   * in registration order; each is isolated by a try/catch so one
   * misbehaving subscriber cannot block the others.
   *
   * Intended for in-process lifecycle wiring (e.g. main-side
   * `MetadataStore.onPaneDeleted` on `pane.closed`). External clients
   * still pull via `events.poll`.
   */
  subscribe(handler: EventBusSubscriber): () => void {
    this.subscribers.push(handler);
    return () => {
      const idx = this.subscribers.indexOf(handler);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
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
    const latest = this.latestSeq();
    // Resync triggers when:
    //  (a) caller drifted past the ring window (cursor + 1 < oldest), OR
    //  (b) caller's cursor is in the future (cursor > latest) — daemon
    //      restarted under them OR client crafted a bogus cursor.
    // Either way, every cached pane/seq is suspect; bootId comparison gives
    // the client a clean recovery signal.
    const drifted = oldest > 0 && cursor + 1 < oldest;
    const ahead = cursor > latest;
    const resync = drifted || ahead ? true : undefined;
    const effectiveCursor = resync ? Math.max(0, oldest - 1) : cursor;
    const droppedCount = drifted ? oldest - cursor - 1 : undefined;

    // Walk from oldest to newest in seq order. Track the last *scanned* seq
    // (regardless of filter match) so subsequent polls don't re-scan events
    // that simply didn't match the filter — otherwise a filtered subscriber
    // pays O(N) per poll for events it never wants.
    const out: WmuxEvent[] = [];
    let lastScannedSeq = effectiveCursor;
    let reachedMax = false;
    if (this.size > 0) {
      const start = (this.head - this.size + RING_CAPACITY) % RING_CAPACITY;
      for (let i = 0; i < this.size; i++) {
        const idx = (start + i) % RING_CAPACITY;
        const ev = this.buf[idx];
        if (!ev) continue;
        if (ev.seq <= effectiveCursor) continue;
        lastScannedSeq = ev.seq;
        if (typeFilter && !typeFilter.has(ev.type)) continue;
        if (wsFilter && ev.workspaceId !== wsFilter) continue;
        out.push(ev);
        if (out.length >= max) {
          reachedMax = true;
          break;
        }
      }
    }

    // Cursor advancement:
    //  - If max truncated the page, the caller still has matching events to
    //    pick up — advance only to the last delivered event.
    //  - Otherwise, the loop drained everything in the ring; jump cursor to
    //    `lastScannedSeq` (covers filter no-matches) clamped to `latest` so
    //    a filtered subscriber doesn't re-scan the same N entries each poll.
    const nextCursor = reachedMax
      ? out[out.length - 1].seq
      : Math.max(lastScannedSeq, latest);

    const result: PollResult = {
      events: out,
      nextCursor,
      priorCursor: cursor,
      bootId: this.bootId,
    };
    if (resync) result.resync = true;
    if (droppedCount !== undefined && droppedCount > 0) result.droppedCount = droppedCount;
    return result;
  }

  /** Clear all events. Test-only; not exposed to RPC. */
  reset(): void {
    for (let i = 0; i < this.buf.length; i++) this.buf[i] = undefined;
    this.head = 0;
    this.nextSeq = 1;
    this.size = 0;
    // Drop registered subscribers so per-test wiring does not leak across
    // suite runs that share the module-level singleton.
    this.subscribers.length = 0;
  }
}

// Module-level singleton — main process only.
export const eventBus = new EventBus();
