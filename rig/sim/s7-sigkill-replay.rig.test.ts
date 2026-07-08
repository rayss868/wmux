// 검증 리그 — SIM S7: flood 중 데몬 SIGKILL→재스폰 (설계 §4 시나리오 S7, v1.1 재정의판)
//
// 계약(v1.1 §4 — **단방 부분집합만**): flood 도중 데몬을 SIGKILL하고 같은 suffix로
// respawn한 뒤, {RPC ok로 커밋 확인된 메시지 seq} ⊆ {replay 후 getMessages 결과 seq}.
// 즉 **확인된 커밋의 무손실**만 어서트한다(§6.L envelope 실증).
//
// **미커밋 무부활은 어서트 불가**(리뷰 P4 — Claude c/80, footgun 9): AppendOnlyLog는
// at-least-once valid-tail 승격 계약(`src/daemon/eventlog/AppendOnlyLog.ts:13-15,:254-269`)
// — fsync 배리어 직전 물리 write된 미커밋분이 부트 스캔에서 정당하게 승격될 수 있다.
// 그래서 "replay ⊆ committed"(미커밋 무부활)를 어서트하면 정상 동작을 fail로 찍는다.
// 우리가 못박는 건 오직 committed ⊆ replay(assertReplaySuperset — 단방).
//
// **ack는 커밋 증거에서 제외**(footgun 11 — Codex M12): ack는 flip 없으면 no-op ok가
// 있어(`ChannelService.ts:2185` 부근) "ok=커밋"이 성립하지 않는다. 그래서 S7의 커밋
// 원장은 post의 ok seq만이다. ack 효과 검증은 이 시나리오 밖.
//
// **graceful vs SIGKILL 혼동 금지**(footgun 10): graceful close는 pending 전원 false
// 확정(별도 계약, E2E-3 몫). S7은 SIGKILL이라 tail 승격 가능 — 계약이 다르다.
//
// 실행 모델: 채널 open → 1차 flood(각 post ok seq 수집=확인된 커밋) → **데몬 SIGKILL**
// → respawn(디스크 상태 복원) → getMessages로 replay 결과 수집 → committed ⊆ replay
// 어서트. + respawn 후 채널이 계속 동작하는지(2차 post) 확인.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { createRigContext, removeRigHome, type RigContext } from '../harness/isolation';
import { RigDaemon } from '../harness/daemon';
import { PersonaRunner } from '../harness/persona';
import { assertReplaySuperset, type RigChannelMessage, type RigUnreadEntry } from '../harness/assert';
import { pickSeed } from '../harness/seed';

/** 1차 flood post 수(SIGKILL 전 확실히 커밋되는 원장). */
const FLOOD_POSTS = 20;

