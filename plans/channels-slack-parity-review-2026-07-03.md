# 채널 기능 고찰 — "진짜 Slack UX"까지의 거리 (2026-07-03)

> 배경: 라이브 도그푸딩에서 3가지 증상 발견 — (1) 메시지가 에이전트에게 안 감,
> (2) 같은 워크스페이스 에이전트 태깅 불가, (3) 멤버 목록에 죽은 워크스페이스 잔존.
> (1)의 주범은 배포 격차(설치본 3.12.0에 채널 v2 미탑재)였으나, (2)(3)은 설계 문제.
> 이 문서는 코드 수정 없이 설계 방향만 정리한다.

## 1. 현재 모델 (as-built)

| 축 | 현재 구현 | 근거 |
|---|---|---|
| 주소 단위 | 채널 멤버 = `(workspaceId, memberId)` 행 | `shared/channels.ts` `ChannelMember` |
| 휴먼 멤버십 | UI 멤버 추가 = 전부 `memberId: "local-ui"` (human-view 행) | `channelsSlice.ts:450` |
| 에이전트 멤버십 | 에이전트가 스스로 `channel_join` 해야 생김 — UI가 대신 안 해줌 | `mcp/channels.ts:213` |
| 발신자 신원 | 메시지에 `workspaceId + memberId`만 기록. **sender paneId 없음** | `ChannelMessage` 스키마 |
| 전달 정본 | pull: `lastReadSeq` 커서 + `channel_unread` → `channel_read` → `channel_ack` | `ChannelMember.lastReadSeq` |
| 전달 가속기 | ① wake worker PTY 넛지 (detached/generic 판) ② renderer 멘션→a2a task (attached claude 판) | `channelWakeWorker.ts`, `channelMentionInbox.ts` |
| 멘션 대상 | 다른 멤버 워크스페이스의 live agent 판만. 자기 워크스페이스 제외 | `Composer.tsx:110` |
| same-ws 라우팅 | 전면 차단 — "sender paneId가 없어 self-loop과 sibling을 구별 불가" (follow-up으로 명시) | `channelMentionInbox.ts:105-108` |

## 2. Slack 모델과의 구조적 차이

Slack의 3가지 불변식:

1. **Principal = 사람/봇.** 채널에 보이는 모든 멤버가 곧 수신 가능한 주체다.
2. **멤버십 = 구독.** 채널에 있으면 모든 메시지가 그 사람의 unread에 쌓인다.
3. **멘션 = 우선순위.** 멤버십과 독립. 채널에 있는 누구든 @가능(자기 자신 포함).

wmux 채널의 현재 상태를 여기에 대면:

| Slack 불변식 | wmux 현재 | 갭 |
|---|---|---|
| Principal = 사람/봇 | 휴먼은 `local-ui`(워크스페이스별로 흩어짐), 에이전트 판은 멘션 **대상**일 뿐 멤버가 아님 | **G1: Principal 부재** |
| 멤버십 = 구독 | UI 멤버 추가는 human-view 행. 에이전트 수신과 무관 | **G2: 멤버십≠구독** |
| 누구든 @가능 | 자기 워크스페이스 판은 후보 제외 + 라우팅 차단 | **G3: same-ws 태깅 불가** |

사용자가 겪은 혼란은 전부 이 3개 갭의 표출이다:
- "멤버로 넣었는데 왜 안 들려?" → G2
- "test에 너 들어있는데 태깅도 안 됨" → G1+G3 (들어있는 건 워크스페이스의 local-ui 행이지 에이전트가 아니고, 같은 워크스페이스라 후보에서도 빠짐)
- "멤버가 이상해" → G1 (local-ui 행 + 죽은 워크스페이스 잔존, 삭제 시 정리 없음)

## 3. G3의 기술적 근원 — 왜 same-ws가 막혔나

차단은 임의가 아니라 **발신자 pane 신원 부재**의 보수적 귀결이다:

- `ChannelMessage`는 발신자를 `(workspaceId, memberId)`로만 기록한다.
- 같은 워크스페이스 안에서 판1의 에이전트가 판2를 멘션한 경우와,
  판1이 실수로 자기 자신을 멘션한 경우(무한 루프 위험)를 수신 측에서 구별할 수 없다.
- 그래서 `channelMentionInbox.ts:108`은 "same-ws post는 절대 self-route 안 함"으로
  전면 차단했고, 코드 주석에 follow-up으로 명시돼 있다.

즉 **senderPaneId 한 필드가 없어서 기능 전체가 막힌 것**이다.

## 4. 방안 — 단계적 Slack-parity

### P1. 발신자 pane 신원 기록 + same-ws 멘션 개방 (최소 변경, 최대 효과)

