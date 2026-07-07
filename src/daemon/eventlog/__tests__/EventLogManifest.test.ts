import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  readManifest,
  writeManifest,
  manifestPath,
  isEventLogManifest,
  pingFormatVersionField,
  EVENTLOG_FORMAT_VERSION,
  type EventLogManifest,
} from '../EventLogManifest';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-manifest-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function sample(overrides: Partial<EventLogManifest> = {}): EventLogManifest {
  return {
    formatVersion: EVENTLOG_FORMAT_VERSION,
    machineId: 'm-abc',
    genesisRef: 'genesis-channel.json',
    reseedRefs: [],
    snapshotLamport: 0,
    activeSegment: 1,
    ...overrides,
  };
}

describe('EventLogManifest read/write(durable)', () => {
  it('write → read 왕복(전 필드 보존)', () => {
    const m = sample({ reseedRefs: ['reseed-1.json'], snapshotLamport: 7, activeSegment: 3 });
    writeManifest(dir, m);
    const read = readManifest(dir);
    expect(read).toEqual(m);
  });

  it('부재 시 null', () => {
    expect(readManifest(dir)).toBeNull();
  });

  it('durable 쓰기 파일이 실제로 생성됨', () => {
    writeManifest(dir, sample());
    expect(fs.existsSync(manifestPath(dir))).toBe(true);
  });

  it('primary 손상 → .bak 폴백', () => {
    writeManifest(dir, sample({ machineId: 'm-first' }));
    writeManifest(dir, sample({ machineId: 'm-second' })); // .bak=first, primary=second
    fs.writeFileSync(manifestPath(dir), 'CORRUPT{');
    const read = readManifest(dir);
    expect(read).not.toBeNull();
    expect(read!.machineId).toBe('m-first'); // .bak에서 복구
  });
});

describe('isEventLogManifest 가드', () => {
  it('유효 manifest 통과', () => {
    expect(isEventLogManifest(sample())).toBe(true);
  });

  it('필수 필드 누락 거부', () => {
    expect(isEventLogManifest({ ...sample(), machineId: undefined })).toBe(false);
    expect(isEventLogManifest({ ...sample(), reseedRefs: 'x' })).toBe(false);
    expect(isEventLogManifest({ ...sample(), genesisRef: '' })).toBe(false);
    expect(isEventLogManifest(null)).toBe(false);
    expect(isEventLogManifest([])).toBe(false);
  });

  it('추가 필드는 거부 안 함(additive-only)', () => {
    expect(
      isEventLogManifest({ ...sample(), futureField: 'x', keyId: 'k' }),
    ).toBe(true);
  });
});

// ── §6.4a daemon.ping의 eventLogFormatVersion additive 필드 ─────────────
describe('pingFormatVersionField (§6.4a)', () => {
  it('로그 활성(active=formatVersion) → 필드 노출(값=활성 formatVersion)', () => {
    expect(pingFormatVersionField(EVENTLOG_FORMAT_VERSION)).toEqual({
      eventLogFormatVersion: EVENTLOG_FORMAT_VERSION,
    });
    // 활성 manifest.formatVersion을 그대로 노출 — 미래 세대도 실값 전달(하드코딩 아님).
    expect(pingFormatVersionField(2)).toEqual({ eventLogFormatVersion: 2 });
  });

  it('로그 비활성(undefined — 레거시 폴백/마이그레이션 미완) → 필드 부재', () => {
    const field = pingFormatVersionField(undefined);
    expect(field).toEqual({});
    expect('eventLogFormatVersion' in field).toBe(false);
  });

  it('스프레드 additive 계약: 부재 시 응답 객체에 키가 안 생긴다(부재 = 레거시 세대)', () => {
    const active = { status: 'ok', ...pingFormatVersionField(EVENTLOG_FORMAT_VERSION) };
    const legacy = { status: 'ok', ...pingFormatVersionField(undefined) };
    expect(active.eventLogFormatVersion).toBe(EVENTLOG_FORMAT_VERSION);
    expect('eventLogFormatVersion' in legacy).toBe(false);
  });
});
