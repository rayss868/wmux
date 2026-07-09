# J2 — diff 리뷰·hunk 채택: 태스크 여정의 수확 단계 (2026-07-10)

- 상태: **v1.1 — 3모델 패널 리뷰 반영판**(Codex 9 + Claude 실코드 9 + GLM 10 — §10 리뷰 로그). v1 대비: diff 소스를 워킹트리로 정정(미커밋 포함)·채택 계약을 all-or-nothing으로 고정·파서를 원문 보존형으로 재정의·타겟 드리프트 게이트·surfaceType 작업을 4번째 서피스 풀 구현으로 격상.
- 계약: `plans/strategy-reset-2026-07-09.md` §4 NB1 J2 · `plans/roadmap-12mo-world-no1-2026-07-05.md` §6.J diff 리뷰 페인 문면 · `plans/j1-fanout-design-2026-07-10.md` v1.2(worktreePath·미션 채널·태스크 워크스페이스)
- 목적: fan-out으로 퍼진 N개 태스크의 산출물(worktree 변경)을 **읽고 → 코멘트하고 → hunk 선택 채택**하는 여정의 수확 단계. §6.J 문면 준수: **"읽기·코멘트·체크아웃 3동작만 — 풀 IDE diff 에디터 금지."**
- 비목표: 1클릭 PR·prUrl 갱신(J3) / 코멘트 스레딩·리액션(채널 기존 기능) / 신택스 하이라이팅(diff +/- 색만) / 3-way 머지·충돌 해소 UI / rename·mode change·바이너리의 hunk 선택(파일 단위 표시만 — v1 채택 불가 라벨) / MCP 코멘트 발신(§4 — 렌더러 전용 명시) / 채택 원장·부분 적용 저널(all-or-nothing이라 불요)
- **성공기준(관측 가능)**: E2E — `태스크 worktree에 미커밋 변경 2파일(+untracked 1파일) → diff 서피스 열기 → 파일 트리 3파일·numstat → hunk 3개 중 2개 선택 → 채택 → 타겟 워킹트리에 선택분만 반영(독립 오라클: 적용 후 타겟 diff == 선택 hunk 집합 재직렬화 결과) → 코멘트 발사 → 미션 채널에 앵커 포함 포스트 실존`. 복원 E2E — `diff 서피스 포함 세션 재기동 → PTY 자가생성 0 + diff 재렌더`. 리그 실검출 — `주입 결함(재직렬화 메타데이터 훼손)을 리그가 red 검출 → 원복 green`(전략 P8 — 출하 블로커).

---

## 1. 결정 D1 — diff 서피스: 4번째 서피스의 풀 구현 (리뷰 정정 — "additive 한 줄" 철회)

v1의 "additive union 확장 = 무영향" 전제는 **거짓이었다**(리뷰 CL1·CL2·CX9): 렌더러의 surfaceType 분기가 negative 술어(`!== 'browser'`, `!== 'editor'` → else 터미널)로 20+ 지점 산재해, 미지 'diff'는 **터미널로 오인 렌더**되고 세션 복원 시 PTY 자가생성 경로에 걸릴 수 있다(src/renderer/components/Pane/Pane.tsx:544,583 · stores/slices/workspaceSlice.ts:634,650 · AppLayout.tsx:386,522).

- 작업 정의 격상: **negative 술어 전수 감사**가 D1의 본체다 — `surfaceType` 소비 지점 전수 목록화(grep 기반) → 각 지점에 diff 케이스 판정(터미널 아님·PTY 없음) 명시. 구현 표면(§6)에 감사 목록 산출물 포함.
- 배선 전량: Pane 렌더 스위치 diff 분기 + 서피스 생성 함수(addDiffSurface) + SurfaceTabs 라벨 + preload/electronAPI + 세션 영속·복원(ptyId 없는 서피스 — editor/browser 관례 확인 후 동일 적용).
- 서피스 상태: `{ taskId }`만 영속. diff 내용은 파생 데이터 — 열 때마다 재계산(worktree 소실 시 "손상" 표시 — J1 §2 디스크 결측 계약 미러).
- 진입: 태스크 워크스페이스 페인 + fan-out 리포트 토스트. 사이드바 1급은 W2 파동 2 몫.
- **복원 왕복 테스트 필수**(리뷰 CL8): diff 서피스 포함 세션 재기동 → PTY 자가생성 0 검증 — 성공기준 편입.

## 2. 결정 D2 — diff 데이터: **워킹트리 대조**(미커밋 포함) + 타겟 스냅샷 동봉

v1의 `git diff {mergeBase}...HEAD`는 **이중 오류였다**(리뷰 CX2 conf10 + CL4): ① 커밋된 변경만 봐서 에이전트의 미커밋 산출물(지배적 케이스)을 통째로 누락 ② `{SHA}...HEAD` triple-dot은 문법 오용. 정정:

