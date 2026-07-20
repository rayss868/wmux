// cwd plausibility check — guards against prompt-scraping false positives (shared).
//
// Background (2026-07-20): the prompt scraper mistook a string like "PS C:\…>"
// shown in terminal text for a real prompt and overwrote a macOS pane's cwd with
// a Windows path. This filters out paths whose shape can't exist on the platform.
// It does not check existence (fs) — this module is used in the renderer too.

/** Whether the cwd shape can exist on the current platform. platform defaults to the runtime environment. */
export function isPlausibleCwd(
  cwd: string,
  platform: NodeJS.Platform | string = typeof process !== 'undefined' ? process.platform : 'linux',
): boolean {
  if (!cwd) return false;
  const isWinShape = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\');
  if (platform === 'win32') return true; // win32 also allows WSL POSIX paths — pass
  return !isWinShape;
}
