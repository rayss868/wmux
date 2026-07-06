import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  readManifest,
  writeManifest,
  manifestPath,
  isEventLogManifest,
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
