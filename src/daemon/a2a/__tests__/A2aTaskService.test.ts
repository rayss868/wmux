import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aTaskService } from '../A2aTaskService';
import type { A2aTaskTransitionPayload } from '../../../shared/a2aEventlog';
import type { CompletionEvidence } from '../../../shared/types';

let dir: string;
const syncOk = (): void => {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a2a-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newLog(): AppendOnlyLog {
  const log = new AppendOnlyLog({ dir, fsync: syncOk });
  log.open();
  return log;
}

function newService(log: AppendOnlyLog): A2aTaskService {
  return new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 } });
}

async function seedWorkingTask(svc: A2aTaskService, id = 'task-1'): Promise<string> {
  const created = await svc.createTask({
    id,
    title: 'T',
    from: { workspaceId: 'ws-sender', name: 'Sender' },
    to: { workspaceId: 'ws-receiver', name: 'Receiver' },
  });
  expect(created.ok).toBe(true);
  const working = await svc.transition({ taskId: id, to: 'working', callerWorkspaceId: 'ws-receiver' });
  expect(working.ok).toBe(true);
  return id;
}

function transitionRecords(log: AppendOnlyLog, taskId: string): A2aTaskTransitionPayload[] {
  return log
    .readAllRecords()
    .filter((r) => r.domain === 'a2a')
    .map((r) => r.payload as { kind?: string })
    .filter((p): p is A2aTaskTransitionPayload => p.kind === 'task.transition' && (p as A2aTaskTransitionPayload).taskId === taskId);
}

// ── T-A2A 전이 게이트: VALID_TRANSITIONS 데몬측 강제 ────────────────────

describe('T-A2A VALID_TRANSITIONS 데몬 강제', () => {
  it('submitted→completed 직행 거부', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-1',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const r = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(false);
    // 거부된 전이는 로그에 append되지 않는다(정본 무오염).
    expect(transitionRecords(log, 'task-1')).toHaveLength(0);
    // projection도 submitted 그대로.
    expect(svc.getTask('task-1')?.status.state).toBe('submitted');
  });

  it('working→completed 허용', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(true);
    expect(svc.getTask('task-1')?.status.state).toBe('completed');
  });

  it('수신자가 아닌 호출자의 전이 거부', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-sender' });
    expect(r.ok).toBe(false);
  });
});

// ── T-A2A: 전이가 데몬 로그에 도달(C12) + evidence payload 실림 ──────────

describe('T-A2A 로그 도달 + evidence 수용', () => {
  it('completed 전이가 domain:a2a envelope로 append되고 evidence를 verbatim 저장', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);

    const evidence: CompletionEvidence = {
      summary: 'built and tested',
      items: [
        { kind: 'command', status: 'passed', summary: 'unit tests', command: 'npm test' },
        { kind: 'inspection', status: 'unverified', summary: 'eyeballed output' },
      ],
    };
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence,
    });
    expect(r.ok).toBe(true);
    // 검증 등급(감사): command/passed 1건만 verified → 1(게이트 아님).
    expect(r.ok && r.verifiedItemCount).toBe(1);

    const recs = transitionRecords(log, 'task-1');
    const completed = recs.find((p) => p.to === 'completed');
    expect(completed).toBeDefined();
    expect(completed?.evidence?.summary).toBe('built and tested');
    expect(completed?.evidence?.items).toHaveLength(2);
    expect(completed?.verifiedItemCount).toBe(1);
    // envelope 계약: domain:'a2a'로 커밋됐다.
    const a2aRecs = log.readAllRecords().filter((rec) => rec.domain === 'a2a');
    expect(a2aRecs.length).toBeGreaterThan(0);
    // projection에도 evidence가 반영.
    expect(svc.getTask('task-1')?.status.evidence?.summary).toBe('built and tested');
  });

  it('evidence 없는 completed도 수용(게이트 아님) — Q1-4b가 아직 거부하지 않음', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(true); // 완료증거 게이트는 여기 없다(수용만)
    expect(r.ok && r.verifiedItemCount).toBeUndefined();
  });

  it('malformed evidence는 렌더러 wire 가드와 동형으로 거부(위생 — 완료증거 게이트 아님)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    const r = await svc.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { items: [{ kind: 'bogus' }] }, // summary 없음 + 미지 kind
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('completion_evidence_malformed');
    // 거부된 전이는 로그·projection 무오염.
    expect(transitionRecords(log, 'task-1').find((p) => p.to === 'completed')).toBeUndefined();
    expect(svc.getTask('task-1')?.status.state).toBe('working');
  });

  it('S-C2: 페인 핀 태스크 + 페인 신원 주장 호출자는 soft-defer(렌더러 게이트로 폴백)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-pin',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R', paneId: 'pane-7' }, // 페인 핀
    });
    const deferred = await svc.transition({
      taskId: 'task-pin',
      to: 'working',
      callerWorkspaceId: 'ws-receiver',
      callerHasPaneIdentity: true, // senderPtyId 주장 — 해석은 렌더러 소유
    });
    expect(deferred.ok).toBe(false);
    expect(!deferred.ok && deferred.error).toContain('pane-authz deferred');
    // 헤드리스(페인 신원 없음 — ClaudeWorker)는 ws-authz로 통과(워커 전이 불변식).
    const headless = await svc.transition({
      taskId: 'task-pin',
      to: 'working',
      callerWorkspaceId: 'ws-receiver',
    });
    expect(headless.ok).toBe(true);
  });
});

