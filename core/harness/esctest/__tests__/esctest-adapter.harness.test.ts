// E0 하니스 M3 — esctest 어댑터 검증 (스펙: engine-core-decision-2026-07-09.md §5-3, D6 S-C)
//
// 통과 기준(D6 S-C 행):
//   T1: DECRQCRA 왕복 1건 — 알려진 그리드 상태에서 체크섬 질의→응답이 DEC 규격 계산과 일치.
//   T2: cup.py(CPR 기반) 완주 — esctest가 cup.py 1파일을 무수정 실행하고 판정을 반환.
//   T3: 체크섬 단위 테스트 — DEC 규격 도출 구현의 독립 검증(수동 계산 케이스).
//
// vendor(GPL-2.0 esctest2) 부재 시 PTY 실행 테스트(T1·T2)는 명시 skip한다. T3는 vendor
// 무관(순수 체크섬 단위)이라 항상 실행한다.

import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import {
  runEsctestCase,
  buildReport,
  esctestVendorPresent,
  parseEsctestLog,
  parseEsctestSummary,
  ESCTEST_ENTRY,
} from '../adapter';
import {
  computeRectChecksum,
  buildDecrqcraReply,
  tryParseDecrqcra,
  tryParseWinopsSizeQuery,
  buildWinopsSizeReply,
  BLANK_CODE,
} from '../decrqcra';

const vendor = esctestVendorPresent();
const describeVendor = vendor ? describe : describe.skip;

if (!vendor) {
  // 스킵 사유를 명시(조용한 통과 방지). vendor는 fetch-esctest.sh로 준비한다.
  // eslint-disable-next-line no-console
  console.warn(
    `[esctest-adapter.test] vendor 부재 (${ESCTEST_ENTRY}) — PTY 실행 테스트(T1·T2) skip. ` +
      `준비: bash core/harness/esctest/fetch-esctest.sh`,
  );
}

// ── 헬퍼: 알려진 그리드 상태를 만든다(differ와 동일한 xterm.js + Unicode11 설정). ──
function makeTerm(cols = 80, rows = 25): Terminal {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon() as never);
  term.unicode.activeVersion = '11';
  return term;
}
function writeSync(term: Terminal, s: string): Promise<void> {
  return new Promise((resolve) => term.write(s, resolve));
}

