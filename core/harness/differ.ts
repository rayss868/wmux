// E0 컨포먼스 하니스 — M2 차등 러너 (스펙: engine-core-decision-2026-07-09.md §5-2)
//
// recording.bin + events.jsonl을 피검체에 feed → 전셀 스냅샷 추출 → 셀 단위 diff → 4분류 대장
// 리포트. 피검체는 Subject 인터페이스로 추상화한다:
//   (a) @xterm/headless      — 현재 유일 구현체(기준선).
//   (b) 우리 코어(E1)         — 나중에 XtermSubject와 같은 형상으로 꽂힌다.
//   (c) 제3 레퍼런스(D2 조건부) — 심판 축.
//
// 기준선 폭 모델은 **Unicode 11로 명시 고정**한다(@xterm/addon-unicode11 로딩 + activeVersion='11').
// 본체 renderer와 동일한 폭 모델을 쓰기 위함(lockfile 핀).

import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type {
  CellSnapshot,
  DiffClassification,
  DiffEntry,
  DiffReport,
  Geometry,
  GridSnapshot,
  IntendedDiff,
  RecordingEvent,
  ThroughputMetrics,
} from './types';

/**
 * 피검체 인터페이스. recording을 events 트레일에 맞춰 재생하고 전 그리드 스냅샷을 낸다.
 * 우리 코어(E1)·제3 레퍼런스가 이 인터페이스로 나중에 꽂힌다(현 구현체는 XtermSubject 하나).
 */
export interface Subject {
  readonly name: string;
  /**
   * recording.bin을 events 트레일에 맞춰 재생하고 최종 그리드 스냅샷 + 처리량 계측을 반환한다.
   */
  replay(recording: Uint8Array, events: readonly RecordingEvent[]): Promise<SubjectResult>;
}

export interface SubjectResult {
  readonly grid: GridSnapshot;
  readonly metrics: ThroughputMetrics;
}

/** init 이벤트에서 초기 geometry를 뽑는다(트레일 선두는 항상 init — recorder 불변식). */
function initialGeometryOf(events: readonly RecordingEvent[]): Geometry {
  const init = events.find((e) => e.type === 'init');
  if (!init || init.type !== 'init') {
    throw new Error('[differ] events에 init 이벤트가 없다(recorder 불변식 위반)');
  }
  return init.geometry;
}

/**
 * @xterm/headless 피검체. Unicode11Addon을 로딩하고 activeVersion='11'로 고정한다.
 * write는 콜백 기반(파서가 비동기 청크 처리)이므로 재생은 콜백을 await하며 순차 feed한다.
 */
export class XtermSubject implements Subject {
  readonly name = 'xterm.js@6';

