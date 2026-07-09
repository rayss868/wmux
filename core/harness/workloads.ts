// E0 컨포먼스 하니스 — 합성 워크로드 6종 (스펙: engine-core-decision-2026-07-09.md §5-1)
//
// 결정성 규율(§5-1): 동일 스크립트 2회 실행이 **동일 바이트**를 내야 한다. 그래서 워크로드는
// 타임스탬프·PID·난수 시스템 호출을 전혀 쓰지 않는다(시드 기반 PRNG만 허용). 각 워크로드는
// 순수 합성 바이트열과 resize 트레일, 그리고 "스크립트가 정답 명세"라는 §5-2 ③ 골든 어서션을
// 워크로드 정의 옆에 함께 둔다.
//
// 커밋 코퍼스 6종(D4 — 저장소 커밋은 합성만):
//   ① scroll-flood      대량 스크롤 flood
//   ② resize-roundtrip  resize 왕복(80→79→80) — **비-reflow 대조군**(40자, wrap 없음)
//   ②b resize-reflow    resize 왕복(80→79→80) — **wrap을 실제로 밟는 reflow 케이스**(120자, 실측 박제)
//   ③ alt-screen        alt-screen 진입/이탈
//   ④ cjk-emoji         CJK·이모지(ZWJ·VS16) 폭 케이스
//   ⑤ sgr-spectrum      SGR 스펙트럼(16/256/truecolor·속성 플래그)

import type { CellSnapshot, Geometry, GridSnapshot, RecordingEvent, ReflowMode } from './types';

/** SeededRng — rig/harness/seed.ts의 mulberry32와 동일 알고리즘(하니스 내부 자족을 위해 재게시). */
export class SeededRng {
  private state: number;
  constructor(readonly seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }
}

/** 워크로드가 그리드 스냅샷을 인자로 받아 참/거짓을 판정하는 골든 어서션. */
export interface GoldenAssertion {
  /** 사람이 읽는 어서션 이름(무엇이 정답인지). */
  readonly name: string;
  /** 스냅샷이 이 어서션을 만족하면 null, 아니면 실패 사유 문자열. */
  readonly check: (grid: GridSnapshot) => string | null;
}

/** 워크로드 정의: 이름 + 순수 합성 바이트 산출 + resize 트레일 + 골든 어서션(≥3). */
export interface Workload {
  readonly name: string;
  readonly initialGeometry: Geometry;
  readonly reflowMode: ReflowMode;
  /** 시드로부터 결정적 바이트열을 만든다(비결정 출력 금지). */
  readonly build: (rng: SeededRng) => Uint8Array;
  /**
   * recording.bin에 대한 resize/reflow 트레일. byteOffset은 build()가 낸 바이트열 기준 절대 위치.
   * init 이벤트는 recorder가 initialGeometry/reflowMode로 자동 선두 삽입하므로 여기엔 넣지 않는다.
   */
  readonly trail: (bytes: Uint8Array) => RecordingEvent[];
  /** §5-2 ③ 골든 어서션(코퍼스당 ≥3). 최종 재생 그리드에 대해 평가. */
  readonly golden: readonly GoldenAssertion[];
}

// ── ANSI 헬퍼(합성 — 상수만) ──────────────────────────────────────────────
const ESC = '\x1b';
const CSI = `${ESC}[`;
const enc = new TextEncoder();
function b(s: string): Uint8Array {
  return enc.encode(s);
}
/** 여러 조각을 하나의 Uint8Array로 잇는다. */
function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ── 골든 어서션 헬퍼 ──────────────────────────────────────────────────────
/** 특정 행의 텍스트(trailing 공백 제거)를 뽑는다. */
function rowText(grid: GridSnapshot, y: number): string {
  if (y < 0 || y >= grid.cells.length) return '';
  return grid.cells[y]
    .map((c: CellSnapshot) => (c.char === '' ? ' ' : c.char))
    .join('')
    .replace(/\s+$/, '');
}

