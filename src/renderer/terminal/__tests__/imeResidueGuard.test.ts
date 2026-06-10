import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  attachImeResidueGuard,
  IME_RESIDUE_CLEAR_DELAY_MS,
  type ImeResidueGuardTextarea,
  type ImeResidueGuardTerminal,
} from '../imeResidueGuard';

const DELAY = IME_RESIDUE_CLEAR_DELAY_MS;

class FakeTextarea implements ImeResidueGuardTextarea {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const l of this.listeners.get(type) ?? []) l();
  }
  listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

function makeTerminal(textarea: FakeTextarea | undefined): {
  terminal: ImeResidueGuardTerminal;
  emitData: (data: string) => void;
  dataHandlerCount: () => number;
} {
  const handlers = new Set<(data: string) => void>();
  return {
    terminal: {
      textarea,
      onData(handler: (data: string) => void) {
        handlers.add(handler);
        return { dispose: () => handlers.delete(handler) };
      },
    },
    emitData: (data: string) => {
      for (const h of handlers) h(data);
    },
    dataHandlerCount: () => handlers.size,
  };
}

describe('attachImeResidueGuard', () => {
  let ta: FakeTextarea;

  beforeEach(() => {
    vi.useFakeTimers();
    ta = new FakeTextarea();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears IME residue after the terminal goes idle (onData trigger)', () => {
    const { terminal, emitData } = makeTerminal(ta);
    attachImeResidueGuard(terminal);

    // IME-committed text was sent to the PTY but lingers in the textarea.
    ta.value = 'abc';
    emitData('abc');

    vi.advanceTimersByTime(DELAY - 1);
    expect(ta.value).toBe('abc');
    vi.advanceTimersByTime(1);
    expect(ta.value).toBe('');
  });

  it('clears residue after compositionend + idle delay', () => {
    const { terminal } = makeTerminal(ta);
    attachImeResidueGuard(terminal);

    ta.fire('compositionstart');
    ta.value = '한글';
    ta.fire('compositionend');

    vi.advanceTimersByTime(DELAY);
    expect(ta.value).toBe('');
  });

  it('never clears while a composition is active', () => {
    const { terminal, emitData } = makeTerminal(ta);
    attachImeResidueGuard(terminal);

    ta.value = 'abc';
    emitData('abc'); // pending clear armed
    ta.fire('compositionstart'); // new composition cancels it
    ta.value = 'abc한';

    // Even far past the delay, an active composition must not be touched —
    // CompositionHelper reads textarea.value to finalize it.
    vi.advanceTimersByTime(DELAY * 10);
    expect(ta.value).toBe('abc한');
  });

  it('keydown re-arms a pending clear (cannot fire inside the 229 diff window)', () => {
    const { terminal, emitData } = makeTerminal(ta);
    attachImeResidueGuard(terminal);

    ta.value = 'abc';
    emitData('abc'); // clear due at t=DELAY

    vi.advanceTimersByTime(DELAY - 10);
    ta.fire('keydown'); // e.g. keyCode 229 — xterm will diff value at setTimeout(0)

    // The old deadline passes without a clear…
    vi.advanceTimersByTime(10);
    expect(ta.value).toBe('abc');
    // …and the re-armed timer fires a full delay after the keydown.
    vi.advanceTimersByTime(DELAY - 10);
    expect(ta.value).toBe('');
  });

  it('skips the clear while the textarea holds a selection (right-click copy)', () => {
    const { terminal, emitData } = makeTerminal(ta);
    attachImeResidueGuard(terminal);

    ta.value = 'selected text';
    ta.selectionStart = 0;
    ta.selectionEnd = ta.value.length;
    emitData('x');

    vi.advanceTimersByTime(DELAY);
    expect(ta.value).toBe('selected text');
  });

  it('is a no-op when the textarea is already empty', () => {
    const { terminal, emitData } = makeTerminal(ta);
    attachImeResidueGuard(terminal);

    emitData('a');
    vi.advanceTimersByTime(DELAY);
    expect(ta.value).toBe('');
  });

  it('dispose removes all listeners and cancels the pending timer', () => {
    const { terminal, emitData, dataHandlerCount } = makeTerminal(ta);
    const guard = attachImeResidueGuard(terminal);

    ta.value = 'abc';
    emitData('abc');
    guard.dispose();

    vi.advanceTimersByTime(DELAY * 2);
    expect(ta.value).toBe('abc'); // pending clear was cancelled
    expect(ta.listenerCount()).toBe(0);
    expect(dataHandlerCount()).toBe(0);
  });

  it('tolerates a terminal without a textarea', () => {
    const { terminal } = makeTerminal(undefined);
    const guard = attachImeResidueGuard(terminal);
    expect(() => guard.dispose()).not.toThrow();
  });
});
