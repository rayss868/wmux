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
- `daemon.ts` — `dist/daemon-bundle/index.js`를 격리 env로 스폰, `daemon.ping` 폴링으로
  ready. SIGKILL·재스폰(S7 대비 API)·로그 채집. **번들 부재 시 명시 에러**(자동 빌드 안 함).
- `pipe.ts` — 데몬 파이프 JSON-RPC 클라이언트(line-delimited, id 상관, 토큰 인증). 이중
  ok 계층(트랜스포트 봉투 vs 핸들러 Result)을 벗겨 채널 op는 `result.ok`로 판정. **G6
  정직-main 규율**: 생성자에 workspaceId 1개 바인딩, 모든 호출에 그 값만 스탬프, 예약
  신원(ws-human/local-ui)·타 ws 자칭은 throw.
- `assert.ts` — 상태 어서션(seq 무결성·본문 전수·unread). **각 헬퍼 주석에 정본 코드
  좌표 필수**(계약 이동 시 리그가 함께 깨지도록 — §5).
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

## 시나리오

| id | 구성 | 핵심 어서션 | 상태 |
|---|---|---|---|
| S1 | flood ×8 | 전 도달·seq 연속·무중복(getMessages 전수 대조) | 이 PR |
| S2~S8 | — | — | 후속 PR (PR-R2) |

페르소나 프레임워크(`persona.ts`)와 S2~S8·카오스·E2E·CI는 후속 PR 몫(설계 §9).
