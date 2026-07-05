# 채널 서브시스템 전체 수정 계획 (2026-07-05)

> 선행: 2026-07-05 정밀 감사(4에이전트 + 라이브 포렌식, 실행 데몬 PID 74379 = `out/` 패키지 기준).
> 감사 결론 메모리: `channel-audit-spine-2026-07-05`.
> 이 문서는 발견을 **뿌리별로 묶고** 의존성·리스크로 순서를 잡은 실행 계획이다. 코드 미변경(계획만).
> **개정 v1.1 (2026-07-05, Fable max 재검토):** 실질 결함 2건 교정 — §D1 권장안 교체(ack-on-paste 기각: ack 계약 위반·과잉소비 → 공유 nudge 원장), 4a 교체(데몬 세션종료 purge 기각: 에이전트 재시작 오폭 → 렌더러 부팅 reconcile). 보강 — 1a memberId 칩 단순화 + 로스터 Me 픽스 편입, 2c ceiling 분리·flap 픽스·CPR 필터, 3a mark-delivered 고정, 5d 쓰기경로 스탬프, 6e 소형 위생 묶음. 실행 순서 1a 선행으로 조정.

## 0. 핵심 진단 (왜 이 순서인가)

감사에서 나온 20여 개 결함은 **3개 뿌리**로 수렴한다:

1. **서버 소유 정체성 부재** — `ChannelMember`에 `memberName` 필드가 없고, 이름은 메시지마다 발신자가 자유 입력. 이것이 "Claude Code" 충돌 + 유령 memberId + 이름 불일치 + CLI 'agent' 충돌 + (휴먼으로 확장하면) 활성-워크스페이스 종속을 **동시에** 만든다.
2. **두 배달 기전이 "완료" 신호를 공유 안 함** — 렌더러 flush(a2a task)와 wake worker(PTY nudge)가 커서/ack를 공유 안 해서 이중 배달, 제로 배달, 거짓 nudgeExhausted가 난다.
3. **배달 상태가 죽은 트랜스포트 위의 거짓 영수증** — `LocalPtyDelivery`가 프로덕션 미배선(dead), `deliveryStatus`는 `ack()`만 씀 → 발신자 자기 메시지 영원히 `pending`.

**전송 하부(pull 커서 + unread + wake nudge)는 견고**하다 — 갈아엎지 않는다. 위 3개 층만 고친다.

**지켜야 할 경계(깨면 회귀):** additive 스키마(`ChannelState.version` 1 유지), pull 정본·push 가속기, `MENTION_NUDGE_CAP` 토큰 방어, humans-only(kick/archive/원격 execute), #113 same-user 신원 천장, 백그라운드 pane PTY forward(paste 게이트 안전 근거). 동시성/seq/멱등성/DoS캡/crash-load 방어는 **정확하므로 손대지 않는다.**

---

## 1. 우선순위 & 배포 단위

| Phase | 내용 | 뿌리 | 심각도 | 리스크 | 도그푸드 게이트 | 배포 단위 |
|---|---|---|---|---|---|---|
| **P1** | 발신자 정체성 (서버 소유 memberName) | ①정체성 | P0/P1 | 중(데몬 스키마 additive) | 일부 | PR-A(1a 즉시) + PR-B(1b~1d) |
| **P2** | 배달 신뢰성 (이중/제로/무한홀드) | ②배달신호 | P1 | **높음(데몬+렌더러 배달)** | 필수 | PR-C |
| **P3** | 배달 상태 정직화 (영수증) | ③영수증 | P1/P2 | 중 | 표시만 | PR-D |
| **P4** | 멤버 수명주기 청소 | 위생 | P1/P2 | 중(데몬 세션 훅) | 일부 | PR-E |
| **P5** | 통합 휴먼 뷰 (활성-ws 종속 해소) | ①정체성(휴먼) | P1 | **높음(표시 캐시 리키)** | 필수 | PR-F |
| **P6** | 초대·권한·UX | UX | P2/P3 | 낮음 | 선택 | PR-G |
| **P7** | (선택) 메시지 수정·삭제 | 기능 | P3 | 중 | 선택 | 별도 결정 |

