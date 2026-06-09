# Progress — 색상 커스터마이징 인스펙트 모드 (2026-06-08)

## Summary
- **Phase**: 5 완료 — **로컬 main에 FF 머지(8a14337)**. origin push는 사용자 확인 대기
- dogfood fix 2건: 터미널 어두운 프레임(ae0b0fb, 컨테이너 배경=xterm), 인스펙트 picker 통과(8a14337, 루트 pointer-events:none → Done 없이 색선택 + 테두리 선택)
- **동적검증**: inspectOverlay.dynamic.test.tsx — 실제 오버레이 createRoot 런타임 12시나리오 구동, 제품버그 0 (3b3ab27)
- **최종 회귀**: 2523 pass / 4 fail (전부 daemon/main win32 timer flaky, renderer 전용 diff 무관, tsc clean)
- **PR2 8커밋**: a9e922a→d561a14→5bf07bf→65ba344→456efba→44b0874(리뷰수정)→3b3ab27(동적하니스), base 3aba1e0(PR1)
- **Branch**: PR1 `team/2026-06-08/color-safety-nets` (3aba1e0 ✓) → PR2 `team/2026-06-08/color-inspect`
- **Base**: `main` (9d97f81)
- **Size**: Large (Phase 1·2 = plan-eng-review로 등가 완료)
- **Done**: 9/9 (PR1 T1·T2·T3 + PR2 F1·F2a·F2b·F3·F4) | In Progress: Phase 4 리뷰 | Blocked: 0
- **Spec**: `plans/color-customization-inspect-mode.md` (Review Decisions LOCKED = 계약)
- **PR1 검증**: 색상 테스트 34 pass, tsc clean, 회귀 0
- **PR2 커밋**: a9e922a(F1 foundation) d561a14(F2a overlay) 5bf07bf(F2b settings) 65ba344(F3 marking) 456efba(F4 glue+invariants)
- **전체 회귀**: 2497 pass / 4 fail (전부 daemon/main win32 timer flaky — renderer 전용 diff라 무관, tsc clean)
- **F4가 잡은 P0**: pick이 exitInspect 호출 → 1클릭에 인스펙트 종료 버그 수정 + 캡처 양보 글루

## DAG
```
# PR1 (color-safety-nets, main 기반)
T1 (getContrastRatio 승격):        []
T2 (대비 배지 + i18n):             [T1]
T3 (프리셋/per-token 리셋 + i18n): []         # SettingsPanel 공유 → T2와 순차

# PR2 (color-inspect, PR1 기반)
S2 (tokenAttrs+파생맵+findToken):  []
S3 (uiSlice 상태머신):             [S2]
S5 (9 컴포넌트 표식):              [S2]
S4 (InspectOverlay+AppLayout):     [S2, S3]
S5b (SettingsPanel 진입+ESC억제):  [S2, S3, PR1머지]
S6 (CI 불변식 + ESC 회귀 + 통합):  [S4, S5, S5b]
```

## Phases
- [x] Phase 0: Init (branch from main, 폰트 격리, records)
- [ ] Phase 3: Implementation
  - [ ] PR1: T1 → T2/T3 (one frontend teammate, 결합도 기준 batch)
  - [ ] PR2: S2 → (S3 ∥ S5) → (S4 ∥ S5b) → S6
- [ ] Phase 3.5: 병합 (PR1 검증 → PR2 분기)
- [ ] Phase 4: code-reviewer 전체 리뷰
- [ ] Phase 5: 마무리 (전체 테스트 + ship 옵션, push는 사용자 확인)

## By Module

### PR1 — 안전망 (color-safety-nets)
- [ ] T1 getContrastRatio export (`tailwindPalette.ts`) + `themes.test.ts` import 전환 + 단위
- [ ] T2 대비 배지 (`SettingsPanel.tsx` CustomThemeEditor, StatusBadge 재사용, surface별 쌍, <AA amber/<3:1 assertive, "안전한 명도로" nudge) + i18n + 테스트
- [ ] T3 프리셋/per-token 리셋 (`SettingsPanel.tsx`, builtinToCustom, undo dot) + i18n + 테스트
- 검증: `npx tsc --noEmit` + `npx eslint` + `npx vitest run` 관련 + dogfood

### PR2 — 인스펙트 (color-inspect)
- [ ] S2 `tokenAttrs(token,role)` + 파생→소스 맵 + `findTokenForElement` (`themes.ts`) + 단위
- [ ] S3 uiSlice inspect 상태머신 (enter/exit/배타/teardown, builtin→custom seed) + 단위
- [ ] S5 9 컴포넌트 tokenAttrs 표식 (Sidebar/MiniSidebar/StatusBar/Pane/SurfaceTabs/Terminal래퍼/CommandPalette/NotificationPanel/FileTreePanel)
- [ ] S4 `InspectOverlay.tsx` + `AppLayout.tsx` 마운트 (캡처레이어/elementsFromPoint/호버하이라이트+칩/클릭 disambiguation/터미널영역/포커스탈취/roving-tabindex/rAF rect sync/ESC/cleanup)
- [ ] S5b `SettingsPanel.tsx` 인스펙트 진입 버튼 + ESC 억제 + TokenRow tokenAttrs + 타깃 scroll/flash
- [ ] S6 CI 불변식(data-token∈tokens, 토큰10개 각≥1) + **ESC 회귀(필수)** + 통합 테스트

## Notes
- push/PR/release는 사용자 확인 후 (memory feedback_push_confirm).
- commit/PR/주석 영어, 대화 한국어 (memory feedback_pr_commit_english).
- git add 명시 (memory feedback_git_add_explicit) — out-dogfood/ 등 untracked 잡파일 휩쓸기 금지.
- 좌표/canvas/하이라이트 = GUI dogfood (jsdom 불가).
