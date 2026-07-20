// ─── Command Deck — dock tab bar (Phase 1 P1a) ───────────────────────────────
//
// Tab header at the top of the right dock: [Orchestrator] [Channels].
// `commander` (Orchestrator) is the default (the LLM-less command composer);
// Channels holds the classic list + conversation and is hideable via Settings,
// so the visible set is 1–2 tabs. Git·Review는 시안 A(2026-07-20)로 중앙 페인
// surface 탭으로 이관됐다. Warm rounded count badge: Channels = unread. Pure +
// props-driven so the tab-switch behavior is unit-testable under jsdom without
// the store-connected dock body.

import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { DeckTab } from '../../stores/slices/deckSlice';

export interface DeckTabsProps {
  active: DeckTab;
  onSelect: (tab: DeckTab) => void;
  /** Unread total across all channels — a small badge on the Channels tab so
   *  switching away from it doesn't hide new activity. Omit / 0 → no badge. */
  channelsUnread?: number;
  /** Whether the Channels tab renders at all. Default true (pure component —
   *  the store default is FALSE; the dock passes the setting through). With
   *  it hidden the strip shows the single Orchestrator tab, doubling as the
   *  deck's header. */
  showChannels?: boolean;
  /** Right-aligned header controls (model chip + collapse button). Rendered
   *  after the tabs, pinned to the trailing edge — the deck's one header row,
   *  so orchestrator settings live next to its name instead of buried in
   *  Settings. Omit → the strip is tabs-only (unchanged). */
  rightSlot?: React.ReactNode;
  /** Translator — defaults to identity so tests can omit it. */
  t?: (key: string) => string;
}

// Warm rounded count badge (Channels unread) — a solid warm fill is reserved for
// tiny count badges (DESIGN.md two-accent grammar). Tabular figures + full-round
// per the geometry rules.
const WARM_BADGE =
  'inline-flex items-center justify-center shrink-0 min-w-[16px] h-4 px-1 rounded-full text-[9px] font-semibold tabular-nums leading-none bg-[var(--accent)] text-[var(--bg-base)]';

const TABS: { id: DeckTab; labelKey: string; fallback: string }[] = [
  { id: 'commander', labelKey: 'deck.tabCommander', fallback: 'Orchestrator' },
  { id: 'channels', labelKey: 'deck.tabChannels', fallback: 'Channels' },
];

export function DeckTabs({
  active,
  onSelect,
  channelsUnread = 0,
  showChannels = true,
  rightSlot,
  t: tProp,
}: DeckTabsProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
  const tabs = TABS.filter((tab) => tab.id !== 'channels' || showChannels);
  return (
    <div
      data-deck-tabs
      role="tablist"
      aria-label={t('deck.tabsAriaLabel') || 'Command deck tabs'}
      className="flex items-stretch shrink-0 border-b border-[var(--bg-surface)]"
      style={{ borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgSurface', 'border')}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-deck-tab={tab.id}
            data-active={isActive ? 'true' : undefined}
            onClick={() => onSelect(tab.id)}
            className={`relative min-w-0 flex items-center justify-center gap-1 px-3 py-2 text-[12.5px] font-semibold transition-colors duration-150 ${FOCUS_RING} ${
              isActive
                ? 'text-[var(--text-main)] bg-[rgba(var(--bg-surface-rgb),0.5)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-sub)]'
            }`}
            {...(isActive ? tokenAttrs('textMain', 'text') : tokenAttrs('textMuted', 'text'))}
          >
            <span className="truncate">{t(tab.labelKey) || tab.fallback}</span>
            {tab.id === 'channels' && channelsUnread > 0 && (
              <span data-deck-tab-unread className={WARM_BADGE} {...tokenAttrs('accent', 'bg')}>
                {channelsUnread > 99 ? '99+' : channelsUnread}
              </span>
            )}
            {isActive && (
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent-blue)]"
                {...tokenAttrs('accentSecondary', 'bg')}
              />
            )}
          </button>
        );
      })}
      {rightSlot && (
        <div data-deck-header-controls className="flex items-center ml-auto shrink-0 pr-1.5 gap-0.5">
          {rightSlot}
        </div>
      )}
    </div>
  );
}

export default DeckTabs;
