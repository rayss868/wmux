// @vitest-environment jsdom
//
// Dynamic test for the Broadcast popover. Mounts the real component via
// react-dom/client and verifies that injectText is called for every terminal surface
// in the active workspace (including plain, non-agent shells), the success/failure
// count on one failure, and double-submit prevention. The packaged Electron UI can't
// be automated, so this jsdom harness is the verification surface.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Mock injectText — stub the pty write, only verify the call arguments.
const injectText = vi.fn<(ptyId: string, text: string, submit: boolean) => Promise<void>>(
  () => Promise.resolve(),
);
vi.mock('../inject', () => ({
  injectText: (ptyId: string, text: string, submit: boolean) => injectText(ptyId, text, submit),
}));

import { useStore } from '../../../stores';
import BroadcastPopover from '../BroadcastPopover';
import type { SessionData, Workspace } from '../../../../shared/types';

// Two leaf panes, 3 terminal surfaces total (one of them a plain, non-agent shell) +
// 1 browser surface (must be excluded from targets). One duplicate ptyId is merged by the Set.
function seedWorkspace(): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'root',
      type: 'split',
      direction: 'row',
      children: [
        {
          id: 'leaf-a',
          type: 'leaf',
          activeSurfaceId: 'sa1',
          surfaces: [
            { id: 'sa1', ptyId: 'pty-1', title: 'claude', shell: 'bash', cwd: '/x', surfaceType: 'terminal' },
            { id: 'sa2', ptyId: 'pty-2', title: 'shell', shell: 'bash', cwd: '/x', surfaceType: 'terminal' },
          ],
        },
        {
          id: 'leaf-b',
          type: 'leaf',
          activeSurfaceId: 'sb1',
          surfaces: [
            { id: 'sb1', ptyId: 'pty-3', title: 'shell2', shell: 'bash', cwd: '/y', surfaceType: 'terminal' },
            // Browser surface — not a target.
            { id: 'sb2', ptyId: 'pty-browser', title: 'web', shell: 'bash', cwd: '/y', surfaceType: 'browser' },
            // Duplicate ptyId — merged by the Set, counted once.
            { id: 'sb3', ptyId: 'pty-1', title: 'dup', shell: 'bash', cwd: '/y', surfaceType: 'terminal' },
          ],
        },
      ],
    },
    activePaneId: 'leaf-a',
  } as unknown as Workspace;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  injectText.mockClear();
  injectText.mockImplementation(() => Promise.resolve());
  const data: SessionData = {
    workspaces: [seedWorkspace()],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
  act(() => useStore.getState().loadSession(data));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(): void {
  act(() => root.render(createElement(BroadcastPopover, { onClose: vi.fn() })));
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const type = (value: string): void => {
  const ta = q('[data-testid="broadcast-input"]') as HTMLTextAreaElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const clickSend = (): void => {
  act(() => {
    q('[data-testid="broadcast-send"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('BroadcastPopover', () => {
  it('shows the deduped terminal target count (browser excluded)', () => {
    mount();
    // pty-1, pty-2, pty-3 → 3 (pty-1 dedup-merged, browser excluded).
    expect(q('[data-testid="broadcast-targets"]')?.textContent).toContain('3');
  });

  it('injects into every terminal ptyId (incl. plain shells) once on send', async () => {
    mount();
    type('hello fleet');
    clickSend();
    await act(async () => { await Promise.resolve(); });
    const ptyIds = injectText.mock.calls.map((c) => c[0]).sort();
    expect(ptyIds).toEqual(['pty-1', 'pty-2', 'pty-3']);
    for (const call of injectText.mock.calls) {
      expect(call[1]).toBe('hello fleet');
      expect(call[2]).toBe(true);
    }
  });

  it('reports success/failure counts when one injection rejects', async () => {
    injectText.mockImplementation((ptyId: string) =>
      ptyId === 'pty-2' ? Promise.reject(new Error('boom')) : Promise.resolve(),
    );
    mount();
    type('go');
    clickSend();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const result = q('[data-testid="broadcast-result"]')?.textContent ?? '';
    expect(result).toContain('2'); // ok
    expect(result).toContain('1'); // fail
  });

  it('prevents a double submit (second synchronous click is a no-op)', async () => {
    mount();
    type('once');
    clickSend();
    clickSend();
    await act(async () => { await Promise.resolve(); });
    // 3 targets × 1 send — not 6.
    expect(injectText).toHaveBeenCalledTimes(3);
  });
});
