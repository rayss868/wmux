// Live WCAG contrast safety-net logic for the custom theme editor (PR1).
//
// This is the *pure* layer behind the contrast warning badges: given the 10
// editable UI tokens, it works out — for every place a text/accent token is
// actually rendered against a background — whether the pair clears WCAG AA, and
// if not, the closest safe lightness nudge. Keeping it framework-free lets the
// node-env vitest suite exercise the math directly (the SettingsPanel UI itself
// can't mount in jsdom-less tests, mirroring the NotificationsView split).
//
// Design contract: see plans/color-customization-inspect-mode.md §4.4.
// Warnings only — never clamp or block. The nudge is opt-in.

import { getContrastRatio, shiftLightness, luminance } from './tailwindPalette';
import type { CustomThemeColors } from '../shared/types';

/** The three editable background tokens a foreground can land on. */
export const BG_TOKENS = ['bgBase', 'bgSurface', 'bgMantle'] as const;
export type BgTokenKey = (typeof BG_TOKENS)[number];

/** Foreground tokens that get a live contrast check. */
export type ForegroundTokenKey = 'textMain' | 'textSub' | 'textMuted' | 'accent';

// WCAG 2.1 thresholds. 1.4.3 body text = 4.5:1; 1.4.11 / 1.4.3 large/UI = 3:1.
export const AA_BODY = 4.5;
export const AA_LARGE = 3.0;

/**
 * Whether a foreground token is "body text" (needs 4.5:1) or "UI / large"
 * (needs 3:1). textMain/textSub are body copy; textMuted is hint-sized but we
 * still hold it to body AA so disabled text stays legible. accent is treated as
 * a UI element (focus rings, fills, badges) per 1.4.11 → 3:1 floor.
 */
export function thresholdFor(token: ForegroundTokenKey): number {
  return token === 'accent' ? AA_LARGE : AA_BODY;
}

export interface ContrastPair {
  /** Background token the foreground renders against. */
  bg: BgTokenKey;
  /** Resolved contrast ratio (1–21). */
  ratio: number;
  /** Required AA threshold for this foreground role. */
  threshold: number;
  /** ratio >= threshold. */
  passes: boolean;
  /** ratio < AA_LARGE — severe, gets an assertive live announcement. */
  severe: boolean;
}

export interface ContrastReport {
  token: ForegroundTokenKey;
  pairs: ContrastPair[];
  /** True when every background pair clears AA for this token. */
  allPass: boolean;
  /** True when at least one pair is below the 3:1 severe floor. */
  anySevere: boolean;
  /** The worst (lowest) ratio across all checked backgrounds. */
  worstRatio: number;
  /** The background token of the worst pair (the one the nudge targets). */
  worstBg: BgTokenKey;
}

/**
 * Evaluate one foreground token against every background it can render on.
 * accent is checked against backgrounds (fill/text-on-surface context); the
 * three text tokens are checked against bgBase/bgSurface/bgMantle each. This is
 * deliberately surface-aware — a single-pair check would be compliance theater
 * when the same text color sits on three different surfaces.
 */
export function evaluateToken(
  token: ForegroundTokenKey,
  colors: Pick<CustomThemeColors, ForegroundTokenKey | BgTokenKey>,
): ContrastReport {
  const fg = colors[token];
  const threshold = thresholdFor(token);
  const pairs: ContrastPair[] = BG_TOKENS.map((bg) => {
    const ratio = getContrastRatio(fg, colors[bg]);
    return {
      bg,
      ratio,
      threshold,
      passes: ratio >= threshold,
      severe: ratio < AA_LARGE,
    };
  });
  let worst = pairs[0];
  for (const p of pairs) if (p.ratio < worst.ratio) worst = p;
  return {
    token,
    pairs,
    allPass: pairs.every((p) => p.passes),
    anySevere: pairs.some((p) => p.severe),
    worstRatio: worst.ratio,
    worstBg: worst.bg,
  };
}

export interface SafeLightnessResult {
  /** A hex that clears `threshold` against `bg`, or null when unreachable. */
  hex: string | null;
  /** The contrast the suggested hex achieves (best effort even when < target). */
  ratio: number;
}

/**
 * Find the nearest lightness-shifted shade of `fg` that clears `threshold`
 * against `bg`. Walks lightness outward from the current value in small steps,
 * toward whichever direction increases contrast (darker on light bg, lighter on
 * dark bg). Returns the first passing shade; if no shade in range passes (e.g.
 * a mid-gray on a mid-gray surface where even black/white can't reach AA), the
 * best-effort extreme is returned with `hex: null` so callers can disable the
 * nudge gracefully rather than apply a non-fix.
 */
export function nearestSafeLightness(
  fg: string,
  bg: string,
  threshold: number,
): SafeLightnessResult {
  // Already safe — nothing to nudge.
  const current = getContrastRatio(fg, bg);
  if (current >= threshold) return { hex: fg, ratio: current };

  // Push the foreground away from the background's luminance: if the bg is
  // light, darken the fg; if dark, lighten it.
  const dir = luminance(bg) > luminance(fg) ? -1 : 1;

  let bestRatio = current;
  // 1% lightness steps to the extreme (±1.0 covers the full 0–1 range; shifts
  // beyond the gamut are clamped by shiftLightness, so the loop self-limits).
  for (let step = 0.01; step <= 1.0001; step += 0.01) {
    const candidate = shiftLightness(fg, dir * step);
    const ratio = getContrastRatio(candidate, bg);
    if (ratio > bestRatio) bestRatio = ratio;
    if (ratio >= threshold) return { hex: candidate, ratio };
  }
  // Could not clear AA at any reachable lightness — surface this honestly.
  return { hex: null, ratio: bestRatio };
}

/**
 * Convenience: compute the nudge for a token's worst background pair. Returns
 * null when the token already passes everywhere (no nudge to offer).
 */
export function nudgeForReport(
  report: ContrastReport,
  colors: Pick<CustomThemeColors, ForegroundTokenKey | BgTokenKey>,
): SafeLightnessResult | null {
  if (report.allPass) return null;
  return nearestSafeLightness(colors[report.token], colors[report.worstBg], report.pairs[0].threshold);
}