- **diff 소스 = `git diff {mergeBase}` (태스크 worktree cwd, 2-arg 아님 1-arg — 워킹트리 vs mergeBase)**: staged+unstaged tracked 전부 포함. mergeBase = `git merge-base HEAD {targetHeadOid}` — 산출·캐싱은 diff:read 1곳(리뷰 G8 단일 출처).
- **타겟 repo 도출 — 스키마 무변경**(리뷰 CX1 해소): 태스크 worktree에서 `git rev-parse --git-common-dir` → 본 repo 경로. WorkTask에 repoPath 추가 불요(worktree가 본 repo의 worktree라는 물리 사실이 정본).
- **타겟 스냅샷 동봉**(리뷰 CX8+CL9 — 드리프트 게이트): diff:read 응답에 `{targetRepoPath, targetBranch, targetHeadOid, targetDirtyFiles}` 포함. applyHunks는 이 스냅샷을 되받아 **적용 직전 재검증** — HEAD/브랜치 불일치 시 "타겟이 이동됨 — diff 재열람" 거부.
- **untracked 포함**: `git status --porcelain`으로 수집 → **정식 new-file 헤더로 합성**(`diff --git` + `new file mode` + `--- /dev/null` + `+++ b/{path}` — 리뷰 CX6·CL6: git apply가 수용하는 형식 명세). untracked는 **파일 단위 all-or-nothing**(리뷰 G5 — 신규 파일 hunk 쪼개기는 의미 불성립, hunk 선택 UI 비활성).
- 캡: diff 총량 2MB·파일당 512KB — 초과·binary는 "파일명·numstat만"(조용한 절단 금지). 스트리밍은 이연(§6.J 문면 "스트리밍 파싱"과의 절충 — 캡 초과가 실관측되면 후속).

## 3. 결정 D3 — 채택 = **선택 hunk 단일 패치 all-or-nothing** (부분 성공 계약 폐기 — 리뷰 3모델 합의)

v1의 "부분 성공 허용(성공 hunk 적용·실패 hunk 표시)"은 단일 `git apply`의 all-or-nothing과 **자가당착이었다**(CX4·G2·CL7). 계약 재고정:

- **적용은 단일 패치 1회 `git apply` — 전부 성공 or 전부 미적용**(git 내부 원자성 활용). 부분 적용 상태가 물리적으로 없으므로 저널·복구 상태기계 불요(리뷰 CX7의 SIGKILL 순환도 해소 — 크래시해도 타겟은 온전 or 미적용).
- **per-hunk 사전 프로브**: 적용 전 각 hunk를 개별 `git apply --check`로 프로브해 실패 hunk를 **선택 해제 유도 표시**(어느 hunk가 문제인지 사용자가 보고 빼고 재시도). "이미 적용됨" 감지는 `--reverse --check` 프로브(성공 = 적용됨 — best-effort 뱃지, 리뷰 G7의 신뢰성 한계 명시: 확정 판정 아님).
- **재직렬화 = 원문 보존**(3모델 합의 — 메타데이터 유실 금지): shared `diffParse.ts`는 lossy 3분류가 아니라 **파일 헤더 블록(diff --git/index/mode/---/+++)과 hunk 바디를 바이트 원문으로 보존**하고, 선택 hunk 재조립 시 원본 파일 헤더에 재부착 + **hunk 헤더 라인카운트만 재계산**. `\ No newline at end of file` 마커·CRLF는 바디 원문 보존으로 자동 통과. v1 채택 지원 범위: **평문 modify/add/delete만** — rename·copy·mode change·binary는 표시만·채택 불가 라벨(CX5 fix안 채택).
- **오프셋**: 같은 파일에서 앞 hunk를 뺀 선택은 뒤 hunk의 old-side 라인이 원본과 동일하므로(old 파일 기준 오프셋은 다른 hunk 적용 여부와 무관 — unified diff의 old 좌표는 원본 파일 기준) 재계산 불요가 원칙이나, git apply의 컨텍스트 탐색 한계는 사전 프로브가 잡는다. **왕복 오라클 테스트**(G1 — 순환논리 금지): 재직렬화 결과를 실제 `git apply`로 청정 체크아웃에 적용 → 적용 후 diff가 선택 hunk 집합과 일치하는지 **git을 오라클**로 검증(파서 자기합의 금지).
- 타겟 오염 방어: ① 적용 전 대상 파일 dirty 거부(스냅샷 dirtyFiles + 적용 직전 재검사) ② 드리프트 게이트(§2) ③ 적용 결과 리포트("타겟에 미커밋 변경으로 반영 — 커밋은 직접"). `--cached` 미사용·`--unsafe-paths` 금지·패치 내부 경로 repo-relative 검증(리뷰 G10 — a/ b/ 접두 정규화 + `..` 거부).
- **적용의 직렬화**(리뷰 G9): 타겟 repo 단위 뮤텍스(J1 TaskWorktreeManager의 per-repo 큐 재사용) — 동시 apply interleave 차단.
- 채택 상태 무영속 원칙은 유지하되 **"잔여 표시" 주장은 철회**(CX3): 채택은 타겟을 바꾸고 태스크 worktree는 불변이므로 diff 재계산에 채택분이 계속 보인다 — "적용됨" best-effort 뱃지(reverse 프로브)가 유일한 표시이고, 정본은 타겟 워킹트리 그 자체다(한계 명시).

