// ─── WorkspaceUtilityBar — 중앙 상단 워크스페이스 헤더 탭 (Git·Review) ──────────
//
// IA 결정(2026-07-20): Git·Review는 워크스페이스 단위 데이터라 페인 surface 탭이
// 아니라 이 워크스페이스 헤더 행의 탭 + 중앙 전체 표면으로 산다. 왼쪽은 활성
// 워크스페이스 이름, 오른쪽은 Git·Review 탭 2개. 활성 탭은 하단 2px accent-blue
// 밑줄(DeckTabs 문법과 동일). 같은 탭 재클릭은 토글 닫기(null).
//
// 자체 구독을 소유(activeWs 요약 + workspaceUtilityView)해 워크스페이스 전환·토글
// 시 AppLayout 크롬 전체를 리렌더하지 않는다(WorkspaceViewport 퍼프 규칙과 동형).

import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { selectActiveWorkspaceSummary } from '../../stores/selectors/workspaceProjections';

const TABS: { id: 'git' | 'review'; labelKey: string; fallback: string }[] = [
  { id: 'git', labelKey: 'deck.tabGit', fallback: 'Git' },
  { id: 'review', labelKey: 'deck.tabReview', fallback: 'Review' },
];

export function WorkspaceUtilityBar() {
  const t = useT();
  // 활성 ws 이름만 필요 — name/branch가 바뀔 때만 리렌더(StatusBar와 동일 셀렉터).
  const activeWs = useStore(useShallow(selectActiveWorkspaceSummary));
  const view = useStore((s) => s.workspaceUtilityView);
  const setView = useStore((s) => s.setWorkspaceUtilityView);

  return (
    <div
      // 36px 크롬 모듈(h-9) — 페인 탭 스트립·덱 탭·사이드바 헤더와 하단 하airline 정렬.
      className="flex items-center shrink-0 h-9 pl-3 bg-[var(--bg-mantle)] border-b border-[var(--bg-surface)]"
      style={{ borderColor: 'var(--border-soft)' }}
      data-ws-utility-bar
      {...tokenAttrs('bgMantle', 'bg')}
      {...tokenAttrs('bgSurface', 'border')}
    >
      <span
        className="text-[12px] text-[var(--text-main)] font-medium font-mono truncate min-w-0"
        {...tokenAttrs('textMain', 'text')}
      >
        {activeWs.name || 'wmux'}
      </span>
      <div className="flex-1" />
      <div className="flex items-stretch h-full">
        {TABS.map((tab) => {
          const isActive = view === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              // 같은 값이면 토글 닫기(null), 아니면 해당 값으로.
              onClick={() => setView(isActive ? null : tab.id)}
              data-ws-utility-tab={tab.id}
              data-active={isActive ? 'true' : undefined}
              aria-pressed={isActive}
              className={`relative flex items-center px-3 text-[12.5px] font-semibold transition-colors duration-150 ${FOCUS_RING} ${
                isActive
                  ? 'text-[var(--text-main)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-sub)]'
              }`}
              {...(isActive ? tokenAttrs('textMain', 'text') : tokenAttrs('textMuted', 'text'))}
            >
              {t(tab.labelKey) || tab.fallback}
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent-blue)]"
                  {...tokenAttrs('accentSecondary', 'bg')}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default WorkspaceUtilityBar;
