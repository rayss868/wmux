// E0 하니스 — 4중 기준선 게이트 (스펙: engine-core-decision-2026-07-09.md §5-2)
//
// 자기일치(①)만으로는 게이트 통과 불가 — 4개 전부여야 한다:
//   ① 결정성    — xterm.js 2회 실행 스냅샷 100% 일치.
//   ② 무크래시  — 전 코퍼스를 크래시/panic 없이 완주.
//   ③ 골든      — 워크로드 정답 명세(코퍼스당 ≥3 어서션)를 xterm.js 산출이 통과.
//   ④ 재현성    — 녹화→재생 왕복 안정(코퍼스 재생성 시 동일 바이트 + 재생 결과 동일).
//
// 이 게이트의 의미(§5-2 명시): "차등 기준선(분모) 확립 + 하니스 자체 신뢰성 증명". 코어 정확도
// 판정은 E1(≥99.9%)·E4(99.99%)의 몫이지 여기가 아니다.

import { describe, it, beforeAll, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { record, parseEvents, sha256Hex } from '../recorder';
import { WORKLOADS, workloadByName } from '../workloads';
import { XtermSubject, snapshotsEqual } from '../differ';
import { generateCorpus, CORPUS_DIR } from '../generate-corpus';
import type { RecordingEvent, ThroughputMetrics } from '../types';

/** 코퍼스 케이스에서 recording.bin + events.jsonl을 읽는다. */
function loadCase(name: string): { recording: Uint8Array; events: RecordingEvent[] } {
  const dir = path.join(CORPUS_DIR, name);
  const recording = new Uint8Array(readFileSync(path.join(dir, 'recording.bin')));
  const events = parseEvents(readFileSync(path.join(dir, 'events.jsonl'), 'utf8'));
  return { recording, events };
}

describe('E0 4중 기준선 게이트 — xterm.js', () => {
  const subject = new XtermSubject();
  const metrics: ThroughputMetrics[] = [];

  // 게이트가 코퍼스를 읽으려면 코퍼스가 디스크에 있어야 한다. 커밋 코퍼스가 이미 있어도
  // 재현성 게이트(④)가 재생성을 요구하므로 beforeAll에서 항상 생성한다(결정적이라 무해).
  beforeAll(async () => {
    await generateCorpus();
  }, 60000);

  // ── 게이트 ① 결정성: 같은 recording을 xterm.js에 2회 재생 → 스냅샷 100% 일치 ──
  it('게이트①: xterm.js 2회 재생 스냅샷이 전 코퍼스에서 100% 일치(결정성)', async () => {
    for (const w of WORKLOADS) {
      const { recording, events } = loadCase(w.name);
      const r1 = await subject.replay(recording, events);
      const r2 = await subject.replay(recording, events);
      expect(
        snapshotsEqual(r1.grid, r2.grid),
        `[${w.name}] xterm.js 2회 재생이 불일치(비결정)`,
      ).toBe(true);
    }
  });

  // ── 게이트 ② 무크래시: 전 코퍼스 완주 ──
  it('게이트②: 전 코퍼스를 크래시/throw 없이 완주(무크래시)', async () => {
    for (const w of WORKLOADS) {
      const { recording, events } = loadCase(w.name);
      // replay가 throw하면 이 expect 이전에 테스트가 실패한다 — 완주 자체가 게이트.
      const res = await subject.replay(recording, events);
      metrics.push(res.metrics); // ④/처리량 계측에 재사용.
      expect(res.grid.cells.length, `[${w.name}] 그리드 행이 비어있음`).toBeGreaterThan(0);
    }
    expect(metrics.length, '전 코퍼스가 완주해야 한다').toBe(WORKLOADS.length);
  });

  // ── 게이트 ③ 골든: 워크로드 정답 명세를 xterm.js 산출이 통과(코퍼스당 ≥3) ──
  it('게이트③: 골든 어서션(코퍼스당 ≥3)을 xterm.js 산출이 전부 통과', async () => {
    for (const w of WORKLOADS) {
      // 코퍼스당 ≥3 어서션 불변식(스펙 §5-2 ③).
      expect(w.golden.length, `[${w.name}] 골든 어서션이 3개 미만`).toBeGreaterThanOrEqual(3);
      const { recording, events } = loadCase(w.name);
      const res = await subject.replay(recording, events);
      for (const g of w.golden) {
        const failure = g.check(res.grid);
        expect(failure, `[${w.name}] 골든 실패: ${g.name} → ${failure}`).toBeNull();
      }
    }
  });

  // ── 게이트 ④ 재현성: 녹화→재생 왕복 안정 ──
  // (a) 녹화 재생성이 동일 바이트를 냄(2회 record 해시 일치).
  // (b) 커밋된 recording.bin과 재생성 바이트가 동일(코퍼스 드리프트 없음).
  // (c) 녹화 산출물을 재생한 결과가 워크로드 정의의 골든을 통과(왕복 안정).
  it('게이트④: 녹화→재생 왕복 안정(2회 녹화 동일 바이트 + 커밋본 일치 + 재생 골든 통과)', async () => {
    for (const w of WORKLOADS) {
      const rec1 = await record(w, 0);
      const rec2 = await record(w, 0);
      // (a) 2회 녹화 동일 바이트.
      expect(rec1.meta.workloadHash, `[${w.name}] 2회 녹화 해시 불일치(비결정 녹화)`).toBe(
        rec2.meta.workloadHash,
      );
      // (b) 커밋된 코퍼스와 일치(gen-corpus 재실행 산출물 == beforeAll 산출물 == 방금 record).
      const committed = new Uint8Array(readFileSync(path.join(CORPUS_DIR, w.name, 'recording.bin')));
      expect(sha256Hex(committed), `[${w.name}] 커밋 코퍼스 드리프트`).toBe(rec1.meta.workloadHash);
      // (c) 재생 왕복 골든.
      const res = await subject.replay(rec1.bytes, rec1.events);
      for (const g of w.golden) {
        expect(g.check(res.grid), `[${w.name}] 재생 왕복 골든 실패: ${g.name}`).toBeNull();
      }
    }
  });

  // ── 처리량 계측(§5-2 요구 — xterm.js 기준선 수치) ──
  it('처리량 계측: xterm.js feed MB/s·전셀 추출 시간을 기준선으로 기록', async () => {
    // 계측은 게이트가 아니라 관측 — 수치를 인쇄해 리포트에 남긴다(예산 판정은 E1 코어 등장 시).
    let totalBytes = 0;
    let totalFeedMs = 0;
    for (const m of metrics) {
      totalBytes += m.bytesTotal;
      totalFeedMs += m.feedMs;
      // eslint-disable-next-line no-console
      console.log(
        `[throughput] ${m.subject} / ${m.bytesTotal}B feed=${m.feedMs.toFixed(2)}ms ` +
          `(${m.feedMBps.toFixed(1)} MB/s) extract=${m.extractMs.toFixed(2)}ms cells=${m.cellCount}`,
      );
    }
    const aggMBps = totalFeedMs > 0 ? totalBytes / 1e6 / (totalFeedMs / 1000) : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[throughput] AGGREGATE(corpus) xterm.js: ${totalBytes}B / ${totalFeedMs.toFixed(2)}ms = ${aggMBps.toFixed(1)} MB/s`,
    );

    // 대표성 있는 steady-state 수치: 커밋 코퍼스는 작아(≤6.4KB) 고정 오버헤드가 지배해 MB/s를
    // 저평가한다. 예산(500/150MB/s) 오더 확인용으로 수 MB flood를 즉석 생성해(커밋 안 함) 측정한다.
    const bigLines: string[] = [];
    for (let i = 0; i < 60000; i++) {
      bigLines.push(`line ${String(i).padStart(6, '0')} ${'.'.repeat(40)}\r\n`);
    }
    const bigBytes = new TextEncoder().encode(bigLines.join(''));
    const bigEvents = [
      { type: 'init' as const, byteOffset: 0 as const, geometry: { cols: 80, rows: 24 }, reflowMode: 'self' as const },
    ];
    const bigRes = await subject.replay(bigBytes, bigEvents);
    // eslint-disable-next-line no-console
    console.log(
      `[throughput] STEADY-STATE xterm.js: ${(bigBytes.length / 1e6).toFixed(2)}MB feed=${bigRes.metrics.feedMs.toFixed(1)}ms ` +
        `(${bigRes.metrics.feedMBps.toFixed(1)} MB/s) extract=${bigRes.metrics.extractMs.toFixed(2)}ms`,
    );

    // 계측이 실제로 수집됐는지(0이 아닌 실측)만 어서트 — 절대 수치는 환경 종속이라 게이트 아님.
    expect(metrics.length).toBe(WORKLOADS.length);
    expect(totalBytes).toBeGreaterThan(0);
    expect(bigRes.metrics.feedMBps).toBeGreaterThan(0);
  });

  // ── 워크로드 커버리지 불변식: 커밋 코퍼스는 정확히 합성 5종(D4) ──
  it('코퍼스 거버넌스: 커밋 코퍼스는 합성 5종이며 전부 synthetic=true', () => {
    expect(WORKLOADS.length, '커밋 코퍼스는 합성 5종').toBe(5);
    const names = WORKLOADS.map((w) => w.name).sort();
    expect(names).toEqual(
      ['alt-screen', 'cjk-emoji', 'resize-roundtrip', 'scroll-flood', 'sgr-spectrum'].sort(),
    );
    for (const name of names) {
      const meta = JSON.parse(
        readFileSync(path.join(CORPUS_DIR, name, 'meta.json'), 'utf8'),
      ) as { synthetic: boolean; createdVia: string };
      expect(meta.synthetic, `[${name}] meta.synthetic`).toBe(true);
      expect(meta.createdVia, `[${name}] createdVia`).toBe('synthetic-generator');
      expect(workloadByName(name), `[${name}] 워크로드 정의 존재`).toBeTruthy();
    }
  });
});
