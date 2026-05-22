import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';

// Capture publisher calls — workspaceSlice imports from this module.
const publishCalls: Array<{ fn: string; args: unknown[] }> = [];
vi.mock('../../../events/publisher', () => ({
  publishWorkspaceMetadataChanged: (...args: unknown[]) => {
    publishCalls.push({ fn: 'workspace.metadata.changed', args });
  },
}));

type TestState = WorkspaceSlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
    }))
  );
}

describe('workspaceSlice — workspace.metadata.changed publication (review fix 6a)', () => {
  let store: ReturnType<typeof createTestStore>;
  let wsId: string;

  beforeEach(() => {
    publishCalls.length = 0;
    store = createTestStore();
    // Make sure there's at least one workspace; use the first auto-created.
    wsId = store.getState().workspaces[0]?.id ?? '';
    if (!wsId) {
      store.getState().addWorkspace('Test');
      wsId = store.getState().workspaces[0].id;
    }
  });

  it('publishes when status changes', () => {
    store.getState().updateWorkspaceMetadata(wsId, { status: 'running' });

    const ev = publishCalls.find((c) => c.fn === 'workspace.metadata.changed');
    expect(ev).toBeDefined();
    expect(ev?.args[0]).toBe(wsId);
    expect((ev?.args[1] as { status?: string }).status).toBe('running');
    expect(ev?.args[2]).toEqual({ status: 'running' });
  });

  it('publishes when progress changes', () => {
    store.getState().updateWorkspaceMetadata(wsId, { progress: 42 });

    const ev = publishCalls.find((c) => c.fn === 'workspace.metadata.changed');
    expect(ev).toBeDefined();
    expect((ev?.args[1] as { progress?: number }).progress).toBe(42);
    expect(ev?.args[2]).toEqual({ progress: 42 });
  });

  it('publishes the FULL post-update snapshot in arg[1] and JUST the patch in arg[2]', () => {
    store.getState().updateWorkspaceMetadata(wsId, { status: 'idle' });
    publishCalls.length = 0;

    store.getState().updateWorkspaceMetadata(wsId, { progress: 80 });
    const ev = publishCalls[0];
    // Full snapshot has both fields.
    expect((ev.args[1] as { status?: string; progress?: number })).toMatchObject({
      status: 'idle',
      progress: 80,
    });
    // Patch only carries the keys this call wrote.
    expect(ev.args[2]).toEqual({ progress: 80 });
  });

  it('does not publish for unknown workspace id (silent no-op)', () => {
    store.getState().updateWorkspaceMetadata('does-not-exist', { status: 'x' });
    expect(publishCalls).toHaveLength(0);
  });

  it('publishes shell-hook updates the same as user-driven ones (cwd, gitBranch, etc.)', () => {
    store.getState().updateWorkspaceMetadata(wsId, { cwd: 'D:/wmux', gitBranch: 'feature/x' });
    const ev = publishCalls[0];
    expect(ev.args[2]).toEqual({ cwd: 'D:/wmux', gitBranch: 'feature/x' });
    // Note: chatty PTY hooks may emit many of these; throttling is a deliberate
    // follow-up (see #18) — for now any update emits.
  });
});

