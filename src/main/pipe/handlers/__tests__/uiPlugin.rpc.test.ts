import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { registerUiPluginRpc } from '../uiPlugin.rpc';
import { IPC } from '../../../../shared/constants';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

function setup() {
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
  const router = new RpcRouter();
  registerUiPluginRpc(router, () => win);
  return { router, send };
}

const CALL = (params: Record<string, unknown>, clientName?: string) => ({
  id: 'r1',
  method: 'ui.decoratePane' as const,
  params,
  ...(clientName ? { clientName } : {}),
});

describe('ui.decoratePane', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('forwards a sanitized decoration keyed by the caller identity', async () => {
    const res = await ctx.router.dispatch(CALL(
      { paneId: 'pane-1', badge: 'CI ✓', tooltip: 'build green', color: 'green' },
      'my-plugin',
    ));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toEqual({ applied: true, cleared: false });
    expect(ctx.send).toHaveBeenCalledWith(IPC.PLUGIN_PANE_DECORATION, {
      plugin: 'my-plugin',
      paneId: 'pane-1',
      badge: 'CI ✓',
      tooltip: 'build green',
      color: 'green',
    });
  });

  it('rejects envelope-less callers (no clientName)', async () => {
    const res = await ctx.router.dispatch(CALL({ paneId: 'p', badge: 'X' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/requires a plugin identity/);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('null badge clears; control chars are stripped; lengths are capped', async () => {
    const cleared = await ctx.router.dispatch(CALL({ paneId: 'p', badge: null }, 'p1'));
    if (cleared.ok) expect(cleared.result).toEqual({ applied: false, cleared: true });
    expect(ctx.send).toHaveBeenLastCalledWith(IPC.PLUGIN_PANE_DECORATION,
      expect.objectContaining({ badge: null }));

    await ctx.router.dispatch(CALL({ paneId: 'p', badge: 'a\x1b[31mb'.padEnd(100, 'x') }, 'p1'));
    const sent = ctx.send.mock.calls.at(-1)?.[1] as { badge: string };
    expect(sent.badge.length).toBeLessThanOrEqual(12);
    expect(sent.badge.includes('\x1b')).toBe(false);

    // Badge that sanitizes to empty behaves as a clear.
    await ctx.router.dispatch(CALL({ paneId: 'p', badge: '\x01\x02' }, 'p1'));
    expect((ctx.send.mock.calls.at(-1)?.[1] as { badge: string | null }).badge).toBeNull();
  });

  it('rejects invalid paneId, badge type, and unknown colors', async () => {
    expect((await ctx.router.dispatch(CALL({ paneId: '', badge: 'X' }, 'p'))).ok).toBe(false);
    expect((await ctx.router.dispatch(CALL({ paneId: 'x'.repeat(65), badge: 'X' }, 'p'))).ok).toBe(false);
    expect((await ctx.router.dispatch(CALL({ paneId: 'p', badge: 42 }, 'p'))).ok).toBe(false);
    expect((await ctx.router.dispatch(CALL({ paneId: 'p', badge: 'X', color: 'magenta' }, 'p'))).ok).toBe(false);
    expect((await ctx.router.dispatch(CALL({ paneId: 'p', badge: 'X', color: '#ff0000' }, 'p'))).ok).toBe(false);
    expect((await ctx.router.dispatch(CALL({ paneId: 'p', badge: 'X', tooltip: 9 }, 'p'))).ok).toBe(false);
  });
});
