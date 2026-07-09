# J1 — fan-out v1: 프롬프트 1개 → N 격리 태스크 (2026-07-10)

- 상태: **v1.1 — 2모델 패널 리뷰 반영판**(Claude 적대 9건 실코드 검증 + GLM 7건, Codex 미가용 — §11 리뷰 로그). v1 대비: D4 정직화(레이스 "완화"·argv 한계)·identity 핸드셰이크 명세·fanout 멱등·프리플라이트·suffix 격리 루트·스폰 경로 단일화.
- 계약: `plans/strategy-reset-2026-07-09.md` §4 NB1 J1 · `plans/roadmap-12mo-world-no1-2026-07-05.md` §6.J · `plans/j0-task-canon-design-2026-07-09.md`(정본 기판 — D1~D5·§5 소유권 계약) · 리뷰 C10(비격리 fan-out 금지)·P2(격리 기본값)
- 목적: 프롬프트 1개 → N개 태스크 스폰. 태스크마다 **worktree 격리(기본값·유일값) + 전용 워크스페이스 + 미션 채널 자동 개설 + 에이전트 페인**. J0가 세운 WorkTask 정본에 물질화 필드(branch·worktreePath·paneGroupId)를 `task.update`로 채운다.
- 비목표: diff 뷰·hunk 채택(J2) / 1클릭 PR·dirty 정리 UX 완성·**고아 worktree/미물질화 태스크의 회수 UX**(J3 — 리뷰 GLM: J1은 발견·노출까지만) / 태스크 사이드바 1급·FleetView 미션 뷰(파동 2 IA — W2) / claim-lease(§6.M P2) / MCP fan-out 도구(사람이 시작하는 여정이 J1의 본질 — §6.M 계약 1 "born-owned") / 에이전트 자동 readiness 감지 / worktree 이탈 하드 방어(J3 감지 설계 몫 — 리뷰 반영 C1)
- **성공기준(관측 가능 — 리뷰 반영 GLM: 디스크 실존은 "자동 보증"이 아니라 스크립트가 확보·검사하는 조건)**: E2E — `fanout(N=2) → worktree 2개 실존(전용 루트, 스크립트가 fs 검사) + 워크스페이스 2개 + 미션 채널 2개(태스크 워크스페이스 멤버 포함) + task.update로 물질화 필드 커밋 → 데몬 재시작 → projection 복원(open·필드 잔존) + worktree 디스크 실존(스크립트 검사) + 채널 active`. 부분 실패 E2E — `2번째 태스크의 worktree add 실패 시: 1번째는 성립, 2번째는 보상 close + 채널 archive, 결과 리포트에 성공 1·실패 1 명시`. 멱등 E2E — `동일 fanout 멱등키 재호출 = 신규 생성 0, 직전 결과 재반환`. **리부트 생존 데모 스크립트**(단일 태스크 — 전략 §P7 페어링): 스크립트가 위 왕복을 재현 가능하게 고정.

---

## 1. 결정 D1 — 태스크 실행 단위 = **태스크 전용 워크스페이스**, `paneGroupId` = 그 워크스페이스 id

J0가 명시 위임한 미결("paneGroupId의 실체 — 그룹 vs 페인 배열")의 판정. 후보는 ① 생성자 워크스페이스 안의 페인 서브트리 ② surface ③ 전용 워크스페이스. **③을 채택한다.**