// T4 — Notification System Expansion: per-workspace mute lives on
// WorkspaceMetadata.notificationsMuted, written through the existing
// generic updateWorkspaceMetadata setter (no new action needed).
// Policy A4: surface off, data preserved — bell math and the T7 listener
// consult this flag; the notification panel still records muted entries.
describe('workspaceSlice — per-workspace notification mute (T4)', () => {
  let store: ReturnType<typeof createTestStore>;
  let wsId: string;

  beforeEach(() => {
    publishCalls.length = 0;
    store = createTestStore();
    wsId = store.getState().workspaces[0]?.id ?? '';
    if (!wsId) {
      store.getState().addWorkspace('Test');
      wsId = store.getState().workspaces[0].id;
    }
  });

  it('setting mute=true writes metadata.notificationsMuted = true', () => {
    store.getState().updateWorkspaceMetadata(wsId, { notificationsMuted: true });

    const ws = store.getState().workspaces.find((w) => w.id === wsId);
    expect(ws?.metadata?.notificationsMuted).toBe(true);
  });

  it('setting mute=false writes metadata.notificationsMuted = false', () => {
    store.getState().updateWorkspaceMetadata(wsId, { notificationsMuted: false });

    const ws = store.getState().workspaces.find((w) => w.id === wsId);
    expect(ws?.metadata?.notificationsMuted).toBe(false);
  });

  it('initializes metadata object when none exists, then sets mute', () => {
    // Sanity: fresh workspace has no metadata object yet (createWorkspace
    // leaves it undefined). updateWorkspaceMetadata is responsible for
    // initializing it — this guards that contract for the mute field too.
    const before = store.getState().workspaces.find((w) => w.id === wsId);
    expect(before?.metadata).toBeUndefined();

    store.getState().updateWorkspaceMetadata(wsId, { notificationsMuted: true });

    const after = store.getState().workspaces.find((w) => w.id === wsId);
    expect(after?.metadata).toBeDefined();
    expect(after?.metadata?.notificationsMuted).toBe(true);
  });

  it('does not disturb other metadata fields when toggling mute', () => {
    // Seed unrelated metadata first.
    store.getState().updateWorkspaceMetadata(wsId, {
      cwd: 'D:/wmux',
      gitBranch: 'main',
      lastNotification: 1234567890,
    });

    // Then flip mute.
    store.getState().updateWorkspaceMetadata(wsId, { notificationsMuted: true });

    const ws = store.getState().workspaces.find((w) => w.id === wsId);
    expect(ws?.metadata?.cwd).toBe('D:/wmux');
    expect(ws?.metadata?.gitBranch).toBe('main');
    expect(ws?.metadata?.lastNotification).toBe(1234567890);
    expect(ws?.metadata?.notificationsMuted).toBe(true);

    // And clearing mute leaves the rest intact.
    store.getState().updateWorkspaceMetadata(wsId, { notificationsMuted: false });
    const ws2 = store.getState().workspaces.find((w) => w.id === wsId);
    expect(ws2?.metadata?.cwd).toBe('D:/wmux');
    expect(ws2?.metadata?.gitBranch).toBe('main');
    expect(ws2?.metadata?.lastNotification).toBe(1234567890);
    expect(ws2?.metadata?.notificationsMuted).toBe(false);
  });

  it('setting mute on a non-existent workspaceId is a silent no-op (no throw)', () => {
    expect(() =>
      store.getState().updateWorkspaceMetadata('does-not-exist', { notificationsMuted: true }),
    ).not.toThrow();

    // And nothing was published.
    expect(publishCalls).toHaveLength(0);

    // And the real workspace is unaffected.
    const ws = store.getState().workspaces.find((w) => w.id === wsId);
    expect(ws?.metadata?.notificationsMuted).toBeUndefined();
  });

  it('toggling true → false → true preserves correct state across cycles', () => {
    store.getState().updateWorkspaceMetadata(wsId, { notificationsMuted: true });
    expect(
      store.getState().workspaces.find((w) => w.id === wsId)?.metadata?.notificationsMuted,
    ).toBe(true);

    store.getState().updateWorkspaceMetadata(wsId, { notificationsMuted: false });
    expect(
      store.getState().workspaces.find((w) => w.id === wsId)?.metadata?.notificationsMuted,
    ).toBe(false);

    store.getState().updateWorkspaceMetadata(wsId, { notificationsMuted: true });
    expect(
      store.getState().workspaces.find((w) => w.id === wsId)?.metadata?.notificationsMuted,
    ).toBe(true);
  });
});

