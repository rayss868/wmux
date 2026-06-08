// S4 — InspectOverlay pure decision logic.
//
// These functions hold every branch the overlay takes on a hover/click that can
// be exercised in jsdom without coordinates, rAF, canvas, or focus. Keeping them
// here (rather than inline in InspectOverlay.tsx) means the click-disambiguation
// contract — single role vs. multi-role menu vs. derived-source routing vs.
// terminal slot vs. "not customizable" hint — is unit-tested in isolation, while
// the overlay file only wires DOM events to these decisions (D-test).

import type { ResolvedRegion, UIThemeTokenKey, TokenRole } from '../../themes';

/** Menu label key for each editable role, surfaced when an element marks 2+
 *  roles and the user must disambiguate which slot the click targets (D-hover). */
export type RoleLabelKey =
  | 'settings.inspect.menuFill'
  | 'settings.inspect.menuText'
  | 'settings.inspect.menuBorder'
  | 'settings.inspect.menuAccent';

const ROLE_LABEL_KEY: Record<TokenRole, RoleLabelKey> = {
  bg: 'settings.inspect.menuFill',
  text: 'settings.inspect.menuText',
  border: 'settings.inspect.menuBorder',
  accent: 'settings.inspect.menuAccent',
};

/** Stable order the disambiguation menu lists roles in. Mirrors the hover
 *  representative priority (bg first) so the menu top item matches the preview. */
const MENU_ROLE_ORDER: readonly TokenRole[] = ['bg', 'accent', 'text', 'border'];

/** One selectable entry in the multi-role disambiguation menu. */
export interface RoleOption {
  role: TokenRole;
  token: UIThemeTokenKey;
  labelKey: RoleLabelKey;
}

/**
 * The decision a click on the capture layer resolves to. Discriminated so the
 * overlay can switch exhaustively:
 *   - terminal: click landed on the xterm area → background/foreground slot menu.
 *   - pick:     a single editable token/role → setInspectTarget immediately.
 *   - menu:     an element marks 2+ roles → show options, then setInspectTarget.
 *   - hint:     nothing editable here → non-silent "not customizable yet" hint.
 */
export type InspectAction =
  | { kind: 'terminal' }
  | { kind: 'pick'; token: UIThemeTokenKey; role: TokenRole }
  | { kind: 'menu'; options: RoleOption[] }
  | { kind: 'hint' };

/**
 * Build the disambiguation menu options for a multi-role element, in the fixed
 * MENU_ROLE_ORDER and including only roles the element actually marks. A region
 * with a single role yields a single-entry array (callers collapse that to a
 * direct 'pick'); a region with zero roles yields [].
 */
export function roleMenuOptions(
  tokens: Partial<Record<TokenRole, UIThemeTokenKey>>,
): RoleOption[] {
  const options: RoleOption[] = [];
  for (const role of MENU_ROLE_ORDER) {
    const token = tokens[role];
    if (token) {
      options.push({ role, token, labelKey: ROLE_LABEL_KEY[role] });
    }
  }
  return options;
}

/**
 * Resolve a click into the action the overlay performs. Order of precedence:
 *   1. Terminal area wins over token markers — a terminal wrapper may itself be
 *      marked (background token), but D-terminal v1 routes the whole area to the
 *      background/foreground slot menu, not the UI token.
 *   2. No resolved region (and not terminal) → non-silent hint.
 *   3. A derived region (data-derived) routes to its editable SOURCE token, so
 *      the click never dead-ends on a non-editable derived value (D-revmap). The
 *      role stays the representative role for menu labeling consistency.
 *   4. A single editable role → pick it directly.
 *   5. Two or more roles → menu for the user to choose the slot (D-hover).
 */
export function resolveClickAction(
  resolved: ResolvedRegion | null,
  isTerminal: boolean,
): InspectAction {
  if (isTerminal) return { kind: 'terminal' };
  if (!resolved) return { kind: 'hint' };

  // Derived region: route to the source token regardless of how many roles it
  // marks, because the visible derived value isn't itself editable.
  if (resolved.derivedNote) {
    return { kind: 'pick', token: resolved.derivedNote, role: resolved.representative.role };
  }

  const options = roleMenuOptions(resolved.tokens);
  if (options.length <= 1) {
    // Exactly one role (the selector guarantees ≥1 when resolved is non-null).
    return { kind: 'pick', token: resolved.representative.token, role: resolved.representative.role };
  }
  return { kind: 'menu', options };
}

/**
 * True when any element in an elementsFromPoint hit-stack belongs to an xterm
 * terminal area. xterm.js adds the `.xterm` class to the element it opens onto,
 * so a hit on the terminal screen, rows, or viewport all sit inside a `.xterm`
 * ancestor. We check both the element and its ancestor chain via closest().
 */
export function isTerminalElement(els: readonly Element[]): boolean {
  return els.some((el) => el.classList.contains('xterm') || el.closest('.xterm') !== null);
}

/**
 * True when an element is part of the overlay's own UI (capture layer, chips,
 * outlines, menus, proxies) and must be excluded from hit-testing so the overlay
 * never reverse-maps itself (D-hittest). Overlay elements live under, or are,
 * `overlayRoot`; we also honor an explicit data-inspect-overlay marker so
 * portaled bits outside the root (if any) are still filtered.
 */
export function isOverlayElement(el: Element, overlayRoot: Element | null): boolean {
  if (overlayRoot && (el === overlayRoot || overlayRoot.contains(el))) return true;
  return el.closest('[data-inspect-overlay]') !== null;
}

/**
 * Pick the first hit-stack element that is neither overlay chrome nor — when a
 * terminal isn't what we're after — anything. Returns the first non-overlay
 * element, or null if every hit was overlay chrome (e.g. pointer over a chip).
 */
export function firstNonOverlayElement(
  els: readonly Element[],
  overlayRoot: Element | null,
): Element | null {
  for (const el of els) {
    if (!isOverlayElement(el, overlayRoot)) return el;
  }
  return null;
}
