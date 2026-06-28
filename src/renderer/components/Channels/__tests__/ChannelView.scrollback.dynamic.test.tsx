// @vitest-environment jsdom
//
// Dynamic interaction test for the P3b scrollback window. The list renders only
// the most recent SCROLLBACK_PAGE messages; clicking "load earlier" grows the
// window. renderToStaticMarkup can't fire the click or run the useState growth,
// so this mounts the REAL <ChannelViewContent/> and drives the actual click.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Channel, ChannelMember, ChannelMessage } from '../../../../shared/channels';
import { ChannelViewContent, SCROLLBACK_PAGE } from '../ChannelView';

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
function makeMessage(seq: number): ChannelMessage {
  return {
    channelId: 'ch-1',
    seq,
    workspaceId: 'ws-1',
    memberId: 'm-1',
    memberName: 'Lead',
    text: `m${seq}`,
    postedAt: 1_700_000_000_000 + seq,
    deliveryStatus: 'pending',
  };
}

let container: HTMLDivElement;
let root: Root;

function mount(count: number): void {
  const messages = Array.from({ length: count }, (_, i) => makeMessage(i + 1));
  act(() => {
    root.render(
      createElement(ChannelViewContent, {
        channel: makeChannel(),
        messages,
        viewer: makeMember(),
        onClose: () => undefined,
        composerSlot: createElement('div', { 'data-fake-composer': true }),
      }),
    );
  });
}

const rows = (): number => container.querySelectorAll('[data-channel-message="true"]').length;
const loadEarlier = (): HTMLElement | null =>
  container.querySelector('[data-channels-load-earlier]');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelViewContent — scrollback load-earlier (jsdom)', () => {
  it('windows to the recent page, then "load earlier" grows the window and disappears', () => {
    mount(SCROLLBACK_PAGE + 1);
    // Initially windowed to the most recent page; one message hidden.
    expect(rows()).toBe(SCROLLBACK_PAGE);
    const btn = loadEarlier();
    if (!btn) throw new Error('load-earlier button not rendered');

    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // After loading earlier, the whole history renders and the button is gone.
    expect(rows()).toBe(SCROLLBACK_PAGE + 1);
    expect(loadEarlier()).toBeNull();
  });
});
