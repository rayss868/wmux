# macOS 호환성 조사 및 조치계획 (2026-07-19)

Windows 기반으로 개발된 wmux를 macOS에서 전수 점검한 결과.
범위: main / daemon / cli / mcp / renderer / shared / preload / 빌드 설정.

**총평**: 앱이 안 뜨는 치명 이슈는 없음. 플랫폼 추상화(platform.ts, 셸 폴백,
DMG/notarize 빌드, 트래픽 라이트 예약 등)는 대부분 갖춰져 있으나,
**터미널 키 입력 계층에 mac 실사용을 바로 막는 회귀 2건**이 있다.

## 발견 요약 (심각도순)

| # | 발견 | 위치 | 심각도 |
|---|------|------|--------|
| 1 | 터미널 내 Ctrl+문자(D, I, M, N, T, K, `,` 등)가 mac에서 완전 무동작 — xterm 핸들러가 삼켜서 버블시키는데 useKeyboard는 mac에서 metaKey로만 매칭 | `useTerminal.ts:1040,1047` ↔ `useKeyboard.ts:239` | **치명** |
| 2 | 선택영역이 있으면 mac에서도 Ctrl+C가 SIGINT 대신 복사로 가로채짐 (mac은 Cmd+C가 이미 복사 담당) | `useTerminal.ts:1132` | **높음** |
| 3 | DMG/ZIP 설치 시 `wmux` CLI가 PATH에 등록 안 됨 — shim 설치가 Squirrel(Win) 훅 전용 | `cliShim.ts`, `main/index.ts:132~185` | **높음** |
| 4 | OS 재시작/로그아웃 시 세션 스냅샷 유실 가능 — 동기 flush가 win32 `session-end` 전용 | `main/index.ts:1564` | 중간 |
| 5 | "로그인 시 자동 시작" 토글이 mac에서 no-op — reg.exe 전용, `setLoginItemSettings` 미사용 | `autostart.ts` | 중간 |
| 6 | 설치 폰트 목록이 mac에서 항상 빈 배열 — PowerShell 열거 전용 | `fonts/installedFonts.ts` | 낮음 |
| 7 | 터미널 폰트 폴백 체인이 win 폰트(Consolas 등)만 — mac은 generic monospace로 추락 | `terminalFont.ts:55` | 낮음 |
| 8 | UI 폰트 스택 Inter 미번들 + 'Segoe UI' 우선 — mac은 SF로 폴백(동작은 함) | `globals.css:376` | 낮음 |
| 9 | Unix 소켓을 홈 디렉터리에 직접 생성(`~/.wmux-*.sock`) — sun_path 104바이트 한계 근접 가능, 홈 오염 | `DaemonClient.ts:447,745` | 낮음 |
| 10 | "Ctrl+click" 문구가 mac 관례(⌘+클릭) 미병기 — 기능 자체는 metaKey 인식으로 정상 | `pathLinkProvider.ts:2` 등 | 낮음 |

이상 없음 확인: 셸 폴백(zsh), launcher `ps` 분기, SIGTERM/SIGKILL, 트레이 icns,
forge DMG/osxSign/notarize/entitlements, spawn-helper asar unpack, CRLF 붙여넣기
정규화, NFC 경로 표시, Cmd+C/V 분기, 경로 구분자 `/` 감지, `useConpty`(비-win 무시).

## 조치계획

