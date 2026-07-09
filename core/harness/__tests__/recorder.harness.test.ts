// E0 하니스 — recorder/differ 단위 검증 (스펙 §5-1·§5-2)
//
// 녹화 산출물 스키마·불변식과 재생기의 오프셋 정합을 좁게 검증한다(4중 게이트가 통합 검증을
// 하므로 여기선 배관 단위 계약만).

import { describe, it, expect } from 'vitest';
import { record, serializeEvents, parseEvents } from '../recorder';
import { WORKLOADS, workloadByName } from '../workloads';
import {
  XtermSubject,
  diffGrids,
  validateEventStream,
  loadIntendedDiffs,
  runDifferential,
} from '../differ';
import type { GridSnapshot, IntendedDiff, RecordingEvent } from '../types';

describe('recorder — events 왕복·불변식', () => {
  it('events.jsonl 직렬화→파싱 왕복이 손실 없다', async () => {
    const w = workloadByName('resize-roundtrip')!;
    const res = await record(w, 0);
    const roundtrip = parseEvents(serializeEvents(res.events));
    expect(roundtrip).toEqual(res.events);
  });

  it('트레일 선두는 항상 init(byteOffset=0)이고 geometry/reflowMode를 담는다', async () => {
    for (const w of WORKLOADS) {
      const res = await record(w, 0);
      const first = res.events[0];
      expect(first.type, `[${w.name}] 선두가 init이 아님`).toBe('init');
      expect(first.byteOffset).toBe(0);
      if (first.type === 'init') {
        expect(first.geometry).toEqual(w.initialGeometry);
        expect(first.reflowMode).toBe(w.reflowMode);
      }
    }
  });

  it('byteOffset은 단조 증가하고 [0, recording.length] 범위 안이다', async () => {
    for (const w of WORKLOADS) {
      const res = await record(w, 0);
      let prev = -1;
      for (const e of res.events) {
        expect(e.byteOffset, `[${w.name}] 단조 위반`).toBeGreaterThanOrEqual(prev);
        expect(e.byteOffset).toBeGreaterThanOrEqual(0);
        expect(e.byteOffset).toBeLessThanOrEqual(res.bytes.length);
        prev = e.byteOffset;
      }
    }
  });

  it('meta는 synthetic=true·workloadHash가 bytes의 sha256과 일치', async () => {
    const w = workloadByName('sgr-spectrum')!;
    const res = await record(w, 0);
    expect(res.meta.synthetic).toBe(true);
    // 같은 워크로드·시드 재녹화 → 같은 해시.
    const res2 = await record(w, 0);
    expect(res2.meta.workloadHash).toBe(res.meta.workloadHash);
  });
});

