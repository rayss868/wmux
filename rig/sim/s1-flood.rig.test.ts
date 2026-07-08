// 검증 리그 — SIM S1: flood ×8 (설계 §4 시나리오 S1)
//
// 핵심 어서션(§4): flood 페르소나 8종이 한 채널에 결정적 시드로 연사한 뒤, getMessages
// 전수 대조로 (전 도달·seq 연속·무중복)을 확인한다. 각 페르소나는 자기 workspaceId +
// PipeClient 1개(G6 정직-main: 페르소나당 신원 1개, 그 값만 스탬프). S1은 PipeClient
// 직접 사용으로 충분하므로 persona.ts 프레임워크 없이 구현한다(설계 §9 판단 위임).
//
// 실행 모델: RigDaemon.spawn(격리 env) → ready=daemon.ping → 채널 생성/join → 연사 →
// 전수 대조 → teardown. 시나리오당 fresh 컨텍스트(§2 — 상태 이월 금지).
//
// 결정성(G7): 시드로 페르소나별 연사 횟수·본문을 만들고, 실패 시 시드를 인쇄해 재현한다
// (WMUX_RIG_SEED=<seed>로 고정 재현 가능).

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PipeClient } from '../harness/pipe';
import {
  assertChannelSeq,
  assertTextsDelivered,
  assertUnread,
  type RigChannelMessage,
  type RigUnreadEntry,
} from '../harness/assert';
import { SeededRng, pickSeed } from '../harness/seed';

/** 페르소나 수(§4 S1: flood ×8). */
const PERSONA_COUNT = 8;
/** 페르소나별 연사 횟수 범위 [min, max). 시드로 결정. */
const MIN_POSTS = 3;
const MAX_POSTS = 10;

