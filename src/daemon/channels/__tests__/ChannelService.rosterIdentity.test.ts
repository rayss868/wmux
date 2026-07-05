// ─── 1b/1c — server-owned roster identity ────────────────────────────
// 1b: member rows carry a daemon-derived `memberName` (principal registry
// display, else the memberId); post() renders the message identity from the
// ROSTER ROW, never the caller's free text once a row is known.
// 1c: a post whose memberId matches no roster row of its (verified)
// workspace is mapped onto the workspace's SINGLE row (fixing the
// self-cursor-ride miss that made the wake worker re-nudge a sender about
// its own message); with multiple rows it keeps the client id and echoes
// `unmatchedMemberId`.
//
// Plan reference: channels-remediation-plan-2026-07-05.md §1b/§1c.

import { describe, it, expect, vi } from 'vitest';
import { ChannelService } from '../ChannelService';
import type { ChannelServiceEmit } from '../ChannelService';
import type { ChannelState } from '../../../shared/channels';

const COMPANY = 'co-test';

function freshState(): ChannelState {
  return { version: 1, channels: [], members: {}, messages: {}, idempotency: {} };
}

function makeFakeWriter(initial?: ChannelState) {
  let lastSaved: ChannelState | null = initial ?? null;
  return {
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      lastSaved = state;
      return true;
    }),
    load: vi.fn((): ChannelState => (lastSaved ? JSON.parse(JSON.stringify(lastSaved)) : freshState())),
  };
}

function makeService(opts: {
  initialState?: ChannelState;
  resolvePrincipalDisplay?: (principalId: string) => string | undefined;
} = {}) {
  const writer = makeFakeWriter(opts.initialState);
  const emit = vi.fn<ChannelServiceEmit>();
  const svc = new ChannelService({
    writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
    companyId: COMPANY,
    emit,
    now: () => 1_700_000_000_000,
    resolvePrincipalDisplay: opts.resolvePrincipalDisplay,
  });
  return { svc, writer, emit };
}

