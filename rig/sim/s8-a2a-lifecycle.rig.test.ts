// 검증 리그 — SIM S8: A2A 전 수명주기 + EPERM 카오스 (설계 §4 시나리오 S8)
//
// 계약(v1.1 §4): A2A 태스크 전 수명주기를 **와이어 레벨**로 —
//   (a) send→working→completed 정상 경로 + verifiedItemCount 방출(§6.M PR-C).
//   (b) 완료증거 게이트 거부(§6.M PR-B) → 유효 증거로 재시도 성공.
//   (c) 멱등 재전송(같은 idempotencyKey = 로그 append 없이 동일 결과).
//   (d) **멱등-authz 순서**(EVIDENCE ①단 대상): 비참여자가 키를 알아도 authz가 먼저
//       걸려 커밋 스냅샷을 재생 조회할 수 없다(#354 `2264c4a` — 데몬측 가드).
//   + EPERM 카오스(unix): 소켓 chmod 000 → 클라이언트 실패 격리·데몬 생존·복구.
//
// 정본 좌표:
//   - transition authz: `A2aTaskService.transition` `src/daemon/a2a/A2aTaskService.ts:312-334`
//     (수신자 workspace만 전이 가능 → 멱등 히트는 authz **뒤**).
//   - VALID_TRANSITIONS: `src/shared/types.ts:655` (submitted→working→completed).
//   - 완료증거 게이트: `src/shared/completionEvidence.ts:75` validateCompletionEvidence.
//
// ── A2A workspaceId 컨벤션(채널 verifiedWorkspaceId와 다름 — 하네스가 막지 않는 이유) ──
// A2A task RPC(create/update/cancel/query)의 `workspaceId`는 **데몬이 authz로 검증하는
// 호출자 주장 신원**이다(`daemon/index.ts:1991` callerWorkspaceId=workspaceId → transition의
// `to.workspaceId !== callerWorkspaceId` 게이트). 채널의 `verifiedWorkspaceId`(transport가
// 서버핀·channelRpc가 스탬프)와 근본이 다르다. 그래서 이 값은 rpc()로 보내며, G6 하네스
// 위생은 **일부러** 이 필드를 막지 않는다 — S8의 #354 authz 테스트가 **비참여자 ws 자칭을
// 정확히 필요로** 하기 때문이다(하네스가 막으면 authz 테스트 자체가 불가능). 페르소나는
// 자기 ws만 쓰는 것이 규율이되, `#354` 테스트만 의도적으로 outsider ws를 자칭한다.
//
// 실행 모델: RigDaemon.spawn → 두 페르소나(from/to) → 수명주기 4단 → EPERM 카오스.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import { assertTaskState, type RigTask } from '../harness/assert';
import { pickSeed } from '../harness/seed';

/** 유효 완료증거 하나(completed 게이트 통과 최소형 — command passed 1건). */
const validEvidence = (summary: string) => ({
  summary,
  items: [{ kind: 'command' as const, status: 'passed' as const, summary, command: 'echo ok' }],
});

