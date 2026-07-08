// 검증 리그 — G6 가드 고정 테스트 (리뷰 반영: 우회 봉쇄를 테스트로 고정)
//
// PipeClient의 신원 위생(G6)이 하네스 레벨에서 throw로 강제됨을 **데몬 없이** 검증한다
// — 위생 검사는 소켓 연결 전에 실행되므로 존재하지 않는 파이프 경로로 충분하다.
// "정당한 크로스-ws 타깃은 막지 않는다" 네거티브 케이스만 연결 시도까지 진행되며,
// 그 경우 연결 에러(G6 아님)로 거부되는 것을 확인한다(가짜 경로라 ENOENT류).
//
// 고정하는 계약(pipe.ts 헤더의 "주의" 블록):
//   (1) verifiedWorkspaceId는 channelRpc()의 스탬프만 실을 수 있다 — rpc()·중첩 위치
//       밀수는 위치 불문 throw.
//   (2) 예약 신원 값(ws-human/local-ui)은 신원류 키에 실리면 전역 throw.
//   (3) sender.workspaceId는 bound와 불일치하면 throw.
//   (4) 블랭킷 금지는 아니다 — invite 타겟·A2A to 등 정당한 타 ws 참조는 통과한다.

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { PipeClient } from '../harness/pipe';

// 존재하지 않는 파이프/토큰 경로 — 위생 통과 케이스만 여기 닿고, 즉시 연결 에러가 난다.
const FAKE_PIPE = path.join(os.tmpdir(), `wmux-rig-g6-nonexistent-${process.pid}.sock`);
const FAKE_TOKEN = path.join(os.tmpdir(), `wmux-rig-g6-nonexistent-${process.pid}-token`);

describe('G6 가드 — PipeClient 신원 위생 (데몬 불요)', () => {
  const clients: PipeClient[] = [];
  const mk = (ws: string): PipeClient => {
    const c = new PipeClient(FAKE_PIPE, FAKE_TOKEN, ws, { timeoutMs: 2000 });
    clients.push(c);
    return c;
  };
  afterEach(() => {
    while (clients.length) clients.pop()!.close();
  });

  it('생성자: 예약 신원 바인딩 거부 (ws-human / local-ui / 빈 값)', () => {
    expect(() => new PipeClient(FAKE_PIPE, FAKE_TOKEN, 'ws-human')).toThrow(/G6/);
    expect(() => new PipeClient(FAKE_PIPE, FAKE_TOKEN, 'local-ui')).toThrow(/G6/);
    expect(() => new PipeClient(FAKE_PIPE, FAKE_TOKEN, '')).toThrow(/workspaceId/);
  });

  it('rpc(): verifiedWorkspaceId 밀수는 위치 불문 throw', async () => {
    const c = mk('ws-honest');
    // 최상위.
    await expect(
      c.rpc('a2a.channel.post', { verifiedWorkspaceId: 'ws-victim', text: 'x' }),
    ).rejects.toThrow(/G6/);
    // 중첩 객체.
    await expect(
      c.rpc('some.method', { nested: { verifiedWorkspaceId: 'ws-victim' } }),
    ).rejects.toThrow(/G6/);
    // 배열 내부 깊은 중첩.
    await expect(
      c.rpc('some.method', { arr: [{ deep: { verifiedWorkspaceId: 'v' } }] }),
    ).rejects.toThrow(/G6/);
  });

  it('rpc(): 예약 신원 값이 신원류 키에 실리면 throw', async () => {
    const c = mk('ws-honest');
    await expect(c.rpc('some.method', { workspaceId: 'ws-human' })).rejects.toThrow(/G6/);
    await expect(c.rpc('some.method', { member: { memberId: 'local-ui' } })).rejects.toThrow(/G6/);
    await expect(c.rpc('some.method', { targetWorkspaceId: 'ws-human' })).rejects.toThrow(/G6/);
  });

  it('channelRpc(): 타 ws 자칭·중첩 밀수·sender 불일치·예약 sender는 전부 throw', async () => {
    const c = mk('ws-honest');
    // 최상위 타 ws 자칭.
    await expect(
      c.channelRpc('a2a.channel.post', { verifiedWorkspaceId: 'ws-victim' }),
    ).rejects.toThrow(/G6/);
    // 중첩 밀수(최상위는 channelRpc가 스탬프하지만 중첩은 존재 자체가 밀수).
    await expect(
      c.channelRpc('a2a.channel.post', { nested: { verifiedWorkspaceId: 'ws-victim' } }),
    ).rejects.toThrow(/G6/);
    // 호출자 신원 필드 sender.workspaceId 불일치.
    await expect(
      c.channelRpc('a2a.channel.post', { sender: { workspaceId: 'ws-other', memberId: 'm' } }),
    ).rejects.toThrow(/G6/);
    // 예약 신원을 sender로.
    await expect(
      c.channelRpc('a2a.channel.post', { sender: { workspaceId: 'ws-human', memberId: 'm' } }),
    ).rejects.toThrow(/G6/);
  });

  it('정당한 크로스-ws 타깃(초대 타겟·A2A to)은 G6가 막지 않는다 (블랭킷 금지 아님)', async () => {
    const c = mk('ws-honest');
    // invite 타겟은 정당하게 타 ws — 위생을 통과해 연결 시도까지 가서
    // (가짜 파이프라) 연결 에러가 나야 하고, 그 에러는 G6 위반이 아니어야 한다.
    const errInvite = await c
      .channelRpc('a2a.channel.invite', {
        channelId: 'ch-x',
        invitedMember: { workspaceId: 'ws-teammate', memberId: 'mate' },
      })
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(errInvite, 'invite는 (가짜 파이프라) 실패해야 한다').toBeTruthy();
    expect(String(errInvite)).not.toMatch(/G6/);

    // A2A to(수신 ws 지정)도 통과 — 'to'는 신원류 키가 아니다.
    const errTo = await c.rpc('a2a.task.send', { to: 'ws-other', message: 'hi' }).then(
      () => null,
      (e: Error) => e,
    );
    expect(errTo, 'task.send는 (가짜 파이프라) 실패해야 한다').toBeTruthy();
    expect(String(errTo)).not.toMatch(/G6/);
  });

  it('channelRpc(): bound와 동일한 명시 verifiedWorkspaceId는 허용(스탬프와 동치)', async () => {
    const c = mk('ws-honest');
    const err = await c
      .channelRpc('a2a.channel.unread', { verifiedWorkspaceId: 'ws-honest' })
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err, '(가짜 파이프라) 연결 에러는 나야 한다').toBeTruthy();
    expect(String(err)).not.toMatch(/G6/);
  });
});
