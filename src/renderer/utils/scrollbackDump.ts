/**
 * Renderer-side serializer for the periodic scrollback dump.
 *
 * Why this lives in its own module
 * --------------------------------
 * `AppLayout.tsx` calls this from the 5-second autosave loop and from the
 * `beforeunload` handler. Both paths must be eligibility-guarded against
 * the "hidden-container fit() reflowed cols to ~2" failure mode, where a
 * dump captured during the reflow window persists a column of single
 * characters to disk and overwrites the previous good file (which then
 * gets restored verbatim on the next launch, breaking the user's visible
 * scrollback). Putting the guard here keeps the dump call site small
 * and lets us unit-test the eligibility logic without spinning up a
 * React tree.
 *
 * The function is duck-typed against the xterm.js `Terminal` surface so
 * tests can pass plain object fixtures.
 */

/**
 * Minimum column count required to consider the current buffer state
 * safe to persist. See `corruption.ts` for the on-disk signature this
 * threshold protects against; 12 is comfortably below the narrowest
 * realistic pane width but well above the values produced by a
 * collapsed-container fit().
 */
export const MIN_SANE_DUMP_COLS = 12;

/** Minimal `Buffer.line` surface our serializer reads. */
export interface DumpableBufferLine {
  /** xterm strips trailing spaces when `trimRight` is true. */
  translateToString(trimRight: boolean): string;
}

/** Minimal `Buffer` surface our serializer reads. */
export interface DumpableBuffer {
  /** Number of physical rows (scrollback + viewport). */
  length: number;
  /** Index of the first viewport row inside `length`. */
  baseY: number;
  /** Cursor's row offset within the viewport. */
  cursorY: number;
  /** Returns the line at the given physical row index, or undefined. */
  getLine(idx: number): DumpableBufferLine | undefined;
}

/** Minimal DOM surface we inspect for the visibility guard. */
export interface DumpableElement {
  offsetWidth: number;
  isConnected: boolean;
}

/** Minimal xterm.js `Terminal` surface we depend on. */
export interface DumpableTerminal {
  cols: number;
  rows: number;
  element: DumpableElement | undefined | null;
  buffer: { active: DumpableBuffer };
}

/**
 * Serialize an xterm terminal buffer to plain text for persistence.
 *
 * Eligibility:
 *   - Returns `null` when `cols < MIN_SANE_DUMP_COLS` or `rows <= 0`
 *     (the cols-collapse smoking gun).
 *   - Returns `null` when xterm's mounted element has zero width or is
 *     no longer attached to the document (display:none, layout
 *     teardown, minimize) — same reflow-corruption window.
 *   - Returns `null` for a fully empty buffer (nothing useful to persist
 *     and the empty string would currently overwrite a non-empty `.bak`
 *     on disk in the next rotation cycle).
 *
 * Callers that already use `if (!content) continue;` get the correct
 * "skip this surface, keep the previous on-disk file" behaviour for
 * free.
 *
 * Only iterates `0..baseY+cursorY` so empty viewport padding past the
 * cursor is excluded from the dump.
 */
export function serializeTerminalBuffer(terminal: DumpableTerminal): string | null {
  const { cols, rows, element } = terminal;

  if (cols < MIN_SANE_DUMP_COLS || rows <= 0) return null;

  if (element && (element.offsetWidth === 0 || !element.isConnected)) return null;

  const buffer = terminal.buffer.active;
  const lastLine = buffer.baseY + buffer.cursorY;
  const lines: string[] = [];
  for (let i = 0; i <= lastLine && i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) return null;
  return lines.join('\r\n');
}