**권장 실행 순서(v1.1): 1a(즉효) → P2 → 1b~1d → P3 → P4 → P5 → P6.** 1a는 렌더러 전용 즉효라 최우선 단독 배포. P2가 가장 심각한 기능 결함이라 그 직후(P1의 데몬 스키마에 비의존). P5(통합 휴먼)는 표시 캐시 리키라 별 트랙으로 마지막.

**공통 게이트(전 Phase):** ① 데몬 변경은 **test-first + 단계별 3모델 리뷰(Codex+GLM+Claude)** — `[[reviews-always-three-model-panel]]`. ② 배달/표시 변경은 **사용자 dev 빌드 GUI 도그푸드**(MCP는 채널 배달 도그푸드 구조적 불가 — `[[external-mcp-no-workspace-identity]]`). ③ 코드/커밋/CHANGELOG 영어(wmux 규칙), 계획/주석 논의는 한국어. ④ 각 단계 `npm run test` 그린 + `tsc` clean.

---

## Phase 1 — 발신자 정체성 (서버 소유 memberName)

**목표:** 채널에 뜨는 이름이 발신자 자유입력이 아니라 **서버가 pane/principal에서 파생한 안정 식별자**가 되게. "Claude Code" 충돌 + 유령 memberId + 이름 불일치 + CLI 'agent' 동시 해소.

### 1a. 렌더 즉효 (PR-A, 스키마 무변경 — 먼저 배포)
> **상태: 구현 완료 (2026-07-05, 워킹트리·미커밋).** `src/renderer/channels/authorDisplay.ts` 신설(+테스트 9), `ChannelView.tsx`/`ChannelMembers.tsx` 배선. tsc clean, 전체 스위트 4774+20 그린. 남은 것: GUI 도그푸드(dev 빌드) → /ship.
- **변경(v1.1 단순화):** `ChannelView.tsx:529-538` 발신자 표시를 `memberName` 단독 → **`m.memberId` 칩 병기**: `Claude Code · w26-1(claude)`. memberId는 메시지에 이미 저장돼 있어(라이브 pane 해석 불필요) 죽은 pane·백그라운드 ws 히스토리에도 동작. 휴먼(memberId='local-ui')은 워크스페이스명 칩 "Me · <ws>". (senderPtyId→pane 라이브 해석은 "지금 살아있음" 표시용 후속 — v1 필수 아님.)
- **추가:** workspaceId 기반 안정 색상 hue + 휴먼/에이전트 글리프(senderPtyId 유무로 판별). [감사 A2]
- **추가(v1.1 편입):** 로스터 "Me" 오표기 픽스 — `ChannelMembers.tsx:168`이 `isHuman` 판별로 모든 워크스페이스 휴먼을 "Me"로 라벨 → 이미 계산돼 있는 `isSelf`(:119)로 교체, 타 ws 휴먼은 워크스페이스명 표기. [감사 C-A3] 한 줄 수정이라 P5를 기다릴 이유 없음.
- **검증:** 라이브에 w25/w26 두 Claude가 서로 다른 칩으로 뜨는지 GUI 확인. 유닛: `senderPtyId`→표시명 해석 순수함수 케이스.
- **리스크:** 낮음(렌더러 전용). **이것만 먼저 머지하면 사용자 1순위 불만이 즉시 해소된다.**

### 1b. 로스터 소유 memberName (PR-B, 데몬 additive)
- **변경:**
  - `shared/channels.ts` `ChannelMember`에 `memberName?: string` **additive**(version 1 유지, `principalId`/`lastReadSeq` 선례).
  - `ChannelService.ts` create/join/invite(585-617, 763-776, 1017-1046)에서 member 행에 `memberName`을 **principal.display에서 파생**해 저장(principalId 있으면 registry 조회, 없으면 memberId).
  - `ChannelService.ts:1307` post가 `sender.memberName` verbatim 대신 **`(verifiedWorkspaceId, memberId)` 로스터 행의 memberName**으로 렌더(행 없으면 1c 처리).
  - `mcp/channels.ts:70,197` `channel_post`의 `member_name` **필수 인자 제거**(또는 무시). CLI는 이미 `member_id` 기본값이라 무변경.
