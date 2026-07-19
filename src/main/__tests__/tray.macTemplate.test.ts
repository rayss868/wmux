import { describe, it, expect, vi, beforeEach } from 'vitest';

// icon.icns(1024px 기반)를 원본 그대로 메뉴바에 넣으면 비정상적으로 크게
// 렌더된다(owner-reported 2026-07-19) — mac에서만 22x22로 리사이즈하는지
// 고정한다. 다색 로고라 setTemplateImage()는 쓰지 않는다(전용 모노크롬
// 에셋 없이 강제하면 검은 실루엣으로 뭉개질 위험).

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
