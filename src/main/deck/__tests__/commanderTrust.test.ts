// Unit tests for the commander trust registry (P3b codex P1, M1.5 ws-binding).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mintCommanderToken,
  revokeCommanderToken,
  isCommanderToken,
  commanderTokenWorkspace,
  __resetCommanderTrustForTesting,
} from '../commanderTrust';

describe('commanderTrust', () => {
  beforeEach(() => __resetCommanderTrustForTesting());

  it('a minted token verifies and carries its workspace; revocation kills it', () => {
    const token = mintCommanderToken('ws-1');
    expect(token.length).toBeGreaterThanOrEqual(64);
    expect(isCommanderToken(token)).toBe(true);
    expect(commanderTokenWorkspace(token)).toBe('ws-1');
    revokeCommanderToken(token);
    expect(isCommanderToken(token)).toBe(false);
    expect(commanderTokenWorkspace(token)).toBeNull();
  });

  it('rejects non-strings, empty strings, and unknown tokens', () => {
    mintCommanderToken('ws-1');
    expect(isCommanderToken(undefined)).toBe(false);
    expect(isCommanderToken(null)).toBe(false);
    expect(isCommanderToken('')).toBe(false);
    expect(isCommanderToken('not-a-real-token')).toBe(false);
    expect(isCommanderToken(42)).toBe(false);
    expect(commanderTokenWorkspace(undefined)).toBeNull();
    expect(commanderTokenWorkspace('not-a-real-token')).toBeNull();
  });

  it('tokens are independent — revoking one leaves the other live', () => {
    const a = mintCommanderToken('ws-a');
    const b = mintCommanderToken('ws-b');
    expect(a).not.toBe(b);
    revokeCommanderToken(a);
    expect(isCommanderToken(a)).toBe(false);
    expect(isCommanderToken(b)).toBe(true);
    expect(commanderTokenWorkspace(b)).toBe('ws-b');
  });

  it('an empty workspace binding registers but never resolves (fail closed)', () => {
    const token = mintCommanderToken('');
    expect(isCommanderToken(token)).toBe(true);
    expect(commanderTokenWorkspace(token)).toBeNull();
  });
});
