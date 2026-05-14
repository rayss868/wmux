/**
 * Tests for the renderer-side scrollback dump serializer.
 *
 * The serializer's job is to refuse the dump when the xterm buffer is in
 * a state that would persist garbled, cols-collapse-shaped content to
 * disk. Each `it()` here pins a specific eligibility branch.
 */
import { describe, it, expect } from 'vitest';
import {
  MIN_SANE_DUMP_COLS,
  serializeTerminalBuffer,
  type DumpableTerminal,
} from '../scrollbackDump';

function makeTerminal(opts: {
  cols?: number;
  rows?: number;
  elementOffsetWidth?: number;
  elementConnected?: boolean;
  elementMissing?: boolean;
  lines: string[];
  /** When supplied, treat this many trailing entries as empty padding. */
  trailingEmpty?: number;
}): DumpableTerminal {
  const {
    cols = 80,
    rows = 24,
    elementOffsetWidth = 800,
    elementConnected = true,
    elementMissing = false,
    lines,
    trailingEmpty = 0,
  } = opts;

  const fullLines = lines.concat(Array.from({ length: trailingEmpty }, () => ''));

  const buffer = {
    length: fullLines.length,
    baseY: 0,
    cursorY: fullLines.length === 0 ? 0 : fullLines.length - 1,
    getLine(idx: number) {
      const text = fullLines[idx];
      if (text === undefined) return undefined;
      return { translateToString: (_trimRight: boolean) => text };
    },
  };

  return {
    cols,
    rows,
    element: elementMissing
      ? null
      : { offsetWidth: elementOffsetWidth, isConnected: elementConnected },
    buffer: { active: buffer },
  };
}

describe('serializeTerminalBuffer', () => {
  describe('cols guard', () => {
    it('returns null when cols is below the safe threshold', () => {
      const term = makeTerminal({
        cols: 2,
        lines: ['P', 'S', ' ', 'C'],
      });
      expect(serializeTerminalBuffer(term)).toBeNull();
    });

    it('returns null at exactly cols = MIN_SANE_DUMP_COLS - 1', () => {
      const term = makeTerminal({
        cols: MIN_SANE_DUMP_COLS - 1,
        lines: ['hello', 'world'],
      });
      expect(serializeTerminalBuffer(term)).toBeNull();
    });

    it('serializes when cols meets the safe threshold', () => {
      const term = makeTerminal({
        cols: MIN_SANE_DUMP_COLS,
        lines: ['ok'],
      });
      expect(serializeTerminalBuffer(term)).toBe('ok');
    });

    it('serializes at typical 80-column terminal', () => {
      const term = makeTerminal({
        cols: 80,
        lines: ['line one', 'line two'],
      });
      expect(serializeTerminalBuffer(term)).toBe('line one\r\nline two');
    });
  });

  describe('rows guard', () => {
    it('returns null when rows <= 0', () => {
      const term = makeTerminal({
        rows: 0,
        lines: ['hello'],
      });
      expect(serializeTerminalBuffer(term)).toBeNull();
    });

    it('serializes when rows > 0', () => {
      const term = makeTerminal({
        rows: 1,
        lines: ['hello'],
      });
      expect(serializeTerminalBuffer(term)).toBe('hello');
    });
  });

  describe('visibility guard', () => {
    it('returns null when element.offsetWidth is zero', () => {
      const term = makeTerminal({
        elementOffsetWidth: 0,
        lines: ['hello'],
      });
      expect(serializeTerminalBuffer(term)).toBeNull();
    });

    it('returns null when element is no longer in the document', () => {
      const term = makeTerminal({
        elementConnected: false,
        lines: ['hello'],
      });
      expect(serializeTerminalBuffer(term)).toBeNull();
    });

    it('serializes when element is missing entirely (xterm not yet attached)', () => {
      // We treat a null element as "no visibility info, fall through to other
      // guards" so callers that race the dump against mount don't accidentally
      // skip a legitimate fresh-mount dump.
      const term = makeTerminal({
        elementMissing: true,
        lines: ['hello'],
      });
      expect(serializeTerminalBuffer(term)).toBe('hello');
    });
  });

  describe('empty-buffer guard', () => {
    it('returns null when the buffer has no content', () => {
      const term = makeTerminal({ lines: [] });
      expect(serializeTerminalBuffer(term)).toBeNull();
    });

    it('returns null when all lines are empty', () => {
      const term = makeTerminal({ lines: ['', '', ''] });
      expect(serializeTerminalBuffer(term)).toBeNull();
    });

    it('trims trailing empty lines but keeps internal blanks', () => {
      const term = makeTerminal({
        lines: ['first', '', 'third', '', ''],
      });
      expect(serializeTerminalBuffer(term)).toBe('first\r\n\r\nthird');
    });
  });

  describe('happy path', () => {
    it('joins physical rows with CRLF and only walks up to baseY+cursorY', () => {
      const buffer = {
        length: 10,
        baseY: 2,
        cursorY: 1,
        getLine(idx: number) {
          const text = ['a', 'b', 'c', 'd', 'should not appear'][idx];
          if (text === undefined) return undefined;
          return { translateToString: (_t: boolean) => text };
        },
      };
      const term: DumpableTerminal = {
        cols: 80,
        rows: 24,
        element: { offsetWidth: 800, isConnected: true },
        buffer: { active: buffer },
      };
      // lastLine = baseY + cursorY = 3, so rows 0..3 → "a","b","c","d".
      expect(serializeTerminalBuffer(term)).toBe('a\r\nb\r\nc\r\nd');
    });
  });
});
