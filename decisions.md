# Decisions Log

## Template

### [YYYY-MM-DD] Decision Title
**Background**: Why this decision is needed
**Options**:
1. Option A — pros / cons
2. Option B — pros / cons
3. Option C — pros / cons

**Chosen**: Option [X]
**Rationale**: Why this option was selected
**Impact**: What changes as a result

---

<!-- Add decisions below. Most recent first. -->

### [2026-04-17] D1. 안정성·영속성 스코프 확정
**Background**: wmux daemon의 안정성/영속성 개선 디벨롭 방향을 설정. A(방어)/B(방어+복원)/C(A+B+UX) 세 옵션 제시.
**Options**:
1. A만 — IPC 에러 핸들링 + write mutex. 체감 개선 작음.
2. A + B — A 전체 + 스키마 마이그레이션 + 손상 파일 격리 + .bak rotation. 명확한 가치("데이터 안 잃음 + 업그레이드 안전").
3. A + B + C — B 전체 + 복원 UI + RingBuffer 설정화 + 수동 스냅샷. 범위가 커서 지연 위험.

**Chosen**: Option 2 (A + B)
**Rationale**: 체감 가치와 완성 가능성의 균형. C는 후속 이터레이션으로 분리.
**Impact**: Large 경로 확정. 예상 파일 10~12개, teammate 5~6명, 2~3일.

---

### [2026-04-17] D2. Write mutex 구현 방식
**Background**: StateWriter/SessionManager concurrent write race 방지 필요.
**Chosen**: 자체 Promise 큐 (의존성 없음, 30~50줄)
**Rationale**: 외부 의존성 추가 최소화, 테스트 단순화, 프로젝트 일관성.
**Impact**: `src/daemon/util/AsyncQueue.ts` 신규. StateWriter/SessionManager에서 사용.

---

### [2026-04-17] D3. 스키마 마이그레이션 전략
**Background**: SessionData/DaemonState의 version up 처리 필요.
**Chosen**: Lazy (load 시 변환, 다음 save에서 새 포맷 기록)
**Rationale**: 롤백 쉬움, 변환 실패 시 영향 국지화, 시작 지연 없음.
**Impact**: `src/daemon/migrations/` 디렉토리 신설. 각 마이그레이션 파일은 순수 함수 `migrate(input: vN) => vN+1`. SessionManager/StateWriter의 load 경로에서 version 체크 후 체이닝.

---

### [2026-04-17] D4. 손상 파일 복구 전략
**Background**: validate 실패 시 현재는 null 반환 → 빈 세션으로 출발. 사용자 데이터 무음 손실.
**Chosen**: 격리 + 사일런트 fallback + 구조화 로그
- 손상 파일을 `corrupted.{timestamp}.bak`로 이름 변경 후 보존
- `.bak` fallback 시도 → 실패 시 fresh start
- daemon log에 `CORRUPT_FILE` 이벤트 구조화 기록
- UI 알림(토스트)은 Phase C 스코프로 분리
**Rationale**: 데이터 보존 + 디버깅 가능성 확보. UI 통합은 스코프 경계 밖.
**Impact**: SessionManager/StateWriter의 load 경로 수정. 격리 파일은 .bak rotation 대상에서 제외.

---

### [2026-04-17] D5. .bak rotation 전략
**Background**: 현재 .bak 파일이 무한정 누적됨. 장기 사용 시 디스크 낭비 + 디렉토리 성능 저하.
**Chosen**: Count-based, 최근 3개 유지 (`.bak.1`, `.bak.2`, `.bak.3`)
**Rationale**: 1개는 부족(연속 손상 대응 불가), 5개는 과함. 3개는 "직전 저장 2회 + 격리 전 1회" 커버.
**Impact**: StateWriter/SessionManager에 `rotateBackups()` 헬퍼 추가. save 성공 시 호출.

---

### [2026-04-17] D6. IPC 에러 핸들링 패턴
**Background**: `registerHandlers.ts`에 try/catch 전무. daemon 끊기면 renderer 무반응.
**Chosen**: Per-handler wrapper helper (`wrapHandler(fn)`)
- 모든 ipcMain.handle을 wrapper로 감싸 표준 에러 응답 `{ok: false, error: {code, message}}` 반환
- daemon 연결 실패는 명시적 에러 코드(`DAEMON_DISCONNECTED`)로 분류
- renderer에서 공통 에러 훅으로 토스트 표시 (최소 구현)
**Rationale**: Electron ipcMain에 전역 middleware 네이티브 지원 없음. wrapper가 가장 간결.
**Impact**: `src/main/ipc/wrapHandler.ts` 신규. 기존 모든 ipcMain.handle 호출을 wrapper로 마이그레이션.

---

### [2026-04-17] D7. Architect Review 반영 수정 (Amendments)
**Background**: architect-reviewer가 Conditional Pass 판정. 3개 Critical + 몇 개 Important 조건 수용.

**A. D2 수정 (AsyncQueue 적용 범위)**
- `saveImmediate`는 **동기 시그니처 유지**. daemon의 14개 호출부(shutdown/suspend emergency sync 경로 포함)가 동기 전제이므로 파괴적 변경 금지.
- AsyncQueue는 `saveDebounced`와 비종료 경로에만 적용.
- `flushSync()` 메서드 신설: 큐 drain + synchronous write. 프로세스 종료 핸들러에서 호출.
- coalescing 옵션: 세션 상태는 스냅샷이므로 큐에 쌓인 write는 마지막 것만 유효.

