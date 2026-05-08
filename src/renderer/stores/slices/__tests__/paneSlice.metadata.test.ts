import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import {
  createWorkspace,
  PANE_METADATA_MAX_BYTES,
  type Workspace,
} from '../../../../shared/types';

type TestState = PaneSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
};

function createTestStore() {
  const ws = createWorkspace('Test');
  return create<TestState>()(
    immer((...args) => ({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
    }))
  );
}

function createTwoWorkspaceStore() {
  const wsA = createWorkspace('A');
  const wsB = createWorkspace('B');
  return create<TestState>()(
    immer((...args) => ({
      workspaces: [wsA, wsB],
      activeWorkspaceId: wsA.id,
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
    }))
  );
}

describe('PaneSlice — metadata', () => {
  let store: ReturnType<typeof createTestStore>;
  let paneId: string;

  beforeEach(() => {
    store = createTestStore();
    paneId = store.getState().workspaces[0].rootPane.id;
  });

  describe('setPaneMetadata', () => {
    it('sets initial metadata with updatedAt populated', () => {
      const before = Date.now();
      store.getState().setPaneMetadata(paneId, { label: 'Backend', role: 'service' });
      const after = Date.now();

      const meta = store.getState().getPaneMetadata(paneId);
      expect(meta).toBeDefined();
      expect(meta?.label).toBe('Backend');
      expect(meta?.role).toBe('service');
      expect(meta?.updatedAt).toBeGreaterThanOrEqual(before);
      expect(meta?.updatedAt).toBeLessThanOrEqual(after);
    });

    it('merges by default (preserves existing fields)', () => {
      store.getState().setPaneMetadata(paneId, { label: 'Backend', role: 'service' });
      store.getState().setPaneMetadata(paneId, { status: 'running-tests' });

      const meta = store.getState().getPaneMetadata(paneId);
      expect(meta?.label).toBe('Backend');
      expect(meta?.role).toBe('service');
      expect(meta?.status).toBe('running-tests');
    });

    it('replaces when merge=false', () => {
      store.getState().setPaneMetadata(paneId, { label: 'Backend', role: 'service' });
      store.getState().setPaneMetadata(paneId, { status: 'idle' }, { merge: false });

      const meta = store.getState().getPaneMetadata(paneId);
      expect(meta?.label).toBeUndefined();
      expect(meta?.role).toBeUndefined();
      expect(meta?.status).toBe('idle');
    });

    it('persists custom string→string map', () => {
      store.getState().setPaneMetadata(paneId, {
        custom: { gitWorktree: 'feat/foo', tier: 'staging' },
      });
      const meta = store.getState().getPaneMetadata(paneId);
      expect(meta?.custom).toEqual({ gitWorktree: 'feat/foo', tier: 'staging' });
    });

    it('rejects metadata exceeding 8KB cap', () => {
      const huge = 'x'.repeat(PANE_METADATA_MAX_BYTES + 100);
      expect(() =>
        store.getState().setPaneMetadata(paneId, { custom: { blob: huge } })
      ).toThrow(/exceeds/);

      // No partial state — slice should not have been mutated.
      expect(store.getState().getPaneMetadata(paneId)).toBeUndefined();
    });

    it('is a no-op for unknown paneId', () => {
      store.getState().setPaneMetadata('does-not-exist', { label: 'Ghost' });
      expect(store.getState().getPaneMetadata('does-not-exist')).toBeUndefined();
    });
  });

  describe('getPaneMetadata', () => {
    it('returns undefined when no metadata set', () => {
      expect(store.getState().getPaneMetadata(paneId)).toBeUndefined();
    });

    it('returns undefined for non-leaf panes (branches)', () => {
      // Split to create a branch
      store.getState().splitPane(paneId, 'horizontal');
      const ws = store.getState().workspaces[0];
      const branchId = ws.rootPane.id; // root is now a branch

      expect(store.getState().getPaneMetadata(branchId)).toBeUndefined();
    });
  });

  describe('clearPaneMetadata', () => {
    it('drops all metadata', () => {
      store.getState().setPaneMetadata(paneId, {
        label: 'Backend',
        custom: { foo: 'bar' },
      });
      expect(store.getState().getPaneMetadata(paneId)).toBeDefined();

      store.getState().clearPaneMetadata(paneId);
      expect(store.getState().getPaneMetadata(paneId)).toBeUndefined();
    });

    it('is safe on a pane that never had metadata', () => {
      expect(() => store.getState().clearPaneMetadata(paneId)).not.toThrow();
      expect(store.getState().getPaneMetadata(paneId)).toBeUndefined();
    });
  });

  describe('metadata survives pane operations', () => {
    it('a pane keeps its metadata after splitPane creates a sibling', () => {
      store.getState().setPaneMetadata(paneId, { label: 'Original' });
      store.getState().splitPane(paneId, 'horizontal');

      // After split the original leaf is cloned into the branch's first child;
      // its id is preserved. Verify metadata is intact via getPaneMetadata.
      const meta = store.getState().getPaneMetadata(paneId);
      expect(meta?.label).toBe('Original');
    });
  });

  describe('custom map deep-merge (review fix 6.1)', () => {
    it('preserves existing custom keys when patch only sets a new key', () => {
      store.getState().setPaneMetadata(paneId, {
        custom: { gitWorktree: 'feat/foo', tier: 'staging' },
      });
      store.getState().setPaneMetadata(paneId, {
        custom: { tagger: 'mcp-x' },
      });

      const meta = store.getState().getPaneMetadata(paneId);
      expect(meta?.custom).toEqual({
        gitWorktree: 'feat/foo',
        tier: 'staging',
        tagger: 'mcp-x',
      });
    });

    it('overwrites the same key when both writes touch it', () => {
      store.getState().setPaneMetadata(paneId, { custom: { tier: 'dev' } });
      store.getState().setPaneMetadata(paneId, { custom: { tier: 'prod' } });

      expect(store.getState().getPaneMetadata(paneId)?.custom).toEqual({ tier: 'prod' });
    });

    it('merge=false replaces the entire custom map', () => {
      store.getState().setPaneMetadata(paneId, { custom: { a: '1', b: '2' } });
      store.getState().setPaneMetadata(paneId, { custom: { c: '3' } }, { merge: false });

      expect(store.getState().getPaneMetadata(paneId)?.custom).toEqual({ c: '3' });
    });
  });

  describe('cross-workspace scoping (review fix 1.1)', () => {
    it('writes to the targeted workspace, not just active', () => {
      const twoStore = createTwoWorkspaceStore();
      const wsA = twoStore.getState().workspaces[0];
      const wsB = twoStore.getState().workspaces[1];
      const paneA = wsA.rootPane.id;
      const paneB = wsB.rootPane.id;

      // Active is A, but write to B's pane explicitly.
      twoStore.getState().setPaneMetadata(paneB, { label: 'B-only' }, { workspaceId: wsB.id });

      expect(twoStore.getState().getPaneMetadata(paneB, { workspaceId: wsB.id })?.label).toBe('B-only');
      // A's pane was untouched.
      expect(twoStore.getState().getPaneMetadata(paneA, { workspaceId: wsA.id })).toBeUndefined();
    });

    it('silent no-op when paneId belongs to a different workspace than workspaceId', () => {
      const twoStore = createTwoWorkspaceStore();
      const wsA = twoStore.getState().workspaces[0];
      const wsB = twoStore.getState().workspaces[1];
      const paneA = wsA.rootPane.id;

      // paneA exists in workspace A, but caller targets workspace B.
      twoStore.getState().setPaneMetadata(paneA, { label: 'should-not-land' }, { workspaceId: wsB.id });

      // Pane A in A: untouched.
      expect(twoStore.getState().getPaneMetadata(paneA, { workspaceId: wsA.id })).toBeUndefined();
      // Pane A queried as if in B: also undefined.
      expect(twoStore.getState().getPaneMetadata(paneA, { workspaceId: wsB.id })).toBeUndefined();
    });

    it('clearPaneMetadata respects workspaceId opts', () => {
      const twoStore = createTwoWorkspaceStore();
      const wsB = twoStore.getState().workspaces[1];
      const paneB = wsB.rootPane.id;

      twoStore.getState().setPaneMetadata(paneB, { label: 'B' }, { workspaceId: wsB.id });
      twoStore.getState().clearPaneMetadata(paneB, { workspaceId: wsB.id });

      expect(twoStore.getState().getPaneMetadata(paneB, { workspaceId: wsB.id })).toBeUndefined();
    });
  });
});
