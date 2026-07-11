// Unit tests for the P3d schedule store: round-trip persistence, sanitize-on-
// load (the file is hand-editable), due computation, and post-run advancement.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadDeckSchedules,
  saveDeckSchedules,
  createSchedule,
  dueSchedules,
  advanceAfterRun,
  getDeckSchedulesPath,
  type DeckSchedule,
} from '../deckScheduleStore';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-sched-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const mk = (over: Partial<DeckSchedule> = {}): DeckSchedule => ({
  id: 'id-1',
  prompt: 'check the PRs',
  nextRunAt: 1_000,
  enabled: true,
  createdAt: 0,
  ...over,
});

describe('deckScheduleStore', () => {
  it('round-trips schedules through the file', async () => {
    const s = createSchedule({ prompt: 'hello', nextRunAt: 123, intervalMinutes: 60 })!;
    await saveDeckSchedules([s], dir);
    const loaded = loadDeckSchedules(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ prompt: 'hello', nextRunAt: 123, intervalMinutes: 60, enabled: true });
  });

  it('missing / corrupt file loads as empty (never bricks the deck)', () => {
    expect(loadDeckSchedules(dir)).toEqual([]);
    fs.writeFileSync(getDeckSchedulesPath(dir), 'CORRUPT{', 'utf8');
    expect(loadDeckSchedules(dir)).toEqual([]);
  });

  it('sanitizes hand-edited entries on load (bad rows dropped, fields coerced)', async () => {
    await saveDeckSchedules(
      [
        mk(),
        { id: '', prompt: 'no id', nextRunAt: 1, enabled: true, createdAt: 0 },
        { id: 'x', prompt: '   ', nextRunAt: 1, enabled: true, createdAt: 0 },
        mk({ id: 'neg', intervalMinutes: -5 }),
      ] as DeckSchedule[],
      dir,
    );
    const loaded = loadDeckSchedules(dir);
    expect(loaded.map((s) => s.id)).toEqual(['id-1', 'neg']);
    expect(loaded[1].intervalMinutes).toBeUndefined();
  });

  it('createSchedule rejects an empty prompt / invalid time', () => {
    expect(createSchedule({ prompt: '  ', nextRunAt: 1 })).toBeNull();
    expect(createSchedule({ prompt: 'x', nextRunAt: NaN })).toBeNull();
  });

  it('dueSchedules = enabled AND past due only', () => {
    const list = [
      mk({ id: 'due', nextRunAt: 500 }),
      mk({ id: 'future', nextRunAt: 2_000 }),
      mk({ id: 'off', nextRunAt: 500, enabled: false }),
    ];
    expect(dueSchedules(list, 1_000).map((s) => s.id)).toEqual(['due']);
  });

  it('advanceAfterRun: repeats catch up PAST now (no storm after sleep)', () => {
    const s = mk({ nextRunAt: 1_000, intervalMinutes: 1 }); // every 60s
    // Laptop slept: now is 10 minutes later. One fire, next slot after now.
    const advanced = advanceAfterRun(s, 'ok', 601_000);
    expect(advanced.nextRunAt).toBe(661_000);
    expect(advanced.enabled).toBe(true);
    expect(advanced.lastResult).toBe('ok');
  });

  it('advanceAfterRun: one-shot flips to disabled but stays listed', () => {
    const advanced = advanceAfterRun(mk(), 'ok', 5_000);
    expect(advanced.enabled).toBe(false);
    expect(advanced.lastRunAt).toBe(5_000);
  });

  it('advanceAfterRun: busy leaves the schedule due (retry next tick)', () => {
    const advanced = advanceAfterRun(mk({ nextRunAt: 1_000 }), 'busy', 5_000);
    expect(advanced.nextRunAt).toBe(1_000);
    expect(advanced.enabled).toBe(true);
    expect(advanced.lastRunAt).toBeUndefined();
  });
});
