# 검증 리그 (validation rig)

wmux의 자가 검증 하니스. 정본 설계: `plans/validation-rig-design-2026-07-08.md` (v1.1).

일회성 `scripts/*.mjs` 도그푸드를 대체하는 1급 존재 — 시나리오는 하네스가 강제하는
`격리 → (데몬) → 행위 → 어서션 → teardown` 형태의 vitest 테스트로만 존재한다.

## 레인 구조 (1페이지)

두 레인, 한 하네스(설계 §1):

| 레인 | 실행 모델 | 표면 | 현재 상태 |
|---|---|---|---|
| **SIM** (`rig/sim/`) | 헤드리스 데몬 번들 스폰 + 데몬 파이프 직결 | 채널·A2A·principal 정본 (앱 없이) | S1 (이 PR) |
| **E2E** (`rig/e2e/`) | 패키지 앱 + CDP | 렌더러·main↔데몬 | 후속 PR (PR-R3) |

기존 vitest 두 레인(`test:parallel`·`test:runtime`)과 완전히 분리 — 리그 include 글롭은
최상위 `rig/**/*.rig.test.ts`만 잡는다(`vitest.rig.config.ts`).

## 하네스 코어 (`rig/harness/`)

- `isolation.ts` — 런당 fresh 임시 홈(mkdtemp) + 4-env(HOME·USERPROFILE·APPDATA·
  LOCALAPPDATA) + `WMUX_DATA_SUFFIX='-rig-{runId}'`. runId는 전 OS 필수(win32 named
  pipe 전역 네임스페이스). 파이프·토큰 경로를 한 곳에서 파생해 인증 미스매치를 막는다.
  **env는 최소 allowlist**(PATH + 플랫폼 필수 + 4-홈 + suffix) — 부모 셸의 WMUX_*
  (유휴 셧다운·워치독 오버라이드 등)가 새어들어 데몬을 변조하는 클래스를 원천 차단.
- `daemon.ts` — `dist/daemon-bundle/index.js`를 격리 env로 스폰, `daemon.ping` 폴링으로
  ready. **트리킬**(posix 그룹킬 / win32 taskkill /T) + exit 회수 대기 + 고아 백스톱
  (`process.on('exit')` 레지스트리)·재스폰(S7 대비 API)·로그 채집. **번들 부재 시 명시
  에러**(자동 빌드 안 함).
- `pipe.ts` — 데몬 파이프 JSON-RPC 클라이언트(지속 소켓, line-delimited, id 멀티플렉싱,
  토큰 인증). 이중 ok 계층(트랜스포트 봉투 vs 핸들러 Result)을 벗겨 채널 op는
  `result.ok`로 판정. **G6 정직-main 규율 — public 표면은 `rpc()`/`channelRpc()` 2개뿐,
  원시 전송은 private**: 생성자에 workspaceId 1개 바인딩(예약 신원 ws-human/local-ui는
  바인딩 거부), `channelRpc()`만 그 값을 verifiedWorkspaceId로 스탬프, 밀수
  (verifiedWorkspaceId 위치 불문)·타 ws 자칭·`sender.workspaceId` 불일치·예약 신원 값은
  전부 throw. 단 블랭킷 금지는 아니다 — invite 타겟·A2A `to` 등 정당한 타 ws 참조는
  통과한다(`g6-guard.rig.test.ts`가 양방향 고정).
- `assert.ts` — 상태 어서션(seq 무결성·본문 전수·unread·deliveryStatus·taskState·replay
  단방 부분집합). **각 헬퍼 주석에 정본 코드 좌표 필수**(계약 이동 시 리그가 함께 깨지도록 — §5).
- `persona.ts` — 시드 주입 페르소나 프레임(§4). 페르소나 = { ws, client(PipeClient) }.
  신원 배정·채널 open(creator seat + 전원 join)·시드 결정성·teardown만 관리한다 —
  **행동 스크립트는 각 시나리오 소유**(6종 페르소나가 서로 다른 로직이라 과추상화 금지).