// ── ① scroll-flood ────────────────────────────────────────────────────────
// 200줄을 24행 화면에 흘려 스크롤을 강제한다. 각 줄은 결정적 번호 + 반복 패턴.
// 마지막 화면에 남는 것은 뒤쪽 24줄이어야 한다(스크롤 정합).
const scrollFlood: Workload = {
  name: 'scroll-flood',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    const lines: Uint8Array[] = [];
    for (let i = 0; i < 200; i++) {
      // 결정적 본문: 줄 번호 + 고정 채움(폭 계산이 단순하도록 ASCII만).
      const label = `line ${String(i).padStart(4, '0')}`;
      const fill = '.'.repeat(20);
      lines.push(b(`${label} ${fill}\r\n`));
    }
    return concat(lines);
  },
  trail: () => [],
  golden: [
    {
      name: '마지막 화면 최하단 행은 line 0199',
      check: (g) => {
        const last = rowText(g, g.rows - 1);
        // 커서가 최종 개행 뒤 새 줄에 있을 수 있으므로 최하단에서 마지막 비어있지 않은 행을 찾는다.
        for (let y = g.rows - 1; y >= 0; y--) {
          const t = rowText(g, y);
          if (t.length > 0) {
            return t.startsWith('line 0199') ? null : `최하단 텍스트 행이 line 0199가 아님: "${t}"`;
          }
        }
        return `화면이 비어있음(last="${last}")`;
      },
    },
    {
      name: '화면 상단에 초기 줄(line 0000)은 스크롤 아웃되어 없다',
      check: (g) => {
        for (let y = 0; y < g.rows; y++) {
          if (rowText(g, y).startsWith('line 0000')) return `line 0000이 여전히 화면에 있음(y=${y})`;
        }
        return null;
      },
    },
    {
      name: '화면 폭·높이가 초기 geometry(80×24)와 일치',
      check: (g) => (g.cols === 80 && g.rows === 24 ? null : `geometry 불일치: ${g.cols}×${g.rows}`),
    },
  ],
};

// ── ② resize-roundtrip (비-reflow 대조군) ────────────────────────────────────
// **정직화(R2 ①): 이 워크로드는 reflow 경로를 밟지 않는 대조군이다.** 40자 마크는 축소 폭 79에서도
// wrap이 일어나지 않으므로(단일 행에 수렴) 80→79→80 왕복에서 xterm.js가 rewrap 로직을 전혀 타지
// 않는다. 즉 이 케이스가 검증하는 것은 "reflow idempotency"가 **아니라** "wrap이 없을 때 resize
// 왕복이 콘텐츠를 건드리지 않는다"는 대조 기준선이다. 실제 wrap/reflow 경로 검증은 신규 워크로드
// resize-reflow(아래)가 100자+ 마크로 담당한다. 이 대조군을 남기는 이유: reflow가 있는 케이스와
// 없는 케이스의 동작 차이를 나란히 봐야 "차이가 reflow에서 왔다"를 귀속할 수 있기 때문이다.
const RESIZE_MARK = 'ABCDEFGHIJ'.repeat(4); // 40자 — 79열에서도 wrap 없음(대조군).
const resizeRoundtrip: Workload = {
  name: 'resize-roundtrip',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    // 홈으로 이동 → 40자 마크 기록.
    return concat([b(`${CSI}H`), b(RESIZE_MARK)]);
  },
  trail: (bytes) => {
    const end = bytes.length;
    // 전 바이트 feed 후 resize 왕복(80→79→80). 같은 offset(end)에 순서대로 적용(안정 정렬 보존).
    return [
      { type: 'resize', byteOffset: end, geometry: { cols: 79, rows: 24 } },
      { type: 'resize', byteOffset: end, geometry: { cols: 80, rows: 24 } },
    ];
  },
  golden: [
    {
      name: '비-reflow 대조군: 80→79→80 왕복 후 첫 행이 40자 마크 그대로(wrap 없어 콘텐츠 불변)',
      check: (g) => {
        const t = rowText(g, 0);
        return t === RESIZE_MARK ? null : `첫 행 복원 실패: "${t}" (len=${t.length})`;
      },
    },
    {
      name: '왕복 후 열 수는 80으로 복원',
      check: (g) => (g.cols === 80 ? null : `cols=${g.cols} (기대 80)`),
    },
    {
      name: '둘째 행은 비어있다(40자는 wrap하지 않으므로 접힘 잔재 없음 — 대조군 특성)',
      check: (g) => {
        const t = rowText(g, 1);
        return t === '' ? null : `둘째 행에 잔재: "${t}"`;
      },
    },
  ],
};

