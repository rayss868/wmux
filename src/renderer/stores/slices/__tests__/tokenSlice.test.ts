import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createTokenSlice, type TokenSlice } from '../tokenSlice';

type TestState = TokenSlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createTokenSlice(...args),
    }))
  );
}

describe('TokenSlice', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('starts with empty tokenDataByPty', () => {
    expect(store.getState().tokenDataByPty).toEqual({});
  });

  it('creates token data on first update', () => {
    store.getState().updateTokenData('pty-1', {
      totalTokens: 1000,
      inputTokens: 400,
      outputTokens: 600,
      totalCost: 0.05,
    });
    const data = store.getState().tokenDataByPty['pty-1'];
    expect(data).toBeDefined();
    expect(data.totalTokens).toBe(1000);
    expect(data.inputTokens).toBe(400);
    expect(data.outputTokens).toBe(600);
    expect(data.totalCost).toBe(0.05);
    expect(data.lastUpdate).toBeGreaterThan(0);
  });

  it('updates existing token data partially', () => {
    store.getState().updateTokenData('pty-1', {
      totalTokens: 1000,
      inputTokens: 400,
      outputTokens: 600,
      totalCost: 0.05,
    });
    store.getState().updateTokenData('pty-1', {
      totalTokens: 2000,
      totalCost: 0.10,
    });
    const data = store.getState().tokenDataByPty['pty-1'];
    expect(data.totalTokens).toBe(2000);
    expect(data.inputTokens).toBe(400); // unchanged
    expect(data.outputTokens).toBe(600); // unchanged
    expect(data.totalCost).toBe(0.10);
  });

  it('clears token data for a pty', () => {
    store.getState().updateTokenData('pty-1', { totalTokens: 100, totalCost: 0.01 });
    store.getState().clearTokenData('pty-1');
    expect(store.getState().tokenDataByPty['pty-1']).toBeUndefined();
  });

  it('getTotalCost sums across all ptys', () => {
    store.getState().updateTokenData('pty-1', { totalCost: 1.50 });
    store.getState().updateTokenData('pty-2', { totalCost: 2.25 });
    store.getState().updateTokenData('pty-3', { totalCost: 0.75 });
    expect(store.getState().getTotalCost()).toBeCloseTo(4.50);
  });

  it('getTotalCost returns 0 when empty', () => {
    expect(store.getState().getTotalCost()).toBe(0);
  });

  it('handles clearing non-existent pty gracefully', () => {
    store.getState().clearTokenData('non-existent');
    expect(store.getState().tokenDataByPty).toEqual({});
  });
});
