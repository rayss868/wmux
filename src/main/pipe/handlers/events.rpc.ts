import type { RpcRouter } from '../RpcRouter';
import { eventBus } from '../../events/EventBus';
import { WMUX_EVENT_TYPES, type WmuxEventType } from '../../../shared/events';

const TYPE_SET = new Set<WmuxEventType>(WMUX_EVENT_TYPES);

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

export function registerEventsRpc(router: RpcRouter): void {
  /**
   * events.poll — pull events newer than `cursor`.
   * params: { cursor?: number, types?: WmuxEventType[], workspaceId?: string, max?: number }
   *
   * Default cursor is 0 (replay from oldest in the ring). External callers
   * SHOULD scope to their own `workspaceId` so they don't see other
   * workspaces' lifecycle. The renderer hop is bypassed — main answers
   * directly from the in-process ring.
   */
  router.register('events.poll', (params) => {
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
    return Promise.resolve(result);
  });
}