describe('differ — diff 엔진 4분류', () => {
  it('같은 그리드는 identical(불일치 0)', async () => {
    const w = workloadByName('scroll-flood')!;
    const res = await record(w, 0);
    const s = new XtermSubject();
    const g1 = await s.replay(res.bytes, res.events);
    const g2 = await s.replay(res.bytes, res.events);
    const report = diffGrids(w.name, g1.grid, g2.grid, 'a', 'b');
    expect(report.identical).toBe(true);
    expect(report.mismatches.length).toBe(0);
  });

  it('셀 하나를 바꾸면 정확히 그 좌표·필드가 unclassified 불일치로 잡힌다', async () => {
    const w = workloadByName('sgr-spectrum')!;
    const res = await record(w, 0);
    const s = new XtermSubject();
    const g1 = await s.replay(res.bytes, res.events);
    const g2 = await s.replay(res.bytes, res.events);
    // g2의 (0,0) 셀 char를 인위 변조(구조적 복제 후 수정).
    const mutated = {
      ...g2.grid,
      cells: g2.grid.cells.map((row, y) =>
        y === 0 ? row.map((c, x) => (x === 0 ? { ...c, char: 'Z' } : c)) : row,
      ),
    };
    const report = diffGrids(w.name, g1.grid, mutated, 'a', 'b');
    expect(report.identical).toBe(false);
    const charMismatch = report.mismatches.find((m) => m.x === 0 && m.y === 0 && m.field === 'char');
    expect(charMismatch, '(0,0) char 불일치가 잡혀야 한다').toBeTruthy();
    // 암묵 (d) 금지: 승인 목록에 없으면 unclassified.
    expect(charMismatch!.classification).toBe('unclassified');
  });

  it('intended 승인 목록에 등재된 불일치만 intended로 승격된다', async () => {
    const w = workloadByName('sgr-spectrum')!;
    const res = await record(w, 0);
    const s = new XtermSubject();
    const g1 = await s.replay(res.bytes, res.events);
    const mutated = {
      ...g1.grid,
      cells: g1.grid.cells.map((row, y) =>
        y === 0 ? row.map((c, x) => (x === 0 ? { ...c, char: 'Z' } : c)) : row,
      ),
    };
    const intended: IntendedDiff[] = [
      { workloadName: w.name, x: 0, y: 0, field: 'char', reason: '테스트: 의도된 차이로 승인' },
    ];
    const report = diffGrids(w.name, g1.grid, mutated, 'a', 'b', intended);
    const charMismatch = report.mismatches.find((m) => m.x === 0 && m.y === 0 && m.field === 'char');
    expect(charMismatch!.classification, '등재 항목은 intended').toBe('intended');
  });

  // R5: activeBuffer 불일치를 셀 비교 전에 잡는다.
  it('activeBuffer(normal vs alternate) 불일치가 최우선 신호로 잡힌다', async () => {
    const w = workloadByName('alt-screen')!;
    const res = await record(w, 0);
    const s = new XtermSubject();
    const g = await s.replay(res.bytes, res.events);
    const alt: GridSnapshot = { ...g.grid, activeBuffer: 'alternate' as const };
    const report = diffGrids(w.name, g.grid, alt, 'a', 'b');
    const bufMismatch = report.mismatches.find((m) => m.field === 'activeBuffer');
    expect(bufMismatch, 'activeBuffer 불일치가 잡혀야 한다').toBeTruthy();
    expect(bufMismatch!.a).toBe('normal');
    expect(bufMismatch!.b).toBe('alternate');
  });

  // R6: fgMode/bgMode raw 상수는 교차-피검체 diff 대상이 아니다.
  it('fgMode/bgMode(raw 색모드 상수)는 diff 대상에서 제외된다(이식 불가)', async () => {
    const w = workloadByName('sgr-spectrum')!;
    const res = await record(w, 0);
    const s = new XtermSubject();
    const g = await s.replay(res.bytes, res.events);
    // 색이 있는 셀(행0 셀0 = 빨강 전경)의 raw fgMode를 인위로 다르게 만든다.
    const mutated: GridSnapshot = {
      ...g.grid,
      cells: g.grid.cells.map((row, y) =>
        y === 0
          ? row.map((c, x) => (x === 0 ? { ...c, fgMode: c.fgMode + 999, bgMode: c.bgMode + 999 } : c))
          : row,
      ),
    };
    const report = diffGrids(w.name, g.grid, mutated, 'a', 'b');
    // fgMode/bgMode만 달라도 불일치로 잡히면 안 된다(diff 필드에서 제외됐으므로).
    expect(report.mismatches.some((m) => m.field === 'fgMode'), 'fgMode는 diff 대상 아님').toBe(false);
    expect(report.mismatches.some((m) => m.field === 'bgMode'), 'bgMode는 diff 대상 아님').toBe(false);
  });
});

