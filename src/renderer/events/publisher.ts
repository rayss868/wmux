// === Renderer-side EventBus publisher ===
//
// Thin shim around the preload IPC channel. Slice methods call these helpers
// inside their state mutations so external tooling can poll the EventBus on
// main and see pane lifecycle. Failures are swallowed — telemetry never
// breaks a state mutation.
//
// NOTE on `pane.metadata.changed`: There is intentionally no renderer-side
// publisher for this event. As of v2.9.0 (M0-d) the renderer no longer owns
// the metadata write path; `MetadataStore` (main process) is the sole writer
// and emits `pane.metadata.changed` directly on the main-process EventBus
// from inside its synchronous critical section. A renderer publisher would
// race the store's own emit and could surface stale `version` values to
// subscribers. If you need to react to metadata changes, poll the EventBus
// or rely on `pane.list` reconciliation.

import type { WorkspaceMetadata } from '../../shared/types';
import type { WmuxEventType } from '../../shared/events';

interface ElectronEventsAPI {
  publish: (input: { type: string; workspaceId: string; [k: string]: unknown }) => void;
}

interface ElectronAPIMaybe {
  events?: ElectronEventsAPI;
}

declare const window: { electronAPI?: ElectronAPIMaybe } & Window;

function publish(input: { type: WmuxEventType; workspaceId: string; [k: string]: unknown }): void {
  try {
    const api = (typeof window !== 'undefined' ? window.electronAPI : undefined)?.events;
    api?.publish?.(input);
  } catch {
    // Swallow — never let publish failure surface into the state mutation.
  }
}

export function publishPaneCreated(workspaceId: string, paneId: string, parentBranchId?: string): void {
  publish({ type: 'pane.created', workspaceId, paneId, ...(parentBranchId ? { parentBranchId } : {}) });
}

export function publishPaneClosed(workspaceId: string, paneId: string): void {
  publish({ type: 'pane.closed', workspaceId, paneId });
}

export function publishPaneFocused(workspaceId: string, paneId: string, previousPaneId?: string): void {
  publish({ type: 'pane.focused', workspaceId, paneId, ...(previousPaneId ? { previousPaneId } : {}) });
}

export function publishWorkspaceMetadataChanged(
  workspaceId: string,
  metadata: WorkspaceMetadata,
  patch: Partial<WorkspaceMetadata>,
): void {
  publish({ type: 'workspace.metadata.changed', workspaceId, metadata, patch });
}
