import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AsyncQueue } from '../AsyncQueue';

/**
 * Edge-case tests for `AsyncQueue`. Complements `AsyncQueue.test.ts`
 * (which covers the baseline happy paths) with deeper interaction
 * scenarios that StateWriter's debounced-write flow relies on:
 *   - interleaved FIFO + coalescing
 *   - flushSync() on mixed fallback/no-fallback keys
 *   - task isolation (reject + sync throw)
 *   - clear() semantics
 *   - debounced enqueue with fake timers
 *   - concurrency stress
 */

/** Helper — advance the microtask queue `n` times. */
async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

/** Deferred used to gate tasks in `running` state for coalescing tests. */
function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('AsyncQueue — edge cases', () => {
  // ── FIFO + coalescing interaction ────────────────────────────────

  it('interleaves FIFO across keys with mid-run re-enqueue of a running key', async () => {
    // Scenario: enqueue A, B. A starts running (and is thus no longer
    // in pending). Re-enqueue A before it finishes → A should run
    // again AFTER B (because the new A goes to the tail of pending
    // which already contains B). Then finish with B.
    const queue = new AsyncQueue();
    const order: string[] = [];

    const gateA = defer();
    const pA1 = queue.enqueue('A', async () => {
      order.push('A1-start');
      await gateA.promise;
      order.push('A1-end');
    });
    const pB = queue.enqueue('B', async () => {
      order.push('B');
    });

    // Let the pump pick up A so it is currently running.
    await tick(2);
    expect(order).toEqual(['A1-start']);

    // Re-enqueue A while A1 is running. A is not in pending (it's
    // running), so this is a brand-new tail entry, NOT a coalesce.
    const pA2 = queue.enqueue('A', async () => {
      order.push('A2');
    });

    gateA.resolve();
    await Promise.all([pA1, pB, pA2]);

    // Running A1 completes first; then pending drains in FIFO order:
    // B was enqueued before the second A, so B runs first, then A2.
    expect(order).toEqual(['A1-start', 'A1-end', 'B', 'A2']);
  });

  it('coalesces a single key without disturbing FIFO of other pending keys', async () => {
    const queue = new AsyncQueue();
    const order: string[] = [];

    // Block the queue so A/B/C all sit in pending.
    const gate = defer();
    const blocker = queue.enqueue('blocker', async () => {
      await gate.promise;
      order.push('blocker');
    });
    await tick(2); // pump picks up 'blocker' (now running)

    queue.enqueue('A', async () => { order.push('A'); });
    queue.enqueue('B', async () => { order.push('B'); });
    queue.enqueue('C', async () => { order.push('C'); });

    // Coalesce B — replace with B' that pushes a different marker.
    queue.enqueue('B', async () => { order.push('B-prime'); });

    gate.resolve();
    await blocker;
    await queue.flush();

    // FIFO order of keys [A, B, C] preserved; B's payload replaced.
    expect(order).toEqual(['blocker', 'A', 'B-prime', 'C']);
  });

  // ── Coalescing spec (mock-based) ─────────────────────────────────

  it('only the last task in a coalesced chain is actually invoked', async () => {
    const queue = new AsyncQueue();

    // Block the queue so subsequent enqueues all land in pending at once.
    const gate = defer();
    const blocker = queue.enqueue('blocker', async () => { await gate.promise; });
    await tick(2);

    const task1 = vi.fn(async () => {});
    const task2 = vi.fn(async () => {});
    const task3 = vi.fn(async () => {});

    queue.enqueue('k', task1);
    queue.enqueue('k', task2); // coalesces task1
    queue.enqueue('k', task3); // coalesces task2

    gate.resolve();
    await blocker;
    await queue.flush();

    expect(task1).not.toHaveBeenCalled();
    expect(task2).not.toHaveBeenCalled();
    expect(task3).toHaveBeenCalledTimes(1);
  });

  it('coalesced (superseded) task promises resolve — not reject', async () => {
    const queue = new AsyncQueue();

    const gate = defer();
    const blocker = queue.enqueue('blocker', async () => { await gate.promise; });
    await tick(2);

    const p1 = queue.enqueue('k', async () => {});
    const p2 = queue.enqueue('k', async () => {});
    const p3 = queue.enqueue('k', async () => {});

    gate.resolve();
    await blocker;

    // p1, p2 coalesced away → resolve as noop (no reject).
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
    await expect(p3).resolves.toBeUndefined();
  });

  // ── flush() edge cases ───────────────────────────────────────────

  it('flush() on empty queue resolves immediately (no waiter lingering)', async () => {
    const queue = new AsyncQueue();
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(queue.isIdle).toBe(true);
  });

  it('flush() waits for all three pending tasks to finish', async () => {
    const queue = new AsyncQueue();
    const runs: string[] = [];

    queue.enqueue('a', async () => { await tick(2); runs.push('a'); });
    queue.enqueue('b', async () => { await tick(2); runs.push('b'); });
    queue.enqueue('c', async () => { await tick(2); runs.push('c'); });

    expect(queue.isIdle).toBe(false);
    await queue.flush();
    expect(queue.isIdle).toBe(true);
    expect(runs).toEqual(['a', 'b', 'c']);
  });

  it('flush() resolves at the first idle point; enqueues after that resolve need a new flush', async () => {
    // This documents the current implementation: flushWaiters are
    // notified as soon as the pending queue drains and no task is
    // running. A later enqueue starts a new lifecycle and requires a
    // new flush() call.
    const queue = new AsyncQueue();
    const runs: string[] = [];

    queue.enqueue('a', async () => { runs.push('a'); });

    await queue.flush();
    expect(runs).toEqual(['a']);
    expect(queue.isIdle).toBe(true);

    // A new enqueue after the queue went idle — the previous flush's
    // promise has already resolved and cannot observe this work.
    queue.enqueue('b', async () => { runs.push('b'); });
    expect(queue.isIdle).toBe(false);

    // A second flush picks up the new work.
    await queue.flush();
    expect(runs).toEqual(['a', 'b']);
    expect(queue.isIdle).toBe(true);
  });

  // ── flushSync() edge cases ───────────────────────────────────────

  it('flushSync() skips keys without a registered fallback but still clears them', () => {
    const queue = new AsyncQueue();
    const invoked: string[] = [];

    // Only 'a' has a fallback; 'b' does not.
    queue.setSyncFallback('a', () => { invoked.push('a-fb'); });

    const pA = queue.enqueue('a', async () => { /* never */ });
    const pB = queue.enqueue('b', async () => { /* never */ });

    queue.flushSync();

    expect(invoked).toEqual(['a-fb']);
    // Both promises resolve as noops regardless of fallback presence.
    return Promise.all([
      expect(pA).resolves.toBeUndefined(),
      expect(pB).resolves.toBeUndefined(),
    ]).then(() => {
      expect(queue.isIdle).toBe(true);
    });
  });

  it('flushSync() continues past a throwing fallback and resolves later promises', async () => {
    const queue = new AsyncQueue();
    const invoked: string[] = [];

    // Silence expected console.error from the swallowed throw.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    queue.setSyncFallback('a', () => { throw new Error('boom'); });
    queue.setSyncFallback('b', () => { invoked.push('b-fb'); });
    queue.setSyncFallback('c', () => { invoked.push('c-fb'); });

    const pA = queue.enqueue('a', async () => { /* never */ });
    const pB = queue.enqueue('b', async () => { /* never */ });
    const pC = queue.enqueue('c', async () => { /* never */ });

    expect(() => queue.flushSync()).not.toThrow();
    expect(invoked).toEqual(['b-fb', 'c-fb']);
    expect(queue.isIdle).toBe(true);

    await Promise.all([pA, pB, pC]); // all resolve

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('queue is reusable after flushSync()', async () => {
    const queue = new AsyncQueue();
    queue.setSyncFallback('k', () => {});
    queue.enqueue('k', async () => {});
    queue.flushSync();
    expect(queue.isIdle).toBe(true);

    // Re-use the same instance: a new enqueue must still run normally.
    const ran = vi.fn(async () => {});
    const p = queue.enqueue('k', ran);
    await p;
    expect(ran).toHaveBeenCalledTimes(1);
    expect(queue.isIdle).toBe(true);
  });

  it('flushSync() on an empty queue is a no-op', () => {
    const queue = new AsyncQueue();
    expect(() => queue.flushSync()).not.toThrow();
    expect(queue.isIdle).toBe(true);
  });

  // ── Task exception isolation ─────────────────────────────────────

  it('a task that synchronously throws rejects its promise and the queue continues', async () => {
    const queue = new AsyncQueue();
    const runs: string[] = [];

    const pFail = queue.enqueue('a', () => {
      throw new Error('sync-throw');
    });
    const pOk = queue.enqueue('b', async () => {
      runs.push('b');
    });

    await expect(pFail).rejects.toThrow('sync-throw');
    await pOk;
    expect(runs).toEqual(['b']);
    expect(queue.isIdle).toBe(true);
  });

  it('multiple rejecting tasks do not halt the queue and later tasks still run', async () => {
    const queue = new AsyncQueue();
    const runs: string[] = [];

    const p1 = queue.enqueue('a', async () => { throw new Error('a-fail'); });
    const p2 = queue.enqueue('b', () => { throw new Error('b-sync-fail'); });
    const p3 = queue.enqueue('c', async () => { runs.push('c'); });

    await expect(p1).rejects.toThrow('a-fail');
    await expect(p2).rejects.toThrow('b-sync-fail');
    await p3;

    expect(runs).toEqual(['c']);
    expect(queue.isIdle).toBe(true);
  });

  // ── clear() semantics ────────────────────────────────────────────

  it('clear() resolves all discarded promises and leaves the queue reusable', async () => {
    const queue = new AsyncQueue();

    // Block the queue while we stuff 3 pending entries behind it.
    const gate = defer();
    const blocker = queue.enqueue('blocker', async () => { await gate.promise; });
    await tick(2);

    const ran = { a: false, b: false, c: false };
    const pA = queue.enqueue('a', async () => { ran.a = true; });
    const pB = queue.enqueue('b', async () => { ran.b = true; });
    const pC = queue.enqueue('c', async () => { ran.c = true; });

    queue.clear();

    gate.resolve();
    await blocker;

    await expect(pA).resolves.toBeUndefined();
    await expect(pB).resolves.toBeUndefined();
    await expect(pC).resolves.toBeUndefined();
    expect(ran).toEqual({ a: false, b: false, c: false });
    expect(queue.isIdle).toBe(true);

    // After clear+drain the queue is reusable.
    let ranAfter = false;
    await queue.enqueue('x', async () => { ranAfter = true; });
    expect(ranAfter).toBe(true);
  });

  it('clear() on an empty queue is a safe no-op', () => {
    const queue = new AsyncQueue();
    expect(() => queue.clear()).not.toThrow();
    expect(queue.isIdle).toBe(true);
  });

  // ── Debounced simulation (fake timers) ───────────────────────────

  describe('debounced coalescing (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('3 rapid enqueues within a 200ms debounce window collapse to the last value', async () => {
      const queue = new AsyncQueue();
      const runs: string[] = [];
      let latestValue: string | null = null;
      let timer: NodeJS.Timeout | null = null;

      // Mini debouncer that mimics StateWriter.saveDebounced pattern:
      // each call updates the latest value; only when the 200ms timer
      // fires do we enqueue a single task that reads the latest value.
      function saveDebounced(value: string): void {
        latestValue = value;
        if (timer !== null) return;
        timer = setTimeout(() => {
          timer = null;
          const snapshot = latestValue;
          latestValue = null;
          if (snapshot === null) return;
          void queue.enqueue('debounced', async () => {
            runs.push(snapshot);
          });
        }, 200);
      }

      saveDebounced('v1');
      vi.advanceTimersByTime(50);
      saveDebounced('v2');
      vi.advanceTimersByTime(50);
      saveDebounced('v3');
      vi.advanceTimersByTime(50);

      // Not yet 200ms since the first call fired — no run.
      expect(runs).toEqual([]);

      // Trip the debounce timer.
      vi.advanceTimersByTime(200);
      // Let microtasks resolve the enqueued task.
      await vi.runAllTimersAsync();
      await queue.flush();

      expect(runs).toEqual(['v3']);
    });

    it('flush() forces pending queued work to complete before the debounce fires', async () => {
      // If the 200ms timer has already fired and enqueued a task, flush()
      // waits for it. If it has not fired, flush() has nothing to wait
      // for (the work is still in userland). This test covers the
      // post-timer-fire case — the most common StateWriter exit path.
      const queue = new AsyncQueue();
      const runs: string[] = [];

      setTimeout(() => {
        void queue.enqueue('k', async () => { runs.push('fired'); });
      }, 200);

      // Trip the timer.
      vi.advanceTimersByTime(200);
      // Now there is a microtask pending that will enqueue — drain it.
      await vi.runAllTimersAsync();

      // flush() must wait for the enqueued task to finish.
      await queue.flush();
      expect(runs).toEqual(['fired']);
      expect(queue.isIdle).toBe(true);
    });
  });

  // ── Concurrency stress ───────────────────────────────────────────

  it('100 concurrent enqueues on distinct keys all resolve in FIFO order', async () => {
    const queue = new AsyncQueue();
    const order: number[] = [];
    const N = 100;

    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(queue.enqueue(`k${i}`, async () => {
        // small async hop so the test actually exercises the pump
        await Promise.resolve();
        order.push(i);
      }));
    }

    await Promise.all(promises);
    expect(order.length).toBe(N);
    // Strict FIFO: order must be 0..N-1.
    for (let i = 0; i < N; i++) expect(order[i]).toBe(i);
    expect(queue.isIdle).toBe(true);
  });

  it('100 concurrent enqueues on the SAME key collapse to a single run', async () => {
    const queue = new AsyncQueue();
    let runCount = 0;
    let lastValue = -1;

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(queue.enqueue('k', async () => {
        runCount++;
        lastValue = i;
      }));
    }

    await Promise.all(promises);
    // All but the last coalesced away; exactly one run observed.
    expect(runCount).toBe(1);
    expect(lastValue).toBe(99);
    expect(queue.isIdle).toBe(true);
  });

  it('clear() in the middle of a batch does not prevent later enqueues from working', async () => {
    const queue = new AsyncQueue();
    const runs: string[] = [];

    // Block the queue.
    const gate = defer();
    const blocker = queue.enqueue('blocker', async () => { await gate.promise; });
    await tick(2);

    // First batch — will be cleared.
    const cleared1 = queue.enqueue('a', async () => { runs.push('a'); });
    const cleared2 = queue.enqueue('b', async () => { runs.push('b'); });

    queue.clear();

    // Second batch — after clear, must still queue and run normally.
    const kept1 = queue.enqueue('c', async () => { runs.push('c'); });
    const kept2 = queue.enqueue('d', async () => { runs.push('d'); });

    gate.resolve();
    await blocker;
    await Promise.all([cleared1, cleared2, kept1, kept2]);

    // Cleared entries never ran; new ones did, in FIFO order.
    expect(runs).toEqual(['c', 'd']);
    expect(queue.isIdle).toBe(true);
  });

  // ── Resource cleanliness ─────────────────────────────────────────

  it('clear() leaves the queue fully idle (indirect proxy for empty internal map)', () => {
    const queue = new AsyncQueue();

    // Enqueue several; clear before the pump runs.
    queue.enqueue('a', async () => {});
    queue.enqueue('b', async () => {});
    queue.enqueue('c', async () => {});

    expect(queue.isIdle).toBe(false);
    queue.clear();
    expect(queue.isIdle).toBe(true);
  });
});