### 1차 — 즉시 (mac 실사용 차단 해소)
- **P1. 터미널 Ctrl+문자 복원** (#1): xterm 커스텀 키 핸들러에서 mac일 때는 해당
  Ctrl 조합을 삼키지 않고 PTY로 통과시킨다(앱 액션은 mac에서 Cmd 계열이므로 충돌
  없음). → 검증: mac에서 Ctrl+D EOF, Ctrl+I=Tab, Ctrl+M=Enter 동작 + 단축키
  액션 회귀 테스트.
- **P2. Ctrl+C SIGINT 보장** (#2): 복사 가로채기 분기를 비-mac 한정으로 게이팅.
  → 검증: mac에서 선택영역 있는 상태로 Ctrl+C → 인터럽트, Cmd+C → 복사.
- P1+P2는 한 PR, 테스트 동반.

### 2차 — 이번 주 (설치/수명주기)
- **P3. mac CLI shim** (#3): 첫 실행 시(또는 Settings 버튼) `/usr/local/bin/wmux`
  심링크 설치 제안(권한 실패 시 `~/.local/bin` 폴백 + PATH 안내). → 검증: DMG
  설치 후 터미널에서 `wmux` 실행.
- **P4. 종료 시 세션 flush** (#4): `before-quit`/`will-quit`에 mac용
  `flushSync()` 경로 추가. → 검증: 앱 실행 중 로그아웃 시뮬레이션 후 세션 복원.
- **P5. 자동 시작** (#5): darwin 분기에 `app.setLoginItemSettings` 구현.
  → 검증: 토글 on → 시스템 설정 로그인 항목 등록 확인.

### 3차 — 여유 시 (품질)
- **P6. 폰트** (#6·#7·#8): 폴백 체인에 Menlo/SF Mono 추가, mac 폰트 열거는
  `system_profiler`나 CSS `queryLocalFonts`로 구현, Inter는 번들 또는 스택에서 제거.
- **P7. 소켓 경로** (#9): `~/.wmux/` 하위(또는 `app.getPath('userData')`)로 이동
  — 구경로 마이그레이션 포함.
- **P8. 문구** (#10): "Ctrl+click" → 플랫폼별 "⌘+클릭" 병기.

리뷰 정책: P1·P2는 입력 계층 회귀 위험이 있으므로 자체 검증 + 테스트 필수,
3모델 패널 대상은 아님(인증·결제·인프라 아님).

## 1~3차 완료 (2026-07-19)

P1~P8 전부 구현·검증·커밋 완료. Ctrl+V 가로채기(P2 잔여)도 함께 게이팅.
전체 스위트(vitest 6,000+) + tsc 통과.

## 2차 조사 — 자체 diff 리뷰 + 추가 스윕

1차 수정 커밋을 Code Reviewer 에이전트로 자체 리뷰하고, 아직 안 본 영역
(트레이/앱 메뉴/알림/윈도우 상태/딥링크/클립보드 이미지/드래그앤드롭/전역
단축키/업데이터/Dock)을 추가 스윕했다.

### diff 리뷰 발견
- 🟡(제기됐으나 재검증 결과 오탐) `getWmuxHomeDir()`(env 기반)와
  `getLegacyDaemonSocketPath()`(os.homedir() 기반)의 홈 소스 불일치 —
  `git log`로 확인한 결과 **구버전 코드가 실제로 os.homedir() 기반**이었으므로
  legacy 헬퍼가 이를 재현하는 것이 맞다(`daemon/config.ts:150` 마이그레이션
  비교도 이 값과 대조). 수정 안 함.
- 💭 `useTerminal.ts`의 `isMac`/`isMacKeys` 중복 선언 — 실제 버그는 아니지만
  가독성 문제. `isMac`으로 통일, 테스트 정규식 갱신. 커밋 완료.
- 💭 CLI shim symlink 설치의 TOCTOU — 로컬 프로세스가 이미 쓰기 권한을 가진
  경우만 성립(이미 code-exec-as-user와 동급), 실질 공격면 아님. 보류.

### 추가 스윕 발견 (신규)

| # | 발견 | 위치 | 심각도 | 처리 |
|---|------|------|--------|------|
| 11 | Dock 아이콘 재클릭(activate) 시 숨겨진 창이 안 뜸 — close 인터셉트가 hide()만 하는데 activate 핸들러는 `getAllWindows().length===0`일 때만 새 창 생성, 숨은 창은 카운트에 포함돼 분기를 못 탐 | `main/index.ts:1656` | **치명** | ✅ 수정+커밋 |
| 12 | mac 메뉴바 트레이 아이콘에 1024px `icon.icns` 원본을 그대로 사용 — 비정상적으로 크게 렌더 | `main/tray.ts:142` | 높음 | ✅ mac에서 22x22 리사이즈로 수정+커밋(다색 로고라 setTemplateImage는 전용 모노크롬 에셋 없이 위험해 보류) |
| 13 | Cmd+,(Preferences)가 무반응이라는 보고 | (탐색 에이전트 주장) | 중간 | **오탐 확인** — `useKeyboard.ts:801`이 window 캡처 단계 전역 리스너라 xterm 포커스와 무관하게 이미 동작(`cmdOrCtrl==='","'` 매칭 존재). 수정 불필요 |
| 14 | macOS 인앱 자동 업데이트 미구현 — `AutoUpdater.ts`가 `win32`만 지원 | `main/updater/AutoUpdater.ts:29` | 중간 | **의도된 스코프 아웃**("서명된 ZIP 셀프업데이트는 이후 단계" 주석 명시) — 별도 프로젝트급 작업, 이번 스윕 범위 밖으로 보류 |
| 15 | 트레이 double-click 핸들러가 mac에서 죽은 코드(좌클릭 1회로 컨텍스트 메뉴가 먼저 뜸) | `main/tray.ts:156` | 낮음 | 보류 |
| 16 | Dock 우클릭 메뉴(`app.dock.setMenu`) 미구성 | (신규 기능) | 낮음~중간 | 보류 |

이상 없음 확인(신규): 알림(ToastManager, 사운드/액션 플랫폼 분기 불필요),
윈도우 bounds 복원(기능 자체 미구현이라 리스크 없음), 딥링크/open-file(기능
자체 미구현), 클립보드 `public.file-url` mac 대응 이미 존재, 드래그앤드롭
`webUtils.getPathForFile` 이미 플랫폼 중립, `globalShortcut` 미사용(접근성
권한 이슈 해당 없음).

## 3차 조사 — 사이드바 git 배지 미표시 (2026-07-19)

**증상**: 워크스페이스 이름 밑 브랜치/동기화 배지(⎇ 브랜치, ↑/↓/●)가 mac에서
전혀 안 뜸(win에서는 정상).

**원인**: `GitSyncStatusCache.ts`·`MetadataCollector.ts`·`git/git.ts`(공용
헬퍼)·`TaskCloseService.ts`·`WorktaskScanService.ts`·`WorktreeManager.ts`·
`TaskWorktreeManager.ts` 전부 `execFile('git', …)`을 Electron 메인 프로세스의
raw `process.env`로 실행. macOS에서 Dock/Finder/Spotlight로 뜬 GUI 앱은
launchd의 최소 PATH(`/usr/bin:/bin:/usr/sbin:/sbin`)만 물려받고
`~/.zshrc`/`~/.zprofile`이 깔아주는 Homebrew PATH(`/opt/homebrew/bin` 등)를
상속받지 못한다 — git이 Homebrew로 설치돼 있으면 실행 파일을 못 찾아 ENOENT.
각 호출부가 "quiet absence"(실패 시 null/undefined 반환, throw 안 함)를
계약으로 삼고 있어 에러가 전혀 노출되지 않고 배지만 조용히 안 뜬다. Windows는
git 설치 시 PATH가 레지스트리에 등록돼 전역 상속되므로 이 문제가 없다.

브랜치 이름 자체(⎇ 텍스트)는 `gitContextWatch.ts`가 `.git/HEAD`를 `fs.watch`로
직접 읽는 방식이라 두 플랫폼 다 정상 — 배지(동기화 상태)만 영향받는다.

**수정**: `shared/execEnv.ts`에 `getGitExecEnv()` 추가 — mac에서만 PATH에
Homebrew(`/opt/homebrew/bin`, `/opt/homebrew/sbin`)와 표준 시스템 경로를
보강(메모이즈, 중복 제거), 그 외 플랫폼은 `process.env` 그대로 반환. 위 7개
파일의 모든 `execFile('git', …)` 호출에 `env: getGitExecEnv()` 적용.
테스트 3개 추가(`shared/__tests__/execEnv.test.ts`), 전체 스위트(6,658개) +
tsc 통과, 기존 194개 관련 테스트 무회귀.

## 3차 조사 정정 — 근본원인은 PATH가 아니라 "재접속 cwd 미복원" (2026-07-19)

위 3차 조사의 PATH 가설(서브에이전트 75% 확신)을 커밋 후 실측 검증한 결과
**틀렸다**. 정정:

**PATH 가설 반증**:
- 앱 메인 프로세스 PATH는 실제로 최소값(`/usr/bin:/bin:/usr/sbin:/sbin`)이 맞다.
- 그러나 이 머신 git은 `/usr/bin/git`(Xcode) — 최소 PATH로도 `git status`·
  `git rev-parse` exit 0. 즉 git 호출은 실패하지 않았고 PATH 보강은 이 증상과
  무관. (Homebrew-only-git + Xcode CLT 없는 소수 사용자에겐 유효한 방어책이라
  코드는 유지하되, CHANGELOG는 "방어적 하드닝"으로 정정.)

**진짜 근본원인** (사용자 증상 "워크스페이스 이름만 뜸" = 브랜치·포트·PR 전부
누락 → git만의 문제가 아님):
- `buildMetadataPayload`는 `if (!cwd) return null` — cwd 없으면 컨텍스트 라인
  전체가 사라진다. 메타 폴도 `for (const [ptyId] of cwdMap)`로 돌아 cwd 없는
  pane은 아예 스킵.
- create 경로(`pty.handler.ts:483/533`)는 cwd를 seed하지만, **PTY_RECONNECT
  핸들러(:814)는 데몬이 `listSessions` 응답에 실어준 `meta.cwd`를 버리고
  updateCwd를 안 불렀다.** → 앱 재시작으로 영속 세션에 재접속하면 cwdMap이 비어
  컨텍스트 라인이 이름만 남는다.
- **왜 mac만?** 재접속 후 cwd는 프롬프트 스크레이프(`detectPromptCwd`)로 사후
  복구될 수 있으나, 정규식 `/(?:PS\s+([A-Za-z]:\\[^>]*?)>)|(?:\w+@[\w.-]+:([^$]+?)\$)/`
  는 PowerShell(`PS C:\…>`)·bash(`user@host:…$`)만 잡고 **macOS 기본 zsh
  프롬프트(`host%`)는 못 잡으며 zsh는 OSC 7도 안 쏜다.** 그래서 win/linux는
  사후 복구돼 버그가 가려지고 mac만 영영 빈 채로 남는다.

**수정**: `pty.handler.ts` 재접속 핸들러에 `if (session.cwd) updateCwd(id, session.cwd)`
추가(listSessions 타입에 `cwd?` 포함). 전 플랫폼에서 재접속 즉시 cwd 복원 →
브랜치는 `collector.getGitBranch` 폴백(+위 PATH 하드닝)으로, 싱크 배지·PR·포트도
정상 복원. 소스 레벨 락 테스트 추가(`pty.reconnectCwd.test.ts`).

**교훈**: 서브에이전트 75% 확신 가설을 재현 검증 없이 커밋한 게 1차 실수.
"근본조치 확인" 요청에 실측(git 위치·최소 PATH 재현·증상 정밀화)으로 반증하고
진짜 원인을 규명.

## 보류 항목 (다음 스프린트 후보)
- #14 macOS 자동 업데이트(서명 ZIP 셀프업데이트 파이프라인 — 별도 계획 필요)
- #16 Dock 우클릭 메뉴
- #15 트레이 double-click 정리
- P6 잔여: CLI shim의 `ELECTRON_RUN_AS_NODE` 래퍼(시스템 node 미설치 대응),
  PATH 안내 문자열 UI 노출(현재 로그만)
