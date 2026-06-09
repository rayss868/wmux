# Decisions — 색상 커스터마이징 인스펙트 모드 (2026-06-08)

> 정본 설계 + LOCKED 결정: `plans/color-customization-inspect-mode.md` (§ Review Decisions LOCKED)
> 이 파일은 팀모드 실행 결정만 추가 기록.

## 팀모드 실행 결정
- **크기**: Large (Full Path). Phase 1·2는 plan-eng-review로 등가 완료(아키텍처 결정 LOCKED + 외부검증 + DAG) → 채택, skip.
- **base 브랜치**: `main` (9d97f81). 폰트 작업(`c5d122e` #147)과 완전 격리.
- **2 PR 분리** (D-scope):
  - PR1 = `team/2026-06-08/color-safety-nets` (main 기반): 대비 배지 + 프리셋/per-token 리셋 + getContrastRatio 승격 + i18n.
  - PR2 = `team/2026-06-08/color-inspect` (PR1 기반): 인스펙트 오버레이 전체.
  - 이유: SettingsPanel·uiSlice·en.ts 공유 → PR1 먼저, PR2가 그 위에. 독립 리뷰 + blast radius 축소.
- **ship 게이트**: push/PR/release는 사용자 확인 후. 구현·검증은 끝까지.
- **테스트**: 순수 로직 jsdom 100% + ESC 회귀 필수. 좌표/canvas/하이라이트는 GUI dogfood.

## 핵심 LOCKED 결정 (구현 계약)
- 역매핑: `data-token-*` 속성이 유일 SoT + 작은 파생→소스 맵. 별도 레지스트리 X.
- 표식: 타입드 `tokenAttrs(token, role)` 헬퍼(토큰명 컴파일타임 강제).
- 히트테스트: `elementsFromPoint` + 오버레이 필터.
- 호버: 대표역할(기본 배경) 미리보기 + 클릭 시 채움/글자/테두리 메뉴.
- Settings: 인스펙트 시 축소 플로팅 바(마운트 유지), ESC=인스펙트만 이탈→전체 복귀(Settings ESC 억제).
- 포커스: active pane blur + 오버레이 포커스 탈취 + roving-tabindex 프록시(프로덕션 tabindex 미변경).
- 빌트인 진입: `builtinToCustom`+`setTheme('custom')` 선행(아니면 silent no-op).
- 배타: 인스펙트=최상위 배타 모드, 팔레트/알림/prefix suppress, 워크스페이스 전환 teardown.
- 터미널: 영역 클릭→xterm 배경/전경 v1(글자별 ANSI v2).
- 칩: "표식된 N곳"(부분집합 명시).
- 성능: pointermove 토큰변경 시만 재계산+rAF, rect rAF 루프 sync, 리스너 정리.
