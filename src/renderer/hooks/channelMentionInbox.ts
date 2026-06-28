// ─── Channel mention → a2a inbox routing (Phase 2 #7 + agent-pane redesign) ──
//
// Channels have no agent-read path yet (channel_history is deferred), so an
// agent never *sees* a channel post — even one that @-mentions it. This module
// bridges that gap WITHOUT a new agent surface: when a channel.message that
// mentions the current workspace lands in the renderer (the same event that
// drives the dock badge in #6), we mint an a2a task addressed to this
// workspace's mentioned AGENT. The agent then receives it through its NORMAL
// inbox poll (`a2a_task_query` / `wmux_events_poll` for `a2a.task`) and can
// reply with `channel_post` (#8). We reuse the a2a task infrastructure rather
// than invent a parallel channel-mention event type.
//
// Trust: the mention set is server-validated (ChannelService.post keeps only
// current-member mentions, frozen at critical-section entry), so `from`
// (= the post's sender workspace) is the daemon's authoritative sender, not a
// renderer-forgeable value. The mentioned workspace's own renderer is the one
// that observes the event and creates the task — `to.workspaceId` is always self.
//
// Routing granularity: PANE-LEVEL (agent-pane redesign). The composer pins the
// mentioned agent's `paneId` + a `ptyId` snapshot at mention time. Here, in the
// RECEIVING renderer, we resolve that paneId in our OWN live leaves and re-check
// the ptyId is still that pane's live pty (fail-closed). On a hit we pin
// `to.paneId` so the task addresses exactly that agent (split panes → exactly one
// agent). On a miss (pane gone, or pty changed = the agent restarted and a
// DIFFERENT agent now holds the pane) we fall back to a ws-level task — a live
// sibling agent still picks it up via role:agent query, and we NEVER deliver to
// the wrong successor pane. A mention with no paneId is ws-level by construction
// (the human composer / legacy path).
//
// Idempotency: the task id is deterministic and per-target
// (`chmention-<channelId>-<seq>[-<paneId>]`), so event re-delivery (resync
// replay, double poll) is a no-op — `getTask` short-circuits before a duplicate
// task or a duplicate `a2a.task` event is emitted, and two agents mentioned in
// one post (one seq) get distinct task ids instead of colliding.

import type { ChannelMessage } from '../../shared/channels';
import type { Task, Message, Part, Artifact, TaskState, PaneLeaf } from '../../shared/types';
import { resolvePaneAddress } from './a2aAddressing';

/** Dependencies injected so the routing logic stays a pure, unit-testable
 *  function (no store / window coupling). The hook wires these to the real
 *  store actions + EventBus publisher. */
export interface MentionInboxDeps {
  /** Look up an existing task by id (idempotency guard). */
  getTask: (taskId: string) => Task | undefined;
  /** Create the inbox task; returns its id. Mirrors `a2aSlice.createA2aTask`. */
  createA2aTask: (task: {
    id?: string;
    title: string;
    from: { workspaceId: string; name: string; paneId?: string; surfaceId?: string };
    to: { workspaceId: string; name: string; paneId?: string; surfaceId?: string; ptyId?: string };
    history: Message[];
    artifacts: Artifact[];
  }) => string;
  /** Resolve a channel's display name (falls back to the id). */
  channelName: (channelId: string) => string;
  /** Resolve a workspace's display name (falls back to the id). */
  workspaceName: (workspaceId: string) => string;
  /** Emit the dual-party `a2a.task` pointer (events/publisher.publishA2aTask). */
  publish: (
    from: string,
    to: string,
    taskId: string,
    state: TaskState,
    kind: 'created' | 'updated' | 'cancelled',
  ) => void;
  /** Durable (reload-surviving) "already routed this mention" check. The store
   *  isn't persisted, so the in-memory getTask() guard misses after a reload —
   *  this is the persisted backstop against boot-replay resurrection (A3). */
  isHandled: (taskId: string) => boolean;
  /** Record that this mention was routed (persisted). */
  markHandled: (taskId: string) => void;
}

/** Deterministic, per-target task id for a channel mention — idempotent across
 *  event re-delivery. `paneId` (when the mention resolved to a live pane)
 *  namespaces the id so two agents mentioned in ONE post (same seq) don't
 *  collide. Exported for the test + any future reconciliation. */
export function channelMentionTaskId(channelId: string, seq: number, paneId?: string): string {
  return paneId
    ? `chmention-${channelId}-${seq}-${paneId}`
    : `chmention-${channelId}-${seq}`;
}

/**
 * Route one channel.message into the a2a inbox for every @-mention of
 * `selfWorkspaceId`. Returns the created task ids (possibly several — one per
 * distinct mentioned pane in this workspace), or `[]` when nothing was routed
 * (not mentioned, self-posted, or already routed). Never throws — a routing
 * failure must not break the channel message dispatch that drives the UI.
 *
 * `selfLeaves` is this workspace's own live pane tree (root → leaves), used to
 * resolve a mention's `paneId` to a concrete live pane + fail-closed ptyId check.
 */
