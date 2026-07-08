// 검증 리그 — SIM S2: ping-pong ×2 (설계 §4 시나리오 S2, v1.1 재정의판)
//
// 계약(v1.1 §4 표 — **유일 정본**): 두 페르소나가 서로를 멘션하며 왕복 부하를 건다.
// 어서션 = **채널 무결성만**(무손실·순서·캡·데몬 자원 바운드). **anti-loop 어서션 금지.**
//
// 왜 anti-loop을 어서트하지 않는가(리뷰 P6 — Claude M/82): 서버측 pair-cap은 미구현
// 보류 결정이고, replyGate는 렌더러 프롬프트 문자열(`src/renderer/hooks/
// channelMentionFlush.ts:131`)이라 SIM 관측면(데몬 파이프)에 **부재**한다. 존재하지 않는
// 계약을 어서트하면 정상 동작을 fail로 찍는다(footgun). 그래서 S2는 "핑퐁 부하 하에서도
// 채널이 무결성을 유지하는가"만 검증한다.
//
// 데몬 자원 바운드(v1.1 §4): RSS/CPU 계측은 SIM에 과하다 — `daemon.ping` 왕복이 왕복
// 부하 전 구간 내내 지속되는지(데몬이 죽거나 무한 홀드에 빠지지 않는지)로 갈음한다.
//
// 실행 모델: RigDaemon.spawn → 채널 open(2인) → 결정적 왕복 라운드(각 라운드에서 서로를
// 멘션) → getMessages 전수 대조(무손실·seq 연속·본문) + unread 멘션 정합 + ping 생존.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import {
  assertChannelSeq,
  assertTextsDelivered,
  type RigChannelMessage,
  type RigUnreadEntry,
} from '../harness/assert';
import { pickSeed } from '../harness/seed';

/** 왕복 라운드 수(각 라운드 = 두 페르소나가 서로 1발씩 = 2 post). */
const ROUNDS = 12;

describe('SIM S2 — ping-pong ×2: 핑퐁 부하 하 채널 무결성 (anti-loop 어서션 없음)', () => {
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

  it('두 페르소나가 서로 멘션 왕복해도 전 메시지가 seq 연속·무손실·무한홀드 없이 도달한다', async () => {
    // 이 시나리오는 **고정 루프라 결정적**이다(rng 미사용) — seed는 PersonaRunner가
    // rng를 만드는 데만 쓰이고 이 시나리오 본문은 소비하지 않는다. 그래서 "WMUX_RIG_SEED
    // 로 재현" 같은 시드 재현 문구를 두지 않는다(거짓 신호 방지 — 리뷰 minor).
    try {
      runner = new PersonaRunner(ctx, { idPrefix: 's2', seed });
      const [a, b] = runner.spawn(2);
      const { channelId, nextSeq } = await runner.openChannel('rig-s2-pingpong', a, [b]);
      expect(nextSeq, 'create 직후 nextSeq=1').toBe(1);

      // 왕복 라운드: 매 라운드 a가 b를 멘션, 이어 b가 a를 멘션. 페르소나 내부는 순차
      // (이전 post 커밋 확인 후 다음), 그래서 결정적 순서. 본문은 (발신자, 라운드)로 유일.
      const sentTexts: string[] = [];
      // 각 페르소나가 상대에게서 받는(=상대 발신) 멘션 수를 세어 unread 멘션 대조에 쓴다.
      for (let r = 0; r < ROUNDS; r++) {
        const aText = `s2|a|r${r} @${b.ws}`;
        const aRes = await a.client.channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: a.ws, memberId: a.ws },
          text: aText,
          mentions: [{ workspaceId: b.ws, name: b.ws }],
        });
        expect((aRes['message'] as { seq: number }).seq, `a post r${r} seq`).toBe(2 * r + 1);
        sentTexts.push(aText);

        const bText = `s2|b|r${r} @${a.ws}`;
        const bRes = await b.client.channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: b.ws, memberId: b.ws },
          text: bText,
          mentions: [{ workspaceId: a.ws, name: a.ws }],
        });
        expect((bRes['message'] as { seq: number }).seq, `b post r${r} seq`).toBe(2 * r + 2);
        sentTexts.push(bText);

        // 데몬 자원 바운드 갈음: 왕복 도중 ping이 계속 살아야 한다(무한 홀드·데몬 사망
        // 없음). ping은 신원 무관 호출이라 rpc()로 직접. daemon.ping 핸들러는
        // `{ status: 'ok', ... }`를 반환한다(`src/daemon/index.ts:1548-1558`) — 트랜스포트
        // 봉투의 ok가 아니라 핸들러 페이로드의 status를 본다(rpc()가 봉투를 벗김).
        const pong = (await a.client.rpc('daemon.ping', {})) as { status?: string } | undefined;
        expect(pong?.status, `핑퐁 라운드 ${r} 도중 daemon.ping 생존`).toBe('ok');
      }

      const totalPosts = 2 * ROUNDS;

      // 무결성 전수 대조(무손실·seq 연속·무중복·본문).
      const fetched = await a.client.channelRpc('a2a.channel.getMessages', { channelId });
      const messages = (fetched['messages'] ?? []) as RigChannelMessage[];
      assertChannelSeq(messages, totalPosts, 1);
      assertTextsDelivered(messages, sentTexts);

      // 멘션 정합: 각 페르소나는 상대가 보낸 ROUNDS개 멘션을 mentionUnread로 센다
      // (자기 발신은 면제 — `unreadFor` self-authored 스킵 :2349). 아직 아무도 ack 안 함.
      for (const [self, peer] of [
        [a, b],
        [b, a],
      ] as const) {
        const unread = await self.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        const row = entries.find((e) => e.channelId === channelId && e.memberId === self.ws);
        expect(row, `unread 엔트리 (ws=${self.ws})`).toBeTruthy();
        // 상대가 나를 멘션한 횟수 = ROUNDS. 무한 루프였다면 이 수가 폭주했을 것.
        expect(row!.mentionUnread, `${self.ws}가 ${peer.ws}에게서 받은 멘션 수 = ROUNDS`).toBe(
          ROUNDS,
        );
        // head 정합(전 post가 커밋됨).
        expect(row!.headSeq, `${self.ws} headSeq = totalPosts`).toBe(totalPosts);
      }

      // 데몬 최종 생존 확인(왕복 부하 후에도 응답 — 자원 바운드 갈음의 종단).
      const finalPing = (await a.client.rpc('daemon.ping', {})) as { status?: string };
      expect(finalPing.status, '핑퐁 부하 종료 후 데몬 생존').toBe('ok');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S2] FAILED (deterministic fixed-loop scenario — no seed dependency)`);
      // eslint-disable-next-line no-console
      console.error(`[S2] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
