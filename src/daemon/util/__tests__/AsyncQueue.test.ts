import { describe, it, expect } from 'vitest';
import { AsyncQueue } from '../AsyncQueue';

/** Helper — sleep for a few microtasks to let the queue drain. */
async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

describe('AsyncQueue', () => {
  it('runs FIFO across distinct keys', async () => {
    const queue = new AsyncQueue();
    const order: string[] = [];

    const p1 = queue.enqueue('a', async () => {
      await Promise.resolve();
      order.push('a');
    });
    const p2 = queue.enqueue('b', async () => {
      await Promise.resolve();
      order.push('b');
    });
    const p3 = queue.enqueue('c', async () => {
      await Promise.resolve();
      order.push('c');
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('coalesces repeated enqueues on the same key to the latest task', async () => {
    const queue = new AsyncQueue();
    const runs: string[] = [];

    // All four enqueues happen synchronously before the pump's
    // microtask fires, so they collapse onto the same pending slot
    // and only the last task runs.
    const p0 = queue.enqueue('k', async () => { runs.push('v0'); });
    const p1 = queue.enqueue('k', async () => { runs.push('v1'); });
    const p2 = queue.enqueue('k', async () => { runs.push('v2'); });
    const p3 = queue.enqueue('k', async () => { runs.push('v3'); });

    await Promise.all([p0, p1, p2, p3]);
    expect(runs).toEqual(['v3']);
  });

  it('coalesces a pending slot while a prior task runs', async () => {
    const queue = new AsyncQueue();
    const runs: string[] = [];

    // Start a running task under key 'k' and block it.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const running = queue.enqueue('k', async () => {
      await gate;
      runs.push('initial');
    });

    // Let the pump pick up the initial task so it's now `running`.
    await tick(2);

    // These land in pending as one slot that gets overwritten.
    const pA = queue.enqueue('k', async () => { runs.push('a'); });
    const pB = queue.enqueue('k', async () => { runs.push('b'); });
    const pC = queue.enqueue('k', async () => { runs.push('c'); });

    release!();
    await Promise.all([running, pA, pB, pC]);

    // initial ran to completion, then only the latest pending ('c') ran.
    expect(runs).toEqual(['initial', 'c']);
  });

  it('flush() resolves once the queue is idle', async () => {
    const queue = new AsyncQueue();
    const results: number[] = [];

    queue.enqueue('a', async () => {
      await tick(2);
      results.push(1);
    });
    queue.enqueue('b', async () => {
      await tick(2);
      results.push(2);
    });

    expect(queue.isIdle).toBe(false);
    await queue.flush();
    expect(queue.isIdle).toBe(true);
    expect(results).toEqual([1, 2]);
  });

  it('flush() on an idle queue resolves immediately', async () => {
    const queue = new AsyncQueue();
    // Just asserting no hang.
    await expect(queue.flush()).resolves.toBeUndefined();
  });

  it('flushSync() invokes registered sync fallback for each pending key', () => {
    const queue = new AsyncQueue();
    const fallbacks: string[] = [];

    queue.setSyncFallback('a', () => { fallbacks.push('a-fb'); });
    queue.setSyncFallback('b', () => { fallbacks.push('b-fb'); });

    // Note: enqueue's pump is microtask-deferred, so these sit in
    // `pending` at the time flushSync runs.
    queue.enqueue('a', async () => { /* never runs */ });
    queue.enqueue('b', async () => { /* never runs */ });

    queue.flushSync();
    expect(fallbacks).toEqual(['a-fb', 'b-fb']);
    expect(queue.isIdle).toBe(true);
  });

  it('flushSync() swallows fallback errors and continues with remaining keys', () => {
    const queue = new AsyncQueue();
    const fallbacks: string[] = [];

    queue.setSyncFallback('a', () => { throw new Error('boom'); });
    queue.setSyncFallback('b', () => { fallbacks.push('b-fb'); });

    queue.enqueue('a', async () => { /* never */ });
    queue.enqueue('b', async () => { /* never */ });

    // Should not throw
    queue.flushSync();
    expect(fallbacks).toEqual(['b-fb']);
    expect(queue.isIdle).toBe(true);
  });

  it('task exceptions reject their promise but do not halt the queue', async () => {
    const queue = new AsyncQueue();
    const runs: string[] = [];

    const pFail = queue.enqueue('a', async () => {
      throw new Error('task-a-failed');
    });
    const pOk = queue.enqueue('b', async () => {
      runs.push('b');
    });

    await expect(pFail).rejects.toThrow('task-a-failed');
    await pOk;
    expect(runs).toEqual(['b']);
    expect(queue.isIdle).toBe(true);
  });

  it('coalesced promises resolve as no-ops (do not block callers)', async () => {
    const queue = new AsyncQueue();

    // Block the queue.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const blocker = queue.enqueue('k', async () => { await gate; });

    // Second and third enqueue — second is coalesced away by third.
    const pCoalesced = queue.enqueue('k', async () => {
      throw new Error('this task should never run');
    });
    const pLatest = queue.enqueue('k', async () => {
      /* latest wins */
    });

    release!();
    await blocker;
    // The superseded promise resolves without running its task.
    await expect(pCoalesced).resolves.toBeUndefined();
    await expect(pLatest).resolves.toBeUndefined();
  });

  it('clear() resolves pending promises without executing them', async () => {
    const queue = new AsyncQueue();

    // Block the queue so subsequent enqueues stay pending until we clear.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const running = queue.enqueue('k', async () => { await gate; });

    let ran = false;
    const pending = queue.enqueue('other', async () => { ran = true; });

    queue.clear();
    release!();
    await running;

    await expect(pending).resolves.toBeUndefined();
    expect(ran).toBe(false);
  });

  it('isIdle is true on a fresh queue', () => {
    const queue = new AsyncQueue();
    expect(queue.isIdle).toBe(true);
  });
});
