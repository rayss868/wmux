// === JSON-RPC Protocol Types ===

export interface RpcRequest {
  id: string;
  method: RpcMethod;
  params: Record<string, unknown>;
  token?: string;
}

export type RpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

// === RPC Method definitions ===
export type RpcMethod =
  | 'workspace.list'
  | 'workspace.new'
  | 'workspace.focus'
  | 'workspace.close'
  | 'workspace.current'
  | 'surface.list'
  | 'surface.new'
  | 'surface.focus'
  | 'surface.close'
  | 'pane.list'
  | 'pane.focus'
  | 'pane.split'
  | 'pane.setMetadata'
  | 'pane.getMetadata'
  | 'pane.clearMetadata'
  | 'pane.search'
  | 'events.poll'
  | 'input.send'
  | 'input.sendKey'
  | 'input.readScreen'
  | 'terminal.readEvents'
  | 'mcp.claimWorkspace'
  | 'notify'
  | 'meta.setStatus'
  | 'meta.setProgress'
  | 'system.identify'
  | 'system.capabilities'
  | 'browser.open'
  | 'browser.navigate'
  | 'browser.goBack'
  | 'browser.close'
  | 'browser.session.start'
  | 'browser.session.stop'
  | 'browser.session.status'
  | 'browser.session.list'
  | 'browser.type.humanlike'
  | 'browser.cdp.target'
  | 'browser.cdp.info'
  | 'browser.screenshot'
  | 'browser.evaluate'
  | 'browser.type.cdp'
  | 'browser.click.cdp'
  | 'browser.press.cdp'
  | 'daemon.createSession'
  | 'daemon.destroySession'
  | 'daemon.attachSession'
  | 'daemon.detachSession'
  | 'daemon.resizeSession'
  | 'daemon.listSessions'
  | 'daemon.readPromptEvents'
  | 'daemon.ping'
  | 'daemon.shutdown'
  | 'daemon.compact'
  | 'a2a.resolve.identity'
  | 'a2a.whoami'
  | 'a2a.discover'
  | 'a2a.task.send'
  | 'a2a.task.query'
  | 'a2a.task.update'
  | 'a2a.task.cancel'
  | 'a2a.broadcast'
  | 'meta.setSkills'
  | 'company.create'
  | 'company.destroy'
  | 'company.status'
  | 'company.addDept'
  | 'company.removeDept'
  | 'company.addMember'
  | 'company.removeMember'
  | 'company.broadcast'
  | 'company.sendDept'
  | 'company.sendMember'
  | 'company.message'
  | 'company.save'
  | 'company.restore'
  | 'company.templates'
  | 'company.worktreeSetup'
  | 'company.mergeDept'
  | 'company.a2a.whoami'
  | 'company.a2a.send'
  | 'company.a2a.broadcast'
  | 'company.a2a.inbox'
  | 'company.a2a.ack'
  | 'company.a2a.status'
  | 'company.provision'
  | 'company.provisionAll'
  | 'company.provisionCeo';

// All available methods as array (for system.capabilities)
export const ALL_RPC_METHODS = [
  'workspace.list',
  'workspace.new',
  'workspace.focus',
  'workspace.close',
  'workspace.current',
  'surface.list',
  'surface.new',
  'surface.focus',
  'surface.close',
  'pane.list',
  'pane.focus',
  'pane.split',
  'pane.setMetadata',
  'pane.getMetadata',
  'pane.clearMetadata',
  'pane.search',
  'events.poll',
  'input.send',
  'input.sendKey',
  'input.readScreen',
  'terminal.readEvents',
  'mcp.claimWorkspace',
  'notify',
  'meta.setStatus',
  'meta.setProgress',
  'system.identify',
  'system.capabilities',
  'browser.open',
  'browser.navigate',
  'browser.goBack',
  'browser.close',
  'browser.session.start',
  'browser.session.stop',
  'browser.session.status',
  'browser.session.list',
  'browser.type.humanlike',
  'browser.cdp.target',
  'browser.cdp.info',
  'browser.screenshot',
  'browser.evaluate',
  'browser.type.cdp',
  'browser.click.cdp',
  'browser.press.cdp',
  'daemon.createSession',
  'daemon.destroySession',
  'daemon.attachSession',
  'daemon.detachSession',
  'daemon.resizeSession',
  'daemon.listSessions',
  'daemon.readPromptEvents',
  'daemon.ping',
  'daemon.shutdown',
  'daemon.compact',
  'a2a.resolve.identity',
  'a2a.whoami',
  'a2a.discover',
  'a2a.task.send',
  'a2a.task.query',
  'a2a.task.update',
  'a2a.task.cancel',
  'a2a.broadcast',
  'meta.setSkills',
  'company.create',
  'company.destroy',
  'company.status',
  'company.addDept',
  'company.removeDept',
  'company.addMember',
  'company.removeMember',
  'company.broadcast',
  'company.sendDept',
  'company.sendMember',
  'company.message',
  'company.save',
  'company.restore',
  'company.templates',
  'company.worktreeSetup',
  'company.mergeDept',
  'company.a2a.whoami',
  'company.a2a.send',
  'company.a2a.broadcast',
  'company.a2a.inbox',
  'company.a2a.ack',
  'company.a2a.status',
  'company.provision',
  'company.provisionAll',
  'company.provisionCeo',
] as const satisfies readonly RpcMethod[];

// === RPC Parameter Types ===

export interface BrowserSessionStartParams {
  profile?: string;
}

export interface BrowserTypeHumanlikeParams {
  text: string;
  selector?: string;
}

// === Daemon RPC Types ===

