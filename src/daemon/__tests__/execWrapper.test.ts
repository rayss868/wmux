import { describe, it, expect } from 'vitest';
import { buildExecArgs } from '../execWrapper';

// X8 exec-style panes: argv synthesis per wrapper-shell family. The exit-code
// propagation contract here is what makes `restart: on-failure` meaningful —
// the wrapper's exit code must BE the command's exit code.
describe('buildExecArgs', () => {
  const CMD = 'claude /loop --until done';

  it('pwsh family gets an explicit $LASTEXITCODE propagation tail', () => {
    for (const shell of [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'pwsh.exe',
      'pwsh',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]) {
      expect(buildExecArgs(shell, CMD)).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-Command',
        `${CMD}; exit $LASTEXITCODE`,
      ]);
    }
  });

  it('cmd.exe gets /d /s /c (native child exit-code propagation, AutoRun skipped)', () => {
    expect(buildExecArgs('C:\\Windows\\System32\\cmd.exe', CMD)).toEqual(['/d', '/s', '/c', CMD]);
  });

  it('POSIX families get -lc (login PATH + native exit-status propagation)', () => {
    for (const shell of ['/bin/bash', '/usr/bin/zsh', '/bin/sh', '/bin/dash', '/usr/bin/ksh', '/usr/local/bin/fish']) {
      expect(buildExecArgs(shell, CMD)).toEqual(['-lc', CMD]);
    }
  });

  it('strips the login-shell dash prefix before classifying', () => {
    expect(buildExecArgs('-zsh', CMD)).toEqual(['-lc', CMD]);
  });

  it('returns null for unknown families instead of guessing argv', () => {
    expect(buildExecArgs('C:\\tools\\nu.exe', CMD)).toBeNull();
    expect(buildExecArgs('/usr/bin/nu', CMD)).toBeNull();
    expect(buildExecArgs('', CMD)).toBeNull();
  });
});