- `seed.ts` — 결정적 PRNG(mulberry32). 실패 시 시드 인쇄로 재현(G7). S2~S8 재사용.

## 로컬 실행법

```bash
# 선행: 데몬 번들 준비 (리그는 자동 빌드하지 않는다)
npm run build:daemon

# SIM 스모크(S1) 실행
npm run test:rig:sim
# = npm run test:rig (v1은 SIM만; E2E는 PR-R3)

# 실패 재현: 로그에 인쇄된 시드를 고정
WMUX_RIG_SEED=<seed> npm run test:rig:sim

# 타입체크
npx tsc --noEmit -p tsconfig.rig.json
```

격리 실효: 모든 데몬 상태(소켓·토큰·이벤트 로그·config)가 임시 홈 안에 있어 실행 후
`~/.wmux*` 실 홈은 오염되지 않는다(`os.homedir()`가 HOME 오버라이드를 추종).

## 시나리오 (SIM 레인 — v1.1 §4 표가 계약)

| id | 구성 | 핵심 어서션 | 상태 |
|---|---|---|---|
| S1 | flood ×8 (페르소나 간 동시 발사, 내부 순차) | 전 도달·seq 연속·무중복(getMessages 전수 대조) + 페르소나 내부 순서 보존 | PR-R1 |
| S2 | ping-pong ×2 (서로 멘션 왕복) | **채널 무결성만** — 무손실·순서·멘션 정합·데몬 ping 생존. **anti-loop 어서션 없음**(서버측 pair-cap 미구현·replyGate는 렌더러) | PR-R2 |
| S3 | dead ×3 + 정상 ×2 | unread·수명주기 수렴 + 채널 기능 잔존(dead 메시지·멤버십 원장 잔재) | PR-R2 |
| S4 | hung ×2 + 정상 ×2 | 채널 무결성·무한 홀드 없음(정상 post 즉시 커밋)·hung unread 정확. **넛지 어서션 없음**(live PTY 전제 — E2E 예약) | PR-R2 |
| S5 | no-ack ×3 | **현행 영수증 계약 고정**: deliveryStatus는 ack로만 pending→delivered(정본 좌표 주석) | PR-R2 |
| S6 | boundary | 캡 경계 수용/거부 정확성(본문 8192·멘션 64·완료증거 E12 문자열 캡) — 와이어 레벨 | PR-R2 |
| S7 | flood 중 데몬 SIGKILL→respawn | **단방 부분집합**: {RPC ok 커밋} ⊆ replay(확인된 커밋 무손실). ack는 커밋 증거 제외 → unread로 커서 생존만 확인 | PR-R2 |
| S8 | A2A 전 수명주기 + EPERM 카오스 | send→working→completed + verifiedItemCount·게이트 거부→재시도·멱등·**#354 멱등-authz(EVIDENCE ①)**. + EPERM(unix): 소켓 chmod 000 → 클라이언트 격리·데몬 생존·복구 | PR-R2 |
| G6 가드 | 하네스 유닛(데몬 불요) | rpc/channelRpc 신원 위생 throw + 정당한 크로스-ws 참조 비차단 | PR-R1 |

카오스 v1(G8): 데몬 SIGKILL(S7)·파이프 EPERM(S8, unix). 디스크풀·시계점프는 v1.1+ 이연
(정정 R2 승인). E2E·CI·넛지 가드(RigSession 소비)는 PR-R3+ 몫(설계 §9).

## 실검출 실증 (G9)

- **①단 SIM (이 PR)**: `rig/EVIDENCE.md` — #354 멱등-authz revert red/green 실증(CL7 선행
  게이트 조기 개방, 정정 R1). S8 시나리오가 red↔green 왕복으로 검증됨.
- **②단 GUI (PR-R4)**: 크로스-ws 멘션 전달 회귀 → E2E-2(예약).

## 도그푸드 흡수 (G10)

`rig/CATALOG.md` — 채널·A2A·신원 도그푸드 전수 3분류(absorb→시나리오 id / keep→수동 사유 /
retire). **물리 삭제는 시나리오 CI 1주 그린 후 개별 PR**(이 PR은 분류만).
