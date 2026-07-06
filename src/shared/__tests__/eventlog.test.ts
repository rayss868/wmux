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

  it('발급 필드(eventId·wallClock)를 채우고 순서 필드(lamport·seq)는 비운다', () => {
    const d = makeEnvelope(base);
    expect(typeof d.eventId).toBe('string');
    expect(d.eventId.length).toBeGreaterThan(0);
    expect(typeof d.wallClock).toBe('number');
    expect(d.origin).toEqual({ machineId: 'm1', daemonEpoch: 1 });
    // 순서 필드는 append 소관 — 초안에 존재하지 않는다.
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

  it('eventId는 호출마다 유일', () => {
    expect(makeEnvelope(base).eventId).not.toBe(makeEnvelope(base).eventId);
  });
});
