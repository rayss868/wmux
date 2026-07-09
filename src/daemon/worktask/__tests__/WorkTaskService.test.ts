// ─── WorkTaskService tests (J0 §0 성공기준 + §1~§3 계약) ────────────────
//
// 성공기준(§0) E2E 왕복: mission.start → 채널 post → mission.close → 데몬 재시작
// 시뮬레이션(서비스 재생성 + boot replay) → projection 복원(closed) · archive 멱등
// 재시도 no-op. 이 테스트가 "R3 블로커 해소"의 판정식이다.
//
// 인프라: 실 AppendOnlyLog(A2aTaskService.test.ts fixture 재사용) + 실
// ChannelService(ChannelService.test.ts fake writer 패턴 재사용, E2E fidelity),
// 또는 주입 가능한 fake ChannelPort(reconcile/보상 archive 실패 케이스).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { ChannelService } from '../../channels/ChannelService';
import type { ChannelServiceDeps } from '../../channels/ChannelService';
import type { ChannelState } from '../../../shared/channels';
import { WorkTaskService } from '../WorkTaskService';
import type { WorkTaskChannelPort } from '../WorkTaskService';
import { missionTopicFor, taskIdFromMissionTopic, normalizeWorktreePath } from '../../../shared/workTask';

let dir: string;
const syncOk = (): void => {
  /* no-op fsync stub for the test log */
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-worktask-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newLog(): AppendOnlyLog {
  const log = new AppendOnlyLog({ dir, fsync: syncOk });
  log.open();
  return log;
}

// ── 실 ChannelService fake writer (ChannelService.test.ts 패턴 재사용) ──
function makeFakeWriter() {
  let lastSaved: ChannelState | null = null;
  const freshState = (): ChannelState => ({
    version: 1,
    channels: [],
    members: {},
    messages: {},
    idempotency: {},
  });
  const clone = (state: ChannelState): ChannelState => ({
    version: state.version,
    channels: state.channels.map((c) => ({ ...c })),
    members: Object.fromEntries(
      Object.entries(state.members).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    messages: Object.fromEntries(
      Object.entries(state.messages).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    idempotency: Object.fromEntries(
      Object.entries(state.idempotency).map(([k, v]) => [k, { ...v }]),
    ),
  });
  return {
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      lastSaved = clone(state);
      return true;
    }),
    load: vi.fn((): ChannelState => (lastSaved ? clone(lastSaved) : freshState())),
  };
}

function newChannelService(writer: ReturnType<typeof makeFakeWriter>): ChannelService {
  const deps: ChannelServiceDeps = {
    writer: writer as unknown as ChannelServiceDeps['writer'],
    companyId: 'co-1',
    emit: vi.fn(),
    now: () => Date.now(),
  };
  return new ChannelService(deps);
}

function newWorkTaskService(
  log: AppendOnlyLog,
  channels: WorkTaskChannelPort,
  opts?: { now?: () => number; ceoWorkspaceId?: string },
): WorkTaskService {
  return new WorkTaskService({
    log,
    channels,
    origin: { machineId: 'm1', daemonEpoch: 1 },
    ...(opts?.ceoWorkspaceId !== undefined ? { ceoWorkspaceId: opts.ceoWorkspaceId } : {}),
    ...(opts?.now ? { now: opts.now } : {}),
  });
}

// ── 주입 가능한 fake ChannelPort (실패·상태 제어) ──────────────────────
function makeFakeChannelPort(opts?: { failCreate?: boolean }) {
  let seq = 0;
  const channels = new Map<string, { id: string; topic?: string; status: 'active' | 'archived' }>();
  const archiveCalls: string[] = [];
  const port: WorkTaskChannelPort = {
    create: vi.fn(async (params) => {
      if (opts?.failCreate) {
        return { ok: false as const, error: { code: 'PERSIST_FAILED', message: 'forced' } };
      }
      const id = `ch-${++seq}`;
      channels.set(id, { id, ...(params.topic !== undefined ? { topic: params.topic } : {}), status: 'active' });
      return { ok: true as const, channel: { id } };
    }),
    archive: vi.fn(async (params) => {
      archiveCalls.push(params.channelId);
      const ch = channels.get(params.channelId);
      if (!ch) return { ok: false as const, error: { code: 'CHANNEL_NOT_FOUND', message: 'nf' } };
      ch.status = 'archived';
      return { ok: true as const };
    }),
    listAllForReconcile: () => [...channels.values()].map((c) => ({ ...c })),
  };
  // 테스트 헬퍼: 크래시/외부 변이 시뮬레이션(non-null assertion 회피).
  const setStatus = (id: string, status: 'active' | 'archived'): void => {
    const ch = channels.get(id);
    if (ch) ch.status = status;
  };
  return { port, channels, archiveCalls, setStatus };
}

// ═══ §2 경로 정규화 유틸 ═══════════════════════════════════════════════

describe('normalizeWorktreePath (§2 배타 불변식 정규화)', () => {
  it('trailing slash·중복 슬래시 제거', () => {
    expect(normalizeWorktreePath('/a/b//c/', 'linux')).toBe('/a/b/c');
  });
  it('대소문자 무구분 FS는 lower-case canonical', () => {
    expect(normalizeWorktreePath('/A/B', 'darwin')).toBe('/a/b');
    expect(normalizeWorktreePath('/A/B', 'linux')).toBe('/A/B');
  });
  it('백슬래시(win)를 슬래시로 통일', () => {
    expect(normalizeWorktreePath('C:\\Repo\\WT', 'win32')).toBe('c:/repo/wt');
  });
});

describe('missionTopic 앵커 (§3)', () => {
  it('round-trips taskId', () => {
    expect(taskIdFromMissionTopic(missionTopicFor('wtask-abc'))).toBe('wtask-abc');
  });
  it('비앵커 topic은 null', () => {
    expect(taskIdFromMissionTopic('random topic')).toBeNull();
    expect(taskIdFromMissionTopic(undefined)).toBeNull();
  });
});

// ═══ §0 성공기준 — E2E 왕복 ════════════════════════════════════════════

describe('§0 성공기준 E2E 왕복 (mission.start → post → close → 재시작 → 복원·archive 멱등)', () => {
  it('E2E: start → channel post → close → restart replay 복원 + archive 멱등 no-op', async () => {
    const writer = makeFakeWriter();
    const channelSvc = newChannelService(writer);
    const log = newLog();
    const svc = newWorkTaskService(log, channelSvc as unknown as WorkTaskChannelPort);
    await svc.boot();

    // 1) mission.start — 태스크 + 미션 채널 생성.
    const started = await svc.startMission({
      title: 'Ship the widget',
      verifiedWorkspaceId: 'ws-owner',
      memberId: 'lead',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { taskId, channelId } = started;

    // 채널이 실제로 생겼고 topic 앵커가 박혔다.
    const created = channelSvc.get(channelId, 'ws-owner');
    expect(created).not.toBeNull();
    expect(created?.topic).toBe(missionTopicFor(taskId));
    expect(created?.status).toBe('active');

    // 2) 채널 post — 미션 채널은 평범한 채널이라 그대로 소비된다.
    const posted = await channelSvc.post({
      channelId,
      sender: { workspaceId: 'ws-owner', memberId: 'lead' },
      text: 'kickoff',
      verifiedWorkspaceId: 'ws-owner',
    });
    expect(posted.ok).toBe(true);

    // 3) mission.close — 태스크 closed + 채널 archive.
    const closed = await svc.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    expect(closed.ok).toBe(true);
    expect(svc.getTask(taskId)?.status).toBe('closed');
    expect(channelSvc.get(channelId, 'ws-owner')?.status).toBe('archived');

    // 4) 데몬 재시작 시뮬레이션 — 같은 로그·같은 writer 위에 서비스 재생성 + boot replay.
    const channelSvc2 = newChannelService(writer); // writer.load()가 마지막 저장 상태 복원.
    const log2 = newLog(); // 같은 dir → 같은 세그먼트 replay.
    const svc2 = newWorkTaskService(log2, channelSvc2 as unknown as WorkTaskChannelPort);
    await svc2.boot();

    // projection 복원: closed 태스크가 살아있다.
    const restored = svc2.getTask(taskId);
    expect(restored).toBeDefined();
    expect(restored?.status).toBe('closed');
    expect(restored?.missionChannelId).toBe(channelId);

    // archive 멱등 재시도 no-op: 부트 reconcile 태스크 방향이 이미 archived 채널을
    // 다시 archive하려 해도 no-op(에러 없음). 채널은 여전히 archived.
    expect(channelSvc2.get(channelId, 'ws-owner')?.status).toBe('archived');

    // 재close도 멱등 no-op ack.
    const reclose = await svc2.closeMission({ taskId, verifiedWorkspaceId: 'ws-owner' });
    expect(reclose.ok).toBe(true);
  });
});

// ═══ §3 멱등 (start 재시도 · 재close) ═══════════════════════════════════

describe('§3 멱등', () => {
  it('같은 idempotency_key start 재시도는 채널·태스크 중복 없이 원본 반환', async () => {
    const { port, create } = (() => {
      const f = makeFakeChannelPort();
      return { port: f.port, create: f.port.create as ReturnType<typeof vi.fn> };
    })();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();

    const r1 = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead', idempotencyKey: 'k1' });
    const r2 = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead', idempotencyKey: 'k1' });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.taskId).toBe(r1.taskId);
    expect(r2.channelId).toBe(r1.channelId);
    // 채널 생성은 정확히 1회.
    expect(create).toHaveBeenCalledTimes(1);
    expect(svc.taskCount).toBe(1);
  });

  it('재close는 멱등 no-op ack (에러 아님)', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const c1 = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    const c2 = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
  });
});

// ═══ §3 authz (타 워크스페이스 거부 · CEO 허용) ══════════════════════════

describe('§3 close authz (owner OR CEO)', () => {
  it('타 워크스페이스 close 거부', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-owner', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-intruder' });
    expect(r.ok).toBe(false);
    // 정본 불변: 거부된 close는 태스크를 open으로 남긴다.
    expect(svc.getTask(started.taskId)?.status).toBe('open');
  });

  it('CEO는 타 워크스페이스 태스크도 close 가능', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port, { ceoWorkspaceId: 'ws-ceo' });
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-owner', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-ceo' });
    expect(r.ok).toBe(true);
    expect(svc.getTask(started.taskId)?.status).toBe('closed');
  });
});

