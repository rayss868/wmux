import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createUISlice, type UISlice } from '../uiSlice';

// Mock browser APIs that uiSlice touches
vi.mock('../../../i18n', () => ({
  setLocale: vi.fn(),
}));

vi.mock('../../../themes', () => ({
  applyCustomCssVars: vi.fn(),
  clearCustomCssVars: vi.fn(),
  DEFAULT_CUSTOM_THEME: {},
}));

// Mock DOM and electronAPI globals
const mockDocument = { documentElement: { setAttribute: vi.fn() } };
Object.defineProperty(globalThis, 'document', { value: mockDocument, writable: true });
Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: {
      settings: {
        setToastEnabled: vi.fn(),
        setAutoUpdateEnabled: vi.fn(),
      },
    },
  },
  writable: true,
});

type TestState = UISlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createUISlice(...args),
    }))
  );
}

describe('UISlice — prefix mode', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('setPrefixMode(true) sets prefixMode to true', () => {
    store.getState().setPrefixMode(true);
    expect(store.getState().prefixMode).toBe(true);
  });

  it('setPrefixMode(false) clears prefixMode AND prefixError', () => {
    // Set up some state first
    store.getState().setPrefixMode(true);
    store.getState().setPrefixError('unknown key');
    expect(store.getState().prefixMode).toBe(true);
    expect(store.getState().prefixError).toBe('unknown key');

    // Clearing prefix mode should also clear error
    store.getState().setPrefixMode(false);
    expect(store.getState().prefixMode).toBe(false);
    expect(store.getState().prefixError).toBeNull();
  });

  it('setPrefixError sets the error message', () => {
    store.getState().setPrefixError('bad key combo');
    expect(store.getState().prefixError).toBe('bad key combo');
  });
});

describe('UISlice — pane zoom', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('togglePaneZoom sets zoomedPaneId', () => {
    expect(store.getState().zoomedPaneId).toBeNull();
    store.getState().togglePaneZoom('pane-123');
    expect(store.getState().zoomedPaneId).toBe('pane-123');
  });

  it('togglePaneZoom same ID twice returns to null', () => {
    store.getState().togglePaneZoom('pane-abc');
    expect(store.getState().zoomedPaneId).toBe('pane-abc');

    store.getState().togglePaneZoom('pane-abc');
    expect(store.getState().zoomedPaneId).toBeNull();
  });
});
