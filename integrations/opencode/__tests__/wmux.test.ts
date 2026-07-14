import { describe, it, expect } from 'vitest';
// The plugin is plain .js (OpenCode loads it directly); it exports the pure
// envelope builder alongside the plugin so this test can validate the shape
// without a live opencode process.
import { buildOpencodeStopEnvelope, buildOpencodeEnvelope, isChildSession } from '../plugins/wmux.js';
import { isAgentSignal } from '../../shared/signal-types';

describe('buildOpencodeStopEnvelope', () => {
  const baseEnv = {
    WMUX_PTY_ID: 'pty-123',
    WMUX_WORKSPACE_ID: 'ws-abc',
    WMUX_SURFACE_ID: 'surf-9',
  } as NodeJS.ProcessEnv;

  it('builds a canonical agent.stop / opencode envelope from the pane env', () => {
    const env = buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/proj', now: 42 });
    expect(env).toMatchObject({
      kind: 'agent.stop',
      agent: 'opencode',
      ptyId: 'pty-123',
      workspaceId: 'ws-abc',
      surfaceId: 'surf-9',
      cwd: '/proj',
      payload: {},
      ts: 42,
    });
  });

  it('produces an envelope the wmux daemon accepts (isAgentSignal)', () => {
    const env = buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/proj', sessionId: 's1', now: 1 });
    expect(isAgentSignal(env)).toBe(true);
  });

  it('carries agentSessionId only when a session id is given', () => {
    expect(buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/p', now: 1 }).agentSessionId).toBeUndefined();
    expect(
      buildOpencodeStopEnvelope({ env: baseEnv, cwd: '/p', sessionId: 'sess-7', now: 1 }).agentSessionId,
    ).toBe('sess-7');
  });

  it('omits routing fields absent from the env (never sends empty strings)', () => {
    const env = buildOpencodeStopEnvelope({ env: {} as NodeJS.ProcessEnv, cwd: '/p', now: 1 });
    expect(env.ptyId).toBeUndefined();
    expect(env.workspaceId).toBeUndefined();
    expect(env.surfaceId).toBeUndefined();
    // Still a valid envelope — cwd + ts + payload carry it (cwd-fallback routing).
    expect(isAgentSignal(env)).toBe(true);
  });

  it('falls back to process.cwd() when no cwd is supplied', () => {
    const env = buildOpencodeStopEnvelope({ env: baseEnv, now: 1 });
    expect(env.cwd).toBe(process.cwd());
    expect(env.cwd.length).toBeGreaterThan(0);
  });
});

describe('buildOpencodeEnvelope — awaiting_input (permission approval)', () => {
  const baseEnv = { WMUX_PTY_ID: 'pty-1', WMUX_WORKSPACE_ID: 'ws-1' } as NodeJS.ProcessEnv;

  it('builds a valid agent.awaiting_input envelope carrying the approval title', () => {
    const env = buildOpencodeEnvelope('agent.awaiting_input', {
      env: baseEnv,
      cwd: '/p',
      sessionId: 's1',
      payload: { title: 'Run `rm -rf build`?' },
      now: 5,
    });
    expect(env.kind).toBe('agent.awaiting_input');
    expect(env.agent).toBe('opencode');
    expect(env.ptyId).toBe('pty-1');
    expect(env.payload).toEqual({ title: 'Run `rm -rf build`?' });
    expect(isAgentSignal(env)).toBe(true);
  });

  it('coerces a non-object payload to {}', () => {
    const env = buildOpencodeEnvelope('agent.stop', { env: baseEnv, cwd: '/p', payload: 'nope' as unknown as object, now: 1 });
    expect(env.payload).toEqual({});
    expect(isAgentSignal(env)).toBe(true);
  });
});

describe('isChildSession — sub-agent suppression', () => {
  const clientReturning = (session: unknown) => ({
    session: { get: async () => ({ data: session }) },
  });

  it('treats a session with a parentID as a child (suppress)', async () => {
    const client = clientReturning({ id: 's1', parentID: 'root-0' });
    expect(await isChildSession(client, 's1')).toBe(true);
  });

  it('treats a session with no parentID as root (emit)', async () => {
    const client = clientReturning({ id: 's1' });
    expect(await isChildSession(client, 's1')).toBe(false);
  });

  it('accepts a client that returns the session directly (no {data} wrapper)', async () => {
    const client = { session: { get: async () => ({ id: 's1', parentID: 'r' }) } };
    expect(await isChildSession(client, 's1')).toBe(true);
  });

  it('fails OPEN (root/emit) when the lookup throws', async () => {
    const client = { session: { get: async () => { throw new Error('offline'); } } };
    expect(await isChildSession(client, 's1')).toBe(false);
  });

  it('fails OPEN when no client or no session id is available', async () => {
    expect(await isChildSession(undefined, 's1')).toBe(false);
    expect(await isChildSession({ session: { get: async () => ({}) } }, undefined)).toBe(false);
  });
});
