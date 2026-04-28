import { app, Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import path from 'path';
import { platformChoice } from '../shared/platform';

let tray: Tray | null = null;

export function createTray(mainWindow: BrowserWindow, onQuit: () => void): Tray {
  // In packaged app, extraResource files land in <exe_dir>/resources/
  // In dev, assets are at project root: <__dirname>/../../assets/
  //
  // OS-aware extension: Windows -> .ico, macOS -> .icns, Linux/other -> .png.
  // The actual non-Windows image files are produced by a separate asset pipeline
  // (Phase 1.1 generate-icon.js). If the resolved file is missing on a given
  // platform, Electron falls back to a default tray image rather than throwing.
  const iconExt = platformChoice<string>({ win: 'ico', mac: 'icns', linux: 'png', default: 'png' });
  const iconFile = `icon.${iconExt}`;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, iconFile)
    : path.join(__dirname, '..', '..', 'assets', iconFile);

  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('wmux');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open wmux',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        onQuit();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  return tray;
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