**B. D3 수정 (Premigrate 스냅샷)**
- Lazy 체이닝 중간 실패 시 원본 오염 방지를 위해 load 직후 `sessions.v{N}.premigrate.bak` 일회성 스냅샷.
- 이미 존재하면 skip.
- 마이그레이션은 메모리에서만 수행, 모든 step 성공 후에만 새 버전 저장.

**C. D6 수정 (IPC wrapper 2단계 분리)**
- 1단계: 공통 try/catch + 구조화 로깅만 전 핸들러에 즉시 적용. 성공 시 raw value, 실패 시 throw는 유지.
- 2단계: `{ok, data, error}` 정규화는 renderer 측 `useIpc` 어댑터 훅에서 흡수. 기존 60+ 호출부는 점진 마이그레이션.
- DAEMON_DISCONNECTED 감지: 핸들러가 던진 에러의 `code` 속성을 wrapper가 분류만 담당.

**D. D5 수정 (Rotation 세부)**
- rename 직후에 rename 체인(`.bak.2→.bak.3`, `.bak.1→.bak.2`, `.bak→.bak.1`). copy 금지.
- 읽기 경로: primary → .bak → .bak.1 → .bak.2 → .bak.3. 하나라도 valid면 즉시 승격 save.

**E. D4 수정 (격리 경로)**
- 격리 파일은 `corrupted/` 서브디렉토리로 분리.
- 로테이터는 파일명 allowlist regex (`^sessions\.json\.bak(\.[123])?$`)로 corrupted 제외.
- 누적 방지: 시간 30일 경과 + 개수 10개 초과 이중 정책.

**F. D8 신규. 공통 atomic-write 모듈 선행 추출**
- `src/daemon/util/atomicWrite.ts` (또는 `src/shared/persist/`) 신규.
- SessionManager(main 측)과 StateWriter(daemon 측)의 중복 atomic-write 코드를 공통화.
- D3/D4/D5 로직을 한 번만 구현하도록 보장. **구현 순서 단계 1로 확정.**

---

### [2026-04-17] D9. 구현 순서 확정
단계 1. 공통 atomicWrite 모듈 추출 + 회귀 테스트 (D8)
단계 2. AsyncQueue + flushSync (D2 수정본)
단계 3. IPC wrapper 1단계 (try/catch + 로깅) (D6 수정본)
단계 4. .bak rotation (D5 수정본)
단계 5. 손상 파일 격리 + corrupted/ 서브디렉토리 (D4 수정본)
단계 6. Lazy 마이그레이션 + premigrate 스냅샷 (D3 수정본)

renderer 어댑터 훅(D6 2단계)은 단계 3 이후 별도 병렬 가능.
각 단계는 기본 순차. 독립 가능 구간은 Phase 2 DAG에서 식별.

---

### [2026-04-17] D10. Plan Review 반영 (파일 충돌 방지 + 스코프 보강)
**Background**: code-reviewer가 Conditional Pass 판정. 4개 핵심 수정 필요.

**A. T1 분해 → T1a + T1b**
- T1a: atomicWrite 스캐폴딩 + 인터페이스 freeze (호출부 미수정). Wave 1의 유일한 blocker.
- T1b: StateWriter/SessionManager 마이그레이션 (T1a 완료 후).

**B. atomicWrite 파일 물리 분리**
- `src/daemon/util/atomicWrite/core.ts` — 기본 tmp→bak→rename (T1a)
- `src/daemon/util/atomicWrite/rotation.ts` — .bak 체인 (T5)
- `src/daemon/util/atomicWrite/migrate.ts` — version load 훅 (T7)
- `src/daemon/util/atomicWrite/index.ts` — 조합 재export
- 이로써 Wave 2 worktree 충돌 제거.

**C. T3 분해 → T3a + T3b**
- T3a: wrapper 모듈 + 대표 핸들러 3개 + 통합 테스트. (Wave 1)
- T3b: 전면 롤아웃. (Wave 3로 이동)

**D. 통합/호환성/릴리스 태스크 신규**
- T12: daemon crash-restore 통합 테스트 (Wave 4)
- T13: migration × rotation × corruption 시나리오 E2E (Wave 4)
- T14: 기존 배포 데이터 호환성 스냅샷 테스트 (Wave 4)
- T15: CHANGELOG + 업그레이드/롤백 가이드 (Wave 4, 의존 없음)

**E. T8 프로덕션 영향 축소**
- 샘플 마이그레이션은 `__tests__/fixtures`에만 둠.
- 프로덕션 레지스트리는 identity 유지. `CURRENT_VERSION=1`.
- T11에서만 v1→v2 체이닝 검증.

**F. DAG 수정 (Wave 2 병렬화 개선)**
- T5, T7 → T1a 의존 (T1b 아님). T1a 완료 즉시 시작 가능.
- T2 → T1b 의존.
- T6 → T5, T1a 의존.

**G. Minor 보강**
- premigrate.bak 수명: rotation 대상 제외 + 수동 정리(로그 경고). 자동 정리는 스코프 외.
- 로그 포맷: JSON lines, `{ts, level, event, ...payload}`.
- T2 coalescing 의미론: "같은 key enqueue 시 마지막 값만 실행", FIFO는 key 간 순서 보장 → T9에 명세 테스트.
- T6 시간 기반 정리: `Date.now()` 대신 `clock: () => number` 주입 → fake clock 테스트.