## 4. 결정 D4 — 코멘트 = 미션 채널 포스트 + `data` 앵커 (렌더러 전용 발신 명시)

- `ChannelMessage.data?: unknown`(src/shared/channels.ts:148 — R10)에 앵커 탑재 — 채널 스키마 변경 0.
- 앵커: `data: { kind: 'diff-comment', taskId, file, hunkHeader, side, line }`. text = 자연문 코멘트(data 미해석 소비자에게 그대로 유효).
- **발신은 렌더러 channelLocal 경로 전용**(리뷰 CL3 — 실측: MCP channel_post는 data 파라미터 미지원): MCP 에이전트는 코멘트 앵커를 읽기만 가능(channel_read는 data 통과). channel_post에 data 추가는 도구 표면 확장이라 별도 판단 몫 — J2는 계약 명시만.
- diff 뷰는 미션 채널에서 kind 매칭 역조회해 인라인 표시(read RPC 재사용). 라인 드리프트는 hunkHeader+line 스냅샷 — 불일치 시 "위치 이동됨" 뱃지 강등.
- 미션 채널 archived/소실 시 코멘트 버튼 비활성 + 사유(J0 외부 변이 내성 정합).

## 5. 결정 D5 — 검증 리그 배선 (전략 P8 — J2 출하 블로커)

- 시나리오(계약 재정의 — all-or-nothing 반영): **채택 원자성** — 적용 중 SIGKILL → 재기동 → 타겟이 "완전 적용 or 완전 미적용"인지 **독립 오라클**(청정 기준 대비 `git diff` 비교 — 리포트 의존 금지, CX7·G6 해소)로 판정.
- **실검출 실증**: 주입 결함은 재직렬화 급소 겨냥 — no-newline 마커 탈락 주입 → 리그 red(파일 말미 개행 오염 검출) → 원복 green. 증적(EVIDENCE) 없이 출하 금지.

## 6. 구현 표면·위임 범위

| 계층 | 신설/변경 | 내용 |
|---|---|---|
| shared | 신설 | `diffParse.ts`(원문 보존 파서·선택 재조립·카운트 재계산 — 순수 함수) + 캡 상수 + `'diff'` surfaceType |
| renderer | 신설(중) | **D1 풀 구현**: negative 술어 전수 감사 목록 + Pane 분기·addDiffSurface·SurfaceTabs·복원 배선 + DiffPanel(파일 트리·hunk 선택·채택·코멘트·"적용됨"/"채택불가" 뱃지) |
| main | 신설 | `diff:read`(워킹트리 대조·untracked 합성·타겟 스냅샷)·`diff:applyHunks`(프로브·드리프트 게이트·dirty 거부·단일 apply·repo 뮤텍스) |
| daemon | **무변경** | 코멘트는 기존 채널 RPC — 데몬 표면 0 |
| rig | 신설 | 채택 원자성 시나리오 + 실검출 증적(EVIDENCE) |
| tests | 신설 | 왕복 오라클(git apply 실적용 — no-newline·CRLF·untracked new-file·앞 hunk 생략·중복 컨텍스트 케이스 명시)·프로브(실패 hunk 표시·reverse 프로브)·드리프트 거부·dirty 거부·경로 검증·staged/unstaged/untracked 조합·복원 E2E(PTY 자가생성 0)·앵커 왕복·E2E(성공기준 §0) |

검증 게이트: 신규 테스트 그린 + `test:parallel` 무영향 + `tsc` 클린 + **리그 실검출 증적**.

## 7. 리스크·함정

| 리스크 | 대응 |
|---|---|
| 재직렬화 = 조용한 코드 오염(최악) | 원문 보존 설계(§3) + git 오라클 왕복 테스트 + 리그 실검출이 이 급소 겨냥(§5) + v1 범위 평문 한정 |
| all-or-nothing UX(한 hunk 때문에 전체 거부) | per-hunk 사전 프로브가 실패 hunk를 특정 → 사용자가 빼고 재시도 — 명시 워크플로 |
| 타겟 드리프트·동시 apply | 스냅샷 게이트(§2) + repo 뮤텍스(§3) |
| 큰 diff·바이너리·rename | 캡+표시 전용 라벨 — 조용한 절단·오적용 금지 |
| "적용됨" 뱃지 오판(reverse 프로브 한계) | best-effort 명시 — 확정 판정 아님, 정본은 타겟 워킹트리 |
| data 필드 남용 | kind 판별 union 관례 고정 |

