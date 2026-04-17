import { app, Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import path from 'path';

let tray: Tray | null = null;

export function createTray(mainWindow: BrowserWindow, onQuit: () => void): Tray {
  // In packaged app, extraResource files land in <exe_dir>/resources/
  // In dev, assets are at project root: <__dirname>/../../assets/
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', '..', 'assets', 'icon.ico');

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