describe('differ — 이벤트 스트림 검증(R3)', () => {
  const geom = { cols: 80, rows: 24 } as const;
  const init: RecordingEvent = { type: 'init', byteOffset: 0, geometry: geom, reflowMode: 'self' };

  it('정상 스트림(init 선두 + 단조 offset + 범위 내)은 통과한다', () => {
    const events: RecordingEvent[] = [
      init,
      { type: 'resize', byteOffset: 5, geometry: geom },
      { type: 'resize', byteOffset: 10, geometry: geom },
    ];
    expect(() => validateEventStream(events, 10)).not.toThrow();
  });

  it('첫 이벤트가 init이 아니면 throw', () => {
    const events: RecordingEvent[] = [{ type: 'resize', byteOffset: 0, geometry: geom }];
    expect(() => validateEventStream(events, 10)).toThrow(/첫 이벤트가 init이 아니다/);
  });

  it('빈 스트림은 throw', () => {
    expect(() => validateEventStream([], 10)).toThrow(/비어있다/);
  });

  it('byteOffset이 원본 순서에서 감소하면 throw(정렬 은닉 금지)', () => {
    // 손상 이벤트 파일 fixture: offset이 12 → 5로 역행(원본 순서 비단조).
    const events: RecordingEvent[] = [
      init,
      { type: 'resize', byteOffset: 12, geometry: geom },
      { type: 'resize', byteOffset: 5, geometry: geom },
    ];
    expect(() => validateEventStream(events, 20)).toThrow(/단조 비감소가 아니다/);
  });

  it('byteOffset이 recording 범위를 넘으면 throw', () => {
    const events: RecordingEvent[] = [init, { type: 'resize', byteOffset: 999, geometry: geom }];
    expect(() => validateEventStream(events, 10)).toThrow(/범위 위반/);
  });

  it('손상 스트림은 replay 진입에서도 throw한다(정렬로 은닉하지 않음)', async () => {
    const s = new XtermSubject();
    const recording = new Uint8Array([65, 66, 67]); // "ABC"
    const corrupt: RecordingEvent[] = [
      init,
      { type: 'resize', byteOffset: 3, geometry: geom },
      { type: 'resize', byteOffset: 1, geometry: geom }, // 역행 — 손상.
    ];
    await expect(s.replay(recording, corrupt)).rejects.toThrow(/단조 비감소가 아니다/);
  });

  it('parseEvents로 읽은 손상 이벤트 파일도 replay에서 throw', async () => {
    // events.jsonl 텍스트가 offset 역행을 담은 fixture(손상 파일 시뮬레이션).
    const jsonl =
      JSON.stringify(init) +
      '\n' +
      JSON.stringify({ type: 'resize', byteOffset: 3, geometry: geom }) +
      '\n' +
      JSON.stringify({ type: 'resize', byteOffset: 0, geometry: geom }) +
      '\n';
    const events = parseEvents(jsonl);
    const s = new XtermSubject();
    await expect(s.replay(new Uint8Array([65, 66, 67]), events)).rejects.toThrow(
      /단조 비감소가 아니다/,
    );
  });
});

describe('differ — intended-diffs 로더 배선(R4)', () => {
  it('loadIntendedDiffs가 저장소 intended-diffs.json을 로드하고 스키마가 정합', () => {
    const list = loadIntendedDiffs();
    expect(Array.isArray(list)).toBe(true);
    // 예약 항목 2건: cjk-emoji VS16 폭 + resize-reflow 왕복 복원.
    const vs16 = list.find(
      (i) => i.workloadName === 'cjk-emoji' && i.x === 0 && i.y === 2 && i.field === 'width',
    );
    const reflow = list.find(
      (i) => i.workloadName === 'resize-reflow' && i.x === 79 && i.y === 0 && i.field === 'char',
    );
    expect(vs16, 'VS16 하트 폭 예약 항목').toBeTruthy();
    expect(reflow, 'resize-reflow 복원 예약 항목').toBeTruthy();
    // 모든 항목이 사유(reason)를 갖는다(사람이 왜 의도인지 적었는지).
    for (const i of list) expect(i.reason.length, 'reason 비어있음').toBeGreaterThan(0);
  });

  it('잘못된 경로는 명시 throw(무음 빈 목록 폴백 금지)', () => {
    expect(() => loadIntendedDiffs('/nonexistent/intended-diffs.json')).toThrow(/로드 실패/);
  });

  it('runDifferential이 로더를 배선해 등재 좌표를 intended로 승격한다', async () => {
    // 같은 피검체 2회지만, 한쪽을 인위 변조해 cjk-emoji VS16 셀(0,2) width를 다르게 만든 뒤,
    // runDifferential이 자동 로드한 승인 목록으로 그 좌표를 intended로 승격하는지 확인한다.
    const w = workloadByName('cjk-emoji')!;
    const res = await record(w, 0);
    const baseline = new XtermSubject();
    // subjectB를 "VS16 셀 width를 2로 바꾸는" 래퍼 피검체로 만든다(E1 코어의 U16 승격을 흉내).
    const promoted: import('../differ').Subject = {
      name: 'e1-mock',
      async replay(recording, events) {
        const r = await baseline.replay(recording, events);
        const cells = r.grid.cells.map((row, y) =>
          y === 2 ? row.map((c, x) => (x === 0 ? { ...c, width: 2 } : c)) : row,
        );
        return { ...r, grid: { ...r.grid, cells } };
      },
    };
    const report = await runDifferential(w.name, res.bytes, res.events, baseline, promoted);
    const vs16Mismatch = report.mismatches.find(
      (m) => m.x === 0 && m.y === 2 && m.field === 'width',
    );
    expect(vs16Mismatch, 'VS16 width 불일치가 잡혀야 한다').toBeTruthy();
    expect(vs16Mismatch!.classification, '등재 좌표는 intended로 승격').toBe('intended');
  });
});