- **검증:** 테스트 — MCP가 임의 `member_name`을 보내도 저장/표시는 로스터 파생값. 3모델 리뷰(데몬 스키마). 마이그레이션 없음(구 행은 memberName 없음 → 1a 렌더 폴백으로 안전 퇴화).
- **리스크:** 중. 데몬 스키마 additive라 롤백 안전. `PrincipalService` 조회 결합 신설.

### 1c. 유령 memberId 차단 (PR-B)
- **변경:** `ChannelService.ts:1163-1182` post 시 `memberId`가 `(verifiedWorkspaceId, *)` 로스터 행과 매칭 안 되면: 워크스페이스 단일 행이면 그 memberId로 매핑, 다중이면 경고 필드(`unmatchedMemberId`)를 결과에 실어 반환. self-cursor-ride(`:1328-1332`)가 매칭돼 **자기 메시지로 자길 재-nudge하는 버그** 해소. [감사 B-P1]
- **검증:** 테스트 — 로스터 없는 memberId post 시 매핑/경고. 회귀: create→post memberId-mismatch가 여전히 통과(과거 `NOT_A_MEMBER` 버그 재발 금지).

### 1d. CLI WMUX_MEMBER_ID 스탬프 (PR-B)
- **변경:** pane 스폰 env에 `WMUX_MEMBER_ID`를 principal/auto-name에서 스탬프(`pty.handler.ts` env 해석 지점, `WMUX_WORKSPACE_ID`와 같은 자리). 없으면 CLI join이 `'agent'` 대신 fail-closed 또는 명시 `--member` 요구. [감사 B-P1]
- **검증:** 스폰된 pane에서 `echo $WMUX_MEMBER_ID`가 auto-name. CLI 두 에이전트가 서로 다른 memberId로 join.

**Phase 1 완료 기준:** 라이브 채널에서 모든 에이전트가 고유 식별자로 구분되고, 로스터에 없는 유령 memberId 포스팅이 매핑/경고되며, CLI 에이전트끼리 안 충돌.

---

## Phase 2 — 배달 신뢰성 (이중/제로/무한홀드) [가장 심각]
> **상태: 2a~2f 전항 구현 완료 (2026-07-05, 워킹트리·미커밋).** Fable 직접(2a-1/2a-2/2b/2d) + Opus 병렬 3건(2c/2e/2f). 신규 테스트 37개(worker 2, handled 3, inbox 5, flush 10, pasteGate 6, rateLimit 6, Composer 11)·기존 5건 의도 갱신. tsc clean, 전체 스위트 4817+20 그린(1a 이전 대비 +43). 2f 하드 종료는 의도적 보류(제품 결정). 남은 게이트: GUI 도그푸드(§검증 시나리오) + ship 시 3모델 리뷰.
>
> **RCA 2026-07-05 (도그푸드 발견 — 인사 루프, 2건 즉시 교정):** 실사용 테스트에서 종료조건 없는 에이전트 인사 루프 발견. 원인 2개 다 P2 회귀:
> - **2a-1 넛지 회귀:** 넛지 문구에 "+ reply"가 있어 프롬프트 자동제출 → 모든 멘션에 반사적 답장 강제(인사→인사→멘션→…). **교정:** 넛지에서 reply 강제 제거, "질문/작업일 때만 답장; 인사·확인엔 답하지 말 것" 명시(`channelMentionFlush.ts` buildChannelMentionNudge). **soft 브레이크**(에이전트 준수 의존).
> - **2b 회귀:** `@local-ui`(사람 seat) 멘션이 사람 워크스페이스의 단일 에이전트 pane에 paste됨 → 사람에게 보낸 인사가 에이전트한테 도착·답장 → 루프 가속. **교정:** 사람 멘션(memberId='local-ui')은 a2a 인보이스 태스크를 아예 생성 안 함(사람=GUI 배지 전용, `channelMentionInbox.ts`). **hard 픽스**(구조적으로 에이전트 PTY 도달 불가). 신규 테스트 5(nudge reply-gate 1 + human-exclusion 2 + 기존 갱신). 전체 4820+20 그린.
> - **교훈:** P2가 4817 테스트를 통과했으나 "멘션이 배달되나"(기계)만 검증, "배달돼야 하나·답해야 하나"(의미)는 미검증 → 초록불 아래 인사 루프. 도그푸드 없이 ship 금지 재확인.
> - **남은 결정(하드 캡):** 인사 루프의 진짜 하드 스톱(내용 무관 pair-cap)은 여전히 보류 — Fix A(의미 게이트)+Fix B(사람 분리)+rate cap(5/분)+2f 토스트+사람 ack-drop으로 충분한지 도그푸드 후 판단. 내용맹 하드캡은 정당한 고속 협업을 죽일 위험.

