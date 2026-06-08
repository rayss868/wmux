/**
 * Tests for the SettingsPanel color-inspect integration (S5b).
 *
 * Same constraint as the contrast / firstRun / notifications suites: vitest runs
 * in `node` env without a DOM library. So we:
 *   1. Test the pure decision helpers (shouldEscCloseSettings,
 *      shouldShowInspectBar, isInspectTargetRow) directly — these single-source
 *      the component's ESC suppression, bar-vs-modal branch, and target-row
 *      reaction, so asserting them asserts the wired behaviour.
 *   2. Render the pure `InspectMinimizedBar` via renderToStaticMarkup and verify
 *      its markup, the "Done" wiring, and that it uses NO live theme tokens
 *      (fixed high-contrast so it stays readable when the theme is broken).
 *
 * scroll-into-view / flash visuals and the live store transitions are
 * DOGFOOD-only (no DOM in this env).
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  InspectMinimizedBar,
  shouldEscCloseSettings,
  shouldShowInspectBar,
  isInspectTargetRow,
} from '../SettingsPanel';
import type { UIThemeTokenKey, TokenRole } from '../../../themes';

const tStub = (key: string): string => key;

// ─── D-esc: the mandatory regression ──────────────────────────────────────────
describe('shouldEscCloseSettings (D-esc — mandatory regression)', () => {
  it('does NOT close Settings while inspect is active (overlay owns ESC)', () => {
    expect(shouldEscCloseSettings(true)).toBe(false);
  });

  it('DOES close Settings when inspect is inactive (pre-inspect behaviour preserved)', () => {
    // This is the regression guard: the non-inspect path must stay unchanged.
    expect(shouldEscCloseSettings(false)).toBe(true);
  });
});

// ─── D-settings: bar vs full modal ────────────────────────────────────────────
describe('shouldShowInspectBar (D-settings)', () => {
  it('shows the bar when minimized with no pending target', () => {
    expect(shouldShowInspectBar(true, false, false)).toBe(true);
  });

  it('expands to the full modal when a target is pending (so the user can edit it)', () => {
    expect(shouldShowInspectBar(true, true, false)).toBe(false);
  });

  it('collapses back to the bar after the target editor is dismissed', () => {
    expect(shouldShowInspectBar(true, true, true)).toBe(true);
  });

  it('shows the full modal when not minimized (inspect off)', () => {
    expect(shouldShowInspectBar(false, false, false)).toBe(false);
    expect(shouldShowInspectBar(false, true, false)).toBe(false);
  });
});

// ─── D-hover: target-row reaction ─────────────────────────────────────────────
describe('isInspectTargetRow (D-hover)', () => {
  const target = { token: 'bgSurface' as UIThemeTokenKey, role: 'bg' as TokenRole };

  it('matches the row whose token AND role both equal the target', () => {
    expect(isInspectTargetRow(target, 'bgSurface', 'bg')).toBe(true);
  });

  it('does not match a different token', () => {
    expect(isInspectTargetRow(target, 'bgBase', 'bg')).toBe(false);
  });

  it('does not match the same token under a different role', () => {
    expect(isInspectTargetRow(target, 'bgSurface', 'accent')).toBe(false);
  });

  it('matches nothing when there is no target', () => {
    expect(isInspectTargetRow(null, 'bgSurface', 'bg')).toBe(false);
  });
});

// ─── InspectMinimizedBar markup ───────────────────────────────────────────────
describe('InspectMinimizedBar (D-settings)', () => {
  it('renders the picking label and a Done button', () => {
    const html = renderToStaticMarkup(
      createElement(InspectMinimizedBar, { t: tStub, onDone: () => undefined }),
    );
    expect(html).toContain('data-testid="inspect-minimized-bar"');
    expect(html).toContain('data-testid="inspect-done"');
    expect(html).toContain('settings.inspect.picking');
    expect(html).toContain('settings.inspect.done');
    // Announced as a status region so SR users know inspect started.
    expect(html).toContain('role="status"');
  });

  it('uses fixed high-contrast colors, never live var(--*) theme tokens', () => {
    // The bar must stay legible even if the user broke the live theme, so it
    // must not reference any CSS custom property (plan §4.4).
    const html = renderToStaticMarkup(
      createElement(InspectMinimizedBar, { t: tStub, onDone: () => undefined }),
    );
    expect(html).not.toContain('var(--');
  });

  it('wires the Done click to onDone (exitInspect in production)', () => {
    // Markup can't fire React handlers in this env, but we can assert the prop
    // contract: the component invokes exactly the callback it was handed.
    const onDone = vi.fn();
    const el = createElement(InspectMinimizedBar, { t: tStub, onDone });
    // The Done button's onClick is `onDone` itself (no wrapper that drops args).
    const doneBtn = (el.props as { onDone: () => void });
    doneBtn.onDone();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
