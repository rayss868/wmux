import { app } from 'electron';
import type { RpcRouter } from '../RpcRouter';
import { ALL_RPC_METHODS } from '../../../shared/rpc';
import { WMUX_EVENT_TYPES, RING_CAPACITY } from '../../../shared/events';
import { eventBus } from '../../events/EventBus';

/**
 * Shape returned by system.identify.
 */
interface SystemIdentity {
  app: string;
  version: string;
  platform: NodeJS.Platform;
  electronVersion: string;
}

export function registerSystemRpc(router: RpcRouter): void {
  /**
   * system.identify — returns static information about the running WinMux instance.
   * No renderer round-trip needed; answered entirely from Main.
   */
  router.register('system.identify', (_params): Promise<SystemIdentity> => {
    return Promise.resolve({
      app: 'wmux',
      version: app.getVersion(),
      platform: process.platform,
      electronVersion: process.versions.electron ?? 'unknown',
    });
  });

  /**
   * system.capabilities — returns the full list of registered RPC method names
   * plus a feature flag map so external tooling can detect optional surfaces
   * (pane metadata, future event bus, etc.) without inferring from method names.
   */
  router.register('system.capabilities', (_params) => {
    return Promise.resolve({
      methods: ALL_RPC_METHODS,
      features: {
        paneMetadata: true,
        events: {
          types: WMUX_EVENT_TYPES,
          maxRingSize: RING_CAPACITY,
          // Stable for the lifetime of this main-process run. Clients that
          // see bootId change between calls must drop all cached state —
          // pane ids, pty ids, and event cursors are all invalidated.
          bootId: eventBus.bootId,
        },
      },
    });
  });
}
