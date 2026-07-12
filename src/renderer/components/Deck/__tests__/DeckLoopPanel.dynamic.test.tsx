// @vitest-environment jsdom
//
// Render tests for the one-click loop panel (loop engineering v1) — fake api
// injected, no store/IPC. Covers the v1 test matrix's ONE-CLICK rows: a single
// [Start loop] carries objective + checklist + tier + cadence in ONE call; the
// tier select CANNOT express full-auto; [stop]/[pause]/[resume] drive the OFF
// contract (main enforces the cap/schedule cleanup — here we assert the calls).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeckLoopPanel, type DeckLoopApi } from '../DeckLoopPanel';
import type { WorkspaceLoopState } from '../../../../main/deck/deckLoopStateStore';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const loopState = (over: Partial<WorkspaceLoopState> = {}): WorkspaceLoopState => ({
  objective: 'keep CI green',
  tasks: [
    { id: 't1', text: 'tests pass', passes: true },
    { id: 't2', text: 'lint clean', passes: false },
  ],
  progressLog: [],
  status: 'running',
  tier: 'continue',
  iterations: 25,
  updatedAt: 1,
  ...over,
});

function fakeApi(initial: WorkspaceLoopState | null = null): DeckLoopApi & {
  started: unknown[];
  stopped: string[];
  paused: string[];
  resumed: string[];
} {
  const state = { loop: initial };
  const started: unknown[] = [];
  const stopped: string[] = [];
  const paused: string[] = [];
  const resumed: string[] = [];
  return {
    started,
    stopped,
    paused,
    resumed,
    get: async () => ({ loop: state.loop }),
    start: async (args) => {
      started.push(args);
      state.loop = loopState({
        objective: args.objective,
        tasks: (args.taskTexts ?? []).map((text, i) => ({ id: `t${i}`, text, passes: false })),
        tier: args.tier === 'continue' ? 'continue' : 'report',
      });
      return { ok: true, loop: state.loop };
    },
    stop: async (ws) => {
      stopped.push(ws);
      state.loop = null;
      return { ok: true };
    },
    pause: async (ws) => {
      paused.push(ws);
      if (state.loop) state.loop = { ...state.loop, status: 'paused' };
      return { ok: true };
    },
    resume: async (ws) => {
      resumed.push(ws);
      if (state.loop) state.loop = { ...state.loop, status: 'running' };
      return { ok: true };
    },
  };
}

async function mount(api: DeckLoopApi, workspaceId = 'ws-1'): Promise<void> {
  await act(async () => {
    root.render(createElement(DeckLoopPanel, { api, workspaceId }));
  });
}

async function open(): Promise<void> {
  const toggle = container.querySelector('[data-deck-loop-toggle]') as HTMLButtonElement;
  await act(async () => { toggle.click(); });
}

function setValue(selector: string, value: string): void {
  const el = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  // React reads value via the native setter path; assign then dispatch.
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}

describe('DeckLoopPanel', () => {
  it('renders nothing without an api (preload absent)', async () => {
    await act(async () => { root.render(createElement(DeckLoopPanel, {})); });
    expect(container.querySelector('[data-deck-loop-toggle]')).toBeNull();
  });

  it('no loop → chip says start; open shows the one-click form', async () => {
    await mount(fakeApi());
    const toggle = container.querySelector('[data-deck-loop-toggle]')!;
    expect(toggle.textContent).toContain('Start a loop');
    await open();
    expect(container.querySelector('[data-deck-loop-objective-input]')).not.toBeNull();
    expect(container.querySelector('[data-deck-loop-tier]')).not.toBeNull();
  });

  it('CRITICAL: the tier select offers ONLY report/continue — full-auto is not expressible', async () => {
    await mount(fakeApi());
    await open();
    const tierSelect = container.querySelector('[data-deck-loop-tier]') as HTMLSelectElement;
    const values = Array.from(tierSelect.options).map((o) => o.value);
    expect(values.sort()).toEqual(['continue', 'report']);
  });

  it('one click sends objective + checklist + tier + cadence in ONE start call', async () => {
    const api = fakeApi();
    await mount(api);
    await open();
    setValue('[data-deck-loop-objective-input]', 'ship the feature');
    setValue('[data-deck-loop-donewhen]', 'tests green\n\nlint clean\n');
    setValue('[data-deck-loop-tier]', 'continue');
    setValue('[data-deck-loop-cadence]', '30');
    setValue('[data-deck-loop-iterations]', '40');
    const start = container.querySelector('[data-deck-loop-start]') as HTMLButtonElement;
    await act(async () => { start.click(); });
    expect(api.started).toEqual([
      {
        workspaceId: 'ws-1',
        objective: 'ship the feature',
        taskTexts: ['tests green', 'lint clean'], // blank lines dropped
        tier: 'continue',
        intervalMinutes: 30,
        iterations: 40,
      },
    ]);
    // The panel flips to the status card.
    expect(container.querySelector('[data-deck-loop-objective]')?.textContent).toBe('ship the feature');
  });

  it('empty objective is rejected inline, nothing sent', async () => {
    const api = fakeApi();
    await mount(api);
    await open();
    const start = container.querySelector('[data-deck-loop-start]') as HTMLButtonElement;
    await act(async () => { start.click(); });
    expect(api.started).toHaveLength(0);
    expect(container.querySelector('[data-deck-loop-error]')).not.toBeNull();
  });

  it('running loop → chip shows passing count + live dot; card lists tasks read-only', async () => {
    await mount(fakeApi(loopState()));
    const toggle = container.querySelector('[data-deck-loop-toggle]')!;
    expect(toggle.textContent).toContain('Loop 1/2');
    expect(container.querySelector('[data-deck-loop-live-dot]')).not.toBeNull();
    await open();
    const tasks = container.querySelector('[data-deck-loop-tasks]')!;
    expect(tasks.textContent).toContain('[x] tests pass');
    expect(tasks.textContent).toContain('[ ] lint clean');
    // Read-only: no checkbox inputs — the human edits by stopping/restarting,
    // the brain never writes passes (v1 posture).
    expect(tasks.querySelectorAll('input').length).toBe(0);
  });

  it('stop / pause / resume call the OFF-contract endpoints with the workspace', async () => {
    const api = fakeApi(loopState());
    await mount(api);
    await open();
    await act(async () => {
      (container.querySelector('[data-deck-loop-pause]') as HTMLButtonElement).click();
    });
    expect(api.paused).toEqual(['ws-1']);
    // Now paused → resume shows.
    await act(async () => {
      (container.querySelector('[data-deck-loop-resume]') as HTMLButtonElement).click();
    });
    expect(api.resumed).toEqual(['ws-1']);
    await act(async () => {
      (container.querySelector('[data-deck-loop-stop]') as HTMLButtonElement).click();
    });
    expect(api.stopped).toEqual(['ws-1']);
    // Loop gone → back to the start form on next open state.
    expect(container.querySelector('[data-deck-loop-objective-input]')).not.toBeNull();
  });
});
