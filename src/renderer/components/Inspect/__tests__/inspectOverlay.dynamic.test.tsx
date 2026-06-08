// @vitest-environment jsdom
//
// S4 — InspectOverlay DYNAMIC integration harness.
//
// Every other inspect test exercises pure logic (inspectActions),
// the store state machine (uiSlice), or the reverse-map helpers
// (tokenInspect) — none of them mount the actual overlay with its
// effects running. This file fills that gap: it mounts the real
// <InspectOverlay/> via react-dom/client createRoot so useEffect /
// useCallback / useState / rAF all execute, then drives it with real
// pointermove / click / keydown events and asserts the full
// hover → highlight → click → target → exit lifecycle against the
// genuine zustand store (no provider needed — global store).
//
// jsdom has NO layout engine, so the four coordinate/animation surfaces
// the overlay depends on are mocked at the lowest level:
//   - document.elementsFromPoint  (absent in jsdom; the hit-stack source)
//   - Element.prototype.getBoundingClientRect (returns 0s in jsdom)
//   - window.requestAnimationFrame / cancelAnimationFrame (deferred queue
//     we flush manually so rAF-deferred highlight commits run inside act())
//   - window.matchMedia (prefers-reduced-motion)
//
// PointerEvent is also absent in jsdom 26, so pointermove is dispatched as
// a MouseEvent with type:'pointermove' carrying clientX/clientY — React 19's
// synthetic onPointerMove fires from it and reads clientX/clientY (verified).
//
// What this harness CANNOT exercise (documented as SKIP in the report):
//   - real pixel geometry of the outline rects (getBoundingClientRect is
//     mocked, so left/top/width/height are fixtures, not laid-out values)
//   - canvas / WebGL terminal rendering (xterm is mocked away to a .xterm div)
//   - real browser hit-testing z-order (we feed elementsFromPoint manually)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import InspectOverlay from '../InspectOverlay';
import { useStore } from '../../../stores';
import { tokenAttrs } from '../../../themes';

// React 19 ships act() from the package root.
const act = React.act;

// React requires this flag to silence the "not wrapped in act" warning and to
// flush effects synchronously inside act().
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── rAF deferred queue ─────────────────────────────────────────────────────
// The overlay defers highlight commits to requestAnimationFrame and runs a
// continuous re-sync loop that re-schedules itself. A synchronous/immediate rAF
// would infinite-loop that tick(). So we queue callbacks and drain ONE
// generation per flush — re-scheduled callbacks land in the next queue.
let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafId = 0;

function installRaf(): void {
  window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
    const id = ++rafId;
    rafQueue.push({ id, cb });
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number): void => {
    rafQueue = rafQueue.filter((e) => e.id !== id);
  }) as typeof window.cancelAnimationFrame;
}

/** Drain the current rAF generation inside act() so state commits flush. */
function flushRaf(): void {
  const gen = rafQueue;
  rafQueue = [];
  act(() => {
    for (const { cb } of gen) cb(performance.now());
  });
}

// ─── elementsFromPoint hit-stack ────────────────────────────────────────────
// The overlay reads document.elementsFromPoint(x, y) for hit-testing. jsdom
// lacks it entirely. We back it with a mutable stack each test sets; the
// overlay then filters out its own chrome via isOverlayElement, so we PREPEND
// the live overlay chrome the browser would actually return on top.
let hitStack: Element[] = [];

