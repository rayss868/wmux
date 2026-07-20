// ─── WorkspaceCenter — 중앙 영역(페인 그리드 + 유틸 표면) ───────────────────────
//
// IA 결정(2026-07-20): Git·Review는 좌측 사이드바 푸터 버튼(Sidebar)이
// 여는 중앙 전체 표면으로 산다. workspaceUtilityView가 set이면 페인 그리드를 덮는
// GitTab/ReviewTab을 렌더한다. 페인 그리드는 언마운트하지 않고 display:none으로만
// 숨긴다 — xterm/PTY를 살려두기 위한 필수 조건. activePaneId·surface.cwd는 숨겨진
// 상태에서도 state에 살아 있으므로 GitTab은 cwd prop 없이 selectActivePaneCwd
// 폴백으로 활성 페인 cwd를 라이브로 따라간다("생성 시 cwd 고정" 문제 해소).

import { useEffect } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { WorkspaceViewport } from './WorkspaceViewport';
import { GitTab } from '../Deck/GitTab';
import { ReviewTab } from '../Deck/ReviewTab';
import { ErrorBoundary } from '../ErrorBoundary';

/** Git·Review 중앙 표면 — 페인 그리드를 덮는 절대 위치 레이어. 우상단 ✕ + Esc로 닫는다. */
function WorkspaceUtilitySurface({ view }: { view: 'git' | 'review' }) {
  const t = useT();
  const setView = useStore((s) => s.setWorkspaceUtilityView);

  // Esc로 닫기 — 표면이 열려 있는 동안만 리스너를 건다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setView(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setView]);

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col bg-[var(--bg-base)]"
      data-ws-utility-surface={view}
    >
      <div className="flex-1 overflow-auto relative">
        {/* 우상단 ✕ — 표면 닫기(다시 헤더 탭을 누르거나 Esc로도 닫힌다). */}
        <button
          type="button"
          onClick={() => setView(null)}
          title={t('surface.closeTab')}
          aria-label={t('surface.closeTab')}
          data-ws-utility-close
          className="absolute top-2 right-3 z-20 text-[var(--text-subtle)] hover:text-[var(--accent-red)] transition-colors leading-none"
        >
          ✕
        </button>
        <div className="max-w-[720px] mx-auto h-full flex flex-col">
          {view === 'git' ? <GitTab /> : <ReviewTab />}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceCenter() {
  const view = useStore((s) => s.workspaceUtilityView);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const setView = useStore((s) => s.setWorkspaceUtilityView);

  // 워크스페이스 전환 시 유틸 표면 자동 닫기 — 전역 단일 값이라 열어둔 채 전환하면
  // 새 워크스페이스에서도 그리드를 가려 "터미널이 안 열린다"로 보인다.
  useEffect(() => {
    setView(null);
  }, [activeWorkspaceId, setView]);

  return (
    <>
      <div className="flex-1 min-h-0 relative">
        {/* 페인 그리드 — 유틸 표면이 열려 있으면 display:none으로 숨긴다(언마운트
            금지 — 터미널 PTY 유지). 숨겨져도 activePaneId·surface.cwd는 살아 있다. */}
        <div
          className="absolute inset-0 flex flex-col"
          style={view ? { display: 'none' } : undefined}
          data-pane-grid-wrapper
        >
          <WorkspaceViewport />
        </div>
        {view && (
          <ErrorBoundary name="WorkspaceUtilitySurface">
            <WorkspaceUtilitySurface view={view} />
          </ErrorBoundary>
        )}
      </div>
    </>
  );
}

export default WorkspaceCenter;
