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
