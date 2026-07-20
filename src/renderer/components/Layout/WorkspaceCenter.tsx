// ─── WorkspaceCenter — central area (pane grid)────────────────────────────────
//
// IA decision (2026-07-20, owner revert): drop the central Git/Review surface variant
// and move back to tabs in the right-hand deck (ChannelDock) — the center returns to
// being pane-grid-only.

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
