// ─── ChannelService × 이벤트로그 (PR3 통합) ────────────────────────────
// envelope-design §5 커밋경로 반전의 계약 고정:
//   - 1 커밋 = 1 envelope, 커밋 실패(fsync 주입) → PERSIST_FAILED + 롤백 + 무이벤트
//   - 재부트 = 스냅샷 폴백 체인 + tail replay → 라이브 projection과 수렴
//   - 스냅샷 마커 지연(stale marker) → 멱등 재적용으로 수렴
//   - dual-write 워터마크(§6.4c): 정상 재기동 오발동 0 / 구-데몬 쓰기 감지

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ChannelService } from '../ChannelService';
import type { ChannelServiceEventLog } from '../ChannelService';
import { ChannelStateWriter } from '../ChannelStateWriter';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import {
  SnapshotStore,
  SNAPSHOT_DIRNAME,
  GENESIS_CHANNEL_REF,
  CHANNEL_PROJECTION_REF,
} from '../../eventlog/SnapshotStore';
import { evaluateWatermark, stampWatermark } from '../../eventlog/migrateToEventLog';
import { EMPTY_CHANNEL_STATE, type ChannelState } from '../../../shared/channels';

let dir: string;
let eventsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-svc-eventlog-'));
  eventsDir = path.join(dir, 'events');
  // 마이그레이션 완료 상태 모사: genesis(빈 상태, lamport 0) 존재.
  const store = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
  store.writeDurableSync(
    GENESIS_CHANNEL_REF,
    { ...EMPTY_CHANNEL_STATE, channels: [], members: {}, messages: {}, idempotency: {} },
    0,
    ChannelStateWriter.isChannelState,
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  svc: ChannelService;
  writer: ChannelStateWriter;
  log: AppendOnlyLog;
  snapshots: SnapshotStore;
  emit: ReturnType<typeof vi.fn>;
  deps: ChannelServiceEventLog;
}

function makeHarness(opts: { fsync?: (fd: number) => void } = {}): Harness {
  const writer = new ChannelStateWriter(dir);
  const log = new AppendOnlyLog({
    dir: eventsDir,
    fsync: opts.fsync ?? ((): void => {}),
  });
  log.open();
  const snapshots = new SnapshotStore(path.join(eventsDir, SNAPSHOT_DIRNAME));
  writer.enableEventLogDualWrite({
    // index.ts 부트 게이트와 동일 배선 — write 시점 워터마크(§6.4c).
    stamp: (s) => stampWatermark(s, log.lamportHwm),
    durableFlush: true,
  });
  const deps: ChannelServiceEventLog = {
    log,
    snapshots,
    genesisRef: GENESIS_CHANNEL_REF,
    reseedRefs: [],
    machineId: 'machine-test',
  };
  const emit = vi.fn();
  const svc = new ChannelService({
    writer,
    eventLog: deps,
    companyId: 'co-test',
    emit,
    now: (() => {
      let t = 1_700_000_000_000;
      return () => ++t;
    })(),
  });
  return { svc, writer, log, snapshots, emit, deps };
}

/** 라이브 projection 스냅숏(비교용 deep clone). */
function stateOf(svc: ChannelService): ChannelState {
  return JSON.parse(
    JSON.stringify((svc as unknown as { state: ChannelState }).state),
  ) as ChannelState;
}

