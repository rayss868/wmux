import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../AppendOnlyLog';
import { makeEnvelope } from '../../../shared/eventlog';
import type {
  EventEnvelope,
  EventEnvelopeDraft,
} from '../../../shared/eventlog';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-eventlog-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 헬퍼 ──────────────────────────────────────────────────────────────

/** append 입력 초안(순서 필드는 append가 발급). */
function draft(payload: unknown = {}): EventEnvelopeDraft {
  return makeEnvelope({
    domain: 'channel',
    payload,
    origin: { machineId: 'm1', daemonEpoch: 1 },
    authContext: {
      principalId: 'p',
      verifiedWorkspaceId: 'ws',
      trustTier: 'trusted',
    },
  });
}

/** 완결 레코드 1줄(raw 세그먼트 주입용 — 크래시 상태 구성). */
function envLine(lamport: number, seq: number, payload: unknown = {}): string {
  const env: EventEnvelope = {
    eventId: `evt-${lamport}`,
    origin: { machineId: 'm1', daemonEpoch: 1, seq },
    lamport,
    wallClock: 1000 + lamport,
    authContext: {
      principalId: 'p',
      verifiedWorkspaceId: 'ws',
      trustTier: 'trusted',
    },
    domain: 'channel',
    payload,
  };
  return `${JSON.stringify(env)}\n`;
}

function seg(n: number): string {
  return path.join(dir, `${String(n).padStart(8, '0')}.ndjson`);
}

const syncOk = (): void => {};

// ── T-크래시: 전방 스캔·최초 불량 절단·at-least-once 승격 ─────────────────

describe('T-크래시 복구', () => {
  it('커밋 프리픽스 무손실 + valid unsynced tail 승격 + torn 말미 절단', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk });
    log.open();
    await log.append(draft({ n: 1 }));
    await log.append(draft({ n: 2 }));
    log.close();

    // 크래시 모사: 커밋 2건 뒤 (a) valid 줄 1건(승격 후보) + (b) torn 미완결 줄 주입.
    fs.appendFileSync(seg(1), envLine(3, 3, { n: 3 }));
    fs.appendFileSync(seg(1), '{"lamport":4,"origin":{"seq":4'); // 비-\n-종단

    const log2 = new AppendOnlyLog({ dir });
    log2.open();
    // 1,2 커밋 + 3 승격 → 무손실. torn 4 → 폐기.
    expect(log2.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3]);
    // 승격 레코드가 hwm 스캔에 반영(재사용 불가).
    expect(log2.lamportHwm).toBe(3);
    log2.close();
  });

  it('코얼레싱 배치 중간 torn(비순서 writeback) → 불량 이후 valid 줄도 폐기(부분 승격 금지)', () => {
    fs.writeFileSync(
      seg(1),
      envLine(1, 1, { n: 1 }) + 'GARBAGE-not-json\n' + envLine(3, 3, { n: 3 }),
    );
    const log = new AppendOnlyLog({ dir });
    log.open();
    // 최초 불량(중간 garbage)에서 절단 → 그 뒤 valid(lamport 3)도 폐기.
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1]);
    expect(log.lamportHwm).toBe(1);
    // 활성 세그먼트가 물리적으로 절단(불량 이후 바이트 제거).
    expect(fs.readFileSync(seg(1), 'utf8')).toBe(envLine(1, 1, { n: 1 }));
    log.close();
  });

  it('fsync 직전 kill(전량 valid unsynced tail) → 전량 승격(절단 아님), 부분 승격 없음', () => {
    fs.writeFileSync(
      seg(1),
      envLine(1, 1) + envLine(2, 2) + envLine(3, 3),
    );
    const log = new AppendOnlyLog({ dir });
    log.open();
    // 절단 or 승격 둘 중 하나 — 전량 valid이므로 승격.
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3]);
    expect(log.lamportHwm).toBe(3);
    log.close();
  });
});

// ── T-fsync실패: 배치 단일 롤백 ─────────────────────────────────────────

describe('T-fsync실패 주입', () => {
  it('배치 전체 ftruncate(batchStartOffset) 1회 + 전원 false + replay 미출현', async () => {
    let failSync = true;
    const log = new AppendOnlyLog({
      dir,
      fsync: () => {
        if (failSync) throw new Error('inject fsync failure');
      },
    });
    log.open();

    const ftruncSpy = vi.spyOn(fs, 'ftruncateSync');
    const results = await Promise.all([
      log.append(draft({ n: 1 })),
      log.append(draft({ n: 2 })),
      log.append(draft({ n: 3 })),
    ]);

    // 배치 Promise 전원 false.
    expect(results).toEqual([false, false, false]);
    // 단일 ftruncate로 배치 전체 물리 제거(순서의존 null 매장 없음).
    expect(ftruncSpy).toHaveBeenCalledTimes(1);
    expect(ftruncSpy).toHaveBeenCalledWith(expect.any(Number), 0);
    // 디스크에 롤백 이벤트 없음.
    expect(log.readAllRecords()).toEqual([]);

    // 롤백 후 정상 append는 소비된 hwm 뒤(gap)에서 재개, 재사용 없음.
    failSync = false;
    const ok = await log.append(draft({ n: 4 }));
    expect(ok).toBe(true);
    const recs = log.readAllRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].lamport).toBe(4);
    log.close();
    ftruncSpy.mockRestore();

    // 재부트 replay에 롤백 이벤트 미출현.
    const log2 = new AppendOnlyLog({ dir });
    log2.open();
    expect(log2.readAllRecords().map((r) => r.lamport)).toEqual([4]);
    log2.close();
  });
});

