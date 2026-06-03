# wmux 로드맵 v2 (FINAL) — "1만 명이 쓰는 서비스로"

> 작성일: 2026-06-02 · **supersedes** `wmux-roadmap-2026-06-02.md` (v1)
> 기반: v1 + 4-시각 적대적 리뷰(codex 시도/계정제약 실패, opus×3: solo-reality / market-skeptic / sequencing-critic) + `wmux-number-one-terminal-strategy-2026-05-29.md`
> 목표(사용자 지정): **wmux를 1만 명이 쓰는 서비스로.**
> 작성 권한: 사용자가 "너의 추천으로 간다, 직접 짜라" 위임. 이건 추천안이며 최종 승인은 사용자.

## v1이 부서진 곳 (적대적 리뷰 종합 — 무엇을 고쳤나)

| 리뷰 발견 | 등급 | v2 대응 |
|---|---|---|
| Phase 2 = 240–405h = 24–40개월 (선언 2–6개월의 4–8배). 14 워크스트림 = #1전략이 경고한 13개 초과 | **사실** | Phase 2를 7개→**2개 critical-path**로 축소, 나머지 명시적 cut |
| 멀티에이전트가 demoware인데 Phase 1에서 공개 런치 → 자기 stop-loss 제조. 모션데모도 Phase 2에 블록 | **사실** | **INTERLEAVE**: 브라우저 웨지 먼저 런치, 멀티에이전트 헤드라인 보류. 데모=브라우저 |
| "Windows 멀티에이전트 콕핏" 카테고리를 Anthropic in-process + IDE 4개 + amirlehmam(같은이름+CDP) 잠식 | **사실+해석** | 북극성 재정의: 멀티에이전트 콕핏 → **브라우저 substrate 웨지** |
| CDP 브라우저 = 유일하게 경쟁 없는 자산, Cursor가 수요 증명, 외부 가시·20초 데모 | **사실** | **이걸 1순위 성장 엔진으로** 승격 |
| "10분 리네임" 거짓 (cross-repo, install path·npm·README 깨짐) | **사실** | alias+deprecate, hard-rename 금지 |

**핵심 전환: 헤드라인을 "멀티에이전트"에서 "any agent에게 진짜 브라우저"로 옮긴다.** wmux(터미널 멀티플렉서)는 버리지 않는다 — 브라우저 MCP가 *획득 깔때기*, wmux가 *심화 제품*.

---

## 북극성 (재정의)

> **"AI 에이전트에게 진짜 로그인된 브라우저와 영속 터미널을 주는 Windows substrate."**
> 1만 명 엔진 = **CDP 브라우저 MCP** (경쟁 없음 + 모든 에이전트 시장 + 진입장벽 0 + Cursor 검증). wmux 앱은 그걸 품은 풀 콕핏으로 백킹.

왜 1만 명에 이게 맞나: Electron 앱(SmartScreen·설치 마찰) 1만 설치는 어렵다. **MCP 서버(`npm install` 한 줄)는 모든 에이전트 사용자(Claude Code·Cursor·Warp·Codex)가 대상**이고 마찰이 0에 가깝다. 가장 넓은 시장 × 가장 낮은 마찰 × 경쟁 없음 = 1만 명의 유일한 현실 경로.

```
지금(v2.16.2) ─▶ Phase 0 무기장전 ─▶ Phase 1 브라우저웨지 런치 ─▶ Phase 2 신뢰성+정직화 ─▶ Phase 3 조건부확장
                  ~2주               1–2개월 (1만명 엔진)         2–4개월               신호 보고서
```

---

## Phase 0 — 무기 장전 + 곁가지 정리 (~2주)

- 🆕 **CDP 브라우저 분리 스파이크 (최우선 결정)**: `src/mcp/playwright/`가 Electron 없이 standalone Node MCP로 돌 수 있는지 검증. #1전략 §3-2가 "터미널과 독립적으로 가치 있는데 Electron 전체를 켜야 닿는다"고 지적한 그 분리.
  - **분리 가능** → standalone MCP 패키지로 (Phase 1 엔진).
  - **분리 과대** → 차선: wmux 내에서 브라우저를 헤드라인 + 경량 "browser-only" 런치 모드.
- 🔜 **20–30초 브라우저 모션 데모** — 에이전트가 실제 로그인 사이트를 보안 게이트 안에서 구동. **멀티에이전트 demoware는 안 보여줌**(정직하게 녹화 가능한 것만).
- 🔜 퍼널 텔레메트리 (채널 분포·활성화율) — 유통을 측정해야 관리.
- 🆕 **orchestrator alias-deprecate** (hard-rename 금지): 기존 `wmux-orchestrator`에 "frozen reference" 배너 + README line 123을 "MCP 도구 직접 호출"로 강등. npm/install-path 깨지 않게 alias만. (10분 아님, ~1시간 안전판)

## Phase 1 — 브라우저 웨지 런치 (1–2개월 · 1만 명 엔진) ⭐

*가장 넓고 경쟁 없는 자산을 가장 낮은 마찰로 푼다.*

