// Unit tests for the P3c quick-action chip builder — pure objects, no store.

import { describe, it, expect } from 'vitest';
import {
  buildQuickActions,
  FLEET_STATUS_PROMPT,
  PR_STATUS_PROMPT,
} from '../deckQuickActions';
import type { RecoveryPane } from '../deckRecovery';

const recoveryPane = (over: Partial<RecoveryPane> = {}): RecoveryPane => ({
  ptyId: 'pty-1',
  autoName: '1.1-claude',
  label: '1.1-claude',
  workspaceName: 'Backend',
  agent: 'claude',
  command: 'claude --resume sess-1',
  exact: true,
  ...over,
});

describe('buildQuickActions', () => {
  it('always offers fleet status and PR status, in that order', () => {
    const actions = buildQuickActions({ recoveryPanes: [] });
    expect(actions.map((a) => a.id)).toEqual(['fleet-status', 'pr-status']);
    expect(actions[0].label).toBe('Fleet status');
    expect(actions[1].label).toBe('PR status');
  });

  it('adds the recover chip only while recoverable panes exist', () => {
    const none = buildQuickActions({ recoveryPanes: [] });
    expect(none.some((a) => a.id === 'recover-fleet')).toBe(false);

    const some = buildQuickActions({ recoveryPanes: [recoveryPane()] });
    const recover = some.find((a) => a.id === 'recover-fleet');
    expect(recover).toBeDefined();
    // The chip carries the same canned prompt the greeting card sends —
    // per-pane exact commands included.
    expect(recover!.prompt).toContain('claude --resume sess-1');
    expect(recover!.prompt).toContain('pty-1');
  });

  it('uses the translator when it yields a value, English fallback otherwise', () => {
    const t = (key: string): string => (key === 'deck.qaFleetStatus' ? '함대 상태' : '');
    const actions = buildQuickActions({ recoveryPanes: [], t });
    expect(actions[0].label).toBe('함대 상태');
    expect(actions[1].label).toBe('PR status');
  });

  it('fleet-status prompt drives terminal_read (the allow-listed read path)', () => {
    expect(FLEET_STATUS_PROMPT).toContain('terminal_read');
  });

  it('PR prompt delegates to a worker pane — never assumes a brain shell (D2)', () => {
    expect(PR_STATUS_PROMPT).toContain('You have no shell');
    expect(PR_STATUS_PROMPT).toContain('terminal_send');
    expect(PR_STATUS_PROMPT).toContain('gh pr status');
  });
});