- `ChannelMessage`에 `senderPaneId`(+`senderPtyId`) **additive 필드** 추가
  (스키마 v1 유지 — `mentions`, `lastReadSeq`와 같은 방식의 하위호환 확장).
- `Composer.tsx:110`의 제외 규칙을 "자기 **워크스페이스** 제외" → "자기 **판** 제외"로 좁힘.
  → 같은 워크스페이스의 다른 에이전트 판이 @후보에 뜬다.
- `channelMentionInbox.ts:108`의 차단을 "mention.paneId === message.senderPaneId일 때만 skip"으로 교체.
  → 진짜 self-loop만 막고 sibling 전달은 허용.
- 외부 에이전트의 MCP `channel_post` 멘션도 같은 규칙으로 통과 — "외부 에이전트가 태깅해도
  전달"이 자동으로 충족된다.

### P2. 에이전트 판을 1급 멤버로 (멤버십 = 구독)

- UI에서 워크스페이스를 채널에 추가할 때, 그 안의 **live agent 판들을 개별 멤버로 함께 조인**
  (memberId = 판 auto name, 예: `w8-1(claude)` — 멘션 토큰과 동일 체계라 로스터와 @후보가 일치).
- 로스터 UI: human 1명("나") + agent N개로 표시. `local-ui` 노출 금지.
- 수명주기 정리: 워크스페이스/판 삭제 시 채널 멤버십 자동 제거 훅.
  (현재는 7일 empty-channel reaper만 있고 멤버 행 정리는 없음 — "죽은 멤버" 문제의 원인.)
- 효과: 멤버 목록이 Slack처럼 "실제로 들을 수 있는 참여자 명단"이 된다.

### P3. 어텐션 모델 정렬 — Slack과 같아야 할 것 / 달라야 할 것

**같게 (UX 표면):**
- 멘션 = 인터럽트: 즉시 깨움(현행 wake/a2a task 경로).
- 일반 메시지 = unread 배지: 에이전트 커서에 쌓이고 다음 idle/폴링 때 소비.
- 드롭다운 후보 매칭 시 직접 타이핑한 @토큰도 멘션으로 자동 승격, 매칭 실패·비멤버는
  `droppedMentions` 토스트로 즉시 피드백 (현재는 조용히 텍스트로 사라짐 — 이번에 겪은 것).

**다르게 유지 (경제성 — Slack에는 없는 제약):**
- **에이전트는 읽는 데 토큰을 낸다.** 모든 메시지를 모든 에이전트에 push하면 채팅 한 줄마다
  N개 에이전트의 컨텍스트가 타고, 에이전트끼리 상호 멘션 루프 스톰이 난다
  (이미 `MENTION_NUDGE_CAP`=3회+백오프로 방어 중인 실전 문제).
- 따라서 "pull이 정본, 멘션만 인터럽트"는 유지해야 한다. Slack의 **UI/UX를 복제**하되
  **전달 비용 모델은 에이전트 현실에 맞게** — 이것이 이 설계의 올바른 차별점이다.

### P4. 신원 표기 정리 (신뢰 표면)

- `deliveryStatus: pending` 영구 노출 대신 Slack식 "읽음 n/m" 표시
  (ack 기반 — v2에 이미 substrate 존재).
- 발신자 표시 `local-ui` → 사용자 표시명.

## 5. 리스크 / 지켜야 할 경계

| 리스크 | 대응 |
|---|---|
| 같은 머신 에이전트 신원 위조 (#113) | kick/archive는 humans-only 유지. same-ws 멘션 라우팅은 수신 renderer(신뢰 경계 안)에서 수행되므로 P1이 이 경계를 깨지 않음 |
| 에이전트↔에이전트 멘션 무한 루프 | 기존 nudge cap + 백오프를 same-ws 경로에도 동일 적용. self-pane 멘션은 P1 규칙으로 원천 차단 |
| 토큰 비용 폭발 | P2의 "멤버십=구독"은 **unread 가시성까지만**. 본문 자동 주입 금지 유지 |
| 스키마 하위호환 | senderPaneId는 additive optional — 구 메시지는 same-ws 라우팅만 계속 차단되는 안전한 퇴화 |

## 6. 권장 순서

P1(발신자 pane 신원 + same-ws 개방)이 지렛대다 — 필드 하나 추가로 사용자가 요구한
"같은 워크스페이스 태깅"과 "외부 에이전트 태깅"이 모두 열린다. P2(1급 멤버 + 수명주기
정리)가 멘탈모델을 Slack에 맞추고, P3~P4는 표면 다듬기.

전제: 어떤 방안이든 **설치본이 채널 v2를 탑재해야 관측 가능** — 3.12.1 배포가 선행 조건.
