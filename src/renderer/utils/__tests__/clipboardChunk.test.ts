/**
 * Tests for `pastePtyChunked` — the renderer-side guard that breaks paste
 * payloads into 4096-byte writes so they survive main's 100KB silent
 * backstop on `pty.write`.
 *
 * Pure-function tests run in vitest's default `node` environment.
 */
import { describe, it, expect, vi } from 'vitest';
import { pastePtyChunked, PTY_PASTE_CHUNK_SIZE } from '../clipboardChunk';

describe('pastePtyChunked', () => {
  it('is a no-op for empty text', () => {
    const writes: string[] = [];
    pastePtyChunked((d) => writes.push(d), '', { bracketedPasteMode: true });
    expect(writes).toEqual([]);
  });

  it('writes a single chunk for short payload without bracketed paste', () => {
    const writes: string[] = [];
    pastePtyChunked((d) => writes.push(d), 'hello world');
    expect(writes).toEqual(['hello world']);
  });

  it('wraps short payload with bracketed-paste markers as a single write (fast path)', () => {
    const writes: string[] = [];
    pastePtyChunked((d) => writes.push(d), 'hi', { bracketedPasteMode: true });
    expect(writes).toEqual(['\x1b[200~hi\x1b[201~']);
  });

  it('chunks a >4096-byte payload and skips bracketed markers when mode is off', () => {
    const writes: string[] = [];
    const text = 'a'.repeat(PTY_PASTE_CHUNK_SIZE * 3 + 17);
    pastePtyChunked((d) => writes.push(d), text);
    // 3 full chunks + tail
    expect(writes.length).toBe(4);
    expect(writes[0].length).toBe(PTY_PASTE_CHUNK_SIZE);
    expect(writes[1].length).toBe(PTY_PASTE_CHUNK_SIZE);
    expect(writes[2].length).toBe(PTY_PASTE_CHUNK_SIZE);
    expect(writes[3].length).toBe(17);
    expect(writes.join('')).toBe(text);
  });

  it('chunks a >4096-byte payload and brackets the entire stream once', () => {
    const writes: string[] = [];
    const text = 'b'.repeat(PTY_PASTE_CHUNK_SIZE * 2 + 5);
    pastePtyChunked((d) => writes.push(d), text, { bracketedPasteMode: true });
    expect(writes[0]).toBe('\x1b[200~');
    expect(writes[writes.length - 1]).toBe('\x1b[201~');
    // 2 prefix-marker + 3 data chunks + 1 suffix-marker
    expect(writes.length).toBe(5);
    const dataOnly = writes.slice(1, -1).join('');
    expect(dataOnly).toBe(text);
  });

  it('handles a 200KB payload with chunk count > 49', () => {
    const writes: string[] = [];
    const text = 'x'.repeat(200 * 1024); // 204_800
    pastePtyChunked((d) => writes.push(d), text, { bracketedPasteMode: true });
    expect(writes[0]).toBe('\x1b[200~');
    expect(writes[writes.length - 1]).toBe('\x1b[201~');
    const expectedDataChunks = Math.ceil(text.length / PTY_PASTE_CHUNK_SIZE);
    expect(writes.length).toBe(expectedDataChunks + 2);
    // No single write exceeds the chunk size — the property that protects us
    // from main's 100KB silent backstop.
    for (const w of writes.slice(1, -1)) {
      expect(w.length).toBeLessThanOrEqual(PTY_PASTE_CHUNK_SIZE);
    }
  });

  it('exact-multiple boundary: payload is N * chunk size with no remainder', () => {
    const writes: string[] = [];
    const text = 'c'.repeat(PTY_PASTE_CHUNK_SIZE * 2);
    pastePtyChunked((d) => writes.push(d), text);
    expect(writes.length).toBe(2);
    expect(writes[0].length).toBe(PTY_PASTE_CHUNK_SIZE);
    expect(writes[1].length).toBe(PTY_PASTE_CHUNK_SIZE);
  });

  it('passes through callback rejections (callback throws → throws)', () => {
    const err = new Error('write fail');
    const fn = vi.fn(() => {
      throw err;
    });
    expect(() => pastePtyChunked(fn, 'short', undefined)).toThrowError(err);
  });

  it('treats null modes the same as undefined (no bracketed paste)', () => {
    const writes: string[] = [];
    pastePtyChunked((d) => writes.push(d), 'data', null as unknown as undefined);
    expect(writes).toEqual(['data']);
  });
});
