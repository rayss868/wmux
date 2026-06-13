import path from 'node:path';

/**
 * X8 exec-style pane: build the wrapper-shell argv that runs `command` as
 * the pane's ROOT process (systemd ExecStart semantics) instead of typing
 * it into an interactive shell. Process = unit: when the command exits the
 * PTY exits, so `session:died` carries the command's own exit code and a
 * recovery/restart replay re-launches the command itself — without this an
 * agent loop crash is invisible (the parent shell survives) and a reboot
 * revives an empty shell instead of the loop.
 *
 * The wrapper shell binary is wmux's choice (the session's resolved shell),
 * NOT part of the trust surface — the trust-approved bytes are `command`.
 *
 * Exit-code propagation per family:
 *  - pwsh/powershell: `-Command "<cmd>; exit $LASTEXITCODE"`. pwsh's own
 *    exit code only reflects script success/failure, so propagate the last
 *    native command's code explicitly. When no native command ran,
 *    $LASTEXITCODE is $null and `exit $null` exits 0; a terminating script
 *    error makes pwsh exit 1 before the tail runs. `-NoProfile` keeps the
 *    unit start lean (PATH on Windows comes from the process env, not the
 *    profile, so command resolution is unaffected).
 *  - cmd: `/d /s /c <cmd>` propagates the child's exit code natively and
 *    `/d` skips AutoRun hooks.
 *  - POSIX shells (bash/zsh/sh/dash/ksh/fish): `-lc <cmd>` — the shell
 *    exits with the last command's status natively; `-l` loads the login
 *    profile so PATH additions (npm shims like `claude`) resolve.
 *
 * Returns null for an unrecognized family — the caller must swap the
 * wrapper to a known-good platform shell and retry, never guess argv.
 */
export function buildExecArgs(shellPath: string, command: string): string[] | null {
  const stem = path
    .basename(shellPath)
    .toLowerCase()
    .replace(/^-/, '') // login shells show up as '-zsh'
    .replace(/\.exe$/, '');

  if (stem === 'pwsh' || stem === 'powershell') {
    return ['-NoLogo', '-NoProfile', '-Command', `${command}; exit $LASTEXITCODE`];
  }
  if (stem === 'cmd') {
    return ['/d', '/s', '/c', command];
  }
  if (
    stem === 'bash' ||
    stem === 'zsh' ||
    stem === 'sh' ||
    stem === 'dash' ||
    stem === 'ksh' ||
    stem === 'fish'
  ) {
    return ['-lc', command];
  }
  return null;
}
