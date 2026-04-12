# Progress — v2.5 Features

## Summary
- Phase: 2 (계획 확정)
- Done: 0/17 | In Progress: 0 | Waiting: 17 | Blocked: 0

## DAG
```
F0-1 (PTYBridge onData 파이프라인 리팩토링): []
F3-1 (shell hook scripts): []
F3-2 (OscParser 확장 + PTYBridge 연동): [F3-1, F0-1]
F3-3 (hook 자동주입 + ShellDetector 연동): [F3-1]
F3-4 (F3 테스트): [F3-2, F3-3]
F2-1 (프리셋 정의 + 팩토리): []
F2-2 (workspaceSlice 확장 + 선택 UI): [F2-1]
F2-3 (F2 테스트): [F2-2]
F1-1 (TokenTracker 클래스): []
F1-2 (PTYBridge 연동 + IPC 채널): [F1-1, F0-1]
F1-3 (tokenSlice + UI 표시): [F1-2]
F1-4 (세션 영속성): [F1-3]
F1-5 (F1 테스트): [F1-3]
F4-1 (OnboardingOverlay 컴포넌트): [F2-2]
F4-2 (스텝 정의 + 하이라이트 로직): [F4-1]
F4-3 (uiSlice 확장 + 설정 연동): [F4-2, F1-4]
F4-4 (F4 테스트): [F4-3]
```

## Parallelization Plan
```
Wave 1 (동시): F0-1, F3-1, F2-1, F1-1          ← 4개 worktree
Wave 2 (동시): F3-2, F3-3, F2-2, F1-2           ← 4개 worktree (F0-1 완료 후)
Wave 3 (동시): F3-4, F2-3, F1-3, F4-1           ← 4개 worktree
Wave 4 (동시): F1-4, F1-5, F4-2                  ← 3개 worktree
Wave 5 (순차): F4-3 → F4-4                       ← types.ts 충돌 방지
```

## By Feature

### F0: 리팩토링 (선행)
- [ ] F0-1: PTYBridge onData 미들웨어 패턴 리팩토링
  - Files: src/main/pty/PTYBridge.ts
  - 방법: onData 내 5개 파서(activity, osc, agent, prompt, [future]) → addMiddleware(handler) 패턴으로 분리
  - 검증: 기존 테스트 통과 + 동작 변경 없음

### F3: Shell Integration
- [ ] F3-1: Shell hook 스크립트 작성
  - Files: src/main/pty/shell-hooks/pwsh.ps1, bash.sh
  - 방법: PowerShell/Bash: OSC 7 (CWD) + 커스텀 OSC 7727 (git branch). CMD: PROMPT 환경변수로 OSC 7 (CWD만, git branch 미지원)
  - 검증: 스크립트 수동 실행 시 올바른 OSC 시퀀스 출력 확인
- [ ] F3-2: OscParser 확장 + PTYBridge 연동
  - Files: src/main/pty/OscParser.ts, src/main/pty/PTYBridge.ts, src/shared/constants.ts
  - 방법: OscParser의 emitOsc에서 OSC 7727 → gitBranch 메타데이터로 전달. PTYBridge 미들웨어로 등록
  - 검증: OscParser 단위테스트
- [ ] F3-3: Hook 자동주입 + ShellDetector 연동
  - Files: src/main/pty/PTYManager.ts, src/main/pty/ShellDetector.ts
  - 방법: PTY 생성 시 셸 종류 감지 → 환경변수(WMUX_SHELL_HOOK)로 hook 스크립트 경로 전달 → PowerShell: -Command ". hook.ps1", Bash: --rcfile, CMD: AutoRun 레지스트리 대신 환경변수 PROMPT 직접 설정
  - oh-my-posh 등 기존 OSC 7 설정 중복 방지: 환경변수 WMUX_SHELL_HOOK_ACTIVE 체크
  - 검증: PTY 생성 후 CWD 변경 시 OSC 7 수신 확인
- [ ] F3-4: F3 통합 테스트
  - Files: src/main/pty/__tests__/
  - 검증: OscParser + hook 스크립트 시나리오

