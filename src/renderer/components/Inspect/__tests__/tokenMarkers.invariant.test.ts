import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  UI_THEME_TOKENS,
  DERIVED_TO_SOURCE,
  type UIThemeTokenKey,
} from '../../../themes';

/**
 * CI invariant for the color inspect-mode markers (plan §6 "CI invariants").
 *
 * The `data-token-<role>` attributes emitted by `tokenAttrs(token, role)` are the
 * single source of truth for the element→token reverse map (D-revmap). tsc
 * already constrains the token name to UIThemeTokenKey at every call site, but a
 * type-level guard can't catch two product-level regressions:
 *
 *   1. an editable token quietly losing its last marker (so a click on the
 *      region it paints dead-ends with a "not customizable" hint), and
 *   2. a `data-derived="…"` value drifting away from the DERIVED_TO_SOURCE keys
 *      (so the overlay can't route the derived region to an editable source).
 *
 * This is a source-structural scan — the marked components pull in the whole
 * store/React tree and can't be imported under the node-env vitest, the same
 * reason the pty.handler / useRpcBridge suites scan source. It fails fast if a
 * refactor drops a marker or introduces an out-of-vocabulary token/derived name.
 */

// The 8 chrome components carrying static tokenAttrs markers (F3), plus the
// SettingsPanel whose TokenRow marks all 10 editable tokens dynamically.
const COMPONENT_FILES = [
  'components/Sidebar/Sidebar.tsx',
  'components/Sidebar/MiniSidebar.tsx',
  'components/StatusBar/StatusBar.tsx',
  'components/Pane/Pane.tsx',
  'components/Pane/SurfaceTabs.tsx',
  'components/Palette/CommandPalette.tsx',
  'components/FileTree/FileTreePanel.tsx',
  'components/Notification/NotificationPanel.tsx',
] as const;

const RENDERER_ROOT = path.join(__dirname, '..', '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(RENDERER_ROOT, rel), 'utf-8');
}

/** Every `tokenAttrs('<token>', '<role>')` literal call across the given source. */
function extractMarkers(src: string): { token: string; role: string }[] {
  const out: { token: string; role: string }[] = [];
  const re = /tokenAttrs\(\s*'([a-zA-Z0-9]+)'\s*,\s*'(bg|text|border|accent)'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({ token: m[1], role: m[2] });
  }
  return out;
}

/** Every `data-derived="<value>"` literal across the given source. */
function extractDerived(src: string): string[] {
  const out: string[] = [];
  const re = /data-derived="([a-zA-Z0-9]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

const VALID_TOKENS = new Set<string>(Object.keys(UI_THEME_TOKENS['catppuccin-mocha']));
const VALID_DERIVED = new Set<string>(Object.keys(DERIVED_TO_SOURCE));

describe('inspect token markers — CI invariant (plan §6)', () => {
  it('there are exactly 11 editable UI token keys', () => {
    // Guards the whole suite: if the token set changes, the per-token coverage
    // assertion below must be revisited (it asserts each is marked).
    // accentSecondary was split from accent (--accent-blue) — defaults to the
    // same value per theme, so it's editable but visually inert by default.
    expect(VALID_TOKENS.size).toBe(11);
    expect([...VALID_TOKENS].sort()).toEqual(
      [
        'accent', 'accentSecondary', 'bgBase', 'bgMantle', 'bgSurface', 'danger',
        'success', 'textMain', 'textMuted', 'textSub', 'warning',
      ].sort(),
    );
  });

  it('every tokenAttrs marker in the 8 chrome components names a valid token', () => {
    for (const rel of COMPONENT_FILES) {
      const markers = extractMarkers(read(rel));
      // Each marked file must actually carry at least one marker (catches a
      // file being dropped from the inspect surface entirely).
      expect(markers.length, `${rel} carries no tokenAttrs markers`).toBeGreaterThan(0);
      for (const { token, role } of markers) {
        expect(
          VALID_TOKENS.has(token),
          `${rel}: data-token-${role}="${token}" is not one of the 10 editable tokens`,
        ).toBe(true);
      }
    }
  });

  it('every data-derived value names a valid derived key', () => {
    // Derived regions route to their editable source; an unknown value would
    // dead-end findTokenForElement's derivedNote lookup.
    for (const rel of COMPONENT_FILES) {
      for (const d of extractDerived(read(rel))) {
        expect(
          VALID_DERIVED.has(d),
          `${rel}: data-derived="${d}" is not a DERIVED_TO_SOURCE key`,
        ).toBe(true);
      }
    }
  });

  it('all 10 editable tokens are marked in at least one place', () => {
    // SettingsPanel marks every editable token via TOKEN_INSPECT_ROLE (its
    // TokenRow spreads tokenAttrs(key, role) for all 10), so the union of the
    // chrome markers plus that map must cover the full token set. We read the
    // map from source to keep this honest even if a key is removed from it.
    const marked = new Set<string>();
    for (const rel of COMPONENT_FILES) {
      for (const { token } of extractMarkers(read(rel))) marked.add(token);
    }
    // Fold in the SettingsPanel TOKEN_INSPECT_ROLE keys (the dynamic markers).
    const settings = read('components/Settings/SettingsPanel.tsx');
    const mapBlock = settings.match(
      /const TOKEN_INSPECT_ROLE:[\s\S]*?=\s*\{([\s\S]*?)\};/,
    );
    expect(mapBlock, 'TOKEN_INSPECT_ROLE map not found in SettingsPanel').not.toBeNull();
    const keyRe = /([a-zA-Z0-9]+)\s*:\s*'(bg|text|border|accent)'/g;
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec((mapBlock as RegExpMatchArray)[1])) !== null) {
      marked.add(km[1]);
    }

    const missing = [...VALID_TOKENS].filter((tok) => !marked.has(tok));
    expect(missing, `editable tokens with no marker: ${missing.join(', ')}`).toEqual([]);
  });

  it('SettingsPanel TOKEN_INSPECT_ROLE covers all 10 tokens on its own (DRY SoT)', () => {
    // Independent of the chrome markers: the Settings editor must be able to
    // route every editable token back to its own row, so the map is exhaustive.
    const settings = read('components/Settings/SettingsPanel.tsx');
    const mapBlock = settings.match(
      /const TOKEN_INSPECT_ROLE:[\s\S]*?=\s*\{([\s\S]*?)\};/,
    );
    expect(mapBlock).not.toBeNull();
    const keys = new Set<string>();
    const keyRe = /([a-zA-Z0-9]+)\s*:\s*'(bg|text|border|accent)'/g;
    let km: RegExpExecArray | null;
    while ((km = keyRe.exec((mapBlock as RegExpMatchArray)[1])) !== null) keys.add(km[1]);
    expect([...keys].sort()).toEqual([...VALID_TOKENS].sort() as UIThemeTokenKey[]);
  });
});
