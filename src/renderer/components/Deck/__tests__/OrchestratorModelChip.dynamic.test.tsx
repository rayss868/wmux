// @vitest-environment jsdom
//
// Dynamic test for the orchestrator model chip. Mounts the real component via
// react-dom/client against the real store (setDeckBrainModel is a pure state
// setter), drives the chip open, selects a model, and asserts the store updated
// and the popover closed. The packaged Electron UI can't be automated, so this
// jsdom harness is the verification surface (mirrors DeckTabs.dynamic).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { OrchestratorModelChip } from '../OrchestratorModelChip';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  act(() => useStore.setState({ deckBrainModel: '' }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(): void {
  act(() => root.render(createElement(OrchestratorModelChip)));
}
const chipButton = (): HTMLButtonElement =>
  container.querySelector('[data-model-chip-button]') as HTMLButtonElement;
const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('OrchestratorModelChip', () => {
  it('shows Default when no model is set', () => {
    mount();
    expect(chipButton().textContent).toContain('Default');
  });

  it('reflects a set model as its display name', () => {
    act(() => useStore.setState({ deckBrainModel: 'opus' }));
    mount();
    expect(chipButton().textContent).toContain('Opus 4.8');
  });

  it('opens the picker on click and marks the current model selected', () => {
    act(() => useStore.setState({ deckBrainModel: 'haiku' }));
    mount();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    click(chipButton());
    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const selected = listbox?.querySelector('[aria-selected="true"]');
    expect(selected?.textContent).toContain('Haiku 4.5');
  });

  it('selecting a model updates the store and closes the picker', () => {
    mount();
    click(chipButton());
    const options = Array.from(
      container.querySelectorAll('[role="option"]'),
    ) as HTMLButtonElement[];
    const sonnet = options.find((o) => o.textContent?.includes('Sonnet 5'));
    expect(sonnet).toBeTruthy();
    click(sonnet as HTMLButtonElement);
    expect(useStore.getState().deckBrainModel).toBe('sonnet');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});
