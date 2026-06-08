// @vitest-environment jsdom
//
// S4 — InspectOverlay pure decision logic. Covers the click-disambiguation
// contract (single role vs. multi-role menu vs. derived→source routing vs.
// terminal slot vs. "not customizable" hint), terminal-area detection, the
// multi-role menu builder, and the overlay self-filter used during hit-testing.
// Coordinate/rAF/focus paths can't run in jsdom and are flagged for dogfood in
// the task report.
import { describe, it, expect } from 'vitest';
import {
  resolveClickAction,
  roleMenuOptions,
  isTerminalElement,
  isOverlayElement,
  firstNonOverlayElement,
  overlayShouldCapture,
} from '../inspectActions';
import type { ResolvedRegion, UIThemeTokenKey, TokenRole } from '../../../themes';

/** Build a minimal ResolvedRegion for the decision functions (el is unused by
 *  resolveClickAction so a bare div suffices). */
function region(
  tokens: Partial<Record<TokenRole, UIThemeTokenKey>>,
  representative: { role: TokenRole; token: UIThemeTokenKey },
  derivedNote?: UIThemeTokenKey,
): ResolvedRegion {
  return { el: document.createElement('div'), tokens, representative, derivedNote };
}

describe('roleMenuOptions — multi-role menu builder', () => {
  it('returns one option per marked role in fixed bg→accent→text→border order', () => {
    const opts = roleMenuOptions({
      text: 'textMain',
      border: 'danger',
      bg: 'bgSurface',
      accent: 'accent',
    });
    expect(opts.map((o) => o.role)).toEqual(['bg', 'accent', 'text', 'border']);
    expect(opts.map((o) => o.token)).toEqual(['bgSurface', 'accent', 'textMain', 'danger']);
  });

  it('maps each role to its i18n label key', () => {
    const opts = roleMenuOptions({ bg: 'bgSurface', text: 'textMain', border: 'danger', accent: 'accent' });
    const byRole = Object.fromEntries(opts.map((o) => [o.role, o.labelKey]));
    expect(byRole).toEqual({
      bg: 'settings.inspect.menuFill',
      accent: 'settings.inspect.menuAccent',
      text: 'settings.inspect.menuText',
      border: 'settings.inspect.menuBorder',
    });
  });

  it('includes only roles that are actually marked', () => {
    expect(roleMenuOptions({ bg: 'bgSurface' }).map((o) => o.role)).toEqual(['bg']);
    expect(roleMenuOptions({}).map((o) => o.role)).toEqual([]);
  });
});

describe('resolveClickAction — click decision (D-hover / D-terminal / D-revmap)', () => {
  it('routes a terminal-area hit to the bg/fg slot menu regardless of markers', () => {
    expect(resolveClickAction(null, true)).toEqual({ kind: 'terminal' });
    // Even a marked terminal wrapper routes to the terminal slot, not its token.
    const marked = region({ bg: 'bgBase' }, { role: 'bg', token: 'bgBase' });
    expect(resolveClickAction(marked, true)).toEqual({ kind: 'terminal' });
  });

  it('emits a non-silent hint when nothing editable is under a non-terminal click', () => {
    expect(resolveClickAction(null, false)).toEqual({ kind: 'hint' });
  });

  it('picks a single role directly (no menu)', () => {
    const single = region({ accent: 'accent' }, { role: 'accent', token: 'accent' });
    expect(resolveClickAction(single, false)).toEqual({ kind: 'pick', token: 'accent', role: 'accent' });
  });

  it('opens a menu for a multi-role element', () => {
    const multi = region(
      { bg: 'bgSurface', text: 'textMain' },
      { role: 'bg', token: 'bgSurface' },
    );
    const action = resolveClickAction(multi, false);
    expect(action.kind).toBe('menu');
    if (action.kind === 'menu') {
      expect(action.options.map((o) => o.role)).toEqual(['bg', 'text']);
    }
  });

  it('routes a derived region to its editable SOURCE token, not the menu', () => {
    // A derived overlay region marks bg=bgSurface but data-derived=bgOverlay →
    // findTokenForElement set derivedNote=bgSurface. Even with multiple roles the
    // action must be a direct pick of the source token (no dead-end / no menu).
    const derived = region(
      { bg: 'bgSurface', text: 'textMain' },
      { role: 'bg', token: 'bgSurface' },
      'bgSurface',
    );
    expect(resolveClickAction(derived, false)).toEqual({
      kind: 'pick',
      token: 'bgSurface',
      role: 'bg',
    });
  });
});

describe('isTerminalElement — xterm-area detection', () => {
  it('detects the .xterm element itself', () => {
    const xt = document.createElement('div');
    xt.className = 'xterm';
    expect(isTerminalElement([xt])).toBe(true);
  });

  it('detects a descendant of an .xterm container via closest()', () => {
    const xt = document.createElement('div');
    xt.className = 'xterm';
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    xt.appendChild(screen);
    document.body.appendChild(xt);
    expect(isTerminalElement([screen])).toBe(true);
    document.body.removeChild(xt);
  });

  it('returns false for a hit-stack with no terminal element', () => {
    const a = document.createElement('div');
    const b = document.createElement('span');
    expect(isTerminalElement([a, b])).toBe(false);
  });
});

describe('isOverlayElement / firstNonOverlayElement — hit-test self-filter', () => {
  it('treats the overlay root and its descendants as overlay chrome', () => {
    const root = document.createElement('div');
    const child = document.createElement('div');
    root.appendChild(child);
    expect(isOverlayElement(root, root)).toBe(true);
    expect(isOverlayElement(child, root)).toBe(true);
  });

  it('treats any [data-inspect-overlay] subtree as overlay chrome even off-root', () => {
    const chip = document.createElement('div');
    chip.setAttribute('data-inspect-overlay', '');
    const inner = document.createElement('span');
    chip.appendChild(inner);
    document.body.appendChild(chip);
    expect(isOverlayElement(inner, null)).toBe(true);
    document.body.removeChild(chip);
  });

  it('does not treat a plain production element as overlay chrome', () => {
    const root = document.createElement('div');
    const other = document.createElement('section');
    expect(isOverlayElement(other, root)).toBe(false);
  });

  it('picks the first non-overlay element from a hit stack', () => {
    const root = document.createElement('div');
    const chip = document.createElement('div');
    root.appendChild(chip);
    const real = document.createElement('article');
    expect(firstNonOverlayElement([chip, real], root)).toBe(real);
  });

  it('returns null when every hit is overlay chrome', () => {
    const root = document.createElement('div');
    const chip = document.createElement('div');
    root.appendChild(chip);
    expect(firstNonOverlayElement([root, chip], root)).toBeNull();
  });
});

describe('overlayShouldCapture — integration glue (yield while editing a target)', () => {
  it('captures while inspecting with no pending target (hover/click active)', () => {
    expect(overlayShouldCapture(true, false)).toBe(true);
  });

  it('yields capture once a target is pending so clicks reach the Settings picker', () => {
    // This is the P0 fix: with a target set the Settings modal re-expands at
    // z-50; the z-65 overlay must let pointer events fall through to its swatch.
    expect(overlayShouldCapture(true, true)).toBe(false);
  });

  it('never captures when inspect is inactive (overlay is unmounted anyway)', () => {
    expect(overlayShouldCapture(false, false)).toBe(false);
    expect(overlayShouldCapture(false, true)).toBe(false);
  });
});
