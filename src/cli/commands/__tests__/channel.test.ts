/**
 * `wmux channel` — the universal agent surface for Channels v2.
 *
 * What these tests pin:
 *  1. Transport: every subcommand rides the DAEMON pipe (sendDaemonRequest),
 *     never the main pipe — that is what keeps the CLI working headless.
 *  2. Identity: senderPtyId rides along (walk hit here via the mocked
 *     resolveSelfContext; env-fallback is covered separately) and the CLI
 *     NEVER claims a workspace (no verifiedWorkspaceId, no sender.workspaceId
 *     — the daemon stamps/backfills those server-side).
 *  3. Envelope unwrap: a daemon-level `{ok:false, error:{code,message}}`
 *     RESULT (inside an ok pipe envelope) exits 1 with the code visible.
 *  4. Fail-closed UX: a mutation with no resolvable pane identity exits 1
 *     BEFORE any RPC is issued, with an actionable message.
 *  5. Name → id resolution: `read general` resolves via a2a.channel.list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../client', () => ({
  sendRequest: vi.fn(),
  sendDaemonRequest: vi.fn(),
}));
vi.mock('../../identity', () => ({
  resolveSelfContext: vi.fn(),
  getParentPidDefault: vi.fn(),
}));

import { sendDaemonRequest } from '../../client';
import { resolveSelfContext } from '../../identity';
import { handleChannel } from '../channel';

const daemonRpc = sendDaemonRequest as unknown as ReturnType<typeof vi.fn>;
const selfContext = resolveSelfContext as unknown as ReturnType<typeof vi.fn>;

const ORIGINAL_ENV_PTY = process.env.WMUX_PTY_ID;
const ORIGINAL_ENV_MEMBER = process.env.WMUX_MEMBER_ID;

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

class ExitCalled extends Error {
  constructor(public readonly code: number | undefined) {
    super(`exit(${code})`);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WMUX_PTY_ID;
  delete process.env.WMUX_MEMBER_ID;
  if (ORIGINAL_ENV_PTY !== undefined) process.env.WMUX_PTY_ID = undefined as unknown as string;
  if (ORIGINAL_ENV_MEMBER !== undefined) process.env.WMUX_MEMBER_ID = undefined as unknown as string;
  delete process.env.WMUX_PTY_ID;
  delete process.env.WMUX_MEMBER_ID;
  selfContext.mockResolvedValue({ ptyId: 'pty-self', workspaceId: 'ws-self' });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code);
  }) as never);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

const okEnvelope = (result: unknown) => ({ id: 'x', ok: true as const, result });

describe('wmux channel — transport + identity', () => {
  it('unread rides the daemon pipe with senderPtyId and NO workspace claim', async () => {
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, entries: [] }));
    await handleChannel('unread', [], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.unread', {
      senderPtyId: 'pty-self',
    });
    const params = daemonRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params).not.toHaveProperty('verifiedWorkspaceId');
  });

  it('falls back to env WMUX_PTY_ID when the verified walk misses (headless)', async () => {
    selfContext.mockResolvedValue({});
    process.env.WMUX_PTY_ID = 'pty-env';
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, entries: [] }));
    await handleChannel('unread', [], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.unread', {
      senderPtyId: 'pty-env',
    });
  });

  it('post sends sender WITHOUT workspaceId (daemon backfills from its own stamp)', async () => {
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, message: { seq: 3 } }));
    await handleChannel('post', ['ch-1', 'hello', 'world', '--member', 'codex'], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.post', {
      channelId: 'ch-1',
      text: 'hello world',
      sender: { memberId: 'codex', memberName: 'codex' },
      senderPtyId: 'pty-self',
    });
  });

  it('post keeps body tokens that start with a dash (flag stripper is pair-aware)', async () => {
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, message: { seq: 4 } }));
    await handleChannel('post', ['ch-1', 'step', '-1', 'failed', '--member', 'codex'], false);
    const params = daemonRpc.mock.calls[0][1] as { text: string };
    expect(params.text).toBe('step -1 failed');
  });

  it('ack forwards uptoSeq + memberId; "all" maps to MAX_SAFE_INTEGER (daemon clamps to head)', async () => {
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, acked: 0, lastReadSeq: 9 }));
    await handleChannel('ack', ['ch-1', 'all', '--member', 'codex'], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.ack', {
      channelId: 'ch-1',
      uptoSeq: Number.MAX_SAFE_INTEGER,
      memberId: 'codex',
      senderPtyId: 'pty-self',
    });
  });

  it('ack without --member resolves the caller\'s SINGLE row from unread (no "agent" guess)', async () => {
    const row = { channelId: 'ch-1', name: 'g', memberId: 'codex', lastReadSeq: 2, headSeq: 9, unread: 7, mentionUnread: 0, trimmedBeforeCursor: 0 };
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, entries: [row] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, acked: 1, lastReadSeq: 9 }));
    await handleChannel('ack', ['ch-1', 'all'], false);
    expect(daemonRpc).toHaveBeenNthCalledWith(1, 'a2a.channel.unread', { senderPtyId: 'pty-self' });
    expect(daemonRpc).toHaveBeenNthCalledWith(2, 'a2a.channel.ack', {
      channelId: 'ch-1',
      uptoSeq: Number.MAX_SAFE_INTEGER,
      memberId: 'codex',
      senderPtyId: 'pty-self',
    });
  });

  it('ack without --member on a MULTI-row workspace fails loudly (never guesses a cursor)', async () => {
    const mk = (memberId: string) => ({ channelId: 'ch-1', name: 'g', memberId, lastReadSeq: 0, headSeq: 3, unread: 3, mentionUnread: 0, trimmedBeforeCursor: 0 });
    daemonRpc.mockResolvedValueOnce(okEnvelope({ ok: true, entries: [mk('codex'), mk('opencode')] }));
    await expect(handleChannel('ack', ['ch-1', 'all'], false)).rejects.toThrow(ExitCalled);
    // Only the unread lookup ran — the ack RPC never fired.
    expect(daemonRpc).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('--member');
  });

  it('post without --member posts AS the resolved row (self-unread exemption depends on it)', async () => {
    const row = { channelId: 'ch-1', name: 'g', memberId: 'codex', lastReadSeq: 2, headSeq: 2, unread: 0, mentionUnread: 0, trimmedBeforeCursor: 0 };
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, entries: [row] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, message: { seq: 3 } }));
    await handleChannel('post', ['ch-1', 'hi'], false);
    expect(daemonRpc).toHaveBeenNthCalledWith(2, 'a2a.channel.post', {
      channelId: 'ch-1',
      text: 'hi',
      sender: { memberId: 'codex', memberName: 'codex' },
      senderPtyId: 'pty-self',
    });
  });

  it('read resolves a channel NAME to its id via a2a.channel.list', async () => {
    daemonRpc
      .mockResolvedValueOnce(okEnvelope({ ok: true, channels: [{ id: 'ch-9', name: 'general', visibility: 'public' }] }))
      .mockResolvedValueOnce(okEnvelope({ ok: true, messages: [{ seq: 1, memberName: 'pm', text: 'hi' }] }));
    await handleChannel('read', ['general'], false);
    expect(daemonRpc).toHaveBeenNthCalledWith(1, 'a2a.channel.list', { senderPtyId: 'pty-self' });
    expect(daemonRpc).toHaveBeenNthCalledWith(2, 'a2a.channel.getMessages', {
      channelId: 'ch-9',
      limit: 50,
      senderPtyId: 'pty-self',
    });
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('[seq 1] pm: hi');
  });

  it('--since / --limit flag values are never mistaken for positionals', async () => {
    daemonRpc.mockResolvedValue(okEnvelope({ ok: true, messages: [] }));
    await handleChannel('read', ['--since', '3', 'ch-1', '--limit', '5'], false);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.getMessages', {
      channelId: 'ch-1',
      sinceSeq: 3,
      limit: 5,
      senderPtyId: 'pty-self',
    });
  });
});

describe('wmux channel — failure surfaces', () => {
  it('a mutation with no resolvable pane identity fails closed BEFORE any RPC', async () => {
    selfContext.mockResolvedValue({});
    await expect(handleChannel('post', ['ch-1', 'hi'], false)).rejects.toThrow(ExitCalled);
    expect(daemonRpc).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('not inside a wmux pane');
  });

  it('a daemon-level channel error (result.ok=false) exits 1 with the error code visible', async () => {
    daemonRpc.mockResolvedValue(
      okEnvelope({ ok: false, error: { code: 'NOT_A_MEMBER', message: 'Not a channel member' } }),
    );
    // Explicit --member skips row resolution, so the post RPC itself errors.
    await expect(handleChannel('post', ['ch-1', 'hi', '--member', 'codex'], false)).rejects.toThrow(ExitCalled);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('NOT_A_MEMBER');
  });

  it('a reads-path call still works with NO pane identity (visibility falls to the daemon gate)', async () => {
    selfContext.mockResolvedValue({});
    daemonRpc.mockResolvedValue(
      okEnvelope({ ok: false, error: { code: 'NOT_AUTHORIZED', message: 'verifiedWorkspaceId is required' } }),
    );
    // No senderPtyId at all → the daemon's own guard produces the rejection;
    // the CLI must surface it, not crash.
    await expect(handleChannel('list', [], false)).rejects.toThrow(ExitCalled);
    expect(daemonRpc).toHaveBeenCalledWith('a2a.channel.list', {});
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('NOT_AUTHORIZED');
  });

  it('unread surfaces trimmedBeforeCursor as a WARNING (silent loss is forbidden)', async () => {
    daemonRpc.mockResolvedValue(
      okEnvelope({
        ok: true,
        entries: [
          {
            channelId: 'ch-1',
            name: 'general',
            memberId: 'codex',
            lastReadSeq: 2,
            headSeq: 9,
            unread: 3,
            mentionUnread: 1,
            trimmedBeforeCursor: 4,
          },
        ],
      }),
    );
    await handleChannel('unread', [], false);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(out).toContain('3 unread');
    expect(out).toContain('1 mention you');
    expect(out).toContain('WARNING: 4 message(s) trimmed');
  });
});
