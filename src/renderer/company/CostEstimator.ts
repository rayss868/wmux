/**
 * CostEstimator — PTY 출력 기반 에이전트 실행 비용 추정기
 *
 * Anthropic API 요금 기준 (2026.03):
 *   Claude Opus 4.6:  $15/M input tokens,  $75/M output tokens
 *
 * 추정 방식:
 *   - PTY 출력 1 char ≈ 1 output token (보수적 추정)
 *   - 활성 시간(분) × 분당 고정 비용 (하이브리드 모델)
 *
 * 정확도: ±50% 수준 (상대적 비교 용도)
 */

// Claude Opus 4.6 output: $75 / 1_000_000 tokens
const COST_PER_OUTPUT_TOKEN = 75 / 1_000_000;

// 1 char ≈ 1 token (단순 추정, ANSI 시퀀스 포함이므로 실제보다 약간 높음)
const CHARS_PER_TOKEN = 1;

// 활성 에이전트 분당 추정 비용 ($0.02/min)
const COST_PER_MINUTE_ACTIVE = 0.02;

export class CostEstimator {
  private memberCosts = new Map<string, number>();

  // ─── PTY 출력 글자 수 기반 비용 누적 ─────────────────────────────────────

  addOutputChars(memberId: string, charCount: number): void {
    const tokens = charCount / CHARS_PER_TOKEN;
    const cost = tokens * COST_PER_OUTPUT_TOKEN;
    this.memberCosts.set(
      memberId,
      (this.memberCosts.get(memberId) ?? 0) + cost,
    );
  }

  // ─── 활성 시간(분) 기반 비용 누적 ────────────────────────────────────────

  addActiveMinutes(memberId: string, minutes: number): void {
    const cost = minutes * COST_PER_MINUTE_ACTIVE;
    this.memberCosts.set(
      memberId,
      (this.memberCosts.get(memberId) ?? 0) + cost,
    );
  }

  // ─── 조회 ─────────────────────────────────────────────────────────────────

  getMemberCost(memberId: string): number {
    return this.memberCosts.get(memberId) ?? 0;
  }

  getTotalCost(): number {
    let total = 0;
    for (const cost of this.memberCosts.values()) {
      total += cost;
    }
    return total;
  }

  getDepartmentCost(memberIds: string[]): number {
    return memberIds.reduce((sum, id) => sum + this.getMemberCost(id), 0);
  }

  // ─── 리셋 ─────────────────────────────────────────────────────────────────

  reset(): void {
    this.memberCosts.clear();
  }

  resetMember(memberId: string): void {
    this.memberCosts.delete(memberId);
  }

  // ─── 스냅샷 (직렬화) ──────────────────────────────────────────────────────

  toRecord(): Record<string, number> {
    return Object.fromEntries(this.memberCosts.entries());
  }

  loadRecord(record: Record<string, number>): void {
    this.memberCosts.clear();
    for (const [id, cost] of Object.entries(record)) {
      this.memberCosts.set(id, cost);
    }
  }
}

// 앱 전역 싱글턴
export const globalCostEstimator = new CostEstimator();
