import { describe, it, expect } from 'vitest';
import {
  evaluateToken,
  nearestSafeLightness,
  nudgeForReport,
  thresholdFor,
  AA_BODY,
  AA_LARGE,
  BG_TOKENS,
  type ForegroundTokenKey,
} from '../contrastSafety';
import { getContrastRatio } from '../tailwindPalette';
import { builtinToCustom } from '../themes';

// Minimal color set the evaluator needs: 3 bg tokens + 4 fg tokens.
function colors(over: Partial<Record<'bgBase' | 'bgSurface' | 'bgMantle' | ForegroundTokenKey, string>> = {}) {
  return {
    bgBase: '#1E1E2E',
    bgSurface: '#313244',
    bgMantle: '#181825',
    textMain: '#CDD6F4',
    textSub: '#BAC2DE',
    textMuted: '#7F849C',
    accent: '#89B4FA',
    ...over,
  };
}

describe('contrastSafety — thresholds', () => {
  it('text tokens require body AA (4.5), accent requires large/UI AA (3.0)', () => {
    expect(thresholdFor('textMain')).toBe(AA_BODY);
    expect(thresholdFor('textSub')).toBe(AA_BODY);
    expect(thresholdFor('textMuted')).toBe(AA_BODY);
    expect(thresholdFor('accent')).toBe(AA_LARGE);
  });
});

describe('contrastSafety — evaluateToken (surface-aware)', () => {
  it('checks the foreground against all three backgrounds', () => {
    const r = evaluateToken('textMain', colors());
    expect(r.pairs.map((p) => p.bg)).toEqual([...BG_TOKENS]);
    // Each pair's ratio matches a direct getContrastRatio call.
    const c = colors();
    for (const p of r.pairs) {
      expect(p.ratio).toBeCloseTo(getContrastRatio(c.textMain, c[p.bg]), 5);
    }
  });

  it('flags a low-contrast pair (light text on light surface) as a warning', () => {
    // bg ≈ #F8F8FA, text ≈ #F0F0F0 — ~1.1:1, far below AA.
    const r = evaluateToken('textMain', colors({ bgBase: '#F8F8FA', bgSurface: '#F8F8FA', bgMantle: '#F8F8FA', textMain: '#F0F0F0' }));
    expect(r.allPass).toBe(false);
    expect(r.anySevere).toBe(true); // < 3:1
    expect(r.worstRatio).toBeLessThan(AA_LARGE);
  });

  it('passes a high-contrast pair (dark text on white) on every surface', () => {
    const r = evaluateToken('textMain', colors({ bgBase: '#FFFFFF', bgSurface: '#FFFFFF', bgMantle: '#FFFFFF', textMain: '#111111' }));
    expect(r.allPass).toBe(true);
    expect(r.anySevere).toBe(false);
    expect(r.worstRatio).toBeGreaterThanOrEqual(AA_BODY);
  });

  it('the default catppuccin-mocha tokens clear AA for textMain', () => {
    const mocha = builtinToCustom('catppuccin-mocha');
    const r = evaluateToken('textMain', mocha);
    expect(r.allPass).toBe(true);
  });

  it('worstBg points at the surface with the lowest ratio', () => {
    // Make bgSurface the closest in luminance to the text → worst pair.
    const r = evaluateToken('textMuted', colors({ bgBase: '#000000', bgMantle: '#000000', bgSurface: '#7F849C', textMuted: '#7F849C' }));
    expect(r.worstBg).toBe('bgSurface');
    expect(r.worstRatio).toBeCloseTo(1, 5); // identical color
  });
});

describe('contrastSafety — nearestSafeLightness (nudge)', () => {
  it('returns the same hex when already safe', () => {
    const res = nearestSafeLightness('#111111', '#FFFFFF', AA_BODY);
    expect(res.hex).toBe('#111111');
  });

  it('darkens a too-light foreground on a light background until it clears AA', () => {
    const res = nearestSafeLightness('#CCCCCC', '#FFFFFF', AA_BODY);
    expect(res.hex).not.toBeNull();
    expect(getContrastRatio(res.hex as string, '#FFFFFF')).toBeGreaterThanOrEqual(AA_BODY);
  });

  it('lightens a too-dark foreground on a dark background until it clears AA', () => {
    const res = nearestSafeLightness('#222222', '#000000', AA_BODY);
    expect(res.hex).not.toBeNull();
    expect(getContrastRatio(res.hex as string, '#000000')).toBeGreaterThanOrEqual(AA_BODY);
  });

  it('returns hex:null gracefully when no lightness can clear the threshold', () => {
    // Mid-gray on mid-gray: even black or white can only reach ~5:1 vs #808080,
    // so a strict 21 target is unreachable → null with best-effort ratio.
    const res = nearestSafeLightness('#808080', '#808080', 21);
    expect(res.hex).toBeNull();
    expect(res.ratio).toBeGreaterThan(1);
  });
});

describe('contrastSafety — nudgeForReport', () => {
  it('returns null when the token already passes everywhere', () => {
    const r = evaluateToken('textMain', colors({ bgBase: '#FFFFFF', bgSurface: '#FFFFFF', bgMantle: '#FFFFFF', textMain: '#111111' }));
    expect(nudgeForReport(r, colors({ bgBase: '#FFFFFF', bgSurface: '#FFFFFF', bgMantle: '#FFFFFF', textMain: '#111111' }))).toBeNull();
  });

  it('targets the worst background and returns a passing shade when reachable', () => {
    const c = colors({ bgBase: '#FFFFFF', bgSurface: '#FFFFFF', bgMantle: '#FFFFFF', textMain: '#CCCCCC' });
    const r = evaluateToken('textMain', c);
    const nudge = nudgeForReport(r, c);
    expect(nudge).not.toBeNull();
    expect(nudge?.hex).not.toBeNull();
    expect(getContrastRatio(nudge?.hex as string, '#FFFFFF')).toBeGreaterThanOrEqual(AA_BODY);
  });
});
