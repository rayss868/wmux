# 에이전트 협업 아키텍처 — 통합 설계안 (2026-07-03)

> 선행 문서: `channels-slack-parity-review-2026-07-03.md` (P1~P4 채널 로드맵).
> 이 문서는 그 위에 **행위자 전체**(휴먼 + 내부 에이전트 + 외부 에이전트 + 오케스트레이터)를
> 올려놓고, "무궁무진한 케이스"를 유한한 축으로 접어 최적 협업 모델을 수립한다.
> 코드 수정 없음 — 설계만.
>
> **개정 2026-07-04 (로드맵 확정)**: "wmux Channels PRD v0.1"을 본 문서에 접합.
> 변경: 로드맵 R6(Approval Gate) 추가, Principal 스키마 `reports_to` 예약,
> R5 비고에 모바일 클라이언트 프레임 명시, PRD 전 항목 처분표(§9) 인라인.
> PRD 원문은 파일로 존재하지 않음(2026-07-04 대화 첨부) — §9 처분표가 정본.
> 판정 근거: `~/.gstack/projects/openwong2kim-wmux/wong2kim-main-design-20260704-115727.md`

## 1. 행위자 분류 (Actor Taxonomy)

| # | 행위자 | 실체 | wmux 안에서의 신원 | 깨우는 방법 (reachability) |
|---|---|---|---|---|
| A1 | **휴먼 (사용자)** | GUI renderer | `local-ui` (워크스페이스별로 흩어짐 — 문제) | GUI 배지/알림 |
| A2 | **내부 상주 에이전트** | 판(pane) 안의 CLI 에이전트 — Claude Code, Codex, Hermes, OpenCode… | (workspaceId, 판) — 단 채널 1급 멤버 아님 | attached claude: renderer hook / 그 외: PTY 넛지 (wake worker) |
| A3 | **내부 서브에이전트** | A2가 스폰하는 단명 작업자 (Task tool 등) | 없음 — 부모 판에 흡수 | 부모가 중계 (신원 불필요, 올바른 설계) |
| A4 | **외부 에이전트** | wmux 밖에서 제어 — OpenClaw(다른 머신/클라우드), 원격 Hermes | **없음 — 최대 갭.** LAN peer는 수신전용 inbox만, 원격 MCP 제어 불가 | 폴링만 가능 (판 없음 = PTY 넛지 불가) |
| A5 | **오케스트레이터** | 역할이지 실체가 아님 — A1/A2/A4 누구든 수행 가능 | 수행자의 신원을 따름 | — |

핵심 관찰 2개:
- **A3는 신원이 필요 없다** (부모 판이 대표). 스코프에서 제외 — 이걸 넣으면 폭발한다.
- **A4가 유일한 신규 축**이다. 나머지는 전부 선행 문서의 P1~P4가 커버한다.

## 2. "무궁무진한 케이스"를 4개 축으로 접기

임의의 협업 시나리오는 다음 4축의 조합으로 환원된다:

1. **발신자**: 휴먼 / 내부 판 / 외부
2. **수신자**: 휴먼 / 내부 attached / 내부 detached(headless) / 외부
3. **의도**: 지시(task) / 논의(discuss) / 호출(mention) / 관찰(read)
4. **시급성**: 인터럽트 / 다음 idle / 기록만

기존 프리미티브 매핑 — **의도 축은 이미 완비돼 있다**:

| 의도 | 프리미티브 | 상태 |
|---|---|---|
| 지시 | `a2a_task_send` (durable task + inbox) | ✅ 동작 |
| 논의 | 채널 (pull 정본 + 커서) | ✅ v2 구현, 배포 대기 |
| 호출 | `@멘션` → a2a task 브리지 | ⚠️ same-ws 차단 (P1), 외부 대상 불가 |
| 관찰 | `terminal_read` / `channel_read` / `a2a_task_query` | ✅ 동작 |

**뚫려 있는 곳은 의도가 아니라 수신자×깨우기 축이다.** 수신자 유형마다 깨우는 방법이
다른데, 현재는 그 분기가 wake worker의 `pickTarget` 한 곳에 하드코딩된 휴리스틱으로만
존재한다. 여기서 설계 원칙이 나온다:

