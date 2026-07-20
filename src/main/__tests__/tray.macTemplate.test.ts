import { describe, it, expect, vi, beforeEach } from 'vitest';

// Putting icon.icns (based on 1024px) into the menu bar as-is renders it
// abnormally large (owner-reported 2026-07-19) — this locks that it's resized to
// 22x22 on mac only. It's a multi-color logo, so we don't use setTemplateImage()
// (forcing it without a dedicated monochrome asset risks it collapsing into a black
// silhouette).

const resizeMock = vi.fn().mockReturnThis();
const trayImageMock = { resize: resizeMock };

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    setAboutPanelOptions: vi.fn(),
  },
  Tray: class {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
  },
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: { createFromPath: vi.fn(() => trayImageMock) },
  BrowserWindow: vi.fn(),
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: {},
}));

describe('createTray macOS icon sizing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resizeMock.mockReturnValue(trayImageMock);
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
  });

  it('macOS: resizes the tray image to 22x22 (menu bar size)', async () => {
    const { createTray } = await import('../tray');
    const fakeWindow = { show: vi.fn(), focus: vi.fn() } as unknown as import('electron').BrowserWindow;
    createTray(fakeWindow, { onQuit: vi.fn(), onShutdownAll: vi.fn() });
    expect(resizeMock).toHaveBeenCalledWith({ width: 22, height: 22 });
  });
});
