import { describe, it, expect, vi } from 'vitest';
import {
  createFlashFrameHandler,
  attachFlashFrameAutoClear,
  type FlashFrameWindow,
} from '../flashFrame';

/**
 * T6 Notification System Expansion — main-process flashFrame plumbing.
 *
 * CEO stamp A7 invariant under test: every native `flashFrame` call must
 * be gated by `BrowserWindow.isDestroyed()`, because Electron throws if
 * the window has been torn down. The same guard protects the focus
 * auto-clear path.
 */

function makeWin(overrides: Partial<FlashFrameWindow> = {}): FlashFrameWindow & {
  isDestroyed: ReturnType<typeof vi.fn>;
  flashFrame: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
} {
  return {
    isDestroyed: vi.fn(() => false),
    flashFrame: vi.fn(),
    on: vi.fn(),
    ...overrides,
  } as FlashFrameWindow & {
    isDestroyed: ReturnType<typeof vi.fn>;
    flashFrame: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
}

describe('createFlashFrameHandler', () => {
  it('forwards `on=true` to BrowserWindow.flashFrame(true)', () => {
    const win = makeWin();
    const handler = createFlashFrameHandler(() => win);
    handler(true);
    expect(win.isDestroyed).toHaveBeenCalledTimes(1);
    expect(win.flashFrame).toHaveBeenCalledTimes(1);
    expect(win.flashFrame).toHaveBeenCalledWith(true);
  });

  it('forwards `on=false` to BrowserWindow.flashFrame(false)', () => {
    const win = makeWin();
    const handler = createFlashFrameHandler(() => win);
    handler(false);
    expect(win.flashFrame).toHaveBeenCalledTimes(1);
    expect(win.flashFrame).toHaveBeenCalledWith(false);
  });

  // CEO stamp A7 — Electron throws if you call flashFrame on a destroyed
  // window. The handler must short-circuit BEFORE the native call.
  it('does NOT call flashFrame when the window is destroyed', () => {
    const win = makeWin({ isDestroyed: vi.fn(() => true) });
    const handler = createFlashFrameHandler(() => win);
    expect(() => handler(true)).not.toThrow();
    expect(win.flashFrame).not.toHaveBeenCalled();
  });

  it('does NOT call flashFrame when getWindow returns null', () => {
    // Covers the cold-boot edge case where main has registered the IPC
    // handler but createWindow() has not finished yet.
    const handler = createFlashFrameHandler(() => null);
    expect(() => handler(true)).not.toThrow();
    expect(() => handler(false)).not.toThrow();
  });

  it('coerces truthy/falsy non-boolean payloads to a clean boolean', () => {
    // Defence-in-depth — registerHandlers already coerces, but the
    // handler itself wraps Boolean() so it cannot be re-introduced by a
    // future direct caller that forgets the coercion.
    const win = makeWin();
    const handler = createFlashFrameHandler(() => win);
    handler(1 as unknown as boolean);
    handler(0 as unknown as boolean);
    handler('' as unknown as boolean);
    handler('x' as unknown as boolean);
    expect(win.flashFrame).toHaveBeenNthCalledWith(1, true);
    expect(win.flashFrame).toHaveBeenNthCalledWith(2, false);
    expect(win.flashFrame).toHaveBeenNthCalledWith(3, false);
    expect(win.flashFrame).toHaveBeenNthCalledWith(4, true);
  });
});

describe('attachFlashFrameAutoClear', () => {
  it('registers a focus listener that clears the flash', () => {
    const win = makeWin();
    attachFlashFrameAutoClear(win);

    expect(win.on).toHaveBeenCalledTimes(1);
    const [event, listener] = win.on.mock.calls[0] as [string, () => void];
    expect(event).toBe('focus');

    // Simulate the user focusing the window — flash should clear.
    listener();
    expect(win.flashFrame).toHaveBeenCalledTimes(1);
    expect(win.flashFrame).toHaveBeenCalledWith(false);
  });

  it('skips flashFrame(false) on focus when the window is destroyed', () => {
    // Real-world trigger: app shutdown races with a late `'focus'` event
    // (alt-tab back into the window the instant the user pressed quit).
    // Without the guard Electron throws.
    const win = makeWin({ isDestroyed: vi.fn(() => true) });
    attachFlashFrameAutoClear(win);
    const [, listener] = win.on.mock.calls[0] as [string, () => void];
    expect(() => listener()).not.toThrow();
    expect(win.flashFrame).not.toHaveBeenCalled();
  });
});