> **원칙 1 — 의도와 전달을 분리하라.** 발신자는 "누구에게 무엇을"만 말하고,
> "어떻게 깨우나"는 수신자 유형별 어댑터가 담당한다.

## 3. 통합 모델: Principal / Room / Task 3층

### 3.1 Principal 레지스트리 (신원층) — 최대 지렛대

모든 행위자를 하나의 주소체로 통일한다:

```
Principal {
  id: string                  // "human:me" | "pane:w8-1(claude)" | "ext:openclaw-mac2"
  kind: 'human' | 'pane-agent' | 'external'
  display: string
  reachability: 'gui' | 'renderer-hook' | 'pty-nudge' | 'poll-only'
  liveness: live | stale      // 판 죽음/워크스페이스 삭제 시 자동 전환
  reports_to?: PrincipalId    // 회사모드 예약 (PRD v0.1 채택분) — v0 항상 null
}
```

- `reports_to`: 회사모드(supervisor 트리)의 유일한 추가 필드로 예약. additive optional이라
  마이그레이션 불필요. 이 필드에 supervisor의 Principal ID가 들어가는 순간 위임/보고
  트리가 완성된다. 활성화는 R6 이후 별도 결정.

- 채널 멤버십·멘션·a2a 수신자가 전부 이 위에 올라간다.
- 선행 문서의 P2(에이전트 판 1급 멤버화)는 이 레지스트리의 `pane-agent` 부분집합.
- **A4(외부)는 `external` principal로 등록** — 워크스페이스가 없어도 채널 멤버가 될 수 있다.
  Slack의 봇/앱 계정에 해당. 현재 `(workspaceId, memberId)` 스키마로는 표현 불가 —
  가상 워크스페이스(`ws-ext-*`) additive 방식이면 스키마 마이그레이션 없이 수용 가능.
- 죽은 워크스페이스 멤버 잔존 문제는 liveness 필드 + 삭제 훅으로 여기서 해소.

### 3.2 Room (채널 = 협업의 공용 표면)

> **원칙 2 — 협업의 정본은 채널에 남긴다.** 1:1 지시는 a2a로 가더라도,
> 오케스트레이션의 진행·결정·결과는 채널에 남아야 휴먼(A1)이 언제든 감사한다.

**미션 채널 패턴** (오케스트레이션의 표준 단위):
1. 오케스트레이터가 `channel_create("mission-<slug>")` + 참여 principal 초대
2. 작업자들은 조인과 동시에 unread 커서 발급 → pull로 맥락 습득
3. 지시는 `@멘션`(=a2a task 브리지로 인터럽트), 보고는 일반 post(=배지)
4. 완료 시 요약 post → 아카이브 → 7일 reaper가 정리

이 패턴이 서면 "워크스페이스 분할 오케스트레이션"의 조율 채널이 표준화된다 —
지금은 조율이 a2a 1:1로 흩어져 휴먼이 볼 수 없다.

### 3.3 Task (a2a = 상태의 정본)

변경 없음. 채널=논의, 태스크=상태 라는 현행 이분법은 옳다.
멘션→태스크 브리지(`channelMentionInbox`)가 두 층의 접착제 — 유지·확장만.

## 4. 전달층: Reachability 어댑터

| 수신 principal | 어댑터 | 현재 상태 |
|---|---|---|
| 내부 attached claude 판 | renderer hook (멘션→a2a task) | ✅ 있음 (same-ws만 P1로 개방) |
| 내부 detached / 비-claude 판 | wake worker PTY 넛지 (quiet gate + 백오프 + cap) | ✅ 있음 |
| 외부 에이전트 | **폴링 계약** — `wmux_events_poll` + `channel_unread` 주기 호출 | ⚠️ 도구는 있으나 계약 미문서화 — **R4 착수 전 문서화 필수** (폴링 주기 하한 포함) |
| 외부 에이전트 (향후) | push — LAN link 대칭 확장 or webhook | ❌ 없음 (v0 수신전용) |
| 휴먼 | GUI 배지 + 멘션 하이라이트 | ✅ 있음 |

