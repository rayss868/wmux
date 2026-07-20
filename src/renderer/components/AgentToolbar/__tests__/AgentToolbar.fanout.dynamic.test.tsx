// @vitest-environment jsdom
//
// Dynamic test for the agent toolbar's Multi Task (fan-out) button. fan-out moved back
// from the deck control bar to the toolbar (DESIGN.md Decisions Log 2026-07-20) — the
// old control-bar empty-fleet test was moved here. Mounts a real <AgentToolbar/> via
// react-dom/client and verifies that fanout-button renders and that clicking it toggles
// the FanOutDialog above the toolbar. The packaged Electron UI can't be automated, so
// this jsdom harness is the verification surface.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Stub the pty write path (only mount/toggle is verified — nothing is fired).
vi.mock('../inject', () => ({
  injectText: () => Promise.resolve(),
  quotePathsForPrompt: (paths: string[]) => paths.join(' '),
}));

import { useStore } from '../../../stores';
import AgentToolbar from '../AgentToolbar';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => useStore.setState({ toolbarPopover: null }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(): void {
  act(() => root.render(createElement(AgentToolbar)));
}

const fanoutButton = (): HTMLButtonElement =>
  container.querySelector('[data-testid="fanout-button"]') as HTMLButtonElement;

describe('AgentToolbar — fan-out', () => {
  it('renders the fan-out button even with no active workspace (spawn a fleet from zero)', () => {
    mount();
    expect(fanoutButton()).not.toBeNull();
    // The dialog starts closed.
    expect(container.querySelector('[data-testid="fanout-dialog"]')).toBeNull();
  });

  it('toggles the FanOutDialog open and closed on click', () => {
    mount();
    act(() => {
      fanoutButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="fanout-dialog"]')).not.toBeNull();
    act(() => {
      fanoutButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="fanout-dialog"]')).toBeNull();
  });
});
