import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  quarantineFile,
  quarantineFileSync,
  cleanupQuarantine,
  cleanupQuarantineSync,
  type CorruptFileLog,
} from '../quarantine';
import { atomicWriteJSON, atomicReadJSON } from '../core';

let tmpDir: string;
let targetPath: string;
let corruptedDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-quarantine-test-'));
  targetPath = path.join(tmpDir, 'data.json');
  corruptedDir = path.join(tmpDir, 'corrupted');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function listCorrupted(): string[] {
  if (!fs.existsSync(corruptedDir)) return [];
  return fs.readdirSync(corruptedDir).sort();
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      if (typeof chunk === 'string') lines.push(chunk);
      else if (chunk instanceof Uint8Array) lines.push(Buffer.from(chunk).toString('utf-8'));
      return true;
    });
  return {
    lines,
    restore: () => {
      spy.mockRestore();
      // Ensure anything else in this test run still reaches the real
      // stderr after we restore.
      void original;
    },
  };
}

// ── quarantineFile ──────────────────────────────────────────────────

describe('quarantineFile (async)', () => {
  it('renames the source into corrupted/{name}.{ts}.bak', async () => {
    fs.writeFileSync(targetPath, '{"broken":true}', 'utf-8');
    const clock = () => 1_700_000_000_000;

    const result = await quarantineFile(targetPath, 'bad schema', { clock });

    expect(result).not.toBeNull();
    const expected = path.join(corruptedDir, 'data.json.1700000000000.bak');
    expect(result?.quarantined_to).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    // Original must be gone — this is a rename, not a copy.
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it('returns null when the source does not exist', async () => {
    const result = await quarantineFile(targetPath, 'missing', {
      clock: () => 1,
    });
    expect(result).toBeNull();
    expect(fs.existsSync(corruptedDir)).toBe(false);
  });

  it('overwrites an existing quarantine target at the same timestamp', async () => {
    // Seed a pre-existing file at the destination so the rename would
    // collide on Windows without the internal unlink step.
    const clock = () => 1_700_000_000_000;
    fs.mkdirSync(corruptedDir, { recursive: true });
    const target = path.join(corruptedDir, 'data.json.1700000000000.bak');
    fs.writeFileSync(target, 'stale', 'utf-8');

    fs.writeFileSync(targetPath, '{"fresh":true}', 'utf-8');
    const result = await quarantineFile(targetPath, 'collision', { clock });

    expect(result?.quarantined_to).toBe(target);
    const body = fs.readFileSync(target, 'utf-8');
    expect(body).toBe('{"fresh":true}');
  });

  it('emits a CORRUPT_FILE JSON log line to stderr', async () => {
    const cap = captureStderr();
    try {
      fs.writeFileSync(targetPath, '{"bad":true}', 'utf-8');
      await quarantineFile(targetPath, 'schema mismatch', {
        clock: () => 1_700_000_000_042,
      });
    } finally {
      cap.restore();
    }

    const jsonLine = cap.lines.find((l) => l.includes('"CORRUPT_FILE"'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!.trim()) as CorruptFileLog;
    expect(parsed.event).toBe('CORRUPT_FILE');
    expect(parsed.code).toBe('CORRUPT_FILE');
    expect(parsed.level).toBe('warn');
    expect(parsed.ts).toBe(1_700_000_000_042);
    expect(parsed.path).toBe(targetPath);
    expect(parsed.reason).toBe('schema mismatch');
    expect(parsed.quarantined_to).toMatch(/data\.json\.1700000000042\.bak$/);
  });

  it('emits sha256_prefix of exactly 16 hex chars', async () => {
    const cap = captureStderr();
    try {
      fs.writeFileSync(targetPath, '{"sha":true}', 'utf-8');
      await quarantineFile(targetPath, 'hash check', {
        clock: () => 1_700_000_000_001,
      });
    } finally {
      cap.restore();
    }

    const jsonLine = cap.lines.find((l) => l.includes('"CORRUPT_FILE"'));
    const parsed = JSON.parse(jsonLine!.trim()) as CorruptFileLog;
    expect(parsed.sha256_prefix).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('quarantineFileSync', () => {
  it('renames the source into corrupted/{name}.{ts}.bak synchronously', () => {
    fs.writeFileSync(targetPath, '{"sync":true}', 'utf-8');
    const result = quarantineFileSync(targetPath, 'sync path', {
      clock: () => 1_700_000_000_777,
    });
    expect(result?.quarantined_to).toBe(
      path.join(corruptedDir, 'data.json.1700000000777.bak'),
    );
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it('returns null when the source is missing', () => {
    const result = quarantineFileSync(targetPath, 'nope');
    expect(result).toBeNull();
  });
});

// ── cleanupQuarantine ───────────────────────────────────────────────

function seedQuarantineFiles(
  mtimes: ReadonlyArray<{ name: string; mtimeMs: number }>,
): void {
  fs.mkdirSync(corruptedDir, { recursive: true });
  for (const { name, mtimeMs } of mtimes) {
    const p = path.join(corruptedDir, name);
    fs.writeFileSync(p, 'x', 'utf-8');
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  }
}

describe('cleanupQuarantine', () => {
  it('returns {removed:0} when the directory is missing', async () => {
    const res = await cleanupQuarantine(corruptedDir);
    expect(res).toEqual({ removed: 0 });
  });

  it('removes files older than maxAgeMs', async () => {
    const now = 10_000_000_000;
    seedQuarantineFiles([
      { name: 'old.bak', mtimeMs: now - 1_000_000 }, // old
      { name: 'fresh.bak', mtimeMs: now - 10 }, // fresh
    ]);

    const res = await cleanupQuarantine(corruptedDir, {
      maxAgeMs: 100,
      maxCount: 100,
      clock: () => now,
    });
    expect(res.removed).toBe(1);
    expect(listCorrupted()).toEqual(['fresh.bak']);
  });

  it('drops oldest files first when count exceeds maxCount', async () => {
    const now = 10_000_000_000;
    seedQuarantineFiles([
      { name: 'a.bak', mtimeMs: now - 400 },
      { name: 'b.bak', mtimeMs: now - 300 },
      { name: 'c.bak', mtimeMs: now - 200 },
      { name: 'd.bak', mtimeMs: now - 100 },
    ]);

    const res = await cleanupQuarantine(corruptedDir, {
      maxAgeMs: 10 * 60 * 1000,
      maxCount: 2,
      clock: () => now,
    });
    expect(res.removed).toBe(2);
    expect(listCorrupted()).toEqual(['c.bak', 'd.bak']);
  });

  it('keeps exactly maxCount files on count-triggered eviction', async () => {
    const now = 10_000_000_000;
    const names: { name: string; mtimeMs: number }[] = [];
    for (let i = 0; i < 15; i++) {
      names.push({ name: `q${i}.bak`, mtimeMs: now - (15 - i) * 100 });
    }
    seedQuarantineFiles(names);

    const res = await cleanupQuarantine(corruptedDir, {
      maxAgeMs: 10 * 60 * 1000,
      maxCount: 5,
      clock: () => now,
    });
    expect(res.removed).toBe(10);
    expect(listCorrupted()).toHaveLength(5);
    // The survivors should be the newest 5 (q10..q14).
    expect(listCorrupted()).toEqual(
      ['q10.bak', 'q11.bak', 'q12.bak', 'q13.bak', 'q14.bak'].sort(),
    );
  });

  it('uses the injected clock rather than wall time', async () => {
    const now = 10_000_000_000;
    seedQuarantineFiles([
      { name: 'stamped.bak', mtimeMs: now - 500 },
    ]);

    // With clock=now and maxAge=1000 nothing is expired.
    const noopRes = await cleanupQuarantine(corruptedDir, {
      maxAgeMs: 1000,
      maxCount: 100,
      clock: () => now,
    });
    expect(noopRes.removed).toBe(0);

    // With clock pushed into the future, the same file should fall
    // outside maxAgeMs.
    const expiredRes = await cleanupQuarantine(corruptedDir, {
      maxAgeMs: 1000,
      maxCount: 100,
      clock: () => now + 2000,
    });
    expect(expiredRes.removed).toBe(1);
    expect(listCorrupted()).toEqual([]);
  });
});

describe('cleanupQuarantineSync', () => {
  it('matches async semantics for age-based eviction', () => {
    const now = 10_000_000_000;
    seedQuarantineFiles([
      { name: 'old.bak', mtimeMs: now - 5000 },
      { name: 'keep.bak', mtimeMs: now - 10 },
    ]);
    const res = cleanupQuarantineSync(corruptedDir, {
      maxAgeMs: 1000,
      maxCount: 100,
      clock: () => now,
    });
    expect(res.removed).toBe(1);
    expect(listCorrupted()).toEqual(['keep.bak']);
  });
});

// ── Integration: core.ts → quarantine ───────────────────────────────

describe('atomicReadJSON integration with quarantine', () => {
  it('moves the primary into corrupted/ when validate rejects', async () => {
    await atomicWriteJSON(targetPath, { version: 1, shape: 'bad' });

    // Sanity — no quarantine directory yet.
    expect(fs.existsSync(corruptedDir)).toBe(false);

    const clock = () => 1_700_000_000_500;
    const loaded = await atomicReadJSON<{ shape: string }>(targetPath, {
      validate: (d): d is { shape: string } =>
        typeof d === 'object' &&
        d !== null &&
        (d as { shape?: string }).shape === 'good',
      clock,
    });

    // No healthy fallback — we expect null overall.
    expect(loaded).toBeNull();
    // Primary file must be out of its original slot.
    expect(fs.existsSync(targetPath)).toBe(false);

    const expected = path.join(corruptedDir, 'data.json.1700000000500.bak');
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('leaves .premigrate.bak files untouched even if they would fail validate', async () => {
    // Arrange: write the primary with a shape that passes validate, so
    // the primary read succeeds and quarantine is never triggered for
    // the primary. Meanwhile seed a `.premigrate.bak` with a broken
    // shape to prove it is not an eligible candidate for quarantine.
    await atomicWriteJSON(targetPath, { version: 1, shape: 'good' });
    const premigratePath = `${targetPath}.v0.premigrate.bak`;
    fs.writeFileSync(premigratePath, '{"shape":"bad"}', 'utf-8');

    const loaded = await atomicReadJSON<{ shape: string }>(targetPath, {
      validate: (d): d is { shape: string } =>
        typeof d === 'object' &&
        d !== null &&
        (d as { shape?: string }).shape === 'good',
    });

    expect(loaded).toEqual({ version: 1, shape: 'good' });
    // The premigrate sentinel must still exist — it is never a
    // quarantine candidate.
    expect(fs.existsSync(premigratePath)).toBe(true);
    expect(fs.existsSync(corruptedDir)).toBe(false);
  });

  it('moves a bad .bak slot into corrupted/ during fallback walk', async () => {
    // Write twice so .bak exists. Then corrupt .bak to a bad-shape
    // payload the validator will reject. The primary is deleted so
    // the fallback chain engages.
    await atomicWriteJSON(targetPath, { version: 1, shape: 'good' });
    await atomicWriteJSON(targetPath, { version: 1, shape: 'good' });
    fs.writeFileSync(`${targetPath}.bak`, '{"shape":"bad"}', 'utf-8');
    fs.unlinkSync(targetPath);

    const clock = () => 1_700_000_000_600;
    const loaded = await atomicReadJSON<{ shape: string }>(targetPath, {
      validate: (d): d is { shape: string } =>
        typeof d === 'object' &&
        d !== null &&
        (d as { shape?: string }).shape === 'good',
      clock,
    });

    // No good data anywhere.
    expect(loaded).toBeNull();
    // The corrupted .bak must have been moved under corrupted/ with
    // its own basename preserved.
    const expected = path.join(corruptedDir, 'data.json.bak.1700000000600.bak');
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.existsSync(`${targetPath}.bak`)).toBe(false);
  });
});