export interface DaemonEvent {
  type:
    | 'session.created'
    | 'session.destroyed'
    | 'session.died'
    | 'session.output'
    | 'agent.event'
    | 'agent.critical'
    | 'activity.idle'
    | 'activity.active';
  sessionId: string;
  data: unknown;
}

// NOTE: 'session.destroyed' is broadcast when the renderer/MCP explicitly
// closes a session (pty:dispose → DaemonSessionManager.destroySession),
// while 'session.died' is broadcast when the underlying PTY exits on its
// own. Both must clear agentStatus on the main side; only one is reliably
// observed depending on the caller path.

export interface DaemonCreateSessionParams {
  id: string;
  cwd: string;
  cmd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  agent?: { role: string; teamId: string; displayName: string };
}

export interface DaemonSessionIdParams {
  id: string;
}

/**
 * Attach carries optional geometry so the daemon can resize+unmute a
 * recovery PTY (deferOutput=true) atomically before its SessionPipe
 * starts forwarding output. Without this, the renderer's first resize
 * RPC could lose the race against attach completion (silent
 * "session not found" swallow in pty.handler.ts) and the bridge would
 * stay muted forever — input still reaches the PTY but echo and
 * command output get dropped, looking like "input doesn't work".
 *
 * Backwards compatible: cols/rows are optional. Legacy callers sending
 * only { id } get the previous behavior (no attach-time resize).
 */
export interface DaemonAttachSessionParams {
  id: string;
  cols?: number;
  rows?: number;
}

export interface DaemonResizeParams {
  id: string;
  cols: number;
  rows: number;
}

// === Pane Metadata RPC types (M0-f) ===
//
// Wire-format spec for the metadata RPC surface. Lifted out of the handler
// internals so external clients can build against a documented, stable
// shape. All additions are backwards-compatible with v2.8.x clients:
//   - PaneSetMetadataParams.mergeMode / .expectedVersion are optional
//   - .merge:boolean still works and maps to mergeMode merge|replace
//   - PaneSetMetadataResult.version is an ADDITIVE field; v2.8.x readers
//     that destructure { ok, paneId, metadata } continue to compile
//   - PaneGetMetadataResult.version is additive (same rationale)
//   - PaneMetadataCapabilities surfaces in system.capabilities as an
//     object; v2.8.x boolean checks (`if (caps.features.paneMetadata)`)
//     still pass because the object is truthy

import type { PaneMetadata } from './types';

/**
 * Merge semantics for pane.setMetadata writes — see PROTOCOL.md §1.3
 * (race spec #2 — optimistic concurrency).
 *
 *   - 'merge':         patch-style; deep-merges custom one level (default)
 *   - 'replace':       full overwrite — only patch fields survive
 *   - 'replaceShared': overwrites top-level shared fields (label/role/status)
 *                      but preserves base.custom verbatim
 */
export type MetadataMergeMode = 'merge' | 'replace' | 'replaceShared';

export interface PaneSetMetadataParams {
  /** Omit to target active leaf in caller's workspace (resolved via pane.resolveActiveLeaf). */
  paneId?: string;
  /** External MCP callers should pass this so writes stay scoped to their workspace. */
  workspaceId?: string;
  label?: string;
  role?: string;
  status?: string;
  custom?: Record<string, string>;
  /**
   * Legacy boolean — kept for v2.8.x client compatibility.
   * true → merge, false → replace. Equivalent to `mergeMode: 'merge'` / `'replace'`.
   * When both `merge` and `mergeMode` are present, `mergeMode` wins.
   */
  merge?: boolean;
  /** v2.9.0+ — explicit merge semantics. Overrides legacy `merge` when present. */
  mergeMode?: MetadataMergeMode;
  /**
   * v2.9.0+ — optimistic concurrency guard. If the pane's current version
   * differs, the server returns VERSION_CONFLICT and does not mutate.
   * Omit for unconditional writes (legacy v2.8.x behavior).
   */
  expectedVersion?: number;
}

export interface PaneSetMetadataResult {
  ok: true;
  paneId: string;
  metadata: PaneMetadata;
  /** v2.9.0+ — post-commit monotonic version. */
  version: number;
}

export interface PaneGetMetadataParams {
  paneId?: string;
  workspaceId?: string;
}

export interface PaneGetMetadataResult {
  paneId: string;
  metadata: PaneMetadata;
  /** v2.9.0+ — current monotonic version for this pane. */
  version: number;
}

export interface PaneClearMetadataParams {
  paneId?: string;
  workspaceId?: string;
}

export interface PaneClearMetadataResult {
  ok: true;
  paneId: string;
  /** v2.9.0+ — version after the clear (bumped monotonically). */
  version: number;
}

/**
 * Surface form of features.paneMetadata in system.capabilities (M0-f).
 * Truthy in boolean context — v2.8.x clients that wrote
 * `if (caps.features.paneMetadata)` continue to work because a non-null
 * object is truthy. v2.9.0+ clients can inspect `optimisticConcurrency`
 * and `mergeModes` to feature-detect the M0 surface.
 */
export interface PaneMetadataCapabilities {
  optimisticConcurrency: true;
  mergeModes: readonly MetadataMergeMode[];
}

/**
 * JSON-RPC error code returned when `pane.setMetadata.expectedVersion`
 * does not match the pane's current version. Exported for clients that
 * want to type-narrow on the error code; the current RpcRouter envelope
 * only surfaces an error message string (with `currentVersion=N` embedded
 * for retry), so this code is informational until the envelope grows
 * structured error data.
 */
export const RPC_VERSION_CONFLICT = -32001 as const;