> **원칙 3 — push는 가속기, pull이 정본.** 이 불변식은 외부 에이전트에도 그대로 적용된다.
> 외부 push가 없어도 폴링으로 정확성이 보장되고, push는 나중에 지연만 줄인다.
> (wake worker 설계 철학의 자연 확장 — 새 발명 불필요.)

## 5. 오케스트레이션 패턴 3종 (전부 위 3층으로 표현됨)

### 패턴 A — 단일 워크스페이스 멀티판
오케스트레이터 판 + `pane_split`로 작업자 판들. 컨텍스트 공유 최대, 격리 최소.
**전제: P1(same-ws 멘션 개방).** 현재는 같은 워크스페이스 판끼리 채널 태깅이 차단돼
이 패턴에서 채널을 쓸 수 없다 — 사용자가 오늘 부딪힌 바로 그 벽.

### 패턴 B — 멀티 워크스페이스 (워크스페이스 = 작업자)
워크스페이스별 git worktree 격리, a2a + 미션 채널로 조율. **현행으로 이미 가능** —
채널 v2 배포와 미션 채널 패턴 표준화만 있으면 됨. 오늘의 trix / if fable 구성이 이것.

### 패턴 C — 외부 오케스트레이터 (OpenClaw가 밖에서 wmux를 도구로)
외부 에이전트가 `surface_new`/`terminal_send`로 작업자 판을 스폰하고 미션 채널로 조율.
**전제: A4 principal + 원격 MCP 접근.** 보안 순서를 지켜야 한다:

1. **1단계 (지금 가능)**: 같은 머신의 다른 프로세스로 실행되는 외부 에이전트 — 로컬 MCP로 전부 가능
2. **2단계**: LAN link 위에 채널 read/post만 개방 (수신전용 불변식의 최소 완화 — execute 여전히 금지)
3. **3단계**: 원격 제어(판 스폰 등)는 별도 신뢰 설계 후 — **"no remote execute" 불변식은
   명시적 결정 전까지 유지** (lanlink PR-4/5의 의도적 경계)

휴먼(A1)은 세 패턴 모두에서 미션 채널 멤버로 관전 + `@멘션`으로 개입 — 이것이
"나도 포함"의 구현이다.

## 6. 경제성과 안전 (Slack과 달라야 하는 이유, 재확인)

- **토큰 경제**: 에이전트는 읽는 데 토큰을 낸다. 멤버십=구독은 unread 가시성까지,
  본문 자동 주입 금지. 멘션만 인터럽트.
- **루프 스톰**: `MENTION_NUDGE_CAP`(3회+백오프+인간 핸드오프)를 모든 어댑터에 동일 적용.
  외부 폴링 에이전트에는 폴링 주기 하한을 계약에 명시.