// ── ②b resize-reflow (신규 — wrap을 실제로 밟는 reflow 케이스) ─────────────────
// **R2: reflow 경로를 실제로 검증한다.** 80열에서 120자 연속 마크를 홈부터 출력하면 시작부터
// wrapped 2행(row0 80자 full + row1 40자)이 된다. 이후 80→79→80 왕복.
//
// **골든은 "왕복 후 이상적 복원"이 아니라 xterm.js U11의 실측 결정적 상태를 박제한다**(R2 ②).
// 로컬 실측 관측(2026-07-09, @xterm/headless 6 + Unicode11Addon activeVersion='11'):
//   - 80열 write 직후: row0=80자 full, row1=40자, cursor (40,1).
//   - 80→79→80 왕복 후(박제 대상): row0=**79자**(col79가 빈 셀 — 마지막 'J'가 wrap 경계에서
//     복원되지 않음), row1=40자 그대로, cursor (40,1). 즉 원본 120자 중 **119자만 잔존**한다.
//   - 왕복 2회 결정성: 동일(게이트①이 보장하는 결정성은 성립 — 다만 "이상적 복원"은 아님).
// 이 79자 잔존은 xterm.js reflow가 wrap-pending 셀을 왕복에서 완전 복원하지 않는 실제 한계이며,
// 이상적 reflow idempotency(120자 완전 복원)는 **E1 코어의 (d)의도된 개선 목표**로
// intended-diffs.json에 예약 항목으로 등재된다(R4). 이 워크로드의 골든은 그 예약을 위한 실측
// 기준선을 박제하는 것이지, xterm.js의 이 동작을 "정답"이라 주장하는 것이 아니다.
const REFLOW_MARK = 'ABCDEFGHIJ'.repeat(12); // 120자 — 80열에서 시작부터 wrapped 2행.
// 왕복 후 실측 row0(79자): 120자 마크의 앞 79자(col0..78). 반복 주기 10 → col78 = 'I'(78 % 10 = 8).
const REFLOW_ROW0_AFTER = REFLOW_MARK.slice(0, 79);
// 왕복 후 실측 row1(40자): 마크의 80..119(원본 row1 40자가 그대로 잔존).
const REFLOW_ROW1_AFTER = REFLOW_MARK.slice(80, 120);
const resizeReflow: Workload = {
  name: 'resize-reflow',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    // 홈으로 이동 → 120자 연속 마크(시작부터 wrapped 2행).
    return concat([b(`${CSI}H`), b(REFLOW_MARK)]);
  },
  trail: (bytes) => {
    const end = bytes.length;
    // 전 바이트 feed 후 resize 왕복(80→79→80). wrap이 있으므로 실제 rewrap 경로를 밟는다.
    return [
      { type: 'resize', byteOffset: end, geometry: { cols: 79, rows: 24 } },
      { type: 'resize', byteOffset: end, geometry: { cols: 80, rows: 24 } },
    ];
  },
  golden: [
    {
      name: '왕복 후 열 수는 80으로 복원',
      check: (g) => (g.cols === 80 ? null : `cols=${g.cols} (기대 80)`),
    },
    {
      name: '실측 박제: 왕복 후 row0은 79자(wrap 경계 셀 미복원 — xterm.js U11 관측 상태)',
      check: (g) => {
        const t = rowText(g, 0);
        return t === REFLOW_ROW0_AFTER
          ? null
          : `row0 실측 불일치: "${t}" (len=${t.length}, 기대 len=79)`;
      },
    },
    {
      name: '실측 박제: 왕복 후 row1은 원본 뒤쪽 40자 그대로 잔존',
      check: (g) => {
        const t = rowText(g, 1);
        return t === REFLOW_ROW1_AFTER
          ? null
          : `row1 실측 불일치: "${t}" (len=${t.length}, 기대 len=40)`;
      },
    },
    {
      name: '실측 박제: 왕복 후 wrap 경계 col79 셀은 비어있다(마지막 J 미복원 — reflow 비-idempotency 증거)',
      check: (g) => {
        const c79 = g.cells[0]?.[79];
        if (!c79) return 'row0 col79 셀 없음';
        // 원본이라면 col79 = 'J'(120자 마크의 index 79 = 'J', 79 % 10 = 9). 실측은 빈 셀.
        return c79.char === '' ? null : `col79 char="${c79.char}" (실측 기대: 빈 셀 — J 미복원)`;
      },
    },
  ],
};

