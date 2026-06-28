// @vitest-environment jsdom
//
// Dynamic interaction test for the P3c in-channel message search. The search
// input is behind a header toggle (useState) and filters the list as you type,
// so renderToStaticMarkup can't exercise it. This mounts the REAL
// <ChannelViewContent/>, opens search, types a query, and asserts the list
// filters to matches (and shows a no-match state).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Channel, ChannelMember, ChannelMessage } from '../../../../shared/channels';
import { ChannelViewContent } from '../ChannelView';

function makeChannel(): Channel {
  return {
    id: 'ch-1',
    companyId: 'co-1',
    name: 'general',
    visibility: 'public',
    status: 'active',
    createdAt: 1_700_000_000_000,
    createdBy: 'ws-1',
    nextSeq: 1,
  };
}
function makeMember(): ChannelMember {
  return { workspaceId: 'ws-1', memberId: 'm-1', joinedAt: 1_700_000_000_000, historyFromSeq: 0 };
}
function makeMessage(seq: number, text: string): ChannelMessage {
  return {
    channelId: 'ch-1',
    seq,
    workspaceId: 'ws-1',
    memberId: 'm-1',
    memberName: 'Lead',
    text,
    postedAt: 1_700_000_000_000 + seq,
    deliveryStatus: 'pending',
  };
}

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  act(() => {
    root.render(
      createElement(ChannelViewContent, {
        channel: makeChannel(),
        messages: [makeMessage(1, 'alpha'), makeMessage(2, 'beta'), makeMessage(3, 'gamma beta')],
        viewer: makeMember(),
        onClose: () => undefined,
        composerSlot: createElement('div', { 'data-fake-composer': true }),
      }),
    );
  });
}

const q = (sel: string): HTMLElement | null => container.querySelector(sel);
const rows = (): number => container.querySelectorAll('[data-channel-message="true"]').length;
const click = (el: HTMLElement): void =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

// React tracks the input's value via a native setter; set through it so the
// synthetic onChange fires with the new value.
function type(input: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(input) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelViewContent — message search (jsdom)', () => {
  it('toggles the search box, filters the list to matches, and shows a no-match state', () => {
    mount();
    expect(rows()).toBe(3);
    expect(q('[data-channel-search]')).toBeNull(); // closed initially

    const toggle = q('[data-channel-search-toggle]');
    if (!toggle) throw new Error('search toggle not rendered');
    click(toggle);

    const input = q('[data-channel-search]') as HTMLInputElement | null;
    if (!input) throw new Error('search input did not open');

    // Query 'beta' matches 2 of 3 messages.
    type(input, 'beta');
    expect(rows()).toBe(2);

    // A non-matching query shows the search-empty state, not the channel-empty.
    type(input, 'zzzzz');
    expect(rows()).toBe(0);
    expect(q('[data-channel-search-empty]')).not.toBeNull();
    expect(q('[data-channel-view-empty]')).toBeNull();

    // Clearing the query restores the full list.
    type(input, '');
    expect(rows()).toBe(3);
  });

  it('closing the search toggle clears the query and restores the list', () => {
    mount();
    const toggle = q('[data-channel-search-toggle]') as HTMLElement;
    click(toggle);
    const input = q('[data-channel-search]') as HTMLInputElement;
    type(input, 'alpha');
    expect(rows()).toBe(1);

    // Toggle off → input gone, query cleared, full list back.
    click(toggle);
    expect(q('[data-channel-search]')).toBeNull();
    expect(rows()).toBe(3);
  });
});
