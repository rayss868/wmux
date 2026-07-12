// @vitest-environment jsdom
//
// Dynamic tab-switch test for the Command Deck tab bar (Phase 1 P1a). Mounts
// the real <DeckTabs/> via react-dom/client and drives clicks, asserting the
// onSelect callback fires with the right tab and that aria-selected/data-active
// track the controlled `active` prop. Mirrors the Composer.mentions.dynamic
// harness (the packaged Electron UI can't be automated).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeckTabs } from '../DeckTabs';
import type { DeckTab } from '../../../stores/slices/deckSlice';

let container: HTMLDivElement;
let root: Root;

function mount(props: {
  active: DeckTab;
  onSelect?: (t: DeckTab) => void;
  channelsUnread?: number;
  showChannels?: boolean;
  rightSlot?: React.ReactNode;
}): void {
  act(() => {
    root.render(
      createElement(DeckTabs, {
        active: props.active,
        onSelect: props.onSelect ?? vi.fn(),
        channelsUnread: props.channelsUnread,
        ...(props.showChannels !== undefined ? { showChannels: props.showChannels } : {}),
        ...(props.rightSlot !== undefined ? { rightSlot: props.rightSlot } : {}),
        t: (k: string) => k,
      }),
    );
  });
}

const tab = (id: DeckTab): HTMLButtonElement => {
  const el = container.querySelector(`[data-deck-tab="${id}"]`) as HTMLButtonElement | null;
  if (!el) throw new Error(`tab ${id} not rendered`);
  return el;
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DeckTabs', () => {
  it('renders both tabs and marks the active one selected', () => {
    mount({ active: 'commander' });
    expect(tab('commander').getAttribute('aria-selected')).toBe('true');
    expect(tab('commander').getAttribute('data-active')).toBe('true');
    expect(tab('channels').getAttribute('aria-selected')).toBe('false');
    expect(tab('channels').getAttribute('data-active')).toBeNull();
  });

  it('fires onSelect with the clicked tab id', () => {
    const onSelect = vi.fn();
    mount({ active: 'commander', onSelect });
    act(() => {
      tab('channels').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('channels');
  });

  it('follows the controlled active prop on re-render', () => {
    mount({ active: 'commander' });
    expect(tab('commander').getAttribute('aria-selected')).toBe('true');
    mount({ active: 'channels' });
    expect(tab('channels').getAttribute('aria-selected')).toBe('true');
    expect(tab('commander').getAttribute('aria-selected')).toBe('false');
  });

  it('shows an unread badge on the Channels tab only when unread > 0', () => {
    mount({ active: 'commander', channelsUnread: 0 });
    expect(container.querySelector('[data-deck-tab-unread]')).toBeNull();
    mount({ active: 'commander', channelsUnread: 3 });
    const badge = container.querySelector('[data-deck-tab-unread]');
    expect(badge?.textContent).toContain('3');
  });

  it('hides the Channels tab (and its badge) when showChannels is false', () => {
    mount({ active: 'commander', showChannels: false, channelsUnread: 5 });
    expect(container.querySelector('[data-deck-tab="commander"]')).not.toBeNull();
    expect(container.querySelector('[data-deck-tab="channels"]')).toBeNull();
    expect(container.querySelector('[data-deck-tab-unread]')).toBeNull();
  });

  it('renders rightSlot header controls after the tabs', () => {
    mount({
      active: 'commander',
      rightSlot: createElement('button', { 'data-test-chip': 'true' }, 'chip'),
    });
    const controls = container.querySelector('[data-deck-header-controls]');
    expect(controls).not.toBeNull();
    expect(controls?.querySelector('[data-test-chip]')).not.toBeNull();
  });

  it('renders no header-controls container when rightSlot is omitted', () => {
    mount({ active: 'commander' });
    expect(container.querySelector('[data-deck-header-controls]')).toBeNull();
  });
});