// ── ③ alt-screen ────────────────────────────────────────────────────────────
// normal 버퍼에 텍스트 → alt-screen 진입(1049h) → alt에 다른 텍스트 → 이탈(1049l).
// 이탈 후 normal 버퍼 텍스트가 복원되어야 한다.
const altScreen: Workload = {
  name: 'alt-screen',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    return concat([
      b(`${CSI}H`),
      b('NORMAL-BUFFER-LINE'),
      b(`${CSI}?1049h`), // alt-screen 진입.
      b(`${CSI}H`),
      b('ALT-BUFFER-LINE'),
      b(`${CSI}?1049l`), // alt-screen 이탈 → normal 복원.
    ]);
  },
  trail: () => [],
  golden: [
    {
      name: '이탈 후 활성 버퍼는 normal',
      check: (g) => (g.activeBuffer === 'normal' ? null : `활성 버퍼=${g.activeBuffer}`),
    },
    {
      name: '이탈 후 normal 버퍼 첫 행이 복원(NORMAL-BUFFER-LINE)',
      check: (g) => {
        const t = rowText(g, 0);
        return t === 'NORMAL-BUFFER-LINE' ? null : `normal 첫 행 미복원: "${t}"`;
      },
    },
    {
      name: '이탈 후 alt 텍스트(ALT-BUFFER-LINE)는 화면에 없다',
      check: (g) => {
        for (let y = 0; y < g.rows; y++) {
          if (rowText(g, y).includes('ALT-BUFFER-LINE')) return `alt 텍스트 잔존(y=${y})`;
        }
        return null;
      },
    },
  ],
};

// ── ④ cjk-emoji ──────────────────────────────────────────────────────────────
// CJK 2폭·범위이모지 2폭·VS16 폭 케이스·ZWJ 시퀀스. 각 wide 글리프 뒤엔 폭0 spacer 셀.
//
// 골든은 xterm.js **U11 기준선의 실제 관측 동작**을 정본으로 삼는다(사람이 이상적으로 아는 폭이
// 아니라 기준선이 내는 폭). 실측 근거:
//   - CJK '한' → 폭2 + spacer w0 (U11 정답 명확).
//   - 범위 이모지 U+1F600(😀) → 폭2 + spacer w0 (코드포인트 자체가 Emoji_Presentation).
//   - U+2764+VS16(❤️) → xterm.js U11에서 **폭1**. VS16 emoji-presentation 폭 승격이 U11 테이블에
//     반영되지 않은 실제 한계다. 이 셀은 우리 코어(E1, U16+grapheme)에서 폭2로 갈 (d)의도된 개선의
//     구체적 씨앗이며, 그때 intended-diffs.json에 (cjk-emoji, VS16 좌표, width) 항목이 등재된다.
const CJK = '한글'; // 각 글자 폭2.
const EMOJI_RANGE = '\u{1F600}'; // 😀 — 코드포인트 자체가 폭2.
const EMOJI_VS16 = '❤️'; // ❤️ 하트 + VS16 → xterm U11 기준선 폭1(관측).
const ZWJ_FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // 👨‍👩‍👧 ZWJ 가족.
const cjkEmoji: Workload = {
  name: 'cjk-emoji',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    return concat([
      b(`${CSI}H`),
      b(CJK), // 행0: 한글 (셀 0='한' w2, 셀1='' w0, 셀2='글' w2, 셀3='' w0).
      b('\r\n'),
      b(EMOJI_RANGE), // 행1: 😀 (셀0 w2, 셀1 w0).
      b('\r\n'),
      b(EMOJI_VS16), // 행2: ❤️ (U11 기준선 셀0 w1).
      b('\r\n'),
      b(`X${ZWJ_FAMILY}Y`), // 행3: X + ZWJ가족 + Y.
    ]);
  },
  trail: () => [],
  golden: [
    {
      name: 'CJK 첫 글자(한)는 폭2, 다음 셀은 폭0 spacer',
      check: (g) => {
        const c0 = g.cells[0]?.[0];
        const c1 = g.cells[0]?.[1];
        if (!c0 || !c1) return '행0 셀 없음';
        if (c0.width !== 2) return `셀0 폭=${c0.width} (기대 2), char="${c0.char}"`;
        if (c1.width !== 0) return `셀1(spacer) 폭=${c1.width} (기대 0)`;
        return c0.char === '한' ? null : `셀0 문자="${c0.char}" (기대 한)`;
      },
    },
    {
      name: 'wide spacer 쌍 정합: 한글 두 글자 → 4셀(w2,w0,w2,w0)',
      check: (g) => {
        const w = [0, 1, 2, 3].map((x) => g.cells[0]?.[x]?.width);
        return w[0] === 2 && w[1] === 0 && w[2] === 2 && w[3] === 0
          ? null
          : `폭 열=${JSON.stringify(w)} (기대 [2,0,2,0])`;
      },
    },
    {
      name: '범위 이모지(😀)는 폭2 + 폭0 spacer(U11 정답)',
      check: (g) => {
        const c0 = g.cells[1]?.[0];
        const c1 = g.cells[1]?.[1];
        if (!c0 || !c1) return '행1 셀 없음';
        if (c0.width !== 2) return `이모지 폭=${c0.width} (기대 2), char="${c0.char}"`;
        return c1.width === 0 ? null : `spacer 폭=${c1.width} (기대 0)`;
      },
    },
    {
      name: 'VS16 하트(❤️)는 xterm.js U11 기준선에서 폭1 (VS16 승격 미반영 — (d)개선 씨앗)',
      check: (g) => {
        const c0 = g.cells[2]?.[0];
        if (!c0) return '행2 셀 없음';
        // 기준선 정본: U11에서 폭1. 우리 코어가 폭2로 가면 그때 intended-diff로 승인.
        return c0.width === 1 ? null : `VS16 하트 폭=${c0.width} (U11 기준선 기대 1)`;
      },
    },
    {
      name: 'ZWJ 가족 앞뒤 ASCII(X…Y) 정합 — X는 행3 셀0',
      check: (g) => {
        const c0 = g.cells[3]?.[0];
        if (!c0) return '행3 셀 없음';
        return c0.char === 'X' && c0.width === 1 ? null : `행3 셀0="${c0.char}" w=${c0.width}`;
      },
    },
  ],
};

