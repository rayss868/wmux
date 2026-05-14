/**
 * Heuristic detector for scrollback dump files corrupted by a
 * hidden-container fit() reflow.
 *
 * Background
 * ----------
 * The renderer dumps each surface's xterm buffer every five seconds and on
 * `beforeunload`. `serializeTerminalBuffer` iterates physical xterm rows
 * (`buffer.getLine(i).translateToString(true)`) and joins them with CRLF.
 *
 * When xterm's FitAddon runs against a hidden or zero-width container it
 * collapses `cols` to a tiny value (we have seen ~2 in production). At
 * that point each physical row holds only one or two visible characters,
 * so a dump captured in that window looks like a column of single
 * characters. Once such a file is written to disk it survives forever
 * because (a) the renderer restores it into a fresh xterm via
 * `terminal.write()` on the next boot, and (b) the next 5s autosave
 * overwrites the (now in-memory) chopped buffer back onto disk — a
 * self-sustaining corruption loop.
 *
 * Smoking-gun signature on disk
 * -----------------------------
 *   - Tens or hundreds of non-empty lines.
 *   - Every non-empty line holds one or two characters.
 *   - CRLF bytes dominate the file (density ≈ 0.4 — roughly one CRLF per
 *     three bytes of content).
 *   - Common tokens ("PS C:\\Users\\rizz>", "CommandNotFoundException")
 *     are visibly split across consecutive single-character rows.
 *
 * Design goals for this detector
 * ------------------------------
 *   1. Cheap (single pass; no allocation per character).
 *   2. Conservative — only flag files that match the cols-collapse
 *      signature. False-positives discard real session output, which is
 *      worse than letting a degenerate-looking-but-legitimate file
 *      through.
 *   3. Self-contained — caller decides what to do with the verdict
 *      (quarantine, fall back to `.bak`, return null). The detector has
 *      no I/O.
 */

// ── Tunables ────────────────────────────────────────────────────────

/**
 * Files smaller than this never trip the detector. A pane that just
 * showed a prompt and idled produces a tiny file with one or two real
 * lines; that is not corruption, it is just a sparse buffer.
 */
const MIN_CONTENT_BYTES_TO_JUDGE = 256;

/**
 * Below this non-empty-line count we cannot reliably compute a stable
 * median, so we abstain from flagging.
 */
const MIN_NONEMPTY_LINES_TO_JUDGE = 20;

/**
 * A median non-empty line length at or below this value is the
 * smoking-gun part of the signature. Real terminal output very rarely
 * has a median below ~10 characters even on narrow panes.
 *
 * We deliberately do NOT gate on the MAX non-empty line length.
 * Production v2.8.4 samples (42 KB and 7.8 KB chopped dumps) had 99%+
 * of lines at 1-2 chars but a small minority of pre-collapse lines
 * that stayed up to 60 chars wide. Any max-based gate strict enough
 * to be useful would also reject these real-world fixtures; the
 * median is the far stronger signal because the cols-collapse reflow
 * forces the bulk distribution toward 1-2 chars regardless of any
 * straggler lines.
 */
const MAX_MEDIAN_NONEMPTY_LEN_FOR_CORRUPT = 3;

/**
 * Fraction of total file bytes consumed by CRLF separators. A file
 * where one in every ~3 bytes is part of a CRLF means the content
 * between CRLFs averages just one character — exactly the
 * cols-collapse signature.
 */
const MIN_CRLF_BYTE_RATIO_FOR_CORRUPT = 0.3;

// ── Internal helpers ────────────────────────────────────────────────

const CR = 0x0d;
const LF = 0x0a;

/**
 * Single-pass scan that returns the statistics the heuristic needs.
 * Splitting on '\r\n' would allocate a huge array for a 5MB cap'd
 * dump; this version keeps allocation to the running length list of
 * non-empty lines.
 */
