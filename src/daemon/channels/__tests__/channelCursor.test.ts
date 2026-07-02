// Channels v2 Step 1 — durable per-member read cursor (lastReadSeq) tests.
// Covers: seeding at create/join, upgrade backfill to head (NOT 0 — the
// re-nudge-storm guard), advance-only ack with optional member narrowing,
// persist-failure rollback, and the unreadFor() read model.
import { describe, it, expect, vi } from 'vitest';
import { ChannelService } from '../ChannelService';
import type { ChannelState } from '../../../shared/channels';

function makeWriter(initial?: ChannelState) {
  let failNext = false;
  let last: ChannelState | null = initial ? structuredClone(initial) : null;
  return {
    load: (): ChannelState =>
      last
        ? structuredClone(last)
        : { version: 1, channels: [], members: {}, messages: {}, idempotency: {} },
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      if (failNext) {
        failNext = false;
        return false;
      }
      last = structuredClone(state);
      return true;
    }),
    save: vi.fn(),
    flush: vi.fn(),
    flushSync: vi.fn(),
    dispose: vi.fn(),
    failNext: () => {
      failNext = true;
    },
  };
}

function makeService(writer = makeWriter()) {
  const svc = new ChannelService({
    writer: writer as never,
    companyId: 'co-test',
    emit: vi.fn(),
  });
  return { svc, writer };
}

const A = 'ws-a';
const B = 'ws-b';

async function seedChannel(svc: ChannelService) {
  const created = await svc.create({
    name: 'cursor-test',
    visibility: 'public',
    createdBy: { workspaceId: A, memberId: 'pm', memberName: 'pm' },
    verifiedWorkspaceId: A,
  });
  if (!created.ok) throw new Error('create failed');
  const channelId = created.channel.id;
  const joined = await svc.join({
    channelId,
    member: { workspaceId: B, memberId: 'codex', memberName: 'codex' },
    verifiedWorkspaceId: B,
  });
  if (!joined.ok) throw new Error('join failed');
  return channelId;
}

async function post(svc: ChannelService, channelId: string, ws: string, memberId: string, text: string, mentions?: Array<{ workspaceId: string; memberId?: string; name: string }>) {
  const r = await svc.post({
    channelId,
    text,
    sender: { workspaceId: ws, memberId, memberName: memberId },
    verifiedWorkspaceId: ws,
    ...(mentions ? { mentions } : {}),
  });
  if (!r.ok) throw new Error(`post failed: ${JSON.stringify(r.error)}`);
  return r.message.seq;
}