// ═══ §3 보상 archive (append 실패) ═════════════════════════════════════

describe('§3 실패 보상 archive', () => {
  it('task.create append 실패 시 생성된 채널을 즉시 보상 archive', async () => {
    const { port, archiveCalls } = makeFakeChannelPort();
    // append를 강제 실패시키는 로그 스텁.
    const failingLog = {
      append: vi.fn(async () => false),
      readAllRecords: () => [],
    };
    const svc = newWorkTaskService(failingLog as never, port);
    await svc.boot();
    const r = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(r.ok).toBe(false);
    // 채널은 만들어졌지만(create 성공) append 실패로 보상 archive가 그 채널을 아카이브.
    expect(archiveCalls).toHaveLength(1);
    // projection에 태스크 없음(append 무커밋).
    expect(svc.taskCount).toBe(0);
  });

  it('채널 create 실패면 태스크 생성 없이 명시 에러', async () => {
    const { port } = makeFakeChannelPort({ failCreate: true });
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const r = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(r.ok).toBe(false);
    expect(svc.taskCount).toBe(0);
  });
});

// ═══ §3 양방향 reconcile (고아 채널 · closed+active) ════════════════════

describe('§3 양방향 부트 reconcile', () => {
  it('채널 방향: projection에 없는 mission-topic 고아 채널을 archive (크래시 창)', async () => {
    // 사전상태: mission-topic 앵커가 박힌 active 채널이 있으나 로그엔 task.create 없음.
    const { port, channels, archiveCalls } = makeFakeChannelPort();
    channels.set('ch-orphan', { id: 'ch-orphan', topic: missionTopicFor('wtask-ghost'), status: 'active' });
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot(); // reconcile 채널 방향이 고아를 줍는다.
    expect(archiveCalls).toContain('ch-orphan');
    expect(channels.get('ch-orphan')?.status).toBe('archived');
  });

  it('태스크 방향: closed 태스크의 채널이 active면 부트에서 archive 재시도', async () => {
    // 1) 정상 start+close를 실 로그에 남긴 뒤,
    const { port, channels, setStatus } = makeFakeChannelPort();
    const log = newLog();
    const svc = newWorkTaskService(log, port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    // 2) 크래시 창 시뮬레이션: 채널을 다시 active로 되돌린다(close의 archive가 유실됐다고 가정).
    setStatus(started.channelId, 'active');
    // 3) 재부트: 태스크 방향 reconcile이 closed+active를 잡아 archive 재시도.
    const log2 = newLog();
    const svc2 = newWorkTaskService(log2, port);
    await svc2.boot();
    expect(channels.get(started.channelId)?.status).toBe('archived');
    expect(svc2.getTask(started.taskId)?.status).toBe('closed');
  });
});

// ═══ §3 외부 변이 내성 (선archive · 채널 소실) ═════════════════════════

describe('§3 close 채널 상태 무조건 내성', () => {
  it('사람이 채널을 먼저 archive해도 close 성립 (archive no-op)', async () => {
    const { port, setStatus } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // 외부 선archive.
    setStatus(started.channelId, 'archived');
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    expect(r.ok).toBe(true);
    expect(svc.getTask(started.taskId)?.status).toBe('closed');
  });

  it('채널이 reaper로 소실돼도 close 성립 (CHANNEL_NOT_FOUND no-op)', async () => {
    const { port, channels } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    channels.delete(started.channelId); // reaper 소실.
    const r = await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    expect(r.ok).toBe(true);
  });
});

// ═══ §1 closed GC (7일 + archive 미확인 면제) ══════════════════════════

describe('§1 closed projection GC', () => {
  it('7일 경과 closed(채널 archived)는 projection 퇴출', async () => {
    let clock = 1_000_000;
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port, { now: () => clock });
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    // 8일 경과.
    clock += 8 * 24 * 60 * 60 * 1000;
    svc.gcClosedTasks();
    expect(svc.getTask(started.taskId)).toBeUndefined();
  });

  it('archive 미확인 closed(채널 여전히 active)는 GC 면제', async () => {
    let clock = 1_000_000;
    const { port, setStatus } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port, { now: () => clock });
    await svc.boot();
    const started = await svc.startMission({ title: 'T', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await svc.closeMission({ taskId: started.taskId, verifiedWorkspaceId: 'ws-a' });
    // 채널을 강제로 active로 되돌려 archive 미확인 상태 조성.
    setStatus(started.channelId, 'active');
    clock += 8 * 24 * 60 * 60 * 1000;
    svc.gcClosedTasks();
    // 면제: 여전히 projection에 남는다(태스크 방향 reconcile 복구 대상 보존).
    expect(svc.getTask(started.taskId)?.status).toBe('closed');
  });
});

// ═══ §2 DoS 캡 (워크스페이스당 open 상한) ══════════════════════════════

describe('§2 open 태스크 캡', () => {
  it('list는 owner 스코프만 반환', async () => {
    const { port } = makeFakeChannelPort();
    const svc = newWorkTaskService(newLog(), port);
    await svc.boot();
    await svc.startMission({ title: 'A', verifiedWorkspaceId: 'ws-a', memberId: 'lead' });
    await svc.startMission({ title: 'B', verifiedWorkspaceId: 'ws-b', memberId: 'lead' });
    expect(svc.listMissions('ws-a')).toHaveLength(1);
    expect(svc.listMissions('ws-b')).toHaveLength(1);
    expect(svc.listMissions('ws-c')).toHaveLength(0);
  });
});
