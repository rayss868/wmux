/**
 * AppendOnlyLog — 세그먼트드 NDJSON append-only writer (envelope-design §2·§3).
 *
 * 계약 요약(스펙 문면):
 *   - append(): Promise<boolean> — resolve(true) = fsync 배리어로 내구화됨(커밋).
 *     resolve(false) = 배치 롤백됨(미커밋). throw하지 않는다(§2.4-5 D16).
 *   - lamport/origin.seq는 append 임계구역 안에서만 발급(pre-increment, §3).
 *     부트 재개값이 max일 때 첫 신규값이 정확히 max+1(오프바이원 없음).
 *   - fsync 코얼레싱(그룹커밋, §2.5): in-flight 배리어 동안 도착분은 다음 배리어로
 *     배치. 성공·실패의 단위가 모두 배치다.
 *   - 배치 단일 롤백(§2.4-4): write/fsync 실패 시 ftruncate(committedOffset) **1회**로
 *     미커밋 전량 물리 제거 + 배치 Promise 전원 false. 순서의존 null 매장 불가.
 *   - 부트 전방 스캔·최초 불량 절단(§2.6): 활성 세그먼트를 앞에서부터 검증, 최초
 *     불량 줄에서 절단. 커밋 프리픽스는 완전·연속 보장. 남은 valid tail은 at-least-once로
 *     승격될 수 있다(계약, 결함 아님 — §2.6 D17).
 *
 * PR1 범위: 순수 라이브러리. manifest·스냅샷·마이그레이션은 PR2 소관 — 미참조.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import type { EventEnvelope, EventEnvelopeDraft } from '../../shared/eventlog';

/** §2.8: 4MB 세그먼트 롤. */
const DEFAULT_MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
const SEGMENT_RE = /^(\d{8})\.ndjson$/;
const NEWLINE = 0x0a; // '\n'

export interface AppendOnlyLogOptions {
  /** events 디렉토리 경로. */
  dir: string;
  /**
   * 배치 배리어 fsync. 기본은 비동기 fs.fsync(코얼레싱 창 확보). 테스트는
   * throw 주입으로 §2.4-4 배치 롤백을 계약 고정한다(의존성 주입).
   */
  fsync?: (fd: number) => void | Promise<void>;
  /** 롤 임계(기본 4MB). 테스트가 작은 값으로 롤을 강제. */
  maxSegmentBytes?: number;
}

interface PendingRecord {
  resolve: (ok: boolean) => void;
}

interface ScanResult {
  /** 최초 불량 직전까지의 유효 바이트 길이(절단 오프셋). */
  validEnd: number;
  maxLamport: number;
  maxSeq: number;
  records: EventEnvelope[];
}

/**
 * prototype-pollution 가드 reviver. atomicWrite core.ts:99-104의 가드를 로그 줄
 * 파싱에 그대로 적용(§2.2). payload가 opaque이므로 신뢰 경계에서 필수.
 */
function stripProtoReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return undefined;
  }
  return value;
}

export class AppendOnlyLog {
  private readonly dir: string;
  private readonly fsyncFd: (fd: number) => void | Promise<void>;
  private readonly maxSegmentBytes: number;

  private fd = -1;
  private activeSegNum = 0;
  private activeSegPath = '';

  // §3: hwm = 마지막 사용값(max). 발급은 pre-increment(hwm+1), write 성공 시 확정.
  private hwmLamport = 0;
  private hwmSeq = 0;

  // §2.4: committedOffset = 마지막 성공 fsync 배리어 오프셋(= 롤백 시 단일 ftruncate 지점).
  private committedOffset = 0;
  private currentOffset = 0;
  private readonly unsynced: PendingRecord[] = [];
  private fsyncInFlight = false;
  // 롤백 세대 카운터: in-flight fsync 도중 롤백이 끼면 그 fsync 완료 콜백이
  // 이미 false 처리된 배리어를 이중 resolve/커밋하지 않도록 가드.
  private rollbackEpoch = 0;
  private opened = false;

