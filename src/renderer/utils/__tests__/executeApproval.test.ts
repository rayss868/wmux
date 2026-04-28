import { describe, it, expect, vi } from 'vitest';
import {
  setExecuteApprovalResolver,
  resolveExecuteApproval,
  hasPendingExecuteApproval,
} from '../executeApproval';

describe('executeApproval resolver', () => {
  it('starts with no pending resolver', () => {
    // Reset any leftover state by resolving twice (no-op the second time).
    resolveExecuteApproval(false);
    expect(hasPendingExecuteApproval()).toBe(false);
  });

  it('invokes the registered resolver with the user decision and clears it', () => {
    const resolver = vi.fn();
    setExecuteApprovalResolver(resolver);
    expect(hasPendingExecuteApproval()).toBe(true);

    resolveExecuteApproval(true);
    expect(resolver).toHaveBeenCalledWith(true);
    expect(hasPendingExecuteApproval()).toBe(false);
  });

  it('passes false through for denial', () => {
    const resolver = vi.fn();
    setExecuteApprovalResolver(resolver);

    resolveExecuteApproval(false);
    expect(resolver).toHaveBeenCalledWith(false);
  });

  it('a second resolve is a no-op (resolver was already cleared)', () => {
    const resolver = vi.fn();
    setExecuteApprovalResolver(resolver);

    resolveExecuteApproval(true);
    resolveExecuteApproval(false); // should not double-invoke
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('replacing an existing resolver overrides the prior one', () => {
    const first = vi.fn();
    const second = vi.fn();
    setExecuteApprovalResolver(first);
    setExecuteApprovalResolver(second); // overwrite — first will never be called

    resolveExecuteApproval(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(true);
  });
});
