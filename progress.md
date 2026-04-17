# Progress — 안정성·영속성 개선 (Phase A + B)

## Summary
- Phase: 2 (계획 확정) → 3 진입 준비
- Done: 0/14 | In Progress: 0 | Waiting: 14 | Blocked: 0
- Branch: team/2026-04-17/stability-persistence

## DAG (D10 개정)
```
T1a (atomicWrite 스캐폴딩 + 인터페이스 freeze): []
T1b (StateWriter/SessionManager 마이그레이션): [T1a]
T2  (AsyncQueue + flushSync): [T1b]
T3a (IPC wrapper 모듈 + 샘플 3개 핸들러): []
T3b (IPC wrapper 전면 롤아웃): [T3a]
T4  (renderer useIpc 어댑터): [T3a]
T5  (.bak rotation — rename 체인): [T1a]
T6  (손상 파일 격리 + corrupted/ 서브디렉토리): [T1a, T5]
T7  (Lazy 마이그레이션 프레임워크): [T1a]
T9  (AsyncQueue + flushSync 테스트): [T2]
T10 (rotation + 격리 통합 테스트): [T5, T6]
T11 (마이그레이션 golden fixture 테스트 + 체이닝): [T7]
T12 (daemon crash-restore 통합 테스트): [T2, T5, T7, T1b]
T13 (migration × rotation × corruption 시나리오 E2E): [T6, T7]
T14 (기존 배포 데이터 호환성 스냅샷 테스트): [T6]
T15 (CHANGELOG + 업그레이드/롤백 가이드): []
```

(T8 삭제 — 프로덕션 레지스트리 identity 유지 결정, 샘플은 T11 fixture로 흡수)

## Parallelization Plan
```
Wave 1 (병렬 3, worktree):
  - T1a (atomicWrite 스캐폴딩)    ← 최우선 blocker
  - T3a (IPC wrapper + 샘플)      ← 독립
  - T15 (CHANGELOG/가이드)        ← 독립 문서 작업

Wave 2 (T1a 완료 후 병렬 3, worktree):
  - T5  (.bak rotation)           ← atomicWrite/rotation.ts
  - T7  (Lazy 마이그레이션)        ← atomicWrite/migrate.ts
  - T1b (호출부 마이그레이션)      ← atomicWrite/core.ts만 사용

Wave 3 (T1b/T3a/T5 완료 후 병렬 3, worktree):
  - T2  (AsyncQueue + flushSync)  ← T1b 필요
  - T3b (IPC wrapper 전면 롤아웃)  ← T3a 필요
  - T4  (useIpc 어댑터)            ← T3a 필요
  - T6  (손상 파일 격리)           ← T1a, T5 필요

Wave 4 (테스트 + 통합, 병렬 4):
  - T9  (AsyncQueue 테스트)       ← T2
  - T10 (rotation/격리 테스트)     ← T5, T6
  - T11 (마이그레이션 golden)      ← T7
  - T12 (crash-restore 통합)       ← T2, T5, T7, T1b
  - T13 (migration × rotation × corruption E2E) ← T6, T7
  - T14 (기존 데이터 호환성)       ← T6
```

## Tasks

### T1a. atomicWrite 스캐폴딩 + 인터페이스 freeze
- **파일 (신규)**: `src/daemon/util/atomicWrite/core.ts`, `src/daemon/util/atomicWrite/index.ts`
- **요구사항**:
  - 인터페이스 확정: `atomicWriteJSON(path, data, opts)`, `atomicReadJSON<T>(path, opts)`
  - opts 타입: `{rotationEnabled?, validate?, migrator?, clock?}`
  - 기본 동작: tmp→bak→rename (기존 동작 보존). rotation/migrate 훅은 no-op 자리만.
  - __proto__/constructor/prototype sanitizer 포함
  - **호출부는 수정하지 않음** (T1b에서 마이그레이션)
- **검증**: 신규 모듈 유닛 테스트 + 타입 체크 통과
- **Status**: Waiting
- **Subagent**: backend-developer
- **Worktree**: yes (Wave 1)

### T1b. StateWriter/SessionManager 마이그레이션
- **파일 (수정)**: `src/daemon/StateWriter.ts`, `src/main/session/SessionManager.ts`
- **요구사항**:
  - 두 모듈의 중복 atomic-write 로직을 T1a 모듈 호출로 치환
  - 외부 API는 유지 (호출부 변경 최소화)
  - 기존 StateWriter/SessionManager 테스트가 회귀 없이 통과
- **검증**: 전체 테스트 suite 통과
- **Status**: Waiting (T1a)
- **Subagent**: backend-developer
- **Worktree**: yes (Wave 2)

