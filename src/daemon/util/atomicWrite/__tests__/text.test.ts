/**
 * Tests for the text variant of atomicWrite.
 *
 * Mirrors `core.test.ts` for the JSON variant, but focuses on the
 * text-specific behaviours we need for scrollback persistence:
 *   - Raw UTF-8 round-trip (no JSON encoding side effects).
 *   - `.bak` rotation on overwrite.
 *   - Rotation chain when `rotationEnabled: true`.
 *   - `validate` hook rejects bad primaries and triggers the fallback
 *     walk + quarantine.
 *   - Pre-write validator aborts the write without mutating disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  atomicWriteText,
  atomicReadText,
  atomicWriteTextSync,
  atomicReadTextSync,
} from '../text';

let tmpDir: string;
let targetPath: string;
let bakPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-atomictext-test-'));
  targetPath = path.join(tmpDir, 'scrollback.txt');
  bakPath = `${targetPath}.bak`;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('atomicWriteText / atomicReadText — round-trip', () => {
  it('round-trips a UTF-8 payload', async () => {
    const payload = 'PS C:\\Users\\rizz> echo "héllo, wörld 🦀"\r\n';
    await atomicWriteText(targetPath, payload);

    const loaded = await atomicReadText(targetPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe(payload);
    expect(loaded!.path).toBe(targetPath);
  });

  it('round-trips a CRLF-heavy payload byte-for-byte', async () => {
    const payload = ['a', 'b', 'c'].join('\r\n');
    await atomicWriteText(targetPath, payload);
    const loaded = await atomicReadText(targetPath);
    expect(loaded?.content).toBe(payload);
  });

  it('returns null when neither primary nor backup exist', async () => {
    const loaded = await atomicReadText(targetPath);
    expect(loaded).toBeNull();
  });
});

describe('.bak rotation', () => {
  it('moves the previous primary to .bak on overwrite', async () => {
    await atomicWriteText(targetPath, 'first');
    expect(fs.existsSync(bakPath)).toBe(false);

    await atomicWriteText(targetPath, 'second');
    expect(fs.existsSync(bakPath)).toBe(true);
    expect(fs.readFileSync(bakPath, 'utf-8')).toBe('first');
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('second');
  });

  it('with rotationEnabled, retains older generations across writes', async () => {
    await atomicWriteText(targetPath, 'gen-1', { rotationEnabled: true });
    await atomicWriteText(targetPath, 'gen-2', { rotationEnabled: true });
    await atomicWriteText(targetPath, 'gen-3', { rotationEnabled: true });
    await atomicWriteText(targetPath, 'gen-4', { rotationEnabled: true });

    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('gen-4');
    expect(fs.readFileSync(`${targetPath}.bak`, 'utf-8')).toBe('gen-3');
    expect(fs.readFileSync(`${targetPath}.bak.1`, 'utf-8')).toBe('gen-2');
    expect(fs.readFileSync(`${targetPath}.bak.2`, 'utf-8')).toBe('gen-1');
  });

  it('recovers from .bak when the primary is missing', async () => {
    await atomicWriteText(targetPath, 'first');
    await atomicWriteText(targetPath, 'second');
    fs.unlinkSync(targetPath);

    const loaded = await atomicReadText(targetPath);
    expect(loaded?.content).toBe('first');
    expect(loaded?.path).toBe(bakPath);
  });
});

describe('validate hook on read', () => {
  it('skips a candidate that fails validate and falls back to the next slot', async () => {
    await atomicWriteText(targetPath, 'good content here');
    await atomicWriteText(targetPath, 'BAD'); // .bak now holds "good content here"

    // Reject any content shorter than 5 chars — the primary should be
    // rejected and the read should walk to .bak.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loaded = await atomicReadText(targetPath, {
        validate: (text) => text.length >= 5,
      });
      expect(loaded?.content).toBe('good content here');
      expect(loaded?.path).toBe(bakPath);
    } finally {
      warn.mockRestore();
    }
  });

  it('quarantines a rejected primary into corrupted/', async () => {
    await atomicWriteText(targetPath, 'BAD');

    const stableClock = vi.fn(() => 1_700_000_000_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const loaded = await atomicReadText(targetPath, {
        validate: () => false,
        clock: stableClock,
      });
      expect(loaded).toBeNull();
      expect(fs.existsSync(targetPath)).toBe(false);
      const corruptedDir = path.join(tmpDir, 'corrupted');
      expect(fs.existsSync(corruptedDir)).toBe(true);
      const corruptedFiles = fs.readdirSync(corruptedDir);
      expect(corruptedFiles.length).toBeGreaterThan(0);
      expect(corruptedFiles[0]).toMatch(/scrollback\.txt\.1700000000000\.bak/);
    } finally {
      warn.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it('returns null when every slot in the chain fails validate', async () => {
    await atomicWriteText(targetPath, 'bad-a');
    await atomicWriteText(targetPath, 'bad-b');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const loaded = await atomicReadText(targetPath, {
        validate: () => false,
      });
      expect(loaded).toBeNull();
    } finally {
      warn.mockRestore();
      stderrWrite.mockRestore();
    }
  });
});

describe('pre-write validate hook', () => {
  it('throws and leaves disk untouched when validate returns false', async () => {
    await atomicWriteText(targetPath, 'good');
    await expect(
      atomicWriteText(targetPath, 'BAD', {
        validate: () => false,
      }),
    ).rejects.toThrow(/rejected/);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('good');
  });

  it('throws and leaves disk untouched when validate throws', async () => {
    await atomicWriteText(targetPath, 'good');
    await expect(
      atomicWriteText(targetPath, 'BAD', {
        validate: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow(/boom/);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('good');
  });
});

describe('sync variants', () => {
  it('round-trips via sync write + sync read', () => {
    atomicWriteTextSync(targetPath, 'sync round-trip');
    const loaded = atomicReadTextSync(targetPath);
    expect(loaded?.content).toBe('sync round-trip');
  });

  it('sync write rotates .bak just like the async variant', () => {
    atomicWriteTextSync(targetPath, 'one');
    atomicWriteTextSync(targetPath, 'two');
    expect(fs.readFileSync(bakPath, 'utf-8')).toBe('one');
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('two');
  });

  it('sync read falls back through the rotation chain', () => {
    atomicWriteTextSync(targetPath, 'gen-1', { rotationEnabled: true });
    atomicWriteTextSync(targetPath, 'gen-2', { rotationEnabled: true });
    atomicWriteTextSync(targetPath, 'gen-3', { rotationEnabled: true });

    // Wipe primary + .bak; .bak.1 should still have gen-1.
    fs.unlinkSync(targetPath);
    fs.unlinkSync(`${targetPath}.bak`);

    const loaded = atomicReadTextSync(targetPath);
    expect(loaded?.content).toBe('gen-1');
    expect(loaded?.path).toBe(`${targetPath}.bak.1`);
  });
});
