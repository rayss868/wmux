import os from 'node:os';
import path from 'node:path';

/**
 * Resolve a leading `~` in a caller-supplied path.
 *
 * Tilde expansion is a SHELL feature. A path that reaches us through an RPC,
 * CLI flag or MCP argument was never touched by a shell, so `~/projects/foo`
 * arrives literal — the existence checks then fail and the session quietly
 * opens in $HOME instead, or node-pty throws on an unreadable cwd. Callers type
 * `~/…` because every other unix tool accepts it, so expand it here rather than
 * making each entry point remember.
 *
 * Handles `~` and `~/…` only. `~otheruser` is deliberately left alone: resolving
 * another account's home needs a passwd lookup, and silently mapping it to the
 * CURRENT user's home would be worse than not expanding it — the caller would
 * land somewhere they did not ask for with no error.
 *
 * Windows: `~` is not a shell convention there and a path like `~\foo` is a
 * legal (if odd) relative name, so this is a no-op off unix.
 */
export function expandTilde(p: string): string {
  if (process.platform === 'win32') return p;
  if (p === '~') return os.homedir();
  // Only a leading `~/` — a bare `~` inside a path (`./~/x`, `a~b`) is a
  // literal character, not a home reference.
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
