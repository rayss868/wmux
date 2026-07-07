/**
 * 채널 도메인 이벤트 payload + 부트 replay 적용기 (envelope-design §5, PR3).
 *
 * payload는 "결정된 효과(effect)"를 담는다 — 검증·판정(now()·randomUUID 포함)은
 * 라이브 경로가 이미 끝냈고, replay는 그 결과를 결정론적으로 재적용만 한다.
 * (요청 params를 담아 비즈니스 로직을 재실행하면 now/uuid 비결정성으로 replay가
 * 라이브와 어긋난다 — 효과 기록이 유일한 결정론적 형태다.)
 *
 * ┌── 불변식: 모든 적용기는 멱등이다 ─────────────────────────────────────┐
 * │ (a) at-least-once 계약(§2.6 D17): 승격 레코드·롤백-후-생존 레코드가       │
 * │     replay에 재출현할 수 있다 — 재적용이 무해해야 한다.                   │
 * │ (b) 스냅샷 마커 지연: 스냅샷은 라이브 참조를 write 시점에 직렬화하므로     │
 * │     내용이 마커(snapshotLamport)보다 앞설 수 있다 — 이미 반영된 이벤트의   │
 * │     재적용이 무해해야 마커-이하 보수적 replay가 안전하다.                 │
 * │ 각 적용기는 존재/seq 가드로 이를 보장한다(레코드 정체성 기준).            │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * additive-only: kind 추가만 허용. 기존 kind의 필드 제거·의미변경 금지(디스크 계약).
 * 미지의 kind는 무시(전방 호환 — 미래 데몬이 쓴 레코드를 구 데몬 replay가 통과).
 */

import {
  CHANNEL_IDEMPOTENCY_CAP,
  CHANNEL_MESSAGES_MAX,
  type Channel,
  type ChannelMember,
  type ChannelMessage,
  type ChannelState,
} from '../../shared/channels';

/** 채널 도메인 envelope payload (D16 — 1 커밋 = 1 envelope). */
export type ChannelEventPayload =
  | {
      kind: 'create';
      channel: Channel;
      members: ChannelMember[];
    }
  | {
      kind: 'archive';
      channelId: string;
      archivedAt: number;
      archivedBy: string;
    }
  | {
      kind: 'join';
      channelId: string;
      member: ChannelMember;
    }
  | {
      kind: 'invite';
      channelId: string;
      member: ChannelMember;
    }
  | {
      kind: 'leave';
      channelId: string;
      workspaceId: string;
      memberId: string;
      /** 라이브 경로가 판정한 emptySince 스탬프(마지막 멤버 이탈 시에만 존재). */
      emptySince?: number;
    }
  | {
      kind: 'kick';
      channelId: string;
      targetWorkspaceId: string;
      targetMemberId: string;
      emptySince?: number;
    }
  | {
      kind: 'purge';
      channelId: string;
      workspaceId: string;
      memberId?: string;
      principalId?: string;
      emptySince?: number;
    }
  | {
      kind: 'post';
      channelId: string;
      /** 결정 완료된 메시지 행(seq·clientMsgId·mentions 포함) 전체. */
      message: ChannelMessage;
      /** 발신자 커서 라이드(§5 — 라이브에서 lastReadSeq === seq-1일 때만 기록). */
      cursorRide?: { workspaceId: string; memberId: string };
      /** 1b 이름 리프레시가 이 커밋에 포함됐을 때의 확정값. */
      nameRefresh?: { workspaceId: string; memberId: string; memberName: string };
    }
  | {
      kind: 'ack';
      channelId: string;
      workspaceId: string;
      /** 있으면 커서 전진(멤버-스코프), 없으면 수신확인만(receipt-only). */
      memberId?: string;
      uptoSeq: number;
      /** 라이브 ack의 now() — lastAttemptAt 스탬프의 결정론 재현용. */
      ackedAt: number;
    }
  | {
      /** §6.4c reseed 마커(migrateToEventLog가 append). 상태는 스냅샷이 운반 — replay 무동작. */
      kind: 'legacy-reseed';
      reseedNumber: number;
      stateHash: string;
      detectedAt: number;
    };