export function routeChannelMentionToInbox(
  message: ChannelMessage,
  selfWorkspaceId: string,
  selfLeaves: PaneLeaf[],
  deps: MentionInboxDeps,
): string[] {
  // Only act on mentions of THIS workspace.
  const selfMentions = (message.mentions ?? []).filter((m) => m.workspaceId === selfWorkspaceId);
  if (selfMentions.length === 0) return [];
  // Never ping yourself on a post THIS workspace authored. Same-ws sibling-agent
  // mentions (pane1 → pane2 within one workspace) are a follow-up: the post event
  // carries no sender paneId, so we cannot yet distinguish a true self-loop from a
  // legitimate sibling target. Until then, a same-ws post never self-routes.
  if (message.workspaceId === selfWorkspaceId) return [];

  const chName = deps.channelName(message.channelId);
  const created: string[] = [];
  const seen = new Set<string>();
  for (const mn of selfMentions) {
    // Resolve a pane-level target. The composer pinned `paneId` + a `ptyId`
    // snapshot at mention time; resolve the paneId in our OWN live leaves and
    // re-check the ptyId still matches (fail-closed). On any miss, leave the
    // target ws-level (no to.paneId) so a live sibling still receives it via
    // role:agent query — never delivered to a wrong successor pane.
    let toPaneId: string | undefined;
    let toSurfaceId: string | undefined;
    let toPtyId: string | undefined;
    if (mn.paneId) {
      const r = resolvePaneAddress(selfLeaves, mn.paneId, '');
      if (!('error' in r) && (!mn.ptyId || r.ptyId === mn.ptyId)) {
        toPaneId = r.paneId;
        toSurfaceId = r.surfaceId;
        toPtyId = r.ptyId; // snapshot for restart fail-closed at flush time (codex R5)
      }
    }

    const taskId = channelMentionTaskId(message.channelId, message.seq, toPaneId);
    // Durable-dedup key (A3) keyed on the mention's TARGETED pane (mn.paneId),
    // NOT the resolved toPaneId. toPaneId falls back to undefined when the pane's
    // ptyId snapshot no longer matches (fail-closed) — which is exactly what a
    // FULL APP RESTART causes (same paneId, new ptyId). If the persisted key used
    // toPaneId it would flip pane→ws across a restart and miss the recorded entry
    // → resurrection (GLM review P1). mn.paneId comes from the message itself, so
    // it's identical on every replay regardless of local pane liveness, while
    // still namespacing two agents mentioned in ONE post (distinct mn.paneId).
    const handledKey = channelMentionTaskId(message.channelId, message.seq, mn.paneId);
    // Idempotent: a re-delivered event (resync replay / overlapping poll) must
    // not mint a second task or re-emit the pointer; and two mentions that
    // resolve to the SAME target (e.g. both fell back to ws-level) collapse here.
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    // Skip if already routed — in THIS session (getTask, live store) OR a prior
    // one (isHandled, persisted). The persisted check is what stops a reload's
    // boot-replay from resurrecting a completed mention task (A3): after a reload
    // the store is empty so getTask misses, but isHandled still remembers.
    if (deps.getTask(taskId) || deps.isHandled(handledKey)) continue;

    const parts: Part[] = [{ kind: 'text', text: message.text }];
    const history: Message[] = [
      {
        kind: 'message',
        // Deterministic message id mirrors the task id's idempotency intent.
        messageId: `chmention-msg-${message.channelId}-${message.seq}${toPaneId ? `-${toPaneId}` : ''}`,
        role: 'user',
        parts,
        metadata: {
          source: 'channel-mention',
          channelId: message.channelId,
          seq: message.seq,
        },
      },
    ];

    try {
      deps.createA2aTask({
        id: taskId,
        title: `#${chName} — mention from ${message.memberName}`,
        from: { workspaceId: message.workspaceId, name: message.memberName },
        to: {
          workspaceId: selfWorkspaceId,
          name: deps.workspaceName(selfWorkspaceId),
          ...(toPaneId ? { paneId: toPaneId, surfaceId: toSurfaceId, ptyId: toPtyId } : {}),
        },
        history,
        artifacts: [],
      });
      // Emit AFTER the store write so a poller that follows the pointer can
      // immediately query the task (created-before-queryable race guard — same
      // ordering rule as the a2a.task.send path).
      deps.publish(message.workspaceId, selfWorkspaceId, taskId, 'submitted', 'created');
      // Persist that we routed this mention so a later reload's boot-replay
      // skips it (A3 — survives the empty-store window). Keyed on the targeted
      // pane (handledKey), stable across a full restart's ptyId change.
      deps.markHandled(handledKey);
      created.push(taskId);
    } catch {
      // Best-effort: never let inbox routing break channel message dispatch.
    }
  }
  return created;
}
