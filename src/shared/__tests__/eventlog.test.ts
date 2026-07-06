import { describe, it, expect } from 'vitest';
import { makeEnvelope } from '../eventlog';

describe('makeEnvelope', () => {
  const base = {
    domain: 'channel' as const,
    payload: { text: 'hi' },
    origin: { machineId: 'm1', daemonEpoch: 1 },
    authContext: {
      principalId: 'p',
      verifiedWorkspaceId: 'ws',
      trustTier: 'trusted' as const,
    },
  };

  it('업무 필드만 조립하고 발급 필드(eventId·wallClock·lamport·origin.seq)는 전부 비운다', () => {
    const d = makeEnvelope(base);
    expect(d.origin).toEqual({ machineId: 'm1', daemonEpoch: 1 });
    // 발급 필드 4종은 전부 append 소관 — 초안에 존재하지 않는다
    // (draft 재사용 재시도가 동일 eventId를 두 번 커밋하지 못하게).
    expect('eventId' in d).toBe(false);
    expect('wallClock' in d).toBe(false);
    expect('lamport' in d).toBe(false);
    expect('seq' in d.origin).toBe(false);
    expect(d.domain).toBe('channel');
    expect(d.payload).toEqual({ text: 'hi' });
  });

  it('옵셔널(idempotencyKey·causalRefs)은 주어질 때만 실린다', () => {
    const without = makeEnvelope(base);
    expect('idempotencyKey' in without).toBe(false);
    expect('causalRefs' in without).toBe(false);

    const withOpt = makeEnvelope({
      ...base,
      idempotencyKey: 'k1',
      causalRefs: ['e1', 'e2'],
    });
    expect(withOpt.idempotencyKey).toBe('k1');
    expect(withOpt.causalRefs).toEqual(['e1', 'e2']);
  });

  it('입력 origin 객체를 변형하지 않는다(방어적 복사)', () => {
    const origin = { machineId: 'm1', daemonEpoch: 1 };
    const d = makeEnvelope({ ...base, origin });
    expect(d.origin).not.toBe(origin);
    expect(origin).toEqual({ machineId: 'm1', daemonEpoch: 1 });
  });
});