describe('SIM S7 — flood 중 SIGKILL→respawn: 확인된 커밋 무손실 (단방 부분집합)', () => {
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

  it('SIGKILL 후 respawn하면 RPC ok로 커밋 확인된 전 메시지가 replay로 살아남는다', async () => {
    // eslint-disable-next-line no-console
    console.log(`[S7] seed=${seed} (WMUX_RIG_SEED=${seed} 로 재현)`);
    try {
      runner = new PersonaRunner(ctx, { idPrefix: 's7', seed });
      const [poster, reader] = runner.spawn(2);
      const { channelId, nextSeq } = await runner.openChannel('rig-s7-replay', poster, [reader]);
      expect(nextSeq, 'create 직후 nextSeq=1').toBe(1);

      // 1. 1차 flood — 각 post의 ok 반환 seq를 수집한다. ok = fsync 커밋 후(envelope PR3)
      //    이므로 이 seq들은 "확실히 커밋된" 원장이다. 순차 발사(커밋 확인 후 다음).
      const committedSeqs: number[] = [];
      for (let k = 0; k < FLOOD_POSTS; k++) {
        const res = await poster.client.channelRpc('a2a.channel.post', {
          channelId,
          sender: { workspaceId: poster.ws, memberId: poster.ws },
          text: `s7|${poster.ws}|#${k}`,
        });
        const seq = (res['message'] as { seq: number }).seq;
        committedSeqs.push(seq);
      }
      expect(committedSeqs.length, '1차 flood 전량 ok').toBe(FLOOD_POSTS);

      // 1b. reader가 전량 ack(멤버 스코프 — 커서 전진). ack는 **커밋 증거로 세지 않는다**
      //     (footgun 11 · Codex M12: ack는 flip 없으면 no-op ok라 "ok=로그 커밋"이 아니다).
      //     대신 respawn 후 **unread 질의**로 커서 생존만 확인한다(살아남았으면 unread 감소).
      await reader.client.channelRpc('a2a.channel.ack', {
        channelId,
        uptoSeq: FLOOD_POSTS,
        memberId: reader.ws,
      });
      // eslint-disable-next-line no-console
      console.log(`[S7] committed ${committedSeqs.length} posts + reader ack, pid=${daemon.pid} → SIGKILL`);

      // 2. 데몬 트리 SIGKILL(카오스 주입) — exit 회수까지 대기. 커밋 배리어와 무관하게
      //    즉발 종료(RigDaemon.kill이 SIGKILL 세만틱 유지).
      const killedPid = daemon.pid;
      await daemon.kill();
      expect(daemon.pid, 'kill 후 pid 없음').toBeUndefined();

      // 3. 같은 suffix로 respawn — 데몬이 임시 홈 안 이벤트 로그에서 상태를 복원한다
      //    (§6.L replay). respawn은 ready(daemon.ping)까지 기다린다.
      await daemon.respawn();
      expect(daemon.pid, 'respawn 후 새 pid 존재').toBeDefined();
      expect(daemon.pid, 'respawn은 새 프로세스').not.toBe(killedPid);

      // 4. replay 결과 수집 — respawn 후 소켓은 새로 열려야 하므로 reader 클라이언트가
      //    지연 재연결한다(PipeClient가 끊긴 소켓을 다음 호출에서 재연결). getMessages로
      //    복원된 원장 전수를 읽는다.
      const fetched = await reader.client.channelRpc('a2a.channel.getMessages', { channelId });
      const replayed = (fetched['messages'] ?? []) as RigChannelMessage[];
      const replayedSeqs = replayed.map((m) => m.seq);
      // eslint-disable-next-line no-console
      console.log(`[S7] replayed ${replayedSeqs.length} messages after respawn`);

      // 5. **단방 부분집합**: 확인된 커밋 seq 전부가 replay 결과에 있어야 한다
      //    (committed ⊆ replayed). 역방향(replay ⊆ committed)은 at-least-once tail
      //    승격 계약상 어서트하지 않는다(footgun 9).
      assertReplaySuperset(committedSeqs, replayedSeqs, 's7-post-seqs');

      // 5b. ack 효과는 **unread로만** 확인(커밋 증거 아님 — footgun 11). 커서가 내구화됐다면
      //     reader의 lastReadSeq가 살아남아 unread=0(전 메시지 읽음)이다. ack가 tail에서
      //     안 살아남는 것도 계약상 정당하므로(no-op ok) 강제는 "cursor≤head 정합"까지 —
      //     여기서는 커서가 실제 살아남았음을 확인한다(내구 ack 경로 실증).
      const readerUnread = await reader.client.channelRpc('a2a.channel.unread', {});
      const readerEntries = (readerUnread['entries'] ?? []) as RigUnreadEntry[];
      const readerRow = readerEntries.find(
        (e) => e.channelId === channelId && e.memberId === reader.ws,
      );
      expect(readerRow, 'respawn 후 reader unread 엔트리 존재(멤버십 복원)').toBeTruthy();
      // 커서가 replay를 관통해 살아남음 → 읽은 지점(lastReadSeq)이 ack한 seq 이상.
      expect(
        readerRow!.lastReadSeq,
        'respawn 후 reader 커서가 내구 생존(ack가 replay를 관통)',
      ).toBeGreaterThanOrEqual(Math.min(FLOOD_POSTS, Math.max(...replayedSeqs)));

      // 6. respawn 후 채널이 계속 동작한다(복원된 nextSeq 위에서 이어 쓰기). 새 post의
      //    seq는 replay된 최대 seq보다 커야 한다(seq 원장 연속성이 재시작을 관통).
      const maxReplayed = replayedSeqs.length > 0 ? Math.max(...replayedSeqs) : 0;
      const after = await poster.client.channelRpc('a2a.channel.post', {
        channelId,
        sender: { workspaceId: poster.ws, memberId: poster.ws },
        text: 's7|post-respawn',
      });
      const afterSeq = (after['message'] as { seq: number }).seq;
      expect(afterSeq, 'respawn 후 post seq는 replay 최대 seq 초과(원장 연속)').toBeGreaterThan(
        maxReplayed,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[S7] FAILED with seed=${seed} — reproduce with WMUX_RIG_SEED=${seed}`);
      // eslint-disable-next-line no-console
      console.error(`[S7] --- daemon log tail ---\n${daemon.log.slice(-3000)}`);
      throw err;
    }
  }, 90000);
});
