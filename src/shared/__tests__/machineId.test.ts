import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  mintMachineId,
  readMachineId,
  writeMachineId,
  resolveMachineId,
  recoverMachineIdFromRecords,
  machineIdPath,
} from '../machineId';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-machineid-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('machineId', () => {
  it('mintMachineId는 uuid 형태를 생성', () => {
    expect(mintMachineId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('readMachineId: 부재 시 null', () => {
    expect(readMachineId(dir)).toBeNull();
  });

  it('resolveMachineId: 최초엔 민팅·durable 기록, 재호출은 동일값 로드(재민팅 없음)', () => {
    const first = resolveMachineId(dir);
    // 파일에 원시 문자열로 기록됐고 내용이 반환값과 일치.
    expect(fs.readFileSync(machineIdPath(dir), 'utf-8')).toBe(first);
    const second = resolveMachineId(dir);
    expect(second).toBe(first); // 재민팅 금지
  });

  it('resolveMachineId: 파일 부재 + 레코드 복구 훅 → 재민팅 없이 복구값 재기록', () => {
    const recovered = resolveMachineId(dir, {
      recoverFromRecords: () => 'recovered-id',
    });
    expect(recovered).toBe('recovered-id');
    // 세그먼트가 증거 — 복구값을 파일에 재기록.
    expect(readMachineId(dir)).toBe('recovered-id');
  });

  it('recoverMachineIdFromRecords: 첫 유효 origin.machineId 반환', () => {
    expect(
      recoverMachineIdFromRecords([
        { origin: {} },
        { origin: { machineId: 'mA' } },
        { origin: { machineId: 'mB' } },
      ]),
    ).toBe('mA');
    expect(recoverMachineIdFromRecords([])).toBeUndefined();
  });

  it('writeMachineId → readMachineId 왕복', () => {
    writeMachineId(dir, 'fixed-uuid');
    expect(readMachineId(dir)).toBe('fixed-uuid');
  });
});
