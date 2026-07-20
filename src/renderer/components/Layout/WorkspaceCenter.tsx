// ─── WorkspaceCenter — 중앙 영역(페인 그리드) ────────────────────────────────
//
// IA 결정(2026-07-20, 오너 원복): Git·Review 중앙 표면 시안을 걷어내고 우측
// 덱(ChannelDock)의 탭으로 복귀 — 중앙은 페인 그리드 전용으로 돌아간다.

import { WorkspaceViewport } from './WorkspaceViewport';

export function WorkspaceCenter() {
  return (
    <div className="flex-1 min-h-0 relative">
      <div className="absolute inset-0 flex flex-col" data-pane-grid-wrapper>
        <WorkspaceViewport />
      </div>
    </div>
  );
}

export default WorkspaceCenter;
