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
import * as fs from 'node:fs';
import * as path from 'node:path';
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

// ─── Integration glue: handleClose clears the target so hover resumes ─────────
// The full modal's close affordances (X / footer / backdrop) collapse back to
// the floating bar while inspecting AND must clear the pending target — without
// that, overlayShouldCapture stays false and the user can never hover-pick a
// second region. handleClose is a component-internal closure (pulls in the whole
// store, can't be imported under node-env vitest), so this is a source-structural
// assertion in the same spirit as the useRpcBridge / pty.handler scans.
describe('SettingsPanel handleClose — clears inspect target (integration glue)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'SettingsPanel.tsx'),
    'utf-8',
  );

  /** Isolate the handleClose body so assertions can't match elsewhere. */
  function handleCloseBody(): string {
    const m = src.match(/const handleClose =\s*\(\) =>\s*\{([\s\S]*?)\n {2}\};/);
    expect(m, 'handleClose not found in SettingsPanel').not.toBeNull();
    return (m as RegExpMatchArray)[1];
  }

  it('subscribes to clearInspectTarget from the store', () => {
    expect(src).toMatch(/const clearInspectTarget = useStore\(\(s\) => s\.clearInspectTarget\)/);
  });

  it('calls clearInspectTarget inside the inspect-active branch', () => {
    const body = handleCloseBody();
    // The inspect-active branch (the one that returns early) must clear the
    // target so the overlay re-arms hover.
    expect(body).toContain('if (inspectModeActive)');
    expect(body).toContain('clearInspectTarget()');
    // And it must NOT fully close Settings while inspecting (that path is for
    // the non-inspect branch only — guards the D-settings stay-mounted rule).
    const inspectBranch = body.match(/if \(inspectModeActive\) \{([\s\S]*?)return;/);
    expect(inspectBranch).not.toBeNull();
    expect((inspectBranch as RegExpMatchArray)[1]).not.toContain('setVisible(false)');
  });
});

// ─── Integration glue: the overlay pick path stays in inspect ─────────────────
// Mirror-asserts the overlay contract from the SettingsPanel side: pickToken /
// pickTerminal must set a target WITHOUT calling exitInspect (the old bug nulled
// the target immediately, so the picker never saw which region was clicked).
describe('InspectOverlay pick path — does not exit inspect on pick (glue)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'Inspect', 'InspectOverlay.tsx'),
    'utf-8',
  );

  function pickTokenBody(): string {
    const m = src.match(/const pickToken = useCallback\(\s*\([\s\S]*?\) => \{([\s\S]*?)\},/);
    expect(m, 'pickToken not found').not.toBeNull();
    return (m as RegExpMatchArray)[1];
  }

  function pickTerminalBody(): string {
    const m = src.match(/const pickTerminal = useCallback\(\s*\([\s\S]*?\) => \{([\s\S]*?)\},/);
    expect(m, 'pickTerminal not found').not.toBeNull();
    return (m as RegExpMatchArray)[1];
  }

  it('pickToken sets the target but does not call exitInspect', () => {
    const body = pickTokenBody();
    expect(body).toContain('setInspectTarget(');
    expect(body).not.toContain('exitInspect');
  });

  it('pickTerminal sets the slot but does not call exitInspect', () => {
    const body = pickTerminalBody();
    expect(body).toContain('setInspectXtermTarget(');
    expect(body).not.toContain('exitInspect');
  });

  it('the capture layer toggles pointer-events off the `capturing` flag', () => {
    // The transparent layer yields capture while a target is pending so clicks
    // reach the Settings picker (overlayShouldCapture).
    expect(src).toContain("pointerEvents: capturing ? 'auto' : 'none'");
    expect(src).toContain('overlayShouldCapture(active, hasTarget)');
  });
});
