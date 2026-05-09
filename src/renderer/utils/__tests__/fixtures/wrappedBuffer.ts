/**
 * Test fixtures for `searchInBuffer` (T-B).
 *
 * Provides duck-typed `SearchableBuffer` builders so tests stay decoupled
 * from xterm.js. Each row is described by `{ text, isWrapped }`; the helper
 * exposes the minimal surface the engine reads (`length`, `getLine`).
 */
import type {
  SearchableBuffer,
  SearchableBufferLine,
} from '../../searchEngine';

export interface FixtureRow {
  text: string;
  isWrapped?: boolean;
}

/**
 * Build a minimal `SearchableBuffer` from a flat array of row descriptors.
 * The returned object satisfies the engine's duck-typed interface — no xterm
 * dependency.
 */
export function makeBuffer(rows: FixtureRow[]): SearchableBuffer {
  return {
    length: rows.length,
    getLine(idx: number): SearchableBufferLine | undefined {
      const r = rows[idx];
      if (!r) return undefined;
      return {
        isWrapped: r.isWrapped ?? false,
        translateToString: () => r.text,
      };
    },
  };
}

/**
 * Build a buffer where one row index returns `undefined` (simulating the
 * defensive code path in `buildLogicalLines` for an unexpectedly missing row).
 */
export function makeBufferWithGap(
  rows: FixtureRow[],
  gapIdx: number,
): SearchableBuffer {
  return {
    length: rows.length,
    getLine(idx: number): SearchableBufferLine | undefined {
      if (idx === gapIdx) return undefined;
      const r = rows[idx];
      if (!r) return undefined;
      return {
        isWrapped: r.isWrapped ?? false,
        translateToString: () => r.text,
      };
    },
  };
}

/**
 * A 200-char logical line wrapped across 3 physical rows of 80 cols
 * (80 + 80 + 40). Row 0 is the start of the wrap chain; rows 1–2 are
 * marked `isWrapped: true`.
 */
export const WRAPPED_3ROW_LINE: FixtureRow[] = [
  { text: 'a'.repeat(80), isWrapped: false },
  { text: 'b'.repeat(80), isWrapped: true },
  { text: 'c'.repeat(40), isWrapped: true },
];
