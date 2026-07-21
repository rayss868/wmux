import { describe, it, expect, beforeEach } from 'vitest';
import { setMutedNotificationCategories, isCategoryMuted } from '../mutedCategories';

describe('mutedCategories (main-side mirror, #516)', () => {
  beforeEach(() => {
    setMutedNotificationCategories([]);
  });

  it('mutes exactly the mirrored categories', () => {
    setMutedNotificationCategories(['subagent']);
    expect(isCategoryMuted('subagent')).toBe(true);
    expect(isCategoryMuted('approval')).toBe(false);
  });

  it('never mutes an uncategorized notification', () => {
    setMutedNotificationCategories(['subagent', 'agent-turn', 'approval', 'terminal', 'system']);
    expect(isCategoryMuted(undefined)).toBe(false);
  });

  it('drops values that are not known categories', () => {
    setMutedNotificationCategories(['subagent', 'nonsense', 42, null]);
    expect(isCategoryMuted('subagent')).toBe(true);
    expect(isCategoryMuted('nonsense' as never)).toBe(false);
  });

  it('ignores a non-array payload rather than clearing the mirror', () => {
    setMutedNotificationCategories(['subagent']);
    setMutedNotificationCategories('subagent');
    expect(isCategoryMuted('subagent')).toBe(true);
  });
});