**목표:** 멘션이 **정확히 한 번, 반드시** 대상 에이전트에 닿게. 두 배달 기전에 공유 완료 신호를 준다.

### 2a. 공유 "handled" 신호 — 이중 배달 + 거짓 exhaustion 제거
- **문제:** attached codex/opencode가 렌더러 paste + wake worker nudge 둘 다 받고, wake worker가 `nudgeExhausted`("사람에게 인계") 방송. `pickTarget`이 attached **claude만** 제외(`channelWakeWorker.ts:362`)하는데 렌더러 flush는 에이전트 무관. [감사 D-P1]
- **변경(v1.1 교체 — 2단계):**
  - **2a-1 (즉시, 렌더러 전용):** paste 템플릿이 에이전트에게 `a2a_task_query`가 아니라 **`channel_ack #chan up to seq N`을 지시**하도록 교체 — 현재 nudge 문구가 ack로 안 이끌어 커서가 영영 안 움직이는 것이 재-nudge 폭주의 절반. 에이전트가 스스로 ack하면 worker는 설계대로 정지.
  - **2a-2 (공유 nudge 원장, §D1):** 렌더러가 paste 성공 시 데몬에 "nudge 1회 발생" 신호(경량 RPC 1개 신설) → wake worker가 그 (channel, member)의 기존 nudge 예산/백오프에 **합산**. 즉시 이중 paste는 사라지고, 에이전트가 끝내 ack 안 하면 백오프 후 재-nudge·escalation은 **보존**(무-ack escalation은 버그가 아니라 기능).
  - **(기각) 렌더러가 paste 시 대신 `channel_ack` 발행** — ack는 "seq까지 전부 소비" 계약(`channel_ack` 문서: "do not ack past messages you have not seen")이라, 멘션 seq까지 강제 ack하면 에이전트가 안 읽은 이전 unread를 **삼킨다**. paste ≠ consume.
- **검증:** **도그푸드** — 단일 codex pane 워크스페이스에서 멘션 1회 → paste 정확히 1회, 즉시 이중 없음; 에이전트 무-ack 시 백오프 후 재-nudge는 발생해야 함(회귀 아님). 유닛: 원장 합산 후 worker 스케줄이 immediate가 아닌 백오프 슬롯.

### 2b. 제로 배달 — ws-level × attached Claude
- **문제:** paneId 없는 ws-level 멘션 × attached Claude = 어느 경로도 배달 안 함(badge만). 렌더러는 paneId 없으면 paste 안 함(`channelMentionFlush.ts:106`), wake worker는 attached Claude 제외(`channelWakeWorker.ts:372`). **Claude 재시작이 핀 paneId를 벗겨 ws-level로 강등**(`channelMentionInbox.ts:141`)시켜 조용히 유실. [감사 D-P1]
- **변경:** attached Claude가 사는 워크스페이스에 **live agent pane이 정확히 1개면** 렌더러가 ws-level 멘션도 그 pane에 배달(wake worker의 `eligible.length===1` 규율 미러). 다중이면 기존대로 큐 유지 + badge.
- **검증:** **도그푸드** — Claude pane 멘션 → 재시작 → 재멘션이 배달되는지. 유닛: 1-agent ws의 ws-level task가 target 해석.