describe('lastReadSeq cursor', () => {
  it('seeds the creator cursor at 0 and a joiner cursor at the join-time head', async () => {
    const { svc } = makeService();
    const created = await svc.create({
      name: 'seed',
      visibility: 'public',
      createdBy: { workspaceId: A, memberId: 'pm', memberName: 'pm' },
      verifiedWorkspaceId: A,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const channelId = created.channel.id;
    await post(svc, channelId, A, 'pm', 'one');
    await post(svc, channelId, A, 'pm', 'two');
    await svc.join({
      channelId,
      member: { workspaceId: B, memberId: 'codex', memberName: 'codex' },
      verifiedWorkspaceId: B,
    });
    const entries = svc.unreadFor(B);
    expect(entries).toHaveLength(1);
    // Joined at head seq 2 → zero unread despite two prior messages.
    expect(entries[0].lastReadSeq).toBe(2);
    expect(entries[0].unread).toBe(0);
  });

  it('backfills a pre-v2 member row (no lastReadSeq) to the channel head on load', async () => {
    const { svc, writer } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'm1');
    await post(svc, channelId, A, 'pm', 'm2');
    // Simulate a pre-v2 file: strip lastReadSeq from the persisted rows.
    const state = writer.load();
    for (const rows of Object.values(state.members)) {
      for (const row of rows) delete (row as unknown as Record<string, unknown>)['lastReadSeq'];
    }
    const writer2 = makeWriter(state);
    const svc2 = new ChannelService({ writer: writer2 as never, companyId: 'co-test', emit: vi.fn() });
    const entries = svc2.unreadFor(B);
    expect(entries).toHaveLength(1);
    // Head backfill ("start reading from now"), NOT 0 — no unread storm.
    expect(entries[0].lastReadSeq).toBe(2);
    expect(entries[0].unread).toBe(0);
  });

  it('ack advances the cursor, is clamped to head, and never moves backwards', async () => {
    const { svc } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'm1');
    await post(svc, channelId, A, 'pm', 'm2');
    expect(svc.unreadFor(B)[0].unread).toBe(2);

    // Overshoot: clamped to head (2), not persisted as 99.
    const r1 = await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 99, memberId: 'codex' });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.lastReadSeq).toBe(2);
    expect(svc.unreadFor(B)[0].unread).toBe(0);

    // Regression attempt: ack(1) after cursor=2 must not move backwards.
    const r2 = await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1, memberId: 'codex' });
    expect(r2.ok).toBe(true);
    expect(svc.unreadFor(B)[0].lastReadSeq).toBe(2);
  });

  it('memberId narrows the cursor advance; omitting it advances every row of the workspace', async () => {
    const { svc } = makeService();
    const channelId = await seedChannel(svc);
    // Second agent row for the same workspace B.
    await svc.join({
      channelId,
      member: { workspaceId: B, memberId: 'reviewer', memberName: 'reviewer' },
      verifiedWorkspaceId: B,
    });
    await post(svc, channelId, A, 'pm', 'm1');

    await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1, memberId: 'codex' });
    const byMember = Object.fromEntries(svc.unreadFor(B).map((e) => [e.memberId, e]));
    expect(byMember['codex'].unread).toBe(0);
    expect(byMember['reviewer'].unread).toBe(1);

    // Workspace-wide ack (renderer semantics) catches the sibling up.
    await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1 });
    expect(svc.unreadFor(B).every((e) => e.unread === 0)).toBe(true);
  });

  it('rolls the cursor back when persist fails', async () => {
    const { svc, writer } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'm1');
    writer.failNext();
    const r = await svc.ack({ channelId, verifiedWorkspaceId: B, uptoSeq: 1, memberId: 'codex' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PERSIST_FAILED');
    // Cursor unchanged → the unread is still owed and a retry is not a no-op.
    expect(svc.unreadFor(B)[0].unread).toBe(1);
  });

  it('unreadFor counts mention-unread separately (workspace-level and member-targeted)', async () => {
    const { svc } = makeService();
    const channelId = await seedChannel(svc);
    await post(svc, channelId, A, 'pm', 'plain message');
    await post(svc, channelId, A, 'pm', 'hey @codex', [{ workspaceId: B, memberId: 'codex', name: 'codex' }]);
    await post(svc, channelId, A, 'pm', 'hey @ws-b', [{ workspaceId: B, name: 'B' }]);

    const entries = svc.unreadFor(B, 'codex');
    expect(entries).toHaveLength(1);
    expect(entries[0].unread).toBe(3);
    // member-targeted mention + workspace-level mention both count for codex.
    expect(entries[0].mentionUnread).toBe(2);
    expect(entries[0].trimmedBeforeCursor).toBe(0);
  });

  it('unreadFor respects the historyFromSeq visibility floor', async () => {
    const { svc } = makeService();
    const created = await svc.create({
      name: 'floor',
      visibility: 'public',
      createdBy: { workspaceId: A, memberId: 'pm', memberName: 'pm' },
      verifiedWorkspaceId: A,
    });
    if (!created.ok) return;
    const channelId = created.channel.id;
    await post(svc, channelId, A, 'pm', 'before-join');
    await svc.join({
      channelId,
      member: { workspaceId: B, memberId: 'codex', memberName: 'codex' },
      verifiedWorkspaceId: B,
      includeHistory: false,
    });
    // Force the cursor BELOW the visibility floor to prove the floor wins.
    // (Not reachable through the public API — simulates a hand-edited file.)
    const rows = (svc as unknown as { state: ChannelState }).state.members[channelId];
    const codexRow = rows.find((m) => m.memberId === 'codex');
    if (codexRow) codexRow.lastReadSeq = 0;
    const entries = svc.unreadFor(B);
    // seq 1 is below historyFromSeq (2) → not owed, not counted.
    expect(entries[0].unread).toBe(0);
  });
});
