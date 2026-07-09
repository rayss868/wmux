// E0 하니스 M3 — DECRQCRA 체크섬 브리지 (스펙: engine-core-decision-2026-07-09.md §5-3)
//
// ⚠️ 클린룸 규율: 이 파일의 체크섬 알고리즘·와이어 형식은 **DEC STD 070 / xterm ctlseqs
//    규격에서만 도출**했다. GPL-2.0 esctest2(vendor/)의 체크섬 로직은 참조하지 않았다.
//    (esctest는 애초에 체크섬을 계산하지 않는다 — 요청만 보내고 터미널이 계산한다. 즉
//     계산 알고리즘은 vendor 소스에 존재하지도 않는다. 우리는 xterm이 응답으로 낼 값을
//     피검체 그리드에서 재현한다.)
//
// ── DECRQCRA 와이어 형식(xterm ctlseqs 규격) ─────────────────────────────────
//   요청:  CSI Pid ; Pp ; Pt ; Pl ; Pb ; Pr * y
//          - Pid: request id(응답에 에코). Pp: page(0=현재). Pt/Pl/Pb/Pr: rect(1-based).
//          - intermediate '*'(0x2A), final 'y'(0x79).
//   응답:  DCS Pid ! ~ D...D ST
//          - DCS = ESC P (0x1B 0x50), 종결 ST = ESC \ (0x1B 0x5C).
//          - Pid 십진 에코, 이어서 "!~", 이어서 4자리 대문자 16진 체크섬.
//
// ── 체크섬 정의(xterm 정본) ──────────────────────────────────────────────────
//   xterm의 DECRQCRA 체크섬 = 사각형 안 각 셀의 문자 코드 합의 **2의 보수(부정)**를
//   16비트로 자른 값:  checksum = (-Σ code) & 0xFFFF.
//   - Σ code: rect 내 각 셀의 표시 문자 코드포인트 합. **빈/공백 셀은 0x20(space)**로
//     계산한다(xterm #336 이후 "모든 blank 균등" 동작 — DEC VT520 실동작과 일치).
//   - 속성(SGR) 기여는 xterm 기본 빌드에서 미포함(문자 코드만). VT520은 속성 비트도
//     더하지만 xterm은 기본적으로 문자만 — 우리 기준선(xterm.js)과 정합.
//   - wide 문자: xterm은 셀 단위로 순회하며 wide의 뒤(spacer) 셀은 코드 0 기여가 아니라
//     건너뛰지 않고 0x20 취급(빈 셀과 동일). 본 브리지도 spacer(width 0)를 0x20으로 센다.
//
// 이 정의는 "xterm.js 그리드가 xterm과 같은 문자를 담고 있으면 같은 체크섬이 나온다"는
// 검증력을 준다 — 즉 DECRQCRA 왕복이 그리드 내용을 실제로 검증한다.

import type { Terminal } from '@xterm/headless';

/** 공백/미기입 셀에 부여하는 코드(xterm #336 blank 균등 = space). */
export const BLANK_CODE = 0x20;

/**
 * rect(1-based, inclusive) 안 문자 코드 합의 16비트 2의 보수를 계산한다.
 * getCells를 직접 순회하지 않고 buffer.active에서 읽는다(differ.extractGrid와 동일 소스).
 *
 * @param term    피검체(@xterm/headless).
 * @param top,left,bottom,right  1-based inclusive 화면 좌표(esctest DECRQCRA rect).
 */
export function computeRectChecksum(
  term: Terminal,
  top: number,
  left: number,
  bottom: number,
  right: number,
): number {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  // 1-based → 0-based, 그리드 경계로 클램프(rect가 화면을 벗어나도 안전).
  const y0 = Math.max(0, top - 1);
  const y1 = Math.min(rows - 1, bottom - 1);
  const x0 = Math.max(0, left - 1);
  const x1 = Math.min(cols - 1, right - 1);

  let sum = 0;
  for (let y = y0; y <= y1; y++) {
    const line = buf.getLine(buf.viewportY + y);
    for (let x = x0; x <= x1; x++) {
      const cell = line?.getCell(x);
      let code: number;
      if (!cell) {
        code = BLANK_CODE;
      } else {
        const width = cell.getWidth();
        const chars = cell.getChars();
        if (width === 0 || chars === '') {
          // wide spacer 또는 미기입 → blank(space) 취급(xterm #336 균등).
          code = BLANK_CODE;
        } else {
          code = cell.getCode();
          if (code === 0) code = BLANK_CODE; // NUL/미설정도 blank로.
        }
      }
      sum = (sum + code) & 0xffff;
    }
  }
  // 2의 보수(부정)를 16비트로.
  return (-sum) & 0xffff;
}

/**
 * DECRQCRA 응답 바이트를 만든다: DCS Pid ! ~ HHHH ST.
 * 체크섬은 4자리 대문자 16진(xterm 관례).
 */
