// E0 컨포먼스 하니스 — 공유 타입 (스펙: engine-core-decision-2026-07-09.md §5-1·§5-2)
//
// 녹화기(M1)와 차등 러너(M2)가 공유하는 자료구조를 한곳에 모은다. 녹화 산출물(events.jsonl)
// 스키마와 그리드 스냅샷·diff 리포트 스키마가 여기 정본이다. 제품 코드(src/)는 전혀 건드리지
// 않으며, 하니스 내부에서만 쓰인다.

/**
 * PTY geometry(열·행). 녹화 시작 시점의 초기 geometry와 이후 resize 이벤트가 이 타입을 쓴다.
 */
export interface Geometry {
  readonly cols: number;
  readonly rows: number;
}

/**
 * reflow 모드. §6-3 전이표의 골격 — win32·conpty는 HostReflow(코어 reflow 미실행),
 * 그 외는 SelfReflow. 녹화 트레일에 기록해 재생 측이 어떤 reflow 규율로 재생할지 명시한다.
 * 합성 코퍼스는 macOS(openpty) 환경이므로 기본 'self'.
 */
export type ReflowMode = 'self' | 'host';

/**
 * 녹화 트레일(events.jsonl)의 한 줄. 초기 geometry·resize·reflow_mode 전이를 **단조 증가하는
 * 바이트 오프셋**과 함께 기록한다. 재생 측(differ)은 recording.bin을 바이트 단위로 흘려보내다가
 * 각 이벤트의 byteOffset 시점에 해당 이벤트(resize 등)를 적용한다.
 *
 * byteOffset의 의미: "recording.bin의 앞에서부터 이만큼의 바이트를 피검체에 feed한 직후" 이
 * 이벤트를 적용한다. 즉 offset은 [0, recording.bin.length] 범위의 절대 위치다.
 */
export type RecordingEvent =
  | {
      readonly type: 'init';
      readonly byteOffset: 0; // init은 항상 스트림 선두(0바이트 feed 후 = 아무것도 feed 안 함).
      readonly geometry: Geometry;
      readonly reflowMode: ReflowMode;
    }
  | {
      readonly type: 'resize';
      readonly byteOffset: number;
      readonly geometry: Geometry;
    }
  | {
      readonly type: 'reflow_mode';
      readonly byteOffset: number;
      readonly reflowMode: ReflowMode;
    };

/**
 * meta.json 스키마. 재현성·거버넌스를 위한 메타데이터.
 * - seed: 워크로드가 결정적 PRNG를 쓸 경우의 시드(합성 워크로드는 시드 고정 → 동일 바이트).
 * - workloadHash: 워크로드가 산출한 recording.bin의 sha256(동일 스크립트 2회 녹화 = 동일 해시 검증용).
 * - workloadName: 코퍼스 케이스 이름.
 * - synthetic: 합성 제너레이터 유래 여부(커밋 코퍼스는 항상 true — D4 거버넌스).
 * - createdVia: 산출 경로('synthetic-generator' | 'cli-recording').
 */
export interface RecordingMeta {
  readonly workloadName: string;
  readonly seed: number;
  readonly workloadHash: string;
  readonly synthetic: boolean;
  readonly createdVia: 'synthetic-generator' | 'cli-recording';
  readonly initialGeometry: Geometry;
}

/**
 * 한 셀의 전 속성 스냅샷. @xterm/headless IBufferCell에서 추출한 값이며, 우리 코어(E1)·제3
 * 레퍼런스도 같은 형상으로 산출해 셀 단위 diff가 가능하도록 한다.
 *
 * 색 모드: raw fgMode/bgMode는 xterm.js 내부 상수(default=0, palette-16≠palette-256≠RGB — quick
 * compare + 16 vs 256 구분용). **이식 가능한 모드 판정은 boolean 3종**(palette/rgb/default)이며,
 * 우리 코어(E1)도 이 boolean 형상으로 산출한다(IBufferCell.isFgPalette/isFgRGB/isFgDefault 대응).
 * 스타일 플래그 9종: bold/italic/dim/underline/blink/inverse/invisible/strikethrough/overline.
 */