- **신원 위조 (#113)**: 같은 머신 에이전트 신원은 위조 가능 → kick/archive/원격 execute는
  humans-only 유지. external principal 등록은 페어링(PIN) 절차 필수.
- **감사 가능성**: 미션 채널 패턴이 곧 감사 로그 — 휴먼이 사후에도 "누가 무엇을 왜"를
  채널 히스토리로 추적.

## 7. 로드맵 (선행 문서 P1~P4에 접합)

| 단계 | 내용 | 의존 | 효과 |
|---|---|---|---|
| **R0** | 3.12.1 배포 (채널 v2 활성화) | 빌드 완료 | 모든 것의 전제 |
| **R1** | = P1: senderPaneId + same-ws 멘션 개방 | R0 | 패턴 A 개통, 오늘의 벽 제거 |
| **R2** | = P2 확장: Principal 레지스트리 (pane-agent 1급 멤버 + liveness 정리 + local-ui 표기 제거) | R1 | 로스터 = 실수신자 명단, 죽은 멤버 해소 |
| **R3** | 미션 채널 패턴 표준화 — 문서(AGENTS.md) + 헬퍼 MCP 도구(`channel_mission_start/close`) | R0 | 패턴 B 조율이 감사 가능해짐 |
| **R4** | external principal (가상 ws additive) + 외부 폴링 계약 문서화 | R2 | 패턴 C 1단계 개통 (같은 머신 외부 에이전트) |
| **R5** | LAN link 채널 브리지 (read/post만, execute 금지 유지) | R4 + lanlink PR-5 | 패턴 C 2단계 (다른 머신 OpenClaw). **모바일 앱도 이 브리지에 붙는 채널 클라이언트** — 별도 API 서버 없음, stateless viewer |
| **R6** | **Approval Gate** — 매칭 액션 보류 → 휴먼 escalate → 승인/거부. 대상: humans-only 액션(kick/archive/원격 execute) 중 위임 가능하게 열 원격 명령 + 외부 principal의 실행성 액션(terminal_send, 판 스폰 등). 정확한 목록은 R6 설계 시 확정 | R4 | **humans-only 경계를 완화하는 유일한 통로.** 모바일의 킬러 유스케이스(밖에서 승인 탭) 전제 |

**R1이 여전히 지렛대다.** 외부까지 포함한 큰 그림에서도, 필드 하나(senderPaneId)로
열리는 패턴 A가 가장 싸고 가장 자주 쓰인다 (오케스트레이터+작업자를 한 워크스페이스에
띄우는 게 기본 구도이므로). R4~R6는 독립 트랙이라 병행 가능 (R6는 R4 이후).

## 8. 결정 필요 사항 (구현 착수 전)

1. **R2의 조인 시점**: 워크스페이스 추가 시 그 안의 판들을 자동 조인 vs 판별 명시 조인.
   자동이 Slack 멘탈모델에 맞지만, 판 수명이 짧은 워크플로에서는 로스터 churn 발생.
2. **R4의 신원 부트스트랩**: external principal 등록을 페어링 PIN 재사용 vs 별도 토큰.
   (PRD v0.1의 장기 토큰 방식은 후보 중 하나. **이 결정이 Gateway 상세 설계의 선행 조건.**)
3. **R5 범위**: LAN 채널 브리지에 멘션(=인터럽트)까지 허용할지, post/read만 허용할지.

## 9. PRD v0.1 처분표 (2026-07-04 접합)

"wmux Channels PRD v0.1" 전 항목의 처분 기록. 처분 어휘 3종: **채택** / **기각** / **연기**
(연기 = 방향은 인정하되 선행 조건 후 재개). 향후 PRD 용어(agent://, dm, broadcast 등)로
논의가 재발하면 이 표가 참조 정본이다.

### 9.1 개념 매핑 (PRD ↔ 본 문서)

| PRD v0.1 | 본 문서 대응 | 판정 |
|---|---|---|
| Agent Registry `agent://<realm>/<name>` | Principal 레지스트리 (`human:` / `pane:` / `ext:`) — R2 | 동일 개념, 표기만 다름 |
| "Human is an agent" | A1 휴먼 = principal | 동일 |
| room 채널 (다자 협업) | 미션 채널 패턴 — R3 | 동일 |
| 원격 에이전트 (헤르메스, OpenClaw) | external principal + 폴링 계약 — R4→R5 | 동일 목표, 보안 단계가 다름 |
| task/result/ack/escalate | a2a task 시스템 (§3.3 이분법 유지) | 이미 존재 |
| 회사모드 `reports_to` 트리 | §3.1 예약 필드 + 패턴 A/B/C | 방향 일치 |

### 9.2 충돌 3곳 (기존 결정이 우선 — 프리미스 합의됨)

1. **기판 중복**: PRD의 신규 JSONL 저장소 + Envelope + ULID는 동작 중인 채널 v2
   (`ChannelService`) + a2a를 재기판하는 것 — 기각. additive 확장이 정본.
2. **push-first vs pull 정본**: PRD Gateway는 WS push가 기본이나 원칙 3("push는 가속기,
   pull이 정본")과 토큰 경제 방어(`MENTION_NUDGE_CAP`)가 우선.
3. **보안 단계 건너뜀**: PRD의 원격 등록 + control cmd 즉시 개방은 "no remote execute"
   불변식과 §5 패턴 C의 3단계 순서 위반 — 단계 준수 형태로만 수용.

### 9.3 전 항목 처분

| PRD 항목 | 처분 | 사유 |
|---|---|---|
| §1.1 Agent ID 스킴 `agent://<realm>/<name>` | 기각 (표기) / 채택 (개념) | R2 Principal id가 동일 역할. 표기 이원화는 이중 진실 |
| §1.2 `capabilities` 필드 | 연기 | R2 Principal 스키마 설계 시 검토. 지금은 라우팅 수요 없음 |
| §1.2 `reports_to` 필드 | **채택** | §3.1에 optional 예약 완료. v0 항상 null. additive라 비용 0 |
| §1.3 로컬 등록 (환경변수 `WMUX_AGENT_ID` 주입) | 연기 | 기존 pane 신원 체계(멘션 토큰)와 중복. R2에서 통합 판단 |
| §1.3 원격 등록 (토큰 인증) | 연기 | §8.2 신원 부트스트랩 결정의 입력 후보 중 하나 |
| §1.4 Presence/heartbeat | 기각 | liveness 필드(live/stale) + 삭제 훅이 동일 문제 커버 |
| §2 Message Envelope (신규 스키마 + ULID) | 기각 | 채널 v2 `ChannelMessage` additive 확장이 정본 (9.2-1) |
| §2.2 task/result/ack/escalate 타입 | 기각 | a2a가 담당. "채널=논의, 태스크=상태" 이분법 유지 (§3.3) |
| §2.2 cmd/cmd_result 타입 | 연기 | R6 Approval Gate 설계 시 함께 |
| §2.3 첨부 참조 방식 (인라인 금지) | 연기 | 채널 첨부 수요 발생 시. 방향은 텍스트 기판 철학과 정합 |
| §3.1 dm 채널 | 연기 | 현행 명시 생성으로 충분. 수요 확인 후 |
| §3.1 room 채널 | 채택 (기존) | = 미션 채널 패턴 (R3). 신규 아님 |
| §3.1 control 채널 | 연기 | R6과 동일 트랙. 보안 3단계 순서 준수 |
| §3.1 broadcast 채널 | 연기 | 수요 미확인 |
| §3.2 ACL (owner/member/observer) | 연기 | 현행 humans-only 경계가 사실상의 ACL. R2 로스터 정비 후 재검토 |
| §3.3 Approval Gate | **채택** | R6로 로드맵 추가 완료. humans-only 경계 완화의 유일한 통로 |
| §4.1 로컬 CLI (`wmux ch send/tail`) | 연기 | MCP 도구(`channel_post`/`channel_read`)가 동일 기능. 셸 CLI는 수요 확인 후 |
| §4.2 Gateway WS | 연기 | §8.2 결정 후, 보안 2단계(read/post만) 준수 + "pull 정본" 모델로 재설계 |
| §4.2 모바일 앱 = WS 클라이언트 | **채택** (프레임) | R5 비고에 명시 완료. 별도 API 서버 없음 |
| §4.3 WS op 6개 프로토콜 | 연기 | Gateway 트랙 재개 시 초안으로 활용 |
| §5 JSONL 파일 스토리지 + 로테이션 | 기각 | 데몬 채널 v2 저장(`ChannelStateWriter`)이 정본. 이중 저장소 금지 |
| §5 Registry 이벤트 소싱 | 연기 | R2 Principal 저장 방식 설계 시 후보로 검토 |
| §6 로드맵 P1~P4 | 기각 | 본 문서 R0~R6 로드맵으로 대체. PRD P1은 채널 v2 + R1로 이미 달성 |
| §6 비목표 (E2EE, 페더레이션, 리치 미디어 제외) | 채택 | 기존 방향과 동일 |
| §7 열린 질문 3건 | 채택 | Q1(수신 인터페이스) = 어댑터 계층(원칙 1)으로 흡수, 종결. Q2(와일드카드 구독 권한) = §8.3과 동축. Q3(task 상태 머신) = 현행 a2a 느슨 모델 유지로 종결 |