### T2. AsyncQueue + flushSync
- **파일 (신규)**: `src/daemon/util/AsyncQueue.ts`
- **파일 (수정)**: `src/daemon/StateWriter.ts`, `src/main/session/SessionManager.ts`
- **요구사항**:
  - 30~50줄 자체 Promise 큐. `enqueue(key, fn)`, `flush()`, `flushSync()`
  - Coalescing: 같은 key 재진입 시 마지막 값만 실행. key 간은 FIFO 보장.
  - `saveDebounced` 경로만 큐잉. `saveImmediate`는 동기 시그니처 유지.
  - `flushSync()`: 큐 drain + `writeFileSync` 폴백. 종료 핸들러에서 호출.
- **검증**: T9 테스트 통과
- **Status**: Waiting (T1b)
- **Subagent**: backend-developer
- **Worktree**: yes (Wave 3)

### T3a. IPC wrapper 모듈 + 샘플 3개 핸들러
- **파일 (신규)**: `src/main/ipc/wrapHandler.ts`
- **파일 (수정)**: `src/main/ipc/handlers/` 중 대표 3개 (pty, workspace, session)
- **요구사항**:
  - `wrapHandler(name, fn)`: try/catch + 구조화 JSON 로그(`{ts, level, event, channel, error_code, stack}`)
  - 성공 시 raw value 반환 유지 (정규화 없음)
  - 에러 `code` 속성 분류 (`DAEMON_DISCONNECTED`, `VALIDATION_ERROR`, `UNKNOWN`)
  - 3개 샘플 핸들러에 적용 + 통합 테스트
- **검증**: throw 시 로그 스키마 일치 + raw 반환 동작 확인
- **Status**: Waiting
- **Subagent**: backend-developer
- **Worktree**: yes (Wave 1)

### T3b. IPC wrapper 전면 롤아웃
- **파일 (수정)**: 나머지 모든 `src/main/ipc/handlers/*.ts`, `src/main/ipc/registerHandlers.ts`
- **요구사항**: 모든 ipcMain.handle을 wrapHandler 경유로 전환
- **검증**: 기존 IPC 통합 테스트 전체 통과
- **Status**: Waiting (T3a)
- **Subagent**: backend-developer
- **Worktree**: yes (Wave 3)

### T4. renderer useIpc 어댑터 훅
- **파일 (신규)**: `src/renderer/hooks/useIpc.ts`
- **파일 (수정)**: daemon 의존 호출부 중 상위 5개만 (나머지는 후속 이터)
- **요구사항**:
  - `{ok, data, error}` 정규화 + 토스트 + `DAEMON_DISCONNECTED` 전용 메시지
  - 기존 ipcRenderer.invoke와 호환 (옵트인)
- **검증**: renderer 빌드 + 신규 훅 에러 시나리오 확인
- **Status**: Waiting (T3a)
- **Subagent**: frontend-developer
- **Worktree**: yes (Wave 3)

### T5. .bak rotation (rename 체인)
- **파일 (신규)**: `src/daemon/util/atomicWrite/rotation.ts`
- **파일 (수정)**: `src/daemon/util/atomicWrite/index.ts` (조합)
- **요구사항**:
  - rename 성공 직후 체인: `.bak.2→.bak.3`, `.bak.1→.bak.2`, `.bak→.bak.1`. copy 금지.
  - 읽기 fallback: primary→.bak→.bak.1→.bak.2→.bak.3. valid 발견 시 즉시 승격 save.
  - Rotation allowlist regex로 `corrupted/`, `.premigrate.bak` 제외.
- **검증**: T10 통과
- **Status**: Waiting (T1a)
- **Subagent**: backend-developer
- **Worktree**: yes (Wave 2)

### T6. 손상 파일 격리 + corrupted/ 서브디렉토리
- **파일 (수정)**: `src/daemon/util/atomicWrite/core.ts`, `src/daemon/util/atomicWrite/rotation.ts`
- **요구사항**:
  - validate 실패 시 `{dir}/corrupted/{basename}.{timestamp}.bak`로 rename
  - `CORRUPT_FILE` 이벤트 JSON 로그 (`code, path, reason, sha256_prefix`)
  - 누적 제한: 30일 초과 또는 10개 초과 시 오래된 것 삭제. `clock` 주입 가능 설계.
  - Rotation에서 `corrupted/` 제외.
- **검증**: T10, T13, T14 통과
- **Status**: Waiting (T1a, T5)
- **Subagent**: backend-developer
- **Worktree**: yes (Wave 3)

### T7. Lazy 마이그레이션 프레임워크
- **파일 (신규)**: `src/daemon/migrations/index.ts`, `src/daemon/migrations/types.ts`
- **파일 (신규)**: `src/daemon/util/atomicWrite/migrate.ts`
- **요구사항**:
  - 각 마이그레이션: 순수 함수 `migrate(input: vN): vN+1`
  - load 직후 `{basename}.v{N}.premigrate.bak` 일회성 스냅샷 (존재 시 skip)
  - 체이닝: 모든 step 성공 → 메모리 객체만 새 버전. save 시점에 새 포맷 기록.
  - step 실패 시 원본 반환 + CORRUPT_FILE 경로로 위임
  - 프로덕션 레지스트리는 identity 유지 (`CURRENT_VERSION=1`)
