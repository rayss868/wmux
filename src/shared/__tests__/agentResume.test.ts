import { describe, it, expect } from 'vitest';
import {
  toResumeCommand,
  isResumableLaunchCommand,
  resumeOfferForRecovered,
  permissionFlagFor,
  PERMISSION_FLAG,
  type ResumeBinding,
  type PermissionMode,
} from '../agentResume';

const CWD = 'D:\\wmux';
const binding = (over: Partial<ResumeBinding> = {}): ResumeBinding => ({
  agent: 'claude',
  sessionId: 'abc-123',
  cwd: CWD,
  ts: 1,
  ...over,
});

describe('toResumeCommand (X6)', () => {
  describe('rewrites known agent launchers', () => {
    it('claude → claude --continue', () => {
      expect(toResumeCommand('claude')).toBe('claude --continue');
    });

    it('preserves trailing args after the launcher', () => {
      expect(toResumeCommand('claude --dangerously-skip-permissions')).toBe(
        'claude --continue --dangerously-skip-permissions',
      );
    });

    it('preserves a quoted prompt argument verbatim', () => {
      expect(toResumeCommand('claude "do the thing"')).toBe('claude --continue "do the thing"');
    });

    it('matches a Windows .exe / .cmd basename', () => {
      expect(toResumeCommand('claude.cmd')).toBe('claude.cmd --continue');
      expect(toResumeCommand('claude.exe --foo')).toBe('claude.exe --continue --foo');
    });

    it('matches a quoted absolute path launcher', () => {
      expect(toResumeCommand('"C:\\tools\\claude\\claude.exe" --foo')).toBe(
        '"C:\\tools\\claude\\claude.exe" --continue --foo',
      );
    });

    it('normalizes a POSIX absolute path launcher', () => {
      expect(toResumeCommand('/usr/local/bin/claude')).toBe('/usr/local/bin/claude --continue');
    });

    it('tolerates leading whitespace (preserved verbatim)', () => {
      expect(toResumeCommand('  claude')).toBe('  claude --continue');
    });
  });

  describe('idempotency — never double-adds / leaves resume+oneshot unchanged', () => {
    it('already --continue → unchanged', () => {
      const c = 'claude --continue';
      expect(toResumeCommand(c)).toBe(c);
    });
    it('re-applying is a fixpoint', () => {
      const once = toResumeCommand('claude --foo');
      expect(toResumeCommand(once)).toBe(once);
    });
    it('--resume <id> → unchanged (would double-resume)', () => {
      const c = 'claude --resume abc-123';
      expect(toResumeCommand(c)).toBe(c);
    });
    it('-c → unchanged', () => {
      expect(toResumeCommand('claude -c')).toBe('claude -c');
    });
    it('-p / --print one-shot → unchanged (semantics differ)', () => {
      expect(toResumeCommand('claude -p "hi"')).toBe('claude -p "hi"');
      expect(toResumeCommand('claude --print "hi"')).toBe('claude --print "hi"');
    });
    it('short-flag cluster containing c/r/p → unchanged', () => {
      expect(toResumeCommand('claude -cp')).toBe('claude -cp');
    });
    it('a flag inside a QUOTED prompt is NOT treated as a resume flag', () => {
      // The prompt mentions --continue but the command itself is fresh.
      expect(toResumeCommand('claude "explain the --continue flag"')).toBe(
        'claude --continue "explain the --continue flag"',
      );
    });
  });

  describe('leaves non-agent / ambiguous commands unchanged', () => {
    it('unknown launcher (node, bash) → unchanged', () => {
      expect(toResumeCommand('node server.js')).toBe('node server.js');
      expect(toResumeCommand('bash -lc "loop.sh"')).toBe('bash -lc "loop.sh"');
    });
    it('false-positive prefix (claude-foo) → unchanged', () => {
      expect(toResumeCommand('claude-foo')).toBe('claude-foo');
      expect(toResumeCommand('claudette')).toBe('claudette');
    });
    it('env-assignment prefix → unchanged', () => {
      expect(toResumeCommand('FOO=claude claude')).toBe('FOO=claude claude');
    });
    it('empty / whitespace → unchanged', () => {
      expect(toResumeCommand('')).toBe('');
      expect(toResumeCommand('   ')).toBe('   ');
    });
  });

  describe('X6 ③ — id-aware resume with a binding', () => {
    it('binding + cwd match → --resume <id> (no permFlag by default, D6 fail-safe)', () => {
      expect(toResumeCommand('claude', binding(), CWD)).toBe('claude --resume abc-123');
    });

    it('preserves trailing args after the inserted --resume', () => {
      expect(toResumeCommand('claude --model opus', binding(), CWD)).toBe(
        'claude --resume abc-123 --model opus',
      );
    });

    it('cwd MISMATCH → falls back to --continue (F7: --resume is cwd-scoped)', () => {
      expect(toResumeCommand('claude', binding({ cwd: 'C:\\other' }), CWD)).toBe('claude --continue');
    });

    it('no paneCwd provided → cannot prove cwd match → --continue', () => {
      expect(toResumeCommand('claude', binding())).toBe('claude --continue');
    });

    it('binding for a DIFFERENT agent slug → --continue', () => {
      expect(toResumeCommand('claude', binding({ agent: 'codex' }), CWD)).toBe('claude --continue');
    });

    it('binding with an empty sessionId → --continue', () => {
      expect(toResumeCommand('claude', binding({ sessionId: '' }), CWD)).toBe('claude --continue');
    });

    it('undefined binding → --continue (today’s behavior, unchanged)', () => {
      expect(toResumeCommand('claude', undefined, CWD)).toBe('claude --continue');
    });

    it('already --resume <id> → unchanged even with a binding (no double-resume)', () => {
      const c = 'claude --resume zzz-999';
      expect(toResumeCommand(c, binding(), CWD)).toBe(c);
    });

    it('idempotent: re-applying the id-aware build is a fixpoint', () => {
      const once = toResumeCommand('claude --model opus', binding(), CWD);
      expect(toResumeCommand(once, binding(), CWD)).toBe(once);
    });
  });

  describe('X6 ③ — opt-in permission-mode restore (restorePermissionMode)', () => {
    const opt = { restorePermissionMode: true };

    it('bypassPermissions → --resume <id> --dangerously-skip-permissions', () => {
      expect(toResumeCommand('claude', binding({ permissionMode: 'bypassPermissions' }), CWD, opt)).toBe(
        'claude --resume abc-123 --dangerously-skip-permissions',
      );
    });

    it('acceptEdits → --resume <id> --permission-mode acceptEdits', () => {
      expect(toResumeCommand('claude', binding({ permissionMode: 'acceptEdits' }), CWD, opt)).toBe(
        'claude --resume abc-123 --permission-mode acceptEdits',
      );
    });

    it('plan → --resume <id> --permission-mode plan', () => {
      expect(toResumeCommand('claude', binding({ permissionMode: 'plan' }), CWD, opt)).toBe(
        'claude --resume abc-123 --permission-mode plan',
      );
    });

    it('default → --resume <id> (no flag, even when opted in)', () => {
      expect(toResumeCommand('claude', binding({ permissionMode: 'default' }), CWD, opt)).toBe(
        'claude --resume abc-123',
      );
    });

    it('no permissionMode captured → --resume <id> only', () => {
      expect(toResumeCommand('claude', binding(), CWD, opt)).toBe('claude --resume abc-123');
    });

    it('opt-in has NO effect on the --continue fallback (cwd mismatch)', () => {
      expect(
        toResumeCommand('claude', binding({ cwd: 'C:\\other', permissionMode: 'bypassPermissions' }), CWD, opt),
      ).toBe('claude --continue');
    });

    it('default OFF: bypass binding does NOT auto-add the flag (D6 fail-safe)', () => {
      expect(toResumeCommand('claude', binding({ permissionMode: 'bypassPermissions' }), CWD)).toBe(
        'claude --resume abc-123',
      );
    });
  });

  describe('permissionFlagFor (pill helper) — the 4-mode mapping', () => {
    it('maps every mode', () => {
      expect(permissionFlagFor('bypassPermissions')).toBe('--dangerously-skip-permissions');
      expect(permissionFlagFor('acceptEdits')).toBe('--permission-mode acceptEdits');
      expect(permissionFlagFor('plan')).toBe('--permission-mode plan');
      expect(permissionFlagFor('default')).toBe('');
    });
    it('undefined → empty string', () => {
      expect(permissionFlagFor(undefined)).toBe('');
    });
    it('PERMISSION_FLAG table covers exactly the 4 modes', () => {
      expect(Object.keys(PERMISSION_FLAG).sort()).toEqual(
        (['acceptEdits', 'bypassPermissions', 'default', 'plan'] as PermissionMode[]).sort(),
      );
    });
  });

  describe('isResumableLaunchCommand', () => {
    it('true for a fresh claude launch', () => {
      expect(isResumableLaunchCommand('claude')).toBe(true);
    });
    it('false for already-resuming or non-agent', () => {
      expect(isResumableLaunchCommand('claude --continue')).toBe(false);
      expect(isResumableLaunchCommand('node x.js')).toBe(false);
    });
  });

  describe('resumeOfferForRecovered (Feature ② EC4 gate)', () => {
    it('offers the slug for an interactive agent shell', () => {
      expect(resumeOfferForRecovered({ lastDetectedAgent: 'claude' })).toBe('claude');
    });
    it('no offer when no agent was detected', () => {
      expect(resumeOfferForRecovered({})).toBeUndefined();
      expect(resumeOfferForRecovered({ lastDetectedAgent: '' })).toBeUndefined();
    });
    it('EXCLUDES exec units (they auto-resume via Feature ①)', () => {
      expect(resumeOfferForRecovered({ exec: { command: 'claude' }, lastDetectedAgent: 'claude' })).toBeUndefined();
    });
    it('EXCLUDES supervised units', () => {
      expect(resumeOfferForRecovered({ supervision: { restart: 'always' }, lastDetectedAgent: 'claude' })).toBeUndefined();
    });
  });
});
