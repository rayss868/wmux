import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createA2aSlice, type A2aSlice } from '../a2aSlice';
import type { Message } from '../../../../shared/types';

type TestState = A2aSlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createA2aSlice(...args),
    }))
  );
}

function makeMessage(text: string): Message {
  return { kind: 'message', messageId: 'msg-1', role: 'user', parts: [{ kind: 'text', text }] };
}

describe('a2aSlice — cancelTask permissions', () => {
  let store: ReturnType<typeof createTestStore>;
  let taskId: string;

  beforeEach(() => {
    store = createTestStore();
    taskId = store.getState().createA2aTask({
      title: 'Test',
      from: { workspaceId: 'ws-sender', name: 'Sender' },
      to: { workspaceId: 'ws-receiver', name: 'Receiver' },
      history: [makeMessage('hello')],
      artifacts: [],
    });
  });

  it('allows the sender to cancel', () => {
    const result = store.getState().cancelTask(taskId, 'ws-sender');
    expect(result.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('canceled');
  });

  it('allows the receiver to cancel (deny incoming task)', () => {
    const result = store.getState().cancelTask(taskId, 'ws-receiver');
    expect(result.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('canceled');
  });

  it('rejects unrelated workspaces', () => {
    const result = store.getState().cancelTask(taskId, 'ws-stranger');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not sender or receiver/);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('submitted');
  });

  it('rejects unknown task ids', () => {
    const result = store.getState().cancelTask('task-does-not-exist', 'ws-sender');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});

describe('a2aSlice — pendingExecuteApproval', () => {
  it('starts null and round-trips through setter', () => {
    const store = createTestStore();
    expect(store.getState().pendingExecuteApproval).toBeNull();

    store.getState().setPendingExecuteApproval({
      taskId: 'task-1',
      senderWorkspaceId: 'ws-from',
      receiverWorkspaceId: 'ws-to',
      messagePreview: 'hi',
      cwd: '/tmp',
      expiresAt: Date.now() + 30_000,
    });
    expect(store.getState().pendingExecuteApproval?.taskId).toBe('task-1');

    store.getState().setPendingExecuteApproval(null);
    expect(store.getState().pendingExecuteApproval).toBeNull();
  });
});
