import { ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC } from '../../../shared/constants';
import { SessionManager } from '../../session/SessionManager';
import type { SessionData } from '../../../shared/types';
import { wrapHandler } from '../wrapHandler';

/**
 * Module-level singleton. Exported so the main-process boot path
 * (`src/main/index.ts`) can wire its `saveMetadataSync` into the
 * `MetadataStore` persist callback (M0-e) and hydrate the store from
 * `metadata.json` on launch. Keep a single instance so the IPC handlers
 * and the metadata persistence path share the same `pendingData` /
 * debounce timer / queue state.
 */
export const sessionManager = new SessionManager();

export function registerSessionHandlers(): () => void {
  // Instrumentation: scrollback restore race investigation. This function is
  // called from `registerAllHandlers`, which is invoked both at module load
  // AND during the daemon-connect/disconnect handler swap in main/index.ts.
  // Logging the exact register/unregister boundaries lets us correlate any
  // renderer-side `scrollback.load` rejection ("No handler registered for
  // 'scrollback:load'") against the swap window timing.
  console.error(`[session.handler] register cycle: install (ts=${new Date().toISOString()})`);

  ipcMain.removeHandler(IPC.SESSION_SAVE);
  ipcMain.handle(IPC.SESSION_SAVE, wrapHandler(IPC.SESSION_SAVE, (_event: Electron.IpcMainInvokeEvent, data: SessionData) => {
    sessionManager.save(data);
    return { success: true };
  }));

  ipcMain.removeHandler(IPC.SESSION_LOAD);
  ipcMain.handle(IPC.SESSION_LOAD, wrapHandler(IPC.SESSION_LOAD, () => {
    return sessionManager.load();
  }));

  // scrollback:dump — write terminal buffer to file
  ipcMain.removeHandler(IPC.SCROLLBACK_DUMP);
  ipcMain.handle(IPC.SCROLLBACK_DUMP, wrapHandler(IPC.SCROLLBACK_DUMP, (_event: Electron.IpcMainInvokeEvent, surfaceId: string, content: string) => {
    // Validate surfaceId (alphanumeric + hyphens only, prevent path traversal)
    if (!/^[a-zA-Z0-9-]+$/.test(surfaceId)) return { success: false };
    const dir = path.join(app.getPath('userData'), 'scrollback');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${surfaceId}.txt`);
    // Cap at 5MB to prevent disk bloat
    const capped = content.length > 5 * 1024 * 1024 ? content.slice(-5 * 1024 * 1024) : content;
    fs.writeFileSync(filePath, capped, 'utf-8');
    return { success: true };
  }));

  // scrollback:load — read terminal buffer from file
  ipcMain.removeHandler(IPC.SCROLLBACK_LOAD);
  ipcMain.handle(IPC.SCROLLBACK_LOAD, wrapHandler(IPC.SCROLLBACK_LOAD, (_event: Electron.IpcMainInvokeEvent, surfaceId: string) => {
    if (!/^[a-zA-Z0-9-]+$/.test(surfaceId)) return null;
    const filePath = path.join(app.getPath('userData'), 'scrollback', `${surfaceId}.txt`);
    try {
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, 'utf-8');
      // Don't delete scrollback files here — they are overwritten by the
      // next periodic dump cycle (every 5s).  Deleting on load created a
      // window where a crash between load and the next dump would lose
      // all scrollback data because session.json still referenced the
      // (now-deleted) file.
      return content;
    } catch {
      return null;
    }
  }));

  return () => {
    // Instrumentation: see register-cycle log above. This is the window we
    // suspect the renderer's scrollback.load lands in during cold boot.
    console.error(`[session.handler] register cycle: uninstall (ts=${new Date().toISOString()})`);
    ipcMain.removeHandler(IPC.SESSION_SAVE);
    ipcMain.removeHandler(IPC.SESSION_LOAD);
    ipcMain.removeHandler(IPC.SCROLLBACK_DUMP);
    ipcMain.removeHandler(IPC.SCROLLBACK_LOAD);
  };
}
