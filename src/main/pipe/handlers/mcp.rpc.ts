// MCP plugin identity / permission-declaration handlers.
//
// Two record-only RPCs that wire identity through the substrate without
// gating any existing behavior. A follow-up PR will introduce enforcement
// (method dispatch / metadata path write / event subscription) on top of
// the trust DB seeded here. See `docs/api/mcp-plugin-spec.md`.

import type { RpcRouter } from '../RpcRouter';
import type {
  McpDeclarePermissionsParams,
  McpDeclarePermissionsResult,
  McpIdentifyParams,
  McpIdentifyResult,
  RpcContext,
} from '../../../shared/rpc';
import {
  getPluginTrustStore,
  PluginTrustStore,
} from '../../mcp/PluginTrustStore';
import { parsePermissionList } from '../../mcp/permissionGrammar';

// Resolve the caller's declared name with the request envelope taking
// priority over the params body, so a plugin can't claim to be one name in
// `mcp.identify` while sending RPCs under another `clientName`.
function resolveCallerName(
  ctx: RpcContext | undefined,
  rawNameFromParams: unknown,
): { name: string; usedSource: 'envelope' | 'params' | 'unknown' } {
  const envelopeName =
    typeof ctx?.clientName === 'string' ? ctx.clientName.trim() : '';
  if (envelopeName.length > 0) {
    return { name: envelopeName, usedSource: 'envelope' };
  }
  if (typeof rawNameFromParams === 'string' && rawNameFromParams.trim().length > 0) {
    return { name: rawNameFromParams.trim(), usedSource: 'params' };
  }
  return { name: 'unknown', usedSource: 'unknown' };
}

export function registerMcpPluginRpc(
  router: RpcRouter,
  storeOverride?: PluginTrustStore,
): void {
  const store = storeOverride ?? getPluginTrustStore();

  // mcp.identify — first-contact handshake. Records the plugin in the
  // trust DB and returns the current record. Idempotent: existing entries
  // refresh `lastSeen`; user-issued trust state ('trusted' | 'denied') is
  // preserved.
  router.register('mcp.identify', async (rawParams, ctx) => {
    const params = (rawParams ?? {}) as Partial<McpIdentifyParams>;
    const { name } = resolveCallerName(ctx, params.name);
    const version = typeof params.version === 'string' ? params.version : ctx?.clientVersion;
    const identity = await store.upsertContact(name, version);
    const result: McpIdentifyResult = { ok: true, identity };
    return result;
  });

  // mcp.declarePermissions — record the capability set the plugin says it
  // needs. Parses against the wmuxPermissions grammar; rejects the whole
  // declaration if any entry is malformed so plugins can't half-declare
  // and accidentally exclude themselves from future enforcement.
  //
  // Returns the structured McpDeclarePermissionsResult union — RPC envelope
  // stays `ok: true` (the call itself succeeded) while application-level
  // outcome rides in `result.ok`. This lets plugins see per-entry rejection
  // detail (index + reason) without the wire envelope growing JSON-RPC
  // error-data support. Spec §4.2.
  router.register('mcp.declarePermissions', async (rawParams, ctx) => {
    const params = (rawParams ?? {}) as Partial<McpDeclarePermissionsParams>;
    const { name } = resolveCallerName(ctx, undefined);

    const list = parsePermissionList(params.permissions);
    if (list.errors.length > 0) {
      // Whole-declaration rejection: do NOT persist anything under `name`.
      // Plugins re-submit a corrected declaration; partial state would
      // confuse the future user-approval prompt.
      const rejection: McpDeclarePermissionsResult = {
        ok: false,
        errors: list.errors.map((e) => ({
          index: e.index,
          permission: e.permission,
          reason: e.reason,
        })),
      };
      return rejection;
    }

    // Echo capability strings the plugin sent, trimmed of leading/trailing
    // whitespace. We persist the trimmed form (not a fully canonical parse)
    // so future PRs can re-parse against an updated grammar without losing
    // the declaration. Trimming closes a widening false-positive: the
    // grammar parser already trims for validation (parsePermission line 88),
    // so storing the untrimmed wire form would make set-difference in
    // applyDeclaration treat `'pane.read '` and `'pane.read'` as distinct
    // capabilities and spuriously demote `trusted` plugins that reformat
    // their codegen templates between handshakes. `parsed` is used only to
    // confirm grammar acceptance; enforcement comes later.
    const accepted = Array.isArray(params.permissions)
      ? params.permissions
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.trim())
      : [];
    const rationale =
      typeof params.rationale === 'string' ? params.rationale : undefined;

    const identity = await store.upsertDeclaration(
      name,
      accepted,
      rationale,
      ctx?.clientVersion,
    );
    const result: McpDeclarePermissionsResult = {
      ok: true,
      identity,
      accepted,
    };
    return result;
  });
}