export interface CellSnapshot {
  readonly char: string; // getChars() — 빈 문자열이면 공백/후속 wide 셀.
  readonly width: number; // getWidth() — 1(보통)·2(wide)·0(wide 다음 spacer).
  readonly code: number; // getCode() — UTF32 codepoint(결합 문자는 마지막 문자).
  readonly fgMode: number; // getFgColorMode() raw 상수(16 vs 256 구분에만 의미).
  readonly fg: number; // getFgColor() — palette 인덱스 / 0xRRGGBB / default -1.
  readonly bgMode: number;
  readonly bg: number;
  readonly fgPalette: boolean; // isFgPalette() — 16색·256색 팔레트.
  readonly fgRGB: boolean; // isFgRGB() — truecolor.
  readonly fgDefault: boolean; // isFgDefault().
  readonly bgPalette: boolean;
  readonly bgRGB: boolean;
  readonly bgDefault: boolean;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly dim: boolean;
  readonly underline: boolean;
  readonly blink: boolean;
  readonly inverse: boolean;
  readonly invisible: boolean;
  readonly strikethrough: boolean;
  readonly overline: boolean;
}

/** 커서 위치. 버퍼 좌표(0-based). */
export interface CursorSnapshot {
  readonly x: number;
  readonly y: number;
}

/**
 * 전 그리드 스냅샷. 활성 버퍼(normal|alt)의 전 셀을 행×열로 담고 커서 위치를 곁들인다.
 * rows[y][x] = 해당 셀 스냅샷. 피검체 간 diff의 단위.
 */
export interface GridSnapshot {
  readonly cols: number;
  readonly rows: number;
  readonly activeBuffer: 'normal' | 'alternate';
  readonly cursor: CursorSnapshot;
  readonly cells: CellSnapshot[][]; // [y][x]
}

/**
 * 불일치 1건. 두 피검체(예: xterm.js vs 우리 코어)의 같은 좌표 같은 필드가 어긋난 지점.
 * classification은 4분류 대장(§5-2)을 그대로 반영한다.
 */
export interface DiffEntry {
  readonly x: number;
  readonly y: number;
  readonly field: keyof CellSnapshot | 'cursor' | 'grid-shape';
  readonly a: unknown; // subject A의 값.
  readonly b: unknown; // subject B의 값.
  readonly classification: DiffClassification;
}

/**
 * 4분류 대장(§5-2). (d)의도된 개선은 암묵 분류 금지 — 명시 승인 목록(intended-diffs.json)에
 * 등재된 것만 'intended'로 표기된다. 미등재 불일치는 'unclassified'로 남아 사람이 판정해야 한다.
 */
export type DiffClassification =
  | 'our-bug' // (a) 우리 코어 버그.
  | 'xterm-bug' // (b) xterm.js 버그(내재화 마케팅 재료).
  | 'spec-ambiguous' // (c) 스펙 모호 — 제3 레퍼런스/DEC 규격 심판 대상.
  | 'intended' // (d) 의도된 개선 — 승인 목록에 등재된 것만.
  | 'unclassified'; // 미판정(기본값 — 암묵 (d) 금지).

/**
 * diff 리포트. 두 피검체 이름·스냅샷 요약·불일치 목록·처리량 계측을 담는다.
 */
export interface DiffReport {
  readonly workloadName: string;
  readonly subjectA: string;
  readonly subjectB: string;
  readonly gridShape: Geometry;
  readonly totalCells: number;
  readonly mismatches: readonly DiffEntry[];
  readonly identical: boolean;
}

/**
 * 처리량 계측. xterm.js 기준선 수치(§5-2 요구). feed MB/s·전셀 추출 시간(ms).
 */
export interface ThroughputMetrics {
  readonly subject: string;
  readonly bytesTotal: number;
  readonly feedMs: number;
  readonly feedMBps: number;
  readonly extractMs: number;
  readonly cellCount: number;
}

/**
 * (d) 의도된 개선 승인 목록의 한 항목. intended-diffs.json이 이 배열을 담는다.
 * 워크로드·좌표·필드가 일치하는 불일치만 'intended'로 승격한다.
 */
export interface IntendedDiff {
  readonly workloadName: string;
  readonly x: number;
  readonly y: number;
  readonly field: string;
  readonly reason: string; // 왜 이것이 버그가 아니라 의도된 차이인지(사람이 작성).
}
