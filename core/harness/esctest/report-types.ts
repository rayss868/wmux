// E0 하니스 M3 — esctest 리포트 스키마 (스펙: engine-core-decision-2026-07-09.md §5-3)
//
// report.json의 정본 타입. 케이스별 판정 + DECRQCRA 브리지 사용 범위를 담는다.
// 리뷰 반영(2026-07-09): 상태 분리(known-bug/skipped를 pass에서 분리), rawLogTail 제거
// (GPL 유래 로그 텍스트를 커밋 산출물에서 배제 — 집계·요약 수치만), esctest 자체 요약
// 라인과의 교차 대조 필드(reconciled), 비정상 실행(timeout·nonzero exit) 가시화.

/** DECRQCRA 브리지가 응답한 1건의 기록(§5-3: 브리지 사용 사실을 리포트에 남긴다). */
export interface DecrqcraBridgeUse {
  readonly pid: number;
  readonly rect: { readonly top: number; readonly left: number; readonly bottom: number; readonly right: number };
  readonly checksum: number;
}

/**
 * 한 케이스(테스트 메서드)의 판정(리뷰 반영 — 상태 분리):
 * pass=순수 통과 / known-bug=esctest가 예상한 실패("Fails as expected" — esctest 관점 정상이나
 * 순도 감사를 위해 분리) / skipped=능력 부재 skip(검증 안 됨 — pass 합산 금지).
 */
export interface EsctestCase {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'error' | 'known-bug' | 'skipped';
}

/** include 1개(파일 1개) 실행 결과. */
export interface EsctestCaseResult {
  readonly include: string;
  readonly exitCode: number;
  readonly signal?: number;
  readonly timedOut: boolean;
  readonly cases: EsctestCase[];
  readonly passCount: number;
  readonly failCount: number;
  readonly errorCount: number;
  /** known-bug(예상 실패)·능력 부재 skip — pass와 분리 집계(리뷰 반영). */
  readonly knownBugCount: number;
  readonly skippedCount: number;
  /** 이 실행에서 DECRQCRA 브리지가 응답한 횟수(xterm.js 미구현 보전 경로 사용량). */
  readonly decrqcraBridgeUses: number;
  /**
   * WINOPS 크기 리포트 브리지 응답 횟수(CSI 18 t / CSI 19 t). 결정 문서 §5-3이 포착하지
   * 못한 경로 — xterm.js는 WINOPS에 침묵하므로 어댑터 geometry 브리지가 필요하다(스파이크 실측).
   */
  readonly winopsBridgeUses: number;
  /**
   * esctest 자체 요약 라인("*** N tests passed, M known bugs, K tests failed ***")의 수치 —
   * 파서 집계와 교차 대조하는 독립 기준(리뷰 반영). 미발견 시 null(비정상 종료 신호).
   */
  readonly esctestSummary: {
    readonly passed: number;
    readonly knownBugs: number;
    readonly failed: number;
  } | null;
  /**
   * 파서 집계와 esctest 요약의 일치 여부(리뷰 반영 — 오분류·분모 축소 탐지).
   * 대조식: pass+skipped == passed(esctest는 skip을 passed에 셈) · knownBug == knownBugs ·
   * fail == failed. 요약 부재·timeout·nonzero exit면 false.
   */
  readonly reconciled: boolean;
}

/** report.json 전체. */
export interface EsctestReport {
  readonly subject: string;
  readonly generatedAt: string;
  /** vendor 커밋 핀(재현성). */
  readonly esctestPin: string;
  readonly results: EsctestCaseResult[];
  readonly totals: {
    readonly pass: number;
    readonly fail: number;
    readonly error: number;
    /** 리뷰 반영 — pass 순도 감사 분리 집계 + 비정상 실행 가시화. */
    readonly knownBug: number;
    readonly skipped: number;
    readonly timedOutRuns: number;
    readonly nonzeroExitRuns: number;
    readonly unreconciledRuns: number;
    readonly decrqcraBridgeUses: number;
    readonly winopsBridgeUses: number;
  };
}