/** 대표 mutation 배터리 — 전 이벤트 종류를 커버한다. */
async function runBattery(svc: ChannelService): Promise<string> {
  const created = await svc.create({
    name: 'general',
    visibility: 'public',
    createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
    verifiedWorkspaceId: 'ws-1',
  });
  if (!created.ok) throw new Error('create failed');
  const chId = created.channel.id;
  expect((await svc.join({
    channelId: chId,
    member: { workspaceId: 'ws-2', memberId: 'm-2' },
    includeHistory: true,
    verifiedWorkspaceId: 'ws-2',
  })).ok).toBe(true);
  expect((await svc.invite({
    channelId: chId,
    invitedMember: { workspaceId: 'ws-3', memberId: 'm-3' },
    verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  expect((await svc.post({
    channelId: chId,
    sender: { workspaceId: 'ws-1', memberId: 'm-1' },
    text: 'hello @ws-2',
    verifiedWorkspaceId: 'ws-1',
    clientMsgId: 'cli-1',
    mentions: [{ workspaceId: 'ws-2', name: 'two' }],
  })).ok).toBe(true);
  expect((await svc.post({
    channelId: chId,
    sender: { workspaceId: 'ws-2', memberId: 'm-2' },
    text: 'reply',
    verifiedWorkspaceId: 'ws-2',
  })).ok).toBe(true);
  expect((await svc.ack({
    channelId: chId, verifiedWorkspaceId: 'ws-2', uptoSeq: 2, memberId: 'm-2',
  })).ok).toBe(true);
  expect((await svc.ack({
    channelId: chId, verifiedWorkspaceId: 'ws-3', uptoSeq: 2, // receipt-only
  })).ok).toBe(true);
  expect((await svc.leave({
    channelId: chId, workspaceId: 'ws-3', memberId: 'm-3', verifiedWorkspaceId: 'ws-3',
  })).ok).toBe(true);
  const second = await svc.create({
    name: 'ops',
    visibility: 'public',
    createdBy: { workspaceId: 'ws-1', memberId: 'm-1' },
    verifiedWorkspaceId: 'ws-1',
    members: [{ workspaceId: 'ws-2', memberId: 'm-2b' }],
  });
  if (!second.ok) throw new Error('second create failed');
  expect((await svc.kick({
    channelId: second.channel.id,
    targetWorkspaceId: 'ws-2',
    targetMemberId: 'm-2b',
    verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  expect((await svc.purgeMembership({
    workspaceId: 'ws-2', verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  expect((await svc.archive({
    channelId: second.channel.id, archivedBy: 'ws-1', verifiedWorkspaceId: 'ws-1',
  })).ok).toBe(true);
  return chId;
}

describe('ChannelService × 이벤트로그 (§5 커밋경로 반전)', () => {
  it('1 커밋 = 1 envelope — 배터리의 커밋 수와 로그 레코드 수·kind가 일치', async () => {
    const h = makeHarness();
    await runBattery(h.svc);
    const kinds = h.log.readAllRecords().map(
      (r) => (r.payload as { kind: string }).kind,
    );
    // create/join/invite/post/post/ack/ack/leave/create/kick/purge/archive = 12 커밋.
    expect(kinds).toEqual([
      'create', 'join', 'invite', 'post', 'post', 'ack', 'ack', 'leave',
      'create', 'kick', 'purge', 'archive',
    ]);
    // 도메인·origin 스탬프(§1): 전 레코드 channel 도메인 + machineId.
    for (const rec of h.log.readAllRecords()) {
      expect(rec.domain).toBe('channel');
      expect(rec.origin.machineId).toBe('machine-test');
      expect(rec.authContext.verifiedWorkspaceId.length).toBeGreaterThan(0);
    }
    h.log.close();
  });

  it('재부트(스냅샷 없음): genesis + 전체 replay가 라이브 projection과 수렴', async () => {
    const h = makeHarness();
    await runBattery(h.svc);
    const live = stateOf(h.svc);
    h.log.close();

    const h2 = makeHarness();
    expect(stateOf(h2.svc)).toEqual(live);
    // lamport hwm도 복원(재시작 후 재사용 없음 — §3).
    expect(h2.log.lamportHwm).toBe(12);
    h2.log.close();
  });

  it('재부트(스냅샷 가속): flush된 스냅샷 + tail replay가 수렴', async () => {
    const h = makeHarness();
    const chId = await runBattery(h.svc);
    // 스냅샷 flush(마커 = 현재 hwm 12) 후 추가 커밋 2건(tail).
    h.snapshots.flushSync();
    await h.svc.post({
      channelId: chId, sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'after snapshot', verifiedWorkspaceId: 'ws-1',
    });
    await h.svc.ack({ channelId: chId, verifiedWorkspaceId: 'ws-1', uptoSeq: 3, memberId: 'm-1' });
    const live = stateOf(h.svc);
    h.log.close();

    const h2 = makeHarness();
    expect(stateOf(h2.svc)).toEqual(live);
    h2.log.close();
  });

  it('스냅샷 마커 지연(내용 > 마커): 멱등 재적용으로 수렴 — 이중 적용 없음', async () => {
    const h = makeHarness();
    const chId = await runBattery(h.svc);
    // 레이스 산물 모사: 전체 내용(hwm 12 반영)을 옛 마커(lamport 4)로 기록 —
    // 부트가 lamport 5..12를 이미 반영된 내용 위에 재적용해도 수렴해야 한다.
    h.snapshots.writeDurableSync(
      CHANNEL_PROJECTION_REF,
      (h.svc as unknown as { state: ChannelState }).state,
      4,
      ChannelStateWriter.isChannelState,
    );
    const live = stateOf(h.svc);
    h.log.close();

    const h2 = makeHarness();
    const replayed = stateOf(h2.svc);
    expect(replayed).toEqual(live);
    // 이중 적용의 대표 증상 부재: 메시지 중복 없음.
    const msgs = replayed.messages[chId] ?? [];
    expect(new Set(msgs.map((m) => m.seq)).size).toBe(msgs.length);
    h2.log.close();
  });

  it('커밋 실패(fsync 주입): PERSIST_FAILED + 인메모리 롤백 + 무이벤트 + 로그 무기록, 이후 재개', async () => {
    let fail = false;
    const h = makeHarness({
      fsync: () => {
        if (fail) throw new Error('inject');
      },
    });
    const created = await h.svc.create({
      name: 'general', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' }, verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('setup create failed');
    const before = stateOf(h.svc);
    h.emit.mockClear();

    fail = true;
    const r = await h.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'doomed', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-x',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PERSIST_FAILED');
    // 인메모리 롤백: nextSeq·messages·멱등 엔트리 원복(기존 롤백 블록 형태 보존).
    expect(stateOf(h.svc)).toEqual(before);
    // 이벤트 방출 없음(persist-first 계약).
    expect(h.emit).not.toHaveBeenCalled();
    // 디스크에 롤백 레코드 없음(§2.4-4 배치 롤백).
    expect(h.log.readAllRecords()).toHaveLength(1); // create뿐

    // 실패 후 재개: lamport gap 허용·재사용 금지(§3 함정).
    fail = false;
    const retry = await h.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'retry', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-x',
    });
    expect(retry.ok).toBe(true);
    const recs = h.log.readAllRecords();
    expect(recs).toHaveLength(2);
    expect(recs[1].lamport).toBe(3); // 2가 gap(소비 후 롤백), 재사용 없음
    h.log.close();
  });

  it('멱등 replay 재구성(§4): 재부트 후 같은 clientMsgId 재시도가 원본을 반환(중복 커밋 없음)', async () => {
    const h = makeHarness();
    const created = await h.svc.create({
      name: 'general', visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm-1' }, verifiedWorkspaceId: 'ws-1',
    });
    if (!created.ok) throw new Error('setup');
    const first = await h.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'once', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-dup',
    });
    if (!first.ok) throw new Error('post');
    h.log.close();

    const h2 = makeHarness();
    const retry = await h2.svc.post({
      channelId: created.channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'm-1' },
      text: 'twice', verifiedWorkspaceId: 'ws-1', clientMsgId: 'cli-dup',
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.idempotent).toBe(true);
      expect(retry.message.seq).toBe(first.message.seq);
      expect(retry.message.text).toBe('once');
    }
    // 로그에 post는 1건뿐(재시도는 append 없이 원본 반환).
    expect(
      h2.log.readAllRecords().filter((r) => (r.payload as { kind: string }).kind === 'post'),
    ).toHaveLength(1);
    h2.log.close();
  });

  it('워터마크(§6.4c): flush된 dual-write는 unchanged(오발동 0), 구-데몬 쓰기 모사는 감지', async () => {
    const h = makeHarness();
    await runBattery(h.svc);
    // dual-write 강제 flush(§6.4b 셧다운 경로) — write 시점 스탬프.
    h.writer.flushSync();
    const channelsJson = path.join(dir, 'channels.json');
    const raw1 = JSON.parse(fs.readFileSync(channelsJson, 'utf8')) as Record<string, unknown>;
    expect(evaluateWatermark(raw1).kind).toBe('unchanged'); // 정상 재기동 — reseed 오발동 0

    // 구-데몬 쓰기 모사: 내용 변경 + 워터마크 필드 왕복 보존(§6.4c 감지 근거).
    (raw1['channels'] as Array<{ name: string }>)[0].name = 'renamed-by-old-daemon';
    fs.writeFileSync(channelsJson, JSON.stringify(raw1));
    const raw2 = JSON.parse(fs.readFileSync(channelsJson, 'utf8'));
    const verdict = evaluateWatermark(raw2);
    expect(verdict.kind).toBe('downgrade-write');
    if (verdict.kind === 'downgrade-write') expect(verdict.reason).toBe('hash-mismatch');
    h.log.close();
  });
});
