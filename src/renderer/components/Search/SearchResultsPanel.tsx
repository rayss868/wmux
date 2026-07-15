import { useMemo } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { terminalRegistry } from '../../hooks/useTerminal';
import type { PaneSearchResult } from '../../../shared/types';

/**
 * Cross-pane search results panel (T-F, see decisions D8).
 *
 * Mount-gated by AppLayout on `searchPanelOpen` (I3) — when closed, this
 * component is unmounted and its zustand subscriptions don't run. The
 * hysteresis machine that flips `searchPanelOpen` lives in
 * `searchSlice.runSearch`; this component is a pure consumer.
 *
 * Layout: docked along the bottom of the viewport (16rem tall). The right
 * side is reserved for `NotificationPanel` (also `fixed right-0`), so a
 * bottom panel keeps the two from overlapping. The active terminal area
 * naturally reflows above the panel because we use `fixed bottom-0` —
 * future iterations may switch to a sibling flex-row in AppLayout if we
 * want true layout reflow.
 *
 * Scroll precision: result clicks call `xterm.scrollToLine(physicalBaseY)`
 * (I6) — the physical buffer row of the first wrapped row composing the
 * matched logical line. This lands exactly on the start of the matched
 * line even when wrap-coalescing combined multiple physical rows into one
 * logical line.
 */
export default function SearchResultsPanel() {
  const t = useT();
  const query = useStore((s) => s.searchQuery);
  const results = useStore((s) => s.searchResults);
  const truncated = useStore((s) => s.searchTruncated);
  const totalMatches = useStore((s) => s.searchTotalMatches);
  const closeSearchPanel = useStore((s) => s.closeSearchPanel);
  const setActivePane = useStore((s) => s.setActivePane);

  // Stable, sorted view: group by paneLabel/paneId so users can scan a
  // pane's hits together. We don't mutate the slice here.
  const orderedResults = useMemo(() => {
    return [...results].sort((a, b) => {
      const ka = a.paneLabel ?? a.paneId;
      const kb = b.paneLabel ?? b.paneId;
      if (ka !== kb) return ka.localeCompare(kb);
      return a.lineIdx - b.lineIdx;
    });
  }, [results]);

  // Note: open-gating is done at the AppLayout mount boundary (I3). No
  // local `if (!open) return null;` — by the time this component renders
  // the panel is open by construction.

  const onResultClick = (r: PaneSearchResult) => {
    setActivePane(r.paneId);
    // Use physicalBaseY (I6) — xterm's scrollToLine expects a physical row
    // index, not a logical (post-wrap-coalesce) line index.
    const term = terminalRegistry.get(r.ptyId);
    if (term) {
      try {
        term.scrollToLine(r.physicalBaseY);
      } catch {
        // xterm.scrollToLine may throw if the line index is out of range
        // (e.g. buffer rotated since the search ran). Swallow — the pane
        // is at least focused and the user can re-search.
      }
    }
  };

  // i18n keys T-E will provide. The i18n `t()` helper falls back to the
  // raw key string when a translation is missing, so missing keys render
  // as e.g. "search.noResults" until T-E lands — no crash.
  const matchedLineLabel = (lineIdx: number) =>
    t('search.matchedLine', { line: lineIdx });

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40 flex flex-col shadow-2xl"
      style={{
        height: '16rem',
        backgroundColor: 'var(--bg-mantle)',
        borderTop: '1px solid var(--bg-surface)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid var(--bg-surface)' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-bold text-[var(--text-main)]">
            {t('search.panelTitle')}
          </span>
          <span
            className="text-xs truncate"
            style={{ color: 'var(--text-sub)', maxWidth: '32rem' }}
            title={query}
          >
            &quot;{query}&quot;
          </span>
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
            style={{
              backgroundColor: 'var(--accent)',
              color: 'var(--bg-base)',
            }}
          >
            {truncated
              ? t('search.matchesCountTruncated')
              : t('search.matchesCount', { count: totalMatches })}
          </span>
        </div>
        <button
          onClick={closeSearchPanel}
          title={t('search.closeTooltip')}
          className="flex items-center justify-center w-6 h-6 rounded transition-colors hover:bg-[var(--bg-overlay)]"
          style={{ color: 'var(--text-sub2)' }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2 2l8 8M10 2l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {orderedResults.length === 0 ? (
          <div
            className="flex items-center justify-center h-full text-xs"
            style={{ color: 'var(--text-sub2)' }}
          >
            {t('search.noResults')}
          </div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--bg-surface)' }}>
            {orderedResults.map((r, idx) => {
              const label = r.paneLabel ?? t('search.unlabeled');
              return (
                <li
                  key={`${r.paneId}-${r.lineIdx}-${idx}`}
                  onClick={() => onResultClick(r)}
                  className="flex items-baseline gap-2 px-4 py-1.5 cursor-pointer text-xs hover:bg-[var(--bg-overlay)]"
                  style={{ color: 'var(--text-main)' }}
                >
                  <span
                    className="shrink-0 font-mono font-semibold"
                    style={{ color: 'var(--accent-blue)' }}
                  >
                    [{label}]
                  </span>
                  <span
                    className="shrink-0 font-mono"
                    style={{ color: 'var(--text-sub)' }}
                  >
                    · {matchedLineLabel(r.lineIdx)} ·
                  </span>
                  <span
                    className="font-mono truncate"
                    title={r.text}
                    style={{ color: 'var(--text-main)' }}
                  >
                    {r.text}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
