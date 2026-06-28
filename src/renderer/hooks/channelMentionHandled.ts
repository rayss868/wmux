// ─── Persisted "already routed" set for channel-mention inbox tasks ──────────
//
// A2A dogfooding (A3): a completed channel-mention task was resurrected on
// RELOAD. The renderer store has no persist middleware, so a reload empties
// a2aTasks; and useChannelsEventSubscription boots with cursor=0, which replays
// every channel.message still in the daemon ring. With an empty store, both the
// in-memory getTask() guard and the idempotent createA2aTask() guard miss, so
// each replayed mention is re-created as a fresh 'submitted' task — the agent
// re-does finished work.
//
// This is the durable truth source that survives a reload: a bounded,
// localStorage-backed set of channel-mention task ids that have ALREADY been
// routed to the inbox. routeChannelMentionToInbox checks it before creating, so
// a boot replay of an old mention is skipped — while a genuinely NEW mention
// (arrived while the app was closed, not in the set) is still routed.
//
// Why localStorage: the renderer origin is stable across both an in-window
// reload and a full app restart (Electron persists it to disk), and the routing
// runs in the renderer. Bounded FIFO so it can't grow without limit.

const STORAGE_KEY = 'wmux.channelMentionHandled.v1';
/** Keep the most recent N routed ids. This MUST stay well above the daemon
 *  EventBus ring size (1024, the max channel.message events a boot can replay)
 *  — if an id is FIFO-evicted here while its channel.message is still in the
 *  ring, a boot replay would resurrect it. 2000 > 1024 with margin; revisit if
 *  the ring grows. */
const CAP = 2000;

let loaded = false;
let order: string[] = [];
let seen = new Set<string>();

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const filtered = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : [];
    // Dedup on load: external corruption could leave duplicate ids, and the FIFO
    // evict (delete from `seen` on splice) would wrongly forget a still-present id.
    order = [...new Set(filtered)];
  } catch {
    // Parse failure loses the whole history → every in-ring mention re-routes.
    // Warn (don't silently swallow) so a resurrection spike is traceable.
    console.warn('[channelMentionHandled] failed to parse persisted set; starting empty');
    order = [];
  }
  seen = new Set(order);
}

function persist(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
    }
  } catch (err) {
    // best-effort, but NOT silent: a quota/serialization failure means the
    // in-memory mark didn't reach disk → that mention can resurrect on reload.
    console.warn('[channelMentionHandled] persist failed (handled set may not survive reload):', err);
  }
}

/** True if this channel-mention task id has already been routed to the inbox
 *  (in a prior session / before a reload). */
export function isChannelMentionHandled(taskId: string): boolean {
  ensureLoaded();
  return seen.has(taskId);
}

/** Record that this channel-mention task id has been routed, so a later reload
 *  replay skips it. No-op if already recorded. FIFO-evicts beyond CAP. */
export function markChannelMentionHandled(taskId: string): void {
  ensureLoaded();
  if (seen.has(taskId)) return;
  seen.add(taskId);
  order.push(taskId);
  if (order.length > CAP) {
    const dropped = order.splice(0, order.length - CAP);
    for (const d of dropped) seen.delete(d);
  }
  persist();
}

/** Test seam — reset the in-memory + persisted state. */
export function __resetChannelMentionHandledForTests(): void {
  loaded = false;
  order = [];
  seen = new Set();
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
