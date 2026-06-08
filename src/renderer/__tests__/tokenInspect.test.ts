// @vitest-environment jsdom
//
// S2 — themes.ts inspect-mode reverse mapping (PR2 foundation). These pure DOM
// helpers are the data-token-* source-of-truth resolvers the InspectOverlay
// (separate task) consumes. Exercised here against a real jsdom tree built with
// createElement + setAttribute so the closest()/querySelectorAll() semantics are
// the genuine browser ones, not a stub.
import { describe, it, expect, afterEach } from 'vitest';
import {
  tokenAttrs,
  DERIVED_TO_SOURCE,
  findTokenForElement,
  regionsForToken,
  type ResolvedRegion,
  type UIThemeTokenKey,
  type TokenRole,
} from '../themes';

/** Resolve + assert non-null in one place so call sites stay assertion-free. */
function resolve(el: Element): ResolvedRegion {
  const r = findTokenForElement(el);
  expect(r).not.toBeNull();
  return r as ResolvedRegion;
}

afterEach(() => {
  document.body.innerHTML = '';
});

/** Build an element carrying the given data-token-<role> markers. */
function mark(
  tag: string,
  marks: Partial<Record<TokenRole, UIThemeTokenKey>>,
  extra?: Record<string, string>,
): HTMLElement {
  const el = document.createElement(tag);
  for (const [role, token] of Object.entries(marks)) {
    el.setAttribute(`data-token-${role}`, token as string);
  }
  if (extra) for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
  return el;
}

describe('tokenAttrs — typed marker emitter', () => {
  it('emits a single data-token-<role> entry keyed by role', () => {
    expect(tokenAttrs('bgSurface', 'bg')).toEqual({ 'data-token-bg': 'bgSurface' });
    expect(tokenAttrs('textMain', 'text')).toEqual({ 'data-token-text': 'textMain' });
    expect(tokenAttrs('accent', 'accent')).toEqual({ 'data-token-accent': 'accent' });
    expect(tokenAttrs('danger', 'border')).toEqual({ 'data-token-border': 'danger' });
  });

  it('round-trips through setAttribute → findTokenForElement', () => {
    const el = document.createElement('div');
    for (const [attr, val] of Object.entries(tokenAttrs('warning', 'bg'))) {
      el.setAttribute(attr, val);
    }
    document.body.appendChild(el);
    const resolved = findTokenForElement(el);
    expect(resolved?.representative).toEqual({ role: 'bg', token: 'warning' });
  });
});

describe('DERIVED_TO_SOURCE — derived var → editable source', () => {
  it('mirrors deriveFullPalette knowledge for all 4 derived vars', () => {
    expect(DERIVED_TO_SOURCE).toEqual({
      bgOverlay: 'bgSurface',
      textSub2: 'textMain',
      textSubtle: 'textSub',
      accentCursor: 'accent',
    });
  });
});

describe('findTokenForElement — reverse map (D-revmap / D-hover)', () => {
  it('resolves a click on a descendant to the nearest marked ancestor', () => {
    const card = mark('div', { bg: 'bgSurface' });
    const inner = document.createElement('span');
    const leaf = document.createElement('em');
    inner.appendChild(leaf);
    card.appendChild(inner);
    document.body.appendChild(card);

    const resolved = resolve(leaf);
    expect(resolved.el).toBe(card);
    expect(resolved.representative).toEqual({ role: 'bg', token: 'bgSurface' });
  });

  it('resolves the element itself when it is the marked node', () => {
    const el = mark('button', { accent: 'accent' });
    document.body.appendChild(el);
    expect(resolve(el).el).toBe(el);
  });

  it('prefers bg as representative for a multi-role element (D-hover)', () => {
    const card = mark('div', { bg: 'bgSurface', text: 'textMain', border: 'accent' });
    document.body.appendChild(card);

    const resolved = resolve(card);
    expect(resolved.representative).toEqual({ role: 'bg', token: 'bgSurface' });
    // All roles are collected for the click disambiguation menu.
    expect(resolved.tokens).toEqual({
      bg: 'bgSurface',
      text: 'textMain',
      border: 'accent',
    });
  });

  it('falls through bg→accent→text→border priority when bg is absent', () => {
    const onlyText = mark('p', { text: 'textSub' });
    document.body.appendChild(onlyText);
    expect(resolve(onlyText).representative).toEqual({ role: 'text', token: 'textSub' });

    const accentAndText = mark('span', { text: 'textMain', accent: 'accent' });
    document.body.appendChild(accentAndText);
    // accent outranks text per ROLE_PRIORITY.
    expect(resolve(accentAndText).representative).toEqual({ role: 'accent', token: 'accent' });

    const onlyBorder = mark('hr', { border: 'danger' });
    document.body.appendChild(onlyBorder);
    expect(resolve(onlyBorder).representative).toEqual({ role: 'border', token: 'danger' });
  });

  it('attaches derivedNote (source token) when data-derived is present', () => {
    const overlay = mark('div', { bg: 'bgSurface' }, { 'data-derived': 'bgOverlay' });
    document.body.appendChild(overlay);

    expect(resolve(overlay).derivedNote).toBe('bgSurface');
  });

  it('omits derivedNote when data-derived is missing or unknown', () => {
    const plain = mark('div', { bg: 'bgSurface' });
    document.body.appendChild(plain);
    expect(resolve(plain).derivedNote).toBeUndefined();

    const bogus = mark('div', { bg: 'bgSurface' }, { 'data-derived': 'notARealDerived' });
    document.body.appendChild(bogus);
    expect(resolve(bogus).derivedNote).toBeUndefined();
  });

  it('returns null for an unmarked element and its unmarked ancestors', () => {
    const plain = document.createElement('div');
    const child = document.createElement('span');
    plain.appendChild(child);
    document.body.appendChild(plain);
    expect(findTokenForElement(child)).toBeNull();
    expect(findTokenForElement(plain)).toBeNull();
  });
});

describe('regionsForToken — forward count (D-chip "marked N places")', () => {
  it('counts every element marked with the given token + role under root', () => {
    const a = mark('div', { bg: 'bgSurface' });
    const b = mark('div', { bg: 'bgSurface' });
    const c = mark('div', { bg: 'bgMantle' });   // different token
    const d = mark('div', { text: 'bgSurface' }); // same token, different role
    document.body.append(a, b, c, d);

    const matches = regionsForToken('bgSurface', 'bg');
    expect(matches).toHaveLength(2);
    expect(matches).toContain(a);
    expect(matches).toContain(b);
    expect(matches).not.toContain(c);
    expect(matches).not.toContain(d);
  });

  it('scopes the query to the provided root', () => {
    const scope = document.createElement('section');
    const inside = mark('div', { accent: 'accent' });
    const outside = mark('div', { accent: 'accent' });
    scope.appendChild(inside);
    document.body.append(scope, outside);

    const matches = regionsForToken('accent', 'accent', scope);
    expect(matches).toEqual([inside]);
  });

  it('returns an empty array when no region carries the token', () => {
    document.body.appendChild(mark('div', { bg: 'bgBase' }));
    expect(regionsForToken('warning', 'bg')).toEqual([]);
  });
});