### 2c. 무한 홀드 ceiling (hung agent)
- **문제:** `running`에 얼어붙은 에이전트로의 paste가 영원히 보류. ceiling이 unknown-status 브랜치에만 있음(`channelMentionPasteGate.ts:137`). [감사 D-P2]
- **변경(v1.1 정밀화):** ① known-busy 브랜치에 **별도 상수 `RUNNING_STALE_MS`(~180s — 45s보다 훨씬 보수)** 신설: `running`이어도 그 시간 output-quiet면 stale로 보고 배달 + **debug 로그 1줄**(TODOS의 "사일런트 지연 가시화" 항목과 합류). 진짜 thinking 에이전트는 상태줄/스피너로 계속 출력하므로 안 걸림. ② flap 리셋 픽스 — 일시적 known 상태 관측이 `firstUnknownAt`을 지워 45s ceiling이 매번 재시작(`channelMentionPasteGate.ts:140`) → **안정적 known이 K초 지속될 때만** 클리어. ③ `notePtyOutput`에서 DSR/CPR 질의-응답 에코(소량 버스트) 필터 — idle CPR 응답자가 quiet 게이트에 안 걸리게(ce8638d는 replay만 처리, 라이브 경로 미처리). [감사 D-P2 두 건 통합]
- **검증:** 유닛 — 'running' + 장시간 quiet → 배달(true→false 전이). 회귀: thinking 에이전트(주기적 출력)는 여전히 hold(941a639 레이스 미재발).

### 2d. 리로드 유실 + 부팅 미라우팅
- **변경:**
  - `channelMentionInbox.ts:215` `markChannelMentionHandled`를 **route 시점 → deliver 시점**으로 이동(또는 delivered set 영속). 리로드 시 미배달 멘션 재라우팅. [감사 D-P2]
  - `useChannelsEventSubscription.ts:347-350` primed 필터가 pre-mount 이벤트를 **표시**에서만 제외하고 **라우팅**은 수행(라우팅은 멱등). 밤새 온 멘션이 부팅 시 배달. [감사 D-P2]
- **검증:** 유닛 — held 상태 리로드 후 재라우팅. 도그푸드 — 앱 껐다 켜고 그 사이 온 멘션 배달.

### 2e. 타이핑 @토큰 유실 + 무매칭 피드백 (렌더러)
- **변경:** `Composer.tsx:253` 제출 시 본문의 `@<token>` 런을 후보 `insertToken`과 대조해 **자동 승격**; 무매칭 런은 인라인 "아무에게도 안 닿음" 피드백. `Composer.tsx:235` 무매칭 시 "멘션할 에이전트 없음" 힌트. [감사 C-C1/C2, 라이브 seq1/2]
- **검증:** 유닛 — 손타이핑 `@w26-1(claude)`가 mention으로 승격. GUI — 무매칭 토큰에 토스트.

### 2f. 루프스톰 종료자
- **변경:** rate cap(`channelMentionRateLimit.ts`)만으로는 ping-pong이 안 멈춤 → per-pair 멘션 체인 깊이 예산(휴먼 상호작용 시에만 보충) 또는 rate-capped pane이 "루프 의심" 1회 신호. [감사 D-P2]
- **검증:** 유닛 — A@B/B@A 반복이 N홉 후 정지. 도그푸드 — 두 에이전트 상호 자기소개가 무한 안 감.

**Phase 2 완료 기준:** 각 배달 경로(attached claude/codex, detached, ws-level, 재시작, 리로드, 부팅)에서 멘션이 정확히 1회 배달, 무한 홀드·거짓 exhaustion·루프스톰 없음.

---

## Phase 3 — 배달 상태 정직화 (영수증)

**목표:** `deliveryStatus`가 거짓말 안 하게. **결정 필요 §D2**: 죽은 `LocalPtyDelivery` 배선 vs 읽음-영수증으로 정직 재정의(권장).

### 3a. 발신자 자기 pending 제거
- **변경(v1.1 고정):** `ChannelService.ts:1243-1247` post 시 발신자 자기 `recipientSnapshot` 엔트리를 **`delivered`로 마킹**(제외 아님 — `viewerDeliveryStatus`가 자기 엔트리를 읽으므로(`ChannelView.tsx:87`) 제외하면 3c 없이는 자기 메시지 배지가 통째로 사라져 3a 단독 배포 불가). `message.deliveryStatus`가 "저장됨"을 정직 반영. [감사 A-F1, 라이브 seq35]
- **검증:** 유닛 — 발신자 post 직후 자기 pending 아님. 라이브 재현 — 최신 에이전트 답장이 "… sending"에 안 멈춤.

