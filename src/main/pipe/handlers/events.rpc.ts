import type { RpcRouter } from '../RpcRouter';
import { eventBus } from '../../events/EventBus';
import { WMUX_EVENT_TYPES, type WmuxEventType } from '../../../shared/events';
import type { PluginIdentityRecord } from '../../../shared/rpc';

const TYPE_SET = new Set<WmuxEventType>(WMUX_EVENT_TYPES);

/**
 * Async trust lookup, wired by main/index.ts to PluginTrustStore.get.
 * Optional so unit tests (and transitional callers) keep the unfiltered
 * pre-B-1 behavior.
 */
type TrustLookup = (clientName: string) => Promise<PluginIdentityRecord | undefined>;

/**
 * `notification.received` events carry terminal-program-controlled text, so
 * they are opt-in: a plugin with a declared capability set must include
 * `notifications.read` (bare or with a glob) to receive them
 * (schema-freeze §1/§4). Callers without an identity envelope or without a
 * declaration are grandfathered (consistent with the legacy/shadow ladder —
 * first-party and pre-declaration clients keep full visibility).
 */
function allowsNotifications(trust: PluginIdentityRecord | undefined): boolean {
  if (!trust?.declaredCapabilities || trust.declaredCapabilities.length === 0) return true;
  return trust.declaredCapabilities.some(
    (c) => c === 'notifications.read' || c.startsWith('notifications.read:'),
  );
}

function parseTypes(raw: unknown): WmuxEventType[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: WmuxEventType[] = [];
  for (const t of raw) {
    if (typeof t === 'string' && TYPE_SET.has(t as WmuxEventType)) {
      out.push(t as WmuxEventType);
    }
  }
  return out.length > 0 ? out : undefined;
}

export function registerEventsRpc(router: RpcRouter, trustLookup?: TrustLookup): void {
  /**
   * events.poll — pull events newer than `cursor`.
   * params: { cursor?: number, types?: WmuxEventType[], workspaceId?: string, max?: number }
   *
   * Default cursor is 0 (replay from oldest in the ring). External callers
   * SHOULD scope to their own `workspaceId` so they don't see other
   * workspaces' lifecycle. The renderer hop is bypassed — main answers
   * directly from the in-process ring.
   */
  router.register('events.poll', async (params, ctx) => {
    const cursor = typeof params['cursor'] === 'number' && Number.isFinite(params['cursor'])
      ? Math.max(0, Math.floor(params['cursor']))
      : 0;
    const workspaceId = typeof params['workspaceId'] === 'string' && params['workspaceId'].length > 0
      ? params['workspaceId']
      : undefined;
    const max = typeof params['max'] === 'number' && Number.isFinite(params['max'])
      ? Math.max(1, Math.floor(params['max']))
      : undefined;
    const types = parseTypes(params['types']);

    const result = eventBus.poll(cursor, { types, workspaceId, max });

    // notifications.read opt-in gate (see allowsNotifications). Applied as
    // a post-poll filter — NOT by rewriting `types` — because EventBus
    // treats an empty types array as "no filter", so a types-rewrite that
    // drains to [] would deliver everything to an unentitled caller.
    // Filtering the result keeps the cursor math intact (the caller's
    // nextCursor still advances past withheld events; they can never see
    // them anyway).
    if (ctx?.clientName && trustLookup) {
      let trust: PluginIdentityRecord | undefined;
      try {
        trust = await trustLookup(ctx.clientName);
      } catch {
        trust = undefined; // unreadable trust DB → grandfather, enforcer handles the rest
      }
      if (!allowsNotifications(trust)) {
        return {
          ...result,
          events: result.events.filter((e) => e.type !== 'notification.received'),
        };
      }
    }

    return result;
  });
}
