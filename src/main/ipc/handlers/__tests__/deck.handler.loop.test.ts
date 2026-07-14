// Unit tests for the one-click loop surface (loop engineering v1):
//   - START = ONE action writing loop-state + autonomy caps + cadence schedule
//   - STOP/PAUSE = the fail-closed OFF contract (caps → DEFAULT, schedule
//     deleted/disabled) — the "authority with no objective" residue guard
//   - the loop-state block prepends on the brain wire for human + scheduled
//     turns (event-woken turns route through the same runTurnForWorkspace)
//   - Full-auto is unreachable from this surface (tier coerces to report)
// Stores are mocked in-memory: the handler's CONTRACT with them is under test;
// the stores' file behavior is covered by their own suites.

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

vi.mock('../../../deck/commanderSessionStore', () => ({
  loadCommanderSession: vi.fn(() => null),
  saveCommanderSession: vi.fn(async () => undefined),
}));

// In-memory loop-state store. Mirrors the real signatures the handler uses.
interface FakeLoop {
  objective: string;
  tasks: { id: string; text: string; passes: boolean }[];
  progressLog: { ts: number; note: string }[];
  status: string;
  tier: 'report' | 'continue';
  iterations: number;
  scheduleId?: string;
  updatedAt: number;
}
const loops = new Map<string, FakeLoop>();
vi.mock('../../../deck/deckLoopStateStore', () => ({
  LOOP_STATE_LIMITS: {
    MIN_ITERATIONS: 1,
    MAX_ITERATIONS: 100,
    DEFAULT_ITERATIONS: 25,
  },
  loadWorkspaceLoopState: vi.fn((ws: string) => loops.get(ws) ?? null),
  renderLoopStateBlock: vi.fn((s: FakeLoop) => `[loop] objective: ${s.objective}`),
  startLoop: vi.fn(async (ws: string, args: { objective: string; taskTexts?: string[]; tier?: 'report' | 'continue'; scheduleId?: string; iterations?: number }) => {
    if (!args.objective.trim()) return null;
    const loop: FakeLoop = {
      objective: args.objective,
      tasks: (args.taskTexts ?? []).map((text, i) => ({ id: `t${i}`, text, passes: false })),
      progressLog: [],
      status: 'running',
      tier: args.tier === 'continue' ? 'continue' : 'report',
      iterations: typeof args.iterations === 'number' ? args.iterations : 25,
      ...(args.scheduleId ? { scheduleId: args.scheduleId } : {}),
      updatedAt: 1,
    };
    loops.set(ws, loop);
    return loop;
  }),
  clearLoop: vi.fn(async (ws: string) => {
    loops.delete(ws);
  }),
  setLoopStatus: vi.fn(async (ws: string, status: string) => {
    const l = loops.get(ws);
    if (!l) return null;
    l.status = status;
    return l;
  }),
  setLoopScheduleId: vi.fn(async () => null),
  setTaskPasses: vi.fn(async (ws: string, taskId: string, passes: boolean) => {
    const l = loops.get(ws);
    if (!l) return null;
    l.tasks = l.tasks.map((task) => (task.id === taskId ? { ...task, passes } : task));
    return l;
  }),
}));

// Autonomy store: record every cap write. Pure functions (modeToCaps /
// modeToWakePolicy / deriveMode) use the REAL implementation via importOriginal
// — only the IO reads/writes are stubbed. The workspace's resting mode is
// 'assist' (the product default), so loop-stop restores to assist caps.
const capWrites: { ws: string; patch: Record<string, unknown> }[] = [];
vi.mock('../../../deck/deckAutonomyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/deckAutonomyStore')>();
  return {
    ...actual,
    loadWorkspaceAutonomy: vi.fn(() => ({
      mode: 'assist' as const,
      summarize: true,
      continueInstruction: true,
      approvalPress: false,
    })),
    loadWorkspaceMode: vi.fn(() => 'assist' as const),
    setWorkspaceAutonomy: vi.fn(async (ws: string, patch: Record<string, unknown>) => {
      capWrites.push({ ws, patch });
      return patch;
    }),
    setWorkspaceMode: vi.fn(async (ws: string, mode: string) => {
      capWrites.push({ ws, patch: { mode } });
      return { mode, ...actual.modeToCaps(mode as import('../../../deck/deckAutonomyStore').AgentMode) };
    }),
  };
});

