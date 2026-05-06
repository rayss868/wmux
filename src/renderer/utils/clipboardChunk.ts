/**
 * Helpers for safely streaming clipboard text into the PTY.
 *
 * Background:
 * The main process enforces a 100KB silent backstop on `pty.write` to protect
 * against unbounded buffer growth. A naive single-write paste of a large blob
 * will be dropped wholesale by main, causing user-visible data loss.
 *
 * Renderer therefore splits paste payloads into 4096-byte chunks before
 * sending — well below any reasonable backstop and matching xterm's
 * historical PTY ingest patterns. When bracketed paste mode is enabled the
 * `\x1b[200~` / `\x1b[201~` markers wrap the entire stream so the foreground
 * application still sees a single paste, regardless of chunk count.
 */

/** Maximum bytes per `pty.write` call. Keeps us under the main backstop. */
export const PTY_PASTE_CHUNK_SIZE = 4096;

/** Minimal subset of xterm's `Terminal.modes` we read for paste behavior. */
export interface TerminalModesLike {
  bracketedPasteMode?: boolean;
}

/** Wire pty write callback — kept narrow to make tests trivial to set up. */
export type PtyWriteFn = (data: string) => void;

/**
 * Stream `text` into the PTY using `PTY_PASTE_CHUNK_SIZE` chunks.
 * When bracketed paste mode is active, wraps the chunked stream with the
 * standard CSI markers so the foreground app receives one logical paste.
 */
export function pastePtyChunked(
  write: PtyWriteFn,
  text: string,
  modes?: TerminalModesLike | null,
): void {
  if (!text) return;

  const bracketed = !!modes?.bracketedPasteMode;
  const size = PTY_PASTE_CHUNK_SIZE;

  // Fast path: short payload + bracketed mode → single write keeps the wire
  // traffic minimal, and matches the prior code's semantics.
  if (bracketed && text.length <= size) {
    write(`\x1b[200~${text}\x1b[201~`);
    return;
  }

  if (bracketed) write('\x1b[200~');
  for (let i = 0; i < text.length; i += size) {
    write(text.slice(i, i + size));
  }
  if (bracketed) write('\x1b[201~');
}
