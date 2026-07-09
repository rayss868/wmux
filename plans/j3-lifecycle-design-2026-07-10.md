# J3 — 태스크 수명주기 완성: 수확 후 정리 + 함대 리부트 생존 데모 (2026-07-10)

- 상태: **v1.1 — 3모델 패널 플랜 리뷰 반영판**(Codex 9 + Claude 실코드 10 + GLM 8 — §10 리뷰 로그). v1 대비: close 순서 역전(remove→close)·prUrl을 신규 mutable 필드로 재정의·onExhausted 신규 IPC 설계 인정·gh 4중 게이트·D5 실증 범위 분리·정리 스캔 정본을 디스크로.
- 계약: 전략 §4 NB1 J3(**8주 하드 게이트**) · 로드맵 §6.J · J1 v1.2 이연분 · J2 v1.1 이연분
- 목적: 태스크의 "끝"을 완성 — ① close UX ② 1클릭 PR ③ onExhausted 배선 ④ 이탈 감지 ⑤ 함대 리부트 생존 데모.
- 비목표: J4 주석 피드백 / 자동 재물질화 / 이탈 차단(경고만) / PR 리뷰·머지 UI / 태스크 사이드바 1급(W2) / onExhausted 상태 영속(리뷰 G8 — 토스트+파일 실존 검사로 한정, 영속 재발사 큐는 과잉)
- **성공기준(관측 가능 — 리뷰 반영 실증 범위 분리)**: ① close E2E — `dirty → remove 거부 + close 보류 + 보존 등재 / clean → remove 성공 → close → 채널 archive(실패 시 archivePending 표시·부트 reconcile 수렴) / 미push 커밋 존재 → 경고+PR 제안`. ② PR E2E — `gh 인증 환경: 1클릭(확인 1회) → push + PR(--base 명시) + prUrl 커밋 / 재클릭(이전 실패 후) → 기존 PR URL 회수 수렴 / gh 부재·미인증 → 안내+브라우저 폴백`. ③ **함대 데모(하드 게이트 — 2단 분리)**: (a) 스크립트 PASS = fanout N=4 → 산출물 시딩 → 데몬 재시작 → **데몬 상태 전량 복원**(projection open·물질화 필드·worktree fs·채널 active) (b) 수동 시나리오 문서 = main 재기동 워크스페이스 복원 확인 절차(랜딩 문구는 (a)+(b) 합산 근거로만). ④ onExhausted E2E — `유실 강제 → 토스트+리포트 / 재발사 → 프롬프트 파일 실존 검사 후 inject`.

---

## 1. 결정 D1 — close: **remove 성공 → close 커밋** 순서(역전), 스캔 정본은 디스크

리뷰가 v1의 "close 먼저" 순서를 3중 타격(CX1 크래시 잔여·CX2 archive 삼킴·G2 롤백 부재). 재설계:

- **clean 경로(순서 역전)**: ① upstream/ahead 검사 — 미push 커밋 있으면 경고+PR 제안(CX3: "clean ≠ 수확 완료") ② `TaskWorktreeManager.removeWorktree`(내부 porcelain 재검사가 정본 게이트 — G1 TOCTOU는 remove 내부 검사로 흡수, 사전 검사는 UX 표시용) ③ remove 성공 후에만 `mission.close` ④ meta dir(prompt.md) 삭제. ②실패(그새 dirty) → dirty 경로로 전환. ③④사이 크래시 → open 태스크+worktree 없음 = 미물질화형 잔여 — 정리 스캔이 줍는다.
- **dirty 경로**: remove 거부(J1 실물) → **close도 보류**(태스크는 open 유지 — "닫혔는데 산출물 잔존" 모순 제거, G2) → 보존 목록 등재 + "보존됨" 토스트. 사람이 정리 목록에서: 산출물 확인(diff 재열람) → 커밋/PR or 폐기 확정(그때 remove+close).
- **close의 채널 archive**: J0 실물대로 close가 archive 동반 — archive 실패는 삼키되(J0 내성 계약) 응답에 `archivePending` 표시(CX2), 부트 reconcile이 재시도 수렴.
- **미물질화 태스크(CX4)**: worktreePath 부재 open 태스크의 close는 **회수 확인 다이얼로그 경유**(worktree 없음을 명시 — 스캔 누락 방지는 아래 디스크 정본이 담당).
- **정리 스캔 — 정본은 디스크**(CL5: J0 closed 7일 GC가 projection 스캔의 근거를 소멸시킴): 전용 루트(`{wmux home}/worktrees/`) 순회가 1차 — **metaDir에 `task.json`(taskId·title·closedAt) 각인**(J1 meta 구조 확장)으로 태스크 소멸 후에도 역추적. projection은 보조(open 태스크 대조). 스캔 4종 판정 유지: 미물질화 open / 디스크 결측 / 보존 잔존 / 무연결 디렉토리.
- prompt.md: clean close 시 meta dir째 삭제. open 중엔 보존(재발사 재료 — CL2 충돌은 "open에서만 재발사 유의미"로 자연 해소, 문서 명시).

