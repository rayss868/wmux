// 검증 리그 — SIM S5: no-ack ×3 (설계 §4 시나리오 S5)
//
// 계약(v1.1 §4 — **현행 영수증 계약 고정**): no-ack 페르소나는 수신하되 ack하지 않는다.
// `deliveryStatus`는 ack로만 pending→delivered 전이한다
// (`ChannelService.ack` `src/daemon/channels/ChannelService.ts:2086-2090`, 스키마
// `src/shared/channels.ts:159`). ack 없으면 pending 유지 — 그리고 어느 수신자가 ack하면
// 그 순간 메시지 deliveryStatus도 delivered로 전이한다("적어도 하나 delivered").
//
// **왜 이걸 고정하는가**(리뷰 Claude m/80): Q1-2 P3가 이 영수증 계약을 뒤집을 때 리그가
// **함께 깨져** 갱신을 강제하는 것이 의도다. 그래서 어서션이 정본 좌표를 주석에 달고
// (assert.ts `assertDeliveryStatus` 헤더), 현행 계약을 리터럴로 못박는다. 계약이 바뀌면
// 이 테스트가 red가 되어 "리그도 갱신하라"는 신호가 된다.
//
// 실행 모델: 채널 open(sender 1 + no-ack 수신 3) → sender가 1발 post → **아무도 ack 안
// 한 상태**에서 deliveryStatus=pending·전 수신자 스냅샷 pending 확인 → no-ack 3종은
// 계속 ack 안 함(unread 유지) → 그 중 1명만 ack → 그 순간 메시지 deliveryStatus=delivered
// 로 전이(& 그 수신자 스냅샷만 delivered, 나머지 no-ack은 여전히 pending) 확인.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import {
  assertDeliveryStatus,
  assertUnread,
  type RigChannelMessage,
  type RigDeliveryRow,
  type RigUnreadEntry,
} from '../harness/assert';
import { pickSeed } from '../harness/seed';

const NO_ACK_COUNT = 3;

describe('SIM S5 — no-ack ×3: 현행 영수증 계약 고정 (deliveryStatus는 ack로만 전이)', () => {
  let ctx: RigContext;
  let daemon: RigDaemon;
  let runner: PersonaRunner;
  const seed = pickSeed();

  beforeAll(async () => {
    ctx = createRigContext();
    daemon = new RigDaemon(ctx);
    await daemon.start();
  }, 120000);

  afterAll(async () => {
    runner?.closeAll();
    await daemon?.teardown();
    if (ctx) removeRigHome(ctx);
  });

  it('ack 없으면 deliveryStatus·수신자 스냅샷 pending 유지, ack하면 그 순간 전이한다', async () => {
    // eslint-disable-next-line no-console
    console.log(`[S5] seed=${seed} (WMUX_RIG_SEED=${seed} 로 재현)`);
    try {
      runner = new PersonaRunner(ctx, { idPrefix: 's5', seed });
      const all = runner.spawn(1 + NO_ACK_COUNT);
      const sender = all[0];
      const receivers = all.slice(1); // no-ack 3종.
      const { channelId, nextSeq } = await runner.openChannel('rig-s5-noack', sender, receivers);
      expect(nextSeq, 'create 직후 nextSeq=1').toBe(1);

      // sender가 1발 post. 이 시점 메시지 deliveryStatus=pending, 스냅샷 전원 pending.
      const posted = await sender.client.channelRpc('a2a.channel.post', {
        channelId,
        sender: { workspaceId: sender.ws, memberId: sender.ws },
        text: 's5|the-message',
      });
      const postedSeq = (posted['message'] as { seq: number }).seq;
      expect(postedSeq, '첫 post seq=1').toBe(1);

      // 헬퍼: 현재 원장에서 postedSeq 메시지 행을 가져온다(deliveryStatus + snapshot 포함).
      const readRow = async (): Promise<RigChannelMessage & RigDeliveryRow> => {
        const fetched = await sender.client.channelRpc('a2a.channel.getMessages', { channelId });
        const msgs = (fetched['messages'] ?? []) as Array<RigChannelMessage & RigDeliveryRow>;
        const row = msgs.find((m) => m.seq === postedSeq);
        if (!row) throw new Error(`[S5] posted message seq=${postedSeq} not found`);
        return row;
      };

      // 1. 누구도 ack 안 한 상태: 메시지 pending + 각 no-ack 수신자 스냅샷 pending.
      let row = await readRow();
      for (const r of receivers) {
        assertDeliveryStatus(row, 'pending', r.ws, 'pending');
      }

      // 2. no-ack 3종이 계속 ack 안 함 → 각자 unread=1(자기 아닌 그 메시지 미열람).
      //    이게 no-ack 페르소나의 정의: 수신 가능하지만 ack를 안 해 영수증이 안 뜬다.
      for (const r of receivers) {
        const unread = await r.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        assertUnread(entries, channelId, r.ws, { unread: 1, headSeq: 1 });
      }

      // 3. no-ack 중 딱 1명만 ack → 그 순간 (a) 메시지 deliveryStatus=delivered("적어도
      //    하나"), (b) 그 수신자 스냅샷만 delivered, (c) 나머지 no-ack은 여전히 pending.
      const acker = receivers[0];
      const stillNoAck = receivers.slice(1);
      await acker.client.channelRpc('a2a.channel.ack', {
        channelId,
        uptoSeq: postedSeq,
        memberId: acker.ws, // 멤버 스코프 ack(커서 전진 포함) — 에이전트 소비 경로.
      });

      row = await readRow();
      // (a)+(b): 메시지는 delivered, acker 스냅샷은 delivered.
      assertDeliveryStatus(row, 'delivered', acker.ws, 'delivered');
      // (c): 아직 ack 안 한 no-ack 수신자들의 스냅샷은 여전히 pending(메시지가 delivered
      //      로 뜬 것과 무관하게 per-recipient 영수증은 각자 ack로만 뒤집힌다).
      for (const r of stillNoAck) {
        const entries = (row.recipientSnapshot ?? []).filter((e) => e.workspaceId === r.ws);
        expect(entries.length, `no-ack ${r.ws} 스냅샷 엔트리 존재`).toBeGreaterThan(0);
        for (const e of entries) {
          expect(e.status, `no-ack ${r.ws}는 여전히 pending`).toBe('pending');
        }
      }

      // 4. acker의 unread는 0으로 떨어졌지만(커서 전진), no-ack들은 여전히 unread=1.
      {
        const unread = await acker.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        assertUnread(entries, channelId, acker.ws, { unread: 0 });
      }
      for (const r of stillNoAck) {
        const unread = await r.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        assertUnread(entries, channelId, r.ws, { unread: 1 });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S5] FAILED with seed=${seed} — reproduce with WMUX_RIG_SEED=${seed}`);
      // eslint-disable-next-line no-console
      console.error(`[S5] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