// FIX #1 — workspace-level lifecycle clear of paneNotificationRing. closePane
// covers the pane-level case (CEO A7 stamp). Phase 4 review found that
// removeWorkspace and setActiveWorkspace (auto-mark-read) leaked stale ring
// entries so rings stayed 'glow' permanently on workspaces the user had
// already cleared.
describe('workspaceSlice — paneNotificationRing lifecycle (FIX #1 + FIX #3)', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
    // Add a second workspace so removeWorkspace is allowed (one-workspace
    // floor short-circuits the action).
    store.getState().addWorkspace('Second');
  });

  it('removeWorkspace deletes ring entries for every leaf pane in the tree', () => {
    const wsToRemove = store.getState().workspaces[1];
    const leafId = wsToRemove.rootPane.id;
    // Pre-seed ring entries for the leaf about to be deleted AND a survivor
    // leaf on another workspace. After removal the survivor must stay.
    const survivorLeafId = store.getState().workspaces[0].rootPane.id;
    store.setState((s) => {
      (s as unknown as { paneNotificationRing: Record<string, 'flash' | 'glow'> })
        .paneNotificationRing = { [leafId]: 'glow', [survivorLeafId]: 'flash' };
    });

    store.getState().removeWorkspace(wsToRemove.id);

    const ring = (store.getState() as unknown as { paneNotificationRing: Record<string, unknown> })
      .paneNotificationRing;
    expect(ring[leafId]).toBeUndefined();
    expect(ring[survivorLeafId]).toBe('flash');
  });

  it('removeWorkspace handles a branch tree by walking every leaf', () => {
    // Build a workspace with a synthetic branch so we exercise the
    // collectLeafIds recursion path (not just the root-leaf case).
    const wsToRemove = store.getState().workspaces[1];
    store.setState((s) => {
      const ws = s.workspaces.find((w) => w.id === wsToRemove.id);
      if (!ws) return;
      ws.rootPane = {
        id: 'branch-1',
        type: 'branch',
        direction: 'horizontal',
        children: [
          { id: 'leaf-a', type: 'leaf', surfaces: [], activeSurfaceId: '' },
          { id: 'leaf-b', type: 'leaf', surfaces: [], activeSurfaceId: '' },
        ],
        sizes: [50, 50],
      };
      (s as unknown as { paneNotificationRing: Record<string, 'flash' | 'glow'> })
        .paneNotificationRing = { 'leaf-a': 'flash', 'leaf-b': 'glow' };
    });

    store.getState().removeWorkspace(wsToRemove.id);

    const ring = (store.getState() as unknown as { paneNotificationRing: Record<string, unknown> })
      .paneNotificationRing;
    expect(ring['leaf-a']).toBeUndefined();
    expect(ring['leaf-b']).toBeUndefined();
  });

  it('removeWorkspace is a no-op for the ring when paneSlice is not mounted', () => {
    // Test store doesn't compose paneSlice — by default `paneNotificationRing`
    // is undefined. The guarded delete must not throw.
    const wsToRemove = store.getState().workspaces[1];
    expect(() => store.getState().removeWorkspace(wsToRemove.id)).not.toThrow();
  });

  it('setActiveWorkspace clears ring entries for the newly activated workspace', () => {
    const wsA = store.getState().workspaces[0];
    const wsB = store.getState().workspaces[1];
    store.setState((s) => {
      (s as unknown as { paneNotificationRing: Record<string, 'flash' | 'glow'> })
        .paneNotificationRing = {
        [wsA.rootPane.id]: 'glow',
        [wsB.rootPane.id]: 'flash',
      };
      // Seed notifications so the auto-mark-read branch executes too. Without
      // the array, the slice would short-circuit before reaching the ring clear.
      (s as unknown as { notifications: unknown[] }).notifications = [];
    });

    store.getState().setActiveWorkspace(wsB.id);

    const ring = (store.getState() as unknown as { paneNotificationRing: Record<string, unknown> })
      .paneNotificationRing;
    // wsB ring cleared; wsA still present.
    expect(ring[wsB.rootPane.id]).toBeUndefined();
    expect(ring[wsA.rootPane.id]).toBe('glow');
  });
});
