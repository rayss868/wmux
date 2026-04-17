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
        readFile: (filePath: string) => Promise<string | null>;
        writeFile: (filePath: string, content: string) => Promise<boolean>;
        watch: (dirPath: string) => Promise<boolean>;
        unwatch: (dirPath: string) => Promise<void>;
        onChanged: (callback: (dirPath: string) => void) => () => void;
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
