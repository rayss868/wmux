// 검증 리그 — SIM S4: hung ×2 + 정상 ×2 (설계 §4 시나리오 S4, v1.1 재정의판)
//
// 계약(v1.1 §4 — **유일 정본**): hung 페르소나 2종은 채널에 join하고 **연결을 유지한
// 채 무응답**(ack도 post도 안 함 — dead와 달리 소켓은 살아있다). 정상 2종은 계속 활동.
// 어서션 = **채널 무결성 · 무한 홀드 없음 · unread 정확**만.
//
// ~~nudgeExhausted~~ 어서션 없음(리뷰 P5 — Claude c/85): 넛지 폭주 가드
// (`channelWakeWorker.ts:35` 재넛지 캡→nudgeExhausted)는 **live PTY 세션이 전제**
// (`channelWakeWorker.ts:88` listLiveSessions + 슬러그 매칭 + 출력 침묵). SIM은 실 PTY를
// 소비하지 않으므로(RigSession은 하네스에 준비만, 소비는 E2E/후속) 발동 조건 자체가 없다.
// 존재하지 않는 계약을 어서트하지 않는다.
//
// "무한 홀드 없음"의 SIM 모사: hung이 무응답이어도 (a) 정상 페르소나의 post가 채널
// 뮤텍스에서 블록되지 않고 즉시 커밋되며(hung의 미ack이 채널을 잠그지 않음), (b) 데몬
// ping이 전 구간 생존한다. hung의 unread는 계속 쌓인다(ack를 안 하니 정확히 미열람분).
//
// 실행 모델: 채널 open(4인) → hung 2종은 join만(이후 무응답, 소켓 유지) → 정상 2종이
// 연사 → 정상 post 즉시 커밋 확인(무한 홀드 없음) + hung unread 단조 증가 + 데몬 생존.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import {
  assertChannelSeq,
  assertUnread,
  type RigChannelMessage,
  type RigUnreadEntry,
} from '../harness/assert';
import { pickSeed } from '../harness/seed';

const HUNG_COUNT = 2;
const ALIVE_COUNT = 2;
/** 정상 페르소나 각자 연사 횟수(hung의 unread가 단조 증가함을 볼 만큼). */
const ALIVE_BURST = 5;

describe('SIM S4 — hung ×2 + 정상 ×2: 채널 무결성·무한 홀드 없음 (넛지 어서션 없음)', () => {
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

  it('hung 2종이 무응답이어도 정상 post는 즉시 커밋되고 hung unread는 정확히 쌓인다', async () => {
    // 고정 루프라 결정적(rng 미사용) — seed는 PersonaRunner rng 시드로만 쓰이고 이
    // 시나리오 본문은 소비하지 않는다. 시드 재현 문구를 두지 않는다(거짓 신호 방지).
    try {
      runner = new PersonaRunner(ctx, { idPrefix: 's4', seed });
      const all = runner.spawn(HUNG_COUNT + ALIVE_COUNT);
      const hung = all.slice(0, HUNG_COUNT);
      const alive = all.slice(HUNG_COUNT);
      const creator = alive[0];
      const others = all.filter((p) => p !== creator);
      // openChannel이 hung도 전원 join시킨다(hung은 join까지는 정상, 이후 무응답).
      const { channelId, nextSeq } = await runner.openChannel('rig-s4-hung', creator, others);
      expect(nextSeq, 'create 직후 nextSeq=1').toBe(1);

      // 정상 2종이 교대로 연사. hung은 아무 것도 하지 않는다(소켓은 열린 채 방치).
      // 각 post의 커밋을 즉시 확인 — hung의 미ack이 채널 뮤텍스를 잠그면 여기서 타임아웃
      // 이 나므로, ok 반환 자체가 "무한 홀드 없음"의 증거다.
      let seq = 0;
      for (let k = 0; k < ALIVE_BURST; k++) {
        for (const p of alive) {
          const res = await p.client.channelRpc('a2a.channel.post', {
            channelId,
            sender: { workspaceId: p.ws, memberId: p.ws },
            text: `s4|alive|${p.ws}|#${k}`,
          });
          seq += 1;
          // 즉시 커밋(블록 없음). post는 fsync 후 ok(envelope PR3) — 반환 = 무한 홀드 없음.
          expect((res['message'] as { seq: number }).seq, `alive post 즉시 커밋 (${p.ws} #${k})`).toBe(
            seq,
          );
        }
        // 매 라운드 데몬 생존 확인(hung 방치가 데몬을 흔들지 않음). daemon.ping 핸들러는
        // `{ status: 'ok', ... }` 반환(`src/daemon/index.ts:1548`) — 핸들러 status를 본다.
        const pong = (await creator.client.rpc('daemon.ping', {})) as { status?: string };
        expect(pong?.status, `라운드 ${k} 데몬 생존`).toBe('ok');
      }
      const totalPosts = seq;

      // 전수 무결성(정상 발신분 전량, seq 연속).
      const fetched = await creator.client.channelRpc('a2a.channel.getMessages', { channelId });
      const messages = (fetched['messages'] ?? []) as RigChannelMessage[];
      assertChannelSeq(messages, totalPosts, 1);

      // hung unread: ack를 한 번도 안 했으므로 정상 발신분 전량이 미열람 = unread.
      // (hung은 자기 발신이 없으니 self-면제 없음 → 전 메시지가 unread.) "무한"이 아니라
      // "정확히 totalPosts"임을 못박는다 — 폭주도 유실도 아님.
      for (const h of hung) {
        const unread = await h.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        const row = entries.find((e) => e.channelId === channelId && e.memberId === h.ws);
        expect(row, `hung unread 엔트리 (ws=${h.ws})`).toBeTruthy();
        assertUnread(entries, channelId, h.ws, { headSeq: totalPosts, unread: totalPosts });
      }

      // 종단 데몬 생존.
      const finalPing = (await creator.client.rpc('daemon.ping', {})) as { status?: string };
      expect(finalPing.status, 'hung 방치 후 데몬 생존').toBe('ok');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S4] FAILED (deterministic fixed-loop scenario — no seed dependency)`);
      // eslint-disable-next-line no-console
      console.error(`[S4] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
