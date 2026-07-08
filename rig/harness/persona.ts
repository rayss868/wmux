// 검증 리그 — 페르소나 프레임워크 (설계 §4 / G7)
//
// 시드 주입 페르소나 러너. S1이 인라인으로 하던 (신원 배정 → join → 행동 스크립트 →
// 기록)을 S2~S8이 재사용하는 **최소** 프레임으로 승격한다. 과추상화 금지(CLAUDE.md
// "한 번만 쓸 코드에 추상화 금지"): 6종 페르소나가 실제로 공유하는 것만 담는다 —
//   (1) 페르소나 = { ws, client(PipeClient) } — G6 정직-main 바인딩(신원 1개, 그 값만
//       스탬프). 예약 신원은 PipeClient 생성자가 이미 거부하므로 여기서 재검증 안 함.
//   (2) 채널 생성/전원 join 오케스트레이션(모든 시나리오의 공통 서막).
//   (3) 시드 결정성 배선(SeededRng를 페르소나 스크립트에 넘김).
//   (4) teardown 편의(모든 client.close()).
//
// **행동 스크립트는 각 시나리오가 소유한다** — flood 연사·ping-pong 왕복·dead 소멸·
// hung 무응답·no-ack 수신·boundary 캡경계는 서로 완전히 다른 로직이라, 여기서
// "행동 타입"을 열거하면 그게 곧 과추상화다. 프레임은 신원·채널·시드·수명만 관리하고,
// 스크립트는 `PersonaRunner`가 넘겨주는 (persona, rng)를 받아 시나리오 파일에서 돈다.
//
// 이 프레임이 하지 않는 것(정직 선언): RigSession(실 PTY)·nudge 어서션은 v1 SIM
// 스코프 밖(설계 §4 — S2·S4 재정의). 그래서 persona에 PTY 훅을 넣지 않는다.

import { PipeClient, type PipeClientOptions } from './pipe';
import { SeededRng } from './seed';
import type { RigContext } from './isolation';

/** 한 페르소나 = G6 바인딩된 신원 1개 + 그 신원으로만 발신하는 PipeClient 1개. */
export interface Persona {
  /** 이 페르소나의 workspaceId(= memberId로도 재사용 — 페르소나당 단일 좌석). */
  readonly ws: string;
  /** 이 페르소나 신원으로 바인딩된 파이프 클라이언트(channelRpc가 ws만 스탬프). */
  readonly client: PipeClient;
}

export interface PersonaRunnerOptions {
  /** 페르소나 workspaceId 접두(시나리오 식별용). 예: 's2' → ws-rig-s2-p0. */
  readonly idPrefix: string;
  /** 이번 런의 결정적 시드(G7 — 실패 시 시나리오가 인쇄해 재현). */
  readonly seed: number;
  /** PipeClient 옵션(타임아웃 등) — 전 페르소나 공유. */
  readonly clientOpts?: PipeClientOptions;
}

/**
 * 페르소나 러너 — 시나리오의 공통 서막(신원 배정·채널 생성·전원 join)과 시드 결정성을
 * 관리한다. 행동 스크립트는 시나리오가 `forEach`/직접 루프로 소유한다(프레임은 무개입).
 *
 * 전형적 사용(S2~S8):
 *   const runner = new PersonaRunner(ctx, { idPrefix: 's2', seed });
 *   const [a, b] = runner.spawn(2);
 *   const { channelId } = await runner.openChannel('rig-s2', a, [b]);
 *   // ... 시나리오 고유 행동 (runner.rng로 결정적) ...
 *   runner.closeAll();  // afterAll에서
 */
export class PersonaRunner {
  private readonly ctx: RigContext;
  private readonly idPrefix: string;
  private readonly clientOpts?: PipeClientOptions;
  private readonly personas: Persona[] = [];
  /** 시나리오가 결정적 행동에 쓰는 공유 PRNG(G7). */
  readonly rng: SeededRng;

  constructor(ctx: RigContext, opts: PersonaRunnerOptions) {
    this.ctx = ctx;
    this.idPrefix = opts.idPrefix;
    this.clientOpts = opts.clientOpts;
    this.rng = new SeededRng(opts.seed);
  }

  /** 지금까지 스폰된 전 페르소나(읽기 전용 스냅샷). */
  get all(): readonly Persona[] {
    return this.personas;
  }

  /**
   * 페르소나 N개를 만든다(각각 신원 1개 + PipeClient 1개). workspaceId는
   * `ws-rig-{idPrefix}-p{index}` 결정적 이름 — 인덱스는 누적(여러 번 spawn해도 충돌
   * 없음). 반환 배열 순서 == 생성 순서.
   */
  spawn(count: number): Persona[] {
    const created: Persona[] = [];
    for (let i = 0; i < count; i++) {
      const index = this.personas.length;
      const ws = `ws-rig-${this.idPrefix}-p${index}`;
      const client = new PipeClient(
        this.ctx.daemonPipePath,
        this.ctx.daemonTokenPath,
        ws,
        this.clientOpts ?? {},
      );
      const persona: Persona = { ws, client };
      this.personas.push(persona);
      created.push(persona);
    }
    return created;
  }

  /**
   * 공용 채널을 만들고(creator 자동 seat) 나머지 멤버를 전원 join시킨다. 모든
   * 시나리오의 공통 서막. 각 호출은 자기 신원만 스탬프(G6 — channelRpc가 강제).
   *
   * 정본 계약(`ChannelService.create`): create 직후 `channel.nextSeq === 1`(첫 post의
   * seq는 1). creator는 자동으로 첫 멤버가 된다(`ChannelService.create`가 creator를
   * seat). join은 멱등이 아니므로 creator를 members에 다시 넣지 않는다.
   *
   * @param name     채널 이름(회사 내 유일 — 시나리오별 접두 권장).
   * @param creator  채널 생성 페르소나(자동으로 첫 멤버).
   * @param members  추가로 join시킬 페르소나(creator 제외). 순서대로 join.
   * @returns { channelId, nextSeq } — nextSeq는 create 직후 값(전수 대조 기준선).
   */
  async openChannel(
    name: string,
    creator: Persona,
    members: Persona[] = [],
  ): Promise<{ channelId: string; nextSeq: number }> {
    const created = await creator.client.channelRpc('a2a.channel.create', {
      name,
      visibility: 'public',
      createdBy: { workspaceId: creator.ws, memberId: creator.ws },
    });
    const channel = created['channel'] as { id: string; nextSeq: number } | undefined;
    if (!channel || !channel.id) {
      throw new Error(`[rig/persona] openChannel: create returned no channel (name=${name})`);
    }
    for (const m of members) {
      await m.client.channelRpc('a2a.channel.join', {
        channelId: channel.id,
        member: { workspaceId: m.ws, memberId: m.ws },
      });
    }
    return { channelId: channel.id, nextSeq: channel.nextSeq };
  }

  /** 전 페르소나의 소켓을 닫는다(teardown — afterAll에서 데몬 kill 전에 호출). */
  closeAll(): void {
    for (const p of this.personas) p.client.close();
  }
}
