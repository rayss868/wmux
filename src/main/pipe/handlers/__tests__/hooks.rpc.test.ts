import { describe, it, expect } from 'vitest';
import {
  resolvePtyIdForCwd,
  resolvePtyIdForSignal,
  findWorkspaceIdForPty,
} from '../hooks.rpc';
import type { AgentSignal } from '../../../../../integrations/shared/signal-types';

function signal(overrides: Partial<AgentSignal>): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: '/foo/bar',
    payload: {},
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

describe('resolvePtyIdForCwd', () => {
  it('exact cwd match returns activePtyId', () => {
    const got = resolvePtyIdForCwd('/foo/bar', [
      {
        id: 'w1',
        name: 'one',
        metadata: { cwd: '/foo/bar' },
        activePtyId: 'p1',
        ptyIds: ['p1', 'p2'],
      },
    ]);
    expect(got).toBe('p1');
  });

  it('prefix match returns longest-matching workspace ptyId', () => {
    const got = resolvePtyIdForCwd('/foo/bar/baz/qux', [
      { id: 'w1', name: 'short', metadata: { cwd: '/foo' }, activePtyId: 'p1', ptyIds: ['p1'] },
      { id: 'w2', name: 'long', metadata: { cwd: '/foo/bar' }, activePtyId: 'p2', ptyIds: ['p2'] },
      { id: 'w3', name: 'other', metadata: { cwd: '/other' }, activePtyId: 'p3', ptyIds: ['p3'] },
    ]);
    expect(got).toBe('p2'); // longest prefix wins
  });

  it('rejects non-directory prefix matches (no /foo/barber match for workspace /foo/bar)', () => {
    const got = resolvePtyIdForCwd('/foo/barber', [
      { id: 'w1', name: 'one', metadata: { cwd: '/foo/bar' }, activePtyId: 'p1', ptyIds: ['p1'] },
    ]);
    expect(got).toBeNull();
  });

  it('Windows-style paths normalize to forward slash, lowercase drive', () => {
    const got = resolvePtyIdForCwd('D:\\wmux\\src', [
      {
        id: 'w1',
        name: 'wmux',
        metadata: { cwd: 'd:/wmux' },
        activePtyId: 'p1',
        ptyIds: ['p1'],
      },
    ]);
    expect(got).toBe('p1');
  });

  it('no workspace owns the cwd → null', () => {
    const got = resolvePtyIdForCwd('/not/wmux', [
      { id: 'w1', name: 'one', metadata: { cwd: '/foo' }, activePtyId: 'p1', ptyIds: ['p1'] },
    ]);
    expect(got).toBeNull();
  });

  it('workspace with missing metadata.cwd is ignored', () => {
    const got = resolvePtyIdForCwd('/foo', [
      { id: 'w1', name: 'no-cwd', activePtyId: 'p1', ptyIds: ['p1'] },
      { id: 'w2', name: 'with-cwd', metadata: { cwd: '/foo' }, activePtyId: 'p2', ptyIds: ['p2'] },
    ]);
    expect(got).toBe('p2');
  });

  it('falls back to first ptyId when activePtyId missing', () => {
    const got = resolvePtyIdForCwd('/foo', [
      { id: 'w1', name: 'no-active', metadata: { cwd: '/foo' }, ptyIds: ['p1', 'p2'] },
    ]);
    expect(got).toBe('p1');
  });

  it('returns null when workspace has neither activePtyId nor ptyIds', () => {
    const got = resolvePtyIdForCwd('/foo', [
      { id: 'w1', name: 'empty', metadata: { cwd: '/foo' } },
    ]);
    expect(got).toBeNull();
  });

  it('rejects path-traversal escapes via canonicalization (codex P1 #8)', () => {
    // `/repo/../other` collapses to `/other` after canonicalization.
    // It must NOT match the workspace at `/repo`.
    const got = resolvePtyIdForCwd('/repo/../other', [
      { id: 'w1', name: 'repo', metadata: { cwd: '/repo' }, activePtyId: 'p1', ptyIds: ['p1'] },
      { id: 'w2', name: 'other', metadata: { cwd: '/other' }, activePtyId: 'p2', ptyIds: ['p2'] },
    ]);
    expect(got).toBe('p2');
  });

  it('collapses redundant ./ and // segments', () => {
    const got = resolvePtyIdForCwd('/repo/./src//foo', [
      { id: 'w1', name: 'repo', metadata: { cwd: '/repo' }, activePtyId: 'p1', ptyIds: ['p1'] },
    ]);
    expect(got).toBe('p1');
  });

  it('exact match short-circuits before prefix scan', () => {
    // If exact-match were not first, the prefix scan over '/foo' would
    // also produce a longest-prefix hit (length 4) on the second entry,
    // and we'd return that. Exact match must beat any prefix.
    const got = resolvePtyIdForCwd('/foo/bar', [
      { id: 'w1', name: 'prefix', metadata: { cwd: '/foo' }, activePtyId: 'p1', ptyIds: ['p1'] },
      { id: 'w2', name: 'exact', metadata: { cwd: '/foo/bar' }, activePtyId: 'p2', ptyIds: ['p2'] },
    ]);
    expect(got).toBe('p2');
  });
});

