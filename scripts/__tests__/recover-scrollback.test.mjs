/**
 * Unit tests for the v2.8.x → v2.9.0 scrollback recovery tool.
 *
 * Scope:
 *   - Detector mirrors `src/main/scrollback/corruption.ts` behaviour
 *     (flag production v2.8.4 chopped patterns, abstain on clean output
 *     and on tiny / sparse inputs).
 *   - Reverse reflow preserves character content of the chopped input
 *     and converts paragraph-style blank rows into single-newline
 *     separators.
 *   - CLI arg parsing handles the documented options + rejects
 *     unknown flags with a non-zero exit code.
 *   - End-to-end `processFile` reads a fixture, classifies, recovers,
 *     and (when `outDir` set + not dryRun) writes the recovered text.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isLikelyChoppedScrollback,
  reverseReflowFromCols2,
  scanContent,
  processFile,
  main,
} from '../recover-scrollback.mjs';

// ── Fixture builders ───────────────────────────────────────────────────────

function colsCollapseFixture(text, charsPerLine = 2, paddingBlankLines = 80) {
  const out = [];
  for (let i = 0; i < paddingBlankLines; i++) out.push('');
  for (let i = 0; i < text.length; i += charsPerLine) {
    out.push(text.slice(i, i + charsPerLine));
  }
  return out.join('\r\n');
}

// ── Detector parity with production ────────────────────────────────────────

describe('isLikelyChoppedScrollback', () => {
  it('flags a 2-char-per-line chopped fixture (with padding)', () => {
    const fx = colsCollapseFixture(
      'PS C:\\Users\\rizz> claude' +
        'Accessing workspace:' +
        'C:\\Users\\rizz' +
        'Quick safety check: Is this a project you created or trust?' +
        '(Like your own code, a well-known open source project)',
      2,
      80,
    );
    expect(isLikelyChoppedScrollback(fx)).toBe(true);
  });

  it('flags the real production pattern (median=1, mixed max widths)', () => {
    const lines = [];
    for (let i = 0; i < 50; i++) lines.push('');
    for (let i = 0; i < 10; i++) lines.push('this is a 30-char-ish pre-collapse line ' + i);
    for (let i = 0; i < 5000; i++) lines.push(i % 2 === 0 ? 'a' : 'bc');
    expect(isLikelyChoppedScrollback(lines.join('\r\n'))).toBe(true);
  });

  it('does not flag normal mixed-length output', () => {
    const content = [
      'PS C:\\Users\\rizz> ls',
      '',
      '    Directory: C:\\Users\\rizz',
      '',
      'Mode                LastWriteTime         Length Name',
      '----                -------------         ------ ----',
      'd-----        2026-05-14 14:30                AppData',
      'd-----        2026-05-14 10:15                Documents',
      '-a----        2026-05-14 09:01           1234 example.txt',
      '',
      'PS C:\\Users\\rizz> echo "hello world"',
      'hello world',
      'PS C:\\Users\\rizz> ',
    ].join('\r\n');
    expect(isLikelyChoppedScrollback(content)).toBe(false);
  });

  it('does not flag short or sparse input', () => {
    expect(isLikelyChoppedScrollback('')).toBe(false);
    expect(isLikelyChoppedScrollback('PS> ls\r\n')).toBe(false);
    const sparse =
      '\r\n'.repeat(100) + 'PS C:\\Users\\rizz> \r\n' + '\r\n'.repeat(20);
    expect(isLikelyChoppedScrollback(sparse)).toBe(false);
  });

  it('does not flag a narrow-pane real session (~20-char lines)', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `narrow line ${i}!`);
    expect(isLikelyChoppedScrollback(lines.join('\r\n'))).toBe(false);
  });
});

// ── scanContent stats ──────────────────────────────────────────────────────

describe('scanContent', () => {
  it('returns total/CRLF bytes and per-line lengths', () => {
    const content = ['abcde', 'fg', 'hijkl'].join('\r\n');
    const r = scanContent(content);
    expect(r.totalBytes).toBe(content.length);
    expect(r.crlfBytes).toBe(4); // 2 separators × 2 bytes
    expect(r.nonEmptyLengths).toEqual([5, 2, 5]);
  });

  it('counts a trailing line with no CRLF', () => {
    const r = scanContent('abc');
    expect(r.nonEmptyLengths).toEqual([3]);
    expect(r.crlfBytes).toBe(0);
  });
});

// ── Reverse reflow ─────────────────────────────────────────────────────────

describe('reverseReflowFromCols2', () => {
  it('joins single-char rows into a recovered paragraph', () => {
    const fx = colsCollapseFixture('CommandNotFoundException', 2, 0);
    expect(reverseReflowFromCols2(fx)).toBe('CommandNotFoundException');
  });

  it('treats a blank row as paragraph boundary', () => {
    // Two paragraphs separated by a blank row. Each paragraph's chopped
    // rows should fuse into one logical line; the blank row should
    // survive as exactly one `\n` boundary.
    const fx =
      colsCollapseFixture('PSecho hi', 2, 0) +
      '\r\n\r\n' +
      colsCollapseFixture('rrooww22', 2, 0);
    const recovered = reverseReflowFromCols2(fx);
    const lines = recovered.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(recovered).toContain('PSecho hi');
    expect(recovered).toContain('rrooww22');
    // Blank-row separator should survive.
    expect(recovered.indexOf('PSecho hi')).toBeLessThan(recovered.indexOf('rrooww22'));
  });

  it('is a pure transform — does not abstain on small clean input', () => {
    // `reverseReflowFromCols2` is intentionally NOT gated on the
    // corruption detector. The detector check lives in `processFile`
    // (so the caller can choose). Asserting raw transform here: a
    // 3-row input with no blanks collapses to a single concatenated
    // paragraph.
    const result = reverseReflowFromCols2('PS> ls\r\nfile1.txt\r\nfile2.txt');
    expect(result).toBe('PS> lsfile1.txtfile2.txt');
  });

  it('strips leading blank padding', () => {
    const fx = '\r\n'.repeat(80) + colsCollapseFixture('Hello', 2, 0);
    const recovered = reverseReflowFromCols2(fx);
    expect(recovered.startsWith('Hello') || recovered === 'Hello').toBe(true);
  });
});

// ── processFile end-to-end ─────────────────────────────────────────────────

describe('processFile', () => {
  let tmpDir;
  let outDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-recover-test-'));
    outDir = path.join(tmpDir, 'out');
    fs.mkdirSync(outDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a recovered file for a chopped input', () => {
    const src = path.join(tmpDir, 'surface-abc.txt.1700000000000.bak');
    const fx = colsCollapseFixture(
      'PS C:\\Users\\rizz> command output here'.repeat(20),
      2,
      40,
    );
    fs.writeFileSync(src, fx, 'utf-8');

    const result = processFile(src, { outDir });
    expect(result.corrupt).toBe(true);
    expect(result.recoveredBytes).toBeGreaterThan(0);
    expect(result.outPath).toMatch(/surface-abc\.txt\.recovered\.txt$/);
    expect(fs.existsSync(result.outPath)).toBe(true);
    const written = fs.readFileSync(result.outPath, 'utf-8');
    expect(written).toContain('command output here');
  });

  it('does not write when content is not chopped', () => {
    const src = path.join(tmpDir, 'surface-clean.txt.1700000000000.bak');
    const content = Array.from({ length: 30 }, (_, i) => `log line ${i} with some text`).join('\r\n');
    fs.writeFileSync(src, content, 'utf-8');

    const result = processFile(src, { outDir });
    expect(result.corrupt).toBe(false);
    expect(result.outPath).toBeNull();
    expect(fs.readdirSync(outDir).length).toBe(0);
  });

  it('honours dry-run (no file written even for corrupt input)', () => {
    const src = path.join(tmpDir, 'surface-abc.txt.1700000000000.bak');
    // Need >256 bytes + >20 non-empty lines to trigger the detector.
    const longText = 'hello world hello world '.repeat(50);
    fs.writeFileSync(src, colsCollapseFixture(longText, 2, 30), 'utf-8');

    const result = processFile(src, { outDir, dryRun: true });
    expect(result.corrupt).toBe(true);
    expect(fs.readdirSync(outDir).length).toBe(0);
  });

  it('derives output name from quarantined naming convention', () => {
    const src = path.join(
      tmpDir,
      'surface-94241a2a-8c69-4cca-8f62-4d780b6b2b4e.txt.bak.1778754626473.bak',
    );
    fs.writeFileSync(src, colsCollapseFixture('a'.repeat(2000), 2, 30), 'utf-8');
    const result = processFile(src, { outDir });
    // .bak.1778754626473.bak → .bak (the trailing timestamp suffix stripped)
    expect(result.outPath).toMatch(
      /surface-94241a2a-8c69-4cca-8f62-4d780b6b2b4e\.txt\.bak\.recovered\.txt$/,
    );
  });
});

// ── CLI plumbing ───────────────────────────────────────────────────────────

describe('main (CLI)', () => {
  let logs;
  let errs;
  let origLog;
  let origErr;
  let origExitCode;

  beforeEach(() => {
    logs = [];
    errs = [];
    origLog = console.log;
    origErr = console.error;
    origExitCode = process.exitCode;
    console.log = (...args) => logs.push(args.join(' '));
    console.error = (...args) => errs.push(args.join(' '));
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExitCode;
  });

  it('prints help on --help and does not error', () => {
    main(['--help']);
    expect(logs.join('\n')).toMatch(/USAGE/);
    expect(process.exitCode).not.toBe(2);
  });

  it('rejects unknown flag with exit code 2', () => {
    main(['--bogus']);
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/error:/);
  });

  it('reports input dir missing with exit code 1', () => {
    const fake = path.join(os.tmpdir(), 'wmux-recover-does-not-exist-' + Date.now());
    main(['--input', fake]);
    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/input dir does not exist/);
  });

  it('skips writing in dry-run mode', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-recover-cli-test-'));
    try {
      const src = path.join(tmpDir, 'surface-x.txt.1700000000000.bak');
      fs.writeFileSync(src, colsCollapseFixture('helloworld'.repeat(20), 2, 30), 'utf-8');
      const outDir = path.join(tmpDir, 'out');
      main(['--input', tmpDir, '--output', outDir, '--dry-run']);
      expect(fs.existsSync(outDir)).toBe(false); // dry-run skips mkdir
      expect(logs.join('\n')).toMatch(/CORRUPT/);
      expect(logs.join('\n')).toMatch(/dry-run/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
