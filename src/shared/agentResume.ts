/**
 * X6 — agent session resume on supervised restart/recovery.
 *
 * Pure transform: given the launch command of a supervised exec unit, return
 * the command rewritten to RESUME the agent's previous session instead of
 * starting a fresh one, so a daemon restart / OS reboot revives the agent
 * CONVERSATION (not just the process — that is X8's job).
 *
 * Only applied on REPLAY paths (recovery + supervisor restart), never on first
 * launch — the persisted `meta.exec.command` always stays the original, and the
 * replay sites pass the rewritten string as a NON-persisted launch command
 * (see DaemonSessionManager.createSession `execLaunchCommand`).
 *
 * Mechanism, per agent: append the agent's "continue latest session in this
 * cwd" flag. For Claude Code that is `--continue` (verified 2026-06-13: it
 * resumes the latest session for the cwd with zero captured state, and is a
 * graceful fresh start when there is nothing to continue). Resume is
 * cwd-scoped, so the caller MUST only apply this when the original cwd still
 * exists — otherwise it would resume an unrelated homedir session.
 *
 * v1 covers `claude` only. cmux supports 16 agents; codex/opencode/gemini
 * resume forms are a deliberate follow-up (their resume ergonomics differ and
 * none is needed for the reboot-survival headline).
 *
 * This module lives in src/shared so the daemon (tsconfig.daemon.json scopes
 * to src/daemon + src/shared) can import it WITHOUT reaching into
 * integrations/shared (out of the daemon's tsconfig).
 */

/** Agent launcher executable stems we know how to resume → the resume flag. */
const RESUME_FLAG_BY_LAUNCHER: Readonly<Record<string, string>> = {
  claude: '--continue',
};

/**
 * X6 ③: Claude Code's per-invocation permission mode, as stamped on every user
 * turn in the `.jsonl` transcript (`"permissionMode":"bypassPermissions"`, etc.).
 * Permission mode is NOT restored state — it must be RE-APPLIED as a launch flag
 * on resume, or a `--dangerously-skip-permissions` workflow drops back to prompts
 * after a reboot.
 */
export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'plan' | 'default';

/**
 * permissionMode → the launch flag that re-enables it. `default` maps to no flag
 * (Claude's normal prompting). Verified 2026-06-14 (live): `--resume <id>` and
 * `--dangerously-skip-permissions` coexist (F6).
 */
export const PERMISSION_FLAG: Readonly<Record<PermissionMode, string>> = {
  bypassPermissions: '--dangerously-skip-permissions',
  acceptEdits: '--permission-mode acceptEdits',
  plan: '--permission-mode plan',
  default: '',
};

/**
 * The launch flag(s) that re-apply `mode`, or '' when none is needed (default
 * mode, unknown mode, or no mode captured). Exported for the resume pill, which
 * assembles its command progressively rather than via {@link toResumeCommand}.
 */
export function permissionFlagFor(mode: PermissionMode | undefined): string {
  if (!mode) return '';
  return PERMISSION_FLAG[mode] ?? '';
}

/**
 * X6 ③: a per-session resume binding, captured live from the claude hook and
 * persisted on the daemon session record so it survives a SIGKILL/reboot.
 *
 * `sessionId` is the ORIGIN conversation id — derived from the transcript
 * filename, NOT the hook's `payload.session_id` (which mints a NEW uuid on
 * resume, upstream #12235; the transcript file is appended in place so its
 * basename always points at the origin).
 */
export interface ResumeBinding {
  /** Agent launcher slug. 'claude' in v1. */
  agent: string;
  /** `--resume` argument: the origin session id (basename of the transcript). */
  sessionId: string;
  /** Origin cwd — hard cwd-match guard, since `--resume` is cwd-scoped (F7). */
  cwd: string;
  /** Last-observed permission mode (F5). Restored only on explicit user intent. */
  permissionMode?: PermissionMode;
  /**
   * Absolute path to the origin transcript `.jsonl`. Stored so staleness can be
   * decided by an `fs.existsSync` probe (D5) — a purged id makes `--resume` a
   * "No conversation found." dead-end (F8 — it exits 0, so no exit-code signal).
   * Storing the exact path keeps the probe slug-rule-free (claude's cwd→slug
   * mapping is version-drift-prone; capture deliberately avoided depending on it).
   */
  transcriptPath?: string;
  /** Capture time (ms). Staleness is decided by existence-probe, not a TTL. */
  ts: number;
}

