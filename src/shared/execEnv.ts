// A process launched from the macOS GUI (Dock/Finder/Spotlight) inherits only
// launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) and does not inherit the
// Homebrew PATH (/opt/homebrew/bin, etc.) that ~/.zshrc·~/.zprofile set up — a
// well-known macOS-specific problem. Windows doesn't have this, because installing
// git registers PATH in the registry (system/user environment variables), which is
// inherited globally by every process.
//
// If execFile('git', …) runs seeing only this PATH, it can't find a Homebrew-installed
// git and fails quietly with ENOENT (callers treat "quiet absence" as a contract, so
// to the user the feature simply doesn't show up — owner-reported 2026-07-19, the cause
// of the branch-sync badge not appearing in the workspace sidebar on macOS).

import { isMac } from './platform';

/** Standard Homebrew (Apple Silicon/Intel) + system git install paths. */
const MAC_PATH_FALLBACKS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

let cachedEnv: NodeJS.ProcessEnv | null = null;

/**
 * Returns an env that corrects the macOS-specific case where passing `process.env`
 * straight to execFile is unsafe — on mac only, it appends the Homebrew/system
 * paths to PATH; on other platforms it returns `process.env` as-is (no recompute).
 */
export function getGitExecEnv(): NodeJS.ProcessEnv {
  if (!isMac) return process.env;
  if (cachedEnv) return cachedEnv;

  const existing = (process.env.PATH || '').split(':').filter(Boolean);
  const merged = [...new Set([...existing, ...MAC_PATH_FALLBACKS])];
  cachedEnv = { ...process.env, PATH: merged.join(':') };
  return cachedEnv;
}
