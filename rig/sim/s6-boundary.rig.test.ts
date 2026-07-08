// 검증 리그 — SIM S6: boundary (설계 §4 시나리오 S6)
//
// 계약(§4): 캡 경계 수용/거부 정확성을 **와이어 레벨**로(경계±1). 오프-바이-원 회귀를 잡는다.
//
// 대상 캡(정본):
//   - 채널 본문: CHANNEL_BODY_MAX=8192 (`src/shared/channels.ts:371`) → 초과 시
//     CHANNEL_BODY_TOO_LARGE (`ChannelService.post` :1660-1667). 새니타이즈 후 길이로
//     측정(`sanitizePostText` :2589 — C0 스트립 + trim)이라 순수 ASCII는 길이 보존.
//   - 멘션 수: CHANNEL_MENTIONS_MAX=64 (`:386`) → CHANNEL_MENTIONS_TOO_MANY (:1702-1710).
//     이 캡은 **멤버십 검증·드롭보다 먼저** 걸린다(:1698 "Reject BEFORE allocating a seq")
//     — 그래서 멘션 대상은 실멤버일 필요가 없다(합성 ws로 충분). 이 성질 덕에 S6은
//     소켓 1개(sender 혼자)로 캡을 밟을 수 있다(데몬 연결률 캡 회피 — 아래 주석).
//   - 완료증거 E12: item 문자열 캡 EVIDENCE_MAX_STR_BYTES=4096 바이트
//     (`src/shared/completionEvidence.ts:15,:58-59`) → completion_evidence_too_large (:93).
//
// **왜 sender 1인인가**(리뷰 없이 확정한 하네스 판단): DaemonPipeServer는
// MAX_NEW_CONNECTIONS_PER_SEC=20 (`DaemonPipeServer.ts:57,:251-252`)로 초당 새 연결을
// 캡한다. 멘션 캡을 실멤버 64명으로 밟으려면 64 소켓이 ~1초에 열려 이 캡을 초과해 데몬이
// 연결을 끊는다("connection lost"). 멘션 캡이 멤버십보다 먼저 걸리므로 합성 ws 65개를
// 실으면 소켓 1개로 정확히 같은 계약을 와이어로 검증한다(진짜 캡, 백도어 아님).
//
// 채널 캡은 channelRpc가 result.ok===false를 throw로 승격 → 거부는 rejects, 수용은 정상
// 반환. A2A 증거 캡은 rpc() 페이로드의 {ok,error}로 직접 판정.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import { pickSeed } from '../harness/seed';

// 정본 캡 값(리터럴 고정 — 정본이 바뀌면 이 테스트가 red가 되어 갱신 강제).
const CHANNEL_BODY_MAX = 8192; // src/shared/channels.ts:371
const CHANNEL_MENTIONS_MAX = 64; // src/shared/channels.ts:386
const EVIDENCE_MAX_ITEMS = 64; // src/shared/completionEvidence.ts:14 (E12)
const EVIDENCE_MAX_STR_BYTES = 4 * 1024; // src/shared/completionEvidence.ts:15 — item 문자열 각각

