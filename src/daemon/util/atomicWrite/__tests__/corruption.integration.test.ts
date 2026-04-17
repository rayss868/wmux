/**
 * T10 — corruption + quarantine integration tests.
 *
 * Focuses on behaviour that crosses the core.ts ⇄ quarantine.ts
 * boundary: a failing `validate` on `atomicReadJSON` must hand the
 * offending file to the quarantine pipeline, the quarantine subtree
 * must stay off-limits to rotation, structured logs must be emitted
 * on stderr, and cleanup retention must engage on both time- and
 * count-based eviction paths.
 *
 * These tests intentionally avoid re-asserting pure-function behaviour
 * already covered in `quarantine.test.ts` / `rotation.test.ts`. The
 * focus is the end-to-end path operators will see in production.
 *
 * Ground rules:
 *   - No source modifications.
 *   - Each `it` gets a fresh tmp directory scrubbed on teardown.
 *   - stderr capture uses `spyOn(process.stderr, 'write')` so parallel
 *     tests do not interleave log lines into the assertion buffer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  atomicWriteJSON,
  atomicReadJSON,
  atomicWriteJSONSync,
  atomicReadJSONSync,
} from '../core';
import { cleanupQuarantine, type CorruptFileLog } from '../quarantine';

let tmpDir: string;
let targetPath: string;
let corruptedDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `wmux-t10-corruption-${Date.now()}-`),
  );
  targetPath = path.join(tmpDir, 'data.json');
  corruptedDir = path.join(tmpDir, 'corrupted');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type ShapeGood = { shape: 'good' };
const goodShape = (d: unknown): d is ShapeGood =>
  typeof d === 'object' &&
  d !== null &&
  (d as Record<string, unknown>)['shape'] === 'good';

function listCorrupted(): string[] {
  if (!fs.existsSync(corruptedDir)) return [];
  return fs.readdirSync(corruptedDir).sort();
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      if (typeof chunk === 'string') lines.push(chunk);
      else if (chunk instanceof Uint8Array)
        lines.push(Buffer.from(chunk).toString('utf-8'));
      return true;
    });
  return { lines, restore: () => spy.mockRestore() };
}

// ── Case 1 — validate failure isolates primary and returns null ─────

describe('atomicReadJSON validate failure end-to-end', () => {
  it('moves primary into corrupted/ and returns null when validate rejects', async () => {
    await atomicWriteJSON(targetPath, { shape: 'bad' });
    expect(fs.existsSync(corruptedDir)).toBe(false);

    const stderr = captureStderr();
    let loaded: ShapeGood | null;
    try {
      loaded = await atomicReadJSON<ShapeGood>(targetPath, {
        validate: goodShape,
        clock: () => 1_700_000_000_100,
      });
    } finally {
      stderr.restore();
    }

    expect(loaded).toBeNull();
    expect(fs.existsSync(targetPath)).toBe(false);
    const quarantined = path.join(corruptedDir, 'data.json.1700000000100.bak');
    expect(fs.existsSync(quarantined)).toBe(true);
    // A single CORRUPT_FILE log entry should have been produced.
    const logs = stderr.lines.filter((l) => l.includes('"CORRUPT_FILE"'));
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Case 2 — rotation must not touch corrupted/ ─────────────────────

describe('rotation avoidance of quarantined copies', () => {
  it('does not disturb corrupted/* when subsequent rotation-enabled writes run', async () => {
    // 1. Trigger a quarantine by reading with a rejecting validator.
    await atomicWriteJSON(targetPath, { shape: 'bad' });
    await atomicReadJSON<ShapeGood>(targetPath, {
      validate: goodShape,
      clock: () => 1_700_000_000_200,
    });

    const quarantined = path.join(
      corruptedDir,
      'data.json.1700000000200.bak',
    );
    expect(fs.existsSync(quarantined)).toBe(true);
    const quarantinedBody = fs.readFileSync(quarantined, 'utf-8');

    // 2. Drive several rotation-enabled writes so the entire .bak
    //    chain materialises. If rotation ever reached into
    //    `corrupted/` the payload bytes would change or the file
    //    would disappear.
    for (let i = 1; i <= 5; i++) {
      await atomicWriteJSON(targetPath, { gen: i }, { rotationEnabled: true });
    }

    // Rotation chain populated as expected.
    expect(JSON.parse(fs.readFileSync(targetPath, 'utf-8'))).toEqual({ gen: 5 });
    expect(fs.existsSync(`${targetPath}.bak`)).toBe(true);
    expect(fs.existsSync(`${targetPath}.bak.3`)).toBe(true);

    // The quarantined copy is byte-identical and still lives in corrupted/.
    expect(fs.existsSync(quarantined)).toBe(true);
    expect(fs.readFileSync(quarantined, 'utf-8')).toBe(quarantinedBody);
  });
});

// ── Case 3 — two validate failures in a row quarantine both slots ───

describe('atomicReadJSON with primary + .bak both rejected', () => {
  it('quarantines primary, walks to .bak, quarantines it, and returns null', async () => {
    // Two writes so .bak exists. Then overwrite both with a
    // "bad-shape" payload that parses as valid JSON but fails the
    // validator.
    await atomicWriteJSON(targetPath, { shape: 'good' });
    await atomicWriteJSON(targetPath, { shape: 'good' });

    fs.writeFileSync(targetPath, JSON.stringify({ shape: 'bad' }), 'utf-8');
    fs.writeFileSync(
      `${targetPath}.bak`,
      JSON.stringify({ shape: 'also-bad' }),
      'utf-8',
    );

    // Monotonic clock so primary and .bak land on distinct
    // quarantine filenames.
    let counter = 1_700_000_100_000;
    const clock = () => counter++;

    const loaded = await atomicReadJSON<ShapeGood>(targetPath, {
      validate: goodShape,
      clock,
    });
    expect(loaded).toBeNull();

    // Both offending files should now live under corrupted/, and
    // neither should remain at its original path.
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.existsSync(`${targetPath}.bak`)).toBe(false);

    const corrupted = listCorrupted();
    expect(corrupted).toHaveLength(2);
    // One copy was the primary, the other was the .bak slot — we
    // only care that both basenames are represented.
    expect(corrupted.some((n) => n.startsWith('data.json.') && !n.startsWith('data.json.bak'))).toBe(true);
    expect(corrupted.some((n) => n.startsWith('data.json.bak.'))).toBe(true);
  });
});

// ── Case 4 — cleanupQuarantine with fake clock (age-based) ──────────

describe('cleanupQuarantine retention', () => {
  it('removes a 35-day-old file once the clock advances past maxAgeMs', async () => {
    fs.mkdirSync(corruptedDir, { recursive: true });
    const stalePath = path.join(corruptedDir, 'stale.bak');
    fs.writeFileSync(stalePath, 'x', 'utf-8');

    // Pin the file's mtime 35 days in the past relative to our fake
    // "now". Using fs.utimesSync keeps the fake clock hermetic — the
    // cleanup routine only reads mtime + its injected clock.
    const now = 1_700_000_000_000;
    const thirtyFiveDaysMs = 35 * 24 * 60 * 60 * 1000;
    const staleMtime = now - thirtyFiveDaysMs;
    fs.utimesSync(stalePath, staleMtime / 1000, staleMtime / 1000);

    const res = await cleanupQuarantine(corruptedDir, {
      clock: () => now,
      // default maxAge = 30d, file is 35d old → evicted.
    });
    expect(res.removed).toBe(1);
    expect(fs.existsSync(stalePath)).toBe(false);
  });

  // ── Case 5 — count-based eviction keeps newest 10 ────────────────
  it('keeps the newest maxCount files when count exceeds the cap', async () => {
    fs.mkdirSync(corruptedDir, { recursive: true });

    const now = 2_000_000_000_000;
    // Seed 12 files whose mtimes are strictly ordered: item 0 is the
    // oldest, item 11 is the newest. Default maxCount is 10 → the
    // two oldest should be evicted.
    const names: string[] = [];
    for (let i = 0; i < 12; i++) {
      const name = `q${i.toString().padStart(2, '0')}.bak`;
      const p = path.join(corruptedDir, name);
      fs.writeFileSync(p, 'x', 'utf-8');
      const mtime = now - (12 - i) * 1000;
      fs.utimesSync(p, mtime / 1000, mtime / 1000);
      names.push(name);
    }

    const res = await cleanupQuarantine(corruptedDir, {
      clock: () => now,
      maxAgeMs: 10 * 365 * 24 * 60 * 60 * 1000, // age disabled
      maxCount: 10,
    });
    expect(res.removed).toBe(2);

    const survivors = listCorrupted();
    expect(survivors).toHaveLength(10);
    // The two oldest (q00, q01) should be gone; the newest ten
    // (q02..q11) should remain.
    expect(survivors).not.toContain('q00.bak');
    expect(survivors).not.toContain('q01.bak');
    expect(survivors).toContain('q02.bak');
    expect(survivors).toContain('q11.bak');
  });
});

// ── Case 6 — premigrate.bak is not quarantined ──────────────────────

describe('.premigrate.bak is excluded from quarantine', () => {
  it('leaves the T7 sentinel untouched even when its payload would fail validate', async () => {
    // Primary carries a valid shape so it passes the validator and
    // the fallback chain is never entered. Any .premigrate.bak file
    // should remain in place regardless — it is owned by T7 and is
    // not part of the fallback walk or the quarantine allowlist.
    await atomicWriteJSON(targetPath, { shape: 'good' });
    const premigrate = `${targetPath}.v1.premigrate.bak`;
    fs.writeFileSync(
      premigrate,
      JSON.stringify({ shape: 'bad' }),
      'utf-8',
    );

    const loaded = await atomicReadJSON<ShapeGood>(targetPath, {
      validate: goodShape,
    });
    expect(loaded).toEqual({ shape: 'good' });

    // The sentinel must still exist with its original bytes; no
    // corrupted/ folder should have been created either.
    expect(fs.existsSync(premigrate)).toBe(true);
    expect(fs.readFileSync(premigrate, 'utf-8')).toBe(
      JSON.stringify({ shape: 'bad' }),
    );
    expect(fs.existsSync(corruptedDir)).toBe(false);
  });
});

// ── Case 7 — CORRUPT_FILE log shape is stable + sha prefix length ──

describe('CORRUPT_FILE structured log', () => {
  it('emits a JSON line with the full field set and a 16-char sha256_prefix', async () => {
    await atomicWriteJSON(targetPath, { shape: 'bad', payload: 'abc' });

    const stderr = captureStderr();
    try {
      await atomicReadJSON<ShapeGood>(targetPath, {
        validate: goodShape,
        clock: () => 1_700_000_000_777,
      });
    } finally {
      stderr.restore();
    }

    const logLine = stderr.lines
      .map((l) => l.trim())
      .find((l) => l.includes('"CORRUPT_FILE"'));
    expect(logLine).toBeDefined();

    const parsed = JSON.parse(logLine!) as CorruptFileLog;
    // Required fields.
    expect(parsed.event).toBe('CORRUPT_FILE');
    expect(parsed.code).toBe('CORRUPT_FILE');
    expect(parsed.level).toBe('warn');
    expect(parsed.ts).toBe(1_700_000_000_777);
    expect(parsed.path).toBe(targetPath);
    expect(parsed.quarantined_to).toBe(
      path.join(corruptedDir, 'data.json.1700000000777.bak'),
    );
    expect(parsed.reason).toMatch(/validate/i);
    // sha256_prefix: 16 lowercase hex chars (or "unknown" if read
    // failed — we wrote a real payload so the hex branch must hit).
    expect(parsed.sha256_prefix).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.sha256_prefix).toHaveLength(16);
  });
});

// ── Case 8 — sync variants share the corruption path ────────────────

describe('atomicWriteJSONSync + atomicReadJSONSync corruption path', () => {
  it('quarantines via the sync entry points with equivalent semantics', () => {
    atomicWriteJSONSync(targetPath, { shape: 'bad' });
    expect(fs.existsSync(corruptedDir)).toBe(false);

    const stderr = captureStderr();
    let loaded: ShapeGood | null;
    try {
      loaded = atomicReadJSONSync<ShapeGood>(targetPath, {
        validate: goodShape,
        clock: () => 1_700_000_000_900,
      });
    } finally {
      stderr.restore();
    }

    expect(loaded).toBeNull();
    // Sync path must observe the same rename-not-copy semantics as
    // the async variant: primary is gone, corrupted/ holds the copy.
    expect(fs.existsSync(targetPath)).toBe(false);
    const quarantined = path.join(
      corruptedDir,
      'data.json.1700000000900.bak',
    );
    expect(fs.existsSync(quarantined)).toBe(true);

    // Same log shape as the async variant — operators should not
    // have to branch on whether the save path was sync.
    const logLine = stderr.lines
      .map((l) => l.trim())
      .find((l) => l.includes('"CORRUPT_FILE"'));
    expect(logLine).toBeDefined();
    const parsed = JSON.parse(logLine!) as CorruptFileLog;
    expect(parsed.path).toBe(targetPath);
    expect(parsed.quarantined_to).toBe(quarantined);
    expect(parsed.sha256_prefix).toMatch(/^[0-9a-f]{16}$/);
  });
});