### 3b. 떠난 수신자 target_gone 기록
- **변경:** leave/kick/purgeMembership(`ChannelService.ts:803-988`)에서 그 워크스페이스의 잔여 `pending` 엔트리를 `target_gone`으로 sweep + `deliveryStatus` 재계산. `CHANNEL_MESSAGES_MAX` 바운드. [감사 A-F2]
- **검증:** 유닛 — 수신자 leave 후 그 엔트리 target_gone.

### 3c. 배지 정직화 (표시)
- **변경:** `ChannelView.tsx:554-563` 배지를 **자기 제외 수신자 엔트리 집계**(하나라도 delivered→delivered, 전부 target_gone→실패)로. ack 이벤트 push해 열린 발신자 뷰가 재열지 않고 갱신(`channelsSlice.ts:592`는 현재 무이벤트). 여유되면 "읽음 n/m" 칩(`lastReadSeq≥seq` 집계). [감사 C-D1/D2]
- **검증:** 도그푸드 — post 후 수신 즉시 배지 갱신(재열기 불필요).

**Phase 3 완료 기준:** 발신자 자기 메시지가 즉시 delivered, 떠난 수신자는 target_gone, 배지가 실제 수신/읽음 반영.

---

## Phase 4 — 멤버 수명주기 청소

### 4a. 부팅 reconcile 청소 (v1.1 교체 — 세션종료 훅 기각)
- **기각 사유:** 데몬 세션(pty) 종료 시 purge는 **에이전트 재시작 오폭** — pane은 pty 재시작을 넘어 존속하고(principal의 ptyId만 갱신, i18n `memberStaleTitle`: "Agent pane is gone or restarting"), pane 트리는 렌더러 소유라 데몬은 "pane 삭제"와 "재시작"을 구별할 수 없다. 세션 exit마다 purge하면 에이전트가 재시작할 때마다 채널에서 쫓겨난다.
- **변경:** **렌더러 부팅/attach 시 reconcile sweep** — 카탈로그 하이드레이션 직후, 멤버 행 중 ①로컬에 존재하지 않는 워크스페이스의 행 ②pane-principal이 그 워크스페이스의 live pane 트리에 해석 안 되는 행을 `purgeMembership`. 크래시/헤드리스 사이 놓친 정리를 다음 GUI attach에서 소급 커버(영구 헤드리스면 로스터를 보는 사람이 없으니 무해). 그 사이 표시는 4c liveness 회색이 담당. [감사 A-F3의 실제 갭 커버]
- **검증:** 유닛 — 죽은 ws/pane 행이 부팅 reconcile에 purge, 살아있는 행 유지, **pty 재시작(같은 pane) 행 유지**(오폭 회귀 가드). 도그푸드 — 앱 강제종료로 pane-close 이벤트를 유실시킨 뒤 재부팅 → 로스터 정리 확인.

### 4b. 주기적 빈 채널 reap
- **변경:** `ChannelStateWriter` prune 술어를 load 시 1회(`ChannelService.ts:347`) 외에 **저빈도 인터벌**(또는 leave/kick/purge가 채널 비운 직후 기회적)로. [감사 A-F4, 라이브 "test1" members:[] 잔존]
- **검증:** 유닛 — emptySince 7d 초과 채널이 인터벌에 purge.

### 4c. principalId 없는 멤버 liveness 표시
- **변경:** `ChannelMembers.tsx:391` principalId 없는 행(외부 MCP/레거시)에 "liveness 불명" 상태 렌더(현재 아무것도 안 함). "stale 제거" affordance. [감사 C-B2]
- **검증:** GUI — principalId 없는 죽은 멤버가 불명 상태로 구분됨.

---

## Phase 5 — 통합 휴먼 뷰 (활성-워크스페이스 종속 해소)

