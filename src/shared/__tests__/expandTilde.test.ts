import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { expandTilde } from '../expandTilde';

// #520 — a cwd arriving off an RPC/CLI/MCP argument was never touched by a
// shell, so `~/foo` stayed literal and the session silently opened in $HOME.
describe('expandTilde', () => {
  const home = os.homedir();
  const onWindows = process.platform === 'win32';

  it.skipIf(onWindows)('expands a bare ~', () => {
    expect(expandTilde('~')).toBe(home);
  });

  it.skipIf(onWindows)('expands a leading ~/', () => {
    expect(expandTilde('~/projects/foo')).toBe(path.join(home, 'projects/foo'));
  });

  it('leaves absolute and relative paths alone', () => {
    expect(expandTilde('/usr/local/bin')).toBe('/usr/local/bin');
    expect(expandTilde('./src')).toBe('./src');
    expect(expandTilde('')).toBe('');
  });

  it('does not touch a tilde that is not a home reference', () => {
    // A `~` anywhere but the front is a literal character, and `~user` needs a
    // passwd lookup — silently mapping it to the CURRENT user's home would put
    // the caller somewhere they never asked for, with no error.
    expect(expandTilde('~otheruser/foo')).toBe('~otheruser/foo');
    expect(expandTilde('./~/x')).toBe('./~/x');
    expect(expandTilde('a~b')).toBe('a~b');
  });

  it.skipIf(!onWindows)('is a no-op on Windows, where ~ is not a shell convention', () => {
    expect(expandTilde('~/foo')).toBe('~/foo');
  });
});