function installElementsFromPoint(): void {
  (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = (
    _x: number,
    _y: number,
  ): Element[] => hitStack.slice();
}

// ─── getBoundingClientRect ──────────────────────────────────────────────────
// jsdom returns an all-zero rect. We hand back a deterministic non-zero rect so
// the chip-anchor math (Math.max(top-28,4)) and the rects array are meaningful.
function installRect(): void {
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 100,
      y: 200,
      left: 100,
      top: 200,
      right: 180,
      bottom: 240,
      width: 80,
      height: 40,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

function installMatchMedia(reduced = false): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') ? reduced : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// ─── Fixture builders ───────────────────────────────────────────────────────

/** Build a marked element via the REAL tokenAttrs emitter (not raw strings),
 *  optionally with extra attributes (e.g. data-derived, class). */
function marked(
  marks: Array<[Parameters<typeof tokenAttrs>[0], Parameters<typeof tokenAttrs>[1]]>,
  extra?: Record<string, string>,
): HTMLDivElement {
  const el = document.createElement('div');
  for (const [token, role] of marks) {
    for (const [attr, val] of Object.entries(tokenAttrs(token, role))) {
      el.setAttribute(attr, val);
    }
  }
  if (extra) for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

/** The whole fixture scene mounted under document.body for one test. */
interface Scene {
  sidebarA: HTMLDivElement;
  sidebarB: HTMLDivElement;
  card: HTMLDivElement;
  derived: HTMLDivElement;
  terminal: HTMLDivElement;
  plain: HTMLDivElement;
}

function buildScene(): Scene {
  // Two sidebar regions sharing the SAME token (bgMantle/bg) — highlight should
  // outline BOTH (regionsForToken count = 2).
  const sidebarA = marked([['bgMantle', 'bg']]);
  const sidebarB = marked([['bgMantle', 'bg']]);
  // A multi-role card: fill + text + border → click yields a 3-item menu.
  const card = marked([
    ['bgSurface', 'bg'],
    ['textMain', 'text'],
    ['danger', 'border'],
  ]);
  // A derived region (Pane body): accent border + data-derived=accentCursor.
  // Click must route to the SOURCE token (accent), never dead-end (D-revmap).
  const derived = marked([['accent', 'border']], { 'data-derived': 'accentCursor' });
  // Terminal area — xterm.js tags its host with class="xterm".
  const terminal = document.createElement('div');
  terminal.className = 'xterm';
  document.body.appendChild(terminal);
  // Unmarked region → "not customizable" hint.
  const plain = document.createElement('div');
  document.body.appendChild(plain);

  return { sidebarA, sidebarB, card, derived, terminal, plain };
}

// ─── Overlay query helpers ──────────────────────────────────────────────────

/** The root application div the overlay renders (or null when inactive). */
function overlayRoot(): HTMLElement | null {
  return document.querySelector('[role="application"][data-inspect-overlay]');
}

/** The transparent capture layer (onPointerMove / onClick live here). It is the
 *  first child of the root carrying data-inspect-overlay + absolute inset-0. */
function captureLayer(): HTMLElement {
  const root = overlayRoot();
  if (!root) throw new Error('overlay not mounted');
  const layer = root.querySelector('.absolute.inset-0[data-inspect-overlay]') as HTMLElement | null;
  if (!layer) throw new Error('capture layer not found');
  return layer;
}

/** Outline highlight nodes (each marked region gets one). They carry an inline
 *  2px cyan (#22D3EE) border; jsdom normalizes the hex to rgb(34,211,238) in the
 *  serialized inline style, so we match the normalized form. The chip/menu/banner
 *  draw a 1px border, so this uniquely selects the region outlines. */
function highlightNodes(): HTMLElement[] {
  const root = overlayRoot();
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('div[data-inspect-overlay].absolute')).filter((el) => {
    const b = el.style.border;
    return b.startsWith('2px solid') && b.replace(/\s+/g, '').includes('rgb(34,211,238)');
  });
}

/** The "Applies to N marked areas" chip text, or null when not rendered. */
function chipText(): string | null {
  const root = overlayRoot();
  if (!root) return null;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('div[data-inspect-overlay]'));
  const chip = candidates.find((el) => /Applies to \d+ marked areas/.test(el.textContent ?? ''));
  return chip ? (chip.textContent ?? '').trim() : null;
}

function roleMenu(): HTMLElement | null {
  const root = overlayRoot();
  return root ? root.querySelector<HTMLElement>('[role="menu"]') : null;
}

function menuItems(): HTMLButtonElement[] {
  const menu = roleMenu();
  return menu ? Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) : [];
}

