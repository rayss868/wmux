# P1 계획: 채널 멘션 자동응답 — "부르면 받는다" (2026-06-27)

> ★ **구현 SSOT = 맨 아래 「P1 최종 설계 (구현 가능 — Step 1 조사 완료)」 섹션.**
> 위 본문은 설계 진화 히스토리(작은 배선 → 1차 eng-review → outside voice가 Stop hook 중심으로 재설계 → 미결 6개). 최종 설계가 그 미결 6개를 조사로 확정한 결과다.

P0 진단 + delivery 경로 정밀 조사 결과 기반. 목표: @멘션하면 에이전트가 **안 시켜도** 그 메시지를 터미널로 받아 반응한다.

## 조사 결론 (핵심)

1. **★ 이미 작동하는 "메시지→에이전트 PTY" 경로가 있다.**
   `a2a.task.send`(에이전트 간 직접 메시지) → `deliveryLiveMeta` + `isLiveTuiAgent` 판정 → `deliverPtyNudge`/`deliverPtyNotification` → `submitBracketedPasteToPty`로 받는 에이전트 PTY에 실제 paste. (`useRpcBridge.ts:1436-1717`, 함수들 `:253/:274/:300/:310`)

2. **채널 멘션은 task만 만들고 배달을 안 한다.**
   `routeChannelMentionToInbox`(`channelMentionInbox.ts`) = `createA2aTask`(store) + `publish`(eventbus)만. `deliverPty*` 호출 0건. 3단계(task생성 → live판정 → PTY배달) 중 뒤 2개 누락.

3. **연결 = 작은 배선.**
   `deliverPtyNudge`/`deliverPtyNotification`/`deliveryLiveMeta`/`isLiveTuiAgent` 전부 `useRpcBridge.ts`에 이미 존재. 추출/export 후 재사용.

4. **작업중 방해 방지 장치도 이미 있다.**
   `isLiveTuiAgent`(status ∈ running/waiting/awaiting_input) → **nudge(한 줄 pointer)**, idle/complete → **full body**. (`useRpcBridge.ts:300-303`)

5. **`LocalPtyDelivery`(채널 전용 transport)는 정의·테스트만, production 미연결.** 멘션에는 이걸 쓰기보다 #1의 a2a 배달 함수를 재사용하는 게 빠르고 일관됨(같은 nudge/full 정책).

## P1 설계

### 핵심 배선
받는 쪽(self renderer)의 `routeChannelMentionToInbox`에서 task 생성 직후, 멘션된 pane의 PTY로 배달:
```
멘션 task 생성 (to.paneId 이미 resolve됨, ptyId 확보)
  → deliveryLiveMeta(surfaceAgent, ptyId) 로 live 판정
  → live  → deliverPtyNudge      (한 줄: "[wmux-channel #ch from X] …")
  → idle  → deliverPtyNotification (full body + sender/채널 정보)
  → submitBracketedPasteToPty 로 PTY write
```
- `to.paneId`의 ptyId는 이미 `resolvePaneAddress`로 얻고 있음(받는쪽 fail-closed 검증 그대로).
- ws-level 멘션(paneId 없음)은 그 ws의 active pane terminal(`activePaneTerminalPty`)로 — a2a task send의 ws-target 동작과 동일.

### 멀티 워크스페이스 (eng-review 결정: 프로덕션 방법)
**`useChannelsEventSubscription`을 active ws 단일 폴 → 모든 멤버 ws 폴로 확장.** background ws(안 보는 ws)의 에이전트도 자기 멘션을 자동으로 받아야 함(Slack 동작). renderer가 모든 ws의 pane tree+ptyId를 store에 갖고 있으므로 background ws pane PTY에도 배달 가능.
- 대안 C(main/daemon-side 배달)는 pane 해석(ptyId/surfaceAgent)이 renderer store라 결국 renderer를 거쳐야 함 → 이점 적고 대공사 → **비채택**.
- `routeChannelMentionToInbox`에 넘기는 `selfLeaves`를 **멘션받은 ws의 leaves**로(현재 self 단일 → 멘션 ws별)로 확장. 배달도 그 ws pane pty에.
- events.poll 멀티 ws 방법(N개 개별 폴 vs poll API에 멀티 ws scope 추가)은 Performance 섹션에서 결정.
- ⚠️ 기존 단일-self 제약(FIX-MULTI-WS)을 이 작업이 해소함 — 1차 슬라이스의 `useChannelsEventSubscription` self-구독 fix(`2b40035`)와 같은 파일, 회귀 주의.

