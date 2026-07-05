// ─── Tests for promoteTypedMentions (P2e) ───────────────────────────────
//
// Audit C-C1/C-C2: a hand-typed @token that was never dropdown-selected was
// silently sent as plain text — no mention fired, no warning. promoteTypedMentions
// is the pure submit-time scanner that fixes this: it promotes typed @tokens that
// exactly match a candidate's insert token (longest-match-first), dedups against
// dropdown picks, and reports the @runs that matched nobody so the UI can warn.
//
// Pure + exported (repo precedent: planChannelMessageDelivery / buildMentionCandidates)
// so the invariant is unit-tested without driving the packaged Electron UI.

import { describe, it, expect } from 'vitest';
import { promoteTypedMentions, type MentionCandidate } from '../Composer';
import type { ChannelMention } from '../../../../shared/channels';

/** Build a candidate whose ids derive from the insert token (distinct panes get
 *  distinct ids) unless overridden. */
function cand(insertToken: string, over: Partial<MentionCandidate> = {}): MentionCandidate {
  return {
    workspaceId: over.workspaceId ?? `ws-${insertToken}`,
    paneId: over.paneId ?? `pane-${insertToken}`,
    ptyId: over.ptyId ?? `pty-${insertToken}`,
    insertToken,
    displayName: over.displayName ?? insertToken,
  };
}

describe('promoteTypedMentions', () => {
  it('promotes a hand-typed exact @token that was never dropdown-selected', () => {
    const c = cand('w1-2(claude)', { workspaceId: 'ws-1', paneId: 'pane-a', ptyId: 'pty-a' });
    const { mentions, unmatched } = promoteTypedMentions('hey @w1-2(claude) look', [c], []);
    expect(unmatched).toEqual([]);
    expect(mentions).toEqual([
      { workspaceId: 'ws-1', paneId: 'pane-a', ptyId: 'pty-a', name: 'w1-2(claude)' },
    ]);
  });

  it('matches the longest insert token first (prefix-collision guard)', () => {
    // A slug-less pane token (`w1-2`) is a strict prefix of an agent pane token
    // (`w1-2(claude)`). The longer must win when the full token is typed.
    const short = cand('w1-2', { workspaceId: 'ws-s', paneId: 'pane-s', ptyId: 'pty-s' });
    const long = cand('w1-2(claude)', { workspaceId: 'ws-l', paneId: 'pane-l', ptyId: 'pty-l' });

    const a = promoteTypedMentions('ping @w1-2(claude)', [short, long], []);
    expect(a.mentions).toEqual([
      { workspaceId: 'ws-l', paneId: 'pane-l', ptyId: 'pty-l', name: 'w1-2(claude)' },
    ]);

    // The bare short token (whitespace boundary) resolves to the short pane only.
    const b = promoteTypedMentions('ping @w1-2 now', [short, long], []);
    expect(b.mentions).toEqual([
      { workspaceId: 'ws-s', paneId: 'pane-s', ptyId: 'pty-s', name: 'w1-2' },
    ]);
  });

  it('dedups a token that was both dropdown-picked and typed', () => {
    const c = cand('w1-2(claude)', { workspaceId: 'ws-1', paneId: 'pane-a', ptyId: 'pty-a' });
    const picked: ChannelMention[] = [
      { workspaceId: 'ws-1', paneId: 'pane-a', ptyId: 'pty-a', name: 'w1-2(claude)' },
    ];
    const { mentions, unmatched } = promoteTypedMentions('hi @w1-2(claude)', [c], picked);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].paneId).toBe('pane-a');
    expect(unmatched).toEqual([]);
  });

  it('drops a picked mention whose @token no longer survives in the body', () => {
    const c = cand('w1-2(claude)', { workspaceId: 'ws-1', paneId: 'pane-a', ptyId: 'pty-a' });
    const picked: ChannelMention[] = [
      { workspaceId: 'ws-1', paneId: 'pane-a', ptyId: 'pty-a', name: 'w1-2(claude)' },
    ];
    const { mentions } = promoteTypedMentions('message with no token', [c], picked);
    expect(mentions).toEqual([]);
  });

  it('reports @tokens that match no candidate as unmatched (no mention fires)', () => {
    const c = cand('w1-2(claude)');
    const { mentions, unmatched } = promoteTypedMentions('yo @nobody and @ghost', [c], []);
    expect(mentions).toEqual([]);
    expect(unmatched).toEqual(['@nobody', '@ghost']);
  });

  it('with no candidates, every typed @token is unmatched and nothing promotes', () => {
    const { mentions, unmatched } = promoteTypedMentions('hi @someone', [], []);
    expect(mentions).toEqual([]);
    expect(unmatched).toEqual(['@someone']);
  });

  it('mixes promotion and unmatched in one body', () => {
    const c = cand('w1-2(claude)', { workspaceId: 'ws-1', paneId: 'pane-a', ptyId: 'pty-a' });
    const { mentions, unmatched } = promoteTypedMentions('@w1-2(claude) and @stranger', [c], []);
    expect(mentions).toEqual([
      { workspaceId: 'ws-1', paneId: 'pane-a', ptyId: 'pty-a', name: 'w1-2(claude)' },
    ]);
    expect(unmatched).toEqual(['@stranger']);
  });

  it('ignores mid-word @ (emails) and a bare @ sign', () => {
    const c = cand('w1-2(claude)');
    const { mentions, unmatched } = promoteTypedMentions('mail a@b.com and a bare @ sign', [c], []);
    expect(mentions).toEqual([]);
    expect(unmatched).toEqual([]);
  });

  it('promotes a token that is followed by trailing punctuation', () => {
    const c = cand('w1-2(claude)', { workspaceId: 'ws-1', paneId: 'pane-a', ptyId: 'pty-a' });
    const { mentions, unmatched } = promoteTypedMentions('done @w1-2(claude)!', [c], []);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].name).toBe('w1-2(claude)');
    expect(unmatched).toEqual([]);
  });

  it('does not exact-match when a token char continues the run', () => {
    // `@w1-2(claude)x` is NOT the token `w1-2(claude)` — treat the whole run as
    // unmatched rather than promoting the pane.
    const c = cand('w1-2(claude)');
    const { mentions, unmatched } = promoteTypedMentions('oops @w1-2(claude)x', [c], []);
    expect(mentions).toEqual([]);
    expect(unmatched).toEqual(['@w1-2(claude)x']);
  });

  it('dedups repeated identical unmatched runs', () => {
    const { unmatched } = promoteTypedMentions('@ghost @ghost @ghost', [], []);
    expect(unmatched).toEqual(['@ghost']);
  });
});

