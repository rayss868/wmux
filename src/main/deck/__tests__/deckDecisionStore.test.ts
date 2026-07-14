import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  raiseDecision,
  resolveDecision,
  clearDecision,
  loadWorkspaceDecision,
  hasPendingDecision,
  renderDecisionBlock,
  getDeckDecisionPath,
  DECISION_LIMITS,
} from '../deckDecisionStore';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-decision-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deckDecisionStore', () => {
  it('raises a pending decision and loads it back', async () => {
    const d = await raiseDecision('ws-1', { question: 'A or B?', options: ['A', 'B'], context: 'ctx' }, dir);
    expect(d).toMatchObject({ question: 'A or B?', options: ['A', 'B'], status: 'pending' });
    expect(d!.id).toBeTruthy();
    expect(loadWorkspaceDecision('ws-1', dir)).toMatchObject({ status: 'pending' });
    expect(hasPendingDecision('ws-1', dir)).toBe(true);
    expect(hasPendingDecision('ws-2', dir)).toBe(false);
  });

  it('survives a fresh read from disk (durability)', async () => {
    await raiseDecision('ws-1', { question: 'persist?' }, dir);
    // A brand-new load (as a fresh process would do) sees the pending decision.
    expect(loadWorkspaceDecision('ws-1', dir)).toMatchObject({ question: 'persist?', status: 'pending' });
    expect(hasPendingDecision('ws-1', dir)).toBe(true);
  });

  it('resolves only on a matching id + still-pending, and stops being pending', async () => {
    const d = (await raiseDecision('ws-1', { question: 'Q?' }, dir))!;
    // wrong id → no-op
    await resolveDecision('ws-1', 'not-the-id', 'X', dir);
    expect(hasPendingDecision('ws-1', dir)).toBe(true);
    // empty answer → no-op
    await resolveDecision('ws-1', d.id, '   ', dir);
    expect(hasPendingDecision('ws-1', dir)).toBe(true);
    // real resolve
    const r = await resolveDecision('ws-1', d.id, 'go with A', dir);
    expect(r).toMatchObject({ status: 'resolved', resolution: 'go with A' });
    expect(hasPendingDecision('ws-1', dir)).toBe(false);
    expect(loadWorkspaceDecision('ws-1', dir)!.status).toBe('resolved');
    // resolving again is a no-op (already resolved)
    await resolveDecision('ws-1', d.id, 'change', dir);
    expect(loadWorkspaceDecision('ws-1', dir)!.resolution).toBe('go with A');
  });

  it('clears a decision', async () => {
    await raiseDecision('ws-1', { question: 'Q?' }, dir);
    await clearDecision('ws-1', dir);
    expect(loadWorkspaceDecision('ws-1', dir)).toBeNull();
  });

  it('rejects bad workspace ids and caps oversized fields', async () => {
    expect(await raiseDecision('bad id!', { question: 'Q' }, dir)).toBeNull();
    expect(loadWorkspaceDecision('bad id!', dir)).toBeNull();
    const long = 'x'.repeat(5000);
    const d = (await raiseDecision(
      'ws-1',
      { question: long, options: Array.from({ length: 20 }, () => 'o'), context: long },
      dir,
    ))!;
    expect(d.question.length).toBe(DECISION_LIMITS.MAX_QUESTION_CHARS);
    expect(d.options.length).toBe(DECISION_LIMITS.MAX_OPTIONS);
    expect(d.context.length).toBe(DECISION_LIMITS.MAX_CONTEXT_CHARS);
  });

  it('a resolved record that lost its resolution loads back as pending (fail-closed)', async () => {
    writeFileSync(
      getDeckDecisionPath(dir),
      JSON.stringify({ 'ws-1': { id: 'x', question: 'Q', options: [], context: '', status: 'resolved', raisedAt: 1 } }),
    );
    expect(loadWorkspaceDecision('ws-1', dir)!.status).toBe('pending');
    expect(hasPendingDecision('ws-1', dir)).toBe(true);
  });

  it('fails open on a torn file — no decision, never throws', () => {
    writeFileSync(getDeckDecisionPath(dir), '{ not json');
    expect(loadWorkspaceDecision('ws-1', dir)).toBeNull();
    expect(hasPendingDecision('ws-1', dir)).toBe(false);
  });

  it('renders pending and resolved blocks for the prompt seam', async () => {
    const d = (await raiseDecision('ws-1', { question: 'Ship it?', options: ['yes', 'no'] }, dir))!;
    const pending = renderDecisionBlock(d);
    expect(pending).toContain('BLOCKED');
    expect(pending).toContain('yes | no');
    const r = (await resolveDecision('ws-1', d.id, 'yes', dir))!;
    const resolved = renderDecisionBlock(r);
    expect(resolved).toContain('RESOLVED');
    expect(resolved).toContain('yes');
  });
});