// Schedule store: in-memory array; scheduler stays inert (nothing due).
interface FakeSchedule {
  id: string;
  workspaceId?: string;
  prompt: string;
  nextRunAt: number;
  intervalMinutes?: number;
  enabled: boolean;
  createdAt: number;
}
let schedules: FakeSchedule[] = [];
let scheduleSeq = 0;
vi.mock('../../../deck/deckScheduleStore', () => ({
  loadDeckSchedules: vi.fn(() => [...schedules]),
  saveDeckSchedules: vi.fn(async (next: FakeSchedule[]) => {
    schedules = [...next];
  }),
  createSchedule: vi.fn((args: { workspaceId: string; prompt: string; nextRunAt: number; intervalMinutes?: number }) => {
    if (!args.prompt.trim() || !args.workspaceId) return null;
    const s: FakeSchedule = {
      id: `sched-${++scheduleSeq}`,
      workspaceId: args.workspaceId,
      prompt: args.prompt,
      nextRunAt: args.nextRunAt,
      ...(args.intervalMinutes ? { intervalMinutes: args.intervalMinutes } : {}),
      enabled: true,
      createdAt: 0,
    };
    return s;
  }),
  dueSchedules: vi.fn(() => []),
  advanceAfterRun: vi.fn((s: FakeSchedule) => s),
  DECK_SCHEDULE_LIMITS: { MAX_SCHEDULES: 50, MAX_PROMPT_CHARS: 4000 },
}));

import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import { eventBus } from '../../../events/EventBus';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from '../../../deck/BrainAdapter';

/** Fake adapter recording the exact text each turn was sent with. */
class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  sentTexts: string[] = [];
  constructor(public readonly workspaceId: string) {}
  start(opts: BrainStartOptions): void {
    void opts; // no-op fake
  }
  async *send(text: string): AsyncIterable<BrainEvent> {
    this.sentTexts.push(text);
    yield { type: 'turn-end', sessionId: 'sess-1' } as BrainEvent;
  }
  interrupt(): void {
    /* no-op fake */
  }
  dispose(): void {
    /* no-op fake */
  }
}

let adapters: FakeAdapter[];
let cleanup: (() => void) | null = null;

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: () => undefined },
} as unknown as import('electron').BrowserWindow;

const invoke = (channel: string, payload: Record<string, unknown>) =>
  captured.get(channel)!({}, payload) as Promise<Record<string, unknown>>;

beforeEach(() => {
  captured.clear();
  loops.clear();
  capWrites.length = 0;
  schedules = [];
  scheduleSeq = 0;
  adapters = [];
  cleanup?.();
  cleanup = registerDeckHandler(() => fakeWindow, {
    createAdapter: (opts) => {
      const a = new FakeAdapter(opts.workspaceId);
      adapters.push(a);
      return a;
    },
  });
});

describe('deck:loop:start — the one click', () => {
  it('writes loop + Continue caps + cadence schedule in one action', async () => {
    const res = await invoke(IPC.DECK_LOOP_START, {
      workspaceId: 'ws-1',
      objective: 'keep CI green',
      taskTexts: ['tests pass'],
      tier: 'continue',
      intervalMinutes: 30,
    });
    expect(res.ok).toBe(true);
    expect(loops.get('ws-1')).toMatchObject({ objective: 'keep CI green', tier: 'continue' });
    // Caps applied per tier.
    expect(capWrites).toContainEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: true, approvalPress: false },
    });
    // Cadence schedule created and linked.
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ workspaceId: 'ws-1', intervalMinutes: 30, enabled: true });
    expect(loops.get('ws-1')!.scheduleId).toBe(schedules[0].id);
  });

  it('report tier keeps continueInstruction off', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', tier: 'report' });
    expect(capWrites).toContainEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: false, approvalPress: false },
    });
  });

  it('CRITICAL: Full-auto is unreachable — any non-continue tier coerces to report', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', tier: 'full-auto' });
    expect(loops.get('ws-1')!.tier).toBe('report');
    // approvalPress is NEVER set true by this surface.
    expect(capWrites.every((w) => w.patch.approvalPress === false)).toBe(true);
  });

  it('rejects an out-of-range cadence instead of clamping silently', async () => {
    const low = await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', intervalMinutes: 1 });
    expect(low).toMatchObject({ ok: false, code: 'invalid_interval' });
    expect(loops.has('ws-1')).toBe(false);
    expect(schedules).toHaveLength(0);
  });

  it('passes the iteration budget through; out-of-range is rejected', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', iterations: 40 });
    expect(loops.get('ws-1')!.iterations).toBe(40);
    const bad = await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-2', objective: 'o', iterations: 9999 });
    expect(bad).toMatchObject({ ok: false, code: 'invalid_iterations' });
    expect(loops.has('ws-2')).toBe(false);
  });

  it('replacing a loop deletes the prior cadence schedule (no orphans)', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'a', intervalMinutes: 30 });
    const firstId = schedules[0].id;
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'b', intervalMinutes: 60 });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].id).not.toBe(firstId);
  });
});

