// Unit tests for commanderMemory (M1a — L0 read-only durable memory). All
// filesystem cases run against a real tmp dir; no electron, no SDK.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadGlobalMemory,
  loadCommanderMemory,
  DEFAULT_MEMORY_BUDGET_CHARS,
} from '../commanderMemory';

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

// ─── M1c: per-workspace memory partitions ──────────────────────────────────
//
// loadCommanderMemory's `dir` is the memory ROOT (contains `_global/` and the
// per-workspace partitions), unlike loadGlobalMemory's `dir` (the `_global`
// dir itself). These tests build the root layout under the tmp dir.

/** Seed `<root>/_global/<name>.md` with content. */
function seedGlobal(root: string, name: string, content: string): void {
  const g = path.join(root, '_global');
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, name), content);
}

/** Seed `<root>/<workspaceId>/<name>.md` with content. */
function seedWorkspace(root: string, workspaceId: string, name: string, content: string): void {
  const w = path.join(root, workspaceId);
  fs.mkdirSync(w, { recursive: true });
  fs.writeFileSync(path.join(w, name), content);
}

describe('loadCommanderMemory', () => {
  it('is global-only when no workspaceId is given', () => {
    seedGlobal(dir, '10-global.md', 'shared fact');
    const out = loadCommanderMemory({ dir });
    expect(out).toContain('shared fact');
    expect(out).not.toContain("This workspace's memory");
  });

  it('is global-only when the workspace partition is missing', () => {
    seedGlobal(dir, '10-global.md', 'shared fact');
    const out = loadCommanderMemory({ dir, workspaceId: 'ws-A' });
    expect(out).toContain('shared fact');
    expect(out).not.toContain("This workspace's memory");
  });

  it('appends the workspace partition after global under a labelled separator', () => {
    seedGlobal(dir, '10-global.md', 'shared fact');
    seedWorkspace(dir, 'ws-A', '10-proj.md', 'project fact A');
    const out = loadCommanderMemory({ dir, workspaceId: 'ws-A' });
    expect(out).toContain('shared fact');
    expect(out).toContain('project fact A');
    // Global comes first, then the label, then the workspace fact.
    expect(out.indexOf('shared fact')).toBeLessThan(out.indexOf("This workspace's memory"));
    expect(out.indexOf("This workspace's memory")).toBeLessThan(out.indexOf('project fact A'));
    expect(out).toContain('### 10-proj.md');
  });

  it('isolates partitions — ws-A never sees ws-B files', () => {
    seedGlobal(dir, '10-global.md', 'shared fact');
    seedWorkspace(dir, 'ws-A', '10-a.md', 'only in A');
    seedWorkspace(dir, 'ws-B', '10-b.md', 'only in B');
    const out = loadCommanderMemory({ dir, workspaceId: 'ws-A' });
    expect(out).toContain('only in A');
    expect(out).not.toContain('only in B');
  });

  it('shares one budget across both partitions and announces the cut', () => {
    seedGlobal(dir, '10-g.md', 'g'.repeat(300));
    seedWorkspace(dir, 'ws-A', '10-w.md', 'w'.repeat(300));
    seedWorkspace(dir, 'ws-A', '20-w.md', 'z'.repeat(300));
    // Budget fits global (~308) + one workspace file (+ label) but not the
    // second workspace file — total is 3 files, 2 shown.
    const out = loadCommanderMemory({ dir, workspaceId: 'ws-A', budgetChars: 800 });
    expect(out).toContain('g'.repeat(300));
    expect(out).toContain('w'.repeat(300));
    expect(out).not.toContain('z'.repeat(300));
    expect(out).toContain('[memory truncated: showing 2 of 3 files within budget]');
  });

  it('falls back to global-only for a traversal workspaceId and reads nothing outside', () => {
    seedGlobal(dir, '10-global.md', 'shared fact');
    // A sibling dir that a `../evil` id would try to reach.
    const evil = path.join(dir, '..', `wmux-evil-${path.basename(dir)}`);
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'secret.md'), 'SECRET');
    try {
      for (const bad of ['../evil', '..', '.', 'a/b', '']) {
        const out = loadCommanderMemory({ dir, workspaceId: bad });
        expect(out).toContain('shared fact');
        expect(out).not.toContain('SECRET');
        expect(out).not.toContain("This workspace's memory");
      }
    } finally {
      fs.rmSync(evil, { recursive: true, force: true });
    }
  });

  it('returns empty when neither partition has anything', () => {
    expect(loadCommanderMemory({ dir, workspaceId: 'ws-A' })).toBe('');
  });
});
