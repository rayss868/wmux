import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerA2aRpc } from '../a2a.rpc';
import type { ClaudeWorker } from '../../../a2a/ClaudeWorker';

const { sendToRendererMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

vi.mock('../../../../shared/constants', () => ({
  getPidMapDir: () => '/tmp/wmux-test-pidmap',
}));

const fakeWindow = {} as BrowserWindow;

function makeWorker(): ClaudeWorker & { execute: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockReturnValue(true),
    isFull: false,
    stop: vi.fn(),
  } as unknown as ClaudeWorker & { execute: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
}

function setupRouter(worker: ClaudeWorker): RpcRouter {
  const router = new RpcRouter();
  registerA2aRpc(router, () => fakeWindow, worker);
  return router;
}

describe('a2a.rpc — execute confirmation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT spawn worker when execute is false', async () => {
    sendToRendererMock.mockResolvedValueOnce({ taskId: 'task-1' });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-1',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'hi' },
    });

    expect(worker.execute).not.toHaveBeenCalled();
    // Only the initial a2a.task.send passthrough — no confirmExecute, no cancel
    const methods = sendToRendererMock.mock.calls.map((c) => c[1]);
    expect(methods).toEqual(['a2a.task.send']);
  });

  it('spawns worker when renderer reports pre-create execute approval', async () => {
    sendToRendererMock.mockResolvedValueOnce({
      ok: true,
      taskId: 'task-2',
      toWorkspaceId: 'ws-to-resolved',
      executeApproved: true,
    });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-2',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'run this', execute: true, cwd: '/tmp/foo' },
    });

    expect(worker.execute).toHaveBeenCalledWith('task-2', 'ws-to-resolved', 'run this', '/tmp/foo');
    const methods = sendToRendererMock.mock.calls.map((c) => c[1]);
    expect(methods).toEqual(['a2a.task.send']);
  });

  it('skips worker and does not cancel when renderer denies before task creation', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: false, error: 'a2a.task.send: execute approval denied' });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-3',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'do bad things', execute: true },
    });

    expect(worker.execute).not.toHaveBeenCalled();
    const calls = sendToRendererMock.mock.calls.map((c) => ({ method: c[1], params: c[2] }));
    expect(calls.map((c) => c.method)).toEqual(['a2a.task.send']);
  });

  it('does not spawn when executeApproved is absent', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: true, taskId: 'task-4', toWorkspaceId: 'ws-to' });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-4',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'no answer', execute: true },
    });

    expect(worker.execute).not.toHaveBeenCalled();
    const methods = sendToRendererMock.mock.calls.map((c) => c[1]);
    expect(methods).toEqual(['a2a.task.send']);
  });

  it('does not spawn for replies even if execute:true is present', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: false, error: 'a2a.task.send: execute is only supported for new tasks' });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-5',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', taskId: 'existing-task', message: 'reply', execute: true },
    });

    expect(worker.execute).not.toHaveBeenCalled();
    const methods = sendToRendererMock.mock.calls.map((c) => c[1]);
    expect(methods).toEqual(['a2a.task.send']);
  });

  it('ignores truthy non-boolean execute values', async () => {
    sendToRendererMock.mockResolvedValueOnce({ ok: true, taskId: 'task-6', toWorkspaceId: 'ws-to', executeApproved: true });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-6',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'do not execute', execute: 'true' },
    });

    expect(worker.execute).not.toHaveBeenCalled();
  });
});