describe('promoteTypedMentions — non-whitespace prefixes (adversarial review F10)', () => {
  const cjkCands = [
    {
      workspaceId: 'ws-a',
      paneId: 'pane-1',
      ptyId: 'pty-1',
      insertToken: 'w1-2(claude)',
      displayName: 'w1-2(claude)',
    },
  ];

  it('promotes a token typed flush against Korean text (확인요@w1-2(claude))', () => {
    const { mentions, unmatched } = promoteTypedMentions('확인요@w1-2(claude)', cjkCands, []);
    expect(mentions).toHaveLength(1);
    expect(unmatched).toHaveLength(0);
  });

  it('promotes a token after punctuation (cc:@w1-2(claude))', () => {
    const { mentions } = promoteTypedMentions('cc:@w1-2(claude)', cjkCands, []);
    expect(mentions).toHaveLength(1);
  });

  it('still ignores email-shaped @ (user@w1-2(claude) does not promote)', () => {
    const { mentions, unmatched } = promoteTypedMentions('user@w1-2(claude)', cjkCands, []);
    expect(mentions).toHaveLength(0);
    expect(unmatched).toHaveLength(0);
  });

  it('a dropdown-PICKED mention survives even when its token sits flush against text', () => {
    const picked = [{ workspaceId: 'ws-a', paneId: 'pane-1', ptyId: 'pty-1', name: 'w1-2(claude)' }];
    const { mentions } = promoteTypedMentions('확인요@w1-2(claude) 부탁', [], picked);
    expect(mentions).toHaveLength(1);
  });
});
