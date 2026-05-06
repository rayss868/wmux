/**
 * Tests for `shouldFitWhilePreservingSelection`.
 *
 * The guard is the deciding step both inside the ResizeObserver tick and the
 * font/theme effect — calling `fit()` mid-drag clears the selection (xterm's
 * SelectionService responds to `rowsChanged` by unconditionally clearing).
 */
import { describe, it, expect } from 'vitest';
import { shouldFitWhilePreservingSelection } from '../fitGuard';

describe('shouldFitWhilePreservingSelection', () => {
  it('returns true when the terminal has no active selection', () => {
    const term = { hasSelection: () => false };
    expect(shouldFitWhilePreservingSelection(term)).toBe(true);
  });

  it('returns false when the terminal has an active selection', () => {
    const term = { hasSelection: () => true };
    expect(shouldFitWhilePreservingSelection(term)).toBe(false);
  });

  it('returns true for null/undefined term (no selection to preserve)', () => {
    expect(shouldFitWhilePreservingSelection(null)).toBe(true);
    expect(shouldFitWhilePreservingSelection(undefined)).toBe(true);
  });

  it('does not call hasSelection more than once per check', () => {
    let calls = 0;
    const term = {
      hasSelection: () => {
        calls += 1;
        return false;
      },
    };
    shouldFitWhilePreservingSelection(term);
    expect(calls).toBe(1);
  });
});