describe('deck:loop:stop / pause / resume — the OFF contract', () => {
  it('CRITICAL: stop clears the loop, deletes the schedule, and resets caps to DEFAULT', async () => {
    await invoke(IPC.DECK_LOOP_START, {
      workspaceId: 'ws-1',
      objective: 'o',
      tier: 'continue',
      intervalMinutes: 30,
    });
    capWrites.length = 0;
    const res = await invoke(IPC.DECK_LOOP_STOP, { workspaceId: 'ws-1' });
    expect(res.ok).toBe(true);
    expect(loops.has('ws-1')).toBe(false);
    expect(schedules).toHaveLength(0); // pending cadence never fires post-stop
    // Loop-stop restores caps to the workspace's MODE (assist), not a hardcoded
    // fail-closed floor — the mode is the resting autonomy the user chose.
    expect(capWrites).toEqual([
      { ws: 'ws-1', patch: { summarize: true, continueInstruction: true, approvalPress: false } },
    ]);
  });

  it('pause drops caps + disables the schedule; resume restores tier + re-enables', async () => {
    await invoke(IPC.DECK_LOOP_START, {
      workspaceId: 'ws-1',
      objective: 'o',
      tier: 'continue',
      intervalMinutes: 30,
    });
    capWrites.length = 0;

    await invoke(IPC.DECK_LOOP_PAUSE, { workspaceId: 'ws-1' });
    expect(loops.get('ws-1')!.status).toBe('paused');
    expect(schedules[0].enabled).toBe(false);
    // pause restores to mode (assist) caps — the loop-state 'paused' + removed
    // override is what stops the driving, not a cap floor.
    expect(capWrites.pop()).toEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: true, approvalPress: false },
    });

    await invoke(IPC.DECK_LOOP_RESUME, { workspaceId: 'ws-1' });
    expect(loops.get('ws-1')!.status).toBe('running');
    expect(schedules[0].enabled).toBe(true);
    expect(capWrites.pop()).toEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: true, approvalPress: false },
    });
  });

  it('the human ticks a done-when item via deck:loop:task (the only passes writer)', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', taskTexts: ['a', 'b'] });
    const res = await invoke(IPC.DECK_LOOP_TASK, { workspaceId: 'ws-1', taskId: 't0', passes: true });
    expect(res.ok).toBe(true);
    expect(loops.get('ws-1')!.tasks[0].passes).toBe(true);
    // Missing taskId / workspace → safe reject.
    expect((await invoke(IPC.DECK_LOOP_TASK, { workspaceId: 'ws-1' })).ok).toBe(false);
    expect((await invoke(IPC.DECK_LOOP_TASK, { taskId: 't0', passes: true })).ok).toBe(false);
  });

  it('get returns the loop AND the live wake budget (ambient default without a loop)', async () => {
    const bare = await invoke(IPC.DECK_LOOP_GET, { workspaceId: 'ws-1' });
    expect(bare.loop).toBeNull();
    // No loop → the coalescer's ambient budget (5/5, nothing consumed).
    expect(bare.wakeBudget).toEqual({ remaining: 5, total: 5 });
    // A running loop's iterations take over as the total.
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', iterations: 12 });
    const withLoop = await invoke(IPC.DECK_LOOP_GET, { workspaceId: 'ws-1' });
    expect(withLoop.wakeBudget).toEqual({ remaining: 12, total: 12 });
  });

  it('stop/pause on a loopless workspace is a safe no-op', async () => {
    expect((await invoke(IPC.DECK_LOOP_GET, { workspaceId: 'ws-1' })).loop).toBeNull();
    expect((await invoke(IPC.DECK_LOOP_PAUSE, { workspaceId: 'ws-1' })).ok).toBe(false);
    const stop = await invoke(IPC.DECK_LOOP_STOP, { workspaceId: 'ws-1' });
    expect(stop.ok).toBe(true); // idempotent
  });
});

