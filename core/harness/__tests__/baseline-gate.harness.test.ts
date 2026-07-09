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
//
// ── 게이트④ tautology 제거(R1) ──────────────────────────────────────────────
// 이 테스트는 **저장소 코퍼스 디렉토리(CORPUS_DIR)에 어떤 쓰기도 하지 않는다.** 커밋된 코퍼스
// 파일(recording.bin·events.jsonl·meta.json)을 먼저 메모리로 읽어 보존하고, 재생성은 별도 tmp
// 디렉토리(os.tmpdir 하위)로 내보낸 뒤 커밋본과 바이트/구조를 비교한다. 이렇게 해야 "커밋본
// 드리프트 0" 검사가 방금 덮어쓴 값과의 자기 비교(tautology)로 전락하지 않는다. 저장소 코퍼스의
// 생성은 harness:gen-corpus 스크립트 전용이다(generate-corpus.ts의 기본 출력 경로).

import { describe, it, beforeAll, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { record, parseEvents, serializeEvents, sha256Hex } from '../recorder';
import { WORKLOADS, workloadByName } from '../workloads';
import { XtermSubject, snapshotsEqual } from '../differ';
import { generateCorpus, CORPUS_DIR } from '../generate-corpus';
import type { CellSnapshot, GridSnapshot, RecordingEvent, ThroughputMetrics } from '../types';

/** 커밋된 코퍼스 케이스에서 raw 파일 3종을 읽는다(저장소 읽기 전용 — 쓰기 없음). */
interface CommittedCase {
  readonly recordingBin: Uint8Array;
  readonly eventsJsonlText: string;
  readonly metaJsonText: string;
  readonly events: RecordingEvent[];
}
function readCommittedCase(name: string): CommittedCase {
  const dir = path.join(CORPUS_DIR, name);
  const recordingBin = new Uint8Array(readFileSync(path.join(dir, 'recording.bin')));
  const eventsJsonlText = readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  const metaJsonText = readFileSync(path.join(dir, 'meta.json'), 'utf8');
  return {
    recordingBin,
    eventsJsonlText,
    metaJsonText,
    events: parseEvents(eventsJsonlText),
  };
}

describe('E0 4중 기준선 게이트 — xterm.js', () => {
  const subject = new XtermSubject();
  const metrics: ThroughputMetrics[] = [];

  // 커밋된 코퍼스를 **먼저 메모리로 보존**한다(R1 — 재생성이 이 값을 오염시키지 않도록 선행 스냅샷).
  const committed = new Map<string, CommittedCase>();

  beforeAll(() => {
    for (const w of WORKLOADS) {
      committed.set(w.name, readCommittedCase(w.name));
    }
  });

  // ── 게이트 ① 결정성: 같은 recording을 xterm.js에 2회 재생 → 스냅샷 100% 일치 ──
  it('게이트①: xterm.js 2회 재생 스냅샷이 전 코퍼스에서 100% 일치(결정성)', async () => {
    for (const w of WORKLOADS) {
      const { recordingBin, events } = committed.get(w.name)!;
      const r1 = await subject.replay(recordingBin, events);
      const r2 = await subject.replay(recordingBin, events);
      expect(
        snapshotsEqual(r1.grid, r2.grid),
        `[${w.name}] xterm.js 2회 재생이 불일치(비결정)`,
      ).toBe(true);
    }
  });

  // ── 게이트 ① 보강(R10): 청크 경계 강건성 — 1바이트씩 feed vs 통째 feed가 동일 레이아웃 ──
  // 파서가 청크 경계에서 상태를 올바로 보존하는지 실검증한다(멀티바이트 UTF-8·ESC 시퀀스가 임의
  // 경계에서 잘려도 그리드가 같아야 한다). XtermSubject를 feedChunkBytes=1로 구성해 recording을
  // 1바이트씩 흘리고 통째 재생과 대조한다 — 청크 크기만 다르고 나머지 규율은 동일하다.
  //
  // **실측 관측(2026-07-09) — 정직한 예외 1건**: cjk-emoji의 ZWJ 가족(👨‍👩‍👧)에서, 트레일링 ZWJ
  // (U+200D)가 **다른 write 콜에 걸쳐 도착하면** 앞 셀의 grapheme 문자열(char/code)에 붙지 않는다
  // (통째 feed: char="👨‍"·code=U+200D / 1바이트 feed: char="👨"·code=U+1F468). 정확히 2셀에서
  // char·code만 이렇게 갈리고, **width·커서·색·플래그·버퍼 등 레이아웃은 100% 동일**하다(폭 불일치
  // 0). 이는 xterm.js의 좁은 실동작이며 하니스 버그가 아니다. 그래서 이 게이트는 레이아웃 강건성을
  // 강제하되, char/code 차이가 **순수 트레일링 U+200D 부착 여부**뿐인 셀만 관용한다(그 외 어떤
  // char/code/width/레이아웃 발산도 실패). 이렇게 해야 게이트가 고무도장이 아니라 실제 강건성 증명이
  // 된다.
  const subjectByByte = new XtermSubject({ feedChunkBytes: 1 });
  it('게이트①-b: 1바이트씩 feed vs 통째 feed가 동일 레이아웃(청크 경계 강건성)', async () => {
    for (const w of WORKLOADS) {
      const { recordingBin, events } = committed.get(w.name)!;
      const whole = await subject.replay(recordingBin, events);
      const chunked = await subjectByByte.replay(recordingBin, events);
      const diff = chunkBoundaryDiff(whole.grid, chunked.grid);
      expect(
        diff,
        `[${w.name}] 청크 경계 강건성 위반(순수 ZWJ 부착 외 발산): ${diff ?? ''}`,
      ).toBeNull();
    }
  });

  // ── 게이트 ② 무크래시: 전 코퍼스 완주 ──
  it('게이트②: 전 코퍼스를 크래시/throw 없이 완주(무크래시)', async () => {
    for (const w of WORKLOADS) {
      const { recordingBin, events } = committed.get(w.name)!;
      // replay가 throw하면 이 expect 이전에 테스트가 실패한다 — 완주 자체가 게이트.
      const res = await subject.replay(recordingBin, events);
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
      const { recordingBin, events } = committed.get(w.name)!;
      const res = await subject.replay(recordingBin, events);
      for (const g of w.golden) {
        const failure = g.check(res.grid);
        expect(failure, `[${w.name}] 골든 실패: ${g.name} → ${failure}`).toBeNull();
      }
    }
  });

  // ── 게이트 ④ 재현성: 녹화→재생 왕복 안정 (tautology 제거 — R1) ──
  // (a) 녹화 재생성이 동일 바이트를 냄(2회 record 해시 일치).
  // (b) **커밋된 코퍼스 3종 파일 == 별도 tmp로 재생성한 산출물**(저장소에 쓰지 않고 비교).
  //     recording.bin은 바이트, events.jsonl·meta.json은 구조(파싱 후 deep-equal)로 대조한다.
  // (c) 커밋된 녹화 산출물을 재생한 결과가 워크로드 정의의 골든을 통과(왕복 안정).
  it('게이트④: 녹화→재생 왕복 안정(2회 녹화 동일 바이트 + 별도 tmp 재생성==커밋본 + 재생 골든 통과)', async () => {
    // 재생성은 **별도 tmp 디렉토리**로만 — 저장소 CORPUS_DIR은 절대 건드리지 않는다.
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'wmux-harness-gate4-'));
    try {
      // 전 워크로드를 tmp로 재생성(harness:gen-corpus와 동일 경로지만 출력 대상만 tmp).
      const genDirs = await generateCorpus(tmpDir);
      expect(genDirs.length, '재생성이 전 워크로드를 산출').toBe(WORKLOADS.length);

      for (const w of WORKLOADS) {
        const c = committed.get(w.name)!;
        // (a) 2회 녹화 동일 바이트(비결정 녹화 검출).
        const rec1 = await record(w, 0);
        const rec2 = await record(w, 0);
        expect(rec1.meta.workloadHash, `[${w.name}] 2회 녹화 해시 불일치(비결정 녹화)`).toBe(
          rec2.meta.workloadHash,
        );

        // (b) 커밋본 vs tmp 재생성 — recording.bin 바이트 동일.
        const tmpCaseDir = path.join(tmpDir, w.name);
        const tmpBin = new Uint8Array(readFileSync(path.join(tmpCaseDir, 'recording.bin')));
        expect(
          sha256Hex(c.recordingBin),
          `[${w.name}] 커밋 코퍼스 recording.bin 드리프트(tmp 재생성과 바이트 불일치)`,
        ).toBe(sha256Hex(tmpBin));
        // 재생성 산출물이 방금 record()한 결정적 바이트와도 일치(교차 확인).
        expect(sha256Hex(tmpBin), `[${w.name}] tmp 재생성 != record() 산출`).toBe(
          rec1.meta.workloadHash,
        );

        // (b') events.jsonl — 구조 비교(파싱 후 deep-equal). 직렬화 공백 차이에 강건.
        const tmpEventsText = readFileSync(path.join(tmpCaseDir, 'events.jsonl'), 'utf8');
        expect(
          parseEvents(tmpEventsText),
          `[${w.name}] 커밋 events.jsonl 구조 드리프트`,
        ).toEqual(c.events);
        // 커밋된 events.jsonl은 재직렬화 왕복이 안정(파서 계약).
        expect(serializeEvents(c.events), `[${w.name}] events.jsonl 재직렬화 왕복 불안정`).toBe(
          tmpEventsText,
        );

        // (b'') meta.json — 구조 비교(파싱 후 deep-equal). 커밋본과 재생성본이 같은 메타를 담는지.
        const tmpMetaText = readFileSync(path.join(tmpCaseDir, 'meta.json'), 'utf8');
        expect(
          JSON.parse(c.metaJsonText),
          `[${w.name}] 커밋 meta.json 구조 드리프트`,
        ).toEqual(JSON.parse(tmpMetaText));

        // (c) 커밋된 산출물을 재생한 결과가 골든을 통과(왕복 안정).
        const res = await subject.replay(c.recordingBin, c.events);
        for (const g of w.golden) {
          expect(g.check(res.grid), `[${w.name}] 재생 왕복 골든 실패: ${g.name}`).toBeNull();
        }
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
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

  // ── 워크로드 커버리지 불변식: 커밋 코퍼스는 정확히 합성 6종(D4) ──
  it('코퍼스 거버넌스: 커밋 코퍼스는 합성 6종이며 전부 synthetic=true', () => {
    expect(WORKLOADS.length, '커밋 코퍼스는 합성 6종').toBe(6);
    const names = WORKLOADS.map((w) => w.name).sort();
    expect(names).toEqual(
      ['alt-screen', 'cjk-emoji', 'resize-reflow', 'resize-roundtrip', 'scroll-flood', 'sgr-spectrum'].sort(),
    );
    for (const name of names) {
      const meta = JSON.parse(committed.get(name)!.metaJsonText) as {
        synthetic: boolean;
        createdVia: string;
      };
      expect(meta.synthetic, `[${name}] meta.synthetic`).toBe(true);
      expect(meta.createdVia, `[${name}] createdVia`).toBe('synthetic-generator');
      expect(workloadByName(name), `[${name}] 워크로드 정의 존재`).toBeTruthy();
    }
  });
});

const ZWJ = '‍'; // Zero-Width Joiner.

/** char 문자열의 트레일링 ZWJ(U+200D)를 벗겨 비교용으로 정규화한다. */
function stripTrailingZwj(s: string): string {
  return s.endsWith(ZWJ) ? s.slice(0, -1) : s;
}

/**
 * 청크 경계 강건성 비교(R10). 두 그리드를 비교해 발산 사유(문자열)를 반환하고, 강건하면 null.
 * 레이아웃(형상·커서·버퍼·폭·색·플래그)은 완전 일치를 요구한다. char/code 차이는 **순수 트레일링
 * U+200D 부착 여부**뿐일 때만 관용한다(측정된 xterm.js ZWJ 실동작 — 위 게이트①-b 주석 근거).
 */
function chunkBoundaryDiff(a: GridSnapshot, b: GridSnapshot): string | null {
  if (a.cols !== b.cols || a.rows !== b.rows) {
    return `grid-shape ${a.cols}×${a.rows} vs ${b.cols}×${b.rows}`;
  }
  if (a.activeBuffer !== b.activeBuffer) return `activeBuffer ${a.activeBuffer} vs ${b.activeBuffer}`;
  if (a.cursor.x !== b.cursor.x || a.cursor.y !== b.cursor.y) {
    return `cursor (${a.cursor.x},${a.cursor.y}) vs (${b.cursor.x},${b.cursor.y})`;
  }
  // 레이아웃 필드(char/code 제외 전부). 이 목록에 하나라도 어긋나면 강건성 위반.
  const layoutFields: (keyof CellSnapshot)[] = [
    'width', 'fg', 'bg', 'fgPalette', 'fgRGB', 'fgDefault', 'bgPalette', 'bgRGB', 'bgDefault',
    'bold', 'italic', 'dim', 'underline', 'blink', 'inverse', 'invisible', 'strikethrough', 'overline',
  ];
  for (let y = 0; y < a.rows; y++) {
    for (let x = 0; x < a.cols; x++) {
      const ca = a.cells[y]?.[x];
      const cb = b.cells[y]?.[x];
      if (!ca || !cb) continue;
      for (const f of layoutFields) {
        if (ca[f] !== cb[f]) return `(${x},${y}) 레이아웃 ${f}: ${String(ca[f])} vs ${String(cb[f])}`;
      }
      // char/code: 순수 트레일링 ZWJ 차이만 관용, 그 외 발산은 위반.
      if (ca.char !== cb.char && stripTrailingZwj(ca.char) !== stripTrailingZwj(cb.char)) {
        return `(${x},${y}) char "${ca.char}" vs "${cb.char}"(순수 ZWJ 부착 아님)`;
      }
      if (ca.code !== cb.code) {
        // code 차이가 ZWJ 부착에서만 왔는지 확인: char의 트레일링 ZWJ만 다르면 code 차이도 그 결과.
        const onlyZwj =
          stripTrailingZwj(ca.char) === stripTrailingZwj(cb.char) &&
          (ca.char.endsWith(ZWJ) || cb.char.endsWith(ZWJ));
        if (!onlyZwj) return `(${x},${y}) code ${ca.code} vs ${cb.code}(순수 ZWJ 부착 아님)`;
      }
    }
  }
  return null;
}
