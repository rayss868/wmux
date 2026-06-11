import { useEffect, useRef } from 'react';
import {
  PLUGIN_BRIDGE_VERSION,
  PLUGIN_PROTOCOL_SCHEME,
  parseBridgeRequest,
  type BridgeResponse,
} from '../../shared/pluginHost';

/**
 * Sandboxed plugin iframe + postMessage bridge (B-1 core).
 *
 * Security model:
 *   - `sandbox="allow-scripts"` ONLY — no allow-same-origin, so the frame
 *     runs with an opaque origin: no storage, no cookies, no reaching the
 *     parent document. Its sole channel to the host is the MessagePort
 *     delivered below.
 *   - The host stamps `pluginName` itself when forwarding requests; nothing
 *     in the envelope identifies the caller, so one plugin cannot
 *     impersonate another.
 *   - Inbound messages are validated by `parseBridgeRequest`; anything that
 *     doesn't match the frozen request shape is dropped silently.
 *   - Requests dispatch through main's RpcRouter with the plugin's
 *     clientName, so the Phase 2.2 permission stack (trust status,
 *     capability/path checks, approval prompts) applies to every call.
 *
 * Bridge handshake: on iframe `load`, the host creates a MessageChannel and
 * posts `{ v: 1, kind: 'init' }` with port2 transferred. targetOrigin is
 * `'*'` by necessity — a sandboxed frame's origin is opaque ("null") and
 * unmatchable; the port transfer is still point-to-point to this frame.
 */
export default function PluginFrame({
  pluginName,
  entry,
  className,
}: {
  pluginName: string;
  entry: string;
  className?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = frameRef.current;
    if (!iframe) return;
    let port: MessagePort | null = null;
    let disposed = false;

    const respond = (msg: BridgeResponse) => {
      try {
        port?.postMessage(msg);
      } catch {
        /* port may be closed mid-flight during unmount */
      }
    };

    const onLoad = () => {
      port?.close();
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (e: MessageEvent) => {
        const req = parseBridgeRequest(e.data);
        if (!req || disposed) return;
        window.electronAPI.plugins
          .rpc(pluginName, req.method, req.params)
          .then((raw) => {
            const resp = raw as { ok?: boolean; result?: unknown; error?: string } | null;
            if (resp && resp.ok === true) {
              respond({ v: PLUGIN_BRIDGE_VERSION, id: req.id, kind: 'response', result: resp.result });
            } else {
              respond({
                v: PLUGIN_BRIDGE_VERSION,
                id: req.id,
                kind: 'response',
                error: { code: 'rpc-rejected', message: resp?.error ?? 'request rejected' },
              });
            }
          })
          .catch((err: unknown) => {
            respond({
              v: PLUGIN_BRIDGE_VERSION,
              id: req.id,
              kind: 'response',
              error: { code: 'bridge-error', message: err instanceof Error ? err.message : String(err) },
            });
          });
      };
      iframe.contentWindow?.postMessage({ v: PLUGIN_BRIDGE_VERSION, kind: 'init' }, '*', [channel.port2]);
    };

    iframe.addEventListener('load', onLoad);
    return () => {
      disposed = true;
      iframe.removeEventListener('load', onLoad);
      port?.close();
      port = null;
    };
  }, [pluginName, entry]);

  return (
    <iframe
      ref={frameRef}
      src={`${PLUGIN_PROTOCOL_SCHEME}://${pluginName}/${entry}`}
      sandbox="allow-scripts"
      className={className}
      title={`plugin:${pluginName}`}
      style={{ border: 'none', width: '100%', height: '100%', background: 'transparent' }}
    />
  );
}
