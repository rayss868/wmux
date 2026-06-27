// ─── Tests for channel mention → a2a inbox routing (#7 + agent-pane redesign) ──
//
// Pure-function tests: routeChannelMentionToInbox takes injected deps + the self
// workspace's live leaves, so we drive it with spies and assert the task shape +
// pointer emit + idempotency + pane-level (fail-closed) routing without a store.

import { describe, it, expect } from 'vitest';
import {
  routeChannelMentionToInbox,
  channelMentionTaskId,
  type MentionInboxDeps,
} from '../channelMentionInbox';
import type { ChannelMessage } from '../../../shared/channels';
import type { Task, PaneLeaf, Surface } from '../../../shared/types';

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
}
function leaf(id: string, surfaces: Surface[]): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channelId: 'ch-1',
    seq: 5,
    workspaceId: 'ws-sender',
    memberId: 'm-1',
    memberName: 'Alice',
    text: 'hey @me check this',
    postedAt: 1_700_000_000_000,
    deliveryStatus: 'pending',
    mentions: [{ workspaceId: 'ws-me', name: 'me' }],
    ...overrides,
  };
}

type CreatedTask = Parameters<MentionInboxDeps['createA2aTask']>[0];
interface Published {
  from: string;
  to: string;
  taskId: string;
  state: string;
  kind: string;
}

function makeDeps(overrides: Partial<MentionInboxDeps> = {}): {
  deps: MentionInboxDeps;
  created: CreatedTask[];
  published: Published[];
} {
  const created: CreatedTask[] = [];
  const published: Published[] = [];
  const deps: MentionInboxDeps = {
    getTask: () => undefined,
    createA2aTask: (t) => {
      created.push(t);
      return t.id ?? 'task-x';
    },
    channelName: (id) => (id === 'ch-1' ? 'general' : id),
    workspaceName: (id) => (id === 'ws-me' ? 'My WS' : id),
    publish: (from, to, taskId, state, kind) => {
      published.push({ from, to, taskId, state, kind });
    },
    ...overrides,
  };
  return { deps, created, published };
}

describe('channelMentionTaskId', () => {
  it('is deterministic and per-target', () => {
    expect(channelMentionTaskId('ch-9', 42)).toBe('chmention-ch-9-42');
    expect(channelMentionTaskId('ch-9', 42, 'pane-7')).toBe('chmention-ch-9-42-pane-7');
  });
});

