// 4d — boot-time agent-candidate seeding decision logic.
import { describe, it, expect } from 'vitest';
import { planAgentCandidateSeed, asAgentSlug } from '../agentCandidateSeed';

describe('planAgentCandidateSeed', () => {
  it('picks only sessions with no detected agent name yet', () => {
    const surfaceAgent = {
      'pty-live': { name: 'claude' },       // already detected — never re-pulled
      'pty-empty-name': { name: '' },        // empty name = not detected
    } as Record<string, { name: string } | undefined>;
    expect(
      planAgentCandidateSeed(['pty-live', 'pty-empty-name', 'pty-unseen'], surfaceAgent),
    ).toEqual(['pty-empty-name', 'pty-unseen']);
  });

  it('handles the empty boot state (no sessions, no map)', () => {
    expect(planAgentCandidateSeed([], {})).toEqual([]);
    expect(planAgentCandidateSeed(['a', 'b'], {})).toEqual(['a', 'b']);
  });

  it('drops empty session ids defensively', () => {
    expect(planAgentCandidateSeed(['', 'x'], {})).toEqual(['x']);
  });
});

describe('asAgentSlug', () => {
  it('narrows known detector outputs to slugs', () => {
    expect(asAgentSlug('claude')).toBe('claude');
    expect(asAgentSlug('codex')).toBe('codex');
    expect(asAgentSlug('opencode')).toBe('opencode');
  });

  it('returns undefined for unknown values (future agents seed name-only)', () => {
    expect(asAgentSlug('some-new-agent')).toBeUndefined();
    expect(asAgentSlug('')).toBeUndefined();
  });
});