  constructor(options: AppendOnlyLogOptions) {
    this.dir = options.dir;
    this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
    this.fsyncFd =
      options.fsync ??
      ((fd) =>
        new Promise<void>((resolve, reject) => {
          fs.fsync(fd, (err) => (err ? reject(err) : resolve()));
        }));
  }

  /** §3: 재개된 lamport hwm(마지막 사용값). 첫 신규 append = 이 값 + 1. */
  get lamportHwm(): number {
    return this.hwmLamport;
  }

  /** §3: 재개된 origin.seq hwm(마지막 사용값). */
  get seqHwm(): number {
    return this.hwmSeq;
  }

  /** 현재 활성 세그먼트 경로(테스트 관측용). */
  get activeSegment(): string {
    return this.activeSegPath;
  }

  /**
   * 부트 복구 (§2.6·§3·§2.8). 세그먼트 스캔 → 활성 세그먼트 전방 검증·절단 →
   * hwm 복원. 롤 직후 크래시(빈 활성 세그먼트)는 first-boot로 오인하지 않고
   * 직전 비어있지-않은 세그먼트에서 hwm을 복원한다.
   */
  open(): void {
    if (this.opened) return;
    fs.mkdirSync(this.dir, { recursive: true });

    const segments = this.listSegments();

    // §3-2: first-boot 판별 = 세그먼트 0개일 때만. 첫 세그먼트 생성, hwm=0.
    if (segments.length === 0) {
      this.activeSegNum = 1;
      this.activeSegPath = this.segPath(1);
      this.fd = this.createSegment(this.activeSegPath);
      this.committedOffset = 0;
      this.currentOffset = 0;
      this.opened = true;
      return;
    }

    // 활성 = 최고번호 세그먼트. §2.6 전방 스캔 + 최초 불량 절단.
    const activeNum = segments[segments.length - 1];
    this.activeSegNum = activeNum;
    this.activeSegPath = this.segPath(activeNum);

    const scan = this.forwardScanFile(this.activeSegPath);
    this.truncateFile(this.activeSegPath, scan.validEnd);

    if (scan.records.length > 0) {
      this.hwmLamport = scan.maxLamport;
      this.hwmSeq = scan.maxSeq;
    } else {
      // §3-3: 활성 세그먼트가 빔(롤 직후 크래시) → 직전 비어있지-않은 세그먼트로
      // 내려가 hwm 복원. lamport 단조라 최신 비어있지-않은 세그먼트가 최고값.
      for (let i = segments.length - 2; i >= 0; i--) {
        const prev = this.forwardScanFile(this.segPath(segments[i]));
        if (prev.records.length > 0) {
          this.hwmLamport = prev.maxLamport;
          this.hwmSeq = prev.maxSeq;
          break;
        }
      }
    }

    // 활성 세그먼트를 append('a') 모드로 개방. 'a'는 매 write가 EOF에 쓰므로
    // ftruncate 후에도 항상 유효 말미에 append된다(오프셋 관리 불필요).
    this.fd = fs.openSync(this.activeSegPath, 'a');
    this.committedOffset = scan.validEnd;
    this.currentOffset = scan.validEnd;
    this.opened = true;
  }

