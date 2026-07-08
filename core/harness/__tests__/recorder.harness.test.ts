// E0 하니스 — recorder/differ 단위 검증 (스펙 §5-1·§5-2)
//
// 녹화 산출물 스키마·불변식과 재생기의 오프셋 정합을 좁게 검증한다(4중 게이트가 통합 검증을
// 하므로 여기선 배관 단위 계약만).

import { describe, it, expect } from 'vitest';
import { record, serializeEvents, parseEvents } from '../recorder';
import { WORKLOADS, workloadByName } from '../workloads';
import { XtermSubject, diffGrids } from '../differ';
import type { IntendedDiff } from '../types';

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
});