## 2. 결정 D2 — 1클릭 PR: gh 4중 게이트 + 멱등 재진입 + prUrl 신규 mutable 필드

- **prUrl의 실체 정정**(CL3 실코드): 현 updateMission은 branch/worktreePath/paneGroupId 3필드만 순회 — prUrl은 게이트도 patch도 wire도 없다. J3 작업 = **prUrl 신규 배선**: wire 화이트리스트 추가·비단조(갱신 허용)·**closed 태스크에도 prUrl만 허용**(CX6 — PR은 close 후에도 생성 가능)·**URL 검증**(G5: `^https://github\.com/[^/]+/[^/]+/pull/\d+$` — 임의 URL 거부).
- **gh 시퀀스(4중 게이트)**: ① `gh --version` + **`gh auth status`**(G3 — 버전≠인증) ② dirty 검사 — 미커밋 변경 있으면 "PR에 포함 안 됨" 경고+차단(CX7, 커밋 안내) ③ `git push -u origin wtask/{slug}`(execFile argv — G6 셸 조립 금지 계약 명시) ④ `gh pr create --head --title --body --base {베이스}` — **--base 명시**(CL4: upstream 없는 신규 브랜치의 base 추론 실패 방지. 베이스 = fan-out 시점 원본 브랜치 [J2대조: 미기록 — repo default를 `gh repo view --json defaultBranchRef`로 조회] ).
- **멱등 재진입**(CX5+G4): pr create 실패 시 `gh pr list --head wtask/{slug}` 조회 — 기존 PR 있으면 URL 회수로 성공 수렴. push의 "이미 존재"는 fast-forward면 무해 통과. half-done(push만 성공) 상태는 재클릭이 자연 수렴.
- 확인 1회: push+PR 확인 다이얼로그(remote URL·브랜치·**pre-push hook 실행 가능성 1줄** — CX9 고지). "1클릭" 문면은 "확인 1회 포함"으로 정합(CL8).
- PrStatusCache: PR 생성 성공 시 `invalidate(cwd, branch)`(CX8 — 5분 TTL 공백 제거).

## 3. 결정 D3 — onExhausted: 신규 이벤트 채널 1본 (기존 배선 부재 인정 — CL1)

- v1의 "콜백 스레드" 전제 철회(CL1 실코드: onExhausted는 pty.handler 내부 발화 — fanout·taskId를 모름). 설계: **`PTY_INITIAL_CMD_EXHAUSTED` 이벤트 신설**(pty.handler onExhausted → main 이벤트 → 렌더러 브로드캐스트, payload `{ptyId}`) + FanOutService가 스폰 시 `ptyId→taskId` 매핑 유지 [J2대조: spawnWorkspace 반환에 ptyId 포함 여부] → 렌더러 토스트 "태스크 {title}: 프롬프트 미발사" + [재발사](프롬프트 파일 **실존 검사 후** injectText — 파일 소실 시 사유 표시).
- 상태 영속 안 함(G8 절충): 리부트로 토스트 소실은 수용 — open 태스크의 빈 에이전트 페인은 사람이 관측 가능하고, 재발사 재료(prompt.md)는 open 동안 잔존(§1). 계약 명시.

## 4. 결정 D4 — 이탈 감지: `onCwdUpdate` 신규 구독 (localContextWatch 아님 — CL6)

- 정정: localContextWatch는 로컬 모드 전용 마운트(registerHandlers.ts:167) — 재사용 대상은 하부 펀넬 `onCwdUpdate`(로컬·데몬 양모드 발화, pty.handler:284 확인). **독립 구독 신설**: 태스크 워크스페이스의 페인 cwd가 worktreePath 경계 밖(normalizeWorktreePath 비교) → 워크스페이스 헤더 경고 뱃지. 원본 repo 경로는 강조. best-effort(OSC 협조 기반) 명시·차단 없음.

## 5. 결정 D5 — 함대 데모: 실증 2단 분리 (과장 제거 — G7+CL7)

- **(a) 스크립트**(자동·하드 게이트 판정식): fanout N=4(데몬 직결) → 산출물 시딩 → 데몬 재시작 → 데몬 상태 전량 복원 검증(projection·물질화 필드·worktree fs·채널 active). **스크립트가 실증하는 범위는 여기까지 — "워크스페이스 생존" 주장 금지.**
- **(b) 수동 시나리오 문서**(촬영용): 실 앱에서 fan-out 4대 → 강제 종료 → 재기동 → 워크스페이스·페인·diff 재열람 확인 절차. 랜딩·데모 문구는 (a)+(b) 합산 근거로만("reboot-resilient agent sessions" 계열, 절대 표현 금지 — P7).
- 리그(자동 회귀)와 분리 유지: 리그 = J2 채택 원자성 몫.

