/**
 * T10 — rotation integration tests.
 *
 * Exercises the full atomicWriteJSON / atomicReadJSON pipeline with
 * rotation enabled, covering cases that live between T5's unit coverage
 * (which stubs at the rotation helpers) and T6's quarantine suite
 * (which exercises read-time isolation). These tests deliberately
 * reach the real filesystem under `os.tmpdir()` so rename semantics on
 * the current platform are hit for real — the sibling rotation.test.ts
 * already covers the invariants at the module boundary.
 *
 * Ground rules:
 *   - No source modifications; tests validate observed behaviour only.
 *   - Each `it` gets a fresh tmp directory scrubbed on teardown.
 *   - Rename-level mocks use `spyOn(fsp, 'rename')` + `mockImplementationOnce`
 *     so the rest of the write path still hits the real fs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  atomicWriteJSON,
  atomicReadJSON,
} from '../core';

let tmpDir: string;
let targetPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `wmux-t10-rotation-${Date.now()}-`),
  );
  targetPath = path.join(tmpDir, 'data.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function readJSONRaw(suffix: '' | '.bak' | '.bak.1' | '.bak.2' | '.bak.3'): unknown {
  const p = `${targetPath}${suffix}`;
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function existsAt(suffix: '' | '.bak' | '.bak.1' | '.bak.2' | '.bak.3'): boolean {
  return fs.existsSync(`${targetPath}${suffix}`);
}

// ── Case 1 — four consecutive rotation-enabled writes ───────────────

describe('atomicWriteJSON(rotationEnabled) integration', () => {
  it('populates primary + .bak/.bak.1/.bak.2 after four sequential writes', async () => {
    // Writes in order: gen 1, 2, 3, 4. Expected end-state:
    //   primary = gen 4   .bak   = gen 3
    //   .bak.1  = gen 2   .bak.2 = gen 1
    //   .bak.3  = <unused — only four generations written so far>
    await atomicWriteJSON(targetPath, { gen: 1 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 2 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 3 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 4 }, { rotationEnabled: true });

    expect(readJSONRaw('')).toEqual({ gen: 4 });
    expect(readJSONRaw('.bak')).toEqual({ gen: 3 });
    expect(readJSONRaw('.bak.1')).toEqual({ gen: 2 });
    expect(readJSONRaw('.bak.2')).toEqual({ gen: 1 });
    expect(existsAt('.bak.3')).toBe(false);
  });

  // ── Case 2 — five writes overwrite the oldest slot ────────────────
  it('overwrites the oldest slot on the fifth write', async () => {
    for (let i = 1; i <= 5; i++) {
      await atomicWriteJSON(targetPath, { gen: i }, { rotationEnabled: true });
    }

    // After five writes, every slot is populated and the oldest
    // surviving generation is gen 1 in .bak.3.
    expect(readJSONRaw('')).toEqual({ gen: 5 });
    expect(readJSONRaw('.bak')).toEqual({ gen: 4 });
    expect(readJSONRaw('.bak.1')).toEqual({ gen: 3 });
    expect(readJSONRaw('.bak.2')).toEqual({ gen: 2 });
    expect(readJSONRaw('.bak.3')).toEqual({ gen: 1 });
  });

  // ── Case 7 — rotation allowlist preserved on real filesystem ─────
  it('never touches corrupted/ copies or the .premigrate.bak sentinel', async () => {
    // Seed sibling artifacts that rotation must leave alone. Both the
    // T6 quarantine subtree and the T7 pre-migration sentinel sit in
    // the same directory; neither is part of the managed chain.
    const corruptedDir = path.join(tmpDir, 'corrupted');
    fs.mkdirSync(corruptedDir, { recursive: true });
    const quarantineCopy = path.join(
      corruptedDir,
      'data.json.1700000000000.bak',
    );
    fs.writeFileSync(quarantineCopy, 'quarantined-payload', 'utf-8');

    const premigrate = `${targetPath}.v1.premigrate.bak`;
    fs.writeFileSync(premigrate, 'premigrate-payload', 'utf-8');

    // Drive rotation three times so the full .bak chain materialises.
    await atomicWriteJSON(targetPath, { gen: 1 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 2 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 3 }, { rotationEnabled: true });

    // The rotation managed slots should have populated per the usual
    // chain — gen 3 is primary, .bak.3 is still empty.
    expect(readJSONRaw('')).toEqual({ gen: 3 });
    expect(readJSONRaw('.bak')).toEqual({ gen: 2 });
    expect(readJSONRaw('.bak.1')).toEqual({ gen: 1 });

    // The two non-managed artifacts must still carry their original
    // bytes. Any rotation step touching them would have overwritten
    // with newer gen bytes.
    expect(fs.readFileSync(quarantineCopy, 'utf-8')).toBe('quarantined-payload');
    expect(fs.readFileSync(premigrate, 'utf-8')).toBe('premigrate-payload');
  });
});

// ── Case 3 — atomicReadJSON fallback recovers from healthy slot ─────

describe('atomicReadJSON fallback chain (rotation-enabled history)', () => {
  it('recovers from .bak.1 when primary is corrupt and .bak is corrupt', async () => {
    // Build out a four-generation chain so every slot is populated.
    await atomicWriteJSON(targetPath, { gen: 1, payload: 'g1' }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 2, payload: 'g2' }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 3, payload: 'g3' }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 4, payload: 'g4' }, { rotationEnabled: true });

    // After four writes: primary=gen4, .bak=gen3, .bak.1=gen2, .bak.2=gen1.
    // Corrupt primary + .bak so fallback walks into .bak.1 (gen 2).
    fs.writeFileSync(targetPath, '{not json', 'utf-8');
    fs.writeFileSync(`${targetPath}.bak`, '{not json either', 'utf-8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loaded = await atomicReadJSON<{ gen: number; payload: string }>(targetPath);
      expect(loaded).toEqual({ gen: 2, payload: 'g2' });
    } finally {
      warn.mockRestore();
    }
  });

  // ── Case 4 — all backups corrupt returns null ─────────────────────
  it('returns null when primary + every backup is corrupt JSON', async () => {
    await atomicWriteJSON(targetPath, { gen: 1 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 2 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 3 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 4 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 5 }, { rotationEnabled: true });

    // Smash every participating slot — primary and all four backups.
    for (const suffix of ['', '.bak', '.bak.1', '.bak.2', '.bak.3'] as const) {
      fs.writeFileSync(`${targetPath}${suffix}`, '<<<corrupt>>>', 'utf-8');
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loaded = await atomicReadJSON(targetPath);
      expect(loaded).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

// ── Case 5 — rotation off keeps single-slot legacy behaviour ────────

describe('atomicWriteJSON (rotation off) single-slot semantics', () => {
  it('never creates .bak.1 through .bak.3 across multiple writes', async () => {
    // Four writes without rotationEnabled. Only `.bak` should appear
    // and the numbered slots must stay unused.
    await atomicWriteJSON(targetPath, { gen: 1 });
    await atomicWriteJSON(targetPath, { gen: 2 });
    await atomicWriteJSON(targetPath, { gen: 3 });
    await atomicWriteJSON(targetPath, { gen: 4 });

    expect(readJSONRaw('')).toEqual({ gen: 4 });
    // Legacy single-slot: .bak holds the most recent previous gen.
    expect(readJSONRaw('.bak')).toEqual({ gen: 3 });
    // No rotated slots should ever materialise.
    expect(existsAt('.bak.1')).toBe(false);
    expect(existsAt('.bak.2')).toBe(false);
    expect(existsAt('.bak.3')).toBe(false);
  });
});

// ── Case 6 — mid-rotation rename failure is tolerated ───────────────

describe('atomicWriteJSON tolerates a failing mid-chain rename', () => {
  it('continues past an ENOENT on the .bak.2 → .bak.3 promotion and still lands primary', async () => {
    // Seed three generations so the .bak.2 → .bak.3 promotion has a
    // real source file on its next write.
    await atomicWriteJSON(targetPath, { gen: 1 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 2 }, { rotationEnabled: true });
    await atomicWriteJSON(targetPath, { gen: 3 }, { rotationEnabled: true });

    // State now: primary=gen3, .bak=gen2, .bak.1=gen1.
    expect(readJSONRaw('')).toEqual({ gen: 3 });

    // Arrange a 4th write where the FIRST fsp.rename call fails with
    // ENOENT. In the rotateBackups walk the oldest-first step is
    // `.bak.2 → .bak.3`, so that is the first rename exercised. An
    // ENOENT is interpreted by renameSlot as "source missing" and the
    // chain continues without logging a warning.
    const realRename = fsp.rename.bind(fsp);
    const renameSpy = vi.spyOn(fsp, 'rename');
    renameSpy.mockImplementationOnce(async () => {
      const err = new Error('synthetic missing') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    // Every subsequent rename call falls through to the real impl.
    renameSpy.mockImplementation((from, to) => realRename(from, to));

    await atomicWriteJSON(targetPath, { gen: 4 }, { rotationEnabled: true });

    // Primary got the new gen despite the mid-chain rename hiccup.
    expect(readJSONRaw('')).toEqual({ gen: 4 });
    // .bak advanced to what used to be primary.
    expect(readJSONRaw('.bak')).toEqual({ gen: 3 });
    // .bak.1 advanced to what used to be .bak.
    expect(readJSONRaw('.bak.1')).toEqual({ gen: 2 });
  });
});

// ── Case 8 — concurrent rotation writes settle to a valid state ─────

describe('concurrent atomicWriteJSON(rotationEnabled)', () => {
  it('concurrent writes — at least one succeeds, final state is consistent with one of the writes', async () => {
    // AsyncQueue is the correct mechanism for serialising concurrent
    // writes; atomicWriteJSON itself does not guarantee atomicity
    // across concurrent callers. On Windows in particular, two
    // tmp→primary renames overlapping in time can surface as EPERM /
    // EEXIST / ENOENT because the OS holds a short-lived handle on the
    // destination while the previous rename is finalising. The
    // important contract we test here is that such a race never
    // corrupts the file on disk: at least one writer lands, primary
    // parses cleanly, and its payload matches exactly one of the
    // submitted writes.

    // Seed a baseline so both concurrent writers race over an existing
    // primary — otherwise the first rename primary→.bak is a no-op.
    await atomicWriteJSON(targetPath, { gen: 0 }, { rotationEnabled: true });

    // Two rotation-enabled writes in flight simultaneously. Each owns
    // its own tmp slot (core.ts uses a monotonic counter) so tmp
    // collisions are impossible, but the rotate/rename/rename triplet
    // is not serialised. The hard invariants are: (a) at least one
    // writer succeeds, and (b) primary is readable as one of the
    // submitted payloads — never missing, never corrupt.
    const writes = [
      atomicWriteJSON(targetPath, { gen: 'A' }, { rotationEnabled: true }),
      atomicWriteJSON(targetPath, { gen: 'B' }, { rotationEnabled: true }),
    ];

    const results = await Promise.allSettled(writes);
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    // At least one writer must succeed. All-rejected would mean the
    // caller's data was fully lost, which atomicWriteJSON must never do.
    expect(rejected.length).toBeLessThan(writes.length);

    // Any rejection must be a known rename-race errno from the OS —
    // not a programming error, not a corrupt-state exception.
    const allowedCodes = new Set(['EPERM', 'EEXIST', 'ENOENT', 'EBUSY']);
    for (const r of rejected) {
      const code = (r.reason as NodeJS.ErrnoException | undefined)?.code;
      expect(allowedCodes.has(code ?? '')).toBe(true);
    }

    // Primary is readable and its content is byte-identical to one of
    // the submitted payloads (no partial writes, no torn JSON).
    expect(existsAt('')).toBe(true);
    const primary = readJSONRaw('') as { gen: string };
    expect([{ gen: 'A' }, { gen: 'B' }]).toContainEqual(primary);

    // No .tmp residue should linger in tmpDir.
    const leftovers = fs
      .readdirSync(tmpDir)
      .filter((name) => name.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });
});
