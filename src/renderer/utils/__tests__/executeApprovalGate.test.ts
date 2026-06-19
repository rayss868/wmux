// @vitest-environment jsdom
//
// Runtime coverage for the renderer-side execute approval gate. The
// useRpcBridge.a2aPaneIdentity test is structural (source-regex); this drives
// the actual Promise/queue/timer behavior so the gate's security-critical paths
// (YOLO short-circuit, approve, deny, 30s auto-deny, concurrent independence)
// are exercised end-to-end.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestExecuteApproval } from '../executeApprovalGate';
import { useStore } from '../../stores';
import { resolveExecuteApproval, hasPendingExecuteApproval } from '../executeApproval';

const INPUT = {
  taskId: 'task-1',
  senderWorkspaceId: 'ws-from',
  receiverWorkspaceId: 'ws-to',
  messagePreview: 'run the build',
  cwd: null,
};

function resetGate() {
  const s = useStore.getState();
  s.setA2aAutoApproveExecute(false);
  for (const id of [...s.pendingExecuteApprovalOrder]) s.removeExecuteApproval(id);
}

describe('requestExecuteApproval (renderer execute gate)', () => {
  beforeEach(resetGate);

  it('short-circuits to approved when YOLO is on, enqueuing nothing', async () => {
    useStore.getState().setA2aAutoApproveExecute(true);
    await expect(requestExecuteApproval(INPUT)).resolves.toBe(true);
    expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(0);
  });

  it('enqueues a prompt and resolves true when the user approves', async () => {
    const p = requestExecuteApproval(INPUT);
    const order = useStore.getState().pendingExecuteApprovalOrder;
    expect(order).toHaveLength(1);
    const approvalId = order[0];
    expect(hasPendingExecuteApproval(approvalId)).toBe(true);

    resolveExecuteApproval(approvalId, true);
    await expect(p).resolves.toBe(true);
    // settle() clears both the queue row and the parked resolver.
    expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(0);
    expect(hasPendingExecuteApproval(approvalId)).toBe(false);
  });

  it('resolves false when the user denies', async () => {
    const p = requestExecuteApproval(INPUT);
    const approvalId = useStore.getState().pendingExecuteApprovalOrder[0];
    resolveExecuteApproval(approvalId, false);
    await expect(p).resolves.toBe(false);
    expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(0);
  });

  it('auto-denies after the 30s timeout', async () => {
    vi.useFakeTimers();
    try {
      const p = requestExecuteApproval(INPUT);
      expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toBe(false);
      expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps two concurrent requests independent', async () => {
    const p1 = requestExecuteApproval({ ...INPUT, taskId: 'task-1' });
    const p2 = requestExecuteApproval({ ...INPUT, taskId: 'task-2' });
    const order = [...useStore.getState().pendingExecuteApprovalOrder];
    expect(order).toHaveLength(2);

    // Approve the second, deny the first — identities must not cross.
    resolveExecuteApproval(order[1], true);
    resolveExecuteApproval(order[0], false);
    await expect(p2).resolves.toBe(true);
    await expect(p1).resolves.toBe(false);
    expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(0);
  });
});
