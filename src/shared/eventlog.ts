/**
 * 공통 이벤트 Envelope — append-only 로그의 레코드 스키마 (envelope-design §1).
 *
 * ┌── PROTOCOL 파일: additive-only 규약 ──────────────────────────────┐
 * │ 이 파일은 디스크에 영속되는 로그 레코드의 계약이다. 크래시 후 부트가       │
 * │ 이 스키마로 과거 레코드를 재파싱하므로:                                  │
 * │   - 필드를 제거·개명·의미변경하지 마라(과거 레코드 파싱 붕괴).           │
 * │   - 새 필드는 반드시 옵셔널(`?:`)로만 추가하라(구 레코드엔 부재).        │
 * │   - domain enum·TrustTier 값은 추가만 허용, 기존 값 재사용 금지.        │
 * │ (§8 origin.keyId, §6.F evidence 등 미래 확장은 전부 옵셔널 additive.)  │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 스코프 경계: payload는 도메인 소유의 opaque 값이다. 로그 계층은 절대
 * 해석하지 않는다(§1 필드표). 채널/A2A 전이 payload·완료증거(evidence)
 * 스키마는 PR5 소관 — 여기서 만들지 않는다.
 */

import { randomUUID } from 'node:crypto';

/**
 * 이벤트 도메인 (§1). 로그는 도메인 무지 — 스코프 밖 값도 미해석 통과.
 * Q1 재배선 대상은 'channel'·'a2a'뿐이고 나머지는 미래 소비자용 예약 슬롯.
 * (additive-only: 값 추가만, 기존 값 재사용·제거 금지.)
 */
export type EventDomain =
  | 'channel'
  | 'a2a'
  | 'task'
  | 'approval'
  | 'recording'
  | 'asp';

/**
 * 신뢰 등급 (§7, §6.K 4등급과 1:1). principalId/trustTier는 라우팅·표시·
 * 감사용이며 authz가 아니다 — 권한 판정 앵커는 verifiedWorkspaceId다.
 * (additive-only.)
 */
export type TrustTier = 'trusted' | 'semi-trusted' | 'heuristic' | 'untrusted';

/**
 * 레코드 출처 (§1, §8). `(machineId, seq)`가 부트 경계를 넘어 전역 유일.
 * daemonEpoch는 순서 비관여 provenance 스탬프(§8 D8).
 */
export interface EventOrigin {
  /** §8: 설치 생애 영구 불변 UUID(교체 금지 — Q4에도 keyId로 분리). */
  machineId: string;
  /** §8 D8: = CHANNELS_EPOCH. 스키마 세대 출처표기 전용, 순서 비관여. */
  daemonEpoch: number;
  /** §8 D7: 이 머신 로그의 append 인덱스(영속 단조·비리셋). append가 발급. */
  seq: number;
  // keyId?: string  // §8: Q4 additive 예약 — 페어링 키 지문(machineId 대체 아님)
}

/** 신뢰 컨텍스트 (§7). 데몬 경계에서 스탬프. */
export interface AuthContext {
  /** §7: display/routing 스탬프(authz 아님). 데몬이 서버측에서 결정. */
  principalId: string;
  /** §7: 서버 핀(authz 앵커, 위조 불가). */
  verifiedWorkspaceId: string;
  /** §7, §6.K. */
  trustTier: TrustTier;
}

/**
 * 로그 레코드 1건 (§1). 한 줄(NDJSON) = 한 EventEnvelope.
 *
 * 순서 정본은 `lamport`(데몬 전역 논리시계)이고, `wallClock`은 표시/감사
 * 전용으로 순서에 절대 관여하지 않는다(§1 D10).
 */
export interface EventEnvelope {
  /** §1 D9: randomUUID() v4. 레코드 정체성(≠ idempotencyKey). */
  eventId: string;
  origin: EventOrigin;
  /** §1 D6: 데몬 전역 논리시계, 표시 순서의 정본. append가 발급(pre-increment). */
  lamport: number;
  /** §1 D10: Date.now() @ append. 표시·감사 전용, 순서 비관여. */
  wallClock: number;
  /** §4: 업무 멱등키(있을 때만). at-least-once 승격의 재시도 흡수 앵커(§2.6). */
  idempotencyKey?: string;
  /** §1: 직접 원인 이벤트의 eventId[]. Q1 비게이팅 provenance. */
  causalRefs?: string[];
  authContext: AuthContext;
  domain: EventDomain;
  /** 도메인 소유 opaque. 로그 계층은 미해석(레이어 경계, §1 필드표). */
  payload: unknown;
}

/**
 * makeEnvelope 산출물 — 순서 필드(lamport, origin.seq)는 제외된 초안.
 *
 * lamport와 origin.seq는 AppendOnlyLog.append가 자신의 임계구역에서
 * hwm 기반으로 발급한다(§3). 서비스는 나머지 필드만 채워 draft를 만들고
 * append에 넘긴다 — 발급 주체가 로그 단독임을 타입으로 강제한다.
 */
export type EventEnvelopeDraft = Omit<EventEnvelope, 'lamport' | 'origin'> & {
  origin: Omit<EventOrigin, 'seq'>;
};

/** makeEnvelope 입력. eventId·wallClock은 팩토리가 발급한다. */
export interface MakeEnvelopeInput {
  domain: EventDomain;
  payload: unknown;
  /** machineId·daemonEpoch. seq는 append가 발급하므로 여기 없음. */
  origin: Omit<EventOrigin, 'seq'>;
  authContext: AuthContext;
  idempotencyKey?: string;
  causalRefs?: string[];
}

/**
 * envelope 초안 팩토리 (§1, §5). eventId(randomUUID)·wallClock(Date.now)을
 * 확정하고, 순서 필드는 append가 채우도록 비운다.
 */
export function makeEnvelope(input: MakeEnvelopeInput): EventEnvelopeDraft {
  const draft: EventEnvelopeDraft = {
    eventId: randomUUID(),
    origin: {
      machineId: input.origin.machineId,
      daemonEpoch: input.origin.daemonEpoch,
    },
    wallClock: Date.now(),
    authContext: {
      principalId: input.authContext.principalId,
      verifiedWorkspaceId: input.authContext.verifiedWorkspaceId,
      trustTier: input.authContext.trustTier,
    },
    domain: input.domain,
    payload: input.payload,
  };
  // 옵셔널은 값이 있을 때만 실어 로그 줄을 깨끗하게 유지(additive 관례).
  if (input.idempotencyKey !== undefined) {
    draft.idempotencyKey = input.idempotencyKey;
  }
  if (input.causalRefs !== undefined) {
    draft.causalRefs = input.causalRefs;
  }
  return draft;
}
