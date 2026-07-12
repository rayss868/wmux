// Unit tests for commanderMemory (M1a — L0 read-only durable memory). All
// filesystem cases run against a real tmp dir; no electron, no SDK.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadGlobalMemory, DEFAULT_MEMORY_BUDGET_CHARS } from '../commanderMemory';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mem-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadGlobalMemory', () => {
  it('returns empty string for a missing directory', () => {
    expect(loadGlobalMemory({ dir: path.join(dir, 'nope') })).toBe('');
  });

  it('returns empty string for an empty directory', () => {
    expect(loadGlobalMemory({ dir })).toBe('');
  });

  it('joins *.md files in filename order under a background-context header', () => {
    fs.writeFileSync(path.join(dir, '20-second.md'), 'fact B');
    fs.writeFileSync(path.join(dir, '10-first.md'), 'fact A');
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'not markdown');
    const out = loadGlobalMemory({ dir });
    expect(out).toContain('Orchestrator memory (background context)');
    expect(out).toContain('NOT');
    expect(out.indexOf('fact A')).toBeGreaterThan(-1);
    expect(out.indexOf('fact A')).toBeLessThan(out.indexOf('fact B'));
    expect(out).toContain('### 10-first.md');
    expect(out).not.toContain('not markdown');
  });

  it('skips empty and unreadable entries but loads the rest', () => {
    fs.writeFileSync(path.join(dir, '10-empty.md'), '   \n');
    fs.mkdirSync(path.join(dir, '20-imposter.md')); // dir named *.md → read throws
    fs.writeFileSync(path.join(dir, '30-good.md'), 'still loaded');
    const out = loadGlobalMemory({ dir });
    expect(out).toContain('still loaded');
    expect(out).not.toContain('10-empty');
  });

  it('announces budget truncation instead of silently dropping files', () => {
    fs.writeFileSync(path.join(dir, '10-a.md'), 'x'.repeat(300));
    fs.writeFileSync(path.join(dir, '20-b.md'), 'y'.repeat(300));
    fs.writeFileSync(path.join(dir, '30-c.md'), 'z'.repeat(300));
    const out = loadGlobalMemory({ dir, budgetChars: 700 });
    expect(out).toContain('x'.repeat(300));
    expect(out).toContain('y'.repeat(300));
    expect(out).not.toContain('z'.repeat(300));
    expect(out).toContain('[memory truncated: showing 2 of 3 files within budget]');
  });

  it('hard-slices a single over-budget file rather than injecting nothing', () => {
    fs.writeFileSync(path.join(dir, '10-huge.md'), 'h'.repeat(5_000));
    const out = loadGlobalMemory({ dir, budgetChars: 1_000 });
    expect(out).toContain('hhhh');
    expect(out.length).toBeLessThan(2_000);
    expect(out).toContain('[memory truncated: showing 1 of 1 files within budget]');
  });

  it('default budget is sane (~4k tokens)', () => {
    expect(DEFAULT_MEMORY_BUDGET_CHARS).toBeGreaterThanOrEqual(8_000);
    expect(DEFAULT_MEMORY_BUDGET_CHARS).toBeLessThanOrEqual(64_000);
  });
});