// ────────────────────────────────────────────────────────────────────────────
// T3: 체크섬 단위 테스트 (vendor 무관 — DEC 규격 도출 구현의 독립 검증).
// ────────────────────────────────────────────────────────────────────────────
describe('T3 — DECRQCRA 체크섬 (DEC STD 070 / xterm ctlseqs 도출)', () => {
  // 수동 계산 정답(파이썬 교차 계산): checksum = (-Σ code) & 0xFFFF, blank=0x20.
  //   'A'(0x41) 1x1                → 0xFFBF
  //   'AB'(0x41+0x42) 1x2          → 0xFF7D
  //   'Hello' 1x5                  → 0xFE0C
  //   빈 2x2 (space×4 = 0x80)      → 0xFF80
  it('단일 문자 A(1x1) 체크섬 = 0xFFBF', async () => {
    const term = makeTerm();
    await writeSync(term, 'A'); // (col1,row1)에 A.
    const chk = computeRectChecksum(term, 1, 1, 1, 1);
    expect(chk).toBe(0xffbf);
    term.dispose();
  });

  it('AB(1x2) 체크섬 = 0xFF7D', async () => {
    const term = makeTerm();
    await writeSync(term, 'AB');
    const chk = computeRectChecksum(term, 1, 1, 1, 2);
    expect(chk).toBe(0xff7d);
    term.dispose();
  });

  it('Hello(1x5) 체크섬 = 0xFE0C', async () => {
    const term = makeTerm();
    await writeSync(term, 'Hello');
    const chk = computeRectChecksum(term, 1, 1, 1, 5);
    expect(chk).toBe(0xfe0c);
    term.dispose();
  });

  it('빈 영역(2x2, space×4) 체크섬 = 0xFF80', () => {
    const term = makeTerm();
    // 아무것도 쓰지 않은 영역 — 빈 셀은 blank(0x20)로 계산.
    const chk = computeRectChecksum(term, 1, 1, 2, 2);
    expect(chk).toBe(0xff80);
    term.dispose();
  });

  it('esctest 복원식 정합: 0x10000 - checksum == Σcode (esctest escutil:279 역산)', () => {
    // esctest는 응답 checksum을 0x10000 - checksum으로 되돌려 문자 코드와 비교한다.
    // 우리 브리지가 (-sum)&0xFFFF를 보내면 이 역산이 sum을 정확히 복원해야 한다.
    const sum = 0x41 + 0x42 + 0x43; // 'ABC'
    const checksum = (-sum) & 0xffff;
    expect((0x10000 - checksum) & 0xffff).toBe(sum);
  });

  it('BLANK_CODE = 0x20 (xterm #336 blank 균등)', () => {
    expect(BLANK_CODE).toBe(0x20);
  });

  it('buildDecrqcraReply는 DCS Pid!~HHHH ST 형식', () => {
    const reply = Buffer.from(buildDecrqcraReply(7, 0xffbf)).toString('binary');
    // ESC P 7 ! ~ F F B F ESC \
    expect(reply).toBe('\x1bP7!~FFBF\x1b\\');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DECRQCRA / WINOPS 요청 파서 단위(라우팅 정확성 — vendor 무관).
// ────────────────────────────────────────────────────────────────────────────
describe('요청 파서 — DECRQCRA / WINOPS 크기 질의', () => {
  it('완결 DECRQCRA 요청을 필드로 파싱(CSI Pid;Pp;t;l;b;r * y)', () => {
    const s = '\x1b[1;0;6;5;6;5*y';
    const p = tryParseDecrqcra(s, 0);
    expect(p).not.toBe('incomplete');
    expect(p).not.toBeNull();
    if (p && p !== 'incomplete') {
      expect(p).toMatchObject({ pid: 1, page: 0, top: 6, left: 5, bottom: 6, right: 5 });
      expect(p.end).toBe(s.length);
    }
  });

  it('청크 경계에 걸린 DECRQCRA는 incomplete(이월 신호)', () => {
    expect(tryParseDecrqcra('\x1b[1;0;6;5', 0)).toBe('incomplete');
  });

  it('DECRQCRA 아닌 CSI(CPR)는 null(피검체로 흘려보냄)', () => {
    expect(tryParseDecrqcra('\x1b[6n', 0)).toBeNull();
  });

  it('WINOPS 18t/19t만 크기 질의로 파싱, 그 외 winop은 null', () => {
    expect(tryParseWinopsSizeQuery('\x1b[18t', 0)).toMatchObject({ reportCode: 8 });
    expect(tryParseWinopsSizeQuery('\x1b[19t', 0)).toMatchObject({ reportCode: 9 });
    // 타이틀 pop 등(23;0t)은 크기 질의 아님.
    expect(tryParseWinopsSizeQuery('\x1b[23;0t', 0)).toBeNull();
    // 픽셀 크기(14t)는 브리지 미지원(정직 — headless는 픽셀 침묵) → null로 흘려보냄.
    expect(tryParseWinopsSizeQuery('\x1b[14t', 0)).toBeNull();
  });

  it('WINOPS 크기 응답 형식: CSI code;rows;cols t', () => {
    expect(Buffer.from(buildWinopsSizeReply(8, 25, 80)).toString('binary')).toBe('\x1b[8;25;80t');
    expect(Buffer.from(buildWinopsSizeReply(9, 25, 80)).toString('binary')).toBe('\x1b[9;25;80t');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 로그 파서 단위(esctest 실측 포맷 — vendor 무관).
// ────────────────────────────────────────────────────────────────────────────
describe('parseEsctestLog — 실측 esctest 로그 포맷', () => {
  it('Run test / Passed. 를 pass로 집계', () => {
    const log = [
      'Run test: CUPTests.test_CUP_DefaultParams',
      'Passed.',
      '',
      'Run test: CUPTests.test_CUP_RowOnly',
      'Passed.',
    ].join('\n');
    const cases = parseEsctestLog(log);
    expect(cases).toHaveLength(2);
    expect(cases.every((c) => c.status === 'pass')).toBe(true);
  });

  it('*** TEST X FAILED 를 fail로 집계', () => {
    const log = ['Run test: FooTests.test_bar', '*** TEST FooTests.test_bar FAILED:', 'Traceback...'].join(
      '\n',
    );
    const cases = parseEsctestLog(log);
    expect(cases).toHaveLength(1);
    expect(cases[0].status).toBe('fail');
  });

  it('Fails as expected는 known-bug로 분리 집계(리뷰 반영 — pass 순도)', () => {
    const log = ['Run test: FooTests.test_bar', 'Fails as expected: known xterm bug'].join('\n');
    expect(parseEsctestLog(log)[0].status).toBe('known-bug');
  });

  it('능력 부재 skip은 skipped로 분리 집계(pass 합산 금지 — 리뷰 반영)', () => {
    const log = [
      'Run test: FooTests.test_bar',
      'Skipped because terminal lacks requisite capability: 8-bit controls',
    ].join('\n');
    expect(parseEsctestLog(log)[0].status).toBe('skipped');
  });

  it('신호 없이 끊긴 마지막 케이스는 error로 마감(무응답 데드락)', () => {
    const log = ['Run test: FooTests.test_bar'].join('\n');
    expect(parseEsctestLog(log)[0].status).toBe('error');
  });

  it('esctest 요약 라인을 파싱한다(파서 집계의 독립 대조 기준 — 리뷰 반영)', () => {
    const s = parseEsctestSummary('...\n*** 6 tests passed, 0 known bugs, 0 tests failed ***\n');
    expect(s).toEqual({ passed: 6, knownBugs: 0, failed: 0 });
    expect(parseEsctestSummary('no summary here')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T1: DECRQCRA 왕복 1건 (vendor 필요 — PTY 실행).
// ────────────────────────────────────────────────────────────────────────────
describeVendor('T1 — DECRQCRA 왕복 (esctest 무수정 실행)', () => {
  it('deccra.py의 DECRQCRA 체크섬 왕복이 최소 1건 성공한다', async () => {
    // deccra(DECCRA=사각형 복사)는 결과 검증에 AssertScreenCharsInRectEqual → DECRQCRA를 쓴다.
    // cursorDoesNotMove 케이스는 CPR 기반이라 확실히 통과하고, 나머지는 DECRQCRA 왕복을 탄다.
    // 통과 기준은 "왕복 1건"이므로 decrqcraBridgeUses ≥ 1 + 최소 1케이스 pass를 본다.
    const r = await runEsctestCase({
      include: '(?i)^DECCRA[Tt]ests\\.',
      timeoutSec: 3,
      maxVtLevel: 5,
      hardTimeoutMs: 40000,
    });
    // DECRQCRA 브리지가 실제로 왕복했다(핵심 통과 기준).
    expect(r.decrqcraBridgeUses).toBeGreaterThanOrEqual(1);
    // 최소 1케이스는 판정을 반환했다(무한 홀드/전멸 아님).
    expect(r.cases.length).toBeGreaterThanOrEqual(1);
    // 어댑터가 완주했다(하드 타임아웃으로 죽지 않음).
    expect(r.timedOut).toBe(false);
  });

  it('알려진 그리드에서 DECRQCRA 왕복이 DEC 규격 계산과 일치(브리지 직접 검증)', async () => {
    // 어댑터의 브리지 경로를 직접 실증: 그리드에 문자를 쓰고 그 rect의 체크섬이
    // 수동 계산과 같은지 — 이 값이 곧 esctest에 되돌려주는 응답이다.
    const term = makeTerm();
    await writeSync(term, 'H'); // (1,1)에 H(0x48).
    const chk = computeRectChecksum(term, 1, 1, 1, 1);
    expect(chk).toBe((-0x48) & 0xffff); // 0xFFB8.
    // 응답 바이트가 esctest 파서가 읽는 형식인지.
    const reply = Buffer.from(buildDecrqcraReply(42, chk)).toString('binary');
    expect(reply).toBe('\x1bP42!~FFB8\x1b\\');
    term.dispose();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// T2: cup.py 완주 (vendor 필요 — CPR 기반, 전 케이스 판정 수집).
// ────────────────────────────────────────────────────────────────────────────
describeVendor('T2 — cup.py 완주 (CPR 기반, 무수정 실행)', () => {
  it('cup.py 1파일을 무수정 실행하고 케이스별 판정을 반환한다', async () => {
    const r = await runEsctestCase({
      include: 'cup', // (?i)cup으로 정규화 → CUPTests 매칭.
      timeoutSec: 3,
      maxVtLevel: 5,
      hardTimeoutMs: 40000,
    });
    // 어댑터가 완주(reset 통과 + 케이스 실행).
    expect(r.timedOut).toBe(false);
    // cup.py는 6개 테스트 메서드를 가진다(vendor 핀 기준). 전부 판정을 반환해야 한다.
    expect(r.cases.length).toBe(6);
    // xterm.js 기준선의 실태: 전 케이스 pass가 목표. 실제 미준수가 있으면 정직하게 fail로
    // 남되(리포트에 기록), 여기서는 "완주 + 판정 반환"을 게이트로 한다. pass 수는 보고용.
    // (관찰: 6/6 pass — xterm.js는 CUP를 정확히 준수.)
    expect(r.passCount + r.failCount + r.errorCount + r.knownBugCount + r.skippedCount).toBe(6);
    // 파서 집계가 esctest 자체 요약 라인과 일치한다(리뷰 반영 — 오분류·분모 축소 탐지).
    expect(r.esctestSummary).not.toBeNull();
    expect(r.reconciled).toBe(true);
    // reset()의 GetScreenSize()가 WINOPS 브리지를 탔다(결정 문서 미포착 경로 실증).
    expect(r.winopsBridgeUses).toBeGreaterThanOrEqual(1);
    // 리포트 빌드가 총계를 집계한다.
    const report = buildReport([r]);
    expect(report.totals.pass + report.totals.fail + report.totals.error).toBe(6);
    expect(report.totals.unreconciledRuns).toBe(0);
    expect(report.esctestPin).toBe('664be3cf2c1e3f06bc93a8bafb48a0db83c607db');
  });
});
