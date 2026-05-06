# Progress — Terminal Bugs Fix (4건 통합)

## Summary
- **Phase**: 0 → 3 (구현 시작)
- **Started**: 2026-05-06
- **Branch**: `team/2026-05-06/terminal-bugs-fix`
- **Size**: Medium (Fast Path: Phase 0 → 3 → 5)
- **Teammates**: 2 (병렬 worktree, opus)

## 4가지 버그 — 전문가 진단 (read-only 완료)

| # | 증상 | Root cause | 신뢰도 |
|---|------|------------|--------|
| 1 | 큰 출력 시 freeze + CPU/RAM 풀가동 | PTYBridge onData 백프레셔 0 + OscParser O(n²) concat + ActivityMonitor 타이머 폭주 | 9/10 |
| 2 | Ctrl+V paste 일부 누락 | useTerminal Ctrl+V 핸들러 청킹 부재 → pty.handler 100K silent drop | 9/10 |
| 3 | Copy 완전 안 됨 | fire-and-forget IPC + Win32 클립보드 lock contention + 무조건 토스트 → silent failure | 9/10 |
| 4 | 마지막 문단만 복사 | ResizeObserver fit() during drag → xterm onResize의 unconditional clearSelection | 7/10 |

## 인터페이스 계약 (병렬 안전)

1. `clipboardAPI.writeText(text: string): Promise<void>` — 실패 시 **throw** (validation/size/lock 모두)
2. `pty.write` 100K 초과 시 main에서 **console.warn** 후 silent drop (backstop 유지)
3. `Terminal` 옵션에 `windowsPty: { backend: 'conpty', buildNumber: 21376 }` 추가는 renderer 단독

## 작업 그룹 (파일 소유권)

### Teammate A — Main side
**파일**: `src/main/pty/PTYBridge.ts`, `src/main/pty/OscParser.ts`, `src/main/pty/ActivityMonitor.ts`, `src/main/ipc/handlers/pty.handler.ts`, `src/main/ipc/handlers/clipboard.handler.ts`

**태스크**:
- A1: PTYBridge onData에 micro-batch 누적기 (~8ms flush)
- A2: OscParser slice 기반으로 변경 (O(n²) → O(n))
- A3: ActivityMonitor.feed에 100ms 타임스탬프 가드
- A4: pty.handler 100K 가드에 console.warn 추가
- A5: clipboard.handler silent return → typed throw (`CLIPBOARD_TOO_LARGE`, `CLIPBOARD_INVALID_TYPE`)
- A6: 신규/보강 테스트 (PTYBridge batch, OscParser slice, ActivityMonitor guard, clipboard throw)

### Teammate B — Renderer side
**파일**: `src/renderer/hooks/useTerminal.ts`, `src/renderer/components/Terminal/Terminal.tsx`, `src/preload/preload.ts`

**태스크**:
- B1: Terminal 옵션에 `windowsPty` 추가 (xterm 6 reflow 활성화)
- B2: ResizeObserver 콜백 + font/theme effect에 `hasSelection()` 가드
- B3: Ctrl+V/Ctrl+Shift+V 핸들러에 4096 청킹 도입 (우클릭 path와 동일 패턴)
- B4: Ctrl+C/Ctrl+Shift+C/우클릭 copy + handleCopy를 await + try/catch로 변경
- B5: showCopyToast는 Promise resolve 후에만 실행, 실패 시 showCopyErrorToast
- B6: clipboardAPI 타입 시그니처를 `Promise<void>` (실패 throw)로 명시
- B7: 신규/보강 테스트 (paste 청킹, copy 에러 경로, hasSelection 가드)

## DAG (Medium이지만 명확화)

```
A (main): []           ← 인터페이스 계약 합의됨, 단독 진행 가능
B (renderer): []       ← 인터페이스 계약 합의됨, 단독 진행 가능
머지: [A, B]           ← Phase 3.5에서 통합
통합 테스트: [머지]    ← Phase 5
```

## 검증

- 단위 테스트: `npm run test`
- 타입 체크: `tsc --noEmit` (또는 `npm run lint` 포함)
- 수동: 큰 출력 reproducer, 200KB Ctrl+V, 멀티문단 드래그-복사

## Status

- [x] Phase 0: 크기 판단, 브랜치 생성, progress.md 작성
- [ ] Phase 3: Teammate A 병렬 (worktree)
- [ ] Phase 3: Teammate B 병렬 (worktree)
- [ ] Phase 3.5: 머지 + 통합 테스트
- [ ] Phase 5: 전체 테스트 + 마무리 옵션 결정
