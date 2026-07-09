// E0 하니스 M3 — esctest 리포트 스키마 (스펙: engine-core-decision-2026-07-09.md §5-3)
//
// report.json의 정본 타입. 케이스별 pass/fail/error + DECRQCRA 브리지 사용 범위를 담는다.

/** DECRQCRA 브리지가 응답한 1건의 기록(§5-3: 브리지 사용 사실을 리포트에 남긴다). */
export interface DecrqcraBridgeUse {
  readonly pid: number;
  readonly rect: { readonly top: number; readonly left: number; readonly bottom: number; readonly right: number };
  readonly checksum: number;
}

/** 한 케이스(테스트 메서드)의 판정. */
export interface EsctestCase {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'error';
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
  /** 이 실행에서 DECRQCRA 브리지가 응답한 횟수(xterm.js 미구현 보전 경로 사용량). */
  readonly decrqcraBridgeUses: number;
  /**
   * WINOPS 크기 리포트 브리지 응답 횟수(CSI 18 t / CSI 19 t). 결정 문서 §5-3이 포착하지
   * 못한 경로 — xterm.js는 WINOPS에 침묵하므로 어댑터 geometry 브리지가 필요하다(스파이크 실측).
   */
  readonly winopsBridgeUses: number;
  /** 디버깅용 stdout 로그 꼬리(과대 방지 절단). */
  readonly rawLogTail: string;
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
    readonly decrqcraBridgeUses: number;
    readonly winopsBridgeUses: number;
  };
}
