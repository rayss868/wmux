import { ipcMain, type BrowserWindow } from 'electron';
import { PTYManager } from '../pty/PTYManager';
import { PTYBridge } from '../pty/PTYBridge';
import { DaemonClient } from '../DaemonClient';
import { McpRegistrar } from '../mcp/McpRegistrar';
import { registerPTYHandlers } from './handlers/pty.handler';
import { registerSessionHandlers } from './handlers/session.handler';
import { registerShellHandlers } from './handlers/shell.handler';
import { registerMetadataHandlers } from './handlers/metadata.handler';
import { registerClipboardHandlers } from './handlers/clipboard.handler';
import { registerFsHandlers } from './handlers/fs.handler';
import { registerMcpHandlers } from './handlers/mcp.handler';
import { IPC } from '../../shared/constants';
import { toastManager } from '../pipe/handlers/notify.rpc';
import { eventBus } from '../events/EventBus';
import { WMUX_EVENT_TYPES, type WmuxEventType } from '../../shared/events';

const EVENT_TYPE_SET = new Set<WmuxEventType>(WMUX_EVENT_TYPES);

export interface RegisterHandlersOptions {
  /** McpRegistrar instance shared with main/index — exposes Settings MCP IPC. */
  mcpRegistrar?: McpRegistrar;
  /** Lazy accessor for the live pipe-server auth token, used by mcp:reregister. */
  getMcpAuthToken?: () => string | null;
}

export function registerAllHandlers(
  ptyManager: PTYManager,
  ptyBridge: PTYBridge,
  getWindow: () => BrowserWindow | null,
  daemonClient?: DaemonClient,
  options: RegisterHandlersOptions = {},
): () => void {
  const cleanupPty = registerPTYHandlers(ptyManager, ptyBridge, daemonClient, getWindow);
  const cleanupSession = registerSessionHandlers();
  const cleanupShell = registerShellHandlers();
  const cleanupMetadata = registerMetadataHandlers(ptyManager, getWindow);
  registerClipboardHandlers();
  const cleanupFs = registerFsHandlers();
  const cleanupMcp = options.mcpRegistrar
    ? registerMcpHandlers(options.mcpRegistrar, options.getMcpAuthToken ?? (() => null))
    : null;

  // Sync toast setting from renderer
  const onToastEnabled = (_event: Electron.IpcMainEvent, enabled: boolean): void => {
    toastManager.enabled = enabled;
  };
  ipcMain.removeAllListeners(IPC.TOAST_ENABLED);
  ipcMain.on(IPC.TOAST_ENABLED, onToastEnabled);

  // Window hide (prefix-d detach)
  const onWindowHide = (): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.hide();
  };
  ipcMain.removeAllListeners(IPC.WINDOW_HIDE);
  ipcMain.on(IPC.WINDOW_HIDE, onWindowHide);

  // EventBus publish from renderer (one-way). Validates the event type and
  // workspaceId at the trust boundary so a misbehaving renderer can't poison
  // the ring with arbitrary shapes; type-specific fields ride through as-is.
  const onEventsPublish = (_event: Electron.IpcMainEvent, input: unknown): void => {
    if (!input || typeof input !== 'object') return;
    const obj = input as Record<string, unknown>;
    const type = obj['type'];
    const workspaceId = obj['workspaceId'];
    if (typeof type !== 'string' || !EVENT_TYPE_SET.has(type as WmuxEventType)) return;
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) return;
    try {
      eventBus.emit({ ...obj, type: type as WmuxEventType, workspaceId });
    } catch {
      // Telemetry must not crash the IPC channel — swallow and move on.
    }
  };
  ipcMain.removeAllListeners(IPC.EVENTS_PUBLISH);
  ipcMain.on(IPC.EVENTS_PUBLISH, onEventsPublish);

  return () => {
    cleanupPty();
    cleanupSession();
    cleanupShell();
    cleanupMetadata();
    cleanupFs();
    if (cleanupMcp) cleanupMcp();
    ipcMain.removeAllListeners(IPC.TOAST_ENABLED);
    ipcMain.removeAllListeners(IPC.WINDOW_HIDE);
  };
}
