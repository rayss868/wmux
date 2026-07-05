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
import { resolveSenderPaneAddress } from './a2aAddressing';

/** Reserved GUI member id — the human seat (one per workspace, no PTY). Mirrors
 *  the daemon's reserved identity (a2a.channel.rpc.ts spoof reject) and the UI
 *  (ChannelMembers UI_MEMBER_ID). A mention of THIS member targets the HUMAN. */
const HUMAN_MEMBER_ID = 'local-ui';

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
  /** Durable "this mention's nudge was actually PASTED" check (remediation 2d).
   *  Routed ≠ delivered: a pane-targeted mention that was routed but still HELD
   *  (busy agent) when the app reloaded must be re-routed, or it is silently
   *  lost. Optional for back-compat with tests/callers that don't wire it —
   *  absent behaves like the pre-2d strict handled guard. */
  isDeliveredPersisted?: (handledKey: string) => boolean;
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
  // Only act on mentions of THIS workspace — and NEVER on a mention of the
  // human seat (memberId 'local-ui'). The a2a inbox is an AGENT delivery
  // channel (consumed via a2a_task_query); a human is reached by the GUI dock
  // badge (appendMessageFromEvent, independent of this task). Dogfood RCA
  // 2026-07-05: a Phase-2b regression pasted "@local-ui …" into the single
  // live agent pane of the human's workspace — an agent then "answered" a
  // greeting meant for the person, feeding the loop. A human mention creates
  // NO inbox task (badge only); it can never reach an agent PTY.
  const selfMentions = (message.mentions ?? []).filter(
    (m) => m.workspaceId === selfWorkspaceId && m.memberId !== HUMAN_MEMBER_ID,
  );
  if (selfMentions.length === 0) return [];
  // R1 — same-workspace posts. A post authored INSIDE this workspace may still
  // legitimately mention a SIBLING agent pane (pane1 → pane2); only a TRUE
  // self-loop (an agent @-mentioning its OWN pane) must be dropped. We tell them
  // apart by the poster's pane, resolved from the daemon-stamped `senderPtyId` in
  // our OWN live leaves — the sender's pane lives in this workspace exactly when
  // the post is same-ws. A human/composer post carries no senderPtyId (local-ui
  // has no pane), so `senderPaneId` stays undefined and every same-ws pane-level
  // mention routes (a human can never self-loop). Pre-R1 messages lack the field
  // and fall into the same safe "no self-pane known" branch.
  const isSameWs = message.workspaceId === selfWorkspaceId;
  const senderPaneId =
    isSameWs && message.senderPtyId
      ? resolveSenderPaneAddress(selfLeaves, message.senderPtyId)?.paneId
      : undefined;

  const chName = deps.channelName(message.channelId);
  const created: string[] = [];
  const seen = new Set<string>();
  for (const mn of selfMentions) {
    // R1 same-ws gate: on a post THIS workspace authored, route only a pane-level
    // mention of a pane OTHER than the sender's.
    //  - no paneId (workspace-level mention): can't tell self from sibling →
    //    skip (conservative — the pre-R1 behavior for this shape).
    //  - paneId === the sender's own pane: a true self-loop → skip.
    // A cross-ws post (isSameWs false) is never a self-loop and skips this gate.
    if (isSameWs) {
      if (!mn.paneId) continue;
      if (senderPaneId && mn.paneId === senderPaneId) continue;
    }
    // Resolve a pane-level target. The composer pinned `paneId` + a `ptyId`
    // snapshot at mention time; resolve the paneId in our OWN live leaves and
    // re-check the ptyId still matches (fail-closed). On any miss, leave the
    // target ws-level (no to.paneId) so a live sibling still receives it via
    // role:agent query — never delivered to a wrong successor pane.
    let toPaneId: string | undefined;
    let toSurfaceId: string | undefined;
    let toPtyId: string | undefined;
    if (mn.paneId && mn.ptyId) {
      // Resolve by the route-time ptyId snapshot, NOT paneId+active-surface: a
      // pane can hold several terminal surfaces and resolvePaneAddress(paneId-only)
      // would pick the ACTIVE one, missing the originally-mentioned agent. Pin the
      // pane target ONLY when that exact pty is still live in the SAME pane. A
      // paneId WITHOUT a ptyId (legacy/human mention), a pty that's gone, or a
      // successor agent now holding the pane (restart) all stay ws-level — a live
      // sibling still picks it up via role:agent query and we never deliver to the
      // wrong occupant (CodeRabbit review).
      const addr = resolveSenderPaneAddress(selfLeaves, mn.ptyId);
      if (addr && addr.paneId === mn.paneId) {
        toPaneId = addr.paneId;
        toSurfaceId = addr.surfaceId;
        toPtyId = addr.ptyId; // snapshot for restart fail-closed at flush time (codex R5)
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
    // one (persisted sets). 2d split (held-mention loss fix):
    //   - delivered (nudge actually pasted, persisted) → always skip.
    //   - handled-but-NOT-delivered:
    //       · ws-level mention (no mn.paneId) → skip (route-time semantics —
    //         badge-only tasks would otherwise resurrect on every boot).
    //       · PANE-targeted mention → RE-ROUTE after a reload. This is the
    //         mention that was routed, then HELD (busy agent), then lost when
    //         the reload emptied the in-memory task store. Known trade-off: a
    //         pane mention the agent consumed via a2a_task_query WITHOUT a
    //         paste (rare — the auto-paste usually wins) can re-route once
    //         after a reboot; a duplicate ping beats a silently lost one.
    if (deps.getTask(taskId)) continue;
    if (deps.isDeliveredPersisted?.(handledKey)) continue;
    if (deps.isHandled(handledKey) && (!mn.paneId || !deps.isDeliveredPersisted)) continue;

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
          // 2d + 2a-2: carried so the FLUSH side can (a) persist the durable
          // delivered mark under the same key the route guard checks, and
          // (b) report the nudge to the daemon wake worker's shared ledger
          // keyed by the mentioned member row. mn.memberId may be absent
          // (workspace-level mention) — the ledger report is skipped then.
          handledKey,
          ...(mn.memberId ? { mentionMemberId: mn.memberId } : {}),
          // F1 (adversarial review): marks a task whose mention PINNED a pane at
          // post time. Only such a task may use the 2b degraded single-agent
          // delivery — a ws-level mention BY CONSTRUCTION (human mention with
          // member_id omitted, deliberate workspace ping) must never be pasted
          // into "the one live agent"; that is how a message meant for the
          // human reached an agent PTY (greeting-loop RCA).
          ...(mn.paneId ? { mentionPaneId: mn.paneId } : {}),
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
