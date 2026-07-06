/**
 * origin.machineId — 민팅·로드·레코드-복구 순수 로직 (envelope-design §8).
 *
 * 생애·소재 계약(§8, 패널 C8):
 *   - machineId는 설치 생애 **영구 불변**. Q4에도 교체하지 않는다(계보 연속성).
 *     페어링 신원은 별도 origin.keyId(additive)로 얹는다.
 *   - 소재는 `events/machine-id`, **로그와 동일 fate**. 로그가 소실되면 이 파일도
 *     함께 소실 → 재민팅 → 새 origin 계보 → `(machineId, seq)` 재사용이 구조적으로
 *     불가능. 로그 밖(예: ~/.wmux/machine-id)에 두면 로그만 소실됐을 때 옛
 *     machineId가 살아남아 소실된 seq들이 재사용된다(전역 유일성 붕괴).
 *   - 부분 소실 복구: machine-id 파일만 없고 세그먼트가 살아 있으면, 아무 레코드의
 *     origin.machineId에서 값을 복구해 재기록한다(재민팅 금지 — 세그먼트가 증거).
 *
 * shared 레이어 파일이라 daemon/util에 의존하지 않는다. machine-id는 JSON이 아닌
 * 원시 UUID 문자열이므로, §2.3 durable 시퀀스(tmp write→tmp fsync→rename→dir fsync)를
 * 자체 구현한다(atomicWrite core.ts의 JSON durable 경로와 동형 계약).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const MACHINE_ID_FILE = 'machine-id';

/** §8: 설치 신원 신규 민팅. */
export function mintMachineId(): string {
  return randomUUID();
}

/** `events/machine-id` 경로. */
export function machineIdPath(eventsDir: string): string {
  return path.join(eventsDir, MACHINE_ID_FILE);
}

/** 파일에서 로드. 부재/공백이면 null. */
export function readMachineId(eventsDir: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(machineIdPath(eventsDir), 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * durable 기록 (§2.3): tmp write → tmp fsync → rename → 부모 dir fsync.
 * win32는 디렉토리 fsync 미지원 — 4단계 스킵(§2.3 win32 잔여).
 */
export function writeMachineId(eventsDir: string, id: string): void {
  fs.mkdirSync(eventsDir, { recursive: true });
  const target = machineIdPath(eventsDir);
  const tmp = `${target}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, id);
    fs.fsyncSync(fd); // rename 전 내용 내구화(§2.3-2)
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  fsyncDir(eventsDir); // rename(디렉토리 엔트리) 내구화(§2.3-4)
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return; // §2.3 win32 잔여
  let dirFd = -1;
  try {
    dirFd = fs.openSync(dir, 'r');
    fs.fsyncSync(dirFd);
  } catch {
    // best-effort — 디렉토리 fsync 미지원 파일시스템은 §2.3 수용 잔여
  } finally {
    if (dirFd >= 0) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* noop */
      }
    }
  }
}

/** 레코드 배열에서 machineId 복구(§8 재민팅 금지 근거). 첫 유효값 반환. */
export function recoverMachineIdFromRecords(
  records: ReadonlyArray<{ origin?: { machineId?: unknown } }>,
): string | undefined {
  for (const rec of records) {
    const mid = rec.origin?.machineId;
    if (typeof mid === 'string' && mid.length > 0) return mid;
  }
  return undefined;
}

export interface ResolveMachineIdOptions {
  /**
   * 파일 부재 시, 살아있는 세그먼트 레코드에서 machineId를 복구하는 훅(§8).
   * 값을 반환하면 재민팅하지 않고 그 값을 재기록한다.
   */
  recoverFromRecords?: () => string | undefined;
}

/**
 * 로드 → (부재 시) 레코드 복구 → (그래도 부재 시) 민팅 순서로 machineId 확정(§8).
 * 어느 경로든 결과를 durable 기록해 다음 부트가 재사용하도록 한다.
 */
export function resolveMachineId(
  eventsDir: string,
  opts: ResolveMachineIdOptions = {},
): string {
  const existing = readMachineId(eventsDir);
  if (existing) return existing;

  const recovered = opts.recoverFromRecords?.();
  if (recovered) {
    // 세그먼트가 증거 — 재민팅 금지, 복구값 재기록(§8 부분 소실 복구).
    writeMachineId(eventsDir, recovered);
    return recovered;
  }

  const minted = mintMachineId();
  writeMachineId(eventsDir, minted);
  return minted;
}