describe('routeChannelMentionToInbox', () => {
  it('creates nothing when the message does not mention self', () => {
    const { deps, created, published } = makeDeps();
    const out = routeChannelMentionToInbox(
      makeMessage({ mentions: [{ workspaceId: 'ws-other', name: 'other' }] }),
      'ws-me',
      [],
      deps,
    );
    expect(out).toEqual([]);
    expect(created).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('creates nothing when the message carries no mentions at all', () => {
    const { deps, created } = makeDeps();
    const out = routeChannelMentionToInbox(makeMessage({ mentions: undefined }), 'ws-me', [], deps);
    expect(out).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it('mints a ws-level a2a task + emits the pointer on a self-mention with no paneId', () => {
    const { deps, created, published } = makeDeps();
    const out = routeChannelMentionToInbox(makeMessage(), 'ws-me', [], deps);

    expect(out).toEqual([channelMentionTaskId('ch-1', 5)]);
    expect(created).toHaveLength(1);
    const t = created[0];
    expect(t.id).toBe('chmention-ch-1-5');
    expect(t.from).toEqual({ workspaceId: 'ws-sender', name: 'Alice' });
    expect(t.to).toEqual({ workspaceId: 'ws-me', name: 'My WS' }); // ws-level, no paneId
    expect(t.title).toContain('general');
    expect(t.history).toHaveLength(1);
    expect(t.history[0].role).toBe('user');
    expect(t.history[0].parts[0]).toEqual({ kind: 'text', text: 'hey @me check this' });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      from: 'ws-sender',
      to: 'ws-me',
      taskId: 'chmention-ch-1-5',
      state: 'submitted',
      kind: 'created',
    });
  });

  it('pins to.paneId when the mention resolves to a live pane (ptyId snapshot matches)', () => {
    const { deps, created, published } = makeDeps();
    const leaves = [leaf('pane-A', [surface('surf-A', 'pty-A')])];
    const out = routeChannelMentionToInbox(
      makeMessage({ mentions: [{ workspaceId: 'ws-me', paneId: 'pane-A', ptyId: 'pty-A', name: 'claude' }] }),
      'ws-me',
      leaves,
      deps,
    );
    expect(out).toEqual([channelMentionTaskId('ch-1', 5, 'pane-A')]);
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe('chmention-ch-1-5-pane-A');
    expect(created[0].to).toEqual({
      workspaceId: 'ws-me',
      name: 'My WS',
      paneId: 'pane-A',
      surfaceId: 'surf-A',
    });
    expect(published[0].taskId).toBe('chmention-ch-1-5-pane-A');
  });

  it('falls back to a ws-level task when the pinned pane is gone (no wrong-pane delivery)', () => {
    const { deps, created } = makeDeps();
    const leaves = [leaf('pane-OTHER', [surface('surf-O', 'pty-O')])]; // pane-A absent
    const out = routeChannelMentionToInbox(
      makeMessage({ mentions: [{ workspaceId: 'ws-me', paneId: 'pane-A', ptyId: 'pty-A', name: 'claude' }] }),
      'ws-me',
      leaves,
      deps,
    );
    expect(out).toEqual([channelMentionTaskId('ch-1', 5)]); // ws-level fallback
    expect(created[0].to).toEqual({ workspaceId: 'ws-me', name: 'My WS' }); // no paneId
  });

  it('falls back to ws-level when the pane exists but ptyId changed (agent restarted → successor)', () => {
    const { deps, created } = makeDeps();
    const leaves = [leaf('pane-A', [surface('surf-A', 'pty-NEW')])]; // pane-A alive but a different pty
    const out = routeChannelMentionToInbox(
      makeMessage({ mentions: [{ workspaceId: 'ws-me', paneId: 'pane-A', ptyId: 'pty-OLD', name: 'claude' }] }),
      'ws-me',
      leaves,
      deps,
    );
    // Fail-closed: ptyId mismatch means a DIFFERENT agent now holds pane-A — do
    // NOT pin to.paneId (would deliver to the successor); fall back to ws-level.
    expect(out).toEqual([channelMentionTaskId('ch-1', 5)]);
    expect(created[0].to).toEqual({ workspaceId: 'ws-me', name: 'My WS' });
  });

  it('mints one task per distinct pane when several panes in self are mentioned (split)', () => {
    const { deps, created } = makeDeps();
    const leaves = [
      leaf('pane-A', [surface('surf-A', 'pty-A')]),
      leaf('pane-B', [surface('surf-B', 'pty-B')]),
    ];
    const out = routeChannelMentionToInbox(
      makeMessage({
        mentions: [
          { workspaceId: 'ws-me', paneId: 'pane-A', ptyId: 'pty-A', name: 'claude' },
          { workspaceId: 'ws-me', paneId: 'pane-B', ptyId: 'pty-B', name: 'codex' },
        ],
      }),
      'ws-me',
      leaves,
      deps,
    );
    expect(out).toEqual([
      channelMentionTaskId('ch-1', 5, 'pane-A'),
      channelMentionTaskId('ch-1', 5, 'pane-B'),
    ]);
    expect(created).toHaveLength(2);
    expect(created.map((t) => t.to.paneId)).toEqual(['pane-A', 'pane-B']);
  });

  it('does not ping yourself when you authored the post', () => {
    const { deps, created, published } = makeDeps();
    const out = routeChannelMentionToInbox(
      makeMessage({ workspaceId: 'ws-me', mentions: [{ workspaceId: 'ws-me', name: 'me' }] }),
      'ws-me',
      [],
      deps,
    );
    expect(out).toEqual([]);
    expect(created).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('is idempotent — a re-delivered event does not double-create', () => {
    const existing = { kind: 'task', id: 'chmention-ch-1-5' } as Task;
    const { deps, created, published } = makeDeps({
      getTask: (id) => (id === 'chmention-ch-1-5' ? existing : undefined),
    });
    const out = routeChannelMentionToInbox(makeMessage(), 'ws-me', [], deps);
    expect(out).toEqual([]);
    expect(created).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('does not throw when createA2aTask fails — never breaks dispatch', () => {
    const { deps, published } = makeDeps({
      createA2aTask: () => {
        throw new Error('boom');
      },
    });
    const out = routeChannelMentionToInbox(makeMessage(), 'ws-me', [], deps);
    expect(out).toEqual([]);
    expect(published).toHaveLength(0);
  });
});
