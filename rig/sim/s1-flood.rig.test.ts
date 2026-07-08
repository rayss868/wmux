// 검증 리그 — SIM S1: flood ×8 (설계 §4 시나리오 S1)
//
// 핵심 어서션(§4): flood 페르소나 8종이 한 채널에 결정적 시드로 연사한 뒤, getMessages
// 전수 대조로 (전 도달·seq 연속·무중복)을 확인한다. 각 페르소나는 자기 workspaceId +
// PipeClient 1개(G6 정직-main: 페르소나당 신원 1개, 그 값만 스탬프). S1은 PipeClient
// 직접 사용으로 충분하므로 persona.ts 프레임워크 없이 구현한다(설계 §9 판단 위임).
//
// 동시성(리뷰 반영 — 진짜 flood): 페르소나 **간**은 Promise.all로 동시 발사해 같은
// 채널 뮤텍스 위의 커밋 경합을 실제로 밟는다. 페르소나 **내부**는 순차(이전 post 커밋
// 확인 후 다음 발사)라 페르소나별 발신 순서 의미가 보존된다 — 그래서 페르소나별 seq 열
// 단조 증가를 추가로 어서트할 수 있다. 전체 인터리브는 비결정적이지만 어서션은 전부
// 집합 기반+연속성이라 인터리브에 안전하다.
//
// 실행 모델: RigDaemon.spawn(격리 env) → ready=daemon.ping → 채널 생성/join → 동시
// 연사 → 전수 대조 → teardown. 시나리오당 fresh 컨텍스트(§2 — 상태 이월 금지).
//
// 결정성(G7): 시드로 페르소나별 연사 횟수·본문을 **발사 전에** 확정하고(연사 계획),
// 실패 시 시드를 인쇄해 재현한다(WMUX_RIG_SEED=<seed>로 고정 재현 가능).

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
  }, 120000); // 리뷰 반영: CI 저속 러너 여유(informational 레인 — 여유가 플레이크 예방)

  afterAll(async () => {
    // 순서: 파이프 소켓 닫기 → 데몬 트리킬(exit 회수까지 대기) → 임시 홈 삭제(§2).
    for (const c of clients) c.close();
    await daemon?.teardown();
    if (ctx) removeRigHome(ctx);
  });

  it('flood 8종이 동시 연사한 전 메시지가 seq 연속·무중복으로 전수 도달한다', async () => {
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

      // 3. 연사 계획을 시드에서 **발사 전에** 확정(페르소나 순회 순서가 고정이라 결정적).
      //    본문은 (ws, k)로 유일 — 인터리브와 무관하게 전수 대조 가능.
      const plan = personas.map((p) => ({ p, count: rng.int(MIN_POSTS, MAX_POSTS) }));
      const sentTexts = plan.flatMap(({ p, count }) =>
        Array.from({ length: count }, (_, k) => `s1|${p.ws}|#${k}`),
      );
      const totalPosts = sentTexts.length;

      // 4. 동시 연사(리뷰 반영 — 진짜 flood). 페르소나 간 병렬 / 페르소나 내부 순차.
      //    post의 커밋 계약: RPC ok = fsync 커밋 후(envelope PR3) → ok받은 전 post가
      //    반드시 getMessages에 나타나야 한다. 반환된 seq를 페르소나별로 수집해
      //    (i) 전역 집합 대조와 (ii) 페르소나 내부 순서 보존에 쓴다.
      const perPersonaSeqs = await Promise.all(
        plan.map(async ({ p, count }) => {
          const seqs: number[] = [];
          for (let k = 0; k < count; k++) {
            const res = await p.client.channelRpc('a2a.channel.post', {
              channelId,
              sender: { workspaceId: p.ws, memberId: p.ws },
              text: `s1|${p.ws}|#${k}`,
            });
            const message = res['message'] as { seq: number } | undefined;
            expect(message, `post가 message를 반환해야 한다 (ws=${p.ws} k=${k})`).toBeTruthy();
            seqs.push(message!.seq);
          }
          return seqs;
        }),
      );
      const okSeqs = perPersonaSeqs.flat();
      // eslint-disable-next-line no-console
      console.log(`[S1] personas=${PERSONA_COUNT} totalPosts=${totalPosts} (concurrent flood)`);
      expect(totalPosts, '최소 페르소나당 MIN_POSTS는 나와야 한다').toBeGreaterThanOrEqual(
        PERSONA_COUNT * MIN_POSTS,
      );

      // 페르소나 내부 발신 순서 보존: 각 페르소나의 seq 열은 단조 증가여야 한다
      // (내부 순차 발사 — k번째 post의 커밋 확인 후 k+1을 보내므로, 채널 뮤텍스가
      //  어떤 인터리브를 택하든 이 관계는 불변).
      for (let i = 0; i < plan.length; i++) {
        const seqs = perPersonaSeqs[i];
        for (let j = 1; j < seqs.length; j++) {
          expect(
            seqs[j],
            `페르소나 내부 순서 보존 (ws=${plan[i].p.ws}, seqs=[${seqs.join(',')}])`,
          ).toBeGreaterThan(seqs[j - 1]);
        }
      }

      // 5. getMessages 전수 대조(creator 시점, 공개 채널이라 floor=0 전량).
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

      // 6. unread 정합. 정본 산식(`unreadFor` `src/daemon/channels/ChannelService.ts:2343,
      //    :2349`): unread = (seq > cursor AND seq >= historyFromSeq AND 자기 발신 아님)인
      //    메시지 수. 자기 발신 면제(:2349)와 커서 자동전진이 인터리브에 좌우되므로
      //    하드코딩은 브리틀하다 — 정본 메시지 목록과 데몬 보고 커서로 기대 unread를
      //    재계산해 대조한다.
      //
      //    이 대조의 정직한 한계(리뷰 반영): **산식 자기정합 검증**이다 — 자기발신 면제·
      //    커서 산입의 회귀는 잡지만, **유실 검출은 못 한다**. getMessages와 unreadFor는
      //    같은 `state.messages` 배열을 읽으므로(post는 단일 배열 push) 메시지가
      //    유실되면 양쪽이 똑같이 적게 세어 이 대조는 통과한다. 유실 검출은 위 5단계의
      //    클라이언트 원장 대조 (a)~(c)(기대 개수·seq 연속·본문 멀티셋·ok-seq 집합)가
      //    담당한다. 공개 채널이라 historyFromSeq=0.
      for (const p of personas) {
        const unread = await p.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        const row = entries.find((e) => e.channelId === channelId && e.memberId === p.ws);
        expect(row, `unread 엔트리가 있어야 한다 (ws=${p.ws})`).toBeTruthy();
        // (i) head 정합.
        assertUnread(entries, channelId, p.ws, { headSeq: totalPosts });
        // (ii) 데몬 보고 커서 기준으로 기대 unread를 정본 목록에서 재계산 → 대조
        //      (산식 자기정합 — 유실엔 눈멂, 위 주석 참조).
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
