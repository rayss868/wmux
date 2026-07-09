// E0 하니스 M3 — esctest 리포트 생성기 (스펙: engine-core-decision-2026-07-09.md §5-3)
//
// 대표 include 세트를 무수정 esctest로 실행해 케이스별 판정을 모으고 report.json을 쓴다.
// 판정 수집의 실행형 진입점(테스트는 통과 기준 게이트, 이건 산출물 생성).
//
// 사용:
//   npx tsx core/harness/esctest/gen-report.ts            # 기본 대표 세트
//   INCLUDES="cup,cuf,ed" npx tsx core/harness/esctest/gen-report.ts
// vendor 부재 시 명시 에러(fetch-esctest.sh 안내). GPL 소스는 vendor/에만(gitignored).

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { runEsctestCase, buildReport, esctestVendorPresent, ESCTEST_ENTRY } from './adapter';
import type { EsctestCaseResult } from './report-types';

// 대표 세트. **전부 클래스 접두 앵커((?i)^<Class>Tests\.)로 준다** — 짧은 이름(cha·ed·hpa)을
// 맨이름으로 주면 esctest의 re.search가 부분매칭을 일으켜(예: (?i)cha → ChangeColorTests까지)
// 색 질의 계열이 딸려와 hang한다. 앵커가 각 파일을 정확히 격리한다(스파이크 실측 교훈).
// 클래스명은 파일명과 1:1이 아니다(ed.py→EDTests, xterm_winops.py→XtermWinopsTests) — vendor
// 클래스명을 그대로 앵커한다.
const CLASS = (name: string): string => `(?i)^${name}Tests\\.`;
const DEFAULT_INCLUDES = [
  // CPR 기반(커서 이동) — xterm.js가 CPR을 자체 방출하는 완주군.
  CLASS('CUP'),
  CLASS('CUF'),
  CLASS('CUB'),
  CLASS('CUU'),
  CLASS('CUD'),
  CLASS('CHA'),
  CLASS('VPA'),
  CLASS('HPA'),
  // DECRQCRA 기반(rect 내용 검증) — 브리지 왕복 대량 실증.
  CLASS('DECCRA'),
  CLASS('DECFRA'),
  CLASS('ED'),
  CLASS('EL'),
  CLASS('ICH'),
  CLASS('DCH'),
  // 디바이스 속성(xterm.js 자체 방출 DA/DA2).
  CLASS('DA'),
  CLASS('DA2'),
];

// report.json 출력 경로. 기본은 이 파일 옆이지만, WMUX_ESCTEST_REPORT로 오버라이드
// 가능(번들 실행·CI 위치 커스터마이즈 — 어댑터의 WMUX_ESCTEST_VENDOR와 같은 패턴).
const REPORT_PATH = process.env.WMUX_ESCTEST_REPORT
  ? path.resolve(process.env.WMUX_ESCTEST_REPORT)
  : path.join(__dirname, 'report.json');

async function main(): Promise<void> {
  if (!esctestVendorPresent()) {
    console.error(
      `[gen-report] vendor 부재: ${ESCTEST_ENTRY}\n` +
        `준비: bash core/harness/esctest/fetch-esctest.sh`,
    );
    process.exit(2);
  }
  const includes = process.env.INCLUDES
    ? process.env.INCLUDES.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_INCLUDES;

  const results: EsctestCaseResult[] = [];
  for (const inc of includes) {
    process.stdout.write(`[gen-report] running include=${inc} ... `);
    try {
      const r = await runEsctestCase({
        include: inc,
        timeoutSec: 3,
        maxVtLevel: 5,
        hardTimeoutMs: 45000,
      });
      // zero-match 가드(리뷰 반영): 앵커 오타·클래스명 변경이 "케이스 0건=조용한 분모 축소"로
      // 숨지 않게 한다 — 0건 매칭은 합성 error 결과로 기록.
      if (r.cases.length === 0) {
        results.push({ ...r, cases: [{ name: `${inc} (zero-match)`, status: 'error' }], errorCount: 1, reconciled: false });
        console.log('ZERO-MATCH (recorded as error)');
        continue;
      }
      results.push(r);
      console.log(
        `pass=${r.passCount} fail=${r.failCount} err=${r.errorCount} ` +
          `known=${r.knownBugCount} skip=${r.skippedCount} ` +
          `decrqcra=${r.decrqcraBridgeUses} winops=${r.winopsBridgeUses}` +
          (r.reconciled ? '' : ' [UNRECONCILED]') +
          (r.timedOut ? ' [TIMED OUT]' : ''),
      );
    } catch (e) {
      // 예외도 리포트에 남긴다(리뷰 반영 — 콘솔에만 찍고 totals에서 소실되는 구멍 차단).
      console.log(`THREW: ${String(e)}`);
      results.push({
        include: inc,
        exitCode: -1,
        timedOut: false,
        cases: [{ name: `${inc} (spawn/run threw)`, status: 'error' }],
        passCount: 0,
        failCount: 0,
        errorCount: 1,
        knownBugCount: 0,
        skippedCount: 0,
        decrqcraBridgeUses: 0,
        winopsBridgeUses: 0,
        esctestSummary: null,
        reconciled: false,
      });
    }
  }

  // 개수 정합(리뷰 반영): include마다 결과 1개가 반드시 존재해야 한다 — 아니면 리포트 자체가 실패.
  if (results.length !== includes.length) {
    console.error(`[gen-report] FATAL: results(${results.length}) != includes(${includes.length})`);
    process.exit(1);
  }

  const report = buildReport(results);
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n[gen-report] wrote ${REPORT_PATH}`);
  console.log(`[gen-report] totals: ${JSON.stringify(report.totals)}`);
  // 비정상 신호는 종료 코드로도 노출(리뷰 반영 — 그린 위장 차단).
  const t = report.totals;
  if (t.unreconciledRuns > 0 || t.timedOutRuns > 0 || t.nonzeroExitRuns > 0) {
    console.error('[gen-report] WARNING: abnormal runs present (see totals) — exit 3');
    process.exit(3);
  }
}

main().catch((e) => {
  console.error('[gen-report] fatal:', e);
  process.exit(1);
});