- **신원 축 정렬(결정적 논거 — 리뷰 반영 C6으로 정직화)**: 채널·A2A의 authz 앵커는 `verifiedWorkspaceId`(senderPtyId→서버 해석)다. 태스크 에이전트가 생성자 워크스페이스의 페인으로 살면 N개 에이전트의 채널 발신이 전부 **생성자 신원으로 뭉개진다**. 전용 워크스페이스면 태스크당 신원 분리가 공짜로 생긴다 — 단 이것은 **forgeable ceiling(#113 — same-machine 신원은 위조 가능이 수용 잔여) 하의 신원 분리**지 암호학적 검증이 아니다. "검증된 발신자" 경주축의 J1 기여분은 "귀속 가능한 분리"까지고, 하드 검증은 기존 신뢰 계층 로드맵 몫.
- **cwd 힌트(리뷰 정정 C1 — v1의 "1차 방어" 주장 철회)**: `WorkspaceProfile.startupCwd`(src/shared/types.ts:123)는 새 페인의 시작 디렉토리 **힌트**다 — 실물 계약상 split CWD 상속에 밀리고, 경로 invalid 시 조용히 homedir 폴백(tolerant by design). 따라서 worktree 격리의 방어가 아니라 **초기 편의**로만 계상한다(스폰 시 `startupCwd = worktreePath`). "에이전트가 worktree 밖 수정" 방어(§6.J 함정)는 J1이 제공하지 않으며 J3 이탈 감지 설계로 전면 이연 — 이 갭은 데모·문안에서 주장 금지.
- **리부트 생존이 기존 경로**: 워크스페이스·페인 트리는 session.json 영속 + 기존 복구 경로가 이미 리부트를 견딘다. 페인 서브트리 방식이면 태스크↔페인 매핑의 별도 영속을 발명해야 한다.
- 스키마 불변: `paneGroupId` 필드명은 J0 additive-only 규약상 유지하고, **의미를 "태스크 전용 워크스페이스 id"로 계약 고정**(필드 주석 갱신 — 의미변경이 아니라 J0가 위임한 의미 확정).
- 태스크 워크스페이스 구성: 에이전트 페인 1 + 셸 페인 1(§6.J 템플릿의 최소형 — "에이전트 페인 N"의 N>1은 후속, 템플릿 일반화는 IA·J3와 동기). 이름 = `wtask: {title 절단}`.

## 2. 결정 D2 — 오케스트레이션은 main의 `FanOutService`(신설), 데몬은 정본만

스폰은 fs(git worktree)·PTY·렌더러 브리지가 전부 필요하다 — 전부 Electron main의 자산이고 데몬엔 없다(데몬 = 내구 정본·채널·로그). **스폰 경로는 렌더러 경유 단일 고정**(리뷰 반영 G4 — v1의 "main 내부 동등 브리지" 병기 삭제): 워크스페이스·페인 트리 정본은 렌더러 스토어(session.json)고, 그 정본을 우회하는 main 브리지는 이 PR에서 만들지 않는다.

### 시퀀스 (리뷰 반영 — 프리플라이트·identity 핸드셰이크 명세)

| 단계 | 계층 | 수단 |
|---|---|---|
| ⓪ **프리플라이트**(리뷰 G2) | main | repo 유효성(git repo·비-bare·경로 길이·전용 루트 쓰기 가능)을 **1회 선검증** — 부적격이면 태스크·채널 생성 자체가 일어나지 않는다(N개 전부 즉시 거부) |
| ① `task.mission.start` | 데몬 | 기존 J0 RPC — taskId·missionChannelId 획득(멱등키 필수 전달) |
| ② worktree 생성 | main | D3 `TaskWorktreeManager`(전용 루트·직렬 큐) |
| ③ 워크스페이스+페인 스폰 | main→렌더러 | 기존 `workspace.new`·`pane.split` 경로(src/shared/rpc.ts:102·112). `profile.startupCwd = worktreePath`. **응답에서 실제 workspaceId 회수**(핸드셰이크 — 리뷰 C3) |
| ④ `task.update` | 데몬 | D5 핸들러 — {branch, worktreePath, paneGroupId=③의 workspaceId} 물질화 커밋 |
| ⑤ 채널 invite + 프롬프트 발사 | main | ③에서 회수한 workspaceId로 기존 채널 invite RPC 호출(태스크 워크스페이스를 미션 채널 멤버로). 에이전트 페인의 발신 신원은 기존 senderPtyId→verifiedWorkspaceId 스탬프가 페인 실존 시점부터 자연 성립(신규 메커니즘 0). invite 실패는 태스크를 무산시키지 않는다 — 리포트에 "채널 미연결" 명시(에이전트는 작동, 채널 발신만 결손 — 사람이 수동 invite 가능) |

- **fanout 호출 멱등(리뷰 G1 — CRITICAL)**: `fanout:start` IPC는 **호출 단위 멱등키**(렌더러가 다이얼로그 제출 시 1회 발급)를 필수로 받는다. FanOutService는 `키 → 태스크별 결과` LRU를 유지: 동일 키 재호출은 재실행 없이 직전 결과 반환, **in-flight 중복은 거부**(진행 중 에러). 더블클릭·IPC 재시도가 N배 worktree를 못 찍는다. 하위 mission.start 멱등키는 `{fanout키}-{k}`로 파생(계층 정합).
- **실패 보상(태스크 단위 원자성, fan-out 전체는 부분 성공 허용)**: k번째 태스크의 ②~④ 실패 시 그 태스크만 보상 — `mission.close`(J0 보상 경로 재사용 — 채널 archive 포함) + 생성된 worktree는 **삭제하지 않고 보존 목록에 기록**(§6.J "dirty 강제 삭제 금지"의 보수적 확장: 실패 시점의 디스크 상태를 지우는 쪽이 더 위험). 나머지 태스크는 계속. 결과는 태스크별 성공/실패 리포트로 반환.
- **크래시 창**: ①~④ 사이 main 크래시 → 데몬엔 open 태스크(물질화 미완)가 남는다. J0 reconcile은 채널↔태스크만 본다. J1은 **물질화 reconcile을 추가하지 않는다** — open ∧ worktreePath 부재 태스크는 fan-out 리포트·`task.mission.list` 소비 지점에서 "미물질화"로 노출되고 사람이 close(J0 경로)한다. 자동 재물질화는 J3 수명주기 몫. (판단: 크래시 창이 좁고, 자동 재시도는 이중 worktree 위험이 더 크다.) **디스크 결측(리뷰 G3)**: worktreePath가 커밋됐는데 디스크에서 수동 삭제된 태스크는 데몬이 감지하지 않는다(데몬은 fs 접근 없음 — 정본은 로그) — fan-out 리포트·데모 스크립트가 표시 시점에 fs 검사로 "손상" 판정하고, 상시 감지·회수는 J3 정리 UX 몫(비목표 명시).
- fan-out N 캡: 8 (상수 `FANOUT_MAX_TASKS` — 워크스페이스·PTY 폭주 방어. J0 open 캡 256과 별개로 1회 호출 캡).

## 3. 결정 D3 — `TaskWorktreeManager`: 고아 코드 일반화·첫 배선

실측: `WorktreeManager`는 **두 벌** 있다(리뷰 C8) — src/main/company/WorktreeManager.ts(156줄)와 src/company/main/WorktreeManager.ts(259줄), 양쪽 다 계보 불명. **계승 출처는 src/main/company 판(156줄)으로 고정**한다(validateGitRef·validatePath — 플래그 주입·traversal 방어 + porcelain 파서). 어느 쪽도 import되지 않는 고아 코드이므로 "재사용"의 실체는 검증 유틸 계승 + §6.J 함정 목록의 신규 구현이다. 두 고아의 삭제·정리는 이 PR에서 하지 않는다(별도 정리 몫 — 인접 코드 무개선 원칙).

- **전용 루트(§6.J 문면 + 리뷰 C4 — suffix 격리 준수)**: `${getWmuxHomeDir()}/worktrees/{repoHash}/{taskSlug}` — 하드코딩 `~/.wmux`가 아니라 **getWmuxHomeDir()(src/shared/constants.ts:311-317) 파생**으로 dev/dogfood suffix 격리(`~/.wmux-dev` 등)를 상속한다. repoHash = 원본 repo 루트의 **realpath 기반 해시 12자**(J0 `normalizeWorktreePath` 주석의 "realpath는 호출측 몫" 이행 지점), taskSlug = `{title slug 절단 24자}-{taskId 말미 8자}`(충돌은 taskId가 흡수). Windows 260자: 루트+slug 조합 길이 사전 검증(⓪ 프리플라이트 편입), 초과 시 명시 에러 + `core.longpaths` 안내(doctor 편입은 후속).
- **branch 네이밍**: `wtask/{taskSlug}` — 기존 브랜치 충돌 시 명시 에러(자동 접미사 금지 — 사용자 브랜치 공간을 조용히 오염하지 않는다).
- **per-repo 직렬 큐(§6.J 인덱스 락 경합)**: repoHash 단위 뮤텍스로 worktree add/remove 순차화. fan-out N개는 같은 repo라 자연 직렬 — git index.lock 경합을 큐잉으로 원천 차단.
- **dirty 보존(§6.J)**: remove 진입 시 `git status --porcelain` 검사 → dirty면 제거 거부 + 보존 목록 반환(강제 삭제 API 자체를 만들지 않는다 — J3에서 "보존 후 목록" UX로 완성).
- **에지 fail-closed**: bare repo·서브모듈 포함 repo·LFS는 감지 시 명시 에러(지원은 후속 — 조용한 반쪽 동작 금지). git 부재·repo 아님도 동일. 전부 ⓪ 프리플라이트에서 걸러 태스크 생성 전에 거부(리뷰 G2).
- 배치: `src/main/worktask/TaskWorktreeManager.ts` 신설(company/ 아님 — company 결합 제거).

## 4. 결정 D4 — 프롬프트 전달: 파일 경유 + `initialCommand` 한 줄 (주입 레이스 **완화** — 리뷰 정정 C2)

v1의 "레이스가 물리적으로 없는 경로" 주장은 **철회한다**(리뷰 C2 실코드): initialCommand 자체가 scheduleInitialCommand(src/main/ipc/handlers/scheduleInitialCommand.ts)의 완화 장치 위에 있다 — first-data 대기·settle·15회 재시도·3초 blind fallback, **onExhausted 시 유실 가능**. 정직한 계약:

- 이 경로의 실제 이점 2가지: ① **주입 대상이 프롬프트 본문이 아니라 짧은 명령줄** — 유실 표면이 "수 KB 본문 중간 절단"에서 "한 줄 전체 성패"로 축소되고, 실패가 관측 가능(빈 셸)하다. ② **에이전트 CLI readiness 레이스가 없다** — CLI가 뜬 뒤 본문을 붙여넣는 방식과 달리, 셸 readiness만 문제고 그건 기존 완화 장치의 검증된 영역이다.
- **onExhausted 배선**: initialCommand 유실 시 해당 태스크를 fan-out 리포트에 "프롬프트 미발사"로 표시(태스크는 성립 — 사람이 프롬프트 파일 경로로 수동 재발사. injectText 재사용).
- 프롬프트를 **태스크 메타 디렉토리**(worktree 밖 — `${getWmuxHomeDir()}/worktrees/{repoHash}/.meta/{taskSlug}/prompt.md`)에 파일로 쓰고, 페인 `initialCommand`는 `{agentCmd} "$(cat {promptPath})"`(POSIX) / PowerShell 동형(`Get-Content -Raw`) 한 줄. worktree 안에 두지 않는 이유: diff 오염 금지(J2가 딛는 diff의 청정성).
- **argv 한계(리뷰 G5 — v1의 64KB 철회)**: `$(cat)` 치환 결과가 단일 argv가 된다 — Windows 명령줄 한계(8191자)·ARG_MAX를 고려해 **프롬프트 캡 8KB**(플랫폼 최소공배수, 상수). 초과 시 명시 에러 + "프롬프트를 줄이고 상세는 파일로 만들어 경로를 언급하라" 안내. stdin 파이프는 에이전트 CLI를 비대화형으로 떨어뜨려(claude -p 모드) 여정 자체가 깨지므로 채택 불가.
- agentCmd는 fan-out 다이얼로그 입력(기본값 `claude`) — exec 화이트리스트 경로가 아니라 **셸에 타이핑되는 initialCommand 경로**(pty.handler 기존 계약)라 사용자 가시·감사 가능. 쿼팅은 경로만 대상(프롬프트 본문은 파일 안 — 본문 쿼팅 표면 제거는 유효한 논거로 유지).
- **sanitize 정합(리뷰 C9)**: initialCommand는 sanitizePtyText(src/main/ipc/handlers/pty.handler.ts:490)를 통과한다 — `$()`·따옴표가 보존되는지 **테스트 1본 필수**(§8). 변형·절단되면 이 설계 전체가 무너지므로 구현 첫 단계에서 검증.

## 5. 결정 D5 — `task.update` 핸들러 활성화 (J0 예약 이행)

- WorkTaskService에 update 적용 로직 추가: open 태스크만, **물질화 필드는 최초 1회 쓰기**(이미 설정된 branch/worktreePath/paneGroupId의 덮어쓰기 거부 — 물질화는 단조, prUrl만 J2에서 갱신 허용 예정), closed 태스크 거부.
- authz: close와 동일 앵커(owner.verifiedWorkspaceId OR CEO) — 물질화는 소유자 행위다. wire 화이트리스트: `{taskId, branch?, worktreePath?, paneGroupId?}`만(J0 §2 관례).
- **worktreePath 배타 불변식 활성화**(J0 §2가 "활성 테스트는 J1 몫"으로 명시 이연한 것): update 진입 시 canonical 정규화(realpath 해석 포함) 후 동일 경로 open 태스크 존재 시 거부. 전역 write 뮤텍스 하에서 검사(J0 구조 그대로).
- **배선(리뷰 정정 C7)**: RPC `task.mission.update`는 RpcMethod union(src/shared/rpc.ts) + 파이프 라우터 등록 + capability map까지. **MCP 도구는 무등재**(물질화는 FanOutService 내부 경로 — 도구 표면 최소주의). FIRST_PARTY_METHODS(src/main/mcp/firstParty.ts) 등재는 실제 호출 클라이언트가 first-party 게이트를 타는 경우에만 — main의 파이프 클라이언트 경로가 어느 게이트를 타는지 구현 시 enforce 모드로 실증하고 필요한 최소만 등재(J0 §4 관례: 누락 시 tsc/enforce가 막는다).

## 6. 결정 D6 — broadcast-only는 태스크가 아니다 (C10 분리 라벨)

- 비격리 모드는 fan-out의 옵션이 아니라 **별개 동작**: 선택한 기존 페인 N개에 같은 텍스트를 inject(기존 injectText 다중 대상화). WorkTask·worktree·채널 생성 0.
- UI 라벨 분리: fan-out 다이얼로그에 격리 해제 토글을 **두지 않는다**. broadcast는 AgentToolbar의 별도 진입(다중 페인 선택 → 전송). C10의 사고(같은 체크아웃에 N 에이전트)를 UI 구조로 봉쇄.
- J1 범위: 최소 구현(S) — 페인 다중 선택 UI가 과하면 "현재 워크스페이스의 모든 에이전트 페인" 1옵션으로 축소 가능(구현 워커 재량, 라벨 분리 원칙만 불변).

## 7. 결정 D7 — UI 최소 표면 (IA 1급 승격은 파동 2 몫)

- 진입: AgentToolbar에 fan-out 버튼 1개 → 다이얼로그 `{프롬프트(textarea), N(1~8), 태스크별 title(자동 파생 + 편집 가능 — 리뷰 G6: 기본값 "{프롬프트 앞 24자} #k", branch·slug가 사람이 식별 가능하도록), repo 경로(기본: 활성 워크스페이스 cwd), agentCmd(기본 claude), 브랜치 접두 미리보기}` → 스폰 → 태스크별 성공/실패 토스트+리포트(미물질화·채널 미연결·프롬프트 미발사 상태 구분 표시 — §2·§4).
- 태스크 상태 표면: 신규 사이드바·뷰 발명 금지 — 태스크 워크스페이스가 사이드바에 자연 등장하는 것(D1의 부수 효과)으로 충분. 미션 채널은 기존 Channels 독에 자연 등장. 1급 태스크 뷰는 W2 파동 2가 이 위에 얹는다.
- 렌더러 변경 diff를 이 최소 표면으로 캡 — J1 리뷰의 렌더러 표면적을 통제.

## 8. 구현 표면·W1 위임 범위

| 계층 | 신설/변경 | 내용 |
|---|---|---|
| shared | 변경(소) | `task.mission.update` RpcMethod·라우터·capability 배선(§5 — FIRST_PARTY는 실증 후 최소) + `FANOUT_MAX_TASKS`·프롬프트 캡(8KB) 상수 + paneGroupId 주석 의미 고정 |
| daemon | 변경(중) | WorkTaskService `task.update` 적용(§5 — 단조 물질화·배타 불변식 활성·authz)·라우터 등록 |
| main | 신설 | `TaskWorktreeManager`(§3)·`FanOutService`(§2 — 프리플라이트·시퀀스·호출 멱등 LRU·보상·리포트)·IPC 핸들러(`fanout:start`) |
| renderer | 신설(소) | fan-out 다이얼로그+버튼(§7 — 멱등키 발급 포함)·broadcast-only 진입(§6)·결과 토스트 |
| scripts | 신설 | 리부트 생존 데모 스크립트(단일 태스크 왕복 — 성공기준 §0 재현, worktree fs 검사 포함) |
| tests | 신설 | E2E 3본(성공기준 §0 — 정상·부분 실패·멱등)·TaskWorktreeManager 단위(전용 루트 suffix 파생·직렬 큐·dirty 거부·에지 fail-closed·경로 길이)·task.update(단조·배타·authz·closed 거부)·**sanitizePtyText `$()` 보존(§4 — 구현 첫 단계)**·프리플라이트 거부(태스크 생성 0 확인)·fanout 멱등(재호출 신규 0·in-flight 거부) |

검증 게이트: 신규 테스트 그린 + `test:parallel` 무영향 + `tsc` 클린 + 데모 스크립트 실행 성공.

## 9. 리스크·함정

| 리스크 | 대응 |
|---|---|
| 렌더러 경유 워크스페이스 스폰의 창(렌더러 미기동·응답 유실) | fan-out은 사람이 렌더러에서 시작하므로 렌더러 실존 전제. 응답 유실 시 태스크는 미물질화로 남고 §2 크래시 창 계약으로 수렴(사람이 close) |
| git 명령 실패 다양성(권한·잠금·detached) | ⓪ 프리플라이트가 대분류를 선차단, 잔여는 TaskWorktreeManager가 명시 에러로 전파 → FanOutService 태스크 단위 보상(§2). 조용한 성공 위장 금지 |
| 프롬프트 파일 잔존(민감 정보) | 태스크 메타 dir은 close 시가 아니라 J3 정리 UX에서 일괄(J1은 보존 — dirty 보존과 동일 원리). 위치가 wmux 홈 하위 단일 루트라 발견 가능 |
| N개 동시 스폰의 렌더러 부하 | N캡 8 + 스폰 자체를 태스크 순차(직렬 큐가 이미 강제)로 — 동시 폭주 없음 |
| agentCmd 자유 입력의 오용 | initialCommand 경로는 기존 계약(사용자 셸 타이핑과 동급) — 신규 권한 표면 아님. 캡·감사 로그는 기존 경로 상속 |
| J2가 딛을 diff 청정성 | 프롬프트 파일 worktree 밖(§4)·`.meta` 분리로 worktree diff = 순수 에이전트 산출물 |
| 고아 누적(실패 보존 worktree·미물질화 태스크·미연결 채널) | J1은 리포트·표시로 **발견 가능**하게만 하고(§2·§7), 회수 UX는 J3(비목표 명시 — 리뷰 G7). 누적 상한은 J0 open 캡 + fanout 멱등이 간접 제어 |

## 10. 후속 순서

1. ~~본 문서 패널 플랜 리뷰~~ **완료(2026-07-10)** — §11. Codex 미가용으로 2모델(Claude 실코드 적대 + GLM).
2. LEDGER 갱신 → W1 구현 위임(Opus, §8 표면).
3. 구현 3모델 코드 리뷰 → PR.
4. J2 설계(오케스트레이터 직접): diff 리뷰 페인 — worktree diff 스트리밍·파일 트리·hunk 뷰·코멘트=미션 채널 앵커. 검증 리그 실검출이 J2 출하 블로커(전략 §4).

## 11. 리뷰 로그 — 2모델 패널 1라운드 (2026-07-10, Codex 미가용)

Claude 적대(Opus, 실코드 검증 — startupCwd tolerant 계약·scheduleInitialCommand 완화 코드·suffix 격리 SSOT·중복 WorktreeManager를 file:line으로 확정) 9건 + GLM 7건. 전건 반영:

| # | 출처 | 요지 | 반영 |
|---|---|---|---|
| C1 | Claude(실코드) | startupCwd "1차 방어" 주장 거짓 — split 상속 override·invalid 시 homedir 폴백 | 힌트로 격하, 이탈 방어는 J3 이연 명시(§1) |
| C2 | Claude(실코드) | "레이스 물리적 부재" 거짓 — scheduleInitialCommand 자체가 완화 장치(onExhausted 유실) | "완화"로 정직화 + onExhausted→리포트 배선(§4) |
| C3 | Claude | 태스크 워크스페이스 invite의 identity bootstrap 미명세 | ③ 응답 workspaceId 회수→⑤ invite 핸드셰이크 + invite 실패 비치명 계약(§2) |
| C4 | Claude(실코드) | `~/.wmux` 하드코딩이 getWmuxHomeDir() suffix 격리 위반 | 루트를 getWmuxHomeDir() 파생으로(§3·§4) |
| C5 | Claude | 파일 경로 src/ 접두 누락·라인 부정확 | 전 인용 정정 |
| C6 | Claude | "검증 가능한 신원" 과장 — forgeable ceiling(#113) | "귀속 가능한 분리"로 정직화(§1) |
| C7 | Claude | FIRST_PARTY 배선 위치·필요성 부정확 | 실증 후 최소 등재로 재규정(§5) |
| C8 | Claude | 중복 WorktreeManager(src/company/main/ 259줄) 미언급 | 두 벌 명시 + 계승 출처 156줄판 고정(§3) |
| C9 | Claude | sanitizePtyText가 `$()` 변형 가능성 미검토 | 보존 테스트를 구현 첫 단계 필수로(§4·§8) |
| G1 | GLM | fanout:start IPC 멱등 부재 — 더블클릭이 N배 worktree | 호출 멱등키+LRU+in-flight 거부+파생 키(§2) — CRITICAL |
| G2 | GLM | 프리플라이트 부재 — 부적격 repo에서 태스크 생성 후 보상 낭비 | ⓪ 프리플라이트 신설(§2·§3) |
| G3 | GLM | 디스크 결측 태스크가 재부팅 후 거짓 성공 | 성공기준 정직화 + 표시 시점 fs 검사 + 상시 감지 J3(§0·§2) |
| G4 | GLM | 스폰 경로 이중 제시(렌더러 vs main 브리지) — 구현 드리프트 | 렌더러 경유 단일 고정(§2) |
| G5 | GLM | `$(cat)` 64KB argv — ARG_MAX·Windows 8191자 | 캡 8KB로 축소 + stdin 불채택 논거(§4) |
| G6 | GLM | N태스크 title 파생 미정 — 브랜치 공간 오염 | 태스크별 title 편집 + 자동 파생 규칙(§7) |
| G7 | GLM | 고아(worktree·채널) 회수 수단 부재 | J1=발견·노출, 회수=J3 비목표 명시(§0·§9) |