function hintNode(): HTMLElement | null {
  const root = overlayRoot();
  return root ? root.querySelector<HTMLElement>('[role="status"]') : null;
}

// ─── Event dispatch helpers ─────────────────────────────────────────────────

function dispatchPointerMove(x: number, y: number): void {
  const layer = captureLayer();
  act(() => {
    layer.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
  });
}

function dispatchClick(x: number, y: number, target: Element = captureLayer()): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
  });
}

function dispatchKey(key: string): void {
  const root = overlayRoot();
  if (!root) throw new Error('overlay not mounted');
  act(() => {
    root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

// ─── Mount lifecycle ────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(InspectOverlay));
  });
}

function unmount(): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

/** Reset store inspect fields to a clean inactive baseline. */
function resetStore(): void {
  act(() => {
    useStore.setState({
      inspectModeActive: false,
      inspectMinimized: false,
      inspectTargetToken: null,
      inspectXtermTarget: null,
      // enterInspect mutates theme; start from a builtin so the seed path runs.
      theme: 'catppuccin-mocha',
      customThemeColors: null,
      locale: 'en',
    });
  });
}

beforeEach(() => {
  installRaf();
  installElementsFromPoint();
  installRect();
  installMatchMedia(false);
  rafQueue = [];
  hitStack = [];
  resetStore();
});