describe('resolvePtyIdForSignal — env-first routing (Codex P1 #7 fix)', () => {
  const workspaces = [
    { id: 'ws-2', name: 'Workspace 2', metadata: { cwd: '/repo' }, activePtyId: 'p2', ptyIds: ['p2'] },
    { id: 'ws-4', name: 'Workspace 4', metadata: { cwd: '/repo' }, activePtyId: 'p4', ptyIds: ['p4'] },
  ];

  it('workspaceId env match wins over cwd ambiguity (the bug user dogfood hit)', () => {
    // Both ws-2 and ws-4 have cwd '/repo' — pure cwd routing would
    // return p2 (first match). Env-first routes to ws-4 deterministically.
    const got = resolvePtyIdForSignal(signal({ workspaceId: 'ws-4', cwd: '/repo' }), workspaces);
    expect(got).toBe('p4');
  });

  it('workspaceId env match wins even when cwd would match a different workspace', () => {
    // ws-2 has cwd '/foo' but the signal env says ws-4. Env wins.
    const ws = [
      { id: 'ws-2', name: 'A', metadata: { cwd: '/foo' }, activePtyId: 'p2', ptyIds: ['p2'] },
      { id: 'ws-4', name: 'B', metadata: { cwd: '/bar' }, activePtyId: 'p4', ptyIds: ['p4'] },
    ];
    const got = resolvePtyIdForSignal(signal({ workspaceId: 'ws-4', cwd: '/foo' }), ws);
    expect(got).toBe('p4');
  });

  it('falls back to cwd when workspaceId is absent', () => {
    const got = resolvePtyIdForSignal(signal({ cwd: '/repo' }), workspaces);
    // No env → cwd exact match → first workspaces entry wins (ws-2's p2).
    expect(got).toBe('p2');
  });

  it('falls back to cwd when workspaceId references a closed workspace', () => {
    // Stale env (workspace closed). Recover via cwd matching.
    const got = resolvePtyIdForSignal(
      signal({ workspaceId: 'ws-deleted', cwd: '/repo' }),
      workspaces,
    );
    expect(got).toBe('p2');
  });

  it('returns null when env workspaceId stale AND cwd has no match', () => {
    const got = resolvePtyIdForSignal(
      signal({ workspaceId: 'ws-deleted', cwd: '/not-wmux' }),
      workspaces,
    );
    expect(got).toBeNull();
  });

  it('workspaceId matches but workspace has no ptyId → fall back to cwd', () => {
    const ws = [
      { id: 'ws-empty', name: 'empty', metadata: { cwd: '/elsewhere' } },
      { id: 'ws-with-cwd', name: 'with-cwd', metadata: { cwd: '/repo' }, activePtyId: 'pX', ptyIds: ['pX'] },
    ];
    const got = resolvePtyIdForSignal(
      signal({ workspaceId: 'ws-empty', cwd: '/repo' }),
      ws,
    );
    expect(got).toBe('pX');
  });
});

