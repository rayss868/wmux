import { describe, it, expect, vi } from 'vitest';
import { createWorkspaceListCache, WORKSPACE_LIST_CACHE_TTL_MS } from '../hooks.rpc';

// RCA (2026-05-29 dogfood): the handler did a renderer workspace.list
// round-trip on EVERY hook signal, so a tool-heavy turn flooded the bridge
// with 2s timeouts. These tests lock in the short-TTL + coalescing cache that
// collapses a burst into a single round-trip and serves stale on refresh
// failure (renderer throttled) instead of dropping the hook.

type WS = { id: string; name: string };
const list = (id: string): WS[] => [{ id, name: id }];

describe('createWorkspaceListCache', () => {
  it('serves a fresh cache hit within the TTL without re-fetching', async () => {
    let t = 1000;
    const fetchList = vi.fn(async () => list('a'));
    const cache = createWorkspaceListCache(fetchList, () => t);

    expect(await cache.get()).toEqual(list('a'));
    t += WORKSPACE_LIST_CACHE_TTL_MS - 1; // still inside the window
    expect(await cache.get()).toEqual(list('a'));

    expect(fetchList).toHaveBeenCalledTimes(1); // second get() was a cache hit
  });

  it('coalesces a burst of concurrent misses into ONE fetch', async () => {
    let resolveFetch!: (v: WS[]) => void;
    const fetchList = vi.fn(() => new Promise<WS[]>((r) => { resolveFetch = r; }));
    const cache = createWorkspaceListCache(fetchList, () => 0);

    // 50 hooks fire "simultaneously" before the first round-trip resolves.
    const all = Promise.all(Array.from({ length: 50 }, () => cache.get()));
    resolveFetch(list('a'));
    const results = await all;

    expect(fetchList).toHaveBeenCalledTimes(1); // the whole burst shared one RTT
    for (const r of results) expect(r).toEqual(list('a'));
  });

  it('re-fetches once the TTL expires', async () => {
    let t = 0;
    const fetchList = vi.fn(async () => list(`v${t}`));
    const cache = createWorkspaceListCache(fetchList, () => t);

    expect(await cache.get()).toEqual(list('v0'));
    t += WORKSPACE_LIST_CACHE_TTL_MS; // exactly at the boundary → expired
    expect(await cache.get()).toEqual(list(`v${t}`));
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it('serves the last-known list when a refresh fails/times out (renderer throttled)', async () => {
    let t = 0;
    let attempt = 0;
    const fetchList = vi.fn(async () => (attempt++ === 0 ? list('good') : null));
    const cache = createWorkspaceListCache(fetchList, () => t);

    expect(await cache.get()).toEqual(list('good')); // populate cache
    t += WORKSPACE_LIST_CACHE_TTL_MS + 1; // expire
    // refresh returns null (timeout) — must serve stale, NOT drop the hook
    expect(await cache.get()).toEqual(list('good'));
    expect(fetchList).toHaveBeenCalledTimes(2);
  });

  it('returns null when nothing has ever been fetched successfully', async () => {
    const fetchList = vi.fn(async () => null);
    const cache = createWorkspaceListCache(fetchList, () => 0);
    expect(await cache.get()).toBeNull();
  });
});
