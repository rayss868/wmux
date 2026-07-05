# B′ — 세션 보존 데몬 자동 교체 설계 (2026-07-05)

> C1 stale-daemon 배너(v3.16.0)의 상위 호환. 버전 불일치 데몬을 **앱 재시작 없이** 안전하게 교체한다.
> 상태: **v1.1** — 3모델 플랜 리뷰(Codex/GLM 5.2/Claude Opus) 반영 완료. §11 리뷰 로그 참조.

## 0. TL;DR

구 데몬에게 `daemon.shutdown` RPC(이미 존재, 전체 suspend 루프를 awaitable하게 실행)를 보내고, **프로세스 죽음을 PID liveness로 확정**한 뒤, 기존 respawn 기계(`DaemonRespawnController` → `ensureDaemon` → `daemon:connected` → 렌더러 reconcile → 부팅 recovery replay)에 넘긴다. 신규 기계는 거의 없다 — 새로 만드는 것은 **버전 신호 1개, 게이트 1개, 죽음 확정 루프 1개**뿐이고, 나머지는 전부 이미 존재하고 이미 테스트된 경로다.

## 1. 확정된 지형 (소스 추적으로 검증, Claude 적대 리뷰가 좌표 전수 재확인)

핸드오프의 미확인 핵심 질문에 대한 답부터:

**Q. shutdown()의 suspend가 live pty 자식을 보존하는가? → 아니오.**
`shutdown()`(src/daemon/index.ts:2512)은 ① ring buffer를 파일로 덤프하고 `state='suspended'` 마킹 → ② suspended 상태를 `saveImmediate`(동기 atomic write)로 디스크에 저장 → ③ **`sessionManager.disposeAll()`로 PTY 전부 kill** 순서로 진행한다. "세션 보존"의 실체는 다음 부팅의 recovery 경로(src/daemon/index.ts:650~)다:

- 새 PTY 스폰 + 스크롤백 덤프 재생(`scrollbackData`)
- X8: exec unit + supervision 정책 재실행
- X6: 에이전트 pane은 `resumeLaunchCommand()`로 **대화 resume** 명령으로 재기동
- ConPTY error 87 재시도 8회, recovery cap, TTL 등 방어 완비

즉 B′가 제공하는 "세션 보존" = **"앱 완전 종료 후 재시작"과 정확히 동일한 보존 수준**(suspend→recover)을 앱 재시작 없이. live 프로세스(돌고 있는 빌드, 에이전트)는 죽고 resume으로 재기동된다. 이것은 fd-passing 같은 신규 발명이 아니라 이미 출하된 의미론이다.

나머지 지형:

