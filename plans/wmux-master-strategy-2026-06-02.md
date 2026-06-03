# wmux 마스터 전략 — "AI 코더의 Windows 터미널 1위"

> 작성일: 2026-06-02 · **supersedes** roadmap v1/v2-final
> 목표(사용자 지정): **Windows 터미널 1위.**
> 근거: `wmux-number-one-terminal-strategy-2026-05-29.md`(#1 전략) + 실제 사용자 증거(GitHub 트래픽/이슈/기여자 + Reddit r/ClaudeAI 런치 댓글) + 4-시각 적대적 리뷰(opus×3) + orchestrator 운영 세션
> 작성 권한: 사용자가 "너가 판단하라" 위임. 판단은 결정적으로 내림. 최종 승인은 사용자.

---

## 0. 목표의 정직한 정의 (전략 전체의 토대)

| 1위 해석 | 가능? | 판단 |
|---|---|---|
| Windows 터미널 *종합* 1위 (Windows Terminal 제치기) | ❌ 불가능 | OS 선탑재·무료·서명된 103K★ 인커번트. 솔로가 못 이김 |
| **AI로 코딩하는 Windows 개발자가 *여는* 터미널 1위** | ✅ **가능·증거 있음** | Windows AI 개발자의 페인이 실재(Reddit), 1st-party 미흡, AI 코딩 주류화로 시장 급성장 |

> **비전: "Windows Terminal은 OS의 기본. wmux는 AI 코더의 기본."**
> "1위"의 측정 = r/ClaudeAI·검색·AI 추천에서 *"Windows에서 Claude Code/Codex/Gemini 여러 개 돌리는 법"의 지명된 기본 답*이 wmux가 되는 것. AI 코딩이 개발의 주류가 될수록 이 1위는 "Windows 개발자 터미널 1위"에 수렴한다.

---

## 1. 증거 — 누가, 왜 쓰나 (가설 아님, 데이터)

**GitHub (14일):** view 719 uniq / **clone 502 uniq**(비정상 높은 clone률 = 실제 빌드 시도) · 발견 = Google 287 + **Reddit 110** + AI추천(chatgpt/claude/perplexity) ~40 · 능동 외부 기여자 5~6명.

**실제 사용자 = Windows AI 개발자 (한국 초기 베이스 → 글로벌 페인):**
- 능동 기여자: alphabeen(서울, 아주대, MLOps/AI infra), cloim(KiBaek Shin), junbeom09(조준범), dev-minggyu, margvez(보안 대형 PR), sodam-ai. → 한국 AI 개발자 코어.
- Reddit 댓글(영어권): dogazine, madpeppers013. → 글로벌로 같은 페인.

**가장 강력한 페인 (Reddit madpeppers013):**
> "Windows user인데 우리는 *항상 세 걸음 뒤처진* 느낌이다 — 좋은 AI 코딩 도구는 전부 macOS만 나오니까."

**wmux가 푸는 정확한 문제 (OP 답):** WSL(tmux)의 마찰 — agent 연결 + 세션 영속 — 을 **네이티브 Windows에서** 제거. 그리고 **비침습 wrap** (Ill-Leadership/PAI: "config 안 건드리고 CC 세션을 wrap만").

**가장 강한 외부 기능 요청 (alphabeen #15):** *"AI automation이 아니라"* — pane metadata + JSON-RPC events + read-only buffer 접근 = **외부 개발자 도구가 빌드할 generic 터미널 primitive.**

**우려 (dogazine + alphabeen #22):** Electron 성능 + 안정성(세션 누적 버그로 unusable). → 리텐션의 최대 리스크.

---

## 2. 두 번의 헛다리에서 배운 것 (이 전략이 피하는 함정)

세션 중 검증으로 기각된 베팅:
- ❌ "멀티에이전트 콕핏 1위" → Anthropic Agent Teams(in-process·무료·터미널 불필요)가 잠식.
- ❌ "CDP 브라우저 단독 MCP = 1만 명 엔진" → 레드오션(MS/Google 공식 Playwright/Chrome DevTools MCP).
- **교훈: 솔로는 1st-party와 *기능* 경쟁을 못 이긴다.** 모든 개별 기능엔 거대 경쟁자가 붙는다.
- **그래서 이 전략은 기능이 아니라 *페인 + 통합 + 커뮤니티*로 이긴다.** 1st-party가 안 하는 것: Windows 네이티브 특화 × AI 코더 워크플로우 × 비침습 wrap × 커뮤니티 × 외부도구 생태계.

---

## 3. 차별화 & 경쟁 매트릭스

| 경쟁자 | 그들의 강점 | wmux가 이기는 지점 | 위협 |
|---|---|---|---|
| **Windows Terminal** (MS, 선탑재) | 무료·기본·서명 | AI 코더 특화 X, 세션영속 X, agent-aware X | 🔴 MS가 agent 붙이면 → 우리가 먼저+깊게 |
| **psmux** (네이티브 Rust) | 빠름·네이티브·tmux호환·CC팀 통합 | **브라우저+MCP+관측성 없음** + 커뮤니티 선점 | 🟠 패리티 클럭 — 속도가 핵심 |
| **IDE 멀티에이전트** (Cursor/VS Code) | 75.9% 거주 | "에디터 밖 터미널 우선" 사용자 + 비침습 wrap | 🔴 카테고리 잠식 — 터미널파를 지킨다 |
| **Anthropic Agent Teams** | in-process·무료 | **이종 에이전트**(CC+Codex+Gemini) + 시각 pane + 영속 | 🟠 단일진영. 이종+영속이 차별 |
| **amirlehmam/wmux** (cmux 포트, ⭐148) | 같은 이름·더 많은 별·CDP 프록시 | **깊이**(47툴·보안게이트·관측성) + 진짜 substrate | 🟡 이름전쟁 — 깊이로 차별 |

**유일하게 방어 가능한 교집합 = Windows 네이티브 × AI 코더 × (멀티플렉싱+세션영속+브라우저+MCP 번들) × 비침습 × 커뮤니티.** 어느 경쟁자도 이 전부를 갖지 못한다.

---

## 4. 5대 전략 축

**축 1 — 핵심 페인 해결 (이미 됨, 강화):** WSL 없이 네이티브 Windows에서 AI 에이전트 멀티플렉싱 + 세션 영속. 포지셔닝을 이 페인("macOS에 뒤처짐")에 정조준.

**축 2 — 안정성 = 리텐션 엔진:** Electron 성능 우려 + 세션 버그(alphabeen #22)가 최대 이탈 리스크. 신뢰성이 곧 입소문. "한 번도 세션 안 잃는다"가 1위의 전제.

**축 3 — 발견 = 유통:** Reddit + AI추천 + 검색이 이미 작동. 증폭한다. 솔로의 cheapest 레버.

**축 4 — 번들 가치 (단독 기능 경쟁 회피):** "wmux 하나면 멀티플렉싱+세션영속+브라우저+MCP+CC가 다 된다." **브라우저는 단독 엔진이 아니라 번들의 강력한 한 기능**(dogazine "actually useful if stable"). 통합이 1st-party 단품을 이기는 지점.

**축 5 — 외부도구 생태계 = lock-in:** alphabeen #15(pane metadata + events + buffer)를 외부 개발자가 빌드하는 substrate로. 생태계가 전환비용이자 "2번째 구현체 = 플랫폼 증명."

---

## 5. 실행 로드맵 (솔로 현실 — Phase당 2~3개, 과적재 금지)

> 적대적 리뷰 교훈: 기능 14개 나열 금지. 안정성·유통 우선, 기능은 있는 것 강화·새것 최소. 큰 항목(A2A daemon store 등)은 신뢰성이 조용해진 뒤.

**M0 — 지금 (0~1개월): 신뢰성 + 발견**
- 🔴 **안정성 잔여 박멸** — split-brain daemon(`plans/duplicate-daemon-split-brain.md`), 세션 누적(alphabeen #22 계열). 1위 전제. *최우선.*
- **번들 모션 데모 20~30초** — 멀티플렉싱+세션영속+브라우저+CC를 한 화면에. (멀티에이전트 demoware는 안 보임 — 정직)
- **포지셔닝 교체** → "The native Windows terminal for AI coding. No WSL. Sessions survive. Claude Code/Codex/Gemini, multiplexed."

**M1 — 유통 (1~3개월): 커뮤니티 온램프 + 생태계 씨앗**
- **발견 증폭**: r/ClaudeAI 재런치(데모 앵커) + awesome-claude-code/awesome-mcp 등재 + AI추천 최적화(README가 "Windows에서 CC 여러 개"의 답이 되게)
- **커뮤니티 온램프**: Discord + issue 템플릿 + good-first-issue(ligature/프로파일 같은 table-stakes를 기여자에게) — 버스팩터 해소(2번째 커미터)
- **alphabeen #15 외부도구 API 완성**(이미 일부 구현 — pane metadata/events) + 문서화. 생태계 입장권.

**M2 — 굳히기 (3~6개월): SLO + 글로벌 확장**
- **신뢰성 SLO 공개** — 90일 롤링 세션손실 0, 공개 신뢰성 페이지. (불안정이 1위의 적)
- **글로벌 확장** — 한국 베이스 검증된 메시지를 영어권 Windows AI 개발자로(Reddit 증거). 메인테이너 스토리.
- **번들 기능 강화** — 브라우저 안정화(dogazine "if stable"), 외부도구 1~2개 실제 연동.
- 큰 항목 해금(신뢰성 조용해지면): A2A daemon store, Company mode OSC-133 정직화.

**M3 — 지속가능성 (6~12개월): 수익화 + 1위 측정**
- Sponsors → (니치 잠근 후) 오픈코어 wmux Teams(엔터프라이즈 표면)
- (조건부) 원격 입구(HTTP) — 외부 빌더/원격 에이전트 수요 신호 시
- (조건부) macOS — Windows 1위 굳힌 후

---

## 6. ⚠️ Kill / Pivot Criteria & 1위 측정 (KPI)

**Kill:**
- 18개월에 "Windows에서 CC 여러 개"의 지명된 기본 답이 아니면 → substrate/생태계로 피벗
- 런치 후 2번째 공개 세션손실 = GTM 동결, 신뢰성 올인
- MS가 Windows Terminal에 세션영속+agent-aware 추가 → 깊이(브라우저+관측성+이종에이전트)로 후퇴
- psmux가 브라우저+MCP 패리티 → 커뮤니티/생태계 lock-in으로 방어

**1위 KPI:**
| 지표 | 목표 |
|---|---|
| **활성 사용자** | 1k(3mo) → 10k(12mo) |
| **"기본 답" 점유** | r/ClaudeAI·검색·AI추천 ≥3곳에서 Windows-CC 질문의 1순위 추천 |
| **신뢰성 SLO** | 90일 롤링 파괴적 세션손실 0 |
| **생태계 증명** | 외부(non-wmux) 도구 ≥1이 #15 API(events/metadata) 소비 |
| **커뮤니티** | Discord 활성 + 2번째 코어 커미터 + 기여 PR 흐름 |
| **지속가능성** | Sponsors live → 첫 Teams 시트 |

---

## 7. 즉시 행동 (Next 30일)

1. **안정성 잔여 박멸** (split-brain + 세션 누적) — 1위의 전제. 코드 작업 1순위.
2. **번들 모션 데모** 제작 — 유통의 앵커.
3. **포지셔닝 한 줄 교체** ("native Windows terminal for AI coding, no WSL") — README/랜딩.
4. **orchestrator alias 정리** (곁가지 10분→1시간 안전판) — `wmux-orchestrator`에 frozen 배너, MCP를 정문으로.
5. **Discord + issue 템플릿** — 커뮤니티 온램프 착수.

> 한 문장: wmux는 Windows Terminal을 못 이기지만, **"AI로 코딩하는 Windows 개발자가 여는 터미널"의 1위는 될 수 있다** — 1st-party와 기능 경쟁이 아니라, 그들의 구체적 페인(macOS 뒤처짐) × 통합 번들 × 안정성 × 커뮤니티 × 외부도구 생태계로. 증거가 이미 그 방향을 가리킨다.
