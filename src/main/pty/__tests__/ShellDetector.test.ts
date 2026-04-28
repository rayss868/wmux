import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';

// Hoisted mutable state shared between the vi.mock factory and the tests.
const platformState = vi.hoisted(() => {
  const state = {
    isWindows: process.platform === 'win32',
    isMac: process.platform === 'darwin',
    isLinux: process.platform === 'linux',
  };
  return {
    state,
    set(p: 'win32' | 'darwin' | 'linux'): void {
      state.isWindows = p === 'win32';
      state.isMac = p === 'darwin';
      state.isLinux = p === 'linux';
    },
  };
});

vi.mock('../../../shared/platform', () => ({
  get isWindows() { return platformState.state.isWindows; },
  get isMac() { return platformState.state.isMac; },
  get isLinux() { return platformState.state.isLinux; },
  get isUnix() { return !platformState.state.isWindows; },
  platformChoice<T>(choices: { win?: T; mac?: T; linux?: T; default: T }): T {
    if (platformState.state.isWindows && choices.win !== undefined) return choices.win;
    if (platformState.state.isMac && choices.mac !== undefined) return choices.mac;
    if (platformState.state.isLinux && choices.linux !== undefined) return choices.linux;
    return choices.default;
  },
}));

import { ShellDetector } from '../ShellDetector';

describe('ShellDetector', () => {
  let existsSpy: ReturnType<typeof vi.spyOn>;
  let originalShell: string | undefined;

  beforeEach(() => {
    existsSpy = vi.spyOn(fs, 'existsSync');
    originalShell = process.env.SHELL;
  });

  afterEach(() => {
    existsSpy.mockRestore();
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  });

  describe('mac', () => {
    beforeEach(() => {
      platformState.set('darwin');
    });

    it('prefers $SHELL when it exists', () => {
      process.env.SHELL = '/bin/zsh';
      existsSpy.mockImplementation((p: fs.PathLike) => p === '/bin/zsh' || p === '/bin/bash');
      const detector = new ShellDetector();
      const shells = detector.detect();
      expect(shells[0].path).toBe('/bin/zsh');
      expect(shells[0].name).toBe('Zsh');
    });

    it('finds /bin/bash and homebrew pwsh', () => {
      delete process.env.SHELL;
      existsSpy.mockImplementation((p: fs.PathLike) =>
        p === '/bin/bash' || p === '/opt/homebrew/bin/pwsh',
      );
      const detector = new ShellDetector();
      const shells = detector.detect();
      const paths = shells.map((s) => s.path);
      expect(paths).toContain('/bin/bash');
      expect(paths).toContain('/opt/homebrew/bin/pwsh');
      expect(shells.find((s) => s.path === '/opt/homebrew/bin/pwsh')?.name).toBe('PowerShell 7');
    });

    it('does not include windows-only shells', () => {
      delete process.env.SHELL;
      existsSpy.mockReturnValue(true);
      const detector = new ShellDetector();
      const shells = detector.detect();
      for (const s of shells) {
        expect(s.path.toLowerCase()).not.toContain('cmd.exe');
        expect(s.path.toLowerCase()).not.toContain('powershell.exe');
        expect(s.path.toLowerCase()).not.toContain('wsl.exe');
      }
    });

    it('getDefault falls back to /bin/zsh when nothing found', () => {
      delete process.env.SHELL;
      existsSpy.mockReturnValue(false);
      const detector = new ShellDetector();
      expect(detector.getDefault()).toBe('/bin/zsh');
    });
  });

  describe('linux', () => {
    beforeEach(() => {
      platformState.set('linux');
    });

    it('prefers $SHELL when it exists', () => {
      process.env.SHELL = '/usr/bin/fish';
      existsSpy.mockImplementation((p: fs.PathLike) => p === '/usr/bin/fish' || p === '/bin/bash');
      const detector = new ShellDetector();
      const shells = detector.detect();
      expect(shells[0].path).toBe('/usr/bin/fish');
      expect(shells[0].name).toBe('Fish');
    });

    it('detects bash, zsh, fish, pwsh from canonical paths', () => {
      delete process.env.SHELL;
      const present = new Set([
        '/bin/bash',
        '/bin/zsh',
        '/usr/bin/fish',
        '/usr/bin/pwsh',
      ]);
      existsSpy.mockImplementation((p: fs.PathLike) => present.has(String(p)));
      const detector = new ShellDetector();
      const shells = detector.detect();
      const paths = shells.map((s) => s.path);
      expect(paths).toEqual(expect.arrayContaining([
        '/bin/bash',
        '/bin/zsh',
        '/usr/bin/fish',
        '/usr/bin/pwsh',
      ]));
    });

    it('getDefault falls back to /bin/bash when nothing found', () => {
      delete process.env.SHELL;
      existsSpy.mockReturnValue(false);
      const detector = new ShellDetector();
      expect(detector.getDefault()).toBe('/bin/bash');
    });
  });

  describe('windows', () => {
    beforeEach(() => {
      platformState.set('win32');
    });

    it('does not include unix-only shells', () => {
      existsSpy.mockReturnValue(true);
      const detector = new ShellDetector();
      const shells = detector.detect();
      for (const s of shells) {
        expect(s.path).not.toBe('/bin/bash');
        expect(s.path).not.toBe('/bin/zsh');
        expect(s.path).not.toBe('/usr/bin/fish');
      }
    });
  });
});
