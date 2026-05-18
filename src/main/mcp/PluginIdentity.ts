// Helpers for constructing per-connection plugin identities. The domain
// record type lives in src/shared/rpc.ts (PluginIdentityRecord) so it can
// also be consumed by clients reading the trust DB shape. This module
// keeps the construction/transition logic.

import type { PluginIdentityRecord, PluginTrustStatus } from '../../shared/rpc';

const UNKNOWN_PLUGIN_NAME = 'unknown';

function now(): number {
  return Date.now();
}

function sanitizeName(name: string | undefined | null): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed.length > 0 ? trimmed : UNKNOWN_PLUGIN_NAME;
}

function sanitizeVersion(version: string | undefined | null): string | undefined {
  if (typeof version !== 'string') return undefined;
  const trimmed = version.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Forward-compat guard: a record loaded from a future schema version
// (or a hand-edited file) may carry a status outside our union. Treat
// anything we don't recognise as `unconfirmed` so the trust-status
// invariant below ('trusted'/'denied' never regress) can't be subverted
// by writing `status: "anything-else"` to disk.
function knownStatus(s: unknown): s is PluginTrustStatus {
  return s === 'unconfirmed' || s === 'trusted' || s === 'denied' || s === 'legacy';
}

function currentStatusOf(record: PluginIdentityRecord): PluginTrustStatus {
  return knownStatus(record.status) ? record.status : 'unconfirmed';
}

// Fresh identity created on first contact via `mcp.identify`. Recorded with
// status='unconfirmed' so a future user-approval PR can promote to trusted
// or denied without re-introducing the record.
export function unconfirmedIdentity(
  rawName: string | undefined,
  rawVersion?: string,
): PluginIdentityRecord {
  const t = now();
  return {
    name: sanitizeName(rawName),
    version: sanitizeVersion(rawVersion),
    status: 'unconfirmed',
    firstSeen: t,
    lastSeen: t,
  };
}

// Identity inferred when an RPC arrives without a clientName envelope —
// pre-v2.10 callers or non-MCP clients. Recorded so future enforcement
// can grandfather them and surface in audit logs.
export function legacyIdentity(rawName?: string): PluginIdentityRecord {
  const t = now();
  return {
    name: sanitizeName(rawName),
    status: 'legacy',
    firstSeen: t,
    lastSeen: t,
  };
}

// Apply a fresh contact to an existing record. Used by `mcp.identify` when
// the plugin reconnects: lastSeen advances, version refreshes, but the
// user-issued trust status (trusted/denied) must NOT be overwritten — only
// `legacy` is allowed to upgrade to `unconfirmed`.
export function applyContact(
  existing: PluginIdentityRecord,
  rawVersion: string | undefined,
): PluginIdentityRecord {
  const cur = currentStatusOf(existing);
  const nextStatus: PluginTrustStatus = cur === 'legacy' ? 'unconfirmed' : cur;
  return {
    ...existing,
    version: sanitizeVersion(rawVersion) ?? existing.version,
    status: nextStatus,
    lastSeen: now(),
  };
}

// True when `next` contains at least one capability string that was not in
// `prev`. A null/empty `prev` with non-empty `next` is also widening — a
// `trusted` record without a stored declaration is anomalous (hand edit or
// corrupt write), so we err on the side of demoting and forcing re-approval
// rather than letting the declaration ride on inherited trust.
function isWidenedDeclaration(
  prev: readonly string[] | undefined,
  next: readonly string[],
): boolean {
  if (!prev || prev.length === 0) return next.length > 0;
  const prevSet = new Set(prev);
  for (const cap of next) {
    if (!prevSet.has(cap)) return true;
  }
  return false;
}

// Apply a permission declaration. Trust-status invariant: 'denied' never
// regresses. 'legacy' upgrades to 'unconfirmed'. 'trusted' is preserved as
// long as the new declaration is a subset of the previously approved
// capability set — any widening (a new capability string the user has not
// approved) demotes back to 'unconfirmed' so the user re-approves. Same
// rule applies if the prior declaration was missing entirely. Spec
// §2.3 / §4.3 codify this transition.
export function applyDeclaration(
  existing: PluginIdentityRecord,
  capabilities: string[],
  rationale?: string,
): PluginIdentityRecord {
  const cur = currentStatusOf(existing);
  let nextStatus: PluginTrustStatus;
  if (cur === 'legacy') {
    nextStatus = 'unconfirmed';
  } else if (cur === 'trusted' && isWidenedDeclaration(existing.declaredCapabilities, capabilities)) {
    nextStatus = 'unconfirmed';
  } else {
    nextStatus = cur;
  }
  return {
    ...existing,
    declaredCapabilities: [...capabilities],
    rationale: typeof rationale === 'string' ? rationale.trim() || undefined : undefined,
    status: nextStatus,
    lastSeen: now(),
  };
}
