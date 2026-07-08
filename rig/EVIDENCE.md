# 검증 리그 — 실검출 증적 (설계 §7 / G9)

리그가 **실재하는 결함을 잡는다**는 실물 증거. 절차(§7): 픽스 커밋을 스크래치 브랜치에서
revert → 리그 red(실패 로그 캡처) → main(픽스 있는 브랜치) green → 여기 기록.

이 문서는 **CL7 선행 게이트 ①단**(SIM 실검출)이다. 로드맵 정정 R1(오너 승인 2026-07-08)에
따라, ①단 착지 시점부터 Q1-2 이하 W1 항목 착수가 언블록된다. ②단(GUI 실검출 — 크로스-ws
멘션 전달 회귀)은 PR-R4 몫(§7 표).

---

## ①단 — #354 멱등-authz 순서 결함 (SIM, PR-R2 동봉)

| 항목 | 값 |
|---|---|
| 결함 id | #354 (멱등 히트가 authz를 앞질러 비참여자 커밋 스냅샷 재생) |
| 픽스 커밋 | `2264c4a` — `fix(a2a): §6.M PR-B — move idempotency hit after authz + namespace by op (codex delta)` |
| 결함 위치 | 데몬측 `src/daemon/a2a/A2aTaskService.ts:329-334` (`transition()`의 멱등 히트 배치) |
| 잡는 시나리오 | `rig/sim/s8-a2a-lifecycle.rig.test.ts` — `it('멱등-authz 순서: 비참여자는 키를 알아도 커밋 스냅샷을 재생 조회할 수 없다 (#354)')` |
| 실증 일자 | 2026-07-08 |

### 왜 이 후보인가 (데몬측이라 SIM 관측면 도달)

v1 설계의 1순위(ws-human create 우회, `2160acf`/`15a5324`)는 **라우터측** revert라 SIM이
못 본다(데몬 파이프 직결 SIM은 main 라우터를 우회하므로 데몬 가드가 잔존해 red가 안 남 —
리뷰 P8, Claude M/72). #354는 **데몬측** 가드라 SIM이 정확히 관측한다.

### 결함의 성질

`transition()`에서 멱등 히트(캐시된 결과 반환)가 수신자 authz 체크보다 **앞**에 있으면,
idempotencyKey를 아는 비참여자(from/to 아님)가 같은 taskId+키로 재전송할 때 authz에
도달하기 **전에** 커밋된 태스크 스냅샷(`TransitionOk` — 커밋된 `task` 포함)을 재생 조회한다.
멱등키는 clientMsgId류로 추측·유출 가능하므로, 이는 authz 우회 정보 노출이다.

픽스(`2264c4a`)는 멱등 히트를 authz·soft-defer **뒤**, `validateTransition` **앞**으로
옮겼다. 정당한 재시도는 동일 입력이라 authz를 항상 재통과하므로 멱등성은 보존되고, 비참여자는
authz에서 먼저 거부된다.

### revert 절차 (스크래치 브랜치 `rig-evidence-354-scratch`)

`A2aTaskService.ts`의 멱등 히트 블록을 authz 체크(`task.metadata.to.workspaceId !==
input.callerWorkspaceId`) **앞**으로 되돌렸다(픽스 `2264c4a`의 역적용):

```diff
       const task = this.tasks.get(input.taskId);
       if (!task) return { ok: false, error: `a2a.task.update: task not found: ${input.taskId}` };
+      // [REVERT] 멱등 히트를 authz 앞으로 — 픽스 2264c4a 역적용.
+      const cached = this.idempotencyHit(input.taskId, input.idempotencyKey, 'transition');
+      if (cached) return cached as TransitionOk;
       // 권한: 수신자 workspace만 상태 갱신 가능.
       if (task.metadata.to.workspaceId !== input.callerWorkspaceId) {
         return { ok: false, error: `... is not the receiver` };
       }
       ...
-      // §4 멱등: authz·soft-defer 뒤 배치(원래 위치 — 제거).
-      const cached = this.idempotencyHit(input.taskId, input.idempotencyKey, 'transition');
-      if (cached) return cached as TransitionOk;
```

**src/ 변경은 이 스크래치 브랜치에서만 수행됐고, feat/validation-rig-scenarios 브랜치엔
커밋되지 않았다**(제약 준수 — 이 브랜치의 src/ 변경 0).

### red 출력 (revert 상태, `npm run build:daemon` 후)

```
FAIL rig/sim/s8-a2a-lifecycle.rig.test.ts > SIM S8 — A2A 전 수명주기 + EPERM 카오스
  > 멱등-authz 순서: 비참여자는 키를 알아도 커밋 스냅샷을 재생 조회할 수 없다 (#354)

AssertionError: 비참여자 전이는 거부돼야 한다(멱등이 authz를 앞지르지 않음): expected true to be false

- Expected
+ Received
- false
+ true

 ❯ rig/sim/s8-a2a-lifecycle.rig.test.ts:233:65

 Test Files  1 failed (1)
      Tests  1 failed | 4 skipped (5)
```

`attack.ok === true` = 비참여자(outsider)가 authz를 우회해 커밋된 working 스냅샷을 캐시
재생으로 받았다. 이게 #354 취약점의 SIM 관측이다.

### green 확인 (main = 픽스 있는 상태)

스크래치 브랜치 폐기 → `feat/validation-rig-scenarios`(픽스 `2264c4a` 포함) →
`npm run build:daemon` → 동일 테스트:

```
 Test Files  1 passed (1)
      Tests  1 passed | 4 skipped (5)
```

비참여자 전이가 `ok:false` + `is not the receiver`로 거부되고, `attack.task`가 `undefined`
(커밋 스냅샷 무누출)임을 어서트가 통과한다.

### 계약 이동 시 동작 (의도된 결합)

이 어서션은 정본 좌표(`A2aTaskService.ts:312-334`)를 주석에 달고 현행 authz-앞-멱등 계약을
못박는다. 향후 이 계약이 바뀌면(예: 멱등 배치 재설계) 리그가 함께 red가 되어 갱신을 강제한다
— 리그가 "60번째 도그푸드"가 되지 않게 하는 결합 규율(footgun 1).

---

## ②단 — 크로스-ws 멘션 전달 회귀 (GUI, PR-R4 예약)

미착수. PR-R4에서 E2E-2(크로스-ws 멘션 전달)로 실증 예정 — N-루프 패치 재적용
(`~/.wmux-multiws-delivery.patch`, 6652B) → E2E red → main green. 분기 게이트 문면("GUI
회귀") 충족의 실물(§7 표 ②단).