  async replay(recording: Uint8Array, events: readonly RecordingEvent[]): Promise<SubjectResult> {
    const initial = initialGeometryOf(events);
    // scrollback 0 — 코퍼스는 화면(뷰포트) 상태를 검증하므로 히스토리 없이 뷰포트만 본다.
    // allowProposedApi: Unicode11Addon 등록에 필요.
    const term = new Terminal({
      cols: initial.cols,
      rows: initial.rows,
      scrollback: 0,
      allowProposedApi: true,
    });
    // 기준선 폭 모델 = Unicode 11 명시 고정(본체 renderer 정렬).
    // addon 타입은 @xterm/xterm의 Terminal을 기대하지만 headless Terminal과 구조 호환 →
    // loadAddon은 ITerminalAddon만 요구하므로 런타임 안전(addon은 core만 만진다).
    term.loadAddon(new Unicode11Addon() as never);
    term.unicode.activeVersion = '11';

    // resize/reflow 이벤트를 byteOffset 오름차순으로 정렬(같은 offset은 트레일 순서 보존).
    const ordered = [...events].filter((e) => e.type !== 'init');
    // 안정 정렬: JS Array.sort는 ES2019+ 안정 → 같은 byteOffset의 상대 순서가 보존된다.
    ordered.sort((a, b) => a.byteOffset - b.byteOffset);

    const bytesTotal = recording.length;
    const feedStart = performance.now();

    // 오프셋 기반 재생: [0..offset) 구간을 feed한 뒤 그 offset의 이벤트(resize)를 적용.
    let cursor = 0;
    const writeChunk = (chunk: Uint8Array): Promise<void> =>
      new Promise<void>((resolve) => term.write(chunk, resolve));

    for (const ev of ordered) {
      if (ev.byteOffset > cursor) {
        await writeChunk(recording.subarray(cursor, ev.byteOffset));
        cursor = ev.byteOffset;
      }
      if (ev.type === 'resize') {
        term.resize(ev.geometry.cols, ev.geometry.rows);
      }
      // reflow_mode는 우리 코어의 재생 규율 신호 — xterm.js는 자체 정책이라 무시(대장에 기록됨).
    }
    // 남은 꼬리 feed.
    if (cursor < recording.length) {
      await writeChunk(recording.subarray(cursor));
    }
    const feedMs = performance.now() - feedStart;

    const extractStart = performance.now();
    const grid = extractGrid(term);
    const extractMs = performance.now() - extractStart;

    const metrics: ThroughputMetrics = {
      subject: this.name,
      bytesTotal,
      feedMs,
      feedMBps: feedMs > 0 ? bytesTotal / 1e6 / (feedMs / 1000) : 0,
      extractMs,
      cellCount: grid.cols * grid.rows,
    };

    term.dispose();
    return { grid, metrics };
  }
}

/** headless Terminal의 활성 버퍼 전 셀을 GridSnapshot으로 추출. */
function extractGrid(term: Terminal): GridSnapshot {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  const activeBuffer: 'normal' | 'alternate' = buf.type === 'alternate' ? 'alternate' : 'normal';

  const cells: CellSnapshot[][] = [];
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    const row: CellSnapshot[] = [];
    for (let x = 0; x < cols; x++) {
      // getCell을 재사용 없이 매 셀 새로 받는다(xterm은 재사용 셀 객체를 권장하나, 스냅샷은
      // 값 복사가 필요하므로 즉시 값으로 추출한다).
      const cell = line?.getCell(x);
      if (!cell) {
        row.push(emptyCell());
        continue;
      }
      row.push({
        char: cell.getChars(),
        width: cell.getWidth(),
        code: cell.getCode(),
        fgMode: cell.getFgColorMode(),
        fg: cell.getFgColor(),
        bgMode: cell.getBgColorMode(),
        bg: cell.getBgColor(),
        fgPalette: cell.isFgPalette(),
        fgRGB: cell.isFgRGB(),
        fgDefault: cell.isFgDefault(),
        bgPalette: cell.isBgPalette(),
        bgRGB: cell.isBgRGB(),
        bgDefault: cell.isBgDefault(),
        bold: cell.isBold() !== 0,
        italic: cell.isItalic() !== 0,
        dim: cell.isDim() !== 0,
        underline: cell.isUnderline() !== 0,
        blink: cell.isBlink() !== 0,
        inverse: cell.isInverse() !== 0,
        invisible: cell.isInvisible() !== 0,
        strikethrough: cell.isStrikethrough() !== 0,
        overline: cell.isOverline() !== 0,
      });
    }
    cells.push(row);
  }

  return {
    cols,
    rows,
    activeBuffer,
    cursor: { x: buf.cursorX, y: buf.cursorY },
    cells,
  };
}

function emptyCell(): CellSnapshot {
  return {
    char: '',
    width: 1,
    code: 0,
    fgMode: 0,
    fg: -1,
    bgMode: 0,
    bg: -1,
    fgPalette: false,
    fgRGB: false,
    fgDefault: true,
    bgPalette: false,
    bgRGB: false,
    bgDefault: true,
    bold: false,
    italic: false,
    dim: false,
    underline: false,
    blink: false,
    inverse: false,
    invisible: false,
    strikethrough: false,
    overline: false,
  };
}