## 6. 구현 표면·위임 범위

| 계층 | 신설/변경 | 내용 |
|---|---|---|
| daemon | 변경(소) | task.update **prUrl 신규 배선**(wire·비단조·closed 허용·URL 검증 — §2) |
| main | 신설/변경 | close 오케스트레이션(§1 순서 역전·upstream 검사·archivePending)·정리 스캔(디스크 정본·task.json 각인)·PR 시퀀스(§2 4중 게이트·멱등 재진입·invalidate)·`PTY_INITIAL_CMD_EXHAUSTED` 이벤트(§3)·cwd 이탈 구독(§4) |
| renderer | 신설(소) | close·PR 버튼([J2대조])·정리 목록 뷰(팔레트 진입)·미발사 토스트+재발사·이탈 뱃지 |
| scripts/docs | 신설 | 함대 데모 스크립트 + 수동 시나리오 문서(§5) |
| tests | 신설 | close E2E 3본(clean·dirty·미push 경고)·순서 크래시 창(remove 후 close 전)·정리 스캔 4종+GC 이후 역추적(task.json)·PR 시퀀스(auth 게이트·--base·멱등 재진입·dirty 차단·URL 검증·invalidate)·prUrl(closed 허용·타 필드 여전히 write-once)·onExhausted 왕복+파일 소실 재발사 거부·이탈 판정·함대 스크립트 그린 |

검증 게이트: 신규 테스트 그린 + `test:parallel` 무영향 + `tsc` 클린 + **함대 데모 스크립트 PASS**.

## 7. 리스크·함정

| 리스크 | 대응 |
|---|---|
| remove→close 사이 크래시 | 잔여 = open+worktree 부재 — 정리 스캔 수렴(§1). close 먼저보다 안전한 방향(산출물 우선) |
| archived 채널 코멘트 열람 [J2대조] | J2 실물 확인 — 불가면 close 전 경고 편입 |
| push 원격 오염·fork 워크플로 | 확인 다이얼로그에 remote URL 명시 + 다중 remote는 head 추론 실패를 명시 에러로(자동 추측 금지) |
| gh 대화형 멈춤 | 전 인자 명시 + 타임아웃 + stderr 전파 |
| 스캔 fs 비용 | 온디맨드 + 전용 루트 한정 |
| 데모 과장 | §5 2단 분리 — 스크립트 주장 범위 명문화 |

## 8. [J2대조] — 해소 완료 (2026-07-10, J2 실물 대조)

1. **DiffPanel 헤더 실존**(src/renderer/components/Diff/DiffPanel.tsx:237) — close·PR 버튼 배치 지점 확보.
2. **archived 채널 read 가능 확정** — CHANNEL_ARCHIVED 게이트는 변이 전용(post:1572·join:952·invite:1433), getMessages(:600)는 무게이트 → close 후 코멘트 열람 유지. §7 "close 전 경고" 불요로 판정.
3. **spawnWorkspace 반환에 `ptyId?` 실존**(FanOutService.ts:53) — §3 ptyId→taskId 매핑 재료 확보(옵셔널이므로 부재 시 매핑 불가 태스크는 토스트 생략 — best-effort 정합).
4. --base = repo default 조회(`gh repo view --json defaultBranchRef`) — 확정.

## 9. 후속 순서

1. ~~3모델 플랜 리뷰~~ **완료(2026-07-10)** — §10 전건 반영 v1.1.
2. J2 코드 리뷰 완료·PR 후 → [J2대조] 해소 → J3 구현 위임(Opus).
3. 코드 리뷰 1R → PR → **함대 데모 확보 = 랜딩 파동 3·D-F 게이트 해제** 통지.

## 10. 리뷰 로그 — 3모델 패널 1라운드 (2026-07-10)

Codex 9(CX)·Claude 실코드 10(CL — updateMission prUrl 부재·onExhausted 격리·localContextWatch 모드·J0 GC를 file:line 확정)·GLM 8(G). 주요 반영: CX1+CX2+G2(close 순서 역전·archivePending) / CX3(미push 경고) / CX4(미물질화 close 다이얼로그) / CX5+G4(PR 멱등 재진입) / CX6+CL3(prUrl 신규 mutable 배선·closed 허용) / CX7(dirty PR 차단) / CX8(invalidate) / CX9(hook 고지) / G1(TOCTOU — remove 내부 게이트 정본) / G3(auth 게이트) / G5(URL 검증) / G6(execFile 계약) / G7+CL7(D5 2단 분리) / G8(영속 안 함 절충) / CL1(이벤트 채널 신설) / CL2(prompt.md open 보존) / CL4(--base 명시) / CL5(디스크 정본+task.json) / CL6(onCwdUpdate 직구독) / CL8(1클릭=확인 1회 정합) / CL9(fork 명시 에러) / CL10([J2대조]2 편입).