export function buildDecrqcraReply(pid: number, checksum: number): Uint8Array {
  const hex = (checksum & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  // ESC P {pid}!~{HHHH} ESC \
  const body = `\x1bP${pid}!~${hex}\x1b\\`;
  return Buffer.from(body, 'binary');
}

// ── WINOPS 크기 리포트 브리지(스파이크 실측 추가 — 결정 문서 §5-3 미포착) ──────
//
// 실측(probe): @xterm/headless는 CPR·DA·DA2·DSR·DECRQM·DECXCPR 질의는 전부 방출하지만
// **XTERM_WINOPS 크기 리포트(CSI 18 t / CSI 19 t)는 침묵**한다(headless엔 윈도우가 없다).
// esctest의 reset()이 GetScreenSize()=CSI 18 t를 tab stop 설정에 쓰므로, 이게 없으면 reset
// 자체가 timeout으로 죽어 어떤 케이스도 실행되지 않는다. 그래서 DECRQCRA와 동일 성격의
// 브리지 — **어댑터가 grid geometry를 알고 있으므로 그 값으로 응답**(검증력 손실 없음:
// geometry는 어댑터의 resize가 관장하는 값이다). 브리지 사용 사실은 리포트에 기록한다.
//
// 와이어 형식(xterm ctlseqs):
//   CSI 18 t (report text-area size in chars)  → 응답 CSI 8 ; rows ; cols t
//   CSI 19 t (report screen size in chars)     → 응답 CSI 9 ; rows ; cols t

/** CSI 18 t / CSI 19 t 요청 응답. code=8(18t)·9(19t). */
export function buildWinopsSizeReply(reportCode: 8 | 9, rows: number, cols: number): Uint8Array {
  return Buffer.from(`\x1b[${reportCode};${rows};${cols}t`, 'binary');
}

/** WINOPS 크기 질의 파싱 결과. */
export type WinopsSizeParse =
  | { readonly reportCode: 8 | 9; readonly end: number }
  | null
  | 'incomplete';

/**
 * s[start..]에서 WINOPS 크기 질의(CSI 18 t / CSI 19 t)만 파싱한다. 다른 WINOPS(타이틀 push/pop,
 * deiconify 등)는 응답이 없으므로 여기서 null → 피검체로 흘려보낸다(xterm.js가 무시).
 */
export function tryParseWinopsSizeQuery(s: string, start: number): WinopsSizeParse {
  let i = start;
  if (s.charCodeAt(i) === 0x1b) {
    if (i + 1 >= s.length) return 'incomplete';
    if (s[i + 1] !== '[') return null;
    i += 2;
  } else if (s.charCodeAt(i) === 0x9b) {
    i += 1;
  } else {
    return null;
  }
  let params = '';
  while (i < s.length) {
    const code = s.charCodeAt(i);
    if (code >= 0x30 && code <= 0x3f) {
      params += s[i];
      i += 1;
    } else if (code >= 0x40 && code <= 0x7e) {
      // final. WINOPS final = 't', intermediate 없음.
      if (s[i] === 't') {
        // 단일 파라미터 18 또는 19만 크기 리포트(뒤에 인자 붙는 형태는 크기 질의 아님).
        if (params === '18') return { reportCode: 8, end: i + 1 };
        if (params === '19') return { reportCode: 9, end: i + 1 };
        return null; // 다른 winop → 피검체로.
      }
      return null; // 't' 아닌 final → WINOPS 아님.
    } else {
      return null;
    }
  }
  return 'incomplete';
}

/** tryParseDecrqcra 결과: 완결 요청이면 필드, 시작 아니면 null, 미완결이면 'incomplete'. */
export type DecrqcraParse =
  | { readonly pid: number; readonly page: number; readonly top: number; readonly left: number; readonly bottom: number; readonly right: number; readonly end: number }
  | null
  | 'incomplete';

/**
 * s[start..] 위치에서 DECRQCRA 요청(CSI ... * y)을 파싱한다.
 *   - s[start]가 ESC(0x1B)이고 CSI(ESC[)로 이어지지 않으면 시작 아님(null).
 *   - CSI 파라미터 도중 버퍼가 끝나면 'incomplete'(다음 chunk와 합쳐 재시도).
 *   - intermediate '*' + final 'y'로 끝나면 파라미터를 (pid,page,top,left,bottom,right)로 해석.
 *
 * 파라미터가 6개 미만이면(비정상 DECRQCRA) null 취급 — 피검체로 흘려보낸다. esctest 정상
 * 경로는 항상 Pid;Pp;Pt;Pl;Pb;Pr 6개를 보낸다(vendor esccmd DECRQCRA 사용법 확인).
 */
export function tryParseDecrqcra(s: string, start: number): DecrqcraParse {
  // CSI 시작 판정: ESC(0x1B) '[' 또는 8-bit CSI(0x9B). esctest는 7-bit(ESC[)만 방출.
  let i = start;
  if (s.charCodeAt(i) === 0x1b) {
    if (i + 1 >= s.length) return 'incomplete';
    if (s[i + 1] !== '[') return null;
    i += 2;
  } else if (s.charCodeAt(i) === 0x9b) {
    i += 1;
  } else {
    return null;
  }
  // 파라미터/intermediate/final 스캔.
  let params = '';
  let intermediate = '';
  while (i < s.length) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (code >= 0x30 && code <= 0x3f) {
      // 파라미터 바이트(숫자·';'·':'·'<'..'?').
      params += ch;
      i += 1;
    } else if (code >= 0x20 && code <= 0x2f) {
      // intermediate 바이트('*' 포함).
      intermediate += ch;
      i += 1;
    } else if (code >= 0x40 && code <= 0x7e) {
      // final 바이트. DECRQCRA final = 'y' + intermediate '*'.
      if (ch === 'y' && intermediate === '*') {
        const parts = params.split(';');
        if (parts.length < 6) return null; // DECRQCRA 아님(다른 CSI * y 없음, 방어).
        const nums = parts.map((p) => (p === '' ? 0 : parseInt(p, 10)));
        if (nums.some((n) => Number.isNaN(n))) return null;
        return {
          pid: nums[0],
          page: nums[1],
          top: nums[2],
          left: nums[3],
          bottom: nums[4],
          right: nums[5],
          end: i + 1,
        };
      }
      // 다른 CSI 시퀀스 → DECRQCRA 아님(피검체로 흘려보낸다).
      return null;
    } else {
      // 제어문자 난입 등 비정상 → 시작 아님으로.
      return null;
    }
  }
  // 파라미터 도중 버퍼 끝 → 미완결.
  return 'incomplete';
}
