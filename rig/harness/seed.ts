// 검증 리그 — 결정적 시드 유틸 (설계 §4 / G7)
//
// 페르소나 행동을 결정적으로 만들기 위한 시드 기반 PRNG. G7: 시나리오는 결정적 시드로
// 돌고, 실패 시 시드를 인쇄해 재현한다. S1은 PipeClient 직접 사용으로 충분하지만
// (persona.ts 없이도 됨), S2~S8이 재사용할 시드 유틸은 분리해둘 가치가 있어(설계 §9
// 판단 위임) 여기 둔다. persona.ts 프레임워크는 후속 PR 몫.
//
// mulberry32 — 32비트 상태의 작고 빠른 결정적 PRNG. 암호학적 안전성이 아니라
// 재현성이 목적(같은 시드 = 같은 수열).

/** 시드 하나로 초기화되는 결정적 난수 생성기. */
export class SeededRng {
  private state: number;

  constructor(readonly seed: number) {
    // 0이면 수열이 죽으므로 non-zero로 정규화.
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** [0, 1) 균등 실수. */
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [minInclusive, maxExclusive) 정수. */
  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive));
  }
}

/**
 * 이번 런의 기본 시드를 고른다. `WMUX_RIG_SEED` env가 있으면 그 값(실패 재현용),
 * 없으면 시간 기반 시드를 새로 뽑는다. 어느 쪽이든 테스트가 시드를 인쇄해야 재현 가능.
 */
export function pickSeed(): number {
  const fromEnv = process.env.WMUX_RIG_SEED;
  if (fromEnv && /^\d+$/.test(fromEnv)) {
    return Number(fromEnv) >>> 0;
  }
  return (Date.now() ^ (process.pid << 16)) >>> 0;
}