**목표:** 어느 워크스페이스를 봐도 채널 unread/멤버십/뷰가 동일. 배달은 이미 ws-독립인데(FIX-MULTI-WS) 휴먼 뷰만 활성-종속인 비대칭 해소. **결정 필요 §D3.**

- **문제:** 표시가 `activeWorkspaceId` 정체성에 묶임 — `planChannelMessageDelivery` appendToDisplay=활성만(`useChannelsEventSubscription.ts:114-116`), `selfWorkspaceId`=활성(`ChannelsPanel.tsx:691`), list/hydration이 활성 ws 질의. 휴먼이 워크스페이스별 `local-ui`로 흩어진 결과. [감사 §5, planChannelMessageDelivery]
- **변경:**
  - 5a. `appendToDisplay`를 "활성만" → **어느 로컬 ws든 멤버인 채널이면 표시**(union).
  - 5b. hydration/list를 로컬 ws **집합** 질의(union). `setChannels` 전체대체를 per-ws 하위캐시 → 병합된 휴먼 뷰로 리키(핵심 리스크).
  - 5c. 휴먼 멤버십을 활성 `local-ui` → **`human:me` principal**(또는 로컬 ws 집합)에 키잉. join/add/kick/self 판정 통일. `ChannelsPanel.tsx:718`이 `human:me`로 가입.
  - 5d. **(v1.1 추가) 쓰기 경로 스탬프:** union 뷰에서 post/leave 등 뮤테이션은 **그 채널의 멤버십을 실제 보유한 워크스페이스**를 해석해 스탬프(활성 ws 아님) — 아니면 "채널은 보이는데 활성 ws가 멤버가 아니라 post가 membership 게이트에 막힌다"는, 지금 없애려는 혼란이 union 뷰에서 재생산된다. 데몬 authz(workspace 기반)는 무변경.
- **검증:** **도그푸드** — WS A에서 채널 unread 본 뒤 WS B로 전환해도 같은 unread/멤버십. WS A가 든 채널 메시지가 WS B를 보는 중에도 badge. 유닛: union appendToDisplay 결정 케이스.
- **리스크:** 높음. 표시 캐시 리키 = 회귀 표면 넓음. Phase 5를 **맨 뒤 + 단독 PR**로 격리. `setChannels` 계약 변경이라 3모델 리뷰 필수.

---

## Phase 6 — 초대·권한·UX

- 6a. **초대 발견성:** 채널 헤더에 "멤버 추가" 라벨드 액션 + 빈 로스터 CTA + 생성 모달에서 멤버 시드. 현재 "Add an agent pane"은 존재하나 묻힘(`ChannelMembers.tsx:247`). [감사 C-B1]
- 6b. **피초대자 동의/private 제한:** invite-into-private을 채널 생성자/CEO로 제한하거나 피초대자 ack 요구. 인바이터가 피초대자 표시명 자유지정(`mcp/channels.ts:327`) 차단. [감사 B-초대]
- 6c. **CLI 누락 서브커맨드:** `invite/leave/create/get_members` 추가 또는 `CHANNEL_HELP`에 MCP-전용 명시. [감사 B-P3]
- 6d. **비멤버 프리뷰 정체성:** `ChannelView.tsx:696` `members[0]` 폴백이 남의 정체성으로 렌더 → 비멤버 프리뷰를 명시적 read-only 뷰로. [감사 C-E2]
- 6f. **(ship-리뷰 이월, 2026-07-05) 구조 개선 묶음:** ①`'local-ui'` 예약 id 5사이트 중복 → `shared/channels.ts` 단일 상수(1b 로스터 정체성과 함께) ②task title `' — mention from '` 파싱 커플링 → 메타데이터 channelName 구조화(1b) ③`isMentionPasteBusy` 9-positional 파라미터 → options 객체 ④멘션 토큰 charset을 computePaneAutoName 옆 공유 상수로 ⑤localStorage persist 배치(부팅 리플레이 N회 직렬화) ⑥Composer live-region pre-populated mount(스크린리더 미공지) ⑦부팅 리플레이/preMount 결정 순수함수 추출+테스트(리포 컨벤션) ⑧chmention taskId에 ws 성분 부재(멀티 ws-level 동시 멘션 충돌, 2b 이후 실질화). **문서화된 잔존 한계:** paste는 fire-and-forget이라 delivered 영속 마크가 ms-급 레이스에서 유령이 될 수 있음(리로드 안전망 제거의 대가, 희귀²) / post 직후 ~1s 창의 renderer-vs-worker 순서 역전 이중 paste(quiet 게이트가 대부분 차단) / ack 힌트가 멘션 seq 이하의 비멘션 unread를 건너뛰게 함(토큰 경제 트레이드오프).
- 6e. **(v1.1 추가) 소형 위생 묶음:** ①CLI `quietOwnMemberRows`가 일시 오류를 "비멤버"로 무신호 강등 → 오류/빈 결과 구분(`channel.ts:194-217`) [감사 B-P2] ②MCP post 결과 `droppedMentions`가 payload 파싱 없인 안 보임 → 드롭 시 결과 첫 줄에 경고 승격 [감사 B-P2] ③채널 열 때 히스토리 로드 전 "No messages yet" 플래시 → 로딩 상태(`ChannelView.tsx:490`) [감사 C-E1] ④`clearNudgesFor`가 모든 pty-close 사이트에 배선됐는지 확인(잔존 시 재사용 ptyId가 죽은 pane의 rate-limit 카운트 상속) [감사 D-P3] ⑤post 후 tail-trim 2차 save 실패 무시(`ChannelService.ts:1450`)에 로그 [감사 A-F5]
- **검증:** GUI — 초대 진입점 발견 가능, private 무단 편입 차단.