// ── T-A2A 멱등: 동일 키 재시도 → 로그 1건 ──────────────────────────────

describe('T-A2A 멱등', () => {
  it('동일 idempotencyKey 재시도는 append 없이 원본 결과(로그 1건)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-1',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const first = await svc.transition({ taskId: 'task-1', to: 'working', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'k1' });
    const second = await svc.transition({ taskId: 'task-1', to: 'working', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'k1' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // working 전이 레코드는 정확히 1건.
    const workingRecs = transitionRecords(log, 'task-1').filter((p) => p.to === 'working');
    expect(workingRecs).toHaveLength(1);
  });
});

// ── T-A2A 크로스-재시작: projection 복원 ───────────────────────────────

describe('T-A2A 크로스-재시작', () => {
  it('재시작 후 restoreFromLog가 태스크를 최종 상태로 복원', async () => {
    const log1 = newLog();
    const svc1 = newService(log1);
    await seedWorkingTask(svc1);
    await svc1.transition({
      taskId: 'task-1',
      to: 'completed',
      callerWorkspaceId: 'ws-receiver',
      evidence: { summary: 'done', items: [{ kind: 'inspection', status: 'verified', summary: 'ok' }] },
    });
    log1.close();

    // 재시작: 새 로그(디스크 replay) + 새 서비스 + restoreFromLog.
    const log2 = newLog();
    const svc2 = newService(log2);
    expect(svc2.taskCount).toBe(0); // 복원 전엔 비어있음
    svc2.restoreFromLog();
    const task = svc2.getTask('task-1');
    expect(task).toBeDefined();
    expect(task?.status.state).toBe('completed');
    expect(task?.status.evidence?.summary).toBe('done');
    expect(task?.metadata.to.workspaceId).toBe('ws-receiver');
    log2.close();
  });
});

// ── T-A2A 취소 + 쿼리 ─────────────────────────────────────────────────

describe('A2aTaskService cancel + query', () => {
  it('sender가 취소 가능, 쿼리는 참여 workspace로 필터', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({
      id: 'task-1',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'S' },
      to: { workspaceId: 'ws-receiver', name: 'R' },
    });
    const cancel = await svc.cancelTask({ taskId: 'task-1', callerWorkspaceId: 'ws-sender' });
    expect(cancel.ok).toBe(true);
    expect(svc.getTask('task-1')?.status.state).toBe('canceled');

    expect(svc.queryTasks('ws-sender')).toHaveLength(1);
    expect(svc.queryTasks('ws-receiver')).toHaveLength(1);
    expect(svc.queryTasks('ws-other')).toHaveLength(0);
    expect(svc.queryTasks('ws-sender', { role: 'agent' })).toHaveLength(0); // sender는 user role
  });
});

