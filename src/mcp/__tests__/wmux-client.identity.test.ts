// Identity-envelope round-trip for the MCP-side wmux-client wrapper.
//
// Verifies that:
//   1. `setClientIdentity` populates the module-scoped name/version.
//   2. `clearClientIdentity` resets them to undefined — so post-close RPCs
//      stamp an envelope-less request and substrate records them as legacy.
//   3. Whitespace-only inputs are treated as empty (no envelope stamping).
//
// We assert on `getClientIdentity` rather than spying on the wire because
// `attemptRpc` opens a real socket; the in-process getter mirrors the same
// module state that `attemptRpc` reads when building the envelope.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearClientIdentity,
  getClientIdentity,
  setClientIdentity,
} from '../wmux-client';

describe('wmux-client declared identity', () => {
  beforeEach(() => {
    clearClientIdentity();
  });

  it('round-trips name and version through setClientIdentity', () => {
    setClientIdentity('claude-ai', '1.0.94');
    expect(getClientIdentity()).toEqual({ name: 'claude-ai', version: '1.0.94' });
  });

  it('clearClientIdentity wipes both fields back to undefined', () => {
    setClientIdentity('claude-ai', '1.0.94');
    clearClientIdentity();
    expect(getClientIdentity()).toEqual({ name: undefined, version: undefined });
  });

  it('treats whitespace-only strings as empty', () => {
    // Defensive against an MCP host that ships clientInfo with padding —
    // an envelope with `clientName: "   "` is worse than no envelope at
    // all because it bypasses the legacy audit path on the wmux side.
    setClientIdentity('   ', '\t\n');
    expect(getClientIdentity()).toEqual({ name: undefined, version: undefined });
  });

  it('clearClientIdentity is idempotent', () => {
    clearClientIdentity();
    clearClientIdentity();
    expect(getClientIdentity()).toEqual({ name: undefined, version: undefined });
  });
});