// ── T-롤크래시: 빈 신규 세그먼트를 first-boot로 오인 금지 ──────────────────

describe('T-롤 직후 크래시', () => {
  it('빈 신규 세그먼트 → 직전 세그먼트에서 hwm 복원(리셋·재사용 없음)', async () => {
    fs.writeFileSync(seg(1), envLine(1, 1) + envLine(2, 2) + envLine(3, 3));
    fs.writeFileSync(seg(2), ''); // 롤이 만든 빈 신규 세그먼트, 쓰기 전 크래시

    const log = new AppendOnlyLog({ dir });
    log.open();
    expect(log.lamportHwm).toBe(3); // first-boot 오인 시 0이 됐을 값
    expect(log.seqHwm).toBe(3);

    const ok = await log.append(draft({ n: 4 }));
    expect(ok).toBe(true);
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3, 4]);
    // 신규 레코드는 활성(최고번호=2) 세그먼트에 기록.
    expect(fs.readFileSync(seg(2), 'utf8')).toContain('"lamport":4');
    log.close();
  });

  it('torn 부분쓰기 신규 세그먼트 → 절단 후 빔 → 직전 세그먼트 복원', async () => {
    fs.writeFileSync(seg(1), envLine(1, 1) + envLine(2, 2) + envLine(3, 3));
    fs.writeFileSync(seg(2), '{"lamport":4,"orig'); // torn 부분쓰기

    const log = new AppendOnlyLog({ dir });
    log.open();
    expect(log.lamportHwm).toBe(3);
    expect(fs.readFileSync(seg(2), 'utf8')).toBe(''); // torn 절단됨

    const ok = await log.append(draft({ n: 4 }));
    expect(ok).toBe(true);
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3, 4]);
    log.close();
  });

  it('세그먼트 롤: 임계 초과 시 신규 세그먼트, 경계 넘어 순서·연속 보존', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk, maxSegmentBytes: 300 });
    log.open();
    for (let i = 0; i < 8; i++) {
      // eslint-disable-next-line no-await-in-loop
      await log.append(draft({ i }));
    }
    const segs = fs
      .readdirSync(dir)
      .filter((f) => /^\d{8}\.ndjson$/.test(f));
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    log.close();
  });
});

// ── T-lamport: 재개·gap·승격 반영 ──────────────────────────────────────

describe('T-lamport 재개', () => {
  it('재시작 후 첫 신규 = 직전 max+1 (오프바이원 없음)', async () => {
    const log = new AppendOnlyLog({ dir, fsync: syncOk });
    log.open();
    await log.append(draft({ n: 1 }));
    await log.append(draft({ n: 2 }));
    await log.append(draft({ n: 3 }));
    expect(log.lamportHwm).toBe(3);
    expect(log.seqHwm).toBe(3);
    log.close();

    const log2 = new AppendOnlyLog({ dir, fsync: syncOk });
    log2.open();
    expect(log2.lamportHwm).toBe(3); // 디스크 라운드트립 복원
    expect(log2.seqHwm).toBe(3);
    await log2.append(draft({ n: 4 }));
    const recs = log2.readAllRecords();
    expect(recs.map((r) => r.lamport)).toEqual([1, 2, 3, 4]); // 첫 신규 = max+1
    expect(recs[recs.length - 1].origin.seq).toBe(4);
    log2.close();
  });

  it('배치 실패 후 hwm gap 허용·재사용 금지', async () => {
    let failSync = false;
    const log = new AppendOnlyLog({
      dir,
      fsync: () => {
        if (failSync) throw new Error('inject');
      },
    });
    log.open();
    await log.append(draft({ n: 1 }));
    await log.append(draft({ n: 2 }));
    await log.append(draft({ n: 3 })); // 1,2,3 커밋

    failSync = true;
    const failed = await Promise.all([
      log.append(draft({ n: 'a' })),
      log.append(draft({ n: 'b' })),
    ]);
    expect(failed).toEqual([false, false]); // 4,5 소비되나 미커밋(롤백)

    failSync = false;
    await log.append(draft({ n: 6 }));
    // gap(4,5)은 허용하되 재사용 금지 → 다음 성공값은 6.
    expect(log.readAllRecords().map((r) => r.lamport)).toEqual([1, 2, 3, 6]);
    expect(log.lamportHwm).toBe(6);
    log.close();
  });

  it('승격 레코드의 lamport가 hwm 스캔에 반영', () => {
    // 커밋 1,2 + 승격(unsynced valid) 5 → hwm 스캔은 max=5.
    fs.writeFileSync(seg(1), envLine(1, 1) + envLine(2, 2) + envLine(5, 5));
    const log = new AppendOnlyLog({ dir });
    log.open();
    expect(log.lamportHwm).toBe(5);
    expect(log.seqHwm).toBe(5);
    log.close();
  });
});