/**
 * Unquoted tokens that mean "already resuming" or "not a resumable run" →
 * leave the command unchanged. `--continue`/`--resume`/`-c`/`-r` already
 * resume; `-p`/`--print` is a non-interactive one-shot (rewriting it to
 * `--continue` would change its semantics and, under `restart: always`, could
 * re-run a print loop). We err toward NOT rewriting: a missed resume just
 * starts fresh, a wrong rewrite changes behavior.
 */
const SKIP_TOKENS: ReadonlySet<string> = new Set([
  '--continue',
  '--resume',
  '--print',
  '-c',
  '-r',
  '-p',
]);

interface Token {
  /** Literal value with surrounding quotes stripped. */
  value: string;
  /** True if any part of the token was quoted (so flags inside a prompt
   *  string like `claude "explain --continue"` are NOT treated as flags). */
  quoted: boolean;
  /** Index in the source string just past this token (for splice insertion). */
  end: number;
}

/**
 * Minimal POSIX-ish tokenizer: splits on unquoted whitespace, respects single
 * and double quotes (a quoted span contributes to the current token and marks
 * it `quoted`). Good enough for launch commands; not a full shell parser.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  const n = command.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(command[i])) i++;
    if (i >= n) break;
    let value = '';
    let quoted = false;
    while (i < n && !/\s/.test(command[i])) {
      const c = command[i];
      if (c === '"' || c === "'") {
        quoted = true;
        const q = c;
        i++;
        while (i < n && command[i] !== q) {
          value += command[i];
          i++;
        }
        if (i < n) i++; // consume closing quote
      } else {
        value += c;
        i++;
      }
    }
    tokens.push({ value, quoted, end: i });
  }
  return tokens;
}

/** Launcher executable stem: basename, drop a Windows executable extension,
 *  lowercase. `"C:\\tools\\claude.cmd"` → `claude`; `claude-foo` → `claude-foo`. */