- 🆕 **CDP 브라우저 MCP를 standalone 출시** — 새 이름(ungoogled·un-squatted, "wmux" 이름전쟁 우회). 포지셔닝: *"Give any AI agent a real, logged-in, security-gated browser on Windows. Logged, DNS-rebinding-hardened."*
- 발견 채널: **Show HN + awesome-mcp + awesome-claude-code + Cursor/Warp/Codex 커뮤니티** (Claude Code 한정 아님 — 모든 에이전트)
- wmux 앱은 "the full cockpit that bundles this browser + multiplexer + session persistence"로 백킹 (MCP → wmux 심화 경로)
- 미니 랜딩 + GitHub Sponsors/FUNDING
- 🆕 amirlehmam 차별화: 브라우저 **깊이**(보안 게이트·DNS-rebinding 방어·로그인 세션·트레이스/네트워크 47툴) — 그쪽 :9222 단순 프록시와 격차

**Phase 1 KPI = 1만 명 게이지**: MCP 설치/활성 수, awesome-* 등재, HN 상위, 브라우저 툴 세션당 호출률.

## Phase 2 — 신뢰성 + 멀티에이전트 정직화 (2–4개월)

*런치 트래픽이 노출할 것을 막고, demoware를 정직하게. 단 critical-path만.*

- 🔜 **신뢰성 잔여 수리** — split-brain daemon(`plans/duplicate-daemon-split-brain.md` 미구현), partial-list reconcile 잔여. 1만 명이 들어오면 stop-loss 1순위 리스크 → 리텐션 방어
- 🆕 **Company mode OSC-133 narrow rewrite** — `setTimeout(8000)`+❯-watch+자연어주입을 *주 경로만* `agent.lifecycle`로. 3중 복제 de-dup은 보류. 헤드라인 아님, "정직화"
- 🆕 **A2A 태스크 상태 → daemon store** (재시작 생존) — 단 이게 가장 큰 시간 sink(40–70h)라 **신뢰성 stop-loss가 한 사이클 조용해진 뒤** 착수
- ❌ **CUT (1만 명에 불필요·솔로 과부하)**: cost dashboard, git-worktree 오케스트레이션, 멀티에이전트 dashboard UI, audit/observability 레이어, input-side approval gate. 전부 "나중에 신호 보고".

## Phase 3 — 조건부 확장 (6개월+ · 신호 게이트)

*신호가 켜질 때만. 미리 짓지 않는다.*

- 브라우저 MCP가 채택되면 → **원격 입구(Streamable HTTP + auth)**. 이때 OpenClaw/Hermes·외부 빌더 unlock. (사용자 원래 목표는 여기서 충족 — 단 수요 확인 후)
- 멀티에이전트가 실수요면 → 심화 (Anthropic Agent Teams와 차별점 = 이종 에이전트 + 영속 + 브라우저)
- 수익화: Sponsors → (니치 잠근 후) 오픈코어 Teams
- (조건부) macOS — 니치 잠근 후

---

## ⚠️ Kill / Pivot Criteria (갱신)

- **브라우저 웨지 6개월**: MCP 활성 사용자가 미미하면 → 브라우저-헤드라인 기각, wmux 콕핏으로 회귀 재검토
- **EXISTENTIAL**: Anthropic/MS가 1st-party "agent browser for Windows"를 내면 → 보안 게이트·로그인-세션 깊이(그들이 안 하는 것)로 후퇴
- **신뢰성 stop-loss**: 런치 후 2번째 공개 파괴적 세션손실 = GTM 동결, 한 사이클 신뢰성 올인
- **이름**: "wmux" 검색이 계속 클론에 묻히면 → 브라우저 MCP의 새 이름을 1차 브랜드로, "wmux"는 부차

## KPI (1만 명 중심)

| 지표 | 목표 |
|---|---|
| **브라우저 MCP 활성 사용자** | 1k(3개월) → 10k(12개월) — **1만 명 주 게이지** |
| awesome-* 등재 | ≥3 (mcp·claude-code·windows) |
| 브라우저 툴 세션당 호출률 | 웨지 검증(A vs 콕핏) |
| 신뢰성 SLO | 90일 롤링 파괴적 세션손실 0 |
| 전환 | MCP 사용자 → wmux 앱 설치율 |
| 지속가능성 | Sponsors live |

---

## 한눈 요약

| Phase | 기간 | 한 줄 | vs v1 변화 |
|---|---|---|---|
| 0 | ~2주 | 브라우저 분리 스파이크 + 데모 + alias 정리 | 리네임 안전판화, 데모=브라우저 |
| 1 | 1–2개월 | **브라우저 MCP 런치 = 1만 명 엔진** ⭐ | 헤드라인 멀티에이전트→브라우저 |
| 2 | 2–4개월 | 신뢰성 + 멀티에이전트 정직화 (critical만) | 7개→2개, 5개 cut |
| 3 | 신호 후 | 원격 입구·멀티에이전트 심화·수익화 | 전부 신호 게이트 |

**한 문장**: 1만 명은 멀티에이전트 콕핏(Anthropic이 잠식)이 아니라, **경쟁 없는 CDP 브라우저를 모든 에이전트에게 마찰 0으로 푸는 것**에서 온다. 멀티에이전트는 정직하게 고치되 헤드라인을 양보하고, 솔로의 시간을 유통과 그 한 웨지에 집중한다.
