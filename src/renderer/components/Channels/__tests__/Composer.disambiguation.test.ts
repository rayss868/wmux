import { describe, it, expect } from 'vitest';
import { buildMentionCandidates } from '../Composer';
import { createLeafPane, createSurface, type Pane, type Workspace } from '../../../../shared/types';

// The P2 goal in one fixture: ONE workspace hosting TWO panes, each running
// "claude". Pre-P2 the composer offered two identical "@claude" candidates with
// the same workspace-name hint — indistinguishable. P2 names them by coordinate.
function twoClaudeWorkspace() {
  const ptyA = 'ptyA';
  const ptyB = 'ptyB';
  const leafA = createLeafPane(createSurface(ptyA, 'pwsh', ''), 1);
  const leafB = createLeafPane(createSurface(ptyB, 'pwsh', ''), 2);
  const root: Pane = {
    id: 'br', type: 'branch', direction: 'horizontal', children: [leafA, leafB], sizes: [50, 50],
  };
  const ws: Workspace = {
    id: 'ws-1', name: 'Backend', wsOrdinal: 1, nextPaneOrdinal: 3, rootPane: root, activePaneId: leafA.id,
  };
  return { ws, leafA, leafB, ptyA, ptyB };
}

const CLAUDE = { name: 'Claude Code', slug: 'claude' as const };

describe('buildMentionCandidates — same-ws same-agent disambiguation (P2)', () => {
  it('gives two same-ws "claude" panes DISTINCT unique @tokens', () => {
    const { ws, ptyA, ptyB } = twoClaudeWorkspace();
    const candidates = buildMentionCandidates({
      workspaces: [ws],
      surfaceAgent: { [ptyA]: CLAUDE, [ptyB]: CLAUDE },
      paneLabel: {},
      memberWorkspaceIds: new Set(['ws-1']),
      selfWorkspaceId: 'ws-other',
    });
    expect(candidates).toHaveLength(2);
    const tokens = candidates.map((c) => c.insertToken).sort();
    expect(tokens).toEqual(['w1-1(claude)', 'w1-2(claude)']);
    // The core invariant: zero collision → @-mention resolves to exactly one pane.
    expect(new Set(tokens).size).toBe(2);
  });

  it('a rename changes displayName but keeps the unique insertToken', () => {
    const { ws, leafB, ptyA, ptyB } = twoClaudeWorkspace();
    const candidates = buildMentionCandidates({
      workspaces: [ws],
      surfaceAgent: { [ptyA]: CLAUDE, [ptyB]: CLAUDE },
      paneLabel: { [leafB.id]: 'API Server' },
      memberWorkspaceIds: new Set(['ws-1']),
      selfWorkspaceId: 'ws-other',
    });
    const b = candidates.find((c) => c.paneId === leafB.id)!;
    expect(b.displayName).toBe('API Server'); // dropdown shows the rename
    expect(b.insertToken).toBe('w1-2(claude)'); // token stays stable + unique
  });

  it('excludes our own workspace, non-member workspaces, and non-agent panes', () => {
    const { ws, ptyA, ptyB } = twoClaudeWorkspace();
    // Our own workspace → excluded entirely.
    expect(buildMentionCandidates({
      workspaces: [ws], surfaceAgent: { [ptyA]: CLAUDE, [ptyB]: CLAUDE },
      paneLabel: {}, memberWorkspaceIds: new Set(['ws-1']), selfWorkspaceId: 'ws-1',
    })).toHaveLength(0);
    // Non-member workspace → excluded.
    expect(buildMentionCandidates({
      workspaces: [ws], surfaceAgent: { [ptyA]: CLAUDE, [ptyB]: CLAUDE },
      paneLabel: {}, memberWorkspaceIds: new Set(), selfWorkspaceId: 'ws-other',
    })).toHaveLength(0);
    // Only ptyA has a detected agent → the plain-terminal pane (ptyB) drops out.
    expect(buildMentionCandidates({
      workspaces: [ws], surfaceAgent: { [ptyA]: CLAUDE },
      paneLabel: {}, memberWorkspaceIds: new Set(['ws-1']), selfWorkspaceId: 'ws-other',
    })).toHaveLength(1);
  });

  // review-team (Codex): a single pane with multiple agent surfaces (tabs) must
  // not emit duplicate candidates with a colliding insertToken — one candidate
  // per pane, using the active (or first) agent surface.
  it('emits ONE candidate per pane even when the pane has multiple agent surfaces', () => {
    const ptyA = 'ptyA';
    const ptyB = 'ptyB';
    const leaf = createLeafPane(createSurface(ptyA, 'pwsh', ''), 1);
    leaf.surfaces.push(createSurface(ptyB, 'pwsh', '')); // second tab, same pane
    const ws: Workspace = {
      id: 'ws-1', name: 'W', wsOrdinal: 1, nextPaneOrdinal: 2, rootPane: leaf, activePaneId: leaf.id,
    };
    const candidates = buildMentionCandidates({
      workspaces: [ws],
      surfaceAgent: { [ptyA]: CLAUDE, [ptyB]: CLAUDE },
      paneLabel: {},
      memberWorkspaceIds: new Set(['ws-1']),
      selfWorkspaceId: 'ws-other',
    });
    expect(candidates).toHaveLength(1); // not 2
    expect(candidates[0].insertToken).toBe('w1-1(claude)'); // unique, no collision
    expect(candidates[0].ptyId).toBe(ptyA); // the active surface
  });
});
