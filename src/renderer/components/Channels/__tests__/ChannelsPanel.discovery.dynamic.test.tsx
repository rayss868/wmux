// @vitest-environment jsdom
//
// Dynamic interaction test for the P1 channel DISCOVERY group. A public channel
// the self workspace hasn't joined is surfaced in a collapsible "Discover" group
// with a Join button (instead of being mixed into the joined/active list).
// renderToStaticMarkup (ChannelsPanel.test.tsx) can't fire clicks or run the
// disclosure state, so this mounts the REAL <ChannelsPanelView/> via
// react-dom/client and drives the actual DOM events the user dogfoods:
// expand the group → click Join → assert the join callback fires with the right
// channel id, and the name-click previews via onSelect.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Channel } from '../../../../shared/channels';
import { ChannelsPanelView } from '../ChannelsPanel';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    companyId: 'co-1',
    name: 'general',
    visibility: 'public',
    status: 'active',
    createdAt: 1_700_000_000_000,
    createdBy: 'ws-1',
    nextSeq: 1,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

interface MountOpts {
  onJoinDiscoverable?: (id: string) => void;
  onSelect?: (id: string) => void;
}

function mount(opts: MountOpts = {}): void {
  act(() => {
    root.render(
      createElement(ChannelsPanelView, {
        channels: {
          joined: makeChannel({ id: 'joined', name: 'joined-room', visibility: 'public' }),
          pub: makeChannel({ id: 'pub', name: 'browse-me', visibility: 'public' }),
        },
        channelUnread: {},
        channelMentions: {},
        activeChannelId: null,
        company: null,
        // self ws is a member of `joined` only → `pub` is discoverable
        memberChannelIds: new Set<string>(['joined']),
        onSelect: opts.onSelect ?? (() => undefined),
        onCreate: () => true,
        onJoinDiscoverable: opts.onJoinDiscoverable ?? (() => undefined),
      }),
    );
  });
}

const q = (sel: string): HTMLElement | null => container.querySelector(sel);
function must(sel: string, what: string): HTMLElement {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`${what} not found: ${sel}`);
  return el as HTMLElement;
}
const click = (el: HTMLElement): void =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelsPanelView — discovery group (jsdom)', () => {
  it('shows a Discover group for public non-member channels, collapsed by default', () => {
    mount();
    const group = q('[data-channels-discover-group]');
    expect(group).not.toBeNull();
    // Toggle present with the count of discoverable channels (1).
    expect(q('[data-channels-discover-toggle]')?.textContent).toContain('1');
    // Collapsed by default → the item is not rendered yet.
    expect(q('[data-channels-discover-item]')).toBeNull();
    // The joined channel is NOT in the discover group.
    expect(container.querySelector('[data-channels-discover-item][data-channel-id="joined"]')).toBeNull();
  });

  it('expanding reveals the discoverable item; Join fires onJoinDiscoverable with its id', () => {
    const onJoinDiscoverable = vi.fn();
    mount({ onJoinDiscoverable });

    click(must('[data-channels-discover-toggle]', 'discover toggle')); // expand
    expect(q('[data-channels-discover-item][data-channel-id="pub"]')).not.toBeNull();
    const joinBtn = must(
      '[data-channels-discover-item][data-channel-id="pub"] [data-channels-discover-join]',
      'join button',
    );
    click(joinBtn);
    expect(onJoinDiscoverable).toHaveBeenCalledTimes(1);
    expect(onJoinDiscoverable).toHaveBeenCalledWith('pub');
  });

  it('clicking the discoverable name previews via onSelect (without joining)', () => {
    const onSelect = vi.fn();
    const onJoinDiscoverable = vi.fn();
    mount({ onSelect, onJoinDiscoverable });

    click(must('[data-channels-discover-toggle]', 'discover toggle')); // expand
    const nameBtn = must(
      '[data-channels-discover-item][data-channel-id="pub"] button',
      'name button',
    );
    click(nameBtn);
    expect(onSelect).toHaveBeenCalledWith('pub');
    expect(onJoinDiscoverable).not.toHaveBeenCalled();
  });

  it('without memberChannelIds (back-compat) renders no Discover group', () => {
    act(() => {
      root.render(
        createElement(ChannelsPanelView, {
          channels: { pub: makeChannel({ id: 'pub', name: 'browse-me' }) },
          channelUnread: {},
          channelMentions: {},
          activeChannelId: null,
          company: null,
          onSelect: () => undefined,
          onCreate: () => true,
        }),
      );
    });
    expect(q('[data-channels-discover-group]')).toBeNull();
  });
});

describe('ChannelsPanelView — create-channel modal positioning (jsdom)', () => {
  it('opens as a viewport-fixed popover (not absolute) so the dock overflow cannot clip it', () => {
    mount();
    click(must('[data-channels-new]', 'new-channel button'));
    const modal = must('[data-create-channel-modal]', 'create modal');
    // The bug: an absolutely-positioned modal was clipped by ChannelDock's
    // overflow-y-auto wrapper (right edge + Cancel/Create cut off). The fix
    // makes it `fixed` (escapes every overflow ancestor), anchored to the "+".
    expect(modal.className).toContain('fixed');
    expect(modal.className).not.toContain('absolute');
  });
});