// ── ⑤ sgr-spectrum ────────────────────────────────────────────────────────────
// 16색·256색·truecolor·속성 플래그. 각 셀의 색모드/색값/플래그가 정확히 반영되는지.
const sgrSpectrum: Workload = {
  name: 'sgr-spectrum',
  initialGeometry: { cols: 80, rows: 24 },
  reflowMode: 'self',
  build: () => {
    return concat([
      b(`${CSI}H`),
      // 행0: 16색 — 빨강 전경(31), 그 다음 파랑 배경(44).
      b(`${CSI}31mR${CSI}0m`),
      b(`${CSI}44mB${CSI}0m`),
      b('\r\n'),
      // 행1: 256색 팔레트 — 전경 196(밝은 빨강).
      b(`${CSI}38;5;196mP${CSI}0m`),
      b('\r\n'),
      // 행2: truecolor — 전경 RGB(0x123456).
      b(`${CSI}38;2;18;52;86mT${CSI}0m`),
      b('\r\n'),
      // 행3: 속성 플래그 — bold+underline+italic.
      b(`${CSI}1;3;4mA${CSI}0m`),
    ]);
  },
  trail: () => [],
  golden: [
    {
      name: '16색: 행0 셀0(R)은 palette 전경 색번호 1(빨강)',
      check: (g) => {
        const c = g.cells[0]?.[0];
        if (!c) return '행0 셀0 없음';
        if (!c.fgPalette) return `palette 전경이 아님(fgPalette=${c.fgPalette})`;
        return c.fg === 1 ? null : `fg=${c.fg} (기대 1)`;
      },
    },
    {
      name: '256색: 행1 셀0(P)은 palette 전경 196',
      check: (g) => {
        const c = g.cells[1]?.[0];
        if (!c) return '행1 셀0 없음';
        if (!c.fgPalette) return `palette 전경이 아님(fgPalette=${c.fgPalette})`;
        return c.fg === 196 ? null : `fg=${c.fg} (기대 196)`;
      },
    },
    {
      name: 'truecolor: 행2 셀0(T)은 RGB 0x123456',
      check: (g) => {
        const c = g.cells[2]?.[0];
        if (!c) return '행2 셀0 없음';
        if (!c.fgRGB) return `RGB 전경이 아님(fgRGB=${c.fgRGB})`;
        return c.fg === 0x123456 ? null : `fg=0x${c.fg.toString(16)} (기대 0x123456)`;
      },
    },
    {
      name: '속성 플래그: 행3 셀0(A)은 bold+italic+underline',
      check: (g) => {
        const c = g.cells[3]?.[0];
        if (!c) return '행3 셀0 없음';
        if (!c.bold) return 'bold 미설정';
        if (!c.italic) return 'italic 미설정';
        if (!c.underline) return 'underline 미설정';
        return null;
      },
    },
  ],
};

/** 커밋 코퍼스 6종(D4 — 저장소 커밋은 합성만). */
export const WORKLOADS: readonly Workload[] = [
  scrollFlood,
  resizeRoundtrip,
  resizeReflow,
  altScreen,
  cjkEmoji,
  sgrSpectrum,
];

/** 이름으로 워크로드 조회. */
export function workloadByName(name: string): Workload | undefined {
  return WORKLOADS.find((w) => w.name === name);
}
