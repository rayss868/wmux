import { describe, it, expect, vi } from 'vitest';
import {
  setExecuteApprovalResolver,
  resolveExecuteApproval,
  hasPendingExecuteApproval,
} from '../executeApproval';

describe('executeApproval resolver', () => {
  it('starts with no pending resolver', () => {
    // Reset any leftover state by resolving twice (no-op the second time).
    resolveExecuteApproval('missing', false);
    expect(hasPendingExecuteApproval()).toBe(false);
  });

  it('invokes the registered resolver with the user decision and clears it', () => {
    const resolver = vi.fn();
    setExecuteApprovalResolver('approval-1', resolver);
    expect(hasPendingExecuteApproval()).toBe(true);
    expect(hasPendingExecuteApproval('approval-1')).toBe(true);

    resolveExecuteApproval('approval-1', true);
    expect(resolver).toHaveBeenCalledWith(true);
    expect(hasPendingExecuteApproval()).toBe(false);
  });

  it('passes false through for denial', () => {
    const resolver = vi.fn();
    setExecuteApprovalResolver('approval-1', resolver);

    resolveExecuteApproval('approval-1', false);
    expect(resolver).toHaveBeenCalledWith(false);
  });

  it('a second resolve is a no-op (resolver was already cleared)', () => {
    const resolver = vi.fn();
    setExecuteApprovalResolver('approval-1', resolver);

    resolveExecuteApproval('approval-1', true);
    resolveExecuteApproval('approval-1', false); // should not double-invoke
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('keeps concurrent resolvers independent', () => {
    const first = vi.fn();
    const second = vi.fn();
    setExecuteApprovalResolver('approval-1', first);
    setExecuteApprovalResolver('approval-2', second);

    resolveExecuteApproval('approval-2', true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(true);
    expect(hasPendingExecuteApproval('approval-1')).toBe(true);

    resolveExecuteApproval('approval-1', false);
    expect(first).toHaveBeenCalledWith(false);
    expect(hasPendingExecuteApproval()).toBe(false);
  });
});