describe('SIM S6 — boundary: 캡 경계 수용/거부 정확성 (와이어 레벨)', () => {
  let ctx: RigContext;
  let daemon: RigDaemon;
  let runner: PersonaRunner;
  const seed = pickSeed();

  beforeAll(async () => {
    ctx = createRigContext();
    daemon = new RigDaemon(ctx);
    await daemon.start();
    runner = new PersonaRunner(ctx, { idPrefix: 's6', seed });
  }, 120000);

  afterAll(async () => {
    runner?.closeAll();
    await daemon?.teardown();
    if (ctx) removeRigHome(ctx);
  });

  it('본문·멘션 캡: 경계값은 수용, +1은 정본 사유코드로 거부한다', async () => {
    // 고정 경계값 시나리오라 결정적(rng 미사용) — seed는 PersonaRunner rng 시드로만
    // 쓰이고 이 시나리오 본문은 소비하지 않는다. 시드 재현 문구를 두지 않는다(거짓 신호 방지).
    try {
      // sender 1인만 — 멘션 캡은 멤버십보다 먼저 걸리므로 실멤버 무리가 불필요(위 주석).
      const [sender] = runner.spawn(1);
      const { channelId } = await runner.openChannel('rig-s6-boundary', sender);

      // 1. 본문 캡: 정확히 8192 바이트(순수 ASCII 1B/char, 새니타이즈로 길이 불변)는 수용.
      const atLimit = 'a'.repeat(CHANNEL_BODY_MAX);
      const okRes = await sender.client.channelRpc('a2a.channel.post', {
        channelId,
        sender: { workspaceId: sender.ws, memberId: sender.ws },
        text: atLimit,
      });
      expect((okRes['message'] as { text: string }).text.length, '경계 본문 수용(8192)').toBe(
        CHANNEL_BODY_MAX,
      );

      // 본문 +1(8193)은 CHANNEL_BODY_TOO_LARGE로 거부.
      const overBody = 'a'.repeat(CHANNEL_BODY_MAX + 1);
      const bodyErr = await sender.client
        .channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: sender.ws, memberId: sender.ws },
          text: overBody,
        })
        .then(() => null, (e: Error) => e);
      expect(bodyErr, '본문 +1 거부').toBeTruthy();
      expect(String(bodyErr), '정본 사유코드 CHANNEL_BODY_TOO_LARGE').toMatch(
        /CHANNEL_BODY_TOO_LARGE/,
      );

      // 2. 멘션 캡: 정확히 64 멘션(합성 ws — 멤버십보다 캡이 먼저라 값 무관)은 수용.
      //    non-member라 전부 droppedMentions로 에코되지만 **post 자체는 성공**(캡 미초과).
      const mkMentions = (n: number): Array<{ workspaceId: string; name: string }> =>
        Array.from({ length: n }, (_, i) => ({ workspaceId: `ws-rig-s6-m${i}`, name: `m${i}` }));

      const okMentions = await sender.client.channelRpc('a2a.channel.post', {
        channelId,
        sender: { workspaceId: sender.ws, memberId: sender.ws },
        text: 's6|mentions-at-cap',
        mentions: mkMentions(CHANNEL_MENTIONS_MAX),
      });
      expect((okMentions['message'] as { seq: number }).seq, '경계 멘션 수용(64)').toBeGreaterThan(0);

      // 멘션 +1(65)은 CHANNEL_MENTIONS_TOO_MANY로 거부(캡이 멤버십·드롭보다 먼저).
      const mentionErr = await sender.client
        .channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: sender.ws, memberId: sender.ws },
          text: 's6|mentions-over-cap',
          mentions: mkMentions(CHANNEL_MENTIONS_MAX + 1),
        })
        .then(() => null, (e: Error) => e);
      expect(mentionErr, '멘션 +1 거부').toBeTruthy();
      expect(String(mentionErr), '정본 사유코드 CHANNEL_MENTIONS_TOO_MANY').toMatch(
        /CHANNEL_MENTIONS_TOO_MANY/,
      );

      // 데몬 생존(캡 거부가 데몬을 흔들지 않음 — 거부는 seq도 소비 안 함). daemon.ping
      // 핸들러는 `{ status: 'ok', ... }` 반환(`src/daemon/index.ts:1548`).
      const ping = (await sender.client.rpc('daemon.ping', {})) as { status?: string };
      expect(ping.status, '캡 거부 후 데몬 생존').toBe('ok');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S6] FAILED (deterministic fixed-boundary scenario — no seed dependency)`);
      // eslint-disable-next-line no-console
      console.error(`[S6] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);

  it('완료증거 캡(E12): 과대 item 문자열은 completion_evidence_too_large로 거부, 경계는 수용', async () => {
    try {
      const [from, to] = runner.spawn(2);

      // 태스크 생성(from→to) → working → completed. id는 결정적(runId로 유일).
      const taskId = `rig-s6-evidence-${ctx.runId}`;
      const created = (await from.client.rpc('a2a.task.create', {
        id: taskId,
        title: 's6 evidence cap',
        from: { workspaceId: from.ws, name: from.ws },
        to: { workspaceId: to.ws, name: to.ws },
      })) as { ok?: boolean; taskId?: string };
      expect(created.ok, 'task.create ok').toBe(true);

      // to가 수신자 authz로 working 전이(정상 — 비종단이라 증거 게이트 비대상).
      const working = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'working',
      })) as { ok?: boolean };
      expect(working.ok, 'working 전이 ok').toBe(true);

      // completed 시도인데 item summary가 EVIDENCE_MAX_STR_BYTES+1 바이트 → per-string 캡
      // 초과. wire normalize는 총바이트(64KiB)만 보므로 이 단일 ~4KiB 문자열은 normalize를
      // 통과하고, 권위 게이트 withinCaps의 per-string 캡(`completionEvidence.ts:58-59`)에서
      // completion_evidence_too_large로 걸린다(E12 — 게이트가 too_large를 내는 실경로).
      const oversizeSummary = 'x'.repeat(EVIDENCE_MAX_STR_BYTES + 1);
      const rejected = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: {
          summary: 's6 done',
          items: [{ kind: 'command', status: 'passed', summary: oversizeSummary, command: 'echo x' }],
        },
      })) as { ok?: boolean; error?: string };
      expect(rejected.ok, '과대 문자열 증거 거부').toBe(false);
      expect(String(rejected.error), '정본 사유코드 completion_evidence_too_large').toMatch(
        /completion_evidence_too_large/,
      );

      // items 개수 경계 +1: EVIDENCE_MAX_ITEMS+1(65)개는 거부. 전부 well-formed지만 items
      // 개수 캡이 초과다. **거부 사유코드는 completion_evidence_malformed**(too_large 아님):
      // 전이 경로가 wire normalize(`normalizeCompletionEvidenceWire`)를 권위 게이트보다
      // **먼저** 태우는데, normalize가 items 개수 캡을 자체 검사(`completionEvidence.ts:155`
      // — `v.items.length > EVIDENCE_MAX_ITEMS`면 null)해 게이트에 닿기 전에 malformed로
      // 거부한다(`A2aTaskService.ts:353-359`). 즉 items 캡은 wire 레벨에서 강제되며, 그
      // 강제가 사라지는 회귀(normalize items 캡 제거)를 이 케이스가 잡는다. (문자열 캡은
      // normalize가 총바이트만 봐서 단일 4KiB가 통과→게이트 withinCaps에서 too_large로
      // 걸리는 것과 대조 — 두 경계가 서로 다른 레이어에서 강제됨.)
      const overItems = Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, (_, i) => ({
        kind: 'command' as const,
        status: 'passed' as const,
        summary: `c${i}`,
        command: `e${i}`,
      }));
      const rejectedItems = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: { summary: 's6 done', items: overItems },
      })) as { ok?: boolean; error?: string };
      expect(rejectedItems.ok, `items=${EVIDENCE_MAX_ITEMS + 1} 거부`).toBe(false);
      expect(
        String(rejectedItems.error),
        '정본 사유코드 completion_evidence_malformed (wire normalize items 캡)',
      ).toMatch(/completion_evidence_malformed/);

      // 경계 수용: EVIDENCE_MAX_ITEMS개(작은 문자열, 캡 내)면 completed 성공 — 개수 경계와
      // 문자열 경계를 동시에 밟는다(각 문자열은 캡 미만).
      const atCapItems = Array.from({ length: EVIDENCE_MAX_ITEMS }, (_, i) => ({
        kind: 'command' as const,
        status: 'passed' as const,
        summary: `c${i}`,
        command: `e${i}`,
      }));
      const accepted = (await to.client.rpc('a2a.task.update', {
        taskId,
        workspaceId: to.ws,
        status: 'completed',
        evidence: { summary: 's6 done', items: atCapItems },
      })) as { ok?: boolean; verifiedItemCount?: number };
      expect(accepted.ok, '증거 경계 수용(completed, items=64)').toBe(true);
      expect(accepted.verifiedItemCount, 'verifiedItemCount = 전 item passed').toBe(EVIDENCE_MAX_ITEMS);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S6-evidence] FAILED with seed=${seed}`);
      // eslint-disable-next-line no-console
      console.error(`[S6-evidence] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