| 사실 | 좌표 | B′에의 함의 |
|---|---|---|
| `forceRespawn()`은 synthetic disconnect일 뿐 — 살아있는 구 데몬을 `ensureDaemon`이 재발견·재사용 | DaemonRespawnController.ts:197 | 교체가 안 됨. 구 데몬을 먼저 죽여야 함 |
| `daemon.shutdown` RPC는 shutdown 본체(덤프+state save+dispose)를 **완료한 뒤** ack를 반환, 이후 50ms 뒤 pipe stop + exit, 1s force-exit 타이머(unref 안 함) | daemon/index.ts:1972~2019 | ack 후 프로세스는 정상적으로 ~1.05s 내 죽음 |
| **ack의 정확한 의미**: 데몬이 수행 가능한 persistence가 전부 끝났음. 단 `StateWriter.saveImmediate`는 non-throwing boolean이고 shutdown이 반환값을 무시하므로(StateWriter.ts:102, daemon/index.ts:2626) 디스크 쓰기 실패 시 ack는 오되 스냅샷급으로 강등 | Codex #2 | ack 후 SIGKILL은 그래도 안전 — 데몬은 ack 후 어차피 ~1.05s 내 자멸하므로 kill이 데이터 결과를 바꾸지 않음. 신 데몬엔 `stateSaved` additive 추가 |
| shutdown 본체 자체에 10s 하드 타임아웃(`process.exit(1)` — ack 없이 즉사) | daemon/index.ts:2534 | **교체 예산은 반드시 10s 미만**이어야 함. 12s로 잡으면 타임아웃 분기가 "이미 죽은 데몬"과 동치가 됨 (교차 합의 #1) |
| `DaemonClient`는 소켓 close 시 `connected=false` + `disconnected` emit하지만 **pending RPC를 reject하지 않음** | DaemonClient.ts:473-479 | RPC 타임아웃만으로는 "데몬 거부"와 "데몬 사망"을 구분 불가 → abort 분기는 `isConnected`를 봐야 함 |
| health probe는 `!client.isConnected`면 **즉시 return** — failureCount 불증가 | DaemonRespawnController.ts:308-310 | 죽은 client를 install하면 probe 에스컬레이션도 안 일어나 영구 정지. 죽은 client install은 절대 금지 |
| `bootstrap()`은 spawnAndConnect 1회 실패 시 그냥 null 반환 — respawn 루프 진입 없음 | DaemonRespawnController.ts:161-180 | 죽음 확정 후의 실패는 bootstrap 맥락에서도 명시적으로 버짓 루프에 넣어야 함 (교차 합의 #2) |
| `ensureDaemon`은 liveness 3상태(alive/unknown/dead). dead 확정일 때만 stale 파일 청소 + 스폰. unknown은 "살아있다고 가정" (split-brain Defect 1 방어) | launcher.ts:84,559 | 구 데몬 죽음이 확정되면 기존 경로가 그대로 새 데몬을 올림 |
| 단일 데몬 불변식은 **데몬 자식에서 부모 무관하게 2중 강제**: acquireLock() wx 배타 + 3상태 재클레임(daemon/index.ts:511-541), canonical pipe 소유 검사 → exit 75 → launcher 재접속(daemon/index.ts:3264-3276, launcher.ts:524,782) | — | 어느 부모가 스폰하든 이중 데몬은 구조적으로 수렴. (GLM의 "같은 부모만 방어" 주장은 환각으로 기각) |
| `killDaemonByPidFile`은 **pid 파일을 재독**하고, image/cmdline 검증이 **null(불확정)이어도 진행** — before-quit 직후 문맥 전용 트레이드오프 | launcher.ts:843-878 | B′ 백스톱으로 그대로 쓰면 안 됨: 타 인스턴스가 그 사이 신 데몬을 스폰했으면 신 데몬을 죽임 (교차 합의 #4) |
| `checkProcessLiveness`는 launcher private (순수 분류기만 export) | launcher.ts:84 | export 추가 필요 (Codex #8) |
| onInstall은 매 (재)연결마다 핸들러 스왑 + `daemon:connected` 방송 → 렌더러 late-reconcile + **채널 재수화**(useChannelsHydration.ts:266) | main/index.ts:832~890 | 교체 후 렌더러 복구·C1 배너 자가 해제 공짜 |
| C1 배너는 `epoch < CHANNELS_EPOCH`일 때만 발화 | useChannelsHydration.ts:124 | "신규 데몬/파싱 불가 → 배너"는 **불가능** — 그 케이스들은 warn 로그로 강등 (Codex #7 + 자체 발견) |
| shutdown은 RPC 핸들러를 정지시키지 않음 — suspend 스냅샷 캡처(:2592) 후에도 타 클라이언트가 `createSession` 가능 → 그 PTY는 기록 없이 dispose | Codex #1 | 신 데몬에 shuttingDown 시 세션-생성 RPC 거부 가드 추가. 구 데몬 교체 시엔 소급 불가 — 오늘 사용자가 배너 지시대로 수동 완전종료해도 동일한 창이므로 신규 위험 아님 |
| 데몬은 30s 주기 스냅샷도 씀 → ack 없이 죽어도 recovery의 snapshot 경로가 받음 | daemon/index.ts:759~ | 크래시급 종료의 데이터 바닥선 |

## 2. 목표 / 비목표

**목표**
- G1. 앱이 자기보다 **오래된** 데몬에 재접속(`spawned=false`)했을 때, 사용자 개입 없이 suspend→교체→recover를 자동 수행
- G2. split-brain 3결함(#1 false-dead 스폰오버, #2 성급한 SIGKILL, #3 이중 데몬)의 기존 방어를 단 하나도 약화시키지 않음
- G3. **pre-ack 실패**(shutdown ack를 받기 전의 모든 실패)는 구 데몬 재사용 + C1 배너(오늘의 동작)로 무손실 후퇴. **post-ack 실패**는 구 데몬이 이미 suspend를 완료했으므로 "재사용"이 물리적으로 불가 — 이 경우의 보장은 "세션은 디스크에 내구 확정 + respawn 버짓 기계가 새 데몬 기동을 계속 시도"다 (Claude #2 정정)

**비목표**
- live pty 핸드오버(fd passing) — 현 아키텍처에서 불가능하고, suspend/recover가 이미 출하된 보존 의미론
- 다운그레이드 교체(데몬이 앱보다 신규) — 절대 안 함, §4 게이트 참조
- 미드세션 파일워치 핫 업그레이드 — 트리거는 재접속 시점만
- C1 배너 제거 — 배너는 교체 실패·다운그레이드 케이스의 폴백으로 존속
- 동버전 dev 반복의 일반 stale 감지 — `channelsEpoch`는 **채널 스키마 한정** 신호다. 세션 스키마/RPC 계약만 바뀐 dev 데몬은 못 잡는다(Claude #7). 번들 mtime/hash 신호는 스코프 아웃

## 3. 버전 신호

**주 신호: spawn-time env.** launcher의 `spawnDaemon()`이 자식 env에 `WMUX_SPAWNED_BY_VERSION = app.getVersion()`을 **무조건 대입(상속값 덮어쓰기)** 한다 — wmux-in-wmux 도그푸드에서 부모 데몬-스폰 PTY로부터 구버전 값이 상속 오염되는 것을 차단(Claude #4). 데몬은 부팅 시 캡처해 `daemon.ping` 응답에 additive로 에코하되, **env가 없으면 sentinel `"unknown"`을 에코** — 즉 B′ 코드 데몬은 이 필드를 *항상* 낸다:

```jsonc
// daemon.ping 응답 (additive 3필드)
{
  "status": "ok", "pid": ..., ...,
  "spawnedByVersion": "3.16.0",   // B′ 데몬은 항상 존재. env 부재 시 "unknown"
  "channelsEpoch": 1              // shared/channels.ts CHANNELS_EPOCH
}
// daemon.shutdown 응답 (additive 1필드)
{ "status": "ok", "stateSaved": true }  // saveImmediate 반환값 (Codex #2)
```

이 sentinel 설계로 **"필드 자체 부재"가 정보 부재가 아니라 "pre-B′ 코드"의 양성 확정 신호**가 된다(auth 토큰을 통과해 ping에 답한 프로세스는 wmux 데몬이고, B′ 코드였다면 반드시 뭔가를 에코했을 것이므로). launcher의 unknown≠dead 원칙("파괴는 양성 확정에서만")과 첫 롤아웃 가치(3.16 데몬 교체)가 동시에 보존된다 — Claude #4의 원칙 위반 지적에 대한 해소.

빌드타임 주입(esbuild define)을 기각한 이유: `build:daemon` 스크립트에 셸 치환은 Windows cmd 호환이 불확실하고, 런타임 package.json 읽기는 prod(resourcesPath/daemon-bundle)에서 인접 파일이 없다.

## 4. 교체 게이트 (전부 만족해야 발동)

```
spawned === false                       // 재사용된 데몬일 때만. 방금 스폰한 데몬은 정의상 현재 버전
&& !replacedOnceThisRun                 // 앱 프로세스 수명당 1회(재시작 시 리셋). 실패해도 재무장 안 함 —
                                        // 성공시-설정으로 바꾸면 실패 반복 시 재접속마다 스톨 루프 (GLM #4 기각 근거)
&& isDaemonOlder(pong, appVersion)      // 아래 표
```

`isDaemonOlder` 판정표 (순수 함수, 테이블 테스트):

| 데몬 ping 응답 | 판정 | 근거 |
|---|---|---|
| `spawnedByVersion` 필드 없음 | **older → 교체** | pre-B′ 코드의 양성 확정 (§3 sentinel 설계) |
| `"unknown"` (sentinel) | 유지 + warn 로그 | B′ 데몬인데 스폰 경로 불명 = 정보 부재 → 파괴 금지 (Claude #4) |
| 유효 semver, 앱보다 낮음 | **older → 교체** | 본 케이스 (3.15/3.16 데몬 + 신 앱) |
| core 동일 && 데몬만 프리릴리스 접미사 | **older → 교체** | 3.16.0-alpha < 3.16.0 (Claude #11) |
| core 동일 && `channelsEpoch`가 숫자이고 `< CHANNELS_EPOCH` | **older → 교체** | dev 윈도우 내 채널 스키마 범프. epoch 부재/비숫자는 이 행에 해당 없음(명시 분기) |
| core 동일, 위 어느 것도 아님 | 유지 | 정상 |
| 유효 semver, 앱보다 높음 | 유지 + warn 로그 | 다운그레이드 금지. C1 배너는 epoch 기반이라 이 케이스에 안 뜸 — 로그가 유일한 흔적(정직) |
| semver 파싱 불가 | 유지 + warn 로그 | 파괴적 행동은 "older 양성 확정"에서만 |

semver 비교는 숫자 삼중쌍 + 프리릴리스 유무 — 외부 패키지 도입 안 함.

**핑퐁 전쟁 분석 (R1).** 도그푸드 현실: packaged 앱(3.16)과 `npm start` dev 앱(3.17)이 데몬 1개를 공유하는 상황이 실존한다. 방어 2중:
- 방향 게이트: 구 앱은 신 데몬을 절대 교체 안 함 → 전쟁의 한쪽 팔이 구조적으로 없음
- `replacedOnceThisRun`: 각 앱은 프로세스 수명당 1회만 시도 → 유한 수렴, 최종 상태는 "데몬 1개(최신) + 진 쪽에 로그/배너"

**무고한 제2 인스턴스의 비용 (Claude #5, 정직 문서화).** dev 앱이 공유 데몬을 교체하면 packaged 앱의 라이브 프로세스도 죽고 resume으로 재기동된다(세션 유실은 아님 — packaged 앱은 disconnect → respawn → 신 데몬의 recovery로 세션 회수). 이는 수용한다: 이중 버전이 데몬 1개를 공유하는 상태 자체가 B′가 치유하려는 병리이고, 어느 쪽이든 한 앱은 불일치 상태이므로 최신으로 수렴하는 것이 옳은 전역 상태다. 연결수 기반 게이트는 MCP 클라이언트가 수를 인플레이션시켜 교체를 영구 차단하는 문제로 기각.

## 5. 교체 시퀀스 (v1.1 — 교차 합의 #1~#4 반영)

발동 지점: `DaemonRespawnController.spawnAndConnect()`(:205). 이미 auth용 `daemon.ping`을 보내고 결과를 **버리고** 있다 — 이 pong을 캡처해 게이트를 평가한다. install() 전에 발동하므로 낡은 데몬이 렌더러에 설치되는 일 자체가 없다.

오케스트레이터는 `runDaemonReplacement(deps)`로 추출 — `shutdownRpc/disconnect/checkLiveness/killVerifiedPid/sleep/isCancelled/log` 전부 주입(`tryEscalatedReping` 선례, 라이브 데몬 없이 유닛 테스트). `oldPid`는 진입 시 **캡처해 고정** — pid 파일 재독 금지(교차 합의 #4).

```
0. 게이트 통과 → replacedOnceThisRun = true (시도 전에 세움)
   emit {type:'replacing'} → 렌더러 토스트
1. raceDaemonShutdown(client, 8_000)
   // 8s < 데몬 10s 하드 타임아웃. 예산 내 무응답이면 데몬은 "아직 살아서 hang 중"이
   // 보장됨 — 12s로 잡으면 타임아웃 분기가 항상 "이미 죽은 데몬"이 되어 죽은 client를
   // 재설치하는 영구 정지 결함 (Codex #3 + Claude #1, health probe :308이 !isConnected면
   // 즉시 return이라 에스컬레이션도 안 됨)
   ├─ ok(ack) → ackReceived=true → 2로. stateSaved===false면 warn 로그(스냅샷급 강등 인지)
   ├─ 실패 && client.isConnected  → [pre-ack 중단] 살아있는 데몬의 진짜 거부/지연
   │    → 그 client 그대로 install (구 데몬 재사용, 오늘과 동일) + C1 배너가 안내
   │    → hang 데몬이 10s에 자살해도 이번엔 disconnected 리스너가 배선된 뒤라(install 완료)
   │      기존 handleDisconnect → respawn 기계가 정상 인계 — 자가 치유
   └─ 실패 && !client.isConnected → 데몬이 shutdown 중 죽음(크래시급, ack 유실 가능)
        → ackReceived=false인 채 2로 (SIGKILL 에스컬레이션은 4에서 게이트)
2. await client.disconnect()          // 우리 소켓이 잔여 정리를 막지 않도록, 실패 무시
3. 죽음 확정 루프: checkLiveness(oldPid) 250ms 간격, 최대 5s
   ├─ 'dead' 확정 → sleep(200)      // Windows named-pipe 핸들 해제 settle,
   │                                 // launcher 자체 kill 경로(:762)와 대칭 (Claude #8)
   │  → 4로
   └─ 5s 소진(alive/unknown):
      ├─ ackReceived && killVerifiedPid(oldPid, {definitiveOnly:true}) 성공
      │    // 캡처된 pid 명시 타겟. image+cmdline이 **정의적으로 확인된 경우에만** kill —
      │    // 검증 lookup null(AV 지연)이면 kill 포기. before-quit용 killDaemonByPidFile의
      │    // "불확정이어도 진행" 완화를 이 비-시급 경로에선 쓰지 않음 (Claude #6 + Codex #5).
      │    // ack 후 kill이 안전한 이유: 데몬은 ack 후 어차피 자멸 경로(1s force-exit) —
      │    // kill은 데이터 결과를 바꾸지 않음
      │  → 재확인 dead → sleep(200) → 4로
      └─ 그 외(ack 없음 / kill 거부 / 여전히 alive) → [post-shutdown 실패] FAIL 반환
         → 죽은/죽어가는 client는 절대 install하지 않음 → 6의 실패 라우팅
4. isCancelled() 체크 (before-quit이 dispose를 불렀는가 — Codex #6 + Claude #3)
   ├─ 취소됨 → FAIL 반환 (스폰 전 중단)
   └─ 진행: ensureDaemon() → PID dead 확정 → stale 청소 → 새 데몬 스폰(spawned=true)
5. 스폰 직후 isCancelled() 재체크
   ├─ 취소됨 → killVerifiedPid(newPid, {definitiveOnly:true}) 후 FAIL
   │    // "완전 종료" 중에 detached 신 데몬이 살아남는 창 봉쇄 (Claude #3)
   └─ 새 client 생성 + auth ping → 성공 반환 → install() → daemon:connected
      → 렌더러 late-reconcile + 채널 재수화(배너 자가 해제) + recovery가 세션 replay
6. FAIL 라우팅 (구 데몬 죽음이 확정/유발된 뒤의 모든 실패):
   spawnAndConnect는 null 반환 + 컨트롤러에 replacementDeadEnd 플래그.
   - attemptRespawn 맥락: 기존 scheduleRespawn 루프가 그대로 인계 (버짓 1단위 소모는
     수용 — once-per-run이라 최대 1회, Claude #10)
   - bootstrap 맥락: bootstrap()이 null + 플래그를 보고 handleDisconnect('replacement
     dead-end')를 호출해 **명시적으로 버짓 루프 진입** — bootstrap은 원래 1회 시도 후
     local 모드로 떨어지는 경로라 이것 없이는 "respawn 기계 인계"가 거짓 (Codex #4 +
     Claude #2). 세션은 디스크에 suspended로 안전.
```

**호환성**: `daemon.shutdown` RPC는 Phase A(A2)부터 존재 — 현존 구 데몬(3.13+) 전부 지원. 그보다 오래된 데몬은 RPC 즉시 에러 → isConnected=true → pre-ack 중단 경로.

**신 데몬 측 보강 (Codex #1)**: shutdown 진행 중(`shuttingDown=true`) 세션-생성 RPC를 `SHUTTING_DOWN` 에러로 거부하는 가드를 신 데몬에 추가 — suspend 스냅샷 이후 끼어든 createSession의 PTY가 기록 없이 죽는 창을 봉쇄. 구 데몬을 교체할 때는 소급 적용 불가하지만, 그 창은 오늘 사용자가 배너 지시대로 수동 완전종료해도 동일하게 존재 — B′가 신설하는 위험이 아님.

## 6. 실패 정책 요약

> **파괴적 에스컬레이션(SIGKILL)은 shutdown ack 이후 + 캡처된 PID + 정의적 검증 성공 시에만.**
> ack의 의미는 "데몬이 할 수 있는 persistence는 전부 시도 완료"(saveImmediate 실패 시 스냅샷급 강등, `stateSaved`로 관측) — kill은 어차피 자멸할 프로세스를 앞당길 뿐 데이터 결과를 바꾸지 않는다.

| 실패 지점 | 처리 | 사용자 가시 결과 |
|---|---|---|
| shutdown RPC 거부/타임아웃, client 생존 | pre-ack 중단, 구 데몬 재사용 | C1 배너 (오늘과 동일). hang이었다면 10s 자살 후 기존 respawn 기계가 자연 인계 |
| shutdown 중 데몬 즉사(하드 타임아웃 exit(1), ack 유실) | 죽음 확정 → 스폰. SIGKILL 없음 | 크래시급 recovery(마지막 30s 스냅샷). B′가 이 크래시를 유발할 수 있음은 사실이나, 동일 데몬은 사용자 수동 완전종료에서도 같은 경로로 죽음 |
| ack 후 프로세스 linger | killVerifiedPid(캡처 pid, 정의적 검증 필수) | 없음 (데이터 이미 확정) |
| kill 거부/검증 불확정/여전히 alive | FAIL → respawn 버짓 기계 (bootstrap 포함, §5-6 라우팅) | reconnecting 토스트 → 최악 respawn-exhausted 다이얼로그. 세션은 디스크에 안전, 다음 시도/재시작 시 recover |
| 죽음 확정 후 새 스폰 실패 | 동일 FAIL 라우팅 | 상동 |
| before-quit이 교체 중 발화 | isCancelled로 스폰 전 중단 / 스폰 직후면 신 pid kill | "완전 종료" 보장 유지 |
| 교체 성공했는데 여전히 older 판정(이론상) | once-per-run → 재발동 없음 | warn 로그 |

## 7. 변경 파일

| 파일 | 변경 | 규모 |
|---|---|---|
| `src/daemon/index.ts` | ① 부팅 시 `WMUX_SPAWNED_BY_VERSION` 캡처(부재 시 `"unknown"`), ping 응답에 `spawnedByVersion`/`channelsEpoch` additive ② shutdown 응답에 `stateSaved` additive ③ `shuttingDown` 중 세션-생성 RPC 거부 가드 | ~15줄 |
| `src/main/daemon/launcher.ts` | ① `spawnDaemon()` env에 버전 **무조건 대입** ② `DaemonPingResult`에 2필드 ③ `checkProcessLiveness` export ④ `killVerifiedDaemonPid(pid, {definitiveOnly})` — 기존 killDaemonByPidFile의 가드 로직을 명시-pid + 정의적-검증 모드로 파라미터화(기존 함수는 그 위의 얇은 래퍼로 유지, before-quit 의미론 불변) | ~40줄 |
| `src/main/daemon/daemonReplacement.ts` (신규) | `isDaemonOlder()` 판정 + `runDaemonReplacement()` 오케스트레이터 (전부 주입식) | ~150줄 |
| `src/main/daemon/DaemonRespawnController.ts` | spawnAndConnect: pong 캡처 → 게이트 → 오케스트레이터, `replacing` RespawnEvent, once-per-run 플래그, replacementDeadEnd 플래그, bootstrap의 dead-end → handleDisconnect 라우팅, isCancelled=()=>this.disposed 주입 | ~60줄 |
| `src/main/index.ts` | emit 스위치에 `replacing` → `daemon:replacing` IPC | ~5줄 |
| `src/preload.ts` + 렌더러 daemonMode/토스트 | `daemon:replacing` 구독 + ko/en 토스트 (D2 채택 시) | ~20줄 |

## 8. 테스트 계획

- `daemonReplacement.test.ts` (신규):
  - `isDaemonOlder` 판정표 **8행 전부** + 프리릴리스 조합 + epoch 부재/비숫자 분기
  - 시퀀스: happy path(ack→dead→settle→done) / **8s 예산이 hang 데몬에서 pre-ack 중단 + isConnected=true → 재사용 신호 반환** / **RPC 실패 + isConnected=false → ack 없이 죽음 확정 경로, kill 미호출** / ack 후 linger → 캡처 pid로 kill(파일 재독 없음 검증) / kill 검증 불확정 → kill 포기 + FAIL / **liveness가 5s 내내 unknown(Windows AV 시나리오) → ack 있어도 정의적 검증 실패 시 FAIL** / isCancelled 스폰 전/후 각각 / disconnect 실패해도 진행
  - once-per-run: 실패 후 재무장 안 됨
- `DaemonRespawnController.test.ts` (기존 확장): 게이트 3조건 / 교체 성공 시 새 client로 install 1회만 / pre-ack 중단 시 구 client로 install / **dead-end 시 어떤 client도 install 안 함 + bootstrap 맥락에서 handleDisconnect 호출됨(버짓 루프 진입)** / attemptRespawn 맥락에서 scheduleRespawn 인계
- 데몬 측: ping 필드(env 있음/없음→sentinel), shutdown `stateSaved`, shuttingDown 중 createSession 거부
- 이중 인스턴스 실시간 시뮬은 통합 수준이라 유닛 스코프 아웃 명시(GLM #7 부분 채택) — 수렴 논거는 §1의 잠금 2중 강제(코드 사실)로 갈음
- 기존 launcher.liveness/reping/pollCadence 테스트 무변경 회귀 확인

## 9. 도그푸드 절차

1. main(3.16.0, pre-B′) 데몬을 살려둔 채 B′ 브랜치 `npm start`
2. 기대: 부팅 수 초 내 "교체 중" 토스트 → 데몬 로그 `rpc.shutdown` → 새 데몬 부팅 → 세션 전부 recovery replay(스크롤백 보존, 에이전트 resume) → 채널 배너 **없음** + P5 병합 마이그레이션(로스터 "나" 단독) 확인 — 미완 도그푸드 C1 항목 동시 해소
3. 역방향: B′ 데몬을 살려둔 채 구 빌드 실행 → 교체 미발동(신규-데몬 행) + warn 로그
4. 외부 MCP(파이프 직결) 사용자는 교체 창(수 초)에 일시 오류 후 재접속 시 정상 — 앱 재시작과 동급 이벤트 (Claude #9)
5. `WMUX_DATA_SUFFIX` 격리 가능하나 2번은 실데이터로 해야 진짜 검증

## 10. 오픈 결정 (사용자)

- **D1. 자동 vs 버튼.** 본 설계 = 완전 자동(권고). 발동 시점이 "앱에 새로 접속하는 순간"이라 멘탈 모델과 일치, 임팩트는 기존 "완전 종료 후 재시작"과 동일. 기각 시 C1 배너 "지금 교체" 버튼으로 강등 — 오케스트레이터 동일, 트리거만 교체.
- **D2. `replacing` 토스트 포함 여부.** 포함 권고(~20줄) — 무언 자동 교체면 pane들이 수 초 얼었다 replay되는 것이 무설명 글리치로 보임.

## 11. 리뷰 로그 (3모델 패널, 2026-07-05)

- **Codex** (8건, 전부 실좌표): #1 비정지 shutdown→신데몬 가드+문서화 / #2 ack 문구 정정+stateSaved / #3 12s>10s 죽은 client install → 예산 8s / #4 bootstrap 버짓 부재 → dead-end 라우팅 / #5 kill 파일재독 → 캡처 pid / #6 before-quit 경쟁 → isCancelled / #7 신규-데몬 배너 불가 → warn / #8 liveness export. **8/8 채택.**
- **GLM 5.2** (8건): 2 CRITICAL은 실코드 검증에서 환각 판정(이중 스폰 방어가 "같은 부모만"이라는 주장 — 실제는 데몬 자식의 잠금 2중 강제로 부모 무관; 무고 프로세스 SIGKILL — killDaemonByPidFile 가드 미인지). G6(하드 타임아웃 ack 유실)·G7(race 테스트)은 부분 채택. **2/8 부분 채택, 6/8 기각.**
- **Claude Opus 적대** (11건, §1 좌표 전수 재검증): CL1(=C3 강화: probe 영구정지 메커니즘 규명) / CL2(=C4: G3 문구 거짓 입증) / CL3(=C6: detached 신데몬 생존 창) / CL4(unknown≠dead 위반 → sentinel 설계로 해소, env 무조건 대입) / CL5(무고 인스턴스 비용 → 정직 문서화) / CL6(=C5: 정의적 검증 필수) / CL7~11(minor: epoch 범위, settle, MCP 창, 버짓 소모, 프리릴리스 엣지). **9 채택(2건은 문서화로), 2 부분.**
- 교차 합의(≥2모델): 예산 8s / bootstrap 라우팅 / before-quit 취소 / kill 타겟·검증 / 배너 불가 — 전부 v1.1에 반영.