describe('resolvePtyIdForSignal — X6 ③ per-pane WMUX_PTY_ID routing', () => {
  // One workspace, TWO panes (split). cwd is shared. activePtyId is p-active.
  // Pre-fix, every hook collapsed to p-active; the non-active pane's binding
  // was clobbered. With ptyId routing each pane keeps its own attribution.
  const workspaces = [
    {
      id: 'ws-1',
      name: 'Split',
      metadata: { cwd: '/repo' },
      activePtyId: 'p-active',
      ptyIds: ['p-active', 'p-bg'],
    },
  ];

  it('exact ptyId wins over workspace activePtyId for a non-active split pane', () => {
    const got = resolvePtyIdForSignal(
      signal({ ptyId: 'p-bg', workspaceId: 'ws-1', cwd: '/repo' }),
      workspaces,
    );
    expect(got).toBe('p-bg'); // NOT p-active — the collapse is fixed
  });

  it('exact ptyId also pins the active pane (no regression)', () => {
    const got = resolvePtyIdForSignal(
      signal({ ptyId: 'p-active', workspaceId: 'ws-1', cwd: '/repo' }),
      workspaces,
    );
    expect(got).toBe('p-active');
  });

  it('a stale/unknown ptyId is NOT trusted — falls back to workspaceId routing', () => {
    const got = resolvePtyIdForSignal(
      signal({ ptyId: 'p-closed', workspaceId: 'ws-1', cwd: '/repo' }),
      workspaces,
    );
    expect(got).toBe('p-active'); // unknown id ignored, workspace fallback wins
  });

  it('a stale ptyId with no other signal falls through to cwd', () => {
    const got = resolvePtyIdForSignal(
      signal({ ptyId: 'p-gone', cwd: '/repo' }),
      workspaces,
    );
    expect(got).toBe('p-active'); // cwd exact match → workspace's activePtyId
  });

  it('a live ptyId is NOT trusted when it belongs to a DIFFERENT claimed workspace (anti-spoof)', () => {
    // p-bg is a real live pane in ws-1, but the hook claims ws-evil. A pane-env
    // -controlled WMUX_PTY_ID must not let an authenticated hook hijack another
    // workspace's pane — the workspace cross-check rejects it and routing falls
    // back to the (unknown) workspaceId → cwd.
    const got = resolvePtyIdForSignal(
      signal({ ptyId: 'p-bg', workspaceId: 'ws-evil', cwd: '/repo' }),
      workspaces,
    );
    expect(got).toBe('p-active'); // NOT p-bg — the spoofed cross-workspace target
  });
});

describe('isAgentSignal (re-export check)', () => {
  // Smoke-imported separately to keep this file focused; full validation
  // tests live next to signal-types.ts spec if needed. Here we just make
  // sure the public API surface is exported.
  it('module exports resolvePtyIdForCwd', () => {
    expect(typeof resolvePtyIdForCwd).toBe('function');
  });
});

describe('findWorkspaceIdForPty', () => {
  const workspaces = [
    { id: 'ws-a', name: 'A', activePtyId: 'p1', ptyIds: ['p1', 'p2'] },
    { id: 'ws-b', name: 'B', activePtyId: 'p3', ptyIds: ['p3'] },
    { id: 'ws-c', name: 'C', metadata: { cwd: '/x' } }, // no ptyIds
  ];

  it('finds workspace by activePtyId', () => {
    expect(findWorkspaceIdForPty('p1', workspaces)).toBe('ws-a');
    expect(findWorkspaceIdForPty('p3', workspaces)).toBe('ws-b');
  });

  it('finds workspace by non-active ptyIds entry', () => {
    expect(findWorkspaceIdForPty('p2', workspaces)).toBe('ws-a');
  });

  it('returns null for unknown ptyId (race: pane closed between resolve and emit)', () => {
    expect(findWorkspaceIdForPty('p-missing', workspaces)).toBeNull();
  });

  it('returns null when no workspaces have ptyIds', () => {
    expect(findWorkspaceIdForPty('p1', [{ id: 'w', name: 'empty' }])).toBeNull();
  });

  it('returns null for empty workspace list', () => {
    expect(findWorkspaceIdForPty('p1', [])).toBeNull();
  });
});