- **검증**: T11, T13 통과
- **Status**: Waiting (T1a)
- **Subagent**: backend-developer
- **Worktree**: yes (Wave 2)

### T9. AsyncQueue + flushSync 테스트
- **파일 (신규)**: `src/daemon/util/__tests__/AsyncQueue.test.ts`
- **요구사항**:
  - FIFO (key 간), coalescing (같은 key), flush/flushSync 동작
  - fake timer로 debounced 상호작용
  - 병렬 enqueue 경합 없음
  - coalescing 명세: "같은 key 2회 enqueue → 마지막 값만 실행" assert
- **검증**: vitest 통과
- **Status**: Waiting (T2)
- **Subagent**: test-automator
- **Worktree**: yes (Wave 4)

### T10. rotation + 격리 통합 테스트
- **파일 (신규)**: `src/daemon/util/__tests__/atomicWrite.rotation.test.ts`, `atomicWrite.corruption.test.ts`
- **요구사항**:
  - rotation: 4회 save 후 .bak/.bak.1/.bak.2/.bak.3 검증
  - 읽기 fallback: primary 손상 → .bak.1 복구 + 승격
  - 격리: validate 실패 → corrupted/로 이동 + rotation 제외 + 시간 기반 정리 (fake clock)
- **검증**: vitest 통과
- **Status**: Waiting (T5, T6)
- **Subagent**: test-automator
- **Worktree**: yes (Wave 4)

### T11. 마이그레이션 golden fixture 테스트 + 체이닝
- **파일 (신규)**: `src/daemon/migrations/__tests__/migrate.test.ts`
- **파일 (신규)**: `src/daemon/migrations/__tests__/fixtures/session.v1.json`, `session.v2.json`, `session.v3.json`
- **요구사항**:
  - golden fixture 기반 순수 함수 회귀
  - 체이닝 엔진이 버전 skip 안 하는지 (v1→v2→v3)
  - step 실패 시 원본 반환 + premigrate.bak 존재 assert
- **검증**: vitest 통과
- **Status**: Waiting (T7)
- **Subagent**: test-automator
- **Worktree**: yes (Wave 4)

### T12. daemon crash-restore 통합 테스트
- **파일 (신규)**: `src/daemon/__tests__/crashRestore.integration.test.ts`
- **요구사항**:
  - 시나리오 1: 세션 저장 중 SIGKILL 시뮬레이션 → 재기동 → .bak에서 복원
  - 시나리오 2: flushSync 호출 보장 (uncaughtException 경로)
  - 시나리오 3: emergency sync save가 실제로 파일에 기록됨
- **검증**: vitest 통과
- **Status**: Waiting (T2, T5, T7, T1b)
- **Subagent**: test-automator
- **Worktree**: yes (Wave 4)

### T13. migration × rotation × corruption E2E
- **파일 (신규)**: `src/daemon/__tests__/persistenceE2E.test.ts`
- **요구사항**:
  - v1 파일 → load 시 premigrate.bak 생성 → save 시 v2 기록 → rotation
  - 마이그레이션 중 validate 실패 → corrupted/ 격리 → .bak에서 fallback load
  - 상호작용 엣지 케이스 커버
- **검증**: vitest 통과
- **Status**: Waiting (T6, T7)
- **Subagent**: test-automator
- **Worktree**: yes (Wave 4)

### T14. 기존 배포 데이터 호환성 스냅샷 테스트
- **파일 (신규)**: `src/daemon/__tests__/legacyCompat.test.ts`
- **파일 (신규)**: `src/daemon/__tests__/fixtures/legacy/` (기존 포맷 샘플)
- **요구사항**:
  - 현재 프로덕션 포맷 파일을 fixture로 복사
  - 신규 코드로 1회 load → 손실 0 + 예상 로그만
  - Rotation allowlist가 기존 누적 .bak을 오삭제하지 않는지
- **검증**: vitest 통과
- **Status**: Waiting (T6)
- **Subagent**: test-automator
- **Worktree**: yes (Wave 4)

### T15. CHANGELOG + 업그레이드/롤백 가이드
- **파일 (신규)**: `CHANGELOG.md` 섹션 추가 또는 `docs/upgrade-2026-04-17.md`
- **요구사항**:
  - 변경 사항 요약 (사용자 관점)
  - premigrate.bak/corrupted/ 디렉토리 설명
  - 롤백 플레이북 (premigrate에서 구버전 복구하는 절차)
  - IPC 에러 포맷 변경 공지 (renderer 플러그인 개발자용)
- **검증**: 문서 빌드 성공 + Leader 리뷰
- **Status**: Waiting
- **Subagent**: technical-writer
- **Worktree**: yes (Wave 1)