  /**
   * 레코드 1건 append (§2.4). 동기 쓰기 임계구역(await 없음 → Node 단일스레드가
   * 뮤텍스)에서 lamport/seq 발급 + write하고, 커버 fsync 배리어 완료 시 resolve.
   */
  append(draft: EventEnvelopeDraft): Promise<boolean> {
    if (!this.opened) {
      return Promise.reject(
        new Error('AppendOnlyLog.append: open() must be called first'),
      );
    }
    return new Promise<boolean>((resolve) => {
      try {
        this.rollIfNeeded();

        // §3: pre-increment 발급. write 성공 후에만 hwm을 확정해 write-실패로 인한
        // 불필요한 gap을 피한다(재사용 금지 불변식은 어느 경로든 유지).
        const lamport = this.hwmLamport + 1;
        const seq = this.hwmSeq + 1;
        const full: EventEnvelope = {
          ...draft,
          lamport,
          origin: { ...draft.origin, seq },
        };
        const buf = Buffer.from(`${JSON.stringify(full)}\n`, 'utf8');

        this.writeFully(buf); // §2.4-2 short-write 루프

        this.hwmLamport = lamport;
        this.hwmSeq = seq;
        this.currentOffset += buf.length;
        this.unsynced.push({ resolve });
      } catch {
        // §2.4: write 에러(ENOSPC/EIO)도 배치 단일 롤백 경로로.
        this.rollbackBatch();
        resolve(false);
        return;
      }
      this.maybeStartFsync();
    });
  }

  /** 현 디스크 상태(복구 절단 반영)의 커밋 레코드를 순서대로 반환. replay/테스트용. */
  readAllRecords(): EventEnvelope[] {
    const out: EventEnvelope[] = [];
    for (const n of this.listSegments()) {
      const scan = this.forwardScanFile(this.segPath(n));
      for (const rec of scan.records) out.push(rec);
    }
    return out;
  }

