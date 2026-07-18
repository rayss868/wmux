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