async function createChannel(svc: ChannelService, extra: Partial<Parameters<ChannelService['create']>[0]> = {}) {
  const created = await svc.create({
    name: 'general',
    visibility: 'public',
    createdBy: { workspaceId: 'ws-1', memberId: 'w1-1(claude)' },
    verifiedWorkspaceId: 'ws-1',
    ...extra,
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
  return created.channel;
}

describe('1b — roster rows carry a server-derived memberName', () => {
  it('create: creator + seeded members derive from the principal registry, falling back to memberId', async () => {
    const registry: Record<string, string> = { 'pane:ws-2/p-9': 'w2-1(codex)' };
    const { svc } = makeService({ resolvePrincipalDisplay: (id) => registry[id] });
    const channel = await createChannel(svc, {
      members: [
        // Registry hit → display name.
        { workspaceId: 'ws-2', memberId: 'raw-id', principalId: 'pane:ws-2/p-9' },
        // Registry miss → memberId fallback.
        { workspaceId: 'ws-3', memberId: 'w3-1(gemini)', principalId: 'pane:ws-3/p-1' },
      ],
    });
    const members = svc.getMembers(channel.id, 'ws-1');
    const byWs = Object.fromEntries(members.map((m) => [m.workspaceId, m.memberName]));
    expect(byWs['ws-1']).toBe('w1-1(claude)'); // creator: no principal → memberId
    expect(byWs['ws-2']).toBe('w2-1(codex)'); // registry display
    expect(byWs['ws-3']).toBe('w3-1(gemini)'); // miss → memberId
  });

  it('join and invite derive the same way, and a resolver throw degrades to the memberId', async () => {
    const resolver = vi.fn((id: string) => {
      if (id === 'pane:ws-4/p-2') return 'w4-1(aider)';
      throw new Error('registry unavailable');
    });
    const { svc } = makeService({ resolvePrincipalDisplay: resolver });
    const channel = await createChannel(svc);
    const joined = await svc.join({
      channelId: channel.id,
      member: { workspaceId: 'ws-4', memberId: 'raw-join-id', principalId: 'pane:ws-4/p-2' },
      verifiedWorkspaceId: 'ws-4',
    });
    expect(joined.ok).toBe(true);
    const invited = await svc.invite({
      channelId: channel.id,
      invitedMember: { workspaceId: 'ws-5', memberId: 'w5-1(x)', principalId: 'pane:ws-5/p-3' },
      verifiedWorkspaceId: 'ws-1',
    });
    expect(invited.ok).toBe(true);
    const members = svc.getMembers(channel.id, 'ws-1');
    const byWs = Object.fromEntries(members.map((m) => [m.workspaceId, m.memberName]));
    expect(byWs['ws-4']).toBe('w4-1(aider)');
    expect(byWs['ws-5']).toBe('w5-1(x)'); // resolver threw → memberId fallback
  });

  it('post renders the message name from the ROSTER row, not the caller free text', async () => {
    const { svc } = makeService({ resolvePrincipalDisplay: () => 'Roster Display' });
    const channel = await createChannel(svc, {
      members: [{ workspaceId: 'ws-2', memberId: 'w2-1(codex)', principalId: 'pane:x' }],
    });
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-2', memberId: 'w2-1(codex)', memberName: 'Forged Fancy Name' },
      text: 'hello',
      verifiedWorkspaceId: 'ws-2',
    });
    expect(posted.ok).toBe(true);
    if (posted.ok) {
      expect(posted.message.memberName).toBe('Roster Display');
      expect(posted.message.memberId).toBe('w2-1(codex)');
    }
  });

  it('legacy roster rows without memberName fall back to the row memberId (no migration)', async () => {
    // Simulate a pre-1b persisted state: member row lacks memberName.
    const state = freshState();
    state.channels.push({
      id: 'ch-legacy', companyId: COMPANY, name: 'old', visibility: 'public',
      status: 'active', createdAt: 1, createdBy: 'ws-1', nextSeq: 1,
    });
    state.members['ch-legacy'] = [
      { workspaceId: 'ws-1', memberId: 'legacy-agent', joinedAt: 1, historyFromSeq: 0, lastReadSeq: 0 },
    ];
    state.messages['ch-legacy'] = [];
    state.idempotency['ch-legacy'] = {};
    const { svc } = makeService({ initialState: state });
    const posted = await svc.post({
      channelId: 'ch-legacy',
      sender: { workspaceId: 'ws-1', memberId: 'legacy-agent', memberName: 'Client Sent This' },
      text: 'hi',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    if (posted.ok) expect(posted.message.memberName).toBe('legacy-agent');
  });

  it('sender.memberName is fully optional (new MCP wire shape)', async () => {
    const { svc } = makeService();
    const channel = await createChannel(svc);
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'w1-1(claude)' },
      text: 'no name field at all',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    if (posted.ok) expect(posted.message.memberName).toBe('w1-1(claude)');
  });
});

describe('1c — ghost memberId mapping and feedback', () => {
  it('single-row workspace: a ghost memberId maps onto the roster row AND rides its cursor (self-re-nudge fix)', async () => {
    const { svc, emit } = makeService();
    const channel = await createChannel(svc); // single row: (ws-1, 'w1-1(claude)'), lastReadSeq 0
    const posted = await svc.post({
      channelId: channel.id,
      // The classic ghost: MCP/CLI posting under a stale default while the
      // roster row uses the auto-name.
      sender: { workspaceId: 'ws-1', memberId: 'agent', memberName: 'agent' },
      text: 'mapped?',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.message.memberId).toBe('w1-1(claude)'); // mapped, not 'agent'
    expect(posted.unmatchedMemberId).toBeUndefined();
    // Cursor rode: the sender's ROW consumed its own message → no self-unread.
    const members = svc.getMembers(channel.id, 'ws-1');
    expect(members[0].lastReadSeq).toBe(posted.message.seq);
    // The broadcast event mirrors the RESOLVED identity.
    const messageEvent = emit.mock.calls.map(([e]) => e).find((e) => e.type === 'channel.message') as
      | { sender: { memberId: string } }
      | undefined;
    expect(messageEvent?.sender.memberId).toBe('w1-1(claude)');
  });

  it('multi-row workspace: an unmatched memberId keeps the client id, echoes unmatchedMemberId, and rides NO cursor', async () => {
    const { svc } = makeService();
    const channel = await createChannel(svc, {
      members: [{ workspaceId: 'ws-1', memberId: 'w1-2(codex)' }], // second seat, same workspace
    });
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'ghost', memberName: 'ghost' },
      text: 'ambiguous',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.message.memberId).toBe('ghost');
    expect(posted.unmatchedMemberId).toBe('ghost');
    const members = svc.getMembers(channel.id, 'ws-1');
    // Neither seat's cursor moved — the daemon must not guess between seats.
    for (const m of members) {
      expect(m.lastReadSeq).toBe(0);
    }
  });

  it('regression: create→post with a DIFFERENT memberId still succeeds (the old NOT_A_MEMBER bug stays dead)', async () => {
    const { svc } = makeService();
    const channel = await createChannel(svc);
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'other-id', memberName: 'x' },
      text: 'still allowed',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
  });

  it('exact (workspaceId, memberId) match is used verbatim — no mapping, no warning', async () => {
    const { svc } = makeService();
    const channel = await createChannel(svc, {
      members: [{ workspaceId: 'ws-1', memberId: 'w1-2(codex)' }],
    });
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'w1-2(codex)', memberName: 'ignored' },
      text: 'exact',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.message.memberId).toBe('w1-2(codex)');
    expect(posted.unmatchedMemberId).toBeUndefined();
  });
});
