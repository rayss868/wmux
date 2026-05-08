// === wmux Event Bus types ===
//
// Lightweight event surface for external tooling (Claude Code, third-party MCPs)
// that want to react to pane/process lifecycle without polling the full state.
// Events are pull-only via `events.poll(cursor)` — pull cursor is the seq number
// of the last seen event; the bus returns events with `seq > cursor`.
//
// The ring is in-memory only and lives for the lifetime of the main process.
// Daemon restarts clear the ring; clients that drift past the ring window get
// a `resync: true` flag and should reconcile via `pane.list`.
//
// Workspace scoping: each event carries a `workspaceId`; `events.poll` filters
// by the caller's claimed workspace by default so workspaces stay isolated.

import type { PaneMetadata } from './types';

export type WmuxEventType =
  | 'pane.created'
  | 'pane.closed'
  | 'pane.focused'
  | 'pane.metadata.changed'
  | 'process.started'
  | 'process.exited';

export const WMUX_EVENT_TYPES: readonly WmuxEventType[] = [
  'pane.created',
  'pane.closed',
  'pane.focused',
  'pane.metadata.changed',
  'process.started',
  'process.exited',
] as const;

export interface WmuxEventBase {
  seq: number;          // monotonic; cursor for poll
  ts: number;           // ms epoch
  workspaceId: string;
  type: WmuxEventType;
}

export interface PaneCreatedEvent extends WmuxEventBase {
  type: 'pane.created';
  paneId: string;
  parentBranchId?: string;
}

export interface PaneClosedEvent extends WmuxEventBase {
  type: 'pane.closed';
  paneId: string;
}

export interface PaneFocusedEvent extends WmuxEventBase {
  type: 'pane.focused';
  paneId: string;
  previousPaneId?: string;
}

export interface PaneMetadataChangedEvent extends WmuxEventBase {
  type: 'pane.metadata.changed';
  paneId: string;
  metadata: PaneMetadata;
}

export interface ProcessStartedEvent extends WmuxEventBase {
  type: 'process.started';
  ptyId: string;
  pid?: number;
  shell: string;
}

export interface ProcessExitedEvent extends WmuxEventBase {
  type: 'process.exited';
  ptyId: string;
  exitCode: number | null;
  signal?: string;
}

export type WmuxEvent =
  | PaneCreatedEvent
  | PaneClosedEvent
  | PaneFocusedEvent
  | PaneMetadataChangedEvent
  | ProcessStartedEvent
  | ProcessExitedEvent;

export const RING_CAPACITY = 1024;
export const POLL_DEFAULT_MAX = 256;