/** 멱등 인덱스 compositeKey — ChannelService와 동일 형식(A11 sender-scoped). */
function idemKey(workspaceId: string, clientMsgId: string): string {
  return JSON.stringify([workspaceId, clientMsgId]);
}

/**
 * 부트 replay 적용기(§5). state를 제자리 변형한다. 이벤트 방출 없음(재구성은 무성).
 * 모든 분기가 멱등 — 파일 헤더의 불변식 참조.
 */
export function applyChannelEvent(state: ChannelState, payload: unknown): void {
  if (payload === null || typeof payload !== 'object') return;
  const p = payload as ChannelEventPayload;
  switch (p.kind) {
    case 'create': {
      if (state.channels.some((c) => c.id === p.channel.id)) return; // 멱등
      state.channels.push({ ...p.channel });
      state.members[p.channel.id] = p.members.map((m) => ({ ...m }));
      state.messages[p.channel.id] = [];
      state.idempotency[p.channel.id] = {};
      return;
    }
    case 'archive': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      ch.status = 'archived';
      ch.archivedAt = p.archivedAt;
      ch.archivedBy = p.archivedBy;
      return;
    }
    case 'join':
    case 'invite': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      const members = state.members[p.channelId] ?? [];
      // 멱등: 동일 (workspaceId, memberId) 행이 이미 있으면 재적용 no-op.
      if (
        members.some(
          (m) => m.workspaceId === p.member.workspaceId && m.memberId === p.member.memberId,
        )
      ) {
        return;
      }
      members.push({ ...p.member });
      state.members[p.channelId] = members;
      // 라이브 경로는 join/invite 시 emptySince를 무조건 해제한다.
      delete ch.emptySince;
      return;
    }
    case 'leave':
    case 'kick':
    case 'purge': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      const members = state.members[p.channelId] ?? [];
      const matches = (m: ChannelMember): boolean => {
        if (p.kind === 'leave') {
          return m.workspaceId === p.workspaceId && m.memberId === p.memberId;
        }
        if (p.kind === 'kick') {
          return (
            m.workspaceId === p.targetWorkspaceId && m.memberId === p.targetMemberId
          );
        }
        // purge — 라이브 matcher와 동형(principalId 우선, 그다음 memberId, 없으면 ws 전체).
        return (
          m.workspaceId === p.workspaceId &&
          (p.principalId !== undefined
            ? m.principalId === p.principalId
            : p.memberId === undefined || m.memberId === p.memberId)
        );
      };
      const survivors = members.filter((m) => !matches(m));
      if (survivors.length === members.length) return; // 멱등: 이미 제거됨
      state.members[p.channelId] = survivors;
      if (
        p.emptySince !== undefined &&
        survivors.length === 0 &&
        ch.emptySince === undefined
      ) {
        ch.emptySince = p.emptySince;
      }
      return;
    }
    case 'post': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      const msgs = (state.messages[p.channelId] ??= []);
      const seq = p.message.seq;
      // 멱등: 같은 seq가 이미 있으면(스냅샷 선반영·승격 재출현) 재적용 no-op.
      if (msgs.some((m) => m.seq === seq)) return;
      // trim된 역사 가드(패널 CL-3): seq < nextSeq인데 msgs에 없다 = 히스토리 캡이
      // 이미 절단한 과거 post다. 재적용하면 tail에 붙어 순서가 깨지고, 캡 trim이
      // 진짜 보존분을 앞에서 축출한다. 스냅샷이 그 효과(커서·멱등 포함)를 이미
      // 반영했으므로 전체 no-op.
      if (seq < ch.nextSeq) return;
      msgs.push({ ...p.message });
      // nextSeq 전진(라이브의 nextSeq++와 동치 — replay는 seq+1로 클램프 전진).
      if (ch.nextSeq <= seq) ch.nextSeq = seq + 1;
      // 커서 라이드 — 라이브 조건(lastReadSeq === seq-1) 그대로, 재적용은 no-op.
      if (p.cursorRide) {
        const row = (state.members[p.channelId] ?? []).find(
          (m) =>
            m.workspaceId === p.cursorRide!.workspaceId &&
            m.memberId === p.cursorRide!.memberId,
        );
        if (row && row.lastReadSeq === seq - 1) row.lastReadSeq = seq;
      }
      // 1b 이름 리프레시(확정값 세팅 — 멱등).
      if (p.nameRefresh) {
        const row = (state.members[p.channelId] ?? []).find(
          (m) =>
            m.workspaceId === p.nameRefresh!.workspaceId &&
            m.memberId === p.nameRefresh!.memberId,
        );
        if (row) row.memberName = p.nameRefresh.memberName;
      }
      // 멱등 인덱스(state.idempotency)는 로그의 projection(§4) — post 적용이 재구성.
      if (p.message.clientMsgId) {
        const map = (state.idempotency[p.channelId] ??= {});
        map[idemKey(p.message.workspaceId, p.message.clientMsgId)] = seq;
        // cap 초과 시 삽입순 선입 삭제(부트 hydration의 FIFO 시드와 동형 —
        // 라이브 LRU의 recency 정보는 로그에 없으므로 삽입순이 결정론적 대용).
        const keys = Object.keys(map);
        for (let i = 0; keys.length - i > CHANNEL_IDEMPOTENCY_CAP; i++) {
          delete map[keys[i]];
        }
      }
      // 히스토리 캡 trim(A2) — 라이브가 post-커밋 후 적용하는 것과 동일 규칙이라
      // 별도 trim 이벤트 없이 replay가 수렴한다.
      if (msgs.length > CHANNEL_MESSAGES_MAX) {
        const trimmed = msgs.slice(msgs.length - CHANNEL_MESSAGES_MAX);
        state.messages[p.channelId] = trimmed;
        const minSeq = trimmed.length > 0 ? trimmed[0].seq : 0;
        const map = state.idempotency[p.channelId];
        if (map) {
          for (const [k, v] of Object.entries(map)) {
            if (v < minSeq) delete map[k];
          }
        }
      }
      return;
    }
    case 'ack': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      // 수신확인 플립 — pending → delivered만 건드리므로 재적용 no-op(멱등).
      for (const m of state.messages[p.channelId] ?? []) {
        if (m.seq > p.uptoSeq) continue;
        for (const entry of m.recipientSnapshot ?? []) {
          if (entry.workspaceId === p.workspaceId && entry.status === 'pending') {
            entry.status = 'delivered';
            entry.lastAttemptAt = p.ackedAt;
            if (m.deliveryStatus !== 'delivered') m.deliveryStatus = 'delivered';
          }
        }
      }
      // 커서 전진 — advance-only·head 클램프(라이브와 동일), 역행 불가라 멱등.
      if (p.memberId !== undefined) {
        const cursorTarget = Math.min(p.uptoSeq, ch.nextSeq - 1);
        for (const row of state.members[p.channelId] ?? []) {
          if (row.workspaceId !== p.workspaceId || row.memberId !== p.memberId) continue;
          const current = typeof row.lastReadSeq === 'number' ? row.lastReadSeq : -1;
          if (cursorTarget > current) row.lastReadSeq = cursorTarget;
        }
      }
      return;
    }
    case 'legacy-reseed':
      return; // 상태는 reseed 스냅샷이 운반(§6.4c) — 마커는 감사 전용.
    default:
      return; // 미지 kind — 전방 호환 통과(additive-only).
  }
}
