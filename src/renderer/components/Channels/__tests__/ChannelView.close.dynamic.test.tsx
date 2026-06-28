// @vitest-environment jsdom
//
// Dynamic test for the two distinct close affordances in the channel header:
//   - the X (data-channel-view-leave) LEAVES the channel  -> onLeave
//   - the chevron (data-channel-view-close) closes the VIEW -> onClose
// renderToStaticMarkup can't fire clicks, so mount the real view and click.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

let container: HTMLDivElement;
let root: Root;

function mount(opts: { onClose?: () => void; onLeave?: () => void }): void {
  act(() => {
    root.render(
      createElement(ChannelViewContent, {
        channel: makeChannel(),
        messages: [] as ChannelMessage[],
        viewer: null as ChannelMember | null,
        onClose: opts.onClose ?? (() => undefined),
        onLeave: opts.onLeave,
        composerSlot: createElement('div', { 'data-fake-composer': true }),
      }),
    );
  });
}

const click = (sel: string): void => {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`not found: ${sel}`);
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
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

describe('ChannelViewContent — close vs leave (jsdom)', () => {
  it('the X (leave) button calls onLeave, not onClose', () => {
    const onClose = vi.fn();
    const onLeave = vi.fn();
    mount({ onClose, onLeave });
    click('[data-channel-view-leave]');
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the close-view button calls onClose (deselect), not onLeave', () => {
    const onClose = vi.fn();
    const onLeave = vi.fn();
    mount({ onClose, onLeave });
    click('[data-channel-view-close]');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('renders no leave button when onLeave is absent (non-member preview)', () => {
    mount({ onClose: () => undefined });
    expect(container.querySelector('[data-channel-view-leave]')).toBeNull();
    expect(container.querySelector('[data-channel-view-close]')).not.toBeNull();
  });
});
