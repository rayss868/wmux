import type { BrowserWindow } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import type { NotificationType } from '../../../shared/types';
import { toastManager } from '../../notification/ToastManager';
import { dispatchNotification } from '../../notification/dispatchNotification';

type GetWindow = () => BrowserWindow | null;

const VALID_TYPES = new Set<NotificationType>(['info', 'warning', 'error', 'agent']);

function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && VALID_TYPES.has(value as NotificationType);
}

// Re-export the singleton at its historical path — PTYBridge,
// DaemonNotificationRouter and pty.handler imported it from here long
// before the notification layer owned it.
export { toastManager };

export function registerNotifyRpc(router: RpcRouter, getWindow: GetWindow): void {
  /**
   * notify — delivers a notification to the renderer UI and, when the app is
   * not focused, also shows a Windows Toast notification.
   *
   * params: {
   *   title:        string
   *   body:         string
   *   type?:        'info' | 'warning' | 'error' | 'agent'  (default: 'info')
   *   workspaceId?: string  — optional. When omitted, the renderer applies
   *                           to the active workspace (backward compat for
   *                           CLI `wmux notify` callers; MCP clients that
   *                           know their workspace via mcp.claimWorkspace
   *                           SHOULD send it for precise routing)
   * }
   */
  router.register('notify', (params) => {
    if (typeof params['title'] !== 'string' || params['title'].length === 0) {
      throw new Error('notify: missing required param "title"');
    }
    if (typeof params['body'] !== 'string') {
      throw new Error('notify: missing required param "body"');
    }

    const title = params['title'];
    const body = params['body'];
    const type: NotificationType = isNotificationType(params['type'])
      ? params['type']
      : 'info';
    const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;

    // ptyId is null here — this RPC originates outside any PTY. The renderer
    // resolves a surface via `workspaceId` (if provided) or falls back to
    // the active workspace, and its notification policy decides every
    // surface — including the OS toast (osToast action when the window is
    // unfocused). With no renderer window at all, dispatchNotification
    // falls back to a direct OS toast.
    dispatchNotification(getWindow(), null, { title, body, type, workspaceId }, { workspaceId });

    return Promise.resolve({ delivered: true, type });
  });
}