describe('SIM S1 — flood ×8: 전 도달·seq 연속·무중복', () => {
  let ctx: RigContext;
  let daemon: RigDaemon;
  const clients: PipeClient[] = [];
  const seed = pickSeed();

  beforeAll(async () => {
    ctx = createRigContext();
    daemon = new RigDaemon(ctx);
    await daemon.start();
  }, 60000);

  afterAll(() => {
    // 순서: 파이프 소켓 닫기 → 데몬 프로세스 kill → 임시 홈 삭제(§2).
    for (const c of clients) c.close();
    daemon?.teardown();
    if (ctx) removeRigHome(ctx);
  });

  it('flood 8종이 연사한 전 메시지가 seq 연속·무중복으로 전수 도달한다', async () => {
    // 실패 시 재현을 위해 시드를 항상 남긴다(G7).
    // eslint-disable-next-line no-console
    console.log(`[S1] seed=${seed} (WMUX_RIG_SEED=${seed} 로 재현)`);

    try {
      const rng = new SeededRng(seed);

      // 페르소나 = workspaceId 1개 + PipeClient 1개(G6). 결정적 이름.
      const personas = Array.from({ length: PERSONA_COUNT }, (_, i) => {
        const ws = `ws-rig-s1-p${i}`;
        const client = new PipeClient(ctx.daemonPipePath, ctx.daemonTokenPath, ws);
        clients.push(client); // afterAll에서 소켓을 닫도록 등록.
        return { ws, client };
      });
      const creator = personas[0];

      // 1. 채널 생성(공개). creator가 첫 멤버로 자동 추가된다(create가 creator를 seat).
      const created = await creator.client.channelRpc('a2a.channel.create', {
        name: 'rig-s1-flood',
        visibility: 'public',
        createdBy: { workspaceId: creator.ws, memberId: creator.ws },
      });
      const channel = created['channel'] as { id: string; nextSeq: number };
      const channelId = channel.id;
      expect(channelId, 'create가 channelId를 반환해야 한다').toBeTruthy();
      // create 직후 nextSeq=1 → 첫 post의 seq는 1(전수 대조 기준선).
      expect(channel.nextSeq, 'create 직후 nextSeq=1').toBe(1);

      // 2. 나머지 페르소나 join(creator는 이미 멤버). 각자 자기 신원만 스탬프(G6).
      for (const p of personas.slice(1)) {
        await p.client.channelRpc('a2a.channel.join', {
          channelId,
          member: { workspaceId: p.ws, memberId: p.ws },
        });
      }

      // 3. 연사. 페르소나별 시드로 횟수를 정하고, 각 post는 결정적 본문을 보낸다.
      //    post의 커밋 계약: RPC ok = fsync 커밋 후(envelope PR3) → ok받은 전 post가
      //    반드시 getMessages에 나타나야 한다. 반환된 seq도 수집해 교차검증한다.
      const sentTexts: string[] = [];
      const okSeqs: number[] = [];
      let globalIdx = 0;
      for (const p of personas) {
        const postCount = rng.int(MIN_POSTS, MAX_POSTS);
        for (let k = 0; k < postCount; k++) {
          const text = `s1|${p.ws}|#${k}|g${globalIdx++}`;
          const res = await p.client.channelRpc('a2a.channel.post', {
            channelId,
            sender: { workspaceId: p.ws, memberId: p.ws },
            text,
          });
          const message = res['message'] as { seq: number } | undefined;
          expect(message, `post가 message를 반환해야 한다 (ws=${p.ws} k=${k})`).toBeTruthy();
          sentTexts.push(text);
          okSeqs.push(message!.seq);
        }
      }
      const totalPosts = sentTexts.length;
      // eslint-disable-next-line no-console
      console.log(`[S1] personas=${PERSONA_COUNT} totalPosts=${totalPosts}`);
      expect(totalPosts, '최소 페르소나당 MIN_POSTS는 나와야 한다').toBeGreaterThanOrEqual(
        PERSONA_COUNT * MIN_POSTS,
      );

      // 4. getMessages 전수 대조(creator 시점, 공개 채널이라 floor=0 전량).
      const fetched = await creator.client.channelRpc('a2a.channel.getMessages', { channelId });
      const messages = (fetched['messages'] ?? []) as RigChannelMessage[];

      // (a) seq 연속·무중복·정확 개수·시작 seq=1.
      assertChannelSeq(messages, totalPosts, 1);
      // (b) 본문 멀티셋 전수 일치(전 도달, 무유실·무변형).
      assertTextsDelivered(messages, sentTexts);
      // (c) post가 반환한 ok seq 집합 == getMessages seq 집합(커밋 영수증과 정본 일치).
      const fetchedSeqs = messages.map((m) => m.seq).slice().sort((x, y) => x - y);
      const committedSeqs = okSeqs.slice().sort((x, y) => x - y);
      expect(fetchedSeqs, 'ok받은 seq 집합이 getMessages seq 집합과 일치해야 한다').toEqual(
        committedSeqs,
      );

      // 5. unread 정합(§4 flood: "유실·중복·seq 무결성"). 정본 산식(`unreadFor`
      //    `src/daemon/channels/ChannelService.ts:2343,:2349`): unread = (seq > cursor
      //    AND seq >= historyFromSeq AND 자기 발신 아님)인 메시지 수. 자기 발신은
      //    제외되고(:2349) 커서 자동전진이 인터리브에 좌우되므로 하드코딩은 브리틀하다.
      //    그래서 **정본 메시지 목록(messages)과 데몬이 보고한 커서로 기대 unread를
      //    독립 계산**해 데몬 보고값과 대조한다 — 메시지가 유실됐다면(seq 검사를 통과할
      //    만큼 교묘해도) 저자별 카운트가 어긋나 이 대조가 잡는다. 공개 채널이라
      //    historyFromSeq=0.
      for (const p of personas) {
        const unread = await p.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        const row = entries.find((e) => e.channelId === channelId && e.memberId === p.ws);
        expect(row, `unread 엔트리가 있어야 한다 (ws=${p.ws})`).toBeTruthy();
        // (i) head 정합.
        assertUnread(entries, channelId, p.ws, { headSeq: totalPosts });
        // (ii) 데몬 보고 커서 기준으로 기대 unread를 정본 목록에서 재계산 → 대조.
        const cursor = row!.lastReadSeq;
        const expectedUnread = messages.filter(
          (m) => m.seq > cursor && m.workspaceId !== p.ws,
        ).length;
        expect(row!.unread, `unread 재계산 대조 (ws=${p.ws}, cursor=${cursor})`).toBe(expectedUnread);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S1] FAILED with seed=${seed} — reproduce with WMUX_RIG_SEED=${seed}`);
      // eslint-disable-next-line no-console
      console.error(`[S1] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
