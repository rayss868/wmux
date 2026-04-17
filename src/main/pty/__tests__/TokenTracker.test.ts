import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenTracker, TokenEvent } from '../TokenTracker';

describe('TokenTracker', () => {
  let tracker: TokenTracker;
  let events: TokenEvent[];

  beforeEach(() => {
    tracker = new TokenTracker();
    events = [];
    tracker.onToken((e) => events.push(e));
  });

  // Helper: feed a complete line (appends \n)
  const feedLine = (line: string) => tracker.feed(line + '\n');

  // ── Gate behaviour ──────────────────────────────────────────────────────

  describe('gate (Claude Code detection)', () => {
    it('ignores token lines when gate is not active', () => {
      feedLine('Total cost: $1.23');
      feedLine('Total tokens: 100,000');
      expect(events).toHaveLength(0);
    });

    it('activates gate on Claude Code banner', () => {
      feedLine('╭─ Claude Code v1.2.3');
      feedLine('Total cost: $1.23');
      expect(events).toHaveLength(1);
      expect(events[0].totalCost).toBe(1.23);
    });

    it('activates gate on "claude-code" text', () => {
      feedLine('Starting claude-code session');
      feedLine('Total tokens: 50,000');
      expect(events).toHaveLength(1);
      expect(events[0].totalTokens).toBe(50000);
    });

    it('does not parse tokens on the gate line itself', () => {
      // Even if the gate line somehow contained token info, skip it
      feedLine('Claude Code — Total cost: $9.99');
      expect(events).toHaveLength(0);
      // But subsequent lines should work
      feedLine('Total cost: $9.99');
      expect(events).toHaveLength(1);
    });
  });

  // ── Cost parsing ────────────────────────────────────────────────────────

  describe('cost parsing', () => {
    beforeEach(() => feedLine('Claude Code'));

    it('parses "Total cost: $X.XX"', () => {
      feedLine('Total cost: $1.23');
      expect(events[0].totalCost).toBe(1.23);
    });

    it('parses "Cost: $X.XX"', () => {
      feedLine('Cost: $0.45');
      expect(events[0].totalCost).toBe(0.45);
    });

    it('parses cost with commas "$1,234.56"', () => {
      feedLine('Total cost: $1,234.56');
      expect(events[0].totalCost).toBe(1234.56);
    });
  });

  // ── Token parsing ──────────────────────────────────────────────────────

  describe('token parsing', () => {
    beforeEach(() => feedLine('Claude Code'));

    it('parses "Total tokens: 142,567"', () => {
      feedLine('Total tokens: 142,567');
      expect(events[0].totalTokens).toBe(142567);
    });

    it('parses "Tokens used: 42.3k"', () => {
      feedLine('Tokens used: 42.3k');
      expect(events[0].totalTokens).toBe(42300);
    });

    it('parses shorthand "500k tokens"', () => {
      feedLine('Used 500k tokens');
      expect(events[0].totalTokens).toBe(500000);
    });

    it('parses "142k tokens"', () => {
      feedLine('142k tokens');
      expect(events[0].totalTokens).toBe(142000);
    });

    it('parses plain number tokens "80000 tokens"', () => {
      feedLine('80000 tokens');
      expect(events[0].totalTokens).toBe(80000);
    });
  });

  // ── Session summary ────────────────────────────────────────────────────

  describe('session summary parsing', () => {
    beforeEach(() => feedLine('Claude Code'));

    it('parses "Session: 100k input, 50k output"', () => {
      feedLine('Session: 100k input, 50k output');
      expect(events[0].inputTokens).toBe(100000);
      expect(events[0].outputTokens).toBe(50000);
      expect(events[0].totalTokens).toBe(150000);
    });

    it('parses session with plain numbers', () => {
      feedLine('Session: 120,000 input, 30,000 output');
      expect(events[0].inputTokens).toBe(120000);
      expect(events[0].outputTokens).toBe(30000);
      expect(events[0].totalTokens).toBe(150000);
    });
  });

  // ── Accumulated values ─────────────────────────────────────────────────

  describe('getAccumulated()', () => {
    beforeEach(() => feedLine('Claude Code'));

    it('returns accumulated values', () => {
      feedLine('Total cost: $2.50');
      feedLine('Total tokens: 200,000');
      const acc = tracker.getAccumulated();
      expect(acc.totalCost).toBe(2.5);
      expect(acc.totalTokens).toBe(200000);
    });

    it('updates (not sums) on repeated values', () => {
      feedLine('Total cost: $1.00');
      feedLine('Total cost: $3.00');
      const acc = tracker.getAccumulated();
      expect(acc.totalCost).toBe(3.0);
    });

    it('returns a copy (not a reference)', () => {
      feedLine('Total cost: $1.00');
      const a = tracker.getAccumulated();
      feedLine('Total cost: $5.00');
      const b = tracker.getAccumulated();
      expect(a.totalCost).toBe(1.0);
      expect(b.totalCost).toBe(5.0);
    });
  });

  // ── Reset ──────────────────────────────────────────────────────────────

  describe('reset()', () => {
    it('clears gate, buffer, and accumulated data', () => {
      feedLine('Claude Code');
      feedLine('Total cost: $1.00');
      expect(events).toHaveLength(1);

      tracker.reset();

      // Gate should be inactive again
      feedLine('Total cost: $9.99');
      expect(events).toHaveLength(1); // no new event

      // After re-gating, should work again
      feedLine('Claude Code');
      feedLine('Total tokens: 10,000');
      expect(events).toHaveLength(2);

      // Accumulated should have been cleared
      const acc = tracker.getAccumulated();
      expect(acc.totalCost).toBeUndefined();
      expect(acc.totalTokens).toBe(10000);
    });
  });

  // ── Graceful degradation ───────────────────────────────────────────────

  describe('graceful degradation', () => {
    beforeEach(() => feedLine('Claude Code'));

    it('ignores unknown formats without errors', () => {
      expect(() => {
        feedLine('Some random output line');
        feedLine('Performance: excellent');
        feedLine('Status: complete');
      }).not.toThrow();
      expect(events).toHaveLength(0);
    });

    it('ignores empty lines', () => {
      expect(() => {
        feedLine('');
        feedLine('   ');
      }).not.toThrow();
      expect(events).toHaveLength(0);
    });
  });

  // ── ANSI escape handling ───────────────────────────────────────────────

  describe('ANSI escape handling', () => {
    beforeEach(() => feedLine('Claude Code'));

    it('parses cost through ANSI escape codes', () => {
      feedLine('\x1b[1;32mTotal cost: $4.56\x1b[0m');
      expect(events[0].totalCost).toBe(4.56);
    });

    it('parses tokens through ANSI escape codes', () => {
      feedLine('\x1b[36mTotal tokens: 99,999\x1b[0m');
      expect(events[0].totalTokens).toBe(99999);
    });

    it('parses session summary through ANSI escapes', () => {
      feedLine('\x1b[33mSession: 50k input, 25k output\x1b[0m');
      expect(events[0].inputTokens).toBe(50000);
      expect(events[0].outputTokens).toBe(25000);
    });
  });

  // ── Line buffer behaviour ──────────────────────────────────────────────

  describe('line buffer', () => {
    beforeEach(() => feedLine('Claude Code'));

    it('handles partial lines across multiple feed() calls', () => {
      tracker.feed('Total co');
      tracker.feed('st: $7.89\n');
      expect(events).toHaveLength(1);
      expect(events[0].totalCost).toBe(7.89);
    });

    it('processes multiple lines in a single feed()', () => {
      tracker.feed('Total cost: $1.00\nTotal tokens: 5,000\n');
      expect(events).toHaveLength(2);
    });
  });

  // ====================================================================
  // ── Supplementary scenarios ─────────────────────────────────────────
  // ====================================================================

  describe('multiline data with token line extraction', () => {
    beforeEach(() => feedLine('Claude Code'));

    it('extracts token line from a chunk with many non-token lines', () => {
      tracker.feed(
        'Compiling src/index.ts...\n' +
        'Build complete in 2.3s\n' +
        'Running tests...\n' +
        'Total tokens: 88,000\n' +
        'All tests passed.\n'
      );
      expect(events).toHaveLength(1);
      expect(events[0].totalTokens).toBe(88000);
    });

    it('extracts multiple token lines from a single multiline chunk', () => {
      tracker.feed(
        'Starting analysis...\n' +
        'Total cost: $2.10\n' +
        'Processing files...\n' +
        'Session: 70k input, 30k output\n' +
        'Done.\n'
      );
      expect(events).toHaveLength(2);
      expect(events[0].totalCost).toBe(2.1);
      expect(events[1].inputTokens).toBe(70000);
      expect(events[1].outputTokens).toBe(30000);
      expect(events[1].totalTokens).toBe(100000);
    });
  });

  describe('ANSI escape mixed with token lines in a single chunk', () => {
    beforeEach(() => feedLine('Claude Code'));

    it('parses token data from an ANSI-heavy multiline chunk', () => {
      tracker.feed(
        '\x1b[1;34m> Building project...\x1b[0m\n' +
        '\x1b[32mSuccess\x1b[0m\n' +
        '\x1b[1;33mTotal cost: $3.14\x1b[0m\n' +
        '\x1b[90m────────────────\x1b[0m\n' +
        '\x1b[36mSession: 200k input, 80k output\x1b[0m\n'
      );
      expect(events).toHaveLength(2);
      expect(events[0].totalCost).toBe(3.14);
      expect(events[1].inputTokens).toBe(200000);
      expect(events[1].outputTokens).toBe(80000);
    });

    it('handles OSC sequences mixed with token info', () => {
      feedLine('\x1b]0;terminal title\x07Total tokens: 12,345');
      expect(events).toHaveLength(1);
      expect(events[0].totalTokens).toBe(12345);
    });
  });

  describe('multiple token updates replace (not sum) for all fields', () => {
    beforeEach(() => feedLine('Claude Code'));

    it('totalTokens: last value wins', () => {
      feedLine('Total tokens: 100,000');
      feedLine('Total tokens: 250,000');
      feedLine('Total tokens: 180,000');
      const acc = tracker.getAccumulated();
      expect(acc.totalTokens).toBe(180000);
    });

    it('inputTokens and outputTokens: last value wins', () => {
      feedLine('Session: 50k input, 20k output');
      feedLine('Session: 90k input, 40k output');
      const acc = tracker.getAccumulated();
      expect(acc.inputTokens).toBe(90000);
      expect(acc.outputTokens).toBe(40000);
      expect(acc.totalTokens).toBe(130000);
    });

    it('mixed updates across different fields all use last-write-wins', () => {
      feedLine('Total cost: $1.00');
      feedLine('Total tokens: 10,000');
      feedLine('Total cost: $2.50');
      feedLine('Session: 60k input, 25k output');
      feedLine('Total cost: $4.00');

      const acc = tracker.getAccumulated();
      expect(acc.totalCost).toBe(4.0);
      expect(acc.inputTokens).toBe(60000);
      expect(acc.outputTokens).toBe(25000);
      // totalTokens was last set by the Session line (60k+25k=85k),
      // and the final cost line does not touch totalTokens
      expect(acc.totalTokens).toBe(85000);
    });
  });

  describe('reset() clears gate so post-reset token lines are ignored', () => {
    it('gate is inactive after reset and reactivates on new banner', () => {
      feedLine('Claude Code');
      feedLine('Total cost: $5.00');
      expect(events).toHaveLength(1);

      tracker.reset();

      // Verify gate is off: token lines should be ignored
      feedLine('Total cost: $99.00');
      feedLine('Total tokens: 999,999');
      expect(events).toHaveLength(1); // still just the original event

      // Re-activate gate
      feedLine('claude-code started');
      feedLine('Total cost: $0.50');
      expect(events).toHaveLength(2);
      expect(events[1].totalCost).toBe(0.5);

      // Accumulated was wiped, only new data present
      const acc = tracker.getAccumulated();
      expect(acc.totalCost).toBe(0.5);
      expect(acc.totalTokens).toBeUndefined();
    });
  });

  describe('buffer trimming on very long lines (>16KB)', () => {
    beforeEach(() => feedLine('Claude Code'));

    it('trims the line buffer when it exceeds MAX_BUFFER (16KB)', () => {
      // Feed a huge chunk without newlines, exceeding 16KB
      const padding = 'x'.repeat(20 * 1024); // 20KB of garbage
      tracker.feed(padding);

      // The old buffer content should have been trimmed.
      // Now feed a token line. The padding did not have \n so it is
      // still in the buffer (trimmed). Appending a newline will cause
      // the trimmed leftover to be processed as a line, which won't
      // match anything. Then feed a real token line.
      tracker.feed('\n');
      feedLine('Total tokens: 77,777');
      expect(events).toHaveLength(1);
      expect(events[0].totalTokens).toBe(77777);
    });

    it('does not lose data that fits within the 16KB tail after trimming', () => {
      // Build a payload where the token info is at the very end,
      // within the last 16KB, but the total exceeds 16KB.
      const padding = 'a'.repeat(17 * 1024);
      const tokenLine = 'Total cost: $6.28';
      // Feed padding (no newline), then newline + token line + newline
      tracker.feed(padding + '\n' + tokenLine + '\n');

      // The padding line (17KB) was buffered, exceeded MAX_BUFFER,
      // got trimmed, then split on \n. The token line should parse.
      expect(events).toHaveLength(1);
      expect(events[0].totalCost).toBe(6.28);
    });
  });
});
