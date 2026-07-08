// 검증 리그 — SIM S3: dead ×3 + 정상 ×2 (설계 §4 시나리오 S3)
//
// 계약(v1.1 §4): dead 페르소나 3종은 join·post 후 소멸(소켓 close). 정상 2종은 계속
// 활동. 핵심 어서션 = unread·수명주기 수렴 + **채널 기능 잔존**(dead가 소멸해도 채널은
// 계속 정상 동작하고, dead가 남긴 메시지/멤버십은 원장에 잔재한다).
//
// "dead 소멸"의 SIM 모사: 데몬 파이프는 무상태 연결이라(페르소나 = 소켓 1개) dead의
// PipeClient.close()가 곧 그 페르소나의 소멸이다 — 데몬은 멤버십 원장(내구)을 그대로
// 유지하고, dead가 post한 메시지도 seq 원장에 남는다(연결 종료 ≠ leave). 이건 실경로다:
// 에이전트 pane이 죽어도 채널 멤버십·히스토리는 데몬 정본에 남는다.
//
// 실행 모델: 채널 open(5인) → dead 3종이 post 후 close → 정상 2종이 계속 post →
// getMessages 전수 대조(dead 메시지 잔존) + getMembers(dead 멤버십 잔존) + 정상
// 페르소나 unread 정합(dead 발신분도 미열람이면 unread) + 데몬 생존.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import {
  assertChannelSeq,
  assertTextsDelivered,
  assertUnread,
  type RigChannelMessage,
  type RigUnreadEntry,
} from '../harness/assert';
import { pickSeed } from '../harness/seed';

const DEAD_COUNT = 3;
const ALIVE_COUNT = 2;

describe('SIM S3 — dead ×3 + 정상 ×2: unread·수명주기 수렴, 채널 기능 잔존', () => {
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

  it('dead 3종이 소멸해도 채널은 정상 동작하고 dead 원장(메시지·멤버십)은 잔재한다', async () => {
    // eslint-disable-next-line no-console
    console.log(`[S3] seed=${seed} (WMUX_RIG_SEED=${seed} 로 재현)`);
    try {
      runner = new PersonaRunner(ctx, { idPrefix: 's3', seed });
      const all = runner.spawn(DEAD_COUNT + ALIVE_COUNT);
      const dead = all.slice(0, DEAD_COUNT);
      const alive = all.slice(DEAD_COUNT);
      const creator = alive[0]; // 정상 페르소나가 채널을 소유(소멸하지 않음).
      const others = all.filter((p) => p !== creator);
      const { channelId, nextSeq } = await runner.openChannel('rig-s3-dead', creator, others);
      expect(nextSeq, 'create 직후 nextSeq=1').toBe(1);

      const sentTexts: string[] = [];
      let seq = 0;

      // 1. dead 3종이 각자 1발 post한 뒤 소켓을 닫아 소멸한다(순차 — 결정적 seq).
      for (const d of dead) {
        const text = `s3|dead|${d.ws}`;
        const res = await d.client.channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: d.ws, memberId: d.ws },
          text,
        });
        seq += 1;
        expect((res['message'] as { seq: number }).seq, `dead post seq (${d.ws})`).toBe(seq);
        sentTexts.push(text);
        d.client.close(); // 소멸 — 이후 이 페르소나는 어떤 호출도 하지 않는다.
      }

      // 2. 정상 2종이 dead 소멸 후에도 계속 post한다(채널 기능 잔존 실증).
      const alivePostsEach = 3;
      for (const p of alive) {
        for (let k = 0; k < alivePostsEach; k++) {
          const text = `s3|alive|${p.ws}|#${k}`;
          const res = await p.client.channelRpc('a2a.channel.post', {
            channelId,
            sender: { workspaceId: p.ws, memberId: p.ws },
            text,
          });
          seq += 1;
          expect((res['message'] as { seq: number }).seq, `alive post seq (${p.ws} #${k})`).toBe(
            seq,
          );
          sentTexts.push(text);
        }
      }
      const totalPosts = seq;

      // 3. getMessages 전수 대조: dead가 남긴 메시지가 원장에 잔존한다(소멸 ≠ 히스토리 삭제).
      const fetched = await creator.client.channelRpc('a2a.channel.getMessages', { channelId });
      const messages = (fetched['messages'] ?? []) as RigChannelMessage[];
      assertChannelSeq(messages, totalPosts, 1);
      assertTextsDelivered(messages, sentTexts);
      for (const d of dead) {
        expect(
          messages.some((m) => m.workspaceId === d.ws),
          `dead ${d.ws}의 메시지가 원장에 잔존해야 한다`,
        ).toBe(true);
      }

      // 4. getMembers: dead 멤버십이 잔존한다(연결 종료는 leave가 아니다). 전원(dead 포함)이
      //    멤버 목록에 남아야 한다.
      const membersRes = await creator.client.channelRpc('a2a.channel.getMembers', { channelId });
      const members = (membersRes['members'] ?? []) as Array<{ workspaceId: string }>;
      for (const p of all) {
        expect(
          members.some((m) => m.workspaceId === p.ws),
          `${p.ws} 멤버십이 잔존해야 한다 (dead 포함)`,
        ).toBe(true);
      }

      // 5. 정상 페르소나 unread 정합: 아직 아무도 ack 안 했으므로, 각 정상 페르소나는
      //    (자기 발신 제외) 전 메시지를 unread로 센다 — dead 발신분도 포함(수명주기 수렴:
      //    발신자가 죽어도 그 메시지는 수신자 unread에 계정된다). 정본 산식으로 재계산 대조.
      for (const p of alive) {
        const unread = await p.client.channelRpc('a2a.channel.unread', {});
        const entries = (unread['entries'] ?? []) as RigUnreadEntry[];
        const row = entries.find((e) => e.channelId === channelId && e.memberId === p.ws);
        expect(row, `unread 엔트리 (ws=${p.ws})`).toBeTruthy();
        assertUnread(entries, channelId, p.ws, { headSeq: totalPosts });
        const cursor = row!.lastReadSeq;
        const expectedUnread = messages.filter(
          (m) => m.seq > cursor && m.workspaceId !== p.ws,
        ).length;
        expect(row!.unread, `unread 재계산 대조 (ws=${p.ws})`).toBe(expectedUnread);
      }

      // 6. 데몬 생존(dead 소멸이 데몬을 흔들지 않음). daemon.ping 핸들러는
      //    `{ status: 'ok', ... }`를 반환한다(`src/daemon/index.ts:1548`).
      const ping = (await creator.client.rpc('daemon.ping', {})) as { status?: string };
      expect(ping.status, 'dead 소멸 후 데몬 생존').toBe('ok');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S3] FAILED with seed=${seed} — reproduce with WMUX_RIG_SEED=${seed}`);
      // eslint-disable-next-line no-console
      console.error(`[S3] --- daemon log tail ---\n${daemon.log.slice(-2000)}`);
      throw err;
    }
  }, 60000);
});