// ── 패널 수정: GC(A) · teardown force-fail(B) · 멱등 재시드(E) · idempotent cancel(G) ──

function newServiceAt(log: AppendOnlyLog, now: () => number): A2aTaskService {
  return new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 }, now });
}

describe('A(패널) projection GC', () => {
  it('30분 경과 종단 태스크는 gcTerminalTasks가 제거, 미경과·비종단은 유지', async () => {
    const t0 = 1_700_000_000_000;
    let clock = t0;
    const log = newLog();
    const svc = newServiceAt(log, () => clock);
    await svc.createTask({ id: 'done-1', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    await svc.transition({ taskId: 'done-1', to: 'working', callerWorkspaceId: 'ws-r' });
    await svc.transition({ taskId: 'done-1', to: 'completed', callerWorkspaceId: 'ws-r', evidence: { summary: 'ok', items: [] } });
    await svc.createTask({ id: 'live-1', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    await svc.transition({ taskId: 'live-1', to: 'working', callerWorkspaceId: 'ws-r' });

    clock = t0 + 31 * 60 * 1000; // 31분 경과
    svc.gcTerminalTasks();
    expect(svc.getTask('done-1')).toBeUndefined(); // 종단·경과 → 제거
    expect(svc.getTask('live-1')?.status.state).toBe('working'); // 비종단 → 유지
    log.close();
  });

  it('restoreFromLog가 부트 직후 GC를 적용 — 오래된 종단 태스크를 부활시키지 않는다', async () => {
    const t0 = 1_700_000_000_000;
    const log1 = newLog();
    const svc1 = newServiceAt(log1, () => t0);
    await svc1.createTask({ id: 'old-done', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    await svc1.transition({ taskId: 'old-done', to: 'working', callerWorkspaceId: 'ws-r' });
    await svc1.transition({ taskId: 'old-done', to: 'completed', callerWorkspaceId: 'ws-r', evidence: { summary: 'ok', items: [] } });
    log1.close();

    // 재시작이 31분 뒤라면: 로그는 영구지만 부트 GC가 오래된 종단분을 즉시 정리.
    const log2 = newLog();
    const svc2 = newServiceAt(log2, () => t0 + 31 * 60 * 1000);
    svc2.restoreFromLog();
    expect(svc2.getTask('old-done')).toBeUndefined(); // 부활 없음
    expect(svc2.taskCount).toBe(0);
    log2.close();
  });
});

describe('B(패널) teardown force-fail 진입점', () => {
  it('workspace 제거 시 non-terminal 수신 태스크를 forced 마커로 failed 커밋 + 재시작 생존', async () => {
    const log = newLog();
    const svc = newService(log);
    // ws-gone으로 향한 submitted + working, 그리고 무관한 ws-keep 태스크.
    await svc.createTask({ id: 'sub', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-gone', name: 'G' } });
    await svc.createTask({ id: 'wrk', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-gone', name: 'G' } });
    await svc.transition({ taskId: 'wrk', to: 'working', callerWorkspaceId: 'ws-gone' });
    await svc.createTask({ id: 'keep', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-keep', name: 'K' } });

    const n = await svc.failTasksForWorkspaceRemoved('ws-gone', 'gone');
    expect(n).toBe(2); // submitted + working 둘 다(그래프 우회)
    expect(svc.getTask('sub')?.status.state).toBe('failed');
    expect(svc.getTask('wrk')?.status.state).toBe('failed');
    expect(svc.getTask('keep')?.status.state).toBe('submitted'); // 무관 ws 불간섭

    // 로그에 forced 마커 + 합성 evidence.
    const subRec = transitionRecords(log, 'sub').find((p) => p.to === 'failed');
    expect(subRec?.forced).toBe('workspace_removed');
    expect(subRec?.evidence?.summary).toBe('gone');

    // 재시작: 정본이 failed로 복원(부활 없음 — teardown이 정본에 도달).
    log.close();
    const log2 = newLog();
    const svc2 = newService(log2);
    svc2.restoreFromLog();
    expect(svc2.getTask('sub')?.status.state).toBe('failed');
    expect(svc2.getTask('wrk')?.status.state).toBe('failed');
    log2.close();
  });

  it('일반 transition API는 submitted→failed를 여전히 거부(진입점이 그래프 완화 아님)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({ id: 'sub', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    const r = await svc.transition({ taskId: 'sub', to: 'failed', callerWorkspaceId: 'ws-r' });
    expect(r.ok).toBe(false);
    log.close();
  });

  it('force-fail은 멱등 — 락 대기 중 종단된 태스크는 재커밋하지 않는다(재호출 no-op)', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask({ id: 'sub', title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-gone', name: 'G' } });
    expect(await svc.failTasksForWorkspaceRemoved('ws-gone', 'gone')).toBe(1);
    expect(await svc.failTasksForWorkspaceRemoved('ws-gone', 'gone')).toBe(0); // 이미 종단 → 0
    log.close();
  });
});

describe('E(패널) 크로스-재시작 멱등 재시드', () => {
  it('재시작 후 같은 키 재시도 → 원본 결과(invalid transition 아님), 로그 무증가', async () => {
    const log1 = newLog();
    const svc1 = newService(log1);
    await seedWorkingTask(svc1); // submitted→working (키 없음)
    // completed를 멱등키와 함께 커밋.
    await svc1.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'kc', evidence: { summary: 'ok', items: [] } });
    log1.close();

    const log2 = newLog();
    const svc2 = newService(log2);
    svc2.restoreFromLog();
    const recBefore = log2.readAllRecords().length;
    // 같은 키 재시도 — 재시드가 없으면 completed→completed로 invalid transition이 된다.
    const retry = await svc2.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver', idempotencyKey: 'kc' });
    expect(retry.ok).toBe(true); // 멱등 흡수
    expect(log2.readAllRecords().length).toBe(recBefore); // append 없음
    log2.close();
  });
});

describe('G(패널) idempotent cancel', () => {
  it('이미 종단(completed)인 태스크의 cancel은 no-op 성공(로그 무증가)', async () => {
    const log = newLog();
    const svc = newService(log);
    await seedWorkingTask(svc);
    await svc.transition({ taskId: 'task-1', to: 'completed', callerWorkspaceId: 'ws-receiver', evidence: { summary: 'ok', items: [] } });
    const recBefore = log.readAllRecords().length;
    const cancel = await svc.cancelTask({ taskId: 'task-1', callerWorkspaceId: 'ws-sender' });
    expect(cancel.ok).toBe(true); // reject 아님(회귀 방지)
    expect(svc.getTask('task-1')?.status.state).toBe('completed'); // 상태 불변
    expect(log.readAllRecords().length).toBe(recBefore); // append 없음
    log.close();
  });
});

describe('A 델타: 하드캡은 종단만 축출 — 활성 태스크는 정본에서 잃지 않는다', () => {
  it('캡(500) 초과가 전부 non-terminal이면 축출 0(모두 생존)', async () => {
    const log = newLog();
    const svc = newService(log);
    for (let i = 0; i < 502; i++) {
      // eslint-disable-next-line no-await-in-loop
      await svc.createTask({ id: `t-${i}`, title: 'T', from: { workspaceId: 'ws-s', name: 'S' }, to: { workspaceId: 'ws-r', name: 'R' } });
    }
    expect(svc.taskCount).toBe(502);
    svc.gcTerminalTasks(); // 종단 후보 0 → 하드캡이 활성을 지우지 않는다
    expect(svc.taskCount).toBe(502); // 정본 무결(활성 보존)
    log.close();
  });
});
