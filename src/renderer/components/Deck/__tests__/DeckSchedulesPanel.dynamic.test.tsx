// @vitest-environment jsdom
//
// Render tests for the P3d schedules panel — fake api injected, no store/IPC.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeckSchedulesPanel, type DeckSchedulesApi } from '../DeckSchedulesPanel';
import type { DeckSchedule } from '../../../../main/deck/deckScheduleStore';

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

const schedule = (over: Partial<DeckSchedule> = {}): DeckSchedule => ({
  id: 's-1',
  prompt: 'check the PRs',
  nextRunAt: Date.UTC(2026, 6, 12, 9, 0),
  enabled: true,
  createdAt: 0,
  ...over,
});

function fakeApi(schedules: DeckSchedule[] = []): DeckSchedulesApi & {
  created: unknown[];
  updated: unknown[];
  removed: string[];
} {
  const state = { schedules: [...schedules] };
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const removed: string[] = [];
  return {
    created,
    updated,
    removed,
    list: async () => ({ schedules: state.schedules }),
    create: async (args) => {
      created.push(args);
      const s = schedule({ id: `s-${created.length + 1}`, prompt: args.prompt, nextRunAt: args.nextRunAt });
      state.schedules.push(s);
      return { ok: true, schedule: s };
    },
    update: async (args) => {
      updated.push(args);
      return { ok: true };
    },
    remove: async (id) => {
      removed.push(id);
      state.schedules = state.schedules.filter((s) => s.id !== id);
      return { ok: true };
    },
  };
}

async function mount(api: DeckSchedulesApi): Promise<void> {
  await act(async () => {
    root.render(createElement(DeckSchedulesPanel, { api }));
  });
}

async function open(): Promise<void> {
  const toggle = container.querySelector('[data-deck-schedules-toggle]') as HTMLButtonElement;
  await act(async () => { toggle.click(); });
}

describe('DeckSchedulesPanel', () => {
  it('renders nothing without an api (preload absent)', async () => {
    await act(async () => { root.render(createElement(DeckSchedulesPanel, {})); });
    expect(container.querySelector('[data-deck-schedules-toggle]')).toBeNull();
  });

  it('toggle opens the panel and lists schedules', async () => {
    await mount(fakeApi([schedule()]));
    expect(container.querySelector('[data-deck-schedules-panel]')).toBeNull();
    await open();
    const rows = container.querySelectorAll('[data-deck-schedule-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('check the PRs');
  });

  it('shows the empty state when there are no schedules', async () => {
    await mount(fakeApi());
    await open();
    expect(container.querySelector('[data-deck-schedules-empty]')).not.toBeNull();
  });

  it('creates a schedule from the form', async () => {
    const api = fakeApi();
    await mount(api);
    await open();
    const promptInput = container.querySelector('[data-deck-schedule-prompt]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(promptInput, 'nightly check');
      promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const create = container.querySelector('[data-deck-schedule-create]') as HTMLButtonElement;
    await act(async () => { create.click(); });
    expect(api.created).toHaveLength(1);
    expect((api.created[0] as { prompt: string }).prompt).toBe('nightly check');
    expect(container.querySelectorAll('[data-deck-schedule-row]')).toHaveLength(1);
  });

  it('rejects an empty prompt with an inline error, no api call', async () => {
    const api = fakeApi();
    await mount(api);
    await open();
    const create = container.querySelector('[data-deck-schedule-create]') as HTMLButtonElement;
    await act(async () => { create.click(); });
    expect(api.created).toHaveLength(0);
    expect(container.querySelector('[data-deck-schedule-error]')).not.toBeNull();
  });

  it('pause and delete round-trip through the api', async () => {
    const api = fakeApi([schedule()]);
    await mount(api);
    await open();
    const pause = container.querySelector('[data-deck-schedule-toggle-enabled]') as HTMLButtonElement;
    await act(async () => { pause.click(); });
    expect(api.updated).toEqual([{ id: 's-1', enabled: false }]);
    const del = container.querySelector('[data-deck-schedule-delete]') as HTMLButtonElement;
    await act(async () => { del.click(); });
    expect(api.removed).toEqual(['s-1']);
    expect(container.querySelectorAll('[data-deck-schedule-row]')).toHaveLength(0);
  });
});