### F2: Layout Presets
- [ ] F2-1: 프리셋 정의 + 팩토리 함수
  - Files: src/shared/layoutPresets.ts
  - 방법: Pane 트리를 직접 생성하는 순수 함수. 프리셋: 2-agent(좌우 50:50), 3-agent(좌50:우상하25:25), code-review(좌60:우40 터미널+브라우저), browser+terminal(상60:하40)
  - sizes 필드 포함
  - 검증: 유닛 테스트
- [ ] F2-2: workspaceSlice 확장 + 선택 UI
  - Files: src/renderer/stores/slices/workspaceSlice.ts, 새 파일: src/renderer/components/Sidebar/PresetPicker.tsx
  - 방법: addWorkspaceWithPreset(presetId) → rootPane에 프리셋 트리 직접 할당. Sidebar + 버튼에 드롭다운 연결. 모든 leaf pane에 PTY 자동 생성
  - 검증: UI에서 프리셋 선택 → 올바른 레이아웃 생성 확인
- [ ] F2-3: F2 테스트
  - Files: src/shared/__tests__/, src/renderer/stores/slices/__tests__/
  - 검증: layoutPresets 유닛 + workspaceSlice 통합

### F1: Token/Cost Tracker
- [ ] F1-1: TokenTracker 클래스
  - Files: src/main/pty/TokenTracker.ts
  - 방법: AgentDetector gate 패턴 동일. Claude Code gate 활성 시에만 토큰 regex 실행. 파싱 실패 시 graceful degradation (이벤트 미발생, 에러 미전파)
  - 검증: 유닛 테스트
- [ ] F1-2: PTYBridge 연동 + IPC 채널 + preload 노출
  - Files: src/main/pty/PTYBridge.ts, src/shared/constants.ts, src/preload/index.ts (또는 preload.ts)
  - 방법: PTYBridge 미들웨어로 tokenTracker 등록. IPC.TOKEN_UPDATE 채널 추가. preload에서 renderer로 노출
  - 검증: PTYBridge에서 토큰 이벤트 발생 + renderer 수신 확인
- [ ] F1-3: tokenSlice + UI 표시
  - Files: src/renderer/stores/slices/tokenSlice.ts (신규), src/renderer/stores/index.ts, src/renderer/components/StatusBar/
  - 방법: pane별 토큰 수/비용 상태. StatusBar에 현재 pane 비용, 사이드바에 workspace 합산
  - 검증: mock 데이터로 UI 렌더링 확인
- [ ] F1-4: 세션 영속성
  - Files: src/shared/types.ts (SessionData), src/renderer/stores/slices/workspaceSlice.ts (loadSession)
  - 방법: SessionData에 tokenData 필드 추가
  - 검증: 세션 저장 → 로드 후 토큰 데이터 유지 확인
- [ ] F1-5: F1 테스트
  - Files: src/main/pty/__tests__/
  - 검증: TokenTracker 유닛 + 파싱 정확도

### F4: Onboarding Tutorial
- [ ] F4-1: OnboardingOverlay 컴포넌트
  - Files: src/renderer/components/Onboarding/OnboardingOverlay.tsx, OnboardingHighlight.tsx
  - 방법: 경량 자체구현 (Shepherd.js 미사용). highlight rect + tooltip + arrow. data-onboarding-* 속성 기반 앵커
  - 검증: 컴포넌트 렌더링 + 스텝 전환 확인
- [ ] F4-2: 스텝 정의 + 하이라이트 로직
  - Files: src/renderer/components/Onboarding/steps.ts
  - 방법: 4-5 스텝 정의. 기존 컴포넌트에 data-onboarding-target 속성 추가 필요 (Sidebar, Pane, Settings 등)
  - 검증: 각 스텝 하이라이트 위치 정확도
- [ ] F4-3: uiSlice 확장 + 설정 연동
  - Files: src/renderer/stores/slices/uiSlice.ts, src/shared/types.ts (SessionData), src/renderer/components/Settings/
  - 방법: onboardingStep/onboardingCompleted 상태, SessionData에 영속화, 설정에서 "튜토리얼 다시 보기" 버튼
  - 검증: 건너뛰기/재시작/완료 영속화
- [ ] F4-4: F4 테스트
  - Files: src/renderer/components/Onboarding/__tests__/
  - 검증: 스텝 전환 + 완료 상태
