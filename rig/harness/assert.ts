// 검증 리그 — 상태 어서션 헬퍼 (설계 §5)
//
// 각 헬퍼는 데몬 정본(파이프 RPC 결과)에 대해 계약을 어서트한다. §5 규율: **각 헬퍼
// 주석에 정본 코드 좌표를 명기**한다 — 계약이 이동하면(예: seq 규칙·unread 산식이 바뀌면)
// 리그가 함께 깨져 갱신을 강제하는 것이 의도. 어서션이 존재하지 않는 계약을 검사하면
// 정상 동작을 fail로 찍으므로(footgun), 좌표가 곧 계약의 출처 표기다.
//
// 실패는 throw(Error). vitest가 잡아 시나리오를 red로 만든다.

/** 데몬이 반환하는 메시지 행의 최소 형태(어서션이 읽는 필드만). */
export interface RigChannelMessage {
  /** 정본: `src/shared/channels.ts:141` — 모노토닉 per-channel 시퀀스(KTD2). */
  seq: number;
  /** 정본: `src/shared/channels.ts:142` — 발신 workspace. */
  workspaceId: string;
  text: string;
}

/** 데몬이 반환하는 unread 엔트리의 최소 형태. */
export interface RigUnreadEntry {
  /** 정본: `ChannelService.unreadFor` 반환형 `src/daemon/channels/ChannelService.ts:2304-2317`. */
  channelId: string;
  memberId: string;
  lastReadSeq: number;
  headSeq: number;
  unread: number;
  mentionUnread: number;
}

/**
 * seq 무결성 어서션 — getMessages 전수 결과가 (a) 정확히 기대 개수 (b) seq 연속(gap 0)
 * (c) 무중복 (d) 기대 시작 seq부터임을 검사한다.
 *
 * 정본 계약:
 *   - seq는 모노토닉 per-channel, post마다 1씩 증가: 첫 채널의 create 직후 nextSeq=1
 *     (`ChannelService.create` → `channel.nextSeq: 1`, 스모크 실증), post가 nextSeq를
 *     소비하고 증가시킨다 → 무유실이면 [expectedFromSeq .. expectedFromSeq+N-1] 연속.
 *   - getMessages는 seq >= floor 필터 후 순서대로 반환(`ChannelService.getMessages`
 *     `src/daemon/channels/ChannelService.ts:625` filter, public 채널은 floor=0).
 *   - post 커밋 계약: RPC ok 반환 = fsync 커밋 후(envelope PR3) → ok받은 전 메시지가
 *     반드시 getMessages에 나타나야 한다(무유실).
 *
 * @param messages       getMessages 전수 결과.
 * @param expectedCount  기대 메시지 수(연사한 총 post 수).
 * @param expectedFromSeq 기대 시작 seq(첫 post의 seq — 보통 1).
 */
export function assertChannelSeq(
  messages: RigChannelMessage[],
  expectedCount: number,
  expectedFromSeq: number,
): void {
  if (messages.length !== expectedCount) {
    throw new Error(
      `assertChannelSeq: expected ${expectedCount} messages, got ${messages.length} ` +
        `(seqs=[${messages.map((m) => m.seq).join(',')}]) — 유실 또는 중복 의심`,
    );
  }
  const seen = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const seq = messages[i].seq;
    if (seen.has(seq)) {
      throw new Error(`assertChannelSeq: duplicate seq ${seq} at index ${i} (무중복 위반)`);
    }
    seen.add(seq);
    const expectedSeq = expectedFromSeq + i;
    if (seq !== expectedSeq) {
      throw new Error(
        `assertChannelSeq: non-contiguous seq at index ${i}: expected ${expectedSeq}, got ${seq} ` +
          `(seqs=[${messages.map((m) => m.seq).join(',')}]) — gap 또는 순서 위반`,
      );
    }
  }
}

/**
 * 텍스트 전수 대조 어서션 — 보낸 본문 멀티셋이 받은 본문 멀티셋과 정확히 일치하는지
 * (seq 순서 무관, 내용 무유실·무중복) 검사한다. flood 페르소나가 결정적 본문을 연사할 때
 * "전 도달"을 seq뿐 아니라 내용으로도 못박는다.
 *
 * 정본: 메시지 본문은 `ChannelMessage.text`(`src/shared/channels.ts:146`)에 verbatim 보존.
 */
export function assertTextsDelivered(messages: RigChannelMessage[], expectedTexts: string[]): void {
  const got = messages.map((m) => m.text).slice().sort();
  const want = expectedTexts.slice().sort();
  if (got.length !== want.length) {
    throw new Error(
      `assertTextsDelivered: expected ${want.length} texts, got ${got.length}`,
    );
  }
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i]) {
      throw new Error(
        `assertTextsDelivered: text multiset mismatch at sorted index ${i}: ` +
          `want=${JSON.stringify(want[i])} got=${JSON.stringify(got[i])} — 본문 유실/변형`,
      );
    }
  }
}

/**
 * unread 어서션 — 특정 (채널, 멤버)의 unread/headSeq/lastReadSeq를 확인한다.
 *
 * 정본 계약(`ChannelService.unreadFor` `src/daemon/channels/ChannelService.ts:2304-2343`):
 *   - headSeq = channel.nextSeq - 1 (마지막 커밋된 seq).
 *   - unread = cursor(lastReadSeq) 초과 & historyFromSeq 이상인 메시지 수.
 *   - 아직 ack 안 한 멤버는 자신이 본 적 없는 메시지를 unread로 센다(단, 자기 발신 포함
 *     여부는 산식이 seq만 보므로 자기 것도 포함될 수 있다 — 호출자가 expected를 그에 맞춰
 *     계산해야 한다).
 *
 * @param entries   unread RPC의 entries 전수.
 * @param channelId 대상 채널.
 * @param memberId  대상 멤버(보통 workspaceId와 동일하게 배정).
 * @param expect    기대값(부분 — 준 필드만 검사).
 */
export function assertUnread(
  entries: RigUnreadEntry[],
  channelId: string,
  memberId: string,
  expect: { unread?: number; headSeq?: number; lastReadSeq?: number; mentionUnread?: number },
): void {
  const row = entries.find((e) => e.channelId === channelId && e.memberId === memberId);
  if (!row) {
    throw new Error(
      `assertUnread: no unread entry for (channel=${channelId}, member=${memberId}) ` +
        `— entries=${JSON.stringify(entries)}`,
    );
  }
  for (const key of ['unread', 'headSeq', 'lastReadSeq', 'mentionUnread'] as const) {
    const want = expect[key];
    if (want !== undefined && row[key] !== want) {
      throw new Error(
        `assertUnread: (channel=${channelId}, member=${memberId}) ${key} expected ${want}, got ${row[key]} ` +
          `— row=${JSON.stringify(row)}`,
      );
    }
  }
}
