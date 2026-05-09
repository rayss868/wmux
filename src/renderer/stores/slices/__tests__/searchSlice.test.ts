import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createSearchSlice, type SearchSlice } from '../searchSlice';
import type { PaneSearchResult, PaneSearchResponse } from '../../../../shared/types';

// Minimal store carrying only SearchSlice — mirrors paneSlice/a2aSlice test
// pattern. The `@ts-expect-error` is unavoidable because createSearchSlice's
// StateCreator is typed against the full StoreState union.
type TestState = SearchSlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createSearchSlice(...args),
    })),
  );
}

function makeResult(idx: number): PaneSearchResult {
  return {
    paneId: `pane-${idx}`,
    surfaceId: `surface-${idx}`,
    ptyId: `pty-${idx}`,
    lineIdx: idx,
    physicalBaseY: idx,
    text: `match ${idx}`,
    contextBefore: [],
    contextAfter: [],
  };
}

function makeResponse(count: number, totalMatches?: number): PaneSearchResponse {
  return {
    resultShapeVersion: 1,
    results: Array.from({ length: count }, (_, i) => makeResult(i)),
    truncated: typeof totalMatches === 'number' && totalMatches > count,
    totalMatches: totalMatches ?? count,
    workspaceId: 'ws-1',
  };
}

type BridgeFn = (query: string, regex: boolean) => Promise<unknown>;

interface MockedWindow {
  __wmuxRunPaneSearch?: BridgeFn;
}

// vitest's default `node` environment doesn't define `window`. The slice
// dereferences `window.__wmuxRunPaneSearch` so we install a stub on
// globalThis to satisfy that lookup. Each test seeds the bridge fn (or
// deletes it for the "missing bridge" case).
const g = globalThis as unknown as { window?: MockedWindow };
let bridgeMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  bridgeMock = vi.fn();
  g.window = { __wmuxRunPaneSearch: bridgeMock as unknown as BridgeFn };
});

afterEach(() => {
  delete g.window;
});

describe('searchSlice — initial state', () => {
  it('starts with empty/false defaults', () => {
    const store = createTestStore();
    const s = store.getState();
    expect(s.searchQuery).toBe('');
    expect(s.searchResults).toEqual([]);
    expect(s.searchTruncated).toBe(false);
    expect(s.searchTotalMatches).toBe(0);
    expect(s.searchPanelOpen).toBe(false);
    expect(s.searchPanelStickyClosed).toBe(false);
  });
});

describe('searchSlice — runSearch (empty query)', () => {
  it('clears all state including the sticky bit', async () => {
    const store = createTestStore();
    // Seed some pre-existing dirty state including sticky=true.
    store.setState((s) => {
      s.searchQuery = 'old';
      s.searchResults = [makeResult(0)];
      s.searchTruncated = true;
      s.searchTotalMatches = 99;
      s.searchPanelOpen = true;
      s.searchPanelStickyClosed = true;
    });

    await store.getState().runSearch('', false);

    const s = store.getState();
    expect(s.searchQuery).toBe('');
    expect(s.searchResults).toEqual([]);
    expect(s.searchTruncated).toBe(false);
    expect(s.searchTotalMatches).toBe(0);
    expect(s.searchPanelOpen).toBe(false);
    expect(s.searchPanelStickyClosed).toBe(false);
    // Bridge must NOT be invoked for empty queries.
    expect(bridgeMock).not.toHaveBeenCalled();
  });
});

describe('searchSlice — hysteresis triggers', () => {
  it('with 3 results: state populated, panel stays closed (≤5)', async () => {
    bridgeMock.mockResolvedValueOnce(makeResponse(3));
    const store = createTestStore();

    await store.getState().runSearch('foo', false);

    const s = store.getState();
    expect(s.searchQuery).toBe('foo');
    expect(s.searchResults).toHaveLength(3);
    expect(s.searchPanelOpen).toBe(false);
  });

  it('with 8 results (dead zone, was closed): panel stays closed', async () => {
    bridgeMock.mockResolvedValueOnce(makeResponse(8));
    const store = createTestStore();

    await store.getState().runSearch('foo', false);

    expect(store.getState().searchPanelOpen).toBe(false);
  });

  it('with 15 results (>10 trigger): panel opens', async () => {
    bridgeMock.mockResolvedValueOnce(makeResponse(15));
    const store = createTestStore();

    await store.getState().runSearch('foo', false);

    expect(store.getState().searchPanelOpen).toBe(true);
  });

  it('was open, results drop to 8 (dead zone): panel stays open', async () => {
    bridgeMock
      .mockResolvedValueOnce(makeResponse(15))
      .mockResolvedValueOnce(makeResponse(8));
    const store = createTestStore();

    await store.getState().runSearch('foo', false);
    expect(store.getState().searchPanelOpen).toBe(true);

    // Prefix-extend the query so this is NOT a session reset.
    await store.getState().runSearch('foob', false);
    expect(store.getState().searchPanelOpen).toBe(true);
  });

  it('was open, results drop to 3 (≤5 trigger): panel closes', async () => {
    bridgeMock
      .mockResolvedValueOnce(makeResponse(15))
      .mockResolvedValueOnce(makeResponse(3));
    const store = createTestStore();

    await store.getState().runSearch('foo', false);
    expect(store.getState().searchPanelOpen).toBe(true);

    await store.getState().runSearch('foob', false);
    expect(store.getState().searchPanelOpen).toBe(false);
  });
});

