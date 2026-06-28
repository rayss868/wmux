// @vitest-environment jsdom
//
// Dynamic interaction test for the P2 roster polish. The members roster lives
// behind a useState-gated popover, so renderToStaticMarkup (ChannelMembers.test)
// can't see its contents. This mounts the REAL <ChannelMembersView/>, clicks the
// members button to open the popover, and asserts the P2 changes:
//   - agent member ids show (attribution) but the internal UI member id is hidden
//   - the workspace-level membership helper note renders

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChannelMember } from '../../../../shared/channels';
import { ChannelMembersView } from '../ChannelMembers';

function member(workspaceId: string, memberId: string): ChannelMember {
  return { workspaceId, memberId, joinedAt: 1_700_000_000_000, historyFromSeq: 0 };
}

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  act(() => {
    root.render(
      createElement(ChannelMembersView, {
        members: [member('ws-1', 'local-ui'), member('ws-2', 'lead')],
        workspaceLabel: (id: string) => id,
        selfWorkspaceId: 'ws-1',
        selfMemberId: 'local-ui',
        joinableWorkspaces: [],
        canJoin: false,
        onJoin: () => undefined,
        onLeave: () => undefined,
        t: (k: string) => k,
      }),
    );
  });
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

describe('ChannelMembersView — P2 roster (jsdom)', () => {
  it('opens the roster; shows agent ids, hides the internal UI member id, renders the membership note', () => {
    mount();
    const btn = container.querySelector('[data-channel-members-button]') as HTMLElement | null;
    if (!btn) throw new Error('members button not rendered');
    click(btn);

    const popover = container.querySelector('[data-channel-members-popover]');
    if (!popover) throw new Error('roster popover did not open');
    const text = popover.textContent ?? '';

    // Agent (non-UI) member id is shown for attribution.
    expect(text).toContain('· lead');
    // The internal UI member id is NOT a visible roster suffix (human members
    // all share it). It may remain in a title tooltip, but not as row text.
    expect(text).not.toContain('local-ui');
    // The workspace-level membership helper note renders.
    expect(container.querySelector('[data-channel-members-note]')).not.toBeNull();
  });
});