  /** fd 닫기. PR1 테스트는 append를 await하므로 unsynced는 통상 비어있다. */
  close(): void {
    if (this.fd >= 0) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* noop */
      }
      this.fd = -1;
    }
    this.opened = false;
  }

  // ── 내부: fsync 코얼레싱 ────────────────────────────────────────────

  private maybeStartFsync(): void {
    if (this.fsyncInFlight || this.unsynced.length === 0) return;
    this.fsyncInFlight = true;
    // 마이크로태스크로 지연해 동기 버스트(같은 tick의 다수 append)를 한 배리어로
    // 코얼레싱한다(§2.5). 이후 tick 도착분은 in-flight 배리어의 다음으로 배치.
    queueMicrotask(() => {
      void this.runFsync();
    });
  }

  private async runFsync(): Promise<void> {
    const epoch = this.rollbackEpoch;
    const barrierCount = this.unsynced.length; // 이 배리어가 커버할 레코드 수
    const barrierEnd = this.currentOffset;

    let ok = true;
    try {
      await this.fsyncFd(this.fd);
    } catch {
      ok = false;
    }

    if (this.rollbackEpoch !== epoch) {
      // 도중 롤백됨 — 이 배리어 레코드는 이미 false 처리됨. 재개만.
      this.fsyncInFlight = false;
      this.maybeStartFsync();
      return;
    }

    if (!ok) {
      this.rollbackBatch(); // §2.4-4 단일 ftruncate + 전원 false
      this.fsyncInFlight = false;
      this.maybeStartFsync();
      return;
    }

    // 성공: 배리어 커버분만 durable로 확정. 그 사이 도착분은 다음 배리어로.
    this.committedOffset = barrierEnd;
    const done = this.unsynced.splice(0, barrierCount);
    for (const rec of done) rec.resolve(true);
    this.fsyncInFlight = false;
    this.maybeStartFsync();
  }

  /**
   * §2.4-4 배치 단일 롤백. ftruncate(committedOffset) **한 번**으로 미커밋 전량
   * (배리어 + 그 뒤 대기분)을 물리 제거하고 전원 false. hwm은 되돌리지 않는다
   * (§3 함정: gap 허용, 재사용 금지).
   */
  private rollbackBatch(): void {
    this.rollbackEpoch++;
    try {
      fs.ftruncateSync(this.fd, this.committedOffset);
    } catch {
      // 절단 실패는 at-least-once로 흡수(§2.6-c) — false 계약은 유지.
    }
    this.currentOffset = this.committedOffset;
    const failed = this.unsynced.splice(0, this.unsynced.length);
    for (const rec of failed) rec.resolve(false);
  }

  // ── 내부: 세그먼트·복구 ─────────────────────────────────────────────

  private rollIfNeeded(): void {
    // §2.8: 롤은 배치 경계(unsynced 비었을 때)에서만 — batchStartOffset이 항상
    // 단일 파일 좌표이도록. 배치가 미결이면 현 세그먼트에 계속 쓰고 다음 배치에서 롤.
    if (this.unsynced.length > 0) return;
    if (this.currentOffset <= this.maxSegmentBytes) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* noop */
    }
    this.activeSegNum += 1;
    this.activeSegPath = this.segPath(this.activeSegNum);
    this.fd = this.createSegment(this.activeSegPath);
    this.committedOffset = 0;
    this.currentOffset = 0;
  }

  private createSegment(segPath: string): number {
    const fd = fs.openSync(segPath, 'a'); // 생성 + append 개방
    this.fsyncDir(); // §2.5: 세그먼트 최초 생성 시 디렉토리 엔트리 내구화
    return fd;
  }

  private writeFully(buf: Buffer): void {
    // §2.4-2: fs.writeSync 단일 호출이 전량 쓰기를 보장하지 않음 → 루프.
    let written = 0;
    while (written < buf.length) {
      written += fs.writeSync(this.fd, buf, written, buf.length - written);
    }
  }

  private fsyncDir(): void {
    if (process.platform === 'win32') return; // §2.3 win32 잔여
    let dirFd = -1;
    try {
      dirFd = fs.openSync(this.dir, 'r');
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

  private listSegments(): number[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const nums: number[] = [];
    for (const name of entries) {
      const m = SEGMENT_RE.exec(name);
      if (m) nums.push(Number(m[1]));
    }
    nums.sort((a, b) => a - b);
    return nums;
  }

  private segPath(n: number): string {
    return path.join(this.dir, `${String(n).padStart(8, '0')}.ndjson`);
  }

  /**
   * §2.6 전방 스캔. 앞에서부터 줄 단위로 파싱하며 검증하고, 최초 불량 줄(파싱
   * 실패 또는 비-\n-종단 말미)에서 멈춘다. validEnd = 그 직전까지의 유효 길이.
   * 최초 불량 이후는 유효 줄이 남아 있어도 전부 버린다(부분 승격 금지).
   */
  private forwardScanFile(filePath: string): ScanResult {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(filePath);
    } catch {
      return { validEnd: 0, maxLamport: 0, maxSeq: 0, records: [] };
    }

    let offset = 0;
    let validEnd = 0;
    let maxLamport = 0;
    let maxSeq = 0;
    const records: EventEnvelope[] = [];

    while (offset < buf.length) {
      const nl = buf.indexOf(NEWLINE, offset);
      if (nl === -1) {
        // 비-\n-종단 말미(미완결 torn) → 최초 불량, 절단.
        break;
      }
      const line = buf.toString('utf8', offset, nl);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line, stripProtoReviver);
      } catch {
        // 파싱 실패(torn 중간 등) → 최초 불량, 이후 전부 폐기.
        break;
      }
      if (parsed === null || typeof parsed !== 'object') {
        break;
      }
      const rec = parsed as EventEnvelope;
      if (typeof rec.lamport === 'number' && rec.lamport > maxLamport) {
        maxLamport = rec.lamport;
      }
      const seq = rec.origin?.seq;
      if (typeof seq === 'number' && seq > maxSeq) {
        maxSeq = seq;
      }
      records.push(rec);
      validEnd = nl + 1;
      offset = nl + 1;
    }

    return { validEnd, maxLamport, maxSeq, records };
  }

  private truncateFile(filePath: string, size: number): void {
    try {
      if (fs.statSync(filePath).size > size) {
        fs.truncateSync(filePath, size);
      }
    } catch {
      // best-effort
    }
  }
}
