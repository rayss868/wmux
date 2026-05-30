/**
 * Tests for the paste-pipeline helpers.
 *
 * `pastePtyChunked` is the renderer-side guard that streams paste payloads
 * to the PTY in bounded chunks with CRLF normalization, UTF-16 surrogate
 * safety, and event-loop pacing — the three properties that together
 * prevent the "front of paste disappears" / "emoji breaks" / "tail
 * truncated under load" symptoms documented in the module header.
 *
 * Pure-function tests run in vitest's default `node` environment.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  pastePtyChunked,
  chunkOnDataIfNeeded,
  normalizePasteText,
  splitSurrogateSafe,
  PTY_PASTE_CHUNK_SIZE,
  ONDATA_CHUNK_THRESHOLD,
} from '../clipboardChunk';

describe('normalizePasteText', () => {
  it('collapses \\r\\n to \\r (Windows clipboard format)', () => {
    expect(normalizePasteText('line1\r\nline2\r\nline3')).toBe('line1\rline2\rline3');
  });

  it('collapses lone \\n to \\r (POSIX source pasted via WSL/Wine clipboard)', () => {
    expect(normalizePasteText('line1\nline2\nline3')).toBe('line1\rline2\rline3');
  });

  it('leaves lone \\r unchanged', () => {
    expect(normalizePasteText('line1\rline2')).toBe('line1\rline2');
  });

  it('handles mixed line endings in a single payload', () => {
    expect(normalizePasteText('a\r\nb\nc\rd')).toBe('a\rb\rc\rd');
  });

  it('is a no-op for empty input', () => {
    expect(normalizePasteText('')).toBe('');
  });

  it('preserves non-line-ending content verbatim', () => {
    expect(normalizePasteText('hello world!@#$%^&*()')).toBe('hello world!@#$%^&*()');
  });

  // Bracketed mode: the in-body separator must be LF, not CR. A lone CR makes
  // PSReadLine misplace the cursor and inject blank space (#3939/#417).
  it('uses LF as the separator when bracketed=true (CRLF → LF)', () => {
    expect(normalizePasteText('line1\r\nline2\r\nline3', true)).toBe('line1\nline2\nline3');
  });

  it('uses LF when bracketed=true (lone \\r and mixed endings → LF)', () => {
    expect(normalizePasteText('a\r\nb\nc\rd', true)).toBe('a\nb\nc\nd');
  });

  it('defaults to CR when bracketed is omitted (non-bracketed path unchanged)', () => {
    expect(normalizePasteText('a\nb')).toBe('a\rb');
  });

  it('is a no-op for empty input regardless of bracketed flag', () => {
    expect(normalizePasteText('', true)).toBe('');
  });
});

describe('splitSurrogateSafe', () => {
  it('returns the input as a single chunk when below size', () => {
    expect(splitSurrogateSafe('abc', 10)).toEqual(['abc']);
  });

  it('splits exactly at size when there is no surrogate at the boundary', () => {
    const text = 'aaaaaaaaaa'; // 10 chars
    expect(splitSurrogateSafe(text, 4)).toEqual(['aaaa', 'aaaa', 'aa']);
  });

  it('never splits a surrogate pair (single astral codepoint U+1F600)', () => {
    // U+1F600 (😀) = high surrogate U+D83D + low surrogate U+DE00
    // Build a string where the size-N boundary lands between them.
    // 4 ASCII chars + 1 emoji = 6 code units. Slice at size=5 would split
    // the pair; the safe splitter should back off by one to size=4.
    const text = 'aaaa\u{1F600}bb';
    const out = splitSurrogateSafe(text, 5);
    // Reassembly must be lossless.
    expect(out.join('')).toBe(text);
    // No chunk should contain a lone surrogate.
    for (const chunk of out) {
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          // High surrogate — next code unit in same chunk must be a low
          // surrogate (not the end of the chunk).
          expect(i + 1).toBeLessThan(chunk.length);
          const next = chunk.charCodeAt(i + 1);
          expect(next).toBeGreaterThanOrEqual(0xdc00);
          expect(next).toBeLessThanOrEqual(0xdfff);
        }
      }
    }
  });

  it('handles many adjacent surrogate pairs across multiple chunk boundaries', () => {
    const emoji = '\u{1F600}'.repeat(10); // 20 code units
    const out = splitSurrogateSafe(emoji, 3);
    expect(out.join('')).toBe(emoji);
    for (const chunk of out) {
      // Each chunk must have even length to avoid orphan surrogates,
      // because every codepoint here is 2 code units. The safe splitter
      // backs off odd boundaries to even ones.
      expect(chunk.length % 2).toBe(0);
    }
  });
});

describe('pastePtyChunked', () => {
  it('is a no-op for empty text', async () => {
    const writes: string[] = [];
    await pastePtyChunked((d) => writes.push(d), '', { bracketedPasteMode: true });
    expect(writes).toEqual([]);
  });

  it('writes a single chunk for short payload without bracketed paste', async () => {
    const writes: string[] = [];
    await pastePtyChunked((d) => writes.push(d), 'hello world');
    expect(writes).toEqual(['hello world']);
  });

  it('normalizes CRLF before chunking (Windows clipboard → CR-only output)', async () => {
    const writes: string[] = [];
    await pastePtyChunked((d) => writes.push(d), 'line1\r\nline2\r\nline3');
    expect(writes).toEqual(['line1\rline2\rline3']);
    // Critical invariant for the non-bracketed path: no \r\n on the wire —
    // PowerShell would treat the \r as an immediate Enter mid-paste.
    for (const w of writes) {
      expect(w).not.toMatch(/\r\n/);
    }
  });

  it('normalizes lone \\n to \\r', async () => {
    const writes: string[] = [];
    await pastePtyChunked((d) => writes.push(d), 'line1\nline2');
    expect(writes).toEqual(['line1\rline2']);
  });

  it('wraps short payload with bracketed-paste markers as a single write (fast path)', async () => {
    const writes: string[] = [];
    await pastePtyChunked((d) => writes.push(d), 'hi', { bracketedPasteMode: true });
    expect(writes).toEqual(['\x1b[200~hi\x1b[201~']);
  });

  it('bracketed multiline uses LF separators inside the marker pair (#3939)', async () => {
    const writes: string[] = [];
    await pastePtyChunked((d) => writes.push(d), 'line1\r\nline2\nline3', { bracketedPasteMode: true });
    // Short payload + bracketed → single fast-path write; body uses LF, not CR,
    // so PSReadLine inserts a clean multiline command instead of executing
    // line-by-line / injecting blank space.
    expect(writes).toEqual(['\x1b[200~line1\nline2\nline3\x1b[201~']);
    expect(writes.join('')).not.toContain('line1\rline2');
  });

  it('still uses CR separators when NOT bracketed (each line is an Enter)', async () => {
    const writes: string[] = [];
    await pastePtyChunked((d) => writes.push(d), 'line1\r\nline2');
    expect(writes).toEqual(['line1\rline2']);
  });

  it('sanitizes a raw ESC in a bracketed body to U+241B (paste-injection guard)', async () => {
    const writes: string[] = [];
    // A pasted, forged close marker + trailing command must NOT survive as
    // real control bytes that escape the bracket and execute.
    await pastePtyChunked((d) => writes.push(d), 'evil\x1b[201~rm -rf /', { bracketedPasteMode: true });
    const wire = writes.join('');
    // Our own close marker is the only real ESC[201~, and it sits at the end.
    expect(wire.endsWith('\x1b[201~')).toBe(true);
    expect(wire.indexOf('\x1b[201~')).toBe(wire.length - '\x1b[201~'.length);
    // The pasted ESC became the visible symbol — no marker forgery.
    expect(wire).toContain('␛[201~rm -rf /');
  });

  it('does NOT sanitize ESC when not bracketed (raw bytes pass through)', async () => {
    const writes: string[] = [];
    await pastePtyChunked((d) => writes.push(d), 'a\x1bb');
    expect(writes).toEqual(['a\x1bb']);
  });

  it('chunks a > PTY_PASTE_CHUNK_SIZE payload without bracketed markers', async () => {
    const writes: string[] = [];
    const text = 'a'.repeat(PTY_PASTE_CHUNK_SIZE * 3 + 17);
    await pastePtyChunked((d) => writes.push(d), text);
    expect(writes.length).toBe(4);
    expect(writes[0].length).toBe(PTY_PASTE_CHUNK_SIZE);
    expect(writes[1].length).toBe(PTY_PASTE_CHUNK_SIZE);
    expect(writes[2].length).toBe(PTY_PASTE_CHUNK_SIZE);
    expect(writes[3].length).toBe(17);
    expect(writes.join('')).toBe(text);
  });

  it('chunks a > PTY_PASTE_CHUNK_SIZE payload and brackets the entire stream once', async () => {
    const writes: string[] = [];
    const text = 'b'.repeat(PTY_PASTE_CHUNK_SIZE * 2 + 5);
    await pastePtyChunked((d) => writes.push(d), text, { bracketedPasteMode: true });
    expect(writes[0]).toBe('\x1b[200~');
    expect(writes[writes.length - 1]).toBe('\x1b[201~');
    expect(writes.length).toBe(5); // 1 open + 3 data + 1 close
    const dataOnly = writes.slice(1, -1).join('');
    expect(dataOnly).toBe(text);
  });

  it('handles a 200KB payload without exceeding chunk size', async () => {
    const writes: string[] = [];
    const text = 'x'.repeat(200 * 1024);
    await pastePtyChunked((d) => writes.push(d), text, { bracketedPasteMode: true });
    expect(writes[0]).toBe('\x1b[200~');
    expect(writes[writes.length - 1]).toBe('\x1b[201~');
    for (const w of writes.slice(1, -1)) {
      expect(w.length).toBeLessThanOrEqual(PTY_PASTE_CHUNK_SIZE);
    }
    // The 100KB main-side backstop never receives a write larger than
    // PTY_PASTE_CHUNK_SIZE — this is the property that survives that guard.
    for (const w of writes) {
      expect(w.length).toBeLessThan(100_000);
    }
  });

  it('exact-multiple boundary: payload is N * chunk size with no remainder', async () => {
    const writes: string[] = [];
    const text = 'c'.repeat(PTY_PASTE_CHUNK_SIZE * 2);
    await pastePtyChunked((d) => writes.push(d), text);
    expect(writes.length).toBe(2);
    expect(writes[0].length).toBe(PTY_PASTE_CHUNK_SIZE);
    expect(writes[1].length).toBe(PTY_PASTE_CHUNK_SIZE);
  });

  it('does not split a surrogate pair at a chunk boundary', async () => {
    const writes: string[] = [];
    // Build a payload where a naive chunker would split a surrogate pair:
    // (PTY_PASTE_CHUNK_SIZE - 1) ASCII chars + 1 emoji (2 code units).
    // Naive slice(0, 4096) ends at the high surrogate; safe splitter
    // backs off to 4095 to keep the pair together.
    const ascii = 'a'.repeat(PTY_PASTE_CHUNK_SIZE - 1);
    const emoji = '\u{1F600}';
    const tail = 'bcd';
    const text = ascii + emoji + tail;
    await pastePtyChunked((d) => writes.push(d), text);
    expect(writes.join('')).toBe(text);
    // First chunk must end with the high surrogate's PAIR (both halves) or
    // before the surrogate entirely — never with a lone high surrogate.
    const first = writes[0];
    const lastCode = first.charCodeAt(first.length - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
  });

  it('passes through callback rejections', async () => {
    const err = new Error('write fail');
    const fn = vi.fn(() => {
      throw err;
    });
    await expect(
      pastePtyChunked(fn, 'short', undefined),
    ).rejects.toThrow(err);
  });

  it('treats null modes the same as undefined (no bracketed paste)', async () => {
    const writes: string[] = [];
    await pastePtyChunked((d) => writes.push(d), 'data', null as unknown as undefined);
    expect(writes).toEqual(['data']);
  });

  it('emits bracketed open/close markers atomically adjacent to body writes', async () => {
    // No yield between open marker and first data chunk, and none between
    // last data chunk and close marker — this is the invariant that
    // prevents another paste from interleaving its markers/data between
    // ours.
    const writes: Array<{ chunk: string; tick: number }> = [];
    let tick = 0;
    const realSetTimeout = global.setTimeout;
    // Monkey-patch setTimeout to bump tick whenever the chunker yields.
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      tick += 1;
      return realSetTimeout(fn, ms ?? 0);
    }) as unknown as typeof setTimeout);
    try {
      const text = 'd'.repeat(PTY_PASTE_CHUNK_SIZE * 2 + 1);
      await pastePtyChunked(
        (d) => writes.push({ chunk: d, tick }),
        text,
        { bracketedPasteMode: true },
      );
    } finally {
      vi.unstubAllGlobals();
    }
    // Open marker arrives at tick 0 (no yield before it).
    expect(writes[0].chunk).toBe('\x1b[200~');
    expect(writes[0].tick).toBe(0);
    // First data chunk also at tick 0 — adjacent to the open marker.
    expect(writes[1].tick).toBe(0);
    // Close marker arrives at the same tick as the last data chunk —
    // no yield between final body and close.
    const closeIdx = writes.length - 1;
    expect(writes[closeIdx].chunk).toBe('\x1b[201~');
    expect(writes[closeIdx].tick).toBe(writes[closeIdx - 1].tick);
  });
});

describe('chunkOnDataIfNeeded', () => {
  it('passes through normal-size onData payloads without chunking', async () => {
    const writes: string[] = [];
    await chunkOnDataIfNeeded((d) => writes.push(d), 'abc');
    expect(writes).toEqual(['abc']);
  });

  it('passes through payloads at the threshold boundary unchunked', async () => {
    const writes: string[] = [];
    const text = 'x'.repeat(ONDATA_CHUNK_THRESHOLD);
    await chunkOnDataIfNeeded((d) => writes.push(d), text);
    expect(writes).toEqual([text]);
  });

  it('chunks payloads above the threshold (bare paste from xterm onData)', async () => {
    const writes: string[] = [];
    const text = 'y'.repeat(PTY_PASTE_CHUNK_SIZE * 2 + 100);
    await chunkOnDataIfNeeded((d) => writes.push(d), text);
    for (const w of writes) {
      expect(w.length).toBeLessThanOrEqual(PTY_PASTE_CHUNK_SIZE);
    }
    expect(writes.join('')).toBe(text);
  });

  it('preserves bracketed paste markers when xterm pre-wrapped the payload', async () => {
    const writes: string[] = [];
    const body = 'z'.repeat(PTY_PASTE_CHUNK_SIZE + 50);
    const wrapped = `\x1b[200~${body}\x1b[201~`;
    await chunkOnDataIfNeeded((d) => writes.push(d), wrapped);
    // Open + close markers come back out around the chunked body.
    expect(writes[0]).toBe('\x1b[200~');
    expect(writes[writes.length - 1]).toBe('\x1b[201~');
    // Body is preserved (concatenation of the middle chunks).
    expect(writes.slice(1, -1).join('')).toBe(body);
  });
});
