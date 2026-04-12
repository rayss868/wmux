# Decisions — v2.5 Features

## 2026-04-12: Phase 1 scope

### Features (4)
1. **Token/Cost Tracker** — 에이전트별 API 토큰/비용 실시간 표시
2. **Layout Presets** — 원클릭 멀티에이전트 워크스페이스 템플릿
3. **Shell Integration** — PowerShell/CMD/WSL CWD/git branch 자동 리포팅
4. **Onboarding Tutorial** — 첫 실행 단계별 안내

### Design Decisions

#### F1: Token/Cost Tracker
- **접근법**: A. stdout 파싱 (Claude Code 전용)
- **범위**: Claude Code만 지원. 다른 에이전트(Codex, Gemini 등) 미지원
- **데이터 소스**: PTYBridge에서 Claude Code 출력 스트림의 토큰 요약 라인을 정규식 캡처
- **이유**: 구현 간단, 의존성 없음, Claude Code가 핵심 타겟

#### F2: Layout Presets
- **접근법**: A. 하드코딩 프리셋 3~5개 (2-agent, 3-agent, code-review 등)
- **트리거**: 새 워크스페이스 생성 시 선택 UI
- **확장 계획**: 나중에 C(사용자 커스텀 저장/불러오기)로 확장
- **이유**: 빠른 구현, 핵심 시나리오 커버

#### F3: Shell Integration
- **접근법**: B. OSC 7 (CWD) + 커스텀 OSC (git branch)
- **셸 지원**: PowerShell, CMD, WSL/Bash
- **CWD**: OSC 7 표준 시퀀스 (다른 도구와 호환)
- **git branch**: wmux 전용 커스텀 OSC 시퀀스로 확장
- **주입 방식**: 셸 시작 시 훅 스크립트 자동 주입
- **이유**: 표준 호환 + wmux 전용 확장의 균형

#### F4: Onboarding Tutorial
- **접근법**: B. 인터랙티브 하이라이트 (Shepherd.js 스타일)
- **단계**: 4~5단계 (분할 → 브라우저 → 에이전트 → Layout Preset)
- **실제 UI 요소를 하이라이트하며 유도**
- **건너뛰기 가능, 설정에서 다시 보기 가능**
- **이유**: 체감 최고, F2와 시너지

#### Build Order
- F3 → F2 → F1 → F4 (architect-reviewer 권장)
- F3: OscParser 확장이 F1의 기반, 다른 의존성 없음
- F2: F4 온보딩의 전제조건 (Layout Preset 스텝)
- F1: PTYBridge onData 영역이 F3과 겹침 → F3 후 작업
- F4: F2 완료 후 구현 (튜토리얼에 프리셋 포함)

### Context
- 경쟁자(amirlehmam/wmux v0.4.0) 등장 → 차별화 필요
- 4인 패널(PM/마케터/투자자/기획자) 검토 후 15개 → 7개 압축
- Phase 1(NOW)은 위 4개, Phase 2(NEXT)는 Timeline/Landing/DangerApproval