### 구현 단계
1. `deliverPtyNudge`/`deliverPtyNotification`/`deliveryLiveMeta`/`isLiveTuiAgent`를 `useRpcBridge.ts`에서 **공유 모듈로 추출**(예: `renderer/utils/ptyAgentDelivery.ts`) → useRpcBridge + channelMentionInbox 공용. (순수 함수라 추출 안전)
2. `MentionInboxDeps`에 `deliverToPane(ptyId, message, isLive)` 주입.
3. `useChannelsEventSubscription`을 **모든 멤버 ws 폴**로 확장 + 각 멘션을 받은 ws의 leaves로 resolve + `store.surfaceAgent` + `window.electronAPI.pty.write`로 배달.
4. 단위 테스트: live→nudge, idle→full, paneId없음→active pane, 사람(local-ui)→배달 안 함, **background ws 멘션→배달됨(멀티 ws)**, 재전달(getTask 단락)→중복 배달 안 함.

### 정책 (결정)
| 항목 | 결정 | 근거 |
|---|---|---|
| 배달 범위 | **멘션된 것만** PTY 배달 | 일반 채널 메시지 전체 fan-out은 노이즈 → 보류 |
| 작업중 에이전트 | nudge 한 줄 | a2a task send와 동일, 방해 최소 |
| idle 에이전트 | full body | 바로 읽고 반응 |
| ws-level 멘션(paneId 없음) | 그 ws active pane | a2a ws-target과 일관 |
| 사람(@local-ui) | PTY 없음 → 도크 배지(기존 #6) | 사람은 task 처리기 아님 |

### 범위 밖 (follow-up)
- **Stop hook → 채널 inbox 자동 poll**: "에이전트가 일 끝낼 때 채널 확인" 연쇄는 현재 없음(큰 작업). 단 1차의 nudge paste가 이미 PTY에 남아 있어 에이전트가 작업 후 입력을 보면 인지 → 효과 일부 대체. 데이터 보고 필요하면 그때.
- **일반 채널 메시지 전체 배달**(`LocalPtyDelivery` wiring): 별도. 1차는 멘션만으로 "부르면 받는다" 달성.

### 리스크 / 확인할 것
- claude Code가 **작업 중일 때 PTY paste**를 어떻게 처리하나(입력 버퍼 큐 / 무시 / 인터럽트). → **a2a task send와 동일 동작**이므로 새 리스크는 아님. dogfood로 실측.
- nudge는 pointer라 작업중 에이전트가 즉시 full을 안 봄(query 필요). idle이면 full 직접. 이 균형이 사용자가 원하는 "작업중이면 나중에, 쉬면 바로"와 맞는지 dogfood 확인.

### 검증 (dogfood)
WS3가 `@WS1-claude` 멘션 → WS1 claude **터미널에 nudge/full이 자동으로 도달** → claude가 (작업중이면 작업 후, idle이면 즉시) 인지하고 `channel_post`로 응답. 안 시켜도 되는지가 합격선.

### 규모
**작은 배선** (순수 함수 추출 + deps 주입 + 호출 1곳). 1차 슬라이스(`feat/channels-pane-membership`)에 커밋 추가 가능. P2(pane 이름)와 독립.

## 다음 순서
1. (지금 계획 확정) → 공유 모듈 추출 + 멘션 배달 배선 구현
2. 단위 테스트 + 라이브 dogfood (WS1 claude 자동 반응)
3. 되면 P2(pane 이름) → P3(push)

---

## Eng-review 결과 (plan-eng-review, 2026-06-27)

### 결정 락인
- **멀티 ws 배달 = B** — renderer가 모든 멤버 ws를 폴링+배달(background ws 에이전트도 자동응답). C(main/daemon-side)는 pane 해석이 renderer store 의존이라 비채택.
- **폴링 = events.poll에 멀티 ws scope 추가** — ws 배열로 1폴/초, cursor 1개. ws당 개별 폴(N폴/초)은 부하·복잡도로 비채택.

### NOT in scope (의도적 defer)
- Stop hook → inbox 자동 poll: nudge paste가 작업 후 인지로 일부 대체. dogfood 빈도 데이터로 결정.
- 일반 채널 메시지 전체 fan-out(`LocalPtyDelivery` wiring): 멘션만으로 P1 충족. 추출한 공유 모듈을 나중에 재사용.
- 작업중 PTY paste 동작 변경: a2a.task.send와 동일 코드, 새 작업 아님.

### What already exists (재사용 / 재구축 안 함)
- `deliverPtyNudge/Notification/deliveryLiveMeta/isLiveTuiAgent` (useRpcBridge) — 작동 중, 추출 재사용.
- `resolvePaneAddress` — 받는쪽 to.paneId→ptyId 이미 확보.
- `ChannelRecipientStatus.ptyId` (channels.ts) — 스키마에 이미 있음.
- `LocalPtyDelivery` — 전체 fan-out follow-up용 보존(공유 모듈 추출 후 재사용, dead code 아님).

### Failure modes (신규 코드패스별, 프로덕션 실패 시나리오)
1. **작업중 PTY paste가 에이전트 입력 오염**: claude 작업중 nudge paste → 입력 버퍼 영향? → a2a.task.send와 동일 동작이라 새 리스크 아니나 **dogfood로 실측 필수**. 완화: nudge 한 줄. 가시: 터미널에 보임.
2. **★critical: 멀티 ws 폴 resync가 silent**: 멀티 scope cursor 1개면 한 ws의 ring drift(resync)가 전체 캐시 wipe 영향. → events.poll 멀티 scope 설계 시 **per-ws cursor vs 통합 cursor** 명시 결정. 테스트: resync 단위. 실패 시 조용히 메시지 누락 가능.
3. **★critical: 배달 실패(dead pty/write 실패)가 silent**: target_gone → 멘션이 에이전트에 안 닿는데 발신자는 모름. 완화: deliver가 status 갱신(a2a 패턴 재사용) + 도크 배지는 뜸(부분 가시). 보낸 쪽 가시성은 follow-up.
4. **사람(local-ui) 멘션 pty 배달 시도**: pty 없음 → resolveRecipient null → skip(도크 배지만). 테스트로 고정.

→ **critical gap 2개(#2 resync, #3 배달실패)**: 둘 다 테스트 + 가시성 처리 필요. 특히 #2는 멀티 ws scope 구현의 핵심 결정.

### Test 커버리지 (구현 시 동반 필수)
신규 코드패스 ~8개 전부 GAP. ★ critical 2개:
- background ws 멘션 → 배달됨 (멀티 ws **회귀방지**)
- 재전달(getTask 단락) → 중복 배달 안 함 (**idempotent**, paste는 getTask 단락 안쪽에)
일반: live→nudge / idle→full / ws-level→active pane / local-ui→skip / 추출함수 단위.

### Parallelization
- **Lane A (renderer)**: ptyAgentDelivery.ts 추출 → channelMentionInbox 배달 배선 (순차, 공유 모듈)
- **Lane B (daemon)**: events.poll 멀티 ws scope (events.rpc) — 독립
- A + B 병렬 worktree 가능. 합친 뒤 dogfood. (단 둘 다 useChannelsEventSubscription에서 만나니 통합 시 조정)

### Completion Summary
- Step 0 Scope: 적절 (멀티ws 포함해도 복잡도 트리거 안 함, 기존 재사용)
- Architecture: 1 issue (멀티 ws → B 락인)
- Code Quality: 0 blocking (DRY 추출 ✓, idempotency 명시)
- Test: diagram 산출, ~8 GAP (2 critical)
- Performance: 1 issue (폴링 → events.poll 멀티 scope)
- Failure modes: **2 critical gap** (resync silent, 배달실패 silent)
- VERDICT(1차): 구현 진행 가능 — **단 outside voice가 이를 뒤집음(아래).**

---

## outside voice 재설계 (Codex + Claude subagent, 2026-06-27)
3사(Claude eng + Codex + Claude subagent)가 plan을 상당히 흔듦. 제 1차 eng-review의 결정 2개가 뒤집혔고 새 critical 다수 발견.

### ★ 근본 전환 (사용자 결정): PTY paste 중심 → **Stop hook 중심**
- `submitBracketedPasteToPty`는 100ms 후 `\r`로 **제출**(passive nudge 없음). 작업 중 에이전트면 입력버퍼 mid-task 주입 → 진행 명령 깨뜨림. 동시 배달이면 두 paste가 concat돼 garbled 명령으로 제출(busy 채널서 routine). `isLiveTuiAgent`는 body만 줄이고 `\r` 제출은 안 막음.
- 근본 원인: 에이전트는 single-task reactive(이벤트 루프 없음). PTY paste는 idle invocation엔 OK지만 busy면 latency unbounded(현재 task 끝나야 반응).
- **→ 멘션은 inbox 큐(task)로 두고, 배달 트리거 = 에이전트 Stop hook(일 한 토막 끝남) + idle 감지.** 그 시점은 idle이라 PTY paste 안전 + 즉시 반응. busy 동안은 큐(paste 안 함, 입력 안 깨뜨림). PTY paste는 보조(idle invocation).
- Stop hook 메커니즘: `HookSignalRouter`(`src/main/hooks/HookSignalRouter.ts`) + integrations/<agent> Stop event. 그 ptyId의 미처리 채널 멘션을 확인 → PTY 주입.

### cross-model 반영 (outside voice 합의 = 강한 신호)
1. **폴링 = per-ws 개별 폴** (events.poll 멀티 scope 비채택). 데몬은 이미 `recipientWorkspaceIds.includes(caller)`로 fan-out(`events.rpc.ts:115`) → 멀티 scope API는 불필요 + auth surface 변경. renderer가 ws당 cursor로 한 tick에 N폴(N=4 trivial). **제 Performance 결정 철회.**
2. **delivery = LocalPtyDelivery wiring** (새 추출 비채택). `LocalPtyDelivery.ts`가 이미 full pipeline. 추출하면 같은 로직 3벌 → mention-scoped `resolveRecipient`로 LocalPtyDelivery를 wiring하면 debt 0. **제 "추출+보존" 철회.**
3. **nudge = 채널용 포맷** — task id/query 지시(`buildA2aNudge` id8 `chmention…`→`chmenti` garbage, full body 채널맥락 없음, "see #ch"는 channel-read deferred라 무용).
4. **stale pane = PTY skip** — pane 죽어 ws-level fallback된 걸 paste하면 엉뚱한 sibling/browser pane. task만 만들고 PTY skip.
5. **`deliverPty*`는 순수 아님** — formatting+write 섞임. decision/format 분리 + write 주입.

### 잔여 critical (구현 전 결정 필요)
- **Stop hook → inbox flush 연동 상세**: HookSignalRouter가 Stop 신호 받을 때 그 ptyId의 미처리 멘션을 어떻게 추적/주입하나. (핵심 신규 설계)
- **delivery status writeback**: 배달이 receiver renderer에서 일어나는데 `ChannelRecipientStatus`는 daemon persist → 불일치. sender 가시성 경로 없음.
- **inbox 가시성 ws-wide**: `queryTasks`가 to.paneId 필터 안 함(`a2aSlice.ts:207`) → split pane이면 PTY는 1명이나 task는 ws 전체 agent가 봄.
- **same-ws sibling 멘션**: `channelMentionInbox.ts:98`이 sender ws==receiver ws drop → split pane 내 @멘션 여전히 안 됨. Stop hook 중심이면 재검토 가능.
- **멀티 renderer 중복 paste**: idempotency가 local store → 두 renderer면 중복.
- **partial failure**: task 생성 후 PTY write 실패 시 catch swallow → getTask 단락이 재시도 영영 막음.
- `channelMentionInbox.test.ts` 8개 기존 mock 갱신 필요(MentionInboxDeps 확장).

### VERDICT (최종): DONE_WITH_CONCERNS → 재설계 필요
P1이 "작은 배선"에서 **"Stop hook 중심 자동응답 재설계"로 확대.** outside voice가 핵심을 잡음(PTY paste만으론 busy 자동응답이 깨짐). **구현 전: ① Stop hook → inbox flush 연동 설계(신규, 조사 필요) ② per-ws 폴 + LocalPtyDelivery wiring으로 plan 재작성 ③ 채널 nudge 포맷 + stale-skip + writeback.** office-hours/추가 조사로 Stop hook 연동을 설계한 뒤 구현 권장.

---

## Stop hook 연동 설계 (P1 핵심 — 사용자 결정 2026-06-27)

### 왜 Stop hook인가 (결정적 근거 = 컨텍스트 위생)
PTY로 멘션을 큐잉하면 **에이전트 메인 작업 컨텍스트에 영구 추가**됨 → 작업 무관 채널까지 토큰 소모 + 작업 흐름 오염("소모성 컨텍스트"). Stop hook은 에이전트가 **일을 끝낸 경계**에서 멘션 처리 → 현재 작업 컨텍스트 안 건드리고 새 턴으로 깔끔 분리. 더해 **알림은 가볍게(한 줄 + task-id), 본문은 에이전트가 필요할 때만 query** → 컨텍스트 절약(Claude Code `/btw`의 "history 안 남김" 비소모 철학과 같은 선). 즉 Stop hook의 이점은 "busy 깨뜨림 회피"만이 아니라 **멘션이 작업 컨텍스트를 소모하지 않게**가 더 큼.

### 흐름 (설계 방향)
```
[멘션 도달]  per-ws 폴(renderer, 모든 멤버 ws) → inbox 큐(task, to.paneId)
                                                  컨텍스트 안 건드림
[배달 트리거] 에이전트 Stop hook(일 끝남) → HookSignalRouter(agent.stop, ptyId)
                    │  (이미 idle이면 Stop 안 기다리고 즉시)
                    ↓
             그 ptyId의 "미알림" 멘션 task 확인
                    ↓
             가벼운 알림 PTY paste: 한 줄 "📨 N mentions in #ch from X · query a2a_task_query"
                    │  (idle 시점이라 안전 + Claude Code가 큐잉)
                    ↓
             에이전트가 a2a_task_query로 본문 query (필요할 때만 = 컨텍스트 절약)
```

### 구현 전 미결 질문 (추가 조사/결정 필요)
1. **main→renderer 경계**: `HookSignalRouter`(main)가 Stop 신호 받을 때 inbox(task store=renderer) 접근법 — `sendToRenderer`로 main이 요청 vs renderer가 Stop 신호 구독. (a2a.channel.rpc의 `input.findOwnerWorkspace` 패턴 참고)
2. **"미알림" 추적**: 어떤 멘션을 아직 안 알렸나 — task에 `notified` 플래그 추가 vs per-pane 미알림 큐. Stop 시 그 pane의 미알림만 flush.
3. **알림 형식**: 한 줄 + task-id(들). 에이전트가 query하기 충분한 reference. (channel nudge 포맷 = outside voice 지적 #3 해소)
4. **idle 즉시 분기**: 에이전트가 이미 idle(작업 없음)이면 Stop 안 기다리고 즉시 알림 (surfaceAgent status로 판정).
5. **비-Claude 에이전트**: codex/hermes/aider가 Stop hook(integrations/<agent> bridge)을 보내나. 안 보내면 폴백(주기 알림? 또는 그 에이전트는 미지원 명시).
6. **same-ws sibling**(channelMentionInbox.ts:98 drop): Stop hook 중심이면 같은 ws pane끼리도 inbox 큐로 가능 — 재검토.

### 다음 액션
1. **조사**: HookSignalRouter Stop 흐름 + main/renderer 경계 + integrations bridge Stop event를 정밀 매핑 → 위 미결 1·2·5 확정.
2. **plan 재작성**: 조사 결과로 P1을 "per-ws 폴(inbox) + Stop hook 알림 + LocalPtyDelivery(idle invocation 보조)"로 통합.
3. 구현 → 라이브 dogfood(작업 중 claude가 Stop 후 멘션 인지·응답, 컨텍스트 안 오염).

---

# P1 최종 설계 (구현 가능 — Step 1 조사 완료, 2026-06-27)

> 위 「Stop hook 연동 설계」의 미결 6개 + 잔여 critical을 코드 정밀 조사로 확정. 이 섹션이 구현 SSOT.

## 조사로 확정된 사실 (코드 근거)

1. **신호는 이미 흐른다 — `agent.lifecycle` EventBus 이벤트.** 새 배선 불필요.
   - main이 Stop을 `eventBus.emit({ type:'agent.lifecycle', workspaceId, ptyId, kind, source, decision })`로 emit:
     `hooks.rpc.ts:360`(source:hook, Claude) · `PTYBridge.ts:443`(source:detector, 전 에이전트) · `DaemonNotificationRouter.ts:193`(detector, daemon pane) · `:233`/`PTYBridge.ts:365`(osc133).
   - `kind ∈ {agent.stop, agent.subagent_stop, agent.awaiting_input}` (`events.ts:206`).
   - `agent.lifecycle`은 `WMUX_EVENT_TYPES`(`events.ts:81`) → `events.poll`에서 **strict ws-scope**(`events.rpc.ts:126` `e.workspaceId === caller`).
2. **비-Claude도 커버됨 (미결 #5 해소).** Stop hook bridge는 `integrations/claude`만 존재. 그러나 detector(~1-2s lag) + osc133이 동일 `agent.lifecycle`을 emit → renderer는 source 무관하게 수신. codex/gemini/aider/opencode/copilot 전부 detector 경로로 stop 잡힘 (lag 수용).
3. **ptyId→paneId 역매핑 존재** = `resolveSenderPaneAddress(leaves, ptyId)` (`a2aAddressing.ts:153`). Stop의 `ptyId`로 그 pane(paneId) 확정.
4. **idle 판정** = `surfaceAgentStatus[ptyId]`(`paneSlice.ts:79`) / `surfaceAgent[ptyId].status`. `LIVE_AGENT_STATUSES = {running, waiting, awaiting_input}`(`useRpcBridge.ts:298`) 외면 idle.
5. **배달 함수 존재** = `deliverPtyNudge`(`useRpcBridge.ts:274`)·`submitToPty`(:281). `LocalPtyDelivery`는 post-시점 fanout 전용이라 Stop-트리거 경로와 별개(미연결 유지).
6. **task store는 renderer-local**(`a2aSlice.ts`, `createA2aTask` = `set()`). `WmuxTaskMetadata`(`types.ts:594`)는 확장 가능 interface. → main 왕복 0, renderer 안에서 Stop 수신·inbox 조회·배달이 한 프로세스에서 닫힘.

## 흐름 (확정)
```
[멘션 도착]  per-ws events.poll(channel.message)  →  routeChannelMentionToInbox
              →  createA2aTask(to.paneId, 채널멘션 마커)  [inbox 큐 = 작업 컨텍스트 안 건드림]
              →  도착 시 그 pane이 idle이면 즉시 flush 분기 (아래와 동일 배달)

[Stop 트리거] 에이전트 turn 끝  →  main: agent.lifecycle(agent.stop, ptyId) emit
              →  renderer events.poll(agent.lifecycle) 수신  [같은 poll loop, types 확장]
              →  resolveSenderPaneAddress(selfLeaves, ptyId) → paneId
              →  그 paneId 대상 "미알림" 채널멘션 task 조회
              →  deliverPtyNudge: 한 줄 "📨 N channel mention(s) in #ch from X — a2a_task_query <id>"
              →  paste 성공 후에만 notified=true 마킹

[에이전트]    a2a_task_query로 본문 query (필요할 때만 = 컨텍스트 절약)  →  channel_post로 응답
```

## 설계 결정 (미결 6개 확정)
| 미결 | 결정 | 근거 |
|---|---|---|
| #1 main→renderer 경계 | **renderer가 events.poll로 agent.lifecycle 구독** (main push 불필요) | task store=renderer 동일 프로세스. `useChannelsEventSubscription` poll에 types 추가뿐 |
| #2 미알림 추적 | **a2aSlice 별도 맵** `channelMentionDelivered: Record<taskId, boolean>` (task 스키마 불변) | metadata 확장보다 GC 동기 단순. 채널멘션 task 식별 = id prefix `chmention-` |
| #3 알림 형식 | **`buildChannelMentionNudge(taskIds, channelName, senderName)` 신규** 1줄 + task-id | `buildA2aNudge` id8가 `chmention-`→`chmentio` garbage. 채널 nudge는 채널명/발신/query 지시 |
| #4 idle 즉시 | 멘션 도착 시 `surfaceAgentStatus[ptyId]`가 non-live면 즉시 flush; live면 Stop 대기 | idle 에이전트가 다음 사용자 턴까지 멘션 못 보는 갭 제거 |
| #5 비-Claude | **detector/osc133 agent.lifecycle로 커버** (hook 없어도 됨) | 조사 사실 #2. lag ~1-2s 수용 |
| #6 same-ws sibling | **P1 범위 밖** (follow-up) | post 이벤트에 sender paneId 없어 self-loop vs sibling 구분 불가(`channelMentionInbox.ts:102`) |

## 잔여 critical 처리
- **delivery status writeback** → P1 범위 밖. nudge는 터미널에 보임 = 부분 가시. sender 가시성은 follow-up.
- **inbox 가시성 ws-wide**(`queryTasks` to.paneId 미필터, `a2aSlice.ts:207`) → nudge는 ptyId-targeted라 **배달은 정확 pane만**. task query 가시성은 ws-wide 유지(sibling이 query는 가능, 무해).
- **멀티 renderer 중복 paste** → 단일 renderer 가정(wmux 표준 1 BrowserWindow). 가정 명시.
- **partial failure** → `notified`는 **paste 성공 후에만** set. write throw 시 미마킹 → 다음 Stop에서 재시도. getTask 단락은 task 생성에만 적용(notified와 분리).

## 구현 단계 (Lane 단일 — 전부 renderer)
1. **poll types 확장**: `useChannelsEventSubscription`의 events.poll을 `types: ['channel.message','agent.lifecycle']`로. agent.lifecycle 수신 시 `kind ∈ {agent.stop, agent.subagent_stop}`만 처리(awaiting_input 제외 — idle 아님).
2. **미알림 맵 + 식별**: `a2aSlice`에 `channelMentionDelivered` + `markChannelMentionDelivered(taskId)` + `isChannelMentionTask(id)=id.startsWith('chmention-')`.
3. **Stop flush 핸들러**(신규, `channelMentionInbox.ts` 또는 형제 모듈, 순수 함수): `flushPaneMentions(ptyId, selfLeaves, deps)` → resolveSenderPaneAddress → 미알림 chmention task(to.paneId === paneId, 또는 ws-level이고 그 ptyId가 ws active) → nudge build → deliver → mark.
4. **idle 즉시 분기**: `routeChannelMentionToInbox` 직후, 해당 task의 to.ptyId(resolvePaneAddress 결과)가 non-live면 즉시 `flushPaneMentions` 호출.
5. **nudge 포맷**: `buildChannelMentionNudge` 신규 — `sanitizeA2aName`/CR-LF strip 재사용, 단일 라인, task-id 나열.
6. **배달 주입**: `deliverPtyNudge`/`submitToPty`를 채널멘션 경로에서 호출(필요 시 export). `MentionInboxDeps`에 `deliverNudge(ptyId, text)` + `getAgentStatus(ptyId)` 주입.

## 테스트 (신규 코드패스 동반)
- agent.stop 수신 → 미알림 멘션 flush → nudge 1회 paste.
- notified 후 재-stop → **재배달 안 함**(idempotent).
- 멘션 도착 시 idle pane → 즉시 flush / live pane → Stop까지 대기.
- ptyId 역매핑: split pane → **정확히 1 pane**만 배달.
- paste throw → notified 미set → 다음 stop 재시도.
- 비-Claude(source:detector) stop도 트리거(소스 무관).
- ws-level 멘션(paneId 없음) → 그 ws active pane.
- `channelMentionInbox.test.ts` 기존 mock 갱신(deps 확장).

## dogfood (합격선)
패키지 빌드 + windows-mcp GUI + pipe RPC. WS1 claude **작업 중** → WS3가 `@WS1-claude` 멘션 → claude가 **그 작업 끝낼 때(Stop)** 터미널에 채널 nudge 1줄 자동 도달 → claude가 `a2a_task_query`로 본문 보고 `channel_post`로 응답. **작업 컨텍스트 오염 0**(멘션이 진행 중 작업 입력 안 깨뜨림) + background ws 에이전트도 받음 + 동시/stale 안전 확인.
