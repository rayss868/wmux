# wmux 로드맵 — "Windows AI-에이전트 콕핏 1위" (2026-06-02 갱신)

> 작성일: 2026-06-02
> 기반: `plans/wmux-number-one-terminal-strategy-2026-05-29.md` (#1 전략) + `plans/wmux-nonnegotiables-execution-plan-2026-05-29.md` (실행계획)
> 갱신 근거: 2026-06-02 orchestrator 운영 세션 — office-hours(builder mode) + opus 3-전문가 적대적 검토. 핵심 결론:
> 1. `@wmux/orchestrator` SDK는 **곁가지**다. 고객(외부 Node 프로그램)이 없고, Claude Code·OpenClaw·Hermes는 전부 MCP를 직접 호출한다. → **동결 + `wmux-sdk` 리네임**, wmux MCP 프로토콜이 정문.
> 2. 원격 에이전트(OpenClaw/Hermes) 제어의 진짜 병목은 SDK가 아니라 **wmux 데몬의 원격 입구 부재**(현재 named-pipe + 127.0.0.1 전용, HTTP/auth 0). OpenClaw·Hermes는 둘 다 MCP 클라이언트라 wmux가 HTTP transport를 열면 SDK 없이 직접 붙는다.
> 3. `amirlehmam/wmux`(cmux 포트, ⭐148 > 당장 114)와 제품명·repo명 이중 충돌. 명분(이름 5일 선점)은 우리지만 인지도는 열세 → 차별화로 승부.
> 현재 상태: v2.16.2. non-negotiables 코드/서명 게이트(신뢰성·SHA-256 무결성·SignPath 서명·install.ps1·보안문서) 대부분 ship.

마커: ✅완료 · 🔜임박 · 🆕오늘 논의 반영 · ⚠️kill-criteria

---

## 북극성

> **자기 substrate를 먹어라(eat your own substrate).** wmux의 가장 깊은 자산(데몬측 OSC-133 시맨틱 이벤트 · CDP 브라우저 자동화)을, wmux 자신의 가장 눈에 띄는 기능(멀티에이전트 오케스트레이션)이 실제로 쓰게 만든다. 그게 amirlehmam·psmux·Warp 누구도 못 따라오는 차별화이자, 데모웨어를 진짜 플랫폼으로 바꾸는 한 수다.

```
지금(v2.16.2) ──▶ Phase 1 런치 ──▶ Phase 2 substrate먹기 ──▶ Phase 3 플랫폼개방 ──▶ Phase 4 내구해자
런치게이트 거의완료    0–2개월          2–6개월 ⭐                6–12개월              12–24개월
```

---

## Phase 0 — 지금 당장 (런치 게이트 잔여 + 곁가지 치우기)

대부분 코드는 이미 ship. 남은 건 비코드 산출물 + 정리.

- ✅ 신뢰성(partial-list 2-strike), 무결성(SHA-256 fail-closed), SignPath 서명, prebuilt installer, 보안문서 일치
- 🔜 **모션 데모 20–30초** — 3-pane 에이전트(Claude/Codex/Gemini) + 하나가 실제 브라우저 구동 + 완료가 OSC-133로 표면화. 런치 게이트 마지막 비코드 산출물, 최고 레버리지 전환 자산
- 🔜 퍼널 텔레메트리(NN6) — winget/choco/exe/소스 채널 분포 + 활성화율
- 🆕 **orchestrator 곁가지 정리 (10분)**: `wmux-orchestrator` → `wmux-sdk` 리네임 + soft-freeze 배너 + README line 123 강등(MCP를 정문으로). amirlehmam repo명 충돌 동시 해소

## Phase 1 — 런치 (0–2개월 · Thesis D 유통 척추)

*비어있는 카테고리를 선점. amirlehmam ⭐148 인지도 따라잡기.*

- 모션 데모 앵커 → **Show HN + r/ClaudeAI + r/commandline 조율 런치**
- 미니 랜딩 페이지(`wmux.dev` 등) + 이메일 캡처
- 생태계 등재: `awesome-claude-code`, `.claude-plugin/marketplace.json`, "Claude가 추천하는 Windows 멀티에이전트 런타임"
- 포지셔닝 전면 교체: "tmux 대안" → **"Windows 에이전트 콕핏"**
- 🆕 amirlehmam 차별화: 브라우저 자동화 · OSC-133 substrate를 헤드라인으로 (그쪽은 "그냥 cmux 포트")
- GitHub Sponsors / FUNDING.yml

## Phase 2 — 자기 substrate 먹기 (2–6개월 · 가장 깊은 차별화) ⭐

*데모웨어를 진짜 플랫폼으로. #1 전략이 꼽은 "가장 날카로운 한 수".*

- **Company mode를 OSC-133 `agent.lifecycle` 기반으로 재작성** (글자감시 ❯ · `setTimeout(8000)` · 자연어 프롬프트 주입 제거)
- **A2A 태스크 상태: 렌더러 Zustand → 데몬 원자적 스토어** (재시작 생존 — 오케스트레이션 플랫폼엔 필수, 현재 30분 GC + 500 cap으로 진행 상태 소실)
- 🆕 **a2a worker 일반화**: `ClaudeWorker`의 `spawn('claude')` 하드코딩 → openclaw/hermes adapter (위임 대상 확장, 기존 승인게이트·상태추적에 얹힘)
- 에이전트 감사/관측 레이어 (MCP 호출 append-only 로그: pane/plugin 신원+결과 + 멀티에이전트 대시보드: 라이프사이클 타임라인, live-session vs 1GB 예산)
- 입력측 승인 게이트 (dangerous-action을 PTY write *전* 차단 — 현재는 사후 토스트라 차단 불가)
- git-worktree 오케스트레이션 (상품화 중인 table-stakes 갭)
- 비용 대시보드 (5 에이전트 "놀랄 청구서" 방지 — 1GB 데몬 천장보다 월 청구서가 먼저 충돌 가능)

## Phase 3 — 플랫폼 개방 (6–12개월 · Thesis B 보험)

*외부 빌더·원격 에이전트가 붙는 문을 연다.*

- 🆕 **원격 MCP 입구**: Streamable HTTP transport(MCP SDK가 `StreamableHTTPServerTransport` 제공) + OAuth 2.1/bearer + explicit-workspaceId identity(PID-walk 대체). ⚠ MCP 서버만 HTTP로 열면 부족 — `wmux-client.ts`의 MCP→daemon 홉이 127.0.0.1 하드코딩이라 daemon 계층 원격 입구가 진짜 작업
- 데몬+OSC133 substrate를 렌더러에서 분리 (미래 셸 재작성 헤지 — Thesis B 값싼 보험)
- 🆕 (게이팅 충족 시) 원격 입구 위에서 **SDK를 HTTP로 재탄생** — stdio 부활 아님, 새로. 게이팅 신호 3개 AND: 원격입구 ship + 외부 이슈 ≥3 + named consumer
- 🎯 **플랫폼 증명 KPI**: 외부(non-wmux) 2번째 구현체가 `events.poll`+trust DB 소비

## Phase 4 — 내구 해자 / 지속가능성 (12–24개월)

- 오픈코어 **wmux Teams**: OSS 코어 MIT 유지 + 유료 티어가 Company/orchestrator/worktree/감사로그 수익화 (엔터프라이즈향 hard-to-clone 표면)
- (조건부) macOS — 니치 잠근 *후*에만, 척추 아니라 Phase 2 격
- IDE 위협 대응: 감사로그+worktree+MCP 워크플로우 관성으로 전환비용 심화 + 커뮤니티 기본값 지위

---

## ⚠️ 항상 가로지르는 것 (Kill / Pivot Criteria — #1 전략 §9)

- **18개월**: r/ClaudeAI·HN·Claude Code 문서에서 "Windows에서 Claude Code 여러 개"의 지명된 기본 답 아니면 → 순수 substrate/SDK로 피벗
- **EXISTENTIAL**: Anthropic/Cursor/Warp/MS가 Windows 1st-party 멀티에이전트 오케스트레이션 출시/축복 → 세션-데몬 신뢰성+감사 니치로 즉시 후퇴
- **신뢰성 stop-loss**: 런치 푸시 후 2번째 공개 파괴적 세션손실 = GTM 동결, 한 릴리스 사이클 신뢰성 올인
- **$0 실험**: 세션당 `browser_*` 호출률 → 브라우저(Thesis A) vs substrate(Thesis B) wedge 결정 게이트
- **플랫폼 12개월**: 외부 2번째 구현체 없으면 → 플랫폼/SDK 테제 폐기

---

## 한눈 요약

| Phase | 기간 | 한 줄 | 오늘 논의 반영 |
|---|---|---|---|
| 0 | 지금 | 런치 게이트 마무리 + 곁가지 정리 | 🆕 SDK 리네임·동결 |
| 1 | 0–2개월 | 런치 (유통 척추) | 🆕 amirlehmam 차별화 |
| 2 | 2–6개월 | **자기 substrate 먹기** ⭐ | 🆕 a2a worker 일반화 |
| 3 | 6–12개월 | 플랫폼 개방 | 🆕 원격 MCP 입구 + SDK 재탄생 |
| 4 | 12–24개월 | 내구 해자 + 수익화 | — |

**지금 당장 = Phase 0 셋**: ① orchestrator 리네임·동결(10분) ② 모션 데모 ③ 텔레메트리. 끝나면 런치.