describe('deck:send × auto-wake race — the loop-stall guard (dogfood finding 2026-07-12)', () => {
  it('a human send rejected busy does NOT consume buffered pane events; the wake still fires', async () => {
    // An adapter whose FIRST turn stays open until released — the brain is busy.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    class SlowFirstAdapter extends FakeAdapter {
      async *send(text: string): AsyncIterable<BrainEvent> {
        this.sentTexts.push(text);
        if (this.sentTexts.length === 1) await gate;
        yield { type: 'turn-end', sessionId: 'sess-1' } as BrainEvent;
      }
    }
    captured.clear();
    cleanup?.();
    adapters = [];
    cleanup = registerDeckHandler(() => fakeWindow, {
      createAdapter: (opts) => {
        const a = new SlowFirstAdapter(opts.workspaceId);
        adapters.push(a);
        return a;
      },
    });

    // Turn 1: an accepted human send holds the brain busy.
    const first = invoke(IPC.DECK_SEND, { workspaceId: 'ws-1', text: 'long turn' });
    await Promise.resolve(); // let it enter busy

    // A worker pane stops while the brain is busy — the coalescer buffers it.
    // awaiting_input (not a plain stop) so the default assist mode's value
    // filter wakes on it — this test exercises the busy-reject plumbing, not
    // the wake filter.
    eventBus.emit({
      type: 'agent.lifecycle',
      workspaceId: 'ws-1',
      ptyId: 'p1',
      kind: 'agent.awaiting_input',
      source: 'hook',
      agent: 'claude',
      decision: 'emit',
    });

    // Racing human send → busy reject. Pre-fix this called notifyHumanSend
    // unconditionally, subsuming the buffered stop on a turn that never ran —
    // the loop chain silently stalled.
    const rejected = await invoke(IPC.DECK_SEND, { workspaceId: 'ws-1', text: 'racing' });
    expect(rejected).toMatchObject({ ok: false, code: 'busy' });

    // Turn 1 ends → deferred onIdle → coalescer flush → the auto-wake fires
    // with the buffered event intact.
    release();
    await first;
    await new Promise((r) => setTimeout(r, 30)); // deferIdle tick + flush
    const texts = adapters[0].sentTexts;
    expect(
      texts.some((t) => t.includes('[pane-events]') && t.includes('p1')),
    ).toBe(true);
  });
});

describe('loop-state block on the brain wire', () => {
  it('human DECK_SEND carries the loop block when a loop exists — and not otherwise', async () => {
    await invoke(IPC.DECK_SEND, { workspaceId: 'ws-1', text: 'no loop yet' });
    expect(adapters[0].sentTexts[0]).toBe('no loop yet');

    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'keep green' });
    // START now fires a fire-and-forget kickoff turn — let it settle so the
    // manager is idle before the human send (else the send is busy-rejected).
    await new Promise((r) => setTimeout(r, 20));
    await invoke(IPC.DECK_SEND, { workspaceId: 'ws-1', text: 'progress?' });
    const last = adapters[0].sentTexts.at(-1)!;
    expect(last.startsWith('[loop] objective: keep green')).toBe(true);
    expect(last.endsWith('progress?')).toBe(true);
  });
});

describe('deck:loop kickoff — the loop actually starts working (owner dogfood 2026-07-14)', () => {
  it('START fires an immediate orchestrator turn carrying the loop block', async () => {
    const res = await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'keep CI green' });
    expect(res.ok).toBe(true);
    // The kick is fire-and-forget (START must return its verdict at once — the
    // modal awaits it), so let the streamed turn land on the fake adapter.
    await new Promise((r) => setTimeout(r, 20));
    const texts = adapters[0].sentTexts;
    expect(texts.length).toBeGreaterThanOrEqual(1);
    const kick = texts[texts.length - 1];
    // The loop-state block (mocked renderLoopStateBlock) rides in front, and the
    // prompt tells the brain to take the first iteration now.
    expect(kick).toContain('[loop] objective: keep CI green');
    expect(kick.toLowerCase()).toContain('first iteration');
  });

  it('RESUME re-engages the orchestrator too (a paused loop should not sit idle)', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o' });
    await new Promise((r) => setTimeout(r, 20));
    const afterStart = adapters[0].sentTexts.length;
    await invoke(IPC.DECK_LOOP_PAUSE, { workspaceId: 'ws-1' });
    await invoke(IPC.DECK_LOOP_RESUME, { workspaceId: 'ws-1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(adapters[0].sentTexts.length).toBeGreaterThan(afterStart);
  });

  it('a rejected START (bad interval) fires no kickoff turn', async () => {
    const res = await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', intervalMinutes: 1 });
    expect(res).toMatchObject({ ok: false, code: 'invalid_interval' });
    await new Promise((r) => setTimeout(r, 20));
    // No loop was created ⇒ no manager, no turn.
    expect(adapters).toHaveLength(0);
  });
});