describe('SIM S8 — A2A 전 수명주기 + EPERM 카오스', () => {
  let ctx: RigContext;
  let daemon: RigDaemon;
  let runner: PersonaRunner;
  const seed = pickSeed();

  beforeAll(async () => {
    ctx = createRigContext();
    daemon = new RigDaemon(ctx);
    await daemon.start();
    // runner를 beforeAll에서 만든다 — 각 it이 runner.spawn()으로 **새 페르소나**(인덱스
    // 자동증가·태스크 id는 prefix로 유일)를 뽑으므로 테스트 간 독립적이고, `-t`로 개별
    // 실행해도 runner가 항상 준비된다(테스트 순서 결합 제거).
    runner = new PersonaRunner(ctx, { idPrefix: 's8', seed });
  }, 120000);

  afterAll(async () => {
    runner?.closeAll();
    await daemon?.teardown();
    if (ctx) removeRigHome(ctx);
  });

  it('send→working→completed 정상 경로 + verifiedItemCount 방출', async () => {
    // 고정 시퀀스라 결정적(rng 미사용) — seed는 PersonaRunner rng 시드로만 쓰이고 이
    // 시나리오 본문은 소비하지 않는다. 시드 재현 문구를 두지 않는다(거짓 신호 방지).
    try {
      const [from, to] = runner.spawn(2);
      const taskId = `rig-s8-happy-${ctx.runId}`;

      // create (from→to). task.create/update는 신원류 스탬프가 아니라 명시 from/to/
      // workspaceId 필드를 쓰므로 rpc()로 보낸다(G6 위생: from/to.workspaceId는 신원류
      // 키지만 예약 신원이 아니고, verifiedWorkspaceId 밀수도 아니라 통과).
      const created = (await from.client.rpc('a2a.task.create', {
        id: taskId,
        title: 's8 happy path',
        from: { workspaceId: from.ws, name: from.ws },
        to: { workspaceId: to.ws, name: to.ws },
      })) as { ok?: boolean; taskId?: string };
      expect(created.ok, 'create ok').toBe(true);
      expect(created.taskId, 'create가 taskId 반환').toBe(taskId);

      // submitted→working (수신자 to의 authz).
      const working = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'working',
      })) as { ok?: boolean };
      expect(working.ok, 'working 전이 ok').toBe(true);

      // working→completed (유효 증거 → 게이트 통과 + verifiedItemCount=1).
      const completed = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: validEvidence('s8 verified'),
      })) as { ok?: boolean; verifiedItemCount?: number };
      expect(completed.ok, 'completed 전이 ok').toBe(true);
      expect(completed.verifiedItemCount, 'verifiedItemCount=1 (command passed)').toBe(1);

      // query로 정본 상태 확인(completed).
      const q = (await to.client.rpc('a2a.task.query', { workspaceId: to.ws })) as {
        tasks?: RigTask[];
      };
      assertTaskState(q.tasks ?? [], taskId, 'completed');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S8-happy] FAILED (deterministic — no seed dependency)\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);

  it('완료증거 게이트 거부 → 유효 증거로 재시도 성공', async () => {
    try {
      const [from, to] = runner.spawn(2);
      const taskId = `rig-s8-gate-${ctx.runId}`;
      await from.client.rpc('a2a.task.create', {
        id: taskId,
        title: 's8 gate',
        from: { workspaceId: from.ws, name: from.ws },
        to: { workspaceId: to.ws, name: to.ws },
      });
      await to.client.rpc('a2a.task.update', { taskId, workspaceId: to.ws, status: 'working' });

      // completed인데 증거 없음 → 게이트 거부(completion_evidence_missing). append 안 됨.
      const rejected = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
      })) as { ok?: boolean; error?: string };
      expect(rejected.ok, '증거 없는 completed는 거부').toBe(false);
      expect(String(rejected.error), '정본 사유코드 completion_evidence_missing').toMatch(
        /completion_evidence_missing/,
      );

      // 상태는 여전히 working(거부는 상태를 바꾸지 않음 — append 없음).
      let q = (await to.client.rpc('a2a.task.query', { workspaceId: to.ws })) as { tasks?: RigTask[] };
      assertTaskState(q.tasks ?? [], taskId, 'working');

      // 유효 증거로 재시도 → 성공.
      const retried = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: validEvidence('s8 gate retry'),
      })) as { ok?: boolean };
      expect(retried.ok, '유효 증거 재시도 성공').toBe(true);
      q = (await to.client.rpc('a2a.task.query', { workspaceId: to.ws })) as { tasks?: RigTask[] };
      assertTaskState(q.tasks ?? [], taskId, 'completed');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S8-gate] FAILED (deterministic — no seed dependency)\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);

  it('멱등 재전송: 같은 idempotencyKey는 로그 append 없이 동일 결과', async () => {
    try {
      const [from, to] = runner.spawn(2);
      const taskId = `rig-s8-idem-${ctx.runId}`;
      await from.client.rpc('a2a.task.create', {
        id: taskId,
        title: 's8 idem',
        from: { workspaceId: from.ws, name: from.ws },
        to: { workspaceId: to.ws, name: to.ws },
      });
      await to.client.rpc('a2a.task.update', { taskId, workspaceId: to.ws, status: 'working' });

      const key = 'idem-key-s8';
      // 1차 completed with key.
      const first = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: validEvidence('s8 idem done'),
        idempotencyKey: key,
      })) as { ok?: boolean; verifiedItemCount?: number };
      expect(first.ok, '1차 completed ok').toBe(true);

      // 2차 같은 key 재전송 → 멱등 히트(로그 append 없이 동일 결과). completed는 종단이라
      // 정상 전이라면 재전송이 invalid transition(completed→completed)이겠지만, 멱등 히트가
      // validateTransition **앞**에 있어(2264c4a 배치) 종단 재시도가 원본 결과로 흡수된다.
      const second = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: validEvidence('s8 idem done'),
        idempotencyKey: key,
      })) as { ok?: boolean; verifiedItemCount?: number };
      expect(second.ok, '멱등 재전송 ok(원본 결과 흡수)').toBe(true);
      expect(second.verifiedItemCount, '멱등 재전송이 원본 verifiedItemCount 반환').toBe(
        first.verifiedItemCount,
      );

      // 상태는 completed 1건으로 안정(중복 전이 안 됨).
      const q = (await to.client.rpc('a2a.task.query', { workspaceId: to.ws })) as {
        tasks?: RigTask[];
      };
      assertTaskState(q.tasks ?? [], taskId, 'completed');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S8-idem] FAILED (deterministic — no seed dependency)\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);

  // ── EVIDENCE ①단 대상: 멱등-authz 순서(#354 `2264c4a`) ─────────────────────
  // 이 테스트가 revert 재현의 red/green 판정점이다(rig/EVIDENCE.md). main(픽스 후):
  // 비참여자가 키를 알아도 authz가 먼저 걸려 거부. revert(픽스 제거): 멱등 히트가 authz를
  // 앞질러 커밋 스냅샷을 재생 조회 → 비참여자가 태스크 상태를 얻는다(authz 우회).
  it('멱등-authz 순서: 비참여자는 키를 알아도 커밋 스냅샷을 재생 조회할 수 없다 (#354)', async () => {
    try {
      const [from, to, outsider] = runner.spawn(3);
      const taskId = `rig-s8-authz-${ctx.runId}`;
      const sharedKey = 'shared-transition-key';

      await from.client.rpc('a2a.task.create', {
        id: taskId,
        title: 's8 authz order',
        from: { workspaceId: from.ws, name: from.ws },
        to: { workspaceId: to.ws, name: to.ws },
      });
      // 수신자 to가 정당하게 working 전이(sharedKey로 멱등 레코드 심음).
      const legit = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'working',
        idempotencyKey: sharedKey,
      })) as { ok?: boolean };
      expect(legit.ok, '수신자 정당 전이 ok').toBe(true);

      // 비참여자(outsider)가 **같은 taskId + 같은 key**로 전이를 시도한다. main(픽스)에서는
      // authz가 먼저 걸려 "is not the receiver"로 거부돼야 한다 — 멱등 히트가 authz를
      // 앞지르면(revert) outsider가 커밋된 working 스냅샷(TransitionOk)을 재생 조회한다.
      const attack = (await outsider.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: outsider.ws, // 비참여자 신원.
        status: 'working',
        idempotencyKey: sharedKey,
      })) as { ok?: boolean; error?: string; task?: unknown };
      // main green 조건: 거부 + authz 사유. (revert면 ok:true + task 스냅샷이 새어 red.)
      expect(attack.ok, '비참여자 전이는 거부돼야 한다(멱등이 authz를 앞지르지 않음)').toBe(false);
      expect(String(attack.error), 'authz 거부 사유(is not the receiver)').toMatch(/is not the receiver/);
      expect(attack.task, '비참여자에게 태스크 스냅샷이 새지 않아야 한다').toBeUndefined();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S8-authz] FAILED (deterministic — no seed dependency)\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);

  // ── EPERM 카오스(unix 한정) — 설계 G8 ──────────────────────────────────────
  // 데몬 소켓 파일을 chmod 000 → 새 연결이 EACCES/EPERM으로 실패한다(클라이언트 실패
  // 격리). 데몬 프로세스는 그대로 살아있어야 하고(소켓 권한 박탈 ≠ 데몬 사망), 권한을
  // 복원하면 다시 연결·동작해야 한다(복구). win32는 named pipe라 파일 chmod가 없어 skip.
  //
  // **root(uid 0) skip**(리뷰 MAJOR — Claude): root는 DAC 권한 비트를 전부 우회하므로
  // chmod 000 소켓에도 connect가 성공한다 → `denied`가 null이 되어 검출이 조용히 무효화
  // (false-fail). CI SIM 레인의 Linux 컨테이너는 흔히 root로 돌기에 반드시 skip한다.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const runEperm = process.platform !== 'win32' && !isRoot;
  if (isRoot) {
    // eslint-disable-next-line no-console
    console.log('[S8-eperm] EPERM chaos skipped under root — chmod bypassed by uid 0');
  }
  (runEperm ? it : it.skip)('EPERM 카오스: 소켓 chmod 000 → 클라이언트 격리·데몬 생존·복구', async () => {
    try {
      const sockPath = ctx.daemonPipePath;
      // 카오스 전: 정상 연결 확인. pid도 기록(카오스 후 동일해야 = 재시작 아님).
      const probe = runner.spawn(1)[0];
      const before = (await probe.client.rpc('daemon.ping', {})) as { status?: string };
      expect(before.status, '카오스 전 데몬 응답').toBe('ok');
      const pidBefore = daemon.pid;
      expect(pidBefore, '카오스 전 데몬 pid 존재').toBeDefined();

      // 원 권한 저장 후 소켓 권한 박탈.
      const orig = fs.statSync(sockPath).mode;
      fs.chmodSync(sockPath, 0o000);
      try {
        // **아직 소켓을 연 적 없는** 신선한 페르소나로 새 연결을 시도한다 — 이미 연결된
        // 소켓은 chmod의 영향을 안 받으므로(권한은 connect 시점 검사) 반드시 새 클라이언트
        // 여야 한다. chmod 000이라 connect가 EACCES/EPERM으로 실패해야 한다(클라이언트
        // 레벨 격리된 실패 — 데몬은 무관하게 생존).
        const blocked = runner.spawn(1)[0];
        const denied = await blocked.client.rpc('daemon.ping', {}).then(
          () => null,
          (e: Error) => e,
        );
        expect(denied, 'chmod 000 소켓 새 연결은 실패해야 한다').toBeTruthy();
        expect(String(denied), 'EACCES/EPERM류 격리된 연결 실패').toMatch(/EACCES|EPERM/i);
      } finally {
        // 권한 복원(finally — 어서션 실패해도 복원해 데몬 정리를 방해하지 않음).
        fs.chmodSync(sockPath, orig);
      }

      // 데몬 생존 + 복구: 권한 복원 후 신선한 클라이언트로 다시 응답해야 한다(데몬은
      // chmod 내내 살아있었다 — 소켓 권한 박탈이 프로세스를 죽이지 않는다).
      const recovered = runner.spawn(1)[0];
      const after = (await recovered.client.rpc('daemon.ping', {})) as { status?: string };
      expect(after.status, '권한 복원 후 데몬 응답(생존+복구)').toBe('ok');
      // 데몬 pid가 카오스 전후로 동일(재시작 아님 — 계속 살아있었음).
      expect(daemon.pid, 'EPERM 카오스 전후 pid 동일(데몬 생존)').toBe(pidBefore);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S8-eperm] FAILED (deterministic — no seed dependency)\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
