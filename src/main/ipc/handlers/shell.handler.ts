import { ipcMain } from 'electron';
import { ShellDetector } from '../../pty/ShellDetector';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';

export function registerShellHandlers(): () => void {
  const detector = new ShellDetector();

  ipcMain.removeHandler(IPC.SHELL_LIST);
  ipcMain.handle(IPC.SHELL_LIST, wrapHandler(IPC.SHELL_LIST, (_event: Electron.IpcMainInvokeEvent) => {
    return detector.detect();
  }));

  return () => {
    ipcMain.removeHandler(IPC.SHELL_LIST);
  };
}
