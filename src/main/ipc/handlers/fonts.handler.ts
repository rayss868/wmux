import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { listInstalledFonts } from '../../fonts/installedFonts';

/**
 * `fonts:list` — best-effort enumeration of installed font families for the
 * Settings font picker. The enumeration logic (and its never-throws contract)
 * lives in ../../fonts/installedFonts.ts so it can be unit-tested without an
 * Electron runtime; this module only wires it to the IPC channel.
 */
export function registerFontHandlers(): () => void {
  ipcMain.removeHandler(IPC.FONTS_LIST);
  ipcMain.handle(
    IPC.FONTS_LIST,
    wrapHandler(IPC.FONTS_LIST, () => listInstalledFonts()),
  );

  return () => {
    ipcMain.removeHandler(IPC.FONTS_LIST);
  };
}
