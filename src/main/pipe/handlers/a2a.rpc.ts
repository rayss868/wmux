import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { sendToRenderer } from './_bridge';
import type { ClaudeWorker } from '../../a2a/ClaudeWorker';
import * as fs from 'fs';
import { getPidMapDir } from '../../../shared/constants';

type GetWindow = () => BrowserWindow | null;

export function registerA2aRpc(router: RpcRouter, getWindow: GetWindow, claudeWorker: ClaudeWorker): void {
  // a2a.resolve.identity — handled in main process (not renderer)
  // Returns all known sessionId/PID → workspaceId mappings so MCP can resolve itself
  router.register('a2a.resolve.identity', async () => {
    const dir = getPidMapDir();
    const mappings: Record<string, string> = {};
    try {
      if (fs.existsSync(dir)) {
        for (const file of fs.readdirSync(dir)) {
          const wsId = fs.readFileSync(`${dir}/${file}`, 'utf8').trim();
          if (wsId) mappings[file] = wsId;
        }
      }
    } catch { /* best-effort */ }
    return { mappings };
  });

  // A2A protocol — passthrough to renderer
  router.register('a2a.whoami', (params) => sendToRenderer(getWindow, 'a2a.whoami', params));
  router.register('a2a.discover', (params) => sendToRenderer(getWindow, 'a2a.discover', params));
  router.register('a2a.task.query', (params) => sendToRenderer(getWindow, 'a2a.task.query', params));
  router.register('a2a.task.update', (params) => sendToRenderer(getWindow, 'a2a.task.update', params));
  router.register('a2a.broadcast', (params) => sendToRenderer(getWindow, 'a2a.broadcast', params));
  router.register('meta.setSkills', (params) => sendToRenderer(getWindow, 'meta.setSkills', params));

  // task.send: store via renderer + background execution for new tasks
  router.register('a2a.task.send', async (params) => {
    // 1) Save task to store + deliver via PTY paste (renderer handles both)
    const result = await sendToRenderer(getWindow, 'a2a.task.send', params);

    // 2) Background execution only when explicitly requested (execute: true)
    //    AND user has approved via the confirmation dialog. The Claude CLI is
    //    spawned with --permission-mode bypassPermissions so any external MCP
    //    caller flipping execute:true would otherwise gain unattended RCE.
    if (params.execute) {
      const taskId = (result as Record<string, unknown>)?.taskId as string | undefined;
      if (taskId && !params.taskId) {
        const senderWsId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
        const receiverWsId = typeof params.to === 'string' ? params.to : '';
        const message = typeof params.message === 'string' ? params.message : '';
        const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;

        let approved = false;
        try {
          const decision = await sendToRenderer(
            getWindow,
            'a2a.confirmExecute',
            {
              taskId,
              senderWorkspaceId: senderWsId,
              receiverWorkspaceId: receiverWsId,
              messagePreview: message.slice(0, 500),
              cwd: cwd ?? null,
            },
            { timeoutMs: 35_000 },
          );
          approved = (decision as { approved?: boolean } | null)?.approved === true;
        } catch (err) {
          console.warn(`[a2a.rpc] confirmExecute failed for task ${taskId}:`, err);
          approved = false;
        }

        if (approved) {
          claudeWorker.execute(taskId, receiverWsId, message, cwd).catch((err) => {
            console.error(`[a2a.rpc] Background worker failed for task ${taskId}:`, err);
          });
        } else {
          // Mark task canceled so the sender's a2a_task_query reflects the
          // denial. The original message delivery still happened in step 1.
          await sendToRenderer(getWindow, 'a2a.task.cancel', {
            taskId,
            workspaceId: receiverWsId,
          }).catch(() => { /* best-effort */ });
        }
      }
    }

    return result;
  });

  // task.cancel: cancel worker + update store
  router.register('a2a.task.cancel', async (params) => {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    if (taskId) claudeWorker.cancel(taskId);
    return sendToRenderer(getWindow, 'a2a.task.cancel', params);
  });
}