---

## Phase 7 — (선택) 메시지 수정·삭제

- **실질 갭:** 잘못 보낸 멘션 취소 불가(라이브 중복 `@w25-1(claude) hi` 2건). edit/delete additive.
- **범위 밖(설계 문서 의도적 제외):** 스레드/반응/DM/첨부/E2EE(`agent-collaboration-architecture-2026-07-03.md` §9 처분표). 이번 계획에 **넣지 않음** — 수요 확인 후 별도.
- **결정 필요:** edit/delete를 v1 범위에 넣을지.

---

## 결정 필요 (착수 전, 각 2택)

- **§D1 (Phase 2a, v1.1 교체):** 이중 배달 handoff를 (a) **공유 nudge 원장**(권장 — 렌더러 paste가 worker의 nudge 예산에 합산, escalation 보존, 경량 RPC 1개 신설) vs (b) pickTarget이 attached 전 에이전트 제외(RPC 불요하나 attached pane의 재-nudge/escalation 상실). 구 권장안 ack-on-paste는 **기각** — ack 계약("안 읽은 것 ack 금지") 위반 + 이전 unread 과잉소비.
- **§D2 (Phase 3):** deliveryStatus를 (a) **읽음-영수증으로 정직 재정의**(권장 — 죽은 LocalPtyDelivery 제거, "seen n/m") vs (b) LocalPtyDelivery 실제 배선(PTY 배달 상태는 본래 불안정).
- **§D3 (Phase 5):** 활성-ws 종속을 (a) **통합 휴먼 뷰 리키**(권장 — 근본 해소, 회사모드 불필요) vs (b) 회사모드를 기본 워크플로로 승격(CEO ws가 고정 정체성, 리키 회피하나 무거운 우회).

**권장 기본값으로 진행 가정.** 다르면 알려주면 해당 Phase만 조정.

---

## 배포·검증 규율 (요약)

- 순서(v1.1): **1a → P2 → 1b~1d → P3 → P4 → P5 → P6** (P7 별도 결정). 각 Phase 독립 PR.
- 데몬 변경: test-first + 단계별 3모델 리뷰 + additive 스키마.
- 배달/표시 변경: 사용자 dev 빌드 GUI 도그푸드 필수(`! npm start` 유지, MCP 도그푸드 불가).
- 각 단계: `npm run test` 그린 + `tsc` clean + 회귀 케이스 명시.
- 롤백: 전 Phase additive/렌더러-격리라 단위 롤백 안전. P5만 표시 캐시 리키라 별도 격리.