afterEach(() => {
  try {
    unmount();
  } catch {
    /* some tests unmount themselves */
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// Convenience: enter inspect through the real store action.
function enterInspect(): void {
  act(() => {
    useStore.getState().enterInspect();
  });
}

describe('InspectOverlay — dynamic mount lifecycle (S4)', () => {
  // ── Scenario 1: active/inactive render gate ─────────────────────────────
  it('1. renders nothing when inactive, then capture layer + banner on enter', () => {
    mount();
    expect(overlayRoot()).toBeNull();

    enterInspect();
    expect(useStore.getState().inspectModeActive).toBe(true);
    const r = overlayRoot();
    expect(r).not.toBeNull();
    // Capture layer present and intercepting.
    const layer = captureLayer();
    expect(layer.style.pointerEvents).toBe('auto');
    // Banner with the instruction + Done button.
    expect(r!.textContent).toContain('Click an area to edit its color');
    expect(r!.textContent).toContain('Done');
  });

  // ── Scenario 2: focus theft on entry ────────────────────────────────────
  it('2. blurs the previously-focused element and takes focus on the overlay', () => {
    // A pane textarea standing in for the active pane.
    const prior = document.createElement('textarea');
    document.body.appendChild(prior);
    prior.focus();
    expect(document.activeElement).toBe(prior);

    mount();
    enterInspect();

    // The entry effect blurs `prior` and focuses the overlay root.
    expect(document.activeElement).not.toBe(prior);
    expect(document.activeElement).toBe(overlayRoot());
  });

  // ── Scenario 3: hover → highlight every region sharing the token ────────
  it('3. hover outlines all sibling regions for the token + chip count, with cache skip', () => {
    const scene = buildScene();
    mount();
    enterInspect();

    // Cursor over sidebarA → reverse-maps to bgMantle/bg. Both sidebar regions
    // share that token, so regionsForToken = 2.
    hitStack = [scene.sidebarA];
    dispatchPointerMove(10, 10);
    flushRaf(); // the rAF-deferred syncHighlight commit.

    expect(highlightNodes()).toHaveLength(2);
    expect(chipText()).toBe('Applies to 2 marked areas');

    // Cache skip: moving again over the SAME token must not re-enqueue a
    // recompute. Snapshot rAF queue length before/after a same-token move.
    const before = rafQueue.length;
    hitStack = [scene.sidebarB]; // different element, SAME token
    dispatchPointerMove(20, 20);
    expect(rafQueue.length).toBe(before); // no new rAF scheduled (cache hit)
    // Highlight unchanged.
    expect(highlightNodes()).toHaveLength(2);
  });

  // ── Scenario 4: click a single-role region → pick immediately ───────────
  it('4. click on a single-role region commits {token, role} and stays in inspect', () => {
    const scene = buildScene();
    mount();
    enterInspect();

    hitStack = [scene.sidebarA]; // bgMantle / bg — single role
    dispatchClick(10, 10);

    expect(useStore.getState().inspectTargetToken).toEqual({ token: 'bgMantle', role: 'bg' });
    // F4 fix: pick does NOT exit inspect.
    expect(useStore.getState().inspectModeActive).toBe(true);
  });

  // ── Scenario 5: click multi-role region → menu → choose a role ──────────
  it('5. click a multi-role region opens fill/text/border menu; choosing sets that role', () => {
    const scene = buildScene();
    mount();
    enterInspect();

    hitStack = [scene.card]; // bgSurface/bg + textMain/text + danger/border
    dispatchClick(30, 30);

    const items = menuItems();
    expect(items).toHaveLength(3);
    // Stable MENU_ROLE_ORDER: bg(Fill), text(Text), border(Border).
    expect(items.map((b) => b.textContent)).toEqual(['Fill', 'Text', 'Border']);
    // No target set yet — the menu is still open.
    expect(useStore.getState().inspectTargetToken).toBeNull();

    // Choose "Text" → textMain / text.
    dispatchClick(0, 0, items[1]);
    expect(useStore.getState().inspectTargetToken).toEqual({ token: 'textMain', role: 'text' });
  });

  // ── Scenario 6: derived region routes to source token (dead-click regress) ─
  it('6. click on a derived region routes to its SOURCE token (not a dead-click)', () => {
    const scene = buildScene();
    mount();
    enterInspect();

    // accent/border + data-derived=accentCursor → source token = accent.
    hitStack = [scene.derived];
    dispatchClick(40, 40);

    // No menu — derived collapses straight to a pick on the source token.
    expect(roleMenu()).toBeNull();
    expect(useStore.getState().inspectTargetToken).toEqual({ token: 'accent', role: 'border' });
  });

  // ── Scenario 7: unmarked region → non-silent hint, no target ────────────
  it('7. click on an unmarked region shows a hint and sets no target', () => {
    const scene = buildScene();
    mount();
    enterInspect();

    hitStack = [scene.plain]; // no data-token-* anywhere in the chain
    dispatchClick(50, 50);

    const hint = hintNode();
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain('Not customizable yet');
    expect(useStore.getState().inspectTargetToken).toBeNull();
    expect(useStore.getState().inspectXtermTarget).toBeNull();
  });

  // ── Scenario 8: terminal area → bg/fg menu → choose slot ────────────────
  it('8. click on the xterm area opens bg/fg menu; choosing sets inspectXtermTarget', () => {
    const scene = buildScene();
    mount();
    enterInspect();

    hitStack = [scene.terminal]; // class="xterm"
    dispatchClick(60, 60);

    const items = menuItems();
    expect(items).toHaveLength(2);
    expect(items.map((b) => b.textContent)).toEqual(['Terminal background', 'Terminal text']);
    expect(useStore.getState().inspectXtermTarget).toBeNull(); // not chosen yet

    dispatchClick(0, 0, items[1]); // "Terminal text" → foreground
    expect(useStore.getState().inspectXtermTarget).toBe('foreground');
  });

  // ── Scenario 9: capture yield while a target is pending ─────────────────
  it('9. capture layer yields (pointer-events:none) with a target, resumes on clear', () => {
    const scene = buildScene();
    mount();
    enterInspect();

    // Establish a highlight first.
    hitStack = [scene.sidebarA];
    dispatchPointerMove(10, 10);
    flushRaf();
    expect(highlightNodes()).toHaveLength(2);

    // Commit a target → overlay must yield capture + hide hover affordances.
    act(() => {
      useStore.getState().setInspectTarget('bgMantle', 'bg');
    });
    expect(captureLayer().style.pointerEvents).toBe('none');
    expect(highlightNodes()).toHaveLength(0); // highlights suppressed
    expect(chipText()).toBeNull();
    // Banner still present so the user can always exit.
    expect(overlayRoot()!.textContent).toContain('Done');

    // Clear the target → capture resumes, hover works again.
    act(() => {
      useStore.getState().clearInspectTarget();
    });
    expect(captureLayer().style.pointerEvents).toBe('auto');

    hitStack = [scene.card];
    dispatchPointerMove(30, 30);
    flushRaf();
    // card's bg token bgSurface is used by exactly one region → 1 highlight.
    expect(highlightNodes()).toHaveLength(1);
    expect(chipText()).toBe('Applies to 1 marked areas');
  });

  // ── Scenario 10: ESC exits inspect ──────────────────────────────────────
  it('10. Escape keydown exits inspect (inspectModeActive=false)', () => {
    mount();
    enterInspect();
    expect(useStore.getState().inspectModeActive).toBe(true);

    dispatchKey('Escape');
    expect(useStore.getState().inspectModeActive).toBe(false);
    // Overlay unmounts when inactive.
    expect(overlayRoot()).toBeNull();
  });

  // ── Scenario 11: overlay self-filter in the hit-stack ───────────────────
  it('11. overlay chrome on top of the cursor is filtered; the marked region wins', () => {
    const scene = buildScene();
    mount();
    enterInspect();

    // The browser would return the overlay banner/capture layer on TOP of the
    // marked region (z-65 > app). Prepend genuine overlay chrome so the filter
    // path (isOverlayElement / firstNonOverlayElement) is actually exercised.
    const banner = overlayRoot()!.querySelector('[data-inspect-overlay]')!;
    const layer = captureLayer();
    hitStack = [layer, banner, scene.sidebarA];
    dispatchPointerMove(10, 10);
    flushRaf();

    // Despite overlay chrome being first in the stack, the bgMantle region is
    // resolved — NOT mistaken for terminal, NOT dropped to a hint.
    expect(highlightNodes()).toHaveLength(2);
    expect(chipText()).toBe('Applies to 2 marked areas');

    // Same for click: overlay chrome on top must not block the pick.
    hitStack = [layer, banner, scene.sidebarA];
    dispatchClick(10, 10);
    expect(useStore.getState().inspectTargetToken).toEqual({ token: 'bgMantle', role: 'bg' });
  });

  // ── Scenario 12: cleanup — no work after teardown, rAF loop stops ───────
  it('12. after exit, further pointer moves do nothing and the rAF loop halts', () => {
    const scene = buildScene();
    mount();
    enterInspect();

    // Prime a highlight + the continuous rAF loop.
    hitStack = [scene.sidebarA];
    dispatchPointerMove(10, 10);
    flushRaf();
    expect(highlightNodes()).toHaveLength(2);

    // Grab the capture layer reference BEFORE exit (it disappears after).
    const layer = captureLayer();

    // Exit inspect.
    act(() => {
      useStore.getState().exitInspect();
    });
    expect(overlayRoot()).toBeNull();

    // Drain whatever the teardown effect left, then assert the loop stops:
    // flushing repeatedly must NOT keep re-arming forever (the continuous loop
    // returns early once active=false). Two drains should empty the queue.
    flushRaf();
    flushRaf();
    expect(rafQueue.length).toBe(0);

    // A pointer move on the now-detached capture layer must be inert (no
    // overlay to update; no throw).
    hitStack = [scene.sidebarA];
    expect(() => {
      act(() => {
        layer.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }));
      });
    }).not.toThrow();
    expect(overlayRoot()).toBeNull();
  });
});
