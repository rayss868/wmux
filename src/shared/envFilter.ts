/**
 * Build a "safe" copy of an environment for spawning child processes
 * (PTY shells, daemon-spawned shells, etc.).
 *
 * Strips three classes of variables:
 *   1. Build/runtime tooling internals (ELECTRON_*, VITE_*, NODE_OPTIONS,
 *      ELECTRON_RUN_AS_NODE, ORIGINAL_XDG_*) — leak Electron detection
 *      and let attackers re-enter the wmux process with custom flags.
 *   2. wmux's own auth surface (WMUX_AUTH*) — the daemon RPC token must
 *      never reach a child shell where untrusted npm scripts run.
 *   3. Common credential names — pattern-matched (`*_TOKEN`, `*_SECRET`,
 *      `*_PASSWORD`, `*_CREDENTIALS`, `*_KEY`) plus exact matches for
 *      well-known providers that don't follow the suffix convention
 *      (DATABASE_URL embeds creds, AWS_SESSION_TOKEN, etc.).
 *
 * The SAFE_PASSTHROUGH set carves out variables that match a sensitive
 * pattern but are known to be harmless (e.g. SSH_AUTH_SOCK is a socket
 * path, COLORTERM is a terminal capability flag).
 *
 * Both PTYManager (main process) and DaemonSessionManager (daemon) call
 * into this so that hardening evolves in lockstep — historically the two
 * filter lists drifted and PTYManager was missing WMUX_AUTH stripping.
 */

const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /^ELECTRON_/,
  /^VITE_/,
  /^WMUX_AUTH/,         // internal auth tokens (daemon RPC)
  /^ORIGINAL_XDG_/,     // Electron-injected XDG overrides
  /_TOKEN$/,            // GITHUB_TOKEN, NPM_TOKEN, …
  /_SECRET$/,           // *_CLIENT_SECRET, …
  /_PASSWORD$/,
  /_CREDENTIALS$/,
  /_KEY$/,              // ANTHROPIC_API_KEY, OPENAI_API_KEY, …
];

const SENSITIVE_EXACT: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'DOCKER_PASSWORD',
  'DATABASE_URL',       // often embeds credentials
]);

const SAFE_PASSTHROUGH: ReadonlySet<string> = new Set([
  'SSH_AUTH_SOCK',      // SSH agent socket path — not a secret
  'COLORTERM',          // terminal capability hint
]);

/**
 * Return whether a given environment variable name should be blocked
 * from inheriting into a child process. Exposed for tests.
 */
export function isSensitiveEnvKey(key: string): boolean {
  if (SAFE_PASSTHROUGH.has(key)) return false;
  if (SENSITIVE_EXACT.has(key)) return true;
  return SENSITIVE_PATTERNS.some((re) => re.test(key));
}

/**
 * Build a child-process environment from a base env (defaults to
 * process.env). Values that are undefined or whose key is sensitive are
 * dropped. The returned object is a fresh shallow copy — callers can
 * safely mutate it (e.g. inject WMUX_SOCKET_PATH).
 */
export function buildSafeChildEnv(
  baseEnv: NodeJS.ProcessEnv = globalThis.process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (isSensitiveEnvKey(key)) continue;
    out[key] = value;
  }
  return out;
}
