import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * clipboard.handler — verifies that CLIPBOARD_WRITE surfaces failures
 * (invalid type, oversize, write failure) as thrown errors so the renderer
 * can react instead of silently showing "copied" toasts.
 */

// ── Module mocks (hoisted; cannot reference outer test variables) ──────────

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const writeText = vi.fn();
  const readText = vi.fn(() => 'hello');
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  return {
    ipcMain,
    clipboard: {
      writeText,
      readText,
      readImage: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.from([]) })),
      availableFormats: vi.fn(() => [] as string[]),
    },
    app: { getPath: vi.fn(() => '/tmp') },
    // Expose registered handlers + clipboard.writeText for tests
    __handlers: handlers,
    __writeText: writeText,
  };
});

vi.mock('fs', () => ({
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import * as electron from 'electron';
import { registerClipboardHandlers } from '../handlers/clipboard.handler';
import { IPC } from '../../../shared/constants';

// Pull the test fixtures back out of the mocked module
const handlers = (electron as unknown as { __handlers: Map<string, (...a: unknown[]) => unknown> }).__handlers;
const writeText = (electron as unknown as { __writeText: ReturnType<typeof vi.fn> }).__writeText;

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn;
}

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  handlers.clear();
  writeText.mockReset();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  registerClipboardHandlers();
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CLIPBOARD_WRITE — error surfacing', () => {
  it('writes text to the clipboard on the happy path', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    await expect(handler({} as never, 'hello world')).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith('hello world');
  });

  it('throws CLIPBOARD_INVALID_TYPE on non-string input (no silent return)', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    await expect(handler({} as never, 12345 as unknown as string))
      .rejects.toThrow(/CLIPBOARD_INVALID_TYPE/);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('throws CLIPBOARD_INVALID_TYPE on undefined', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    await expect(handler({} as never, undefined as unknown as string))
      .rejects.toThrow(/CLIPBOARD_INVALID_TYPE/);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('throws CLIPBOARD_TOO_LARGE when payload exceeds 1MB', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    const huge = 'x'.repeat(1_000_001);
    await expect(handler({} as never, huge))
      .rejects.toThrow(/CLIPBOARD_TOO_LARGE/);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('accepts payloads exactly at the 1MB boundary', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    const oneMb = 'x'.repeat(1_000_000);
    await expect(handler({} as never, oneMb)).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith(oneMb);
  });

  it('throws CLIPBOARD_WRITE_FAILED when underlying clipboard.writeText throws', async () => {
    const handler = getHandler(IPC.CLIPBOARD_WRITE);
    writeText.mockImplementationOnce(() => {
      throw new Error('OpenClipboard failed: 0x800401D0');
    });
    await expect(handler({} as never, 'payload'))
      .rejects.toThrow(/CLIPBOARD_WRITE_FAILED.*OpenClipboard failed/);
  });

  it('CLIPBOARD_READ still works (sanity)', async () => {
    const handler = getHandler(IPC.CLIPBOARD_READ);
    await expect(handler({} as never)).resolves.toBe('hello');
  });
});