describe('searchSlice — sticky bit', () => {
  it('closeSearchPanel sets the sticky bit and blocks auto-reopen on subsequent runSearch with 15 results', async () => {
    bridgeMock
      .mockResolvedValueOnce(makeResponse(15))
      .mockResolvedValueOnce(makeResponse(15));
    const store = createTestStore();

    // 1. Trigger panel open via hysteresis.
    await store.getState().runSearch('foo', false);
    expect(store.getState().searchPanelOpen).toBe(true);

    // 2. User explicitly dismisses panel.
    store.getState().closeSearchPanel();
    expect(store.getState().searchPanelOpen).toBe(false);
    expect(store.getState().searchPanelStickyClosed).toBe(true);

    // 3. Prefix-extending query (no session reset) returns 15 results — sticky
    //    must keep panel closed.
    await store.getState().runSearch('foob', false);
    expect(store.getState().searchPanelOpen).toBe(false);
    expect(store.getState().searchPanelStickyClosed).toBe(true);
  });

  it('session reset (length delta > 2) clears sticky and panel reopens', async () => {
    bridgeMock
      .mockResolvedValueOnce(makeResponse(15))
      .mockResolvedValueOnce(makeResponse(15));
    const store = createTestStore();

    // Initial query "ab" (len 2) → open → user dismiss.
    await store.getState().runSearch('ab', false);
    store.getState().closeSearchPanel();
    expect(store.getState().searchPanelStickyClosed).toBe(true);

    // "abcde" — len delta = 3 → sessionReset = true → sticky cleared.
    await store.getState().runSearch('abcde', false);
    expect(store.getState().searchPanelStickyClosed).toBe(false);
    expect(store.getState().searchPanelOpen).toBe(true);
  });

  it('session reset (not a prefix extension) clears sticky', async () => {
    bridgeMock
      .mockResolvedValueOnce(makeResponse(15))
      .mockResolvedValueOnce(makeResponse(15));
    const store = createTestStore();

    await store.getState().runSearch('abc', false);
    store.getState().closeSearchPanel();
    expect(store.getState().searchPanelStickyClosed).toBe(true);

    // "xyz" — neither side is a prefix of the other → sessionReset = true.
    await store.getState().runSearch('xyz', false);
    expect(store.getState().searchPanelStickyClosed).toBe(false);
    expect(store.getState().searchPanelOpen).toBe(true);
  });

  it('prefix extension does NOT clear sticky (delta ≤ 2 and prefix match)', async () => {
    bridgeMock
      .mockResolvedValueOnce(makeResponse(15))
      .mockResolvedValueOnce(makeResponse(15));
    const store = createTestStore();

    await store.getState().runSearch('ab', false);
    store.getState().closeSearchPanel();
    expect(store.getState().searchPanelStickyClosed).toBe(true);

    // "abcd" — prev "ab" is a prefix, delta = 2 → NOT a session reset.
    await store.getState().runSearch('abcd', false);
    expect(store.getState().searchPanelStickyClosed).toBe(true);
    expect(store.getState().searchPanelOpen).toBe(false);
  });

  it('openSearchPanel clears the sticky bit so subsequent searches respect normal hysteresis', async () => {
    bridgeMock
      .mockResolvedValueOnce(makeResponse(15))
      .mockResolvedValueOnce(makeResponse(15));
    const store = createTestStore();

    await store.getState().runSearch('foo', false);
    store.getState().closeSearchPanel();
    expect(store.getState().searchPanelStickyClosed).toBe(true);

    // Explicit user open.
    store.getState().openSearchPanel();
    expect(store.getState().searchPanelOpen).toBe(true);
    expect(store.getState().searchPanelStickyClosed).toBe(false);

    // Prefix-extending search with 15 results — hysteresis should keep open
    // and sticky should still be false.
    await store.getState().runSearch('foob', false);
    expect(store.getState().searchPanelOpen).toBe(true);
    expect(store.getState().searchPanelStickyClosed).toBe(false);
  });
});

describe('searchSlice — clearSearch', () => {
  it('resets everything including the sticky bit', async () => {
    bridgeMock.mockResolvedValueOnce(makeResponse(15));
    const store = createTestStore();
    await store.getState().runSearch('foo', false);
    store.getState().closeSearchPanel();
    expect(store.getState().searchPanelStickyClosed).toBe(true);

    store.getState().clearSearch();

    const s = store.getState();
    expect(s.searchQuery).toBe('');
    expect(s.searchResults).toEqual([]);
    expect(s.searchTruncated).toBe(false);
    expect(s.searchTotalMatches).toBe(0);
    expect(s.searchPanelOpen).toBe(false);
    expect(s.searchPanelStickyClosed).toBe(false);
  });
});

describe('searchSlice — truncation echo', () => {
  it('propagates truncated flag and totalMatches from the bridge response', async () => {
    bridgeMock.mockResolvedValueOnce(makeResponse(200, 423));
    const store = createTestStore();

    await store.getState().runSearch('foo', false);

    const s = store.getState();
    expect(s.searchResults).toHaveLength(200);
    expect(s.searchTruncated).toBe(true);
    expect(s.searchTotalMatches).toBe(423);
    expect(s.searchPanelOpen).toBe(true); // 200 > 10
  });
});

describe('searchSlice — bridge missing', () => {
  it('runSearch bails (no state change) and logs a warn when window.__wmuxRunPaneSearch is not defined', async () => {
    // Window present but bridge not set — slice's no-op branch must trigger.
    g.window = {};
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createTestStore();

    // No throw, no state change.
    await expect(store.getState().runSearch('foo', false)).resolves.toBeUndefined();
    expect(store.getState().searchQuery).toBe('');
    expect(store.getState().searchResults).toEqual([]);
    // I7: bridge-missing condition is logged so DevTools surfaces the
    // timing edge case (without sentinel-erroring the user-visible state).
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('runSearch invoked before bridge mounted'),
    );
    warnSpy.mockRestore();
  });
});
