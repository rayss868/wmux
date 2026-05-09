# Progress — Cross-Pane Search

## Summary
- **Phase**: 2 (계획 — code-reviewer 재검증 대기)
- **Started**: 2026-05-09
- **Branch**: `team/2026-05-09/cross-pane-search`
- **Base**: `main` (PR #19 클립보드 fix 머지 후 최신)
- **Size**: Large (Full Path)
- **Effort**: 1.5-2일 (code-reviewer 산정)
- **Teammates**: 7 tasks (병렬 가능 4개 동시 max, opus, worktree)
- **Done**: 3/7 (T-A `eb0b6fe`, T-B `4c45aca`, integrated `03f47d7`, T-C this commit) | In Progress: 0 | Waiting: 4 | Blocked: 0

## Keyboard

- **Cross-pane 트리거**: 기존 Ctrl+F bar에 'All Panes' 토글 (single keybind, 단순화)
- **Ctrl+Shift+F**: v2 cross-workspace 검색용 예약 (v1 미사용)

## DAG

```
T-A (types + RPC method + minimal main handler): []
T-B (search engine util — pure function): []
T-C (renderer handler in useRpcBridge + searchSlice skeleton): [T-A, T-B]
T-D (MCP tool registration): [T-A]
T-E (search bar UI extension): [T-C]
T-F (panel UI + hysteresis state machine): [T-C]   # T-E와 병렬 (다른 파일)
T-G (tests for T-B/T-C/T-D/T-F): [T-B, T-C, T-D, T-F]
```

병렬 라운드:
- Round 1 (worktree 2): T-A, T-B
- Round 2 (worktree 2): T-C, T-D
- Round 3 (worktree 2): T-E, T-F
- Round 4 (worktree 1): T-G

## Tasks

### T-A. Types + RPC method + main handler skeleton
- **Owner**: backend-developer
- **Deps**: []
- **Files**:
  - `src/shared/rpc.ts` — `'pane.search'` union + array entry
  - `src/shared/types.ts` — `PaneSearchResult`, `PaneSearchResponse` types (D5 스펙)
  - `src/main/pipe/handlers/pane.rpc.ts` — `pane.search` handler that forwards to renderer via `sendToRenderer(getWindow, 'pane.search', params)`
- **Public types** (T-C가 import):
  ```ts
  export interface PaneSearchResult {
    paneId: string; surfaceId: string; ptyId: string;
    lineIdx: number;            // logical line idx (post wrap-coalesce)
    text: string;               // matched logical line, 500 chars cap
    contextBefore: string[];    // 2 lines, each 500 chars cap
    contextAfter: string[];
    paneLabel?: string;         // PR #16 metadata if present
  }
  export interface PaneSearchResponse {
    resultShapeVersion: 1;
    results: PaneSearchResult[];
    truncated: boolean;
    totalMatches: number;
    workspaceId: string;
  }
  ```
- **Acceptance**:
  - `RpcMethod` union + `ALL_RPC_METHODS` array에 `'pane.search'` 등장
  - 위 타입 export
  - main handler가 `query: string` validation (빈 문자열 거부) + optional `regex: boolean` 받아 forward
  - tsc clean
- **검증**: `npx tsc --noEmit` + 기존 pane.rpc test 회귀 X

### T-B. Search engine util (pure function)
- **Owner**: backend-developer
- **Deps**: []
- **Files**:
  - `src/renderer/utils/searchEngine.ts` (신규) — `searchInBuffer(buffer, query, opts): MatchInBuffer[]`
- **Internal types** (T-B 소유, T-C가 매핑):
  ```ts
  export interface SearchOpts {
    regex?: boolean;
    contextLines?: number;       // default 2
    perBufferLineCap?: number;   // default 20_000
    remainingBudget: number;     // T-C가 매 pane마다 decrement
  }
  export interface MatchInBuffer {
    lineIdx: number;            // logical line, post-coalesce
    physicalBaseY: number;      // 원래 buffer baseY+offset (scrollToLine용)
    text: string;               // 500 chars cap
    contextBefore: string[];    // 500 chars cap each
    contextAfter: string[];
  }
  ```
- **Acceptance**:
  - `BufferLine.isWrapped` 기반 wrap-coalescing → logical line 단위 (N1)
  - 각 logical line 텍스트 500 chars cap (N1)
  - regex 모드 — 잘못된 패턴 throw `SyntaxError` (UI에서 catch)
  - per-buffer cap (default 20k lines) 적용 (D3 F11)
  - context lines (default 2) — logical line 단위, 500 chars cap each (N1)
  - `remainingBudget` 도달 시 early return (G2: T-C가 pane 간 분배)
  - pure 함수 (DOM/electron 의존 X)
- **검증**: T-G에서 unit tests

### T-C. Renderer handler + searchSlice skeleton
- **Owner**: frontend-developer
- **Deps**: [T-A, T-B]
- **Files**:
  - `src/renderer/hooks/useRpcBridge.ts` — `'pane.search'` method case
  - `src/renderer/stores/slices/searchSlice.ts` (신규 skeleton — T-F가 hysteresis 채움)
- **searchSlice skeleton** (T-C 책임):
  ```ts
  interface SearchSlice {
    query: string;
    results: PaneSearchResult[];
    truncated: boolean;
    totalMatches: number;
    panelOpen: boolean;          // T-F가 hysteresis 로직 추가
    panelStickyClosed: boolean;  // T-F가 sticky 로직 추가
    runSearch: (query: string, regex: boolean) => Promise<void>;
    clearSearch: () => void;
  }
  ```
- **Acceptance**:
  - `terminalRegistry` 사용 (D7)
  - mutation safety: keys snapshot + per-pane try/catch (N2)
  - ptyId→workspaceId 역매핑 (`store.workspaces` walk, F12)
  - paneLabel: `paneLeaf.metadata?.label ?? undefined` — undefined OK, no throw (N4, G3)
  - `searchInBuffer` 호출 — 매 pane마다 `remainingBudget` 전달, 결과 받아 누적, 200 도달 시 break (G2 breadth-first)
  - 응답: T-A의 `PaneSearchResponse` 그대로
- **검증**: T-G에 RPC dispatch 테스트 (mock terminalRegistry)

### T-D. MCP tool — wmux_search_panes
- **Owner**: mcp-developer
- **Deps**: [T-A]
- **Files**:
  - `src/mcp/index.ts` — `server.tool('wmux_search_panes', ..., async ({query, regex}) => {...})`
- **Acceptance**:
  - tool description 명시 (use case: AI 자율 추론)
  - workspaceId은 `requireWorkspaceId()` 자동 (cross-ws 차단)
  - params: `query` required, `regex` optional. **scope 없음** (D9)
  - 응답을 callRpc 통해 그대로 반환
- **검증**: tsc + T-G에서 mock RPC test

### T-E. Search bar UI — All Panes 토글 + dropdown
- **Owner**: frontend-developer
- **Deps**: [T-C]
- **Files**:
  - `src/renderer/components/Terminal/SearchBar.tsx` — All Panes 토글, regex 토글, 결과 dropdown
  - `src/renderer/i18n/locales/{en,ko,ja,zh}.ts` — 새 i18n 키 (M1):
    - `search.allPanes`, `search.regexMode`, `search.noResults`, `search.showInPanel`, `search.matchedLine` 등
- **Acceptance**:
  - 기존 단일 pane 검색 회귀 X
  - All Panes 토글 ON 시 `searchSlice.runSearch(query, regex)` 호출
  - 잘못된 regex → red border + tooltip (D6, F8)
  - 결과 ≤10 → inline dropdown
  - 결과 클릭 → 해당 pane focus + scrollToLine(physicalBaseY)
  - i18n 키 4 locale 모두 채움
- **검증**: 기존 SearchBar 테스트 회귀 + 신규 토글 테스트 (T-G)

### T-F. Panel UI + hysteresis state machine
- **Owner**: frontend-developer
- **Deps**: [T-C]   # 다른 파일이라 T-E와 병렬
- **Files**:
  - `src/renderer/components/Search/SearchResultsPanel.tsx` (신규)
  - `src/renderer/stores/slices/searchSlice.ts` (확장 — T-C가 만든 skeleton에 hysteresis 추가)
- **searchSlice 추가 로직**:
  - `panelOpen` derive: `results.length > 10 && !panelStickyClosed`
  - 사용자가 panel 닫으면 `panelStickyClosed = true`
  - **session reset** (sticky 해제): `query === ''` OR `Math.abs(newQuery.length - prevQuery.length) > 2` OR `!newQuery.startsWith(prevQuery) && !prevQuery.startsWith(newQuery)` (G4)
- **Acceptance**:
  - panel 클릭 → 해당 pane focus + scrollToLine
  - paneLabel 표시 (있을 때) — "Backend (running): line 42 → JWT error"
  - session reset 메트릭 위 그대로
  - i18n 키 사용 (T-E와 공유)
- **검증**: T-G에 hysteresis state machine 테스트

### T-G. Tests
- **Owner**: test-automator
- **Deps**: [T-B, T-C, T-D, T-F]
- **Files**:
  - `src/renderer/utils/__tests__/searchEngine.test.ts` (신규)
  - `src/renderer/utils/__tests__/fixtures/wrappedBuffer.ts` (신규 — wrap-coalescing fixture, M3)
  - `src/main/pipe/handlers/__tests__/pane.rpc.test.ts` 확장 — `pane.search` dispatch
  - `src/renderer/stores/slices/__tests__/searchSlice.test.ts` (신규) — hysteresis state machine
  - `src/renderer/hooks/__tests__/useRpcBridge.search.test.ts` (옵션) — registry walk + budget decrement
- **Acceptance**:
  - searchEngine: wrap-coalescing (3 wrapped rows → 1 logical), regex match/error, 200 cap, 20k buffer cap, empty buffer, context lines, budget exhaustion
  - pane.rpc: query validation, regex param forwarding, error handling
  - searchSlice: open >10 트리거, close <=5 트리거, sticky bit, session reset (3가지 reset 트리거 모두)
- **검증**: vitest 그린, 회귀 0건

## By Module

### Backend (RPC layer + engine)
- [x] T-A types + main handler (commit eb0b6fe)
- [x] T-B search engine util (commit 4c45aca)
- [ ] T-D MCP tool

### Frontend (UI + handler + state)
- [x] T-C renderer handler + searchSlice skeleton (this commit)
- [ ] T-E search bar + i18n
- [ ] T-F panel + hysteresis

### Tests
- [ ] T-G unit + integration + fixture
