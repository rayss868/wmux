import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createSupervisionSlice, type SupervisionSlice } from '../supervisionSlice';

function createTestStore() {
  return create<SupervisionSlice>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createSupervisionSlice(...args),
    })),
  );
}

describe('supervisionSlice', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('starts empty', () => {
    expect(store.getState().supervisionByPtyId).toEqual({});
  });

  describe('setSupervision', () => {
    it('sets status + restartCount for a new pty', () => {
      store.getState().setSupervision('pty-a', 'armed', 3);
      expect(store.getState().supervisionByPtyId['pty-a']).toEqual({ status: 'armed', restartCount: 3 });
    });

    it('defaults restartCount to 0 for a brand-new entry when omitted', () => {
      store.getState().setSupervision('pty-a', 'armed');
      expect(store.getState().supervisionByPtyId['pty-a']).toEqual({ status: 'armed', restartCount: 0 });
    });

    it('preserves the existing restartCount on a status-only flip', () => {
      store.getState().setSupervision('pty-a', 'armed', 4);
      // Guard trip → stopped, no count passed: count must survive.
      store.getState().setSupervision('pty-a', 'stopped');
      expect(store.getState().supervisionByPtyId['pty-a']).toEqual({ status: 'stopped', restartCount: 4 });
    });

    it('overwrites restartCount when one is supplied', () => {
      store.getState().setSupervision('pty-a', 'armed', 4);
      store.getState().setSupervision('pty-a', 'stopped', 5);
      expect(store.getState().supervisionByPtyId['pty-a']).toEqual({ status: 'stopped', restartCount: 5 });
    });
  });

  describe('bumpSupervisionRestart', () => {
    it('increments restartCount, leaving status armed', () => {
      store.getState().setSupervision('pty-a', 'armed', 1);
      store.getState().bumpSupervisionRestart('pty-a');
      expect(store.getState().supervisionByPtyId['pty-a']).toEqual({ status: 'armed', restartCount: 2 });
    });

    it('seeds an armed entry when the pty is untracked (hydration race)', () => {
      store.getState().bumpSupervisionRestart('pty-new');
      expect(store.getState().supervisionByPtyId['pty-new']).toEqual({ status: 'armed', restartCount: 1 });
    });

    it('preserves a stopped status if it was already stopped', () => {
      // A restart that races a just-tripped guard should not silently re-arm.
      store.getState().setSupervision('pty-a', 'stopped', 5);
      store.getState().bumpSupervisionRestart('pty-a');
      expect(store.getState().supervisionByPtyId['pty-a']).toEqual({ status: 'stopped', restartCount: 6 });
    });
  });

  describe('clearSupervision', () => {
    it('removes a single entry', () => {
      store.getState().setSupervision('pty-a', 'armed', 1);
      store.getState().setSupervision('pty-b', 'stopped', 2);
      store.getState().clearSupervision('pty-a');
      expect(store.getState().supervisionByPtyId['pty-a']).toBeUndefined();
      expect(store.getState().supervisionByPtyId['pty-b']).toEqual({ status: 'stopped', restartCount: 2 });
    });

    it('is a no-op for an unknown pty', () => {
      store.getState().setSupervision('pty-a', 'armed', 1);
      store.getState().clearSupervision('pty-nope');
      expect(store.getState().supervisionByPtyId['pty-a']).toEqual({ status: 'armed', restartCount: 1 });
    });
  });

  describe('hydrateSupervision', () => {
    it('replaces the whole map (drops entries absent from the snapshot)', () => {
      store.getState().setSupervision('pty-stale', 'armed', 9);
      store.getState().hydrateSupervision({
        'pty-a': { status: 'armed', restartCount: 0 },
        'pty-b': { status: 'stopped', restartCount: 5 },
      });
      const map = store.getState().supervisionByPtyId;
      expect(map['pty-stale']).toBeUndefined();
      expect(map['pty-a']).toEqual({ status: 'armed', restartCount: 0 });
      expect(map['pty-b']).toEqual({ status: 'stopped', restartCount: 5 });
    });

    it('clears everything when hydrated with an empty snapshot', () => {
      store.getState().setSupervision('pty-a', 'armed', 1);
      store.getState().hydrateSupervision({});
      expect(store.getState().supervisionByPtyId).toEqual({});
    });

    it('is idempotent', () => {
      const snap = { 'pty-a': { status: 'armed' as const, restartCount: 2 } };
      store.getState().hydrateSupervision(snap);
      store.getState().hydrateSupervision(snap);
      expect(store.getState().supervisionByPtyId).toEqual(snap);
    });
  });
});