function launcherStem(firstToken: string): string {
  const base = firstToken.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/**
 * X6 ③: merge a freshly-captured binding over the previously-persisted one,
 * keeping `permissionMode` and `transcriptPath` STICKY. The bridge reads
 * permissionMode from the transcript's last 64KB; a turn that writes >64KB after
 * the last user line makes that read miss and return undefined (codex review
 * 2026-06-14). A capture that couldn't observe the mode must NOT wipe a mode we
 * already captured — so undefined fields fall back to the prior binding's value.
 * `sessionId`/`cwd` always take the latest (they come from stable fields).
 */
export function mergeResumeBinding(
  prev: ResumeBinding | undefined,
  next: ResumeBinding,
): ResumeBinding {
  const merged: ResumeBinding = { ...next };
  if (!merged.permissionMode && prev?.permissionMode) merged.permissionMode = prev.permissionMode;
  if (!merged.transcriptPath && prev?.transcriptPath) merged.transcriptPath = prev.transcriptPath;
  return merged;
}

/**
 * Decide what to insert after the launcher token: an id-aware
 * `--resume <id> [permFlag]` when a valid binding exists for THIS launcher and
 * its origin cwd still matches the pane (F7: `--resume` is cwd-scoped), or the
 * launcher's plain `--continue` fallback otherwise.
 *
 * The permission flag is OPT-IN (`options.restorePermissionMode`) and OFF by
 * default. The only auto-run consumer is the supervised replay path, which must
 * be fail-safe per D6 — never silently re-grant `--dangerously-skip-permissions`
 * with no human in the loop. The resume pill (explicit user Enter) opts in via
 * {@link permissionFlagFor} instead of this builder.
 */
function resumeInsertion(
  stem: string,
  resumeFlag: string,
  binding: ResumeBinding | undefined,
  paneCwd: string | undefined,
  options: { restorePermissionMode?: boolean } | undefined,
): string {
  if (
    binding &&
    binding.agent === stem &&
    binding.sessionId &&
    binding.cwd &&
    paneCwd &&
    binding.cwd === paneCwd
  ) {
    const parts = ['--resume', binding.sessionId];
    if (options?.restorePermissionMode) {
      const permFlag = permissionFlagFor(binding.permissionMode);
      if (permFlag) parts.push(permFlag);
    }
    return parts.join(' ');
  }
  return resumeFlag;
}

/**
 * Return `command` rewritten to resume the agent's previous session, or the
 * command UNCHANGED when it is not a known single-agent launcher, when it is
 * already a resume/one-shot, or when it uses syntax we won't touch (env
 * assignment, pipeline — anything whose first token is not a bare launcher).
 *
 * With a valid `binding` whose cwd matches `paneCwd`, resumes the EXACT session
 * (`--resume <id>`); otherwise falls back to `--continue` (latest-in-cwd, still
 * correct for the single-session case). Permission-mode restore is opt-in via
 * `options.restorePermissionMode` (default OFF — D6 fail-safe).
 *
 * Idempotent: re-applying never double-adds the flag (`--resume`/`--continue`
 * are both skip tokens).
 */
export function toResumeCommand(
  command: string,
  binding?: ResumeBinding,
  paneCwd?: string,
  options?: { restorePermissionMode?: boolean },
): string {
  const tokens = tokenize(command);
  if (tokens.length === 0) return command;

  // The launcher must be a bare command (its first token's stem). An env
  // assignment (`FOO=bar`) or a path that doesn't basename to a known launcher
  // falls through unchanged.
  const stem = launcherStem(tokens[0].value);
  const resumeFlag = RESUME_FLAG_BY_LAUNCHER[stem];
  if (!resumeFlag) return command;

  // Already resuming / one-shot? Check UNQUOTED tokens only, exact match plus
  // short-flag clusters that contain c/r/p (e.g. `-cp`). Errs toward skipping.
  for (const t of tokens) {
    if (t.quoted) continue;
    if (SKIP_TOKENS.has(t.value)) return command;
    if (/^-[a-z]*[crp][a-z]*$/.test(t.value)) return command;
  }

  // Insert the resume tokens immediately after the launcher token, preserving
  // the rest of the command (and its spacing/quoting) verbatim.
  const insert = resumeInsertion(stem, resumeFlag, binding, paneCwd, options);
  const at = tokens[0].end;
  return `${command.slice(0, at)} ${insert}${command.slice(at)}`;
}

/** Whether a launch command would be rewritten by {@link toResumeCommand}. */
export function isResumableLaunchCommand(command: string): boolean {
  return toResumeCommand(command) !== command;
}

/**
 * X6 Feature ②: does a RECOVERED session qualify for the one-click resume pill?
 *
 * Only INTERACTIVE agent shells do: the user typed `claude` in a plain pane and
 * a reboot replayed the SHELL (the agent is gone — the pill offers to bring it
 * back). Excluded:
 *   - exec/supervised units — they already auto-resume via execLaunchCommand
 *     (Feature ①); a pill would be a redundant second resume.
 *   - panes that never ran a detectable agent (no lastDetectedAgent).
 *
 * Returns the agent slug to offer, or undefined. The caller is responsible for
 * the "recovered THIS boot" half of the gate — a live reconnect must never
 * reach here (Codex eng review EC4).
 */
export function resumeOfferForRecovered(session: {
  exec?: { command: string };
  supervision?: unknown;
  lastDetectedAgent?: string;
}): string | undefined {
  if (session.exec || session.supervision) return undefined;
  return session.lastDetectedAgent || undefined;
}