/** CellSnapshot의 diff 대상 필드(문자·폭·색·9플래그·code). */
const CELL_FIELDS: readonly (keyof CellSnapshot)[] = [
  'char',
  'width',
  'code',
  'fgMode',
  'fg',
  'bgMode',
  'bg',
  'fgPalette',
  'fgRGB',
  'fgDefault',
  'bgPalette',
  'bgRGB',
  'bgDefault',
  'bold',
  'italic',
  'dim',
  'underline',
  'blink',
  'inverse',
  'invisible',
  'strikethrough',
  'overline',
];

/**
 * 두 그리드 스냅샷을 셀 단위로 비교해 불일치 리포트를 낸다. (d) 의도된 개선은 intended 목록에
 * 등재된 (workload,x,y,field)만 'intended'로 표기하고, 나머지는 모두 'unclassified'로 남긴다
 * (암묵 (d) 금지 — §5-2). (a)/(b)/(c) 자동 판정은 하지 않는다: 그 심판은 사람/제3 레퍼런스의
 * 몫이며, 하니스는 "불일치가 있다"는 사실과 좌표·양측 값만 정직하게 보고한다.
 */
export function diffGrids(
  workloadName: string,
  a: GridSnapshot,
  b: GridSnapshot,
  subjectA: string,
  subjectB: string,
  intended: readonly IntendedDiff[] = [],
): DiffReport {
  const mismatches: DiffEntry[] = [];
  const intendedKey = (x: number, y: number, field: string): boolean =>
    intended.some(
      (i) => i.workloadName === workloadName && i.x === x && i.y === y && i.field === field,
    );
  const classify = (x: number, y: number, field: string): DiffClassification =>
    intendedKey(x, y, field) ? 'intended' : 'unclassified';

  // 그리드 형상 불일치는 셀 비교 전에 별도 기록(형상이 다르면 셀 좌표 대응이 무의미).
  if (a.cols !== b.cols || a.rows !== b.rows) {
    mismatches.push({
      x: -1,
      y: -1,
      field: 'grid-shape',
      a: { cols: a.cols, rows: a.rows },
      b: { cols: b.cols, rows: b.rows },
      classification: classify(-1, -1, 'grid-shape'),
    });
  }

  // 커서 불일치.
  if (a.cursor.x !== b.cursor.x || a.cursor.y !== b.cursor.y) {
    mismatches.push({
      x: a.cursor.x,
      y: a.cursor.y,
      field: 'cursor',
      a: a.cursor,
      b: b.cursor,
      classification: classify(a.cursor.x, a.cursor.y, 'cursor'),
    });
  }

  // 셀 단위 비교 — 공통 교집합 영역만(형상 불일치 시 좌표 대응 붕괴 방지).
  const rows = Math.min(a.rows, b.rows);
  const cols = Math.min(a.cols, b.cols);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ca = a.cells[y]?.[x];
      const cb = b.cells[y]?.[x];
      if (!ca || !cb) continue;
      for (const field of CELL_FIELDS) {
        if (ca[field] !== cb[field]) {
          mismatches.push({
            x,
            y,
            field,
            a: ca[field],
            b: cb[field],
            classification: classify(x, y, field),
          });
        }
      }
    }
  }

  return {
    workloadName,
    subjectA,
    subjectB,
    gridShape: { cols: a.cols, rows: a.rows },
    totalCells: a.cols * a.rows,
    mismatches,
    identical: mismatches.length === 0,
  };
}

/**
 * 두 스냅샷이 완전히 동일한지(결정성 게이트 ①에 쓰인다). intended 목록을 비우면 어떤 불일치도
 * 실패로 본다 — 결정성은 같은 피검체 2회이므로 intended가 있을 수 없다.
 */
export function snapshotsEqual(a: GridSnapshot, b: GridSnapshot): boolean {
  return diffGrids('__determinism__', a, b, 'run1', 'run2').identical;
}