function scanContent(content: string): {
  totalBytes: number;
  crlfBytes: number;
  nonEmptyLengths: number[];
} {
  const totalBytes = content.length;
  let crlfBytes = 0;
  const nonEmptyLengths: number[] = [];

  let lineStart = 0;
  for (let i = 0; i < totalBytes; i++) {
    const c = content.charCodeAt(i);
    if (c === CR && i + 1 < totalBytes && content.charCodeAt(i + 1) === LF) {
      const lineLen = i - lineStart;
      if (lineLen > 0) nonEmptyLengths.push(lineLen);
      crlfBytes += 2;
      i += 1; // consume LF
      lineStart = i + 1;
    } else if (c === LF) {
      // Bare LF — count as a line break but only the LF byte counts
      // toward the "CRLF" budget. Real dumps always use CRLF (writer
      // joins with '\r\n') so this branch is mostly defensive.
      const lineLen = i - lineStart;
      if (lineLen > 0) nonEmptyLengths.push(lineLen);
      crlfBytes += 1;
      lineStart = i + 1;
    }
  }

  // Trailing partial line (no terminating CRLF).
  if (lineStart < totalBytes) {
    nonEmptyLengths.push(totalBytes - lineStart);
  }

  return { totalBytes, crlfBytes, nonEmptyLengths };
}

function medianAscending(sortedAsc: readonly number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedAsc[mid];
  return (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

// ── Public API ──────────────────────────────────────────────────────

export interface CorruptionReport {
  isCorrupt: boolean;
  /** Why the file was (or was not) flagged. Useful for log lines. */
  reason: string;
  /** Stats computed for the decision; populated even when isCorrupt = false. */
  stats: {
    totalBytes: number;
    crlfBytes: number;
    nonEmptyLines: number;
    medianNonEmptyLen: number;
    maxNonEmptyLen: number;
    crlfByteRatio: number;
  };
}

/**
 * Inspect the raw text of a scrollback dump and decide whether it
 * matches the cols-collapse corruption signature. Pure function; no
 * I/O, no allocations beyond the per-line length list.
 *
 * The detector deliberately abstains (returns `isCorrupt: false`) when
 * the file is too small or too sparse to judge — those files might
 * just be legitimately quiet sessions.
 */
export function analyzeScrollbackContent(content: string): CorruptionReport {
  // Always scan so the returned stats reflect the actual file even when
  // we abstain. Scanning is O(n) with a single allocation list and is
  // cheap relative to the IPC round-trip that brought the payload here.
  const { totalBytes, crlfBytes, nonEmptyLengths } = scanContent(content);
  const sorted = [...nonEmptyLengths].sort((a, b) => a - b);
  const median = medianAscending(sorted);
  const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
  const crlfByteRatio = totalBytes > 0 ? crlfBytes / totalBytes : 0;
  const stats = {
    totalBytes,
    crlfBytes,
    nonEmptyLines: nonEmptyLengths.length,
    medianNonEmptyLen: median,
    maxNonEmptyLen: max,
    crlfByteRatio,
  };

  if (!content || content.length < MIN_CONTENT_BYTES_TO_JUDGE) {
    return {
      isCorrupt: false,
      reason: 'content below minimum size — abstain',
      stats,
    };
  }

  if (nonEmptyLengths.length < MIN_NONEMPTY_LINES_TO_JUDGE) {
    return {
      isCorrupt: false,
      reason: `only ${nonEmptyLengths.length} non-empty lines — abstain`,
      stats,
    };
  }

  if (median > MAX_MEDIAN_NONEMPTY_LEN_FOR_CORRUPT) {
    return {
      isCorrupt: false,
      reason: `median non-empty line length ${median} > ${MAX_MEDIAN_NONEMPTY_LEN_FOR_CORRUPT}`,
      stats,
    };
  }
  if (crlfByteRatio < MIN_CRLF_BYTE_RATIO_FOR_CORRUPT) {
    return {
      isCorrupt: false,
      reason: `CRLF byte ratio ${crlfByteRatio.toFixed(3)} < ${MIN_CRLF_BYTE_RATIO_FOR_CORRUPT}`,
      stats,
    };
  }

  return {
    isCorrupt: true,
    reason: `cols-collapse signature — median=${median}, max=${max}, crlfRatio=${crlfByteRatio.toFixed(3)}, nonEmptyLines=${nonEmptyLengths.length}`,
    stats,
  };
}

/** Convenience wrapper for callers that only need the verdict. */
export function isLikelyChoppedScrollback(content: string): boolean {
  return analyzeScrollbackContent(content).isCorrupt;
}
