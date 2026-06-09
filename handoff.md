# Handoff — 색상 커스터마이징 인스펙트 모드

## Session State
- **current_phase**: 3 (Implementation) — PR1 시작
- **completed_tasks**: Phase 0 (branch from main, 폰트 격리, records)
- **blocked_items**: (none)
- **next_steps**: PR1 teammate(frontend-developer, opus) 스폰 → 검증 → PR2
- **active_worktrees**: (none — PR1 단일 teammate 순차)

## Branch
- `team/2026-06-08/color-safety-nets` (PR1, main 9d97f81 기반)
- 폰트 작업(`c5d122e` #147)은 이 브랜치에 **없음** (격리됨)

## Spec
- 정본: `plans/color-customization-inspect-mode.md` (Review Decisions LOCKED = 계약)
- 결정: `decisions.md` / 진행: `progress.md`

## Gotchas
1. push/PR/release는 사용자 확인 후. teammate는 git commit 금지 (Leader가 git 담당).
2. commit/PR/주석 영어, 대화 한국어.
3. git add 명시 — out-dogfood/ 등 untracked 잡파일 휩쓸기 금지.
4. SettingsPanel.tsx 라인번호는 main 기준으로 재확인(심볼명으로 탐색): CustomThemeEditor, TokenRow, TailwindSwatchPicker, StatusBadge.
5. 좌표/canvas/하이라이트(PR2)는 jsdom 불가 → GUI dogfood.
6. i18n: en.ts 필수, 타 로케일은 auto-fallback(en) 허용.

## Key Files
- `src/renderer/tailwindPalette.ts` (luminance/isLight ~92, shiftLightness, mixHex)
- `src/renderer/components/Settings/SettingsPanel.tsx` (CustomThemeEditor, TokenRow, StatusBadge, TailwindSwatchPicker)
- `src/renderer/themes.ts` (builtinToCustom, deriveFullPalette, UI_THEME_TOKENS)
- `src/renderer/i18n/locales/en.ts`
- `src/renderer/__tests__/themes.test.ts` (local contrastRatio ~42 → import 전환)
