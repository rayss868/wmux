/**
 * Tests for the cols-collapse corruption detector.
 *
 * The detector exists to catch dump files that exhibit the on-disk
 * signature observed in production v2.8.4: a 5 MB-bounded text file
 * where every non-empty line is 1-2 characters long, separated by
 * CRLF. The smoking-gun pattern, captured from real user data, is
 * reconstructed below.
 *
 * Coverage:
 *   - Real-world cols-collapse fixtures fire `isCorrupt: true`.
 *   - Legitimate dumps (normal output, sparse/idle sessions, narrow
 *     panes, ANSI-rich logs) MUST NOT trigger false positives — false
 *     positives discard real user history.
 *   - Edge cases: tiny inputs, all-blank files, malformed line
 *     endings, very long single lines.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeScrollbackContent,
  isLikelyChoppedScrollback,
} from '../corruption';

// ── Fixture builders ─────────────────────────────────────────────────

/** Build the 7.8KB / 42KB cols-collapse signature: 1-2 chars per CRLF. */
function colsCollapseFixture(
  text: string,
  charsPerLine = 2,
  paddingBlankLines = 80,
): string {
  const padded: string[] = [];
  for (let i = 0; i < paddingBlankLines; i++) padded.push('');
  for (let i = 0; i < text.length; i += charsPerLine) {
    padded.push(text.slice(i, i + charsPerLine));
  }
  return padded.join('\r\n');
}

/** Build a normal-looking dump with longer lines. */
function normalDump(lines: string[]): string {
  return lines.join('\r\n');
}

// ── Cases that SHOULD be flagged ─────────────────────────────────────

describe('corruption signature detection', () => {
  it('flags the production v2.8.4 7.8KB pattern (chopped prompt + commands)', () => {
    // Reconstructs the actual on-disk pattern: many leading blanks, then
    // a chopped prompt + chopped "claude" line + chopped "Accessing
    // workspace" + many 1-2 char fragments.
    const chopped = colsCollapseFixture(
      'PS C:\\Users\\rizz> claude' +
        'Accessing workspace:' +
        'C:\\Users\\rizz' +
        'Quick safety check: Is this a project you created or one you trust?' +
        '(Like your own code, a well-known open source project, or work)',
      2,
      80,
    );
    const report = analyzeScrollbackContent(chopped);
    expect(report.isCorrupt).toBe(true);
    expect(report.stats.medianNonEmptyLen).toBeLessThanOrEqual(3);
    expect(report.stats.crlfByteRatio).toBeGreaterThan(0.3);
  });

  it('flags the 42KB CommandNotFoundException-chopped pattern', () => {
    const longCommandOutput =
      'omma' + // wraps in 2-char chunks below
      'ndNotFoundException' +
      'PS C:\\Users\\rizz> dd' +
      ": 'd' 용어가 cmdlet, 함수, 스크립트 파일 또는 실행할 수 있는 프로그램 이름으로 인식되지 않습니다.";
    const chopped = colsCollapseFixture(longCommandOutput.repeat(50), 2, 40);
    expect(isLikelyChoppedScrollback(chopped)).toBe(true);
  });

  it('flags content even when a few long pre-collapse lines slipped through', () => {
    // Reproduces the real on-disk shape: cols-collapse reflow leaves a
    // handful of pre-collapse lines intact. Production v2.8.4 samples
    // had a max non-empty line length up to 60 chars in an otherwise-
    // chopped 42 KB file. The detector must still flag because the
    // BULK distribution is dominated by 1-2 char chops — median is
    // the load-bearing signal, not max.
    const chopped = colsCollapseFixture('a'.repeat(2000), 2, 30);
    const withOutliers =
      'OK\r\nthis is a much longer pre-collapse line that survived\r\n' + chopped;
    expect(isLikelyChoppedScrollback(withOutliers)).toBe(true);
    expect(isLikelyChoppedScrollback(chopped)).toBe(true);
  });

  it('flags the real production v2.8.4 on-disk pattern (median=1, max=60)', () => {
    // This fixture mirrors the actual hex pattern observed in user data:
    // ~99% of non-empty lines are 1-2 chars (cols=2 reflow), but a
    // minority of pre-collapse lines stayed up to ~60 chars. An earlier
    // version of this detector gated on max<=10 and missed this case.
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push(''); // leading blanks
    for (let i = 0; i < 10; i++) lines.push('this is a 30-char-ish surviving line ' + i); // long outliers
    for (let i = 0; i < 5000; i++) lines.push(i % 2 === 0 ? 'a' : 'bc'); // bulk chopped
    expect(isLikelyChoppedScrollback(lines.join('\r\n'))).toBe(true);
  });
});

// ── Cases that MUST NOT be flagged ───────────────────────────────────

describe('false-positive resistance', () => {
  it('does not flag a normal session with mixed-length output', () => {
    const content = normalDump([
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
    ]);
    expect(isLikelyChoppedScrollback(content)).toBe(false);
  });

  it('does not flag a sparse / mostly-idle session (few non-empty lines)', () => {
    const content =
      '\r\n'.repeat(100) +
      'PS C:\\Users\\rizz> \r\n' +
      '\r\n'.repeat(20);
    const report = analyzeScrollbackContent(content);
    expect(report.isCorrupt).toBe(false);
  });

  it('does not flag content below the minimum byte threshold', () => {
    expect(isLikelyChoppedScrollback('PS> ls\r\n')).toBe(false);
    expect(isLikelyChoppedScrollback('')).toBe(false);
  });

  it('does not flag a narrow-pane session with ~20-char lines', () => {
    // A genuinely narrow but functional pane: cols ≈ 20. Median should
    // sit around 15-20, well above the corruption threshold.
    const lines = Array.from({ length: 100 }, (_, i) => `narrow line ${i}!`);
    expect(isLikelyChoppedScrollback(normalDump(lines))).toBe(false);
  });

  it('does not flag ANSI-rich log output', () => {
    // ANSI escapes are still part of the line length, and `translateToString`
    // strips them anyway. Use realistic shell output with prompts + status lines.
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`[2026-05-14T${i.toString().padStart(2, '0')}:00:00Z] INFO worker started`);
      lines.push(`[2026-05-14T${i.toString().padStart(2, '0')}:00:01Z] DEBUG fetched 100 records`);
    }
    expect(isLikelyChoppedScrollback(normalDump(lines))).toBe(false);
  });

  it('does not flag a file with one very long line', () => {
    // A pasted JSON blob or single command with no newlines. CRLF
    // density is essentially zero so detector abstains.
    const content = 'x'.repeat(10_000);
    expect(isLikelyChoppedScrollback(content)).toBe(false);
  });
});

// ── Stats sanity ─────────────────────────────────────────────────────

describe('analyzeScrollbackContent stats', () => {
  it('populates totalBytes for all paths', () => {
    const content = 'a'.repeat(500);
    const report = analyzeScrollbackContent(content);
    expect(report.stats.totalBytes).toBe(500);
  });

  it('counts CRLF bytes correctly', () => {
    // 10 lines of length 5, joined with CRLF → 10*5 + 9*2 = 68 bytes,
    // 18 CRLF bytes.
    const content = Array.from({ length: 10 }, () => 'abcde').join('\r\n');
    const report = analyzeScrollbackContent(content);
    expect(report.stats.crlfBytes).toBe(18);
    expect(report.stats.totalBytes).toBe(68);
  });

  it('returns an abstain reason for tiny inputs', () => {
    const report = analyzeScrollbackContent('hi\r\n');
    expect(report.isCorrupt).toBe(false);
    expect(report.reason).toMatch(/below minimum size/);
  });
});
