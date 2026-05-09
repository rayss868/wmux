import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { PaneSearchResult } from '../../../shared/types';

/**
 * Cross-pane search state (T-C skeleton).
 *
 * T-C owns: query / results / truncated / totalMatches + `runSearch` /
 * `clearSearch` actions, plus declaring the panel hysteresis fields so T-E
 * can read them.
 *
 * T-F will own: writes to `searchPanelOpen` / `searchPanelStickyClosed`
 * (auto-expand at >10, auto-collapse at <=5, sticky-closed bit, session
 * resets — see decisions D8 / D9 and progress.md T-F).
 *
 * The actual search engine lives in `utils/searchEngine.ts` and is invoked
 * via the `pane.search` RPC handler in `useRpcBridge.ts`. Because that
 * engine reads xterm.js Terminal instances which only exist in the renderer,
 * `useRpcBridge` exposes a `window.__wmuxRunPaneSearch` global that the
 * action below calls directly — avoiding a pointless renderer→main→renderer
 * IPC round trip.
 */
export interface SearchSlice {
  /** Last query string that produced `searchResults`. Empty when cleared. */
  searchQuery: string;
  /** Most recent result set (capped at 200, see D5). */
  searchResults: PaneSearchResult[];
  /** True when the engine hit the 200-result budget. */
  searchTruncated: boolean;
  /**
   * Pre-cap match count, useful for the "200+ matches" UI hint. May exceed
   * `searchResults.length` when `searchTruncated` is true.
   */
  searchTotalMatches: number;
  /**
   * Auto-expanded results panel visibility. T-F flips this based on D8
   * hysteresis (open >10, close <=5). T-C only initializes/clears it.
   */
  searchPanelOpen: boolean;
  /**
   * Sticky bit set when the user explicitly dismisses the panel — prevents
   * auto-reopen until a session reset (T-F). T-C only initializes/clears it.
   */
  searchPanelStickyClosed: boolean;

  /**
   * Run the cross-pane search through the renderer-side bridge.
   * No-op (resets state) on empty query. Errors from the bridge (e.g.
   * invalid regex) are swallowed here — T-E owns user-visible error UI.
   */
  runSearch: (query: string, regex: boolean) => Promise<void>;
  /** Reset all search state, including the panel sticky bit. */
  clearSearch: () => void;
  /**
   * User explicitly closed the results panel. Sets the sticky bit so the
   * hysteresis machine in `runSearch` does not auto-reopen for this query
   * session (cleared on session reset — see D8).
   */
  closeSearchPanel: () => void;
  /**
   * User explicitly opened the panel (e.g. "Show in panel" affordance in
   * the search bar). Clears the sticky bit since this is an explicit intent
   * to keep the panel open.
   */
  openSearchPanel: () => void;
}

export const createSearchSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  SearchSlice
> = (set, get) => ({
  searchQuery: '',
  searchResults: [],
  searchTruncated: false,
  searchTotalMatches: 0,
  searchPanelOpen: false,
  searchPanelStickyClosed: false,

  runSearch: async (query, regex) => {
    // Capture prev query BEFORE the new search runs so we can compute the
    // session-reset metric below (G4). Reading via `get()` is required —
    // immer's draft inside `set` would observe the post-update value.
    const prev = get().searchQuery;

    if (!query) {
      // Empty query is treated as a clear: zero results AND fully reset
      // panel state (closed + sticky cleared). T-F (D8) — empty-query is
      // an explicit session reset, so the next non-empty query starts the
      // hysteresis machine in a clean state.
      set((state: StoreState) => {
        state.searchQuery = '';
        state.searchResults = [];
        state.searchTruncated = false;
        state.searchTotalMatches = 0;
        state.searchPanelOpen = false;
        state.searchPanelStickyClosed = false;
      });
      return;
    }

    // ─── Session-reset metric (D8 / G4) ────────────────────────────────
    // The sticky-closed bit only persists within a "search session". A
    // session resets when:
    //   - prev query is empty (we were idle), OR
    //   - the length delta is > 2 chars (likely a wholly new query, not
    //     incremental typing/backspacing), OR
    //   - neither the old nor new query is a prefix of the other (the
    //     user retyped, not extended).
    const lengthDeltaTooBig = Math.abs(query.length - prev.length) > 2;
    const notPrefixExtension =
      prev.length > 0 && !query.startsWith(prev) && !prev.startsWith(query);
    const sessionReset = !prev || lengthDeltaTooBig || notPrefixExtension;

    // The bridge global is wired up by `useRpcBridge`'s useEffect. If this
    // slice is consulted before that hook mounts (e.g. tests, SSR-ish flows)
    // we silently bail — T-E will handle the empty-result UI.
    const fn = (window as unknown as {
      __wmuxRunPaneSearch?: (q: string, r: boolean) => Promise<unknown>;
    }).__wmuxRunPaneSearch;
    if (!fn) return;

    const result = await fn(query, regex);
    if (result && typeof result === 'object' && !('error' in result)) {
      const r = result as {
        results: PaneSearchResult[];
        truncated: boolean;
        totalMatches: number;
      };
      set((state: StoreState) => {
        state.searchQuery = query;
        state.searchResults = r.results;
        state.searchTruncated = r.truncated;
        state.searchTotalMatches = r.totalMatches;

        // ─── Hysteresis state machine (D8) ─────────────────────────────
        //   - >10 results → open
        //   - ≤5 results  → close
        //   - 6-10 results (dead zone) → keep current visibility
        //   - sticky-closed bit blocks auto-open within the same session;
        //     a session reset clears it before applying the rule above.
        if (sessionReset) {
          state.searchPanelStickyClosed = false;
        }
        const wasOpen = state.searchPanelOpen;
        if (!state.searchPanelStickyClosed) {
          if (r.results.length > 10) {
            state.searchPanelOpen = true;
          } else if (r.results.length <= 5) {
            state.searchPanelOpen = false;
          } else {
            // 6-10 hysteresis dead zone — preserve current visibility.
            state.searchPanelOpen = wasOpen;
          }
        }
      });
    }
  },

  clearSearch: () =>
    set((state: StoreState) => {
      state.searchQuery = '';
      state.searchResults = [];
      state.searchTruncated = false;
      state.searchTotalMatches = 0;
      // clearSearch is a session reset by definition — drop the sticky bit
      // so the next runSearch starts in a clean hysteresis state (D8).
      state.searchPanelOpen = false;
      state.searchPanelStickyClosed = false;
    }),

  closeSearchPanel: () =>
    set((state: StoreState) => {
      state.searchPanelOpen = false;
      // Sticky until the next session reset (empty query / length jump /
      // non-prefix retype). See `runSearch` above.
      state.searchPanelStickyClosed = true;
    }),

  openSearchPanel: () =>
    set((state: StoreState) => {
      state.searchPanelOpen = true;
      // Explicit user intent to open — clear sticky so subsequent edits
      // within the dead zone don't re-close it on the user.
      state.searchPanelStickyClosed = false;
    }),
});
