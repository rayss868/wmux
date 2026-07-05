import { describe, it, expect } from 'vitest';
import { formatChannelAuthor, rosterMemberLabel, workspaceHue } from '../authorDisplay';

// Fixtures mirror the live ~/.wmux/channels.json shapes the identity audit
// documented: agents posting as "Claude Code", naming drift ("w16-1" vs
// "w16-1(claude)"), and legacy human rows with a null memberName.
const WS = 'ws-72ca48f2-5786-4c50-830c-154ac039c72f';
const OTHER_WS = 'ws-0483577a-2a09-43c8-8618-c6501ef48888';
const noWs = () => undefined;

describe('formatChannelAuthor (identity audit 1a)', () => {
  it('agent with a product display name keeps the pane memberId as a chip', () => {
    const a = formatChannelAuthor(
      { workspaceId: WS, memberId: 'w26-1(claude)', memberName: 'Claude Code' },
      noWs,
    );
    expect(a).toMatchObject({ kind: 'agent', primary: 'Claude Code', chip: 'w26-1(claude)' });
  });

  it('skips the chip when the primary already carries the memberId', () => {
    expect(
      formatChannelAuthor(
        { workspaceId: WS, memberId: 'w18-1(claude)', memberName: 'w18-1(claude)' },
        noWs,
      ).chip,
    ).toBeNull();
    // Live naming drift: memberName "w16-1(claude)" vs memberId "w16-1".
    expect(
      formatChannelAuthor({ workspaceId: WS, memberId: 'w16-1', memberName: 'w16-1(claude)' }, noWs)
        .chip,
    ).toBeNull();
  });

  it('falls back to memberId when memberName is null/empty', () => {
    const a = formatChannelAuthor({ workspaceId: WS, memberId: 'w9-2(codex)', memberName: null }, noWs);
    expect(a.primary).toBe('w9-2(codex)');
    expect(a.chip).toBeNull();
  });

  it('human seat: kind=human with the workspace name as the chip', () => {
    const a = formatChannelAuthor(
      { workspaceId: WS, memberId: 'local-ui', memberName: 'local-ui' },
      () => 'Workspace 2',
    );
    expect(a).toMatchObject({ kind: 'human', primary: '', chip: 'Workspace 2' });
  });

  it('human seat with a null memberName still renders (regression: blank author line)', () => {
    const a = formatChannelAuthor({ workspaceId: WS, memberId: 'local-ui', memberName: null }, noWs);
    expect(a.kind).toBe('human');
    expect(a.chip).toBe('ws-72ca48f2…');
  });

  it('hue is stable per workspace, in range, and differs across these fixtures', () => {
    expect(workspaceHue(WS)).toBe(workspaceHue(WS));
    expect(workspaceHue(WS)).toBeGreaterThanOrEqual(0);
    expect(workspaceHue(WS)).toBeLessThan(360);
    expect(workspaceHue(WS)).not.toBe(workspaceHue(OTHER_WS));
  });
});

describe('rosterMemberLabel (identity audit C-A3)', () => {
  const SELF_WS = 'ws-self';
  const UI = 'local-ui';

  it("labels only the viewer's own row as Me — with NO workspace suffix (P5: one human seat)", () => {
    const own = rosterMemberLabel({ workspaceId: SELF_WS, memberId: UI }, SELF_WS, UI, 'Workspace 1');
    expect(own).toEqual({ primary: '', showWorkspaceSuffix: false });
  });

  it("labels another workspace's human seat with its workspace name, no duplicate suffix", () => {
    const other = rosterMemberLabel({ workspaceId: 'ws-other', memberId: UI }, SELF_WS, UI, 'Workspace 2');
    expect(other).toEqual({ primary: 'Workspace 2', showWorkspaceSuffix: false });
  });

  it('labels agent rows by memberId with the workspace suffix', () => {
    const agent = rosterMemberLabel(
      { workspaceId: 'ws-other', memberId: 'w26-1(claude)' },
      SELF_WS,
      UI,
      'Workspace 2',
    );
    expect(agent).toEqual({ primary: 'w26-1(claude)', showWorkspaceSuffix: true });
  });
});

describe('formatChannelAuthor — untrusted memberName (ship review pin)', () => {
  it("an agent naming itself 'local-ui' still renders as an AGENT", () => {
    const a = formatChannelAuthor(
      { workspaceId: WS, memberId: 'w1-1(codex)', memberName: 'local-ui' },
      noWs,
    );
    expect(a.kind).toBe('agent');
    expect(a.chip).toBe('w1-1(codex)');
  });
});

describe('formatChannelAuthor — P5 unified human seat', () => {
  it('a post from ws-human renders as plain "Me" with NO chip (one human, no ambiguity)', () => {
    const a = formatChannelAuthor(
      { workspaceId: 'ws-human', memberId: 'local-ui', memberName: 'local-ui' },
      noWs,
    );
    expect(a).toMatchObject({ kind: 'human', primary: '', chip: null });
  });

  it('a PRE-P5 human post (real workspace id) keeps its workspace chip as history', () => {
    const a = formatChannelAuthor(
      { workspaceId: WS, memberId: 'local-ui', memberName: 'local-ui' },
      () => 'Workspace 2',
    );
    expect(a.chip).toBe('Workspace 2');
  });
});
