// Unit tests for the orchestrator model override in the deck IPC handler:
// the model rides along on deck:send, the manager's adapter is created with
// it, a change swaps the brain BETWEEN turns only, and the value is sanitized
// before it can reach the SDK subprocess command line.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
  app: { once: vi.fn(), removeListener: vi.fn() },
}));

// No persisted session in these tests — resume is P3a's concern, not model's.
vi.mock('../../../deck/commanderSessionStore', () => ({
  loadCommanderSession: vi.fn(() => null),
  saveCommanderSession: vi.fn(async () => undefined),
}));

import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from '../../../deck/BrainAdapter';

/** Fake adapter: replies with one turn-end per send; records its model. */
class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  started: BrainStartOptions | null = null;
  disposed = false;
  constructor(public readonly model: string | undefined) {}
  start(opts: BrainStartOptions): void {
    this.started = opts;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *send(_text: string): AsyncIterable<BrainEvent> {
    yield { type: 'turn-end', sessionId: 'sess-1' } as BrainEvent;
  }
  interrupt(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

let adapters: FakeAdapter[];
let cleanup: (() => void) | null = null;

function register(): void {
  cleanup = registerDeckHandler(() => null, {
    createAdapter: (opts?: { model?: string }) => {
      const a = new FakeAdapter(opts?.model);
      adapters.push(a);
      return a;
    },
  });
}

const send = (payload: Record<string, unknown>) =>
  captured.get(IPC.DECK_SEND)!({}, payload) as Promise<{ ok: boolean; code?: string }>;

beforeEach(() => {
  captured.clear();
  adapters = [];
  cleanup?.();
  register();
});

describe('deck:send — orchestrator model override', () => {
  it('creates the adapter with the requested model and reuses it while unchanged', async () => {
    await send({ text: 'hi', model: 'opus' });
    await send({ text: 'again', model: 'opus' });
    expect(adapters).toHaveLength(1);
    expect(adapters[0].model).toBe('opus');
  });

  it('no model → adapter created with undefined model (SDK default)', async () => {
    await send({ text: 'hi' });
    expect(adapters).toHaveLength(1);
    expect(adapters[0].model).toBeUndefined();
  });

  it('model change between turns disposes the old brain and builds a new one', async () => {
    await send({ text: 'hi', model: 'opus' });
    await send({ text: 'switch', model: 'sonnet' });
    expect(adapters).toHaveLength(2);
    expect(adapters[0].disposed).toBe(true);
    expect(adapters[1].model).toBe('sonnet');
  });

  it('switching back to default is also a swap', async () => {
    await send({ text: 'hi', model: 'opus' });
    await send({ text: 'back', model: '' });
    expect(adapters).toHaveLength(2);
    expect(adapters[1].model).toBeUndefined();
  });

  it('never swaps mid-turn: a model change while busy keeps the running brain', async () => {
    // An adapter whose turn we control, so the manager stays busy.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    class SlowAdapter extends FakeAdapter {
      async *send(): AsyncIterable<BrainEvent> {
        await gate;
        yield { type: 'turn-end', sessionId: 'sess-slow' } as BrainEvent;
      }
    }
    captured.clear();
    cleanup?.();
    adapters = [];
    cleanup = registerDeckHandler(() => null, {
      createAdapter: (opts?: { model?: string }) => {
        const a = adapters.length === 0 ? new SlowAdapter(opts?.model) : new FakeAdapter(opts?.model);
        adapters.push(a);
        return a;
      },
    });

    const first = send({ text: 'long turn', model: 'opus' });
    // Racing send with a DIFFERENT model while busy: must NOT dispose the
    // running brain — it gets the normal busy reject.
    const second = await send({ text: 'switch', model: 'sonnet' });
    expect(second).toEqual({ ok: false, code: 'busy' });
    expect(adapters).toHaveLength(1);
    expect(adapters[0].disposed).toBe(false);
    release();
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('sanitizes a hostile model string to the default (never reaches the CLI)', async () => {
    await send({ text: 'hi', model: 'opus; rm -rf /' });
    expect(adapters).toHaveLength(1);
    expect(adapters[0].model).toBeUndefined();
  });
});
