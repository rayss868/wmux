import type { ElectronAPI } from '../preload/index';
import type { TokenEvent } from '../main/pty/TokenTracker';

declare global {
  interface Window {
    electronAPI: ElectronAPI & {
      onFileDrop: (callback: (paths: string[]) => void) => () => void;
      token?: {
        onUpdate: (callback: (ptyId: string, event: TokenEvent) => void) => () => void;
      };
      fs?: {
        readDir: (dirPath: string) => Promise<{ name: string; path: string; isDirectory: boolean; isSymlink: boolean }[]>;
      };
    };
    clipboardAPI: {
      writeText: (text: string) => Promise<void>;
      readText: () => Promise<string>;
      readImage: () => Promise<string | null>;
      hasImage: () => Promise<boolean>;
    };
  }
}
