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

  it('spawns worker when user approves the confirm prompt', async () => {
    sendToRendererMock
      .mockResolvedValueOnce({ taskId: 'task-2' })   // a2a.task.send
      .mockResolvedValueOnce({ approved: true });    // a2a.confirmExecute
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-2',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'run this', execute: true, cwd: '/tmp/foo' },
    });

    expect(worker.execute).toHaveBeenCalledWith('task-2', 'ws-to', 'run this', '/tmp/foo');
    const methods = sendToRendererMock.mock.calls.map((c) => c[1]);
    expect(methods).toEqual(['a2a.task.send', 'a2a.confirmExecute']);

    // confirmExecute payload carries the right fields for the dialog
    const confirmCall = sendToRendererMock.mock.calls.find((c) => c[1] === 'a2a.confirmExecute');
    expect(confirmCall?.[2]).toMatchObject({
      taskId: 'task-2',
      senderWorkspaceId: 'ws-from',
      receiverWorkspaceId: 'ws-to',
      messagePreview: 'run this',
      cwd: '/tmp/foo',
    });
    // Long timeout requested for the user prompt
    expect(confirmCall?.[3]).toEqual({ timeoutMs: 35_000 });
  });

  it('cancels task and skips worker when user denies', async () => {
    sendToRendererMock
      .mockResolvedValueOnce({ taskId: 'task-3' })   // a2a.task.send
      .mockResolvedValueOnce({ approved: false })    // a2a.confirmExecute
      .mockResolvedValueOnce({ ok: true });          // a2a.task.cancel
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-3',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'do bad things', execute: true },
    });

    expect(worker.execute).not.toHaveBeenCalled();
    const calls = sendToRendererMock.mock.calls.map((c) => ({ method: c[1], params: c[2] }));
    expect(calls.map((c) => c.method)).toEqual(['a2a.task.send', 'a2a.confirmExecute', 'a2a.task.cancel']);
    expect(calls[2].params).toMatchObject({ taskId: 'task-3', workspaceId: 'ws-to' });
  });

  it('treats confirmExecute timeout/error as denial', async () => {
    sendToRendererMock
      .mockResolvedValueOnce({ taskId: 'task-4' })                                     // a2a.task.send
      .mockRejectedValueOnce(new Error('RPC timeout: a2a.confirmExecute (35000ms)'))   // a2a.confirmExecute
      .mockResolvedValueOnce({ ok: true });                                            // a2a.task.cancel
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-4',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: 'no answer', execute: true },
    });

    expect(worker.execute).not.toHaveBeenCalled();
    const methods = sendToRendererMock.mock.calls.map((c) => c[1]);
    expect(methods).toEqual(['a2a.task.send', 'a2a.confirmExecute', 'a2a.task.cancel']);
  });

  it('does not gate replies (execute:true on existing taskId is ignored regardless)', async () => {
    sendToRendererMock.mockResolvedValueOnce({ taskId: 'existing-task' });
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

  it('truncates messagePreview in confirmExecute payload', async () => {
    const longMessage = 'x'.repeat(800);
    sendToRendererMock
      .mockResolvedValueOnce({ taskId: 'task-6' })
      .mockResolvedValueOnce({ approved: false })
      .mockResolvedValueOnce({ ok: true });
    const worker = makeWorker();
    const router = setupRouter(worker);

    await router.dispatch({
      id: 'rpc-6',
      method: 'a2a.task.send',
      params: { workspaceId: 'ws-from', to: 'ws-to', message: longMessage, execute: true },
    });

    const confirmCall = sendToRendererMock.mock.calls.find((c) => c[1] === 'a2a.confirmExecute');
    expect((confirmCall?.[2] as { messagePreview: string }).messagePreview.length).toBe(500);
  });
});
