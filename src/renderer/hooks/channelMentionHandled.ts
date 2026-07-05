// ─── Persisted "already routed" / "already delivered" sets for channel-mention
//     inbox tasks ─────────────────────────────────────────────────────────────
//
// A2A dogfooding (A3): a completed channel-mention task was resurrected on
// RELOAD. The renderer store has no persist middleware, so a reload empties
// a2aTasks; and useChannelsEventSubscription boots with cursor=0, which replays
// every channel.message still in the daemon ring. With an empty store, both the
// in-memory getTask() guard and the idempotent createA2aTask() guard miss, so
// each replayed mention is re-created as a fresh 'submitted' task — the agent
// re-does finished work.
//
// Two durable sets survive a reload (both bounded, localStorage-backed):
//
//   HANDLED   — "this mention was ROUTED to the inbox" (stamped at route time).
//   DELIVERED — "this mention's nudge was actually PASTED into the target pane"
//               (stamped at deliver time — remediation 2d). Routing ≠ delivery:
//               a mention routed but still HELD (busy agent) at reload time used
//               to be lost forever, because the handled set blocked the re-route
//               while the in-memory task (the only thing that could still
//               deliver it) was gone. The route guard now re-routes a
//               PANE-TARGETED handled-but-undelivered mention after a reload;
//               ws-level mentions keep the strict route-time semantics (they are
//               badge-only and would otherwise resurrect on every boot).
//
// Upgrade migration: installs that predate the delivered set have handled
// entries whose delivery outcome is unknowable. Seeding delivered := handled
// once (first load with no delivered storage) preserves the old no-resurrection
// behavior for the backlog; the held-mention recovery applies going forward.
//
// Why localStorage: the renderer origin is stable across both an in-window
// reload and a full app restart (Electron persists it to disk), and the routing
// runs in the renderer. Bounded FIFO so it can't grow without limit.

const STORAGE_KEY = 'wmux.channelMentionHandled.v1';
const DELIVERED_STORAGE_KEY = 'wmux.channelMentionDelivered.v1';
/** Keep the most recent N ids per set. This MUST stay well above the daemon
 *  EventBus ring size (1024, the max channel.message events a boot can replay)
 *  — if an id is FIFO-evicted here while its channel.message is still in the
 *  ring, a boot replay would resurrect it. 2000 > 1024 with margin; revisit if
 *  the ring grows. */
const CAP = 2000;

interface PersistedIdSet {
  loaded: boolean;
  order: string[];
  seen: Set<string>;
}

const handled: PersistedIdSet = { loaded: false, order: [], seen: new Set() };
const delivered: PersistedIdSet = { loaded: false, order: [], seen: new Set() };

function loadSet(set: PersistedIdSet, storageKey: string): boolean {
  if (set.loaded) return true;
  set.loaded = true;
  let hadStorage = false;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
    hadStorage = raw !== null;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const filtered = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : [];
    // Dedup on load: external corruption could leave duplicate ids, and the FIFO
    // evict (delete from `seen` on splice) would wrongly forget a still-present id.
    set.order = [...new Set(filtered)];
  } catch {
    // Parse failure loses the whole history → every in-ring mention re-routes.
    // Warn (don't silently swallow) so a resurrection spike is traceable.
    console.warn(`[channelMentionHandled] failed to parse persisted set ${storageKey}; starting empty`);
    set.order = [];
  }
  set.seen = new Set(set.order);
  return hadStorage;
}

function persistSet(set: PersistedIdSet, storageKey: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(storageKey, JSON.stringify(set.order));
    }
  } catch (err) {
    // best-effort, but NOT silent: a quota/serialization failure means the
    // in-memory mark didn't reach disk → that mention can resurrect on reload.
    console.warn(`[channelMentionHandled] persist failed for ${storageKey} (set may not survive reload):`, err);
  }
}

function addToSet(set: PersistedIdSet, storageKey: string, id: string): void {
  if (set.seen.has(id)) return;
  set.seen.add(id);
  set.order.push(id);
  if (set.order.length > CAP) {
    const dropped = set.order.splice(0, set.order.length - CAP);
    for (const d of dropped) set.seen.delete(d);
  }
  persistSet(set, storageKey);
}

function ensureHandledLoaded(): void {
  loadSet(handled, STORAGE_KEY);
}

function ensureDeliveredLoaded(): void {
  if (delivered.loaded) return;
  ensureHandledLoaded();
  const hadStorage = loadSet(delivered, DELIVERED_STORAGE_KEY);
  // One-time upgrade seed (see header): no delivered storage yet + a non-empty
  // handled backlog ⇒ treat the backlog as delivered so pre-upgrade completed
  // mentions do not resurrect on the first boot after this change ships.
  if (!hadStorage && handled.order.length > 0) {
    delivered.order = [...handled.order];
    delivered.seen = new Set(delivered.order);
    persistSet(delivered, DELIVERED_STORAGE_KEY);
  }
}

/** True if this channel-mention task id has already been routed to the inbox
 *  (in a prior session / before a reload). */
export function isChannelMentionHandled(taskId: string): boolean {
  ensureHandledLoaded();
  return handled.seen.has(taskId);
}

/** Record that this channel-mention task id has been routed, so a later reload
 *  replay skips it. No-op if already recorded. FIFO-evicts beyond CAP. */
export function markChannelMentionHandled(taskId: string): void {
  ensureHandledLoaded();
  addToSet(handled, STORAGE_KEY, taskId);
}

/** True if this mention's nudge was actually pasted into its target pane in
 *  some session (durable — survives reload). Keyed like the handled set (the
 *  mention's handledKey), NOT by the volatile task id. */
export function isChannelMentionDeliveredPersisted(handledKey: string): boolean {
  ensureDeliveredLoaded();
  return delivered.seen.has(handledKey);
}

/** Record a successful nudge paste for this mention (remediation 2d — the
 *  deliver-time half of the durable dedup). No-op if already recorded. */
export function markChannelMentionDeliveredPersisted(handledKey: string): void {
  ensureDeliveredLoaded();
  addToSet(delivered, DELIVERED_STORAGE_KEY, handledKey);
}

/** Test seam — reset the in-memory + persisted state (both sets). */
export function __resetChannelMentionHandledForTests(): void {
  handled.loaded = false;
  handled.order = [];
  handled.seen = new Set();
  delivered.loaded = false;
  delivered.order = [];
  delivered.seen = new Set();
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(DELIVERED_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}