## 8. J1 착지 대조 — 해소 완료 (2026-07-10)

1. **진입 배선**: `FanOutTaskResult`(src/main/worktask/FanOutService.ts:75)가 `{taskId, channelId, workspaceId, worktreePath, branch}` 반환 — 토스트→diff 진입 재료 완비.
2. **taskId 역참조**: `paneGroupId = workspaceId`(FanOutService.ts:299) — `task.mission.list` 후 paneGroupId 매칭(신규 RPC 불요).
3. **타겟 repo**: WorkTask 스키마 무변경 — `git rev-parse --git-common-dir` 도출(§2)로 리뷰 CX1까지 함께 해소.

## 9. 후속 순서

1. ~~3모델 패널 플랜 리뷰~~ **완료(2026-07-10)** — §10. 전건 반영 v1.1.
2. J1 PR 머지 후 LEDGER 갱신 → 구현 위임(Opus).
3. 구현 3모델 코드 리뷰 + 리그 실검출 증적 → PR.
4. J3 설계(Fable 직접): 수명주기 완성 — close UX(dirty·prompt.md 회수)·1클릭 PR·onExhausted 배선(J1 이연분)·함대 리부트 생존 데모(하드 게이트).

## 10. 리뷰 로그 — 3모델 패널 1라운드 (2026-07-10)

Codex 9건(CX) + Claude 실코드 9건(CL — Pane.tsx·workspaceSlice·mcp/channels.ts를 file:line 확정) + GLM 10건(G). 주요 합의·반영:

| # | 합의 | 요지 | 반영 |
|---|---|---|---|
| R1 | 3-MODEL | 재직렬화 메타데이터 유실(no-newline·CRLF·rename·new/delete) | 원문 보존 파서 + v1 평문 한정(§3) |
| R2 | 3-MODEL | 부분 성공 ↔ 단일 apply all-or-nothing 자가당착 | all-or-nothing 계약 고정 + per-hunk 사전 프로브(§3) |
| R3 | 2-MODEL+ | 오프셋 재계산·중복 컨텍스트 | old 좌표 불변 논거 + 프로브 + git 오라클 테스트(§3) |
| R4 | 2-MODEL | untracked 합성 diff의 apply 비호환 | 정식 new-file 헤더 명세 + 파일 단위 all-or-nothing(§2) |
| R5 | 2-MODEL | 타겟 드리프트(HEAD 이동) 게이트 부재 | 스냅샷 동봉 + 적용 직전 재검증 거부(§2·§3) |
| R6 | 2-MODEL | surfaceType "additive" 과소평가 — negative 술어 20+·복원 PTY 자가생성 | 4번째 서피스 풀 구현으로 격상 + 전수 감사 + 복원 E2E(§1) |
| R7 | Codex(10) | 커밋 대조는 미커밋 산출물 누락 | 워킹트리 대조로 정정(§2) |
| R8 | Codex(10) | "잔여 표시" 전제 붕괴(채택은 타겟 변이·태스크 worktree 불변) | 주장 철회 + reverse 프로브 best-effort 뱃지(§3) |
| R9 | Codex(9) | taskId→타겟 repo 경로 불가(스키마 부재) | git-common-dir 도출 — 스키마 무변경(§2) |
| R10 | Codex(9) | SIGKILL 리그가 미영속 리포트 의존(순환) | all-or-nothing化로 저널 불요 + 독립 오라클(§5) |
| R11 | GLM(8) | 왕복 테스트 순환논리(파서 자기합의) | git apply를 오라클로(§3·§6) |
| R12 | GLM(6) | "이미 적용됨"을 plain --check가 못 잡음 | --reverse --check 프로브 + best-effort 한계 명시(§3) |
| R13 | Claude(8) | MCP channel_post는 data 미지원 — 앵커 POST 불가 | 렌더러 전용 발신 계약 명시(§4) |
| R14 | Claude(8)+GLM(6) | mergeBase 문법 오용·산출 위치 불일치 | 1-arg 워킹트리 diff + 단일 출처 캐싱(§2) |
| R15 | GLM(5) | 동시 apply 직렬화 부재 | per-repo 뮤텍스 재사용(§3) |
| R16 | GLM(5) | 패치 내부 경로 검증 부재 | a/ b/ 정규화 + `..` 거부 + --unsafe-paths 금지(§3) |
