/**
 * Unit tests for the two extracted halves of useActivePaneFocus:
 * `resolveActivePanePtyId` (pure target resolution) and
 * `driveFocusToTerminal` (retry + late-registration focus driver, with raf /
 * registry deps injected so the node-env vitest can exercise it — previously
 * the rAF half was dogfood-only and its 10-frame give-up shipped a boot-
 * restore focus hole).
 *
 * These tests pin the regression behind the "red border moves but typing lands
 * in the old pane" bug: the resolver must follow BOTH pane switches and
 * same-pane surface (tab) switches, and must decline non-terminal surfaces.
 */
import { describe, it, expect } from 'vitest';
import { resolveActivePanePtyId, driveFocusToTerminal, type FocusDriverDeps } from '../useActivePaneFocus';
import type { Workspace, Pane, PaneLeaf, Surface } from '../../../shared/types';

function surface(id: string, ptyId: string, surfaceType?: Surface['surfaceType']): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: '.', surfaceType };
}

function leaf(id: string, surfaces: Surface[], activeSurfaceId: string): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId };
}

function ws(id: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name: id, rootPane, activePaneId };
}

describe('resolveActivePanePtyId', () => {
  it('returns the active surface ptyId of the active pane', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 's1');
    const state = { workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' };
    expect(resolveActivePanePtyId(state)).toBe('pty-1');
  });

  it('follows a pane switch — picks the ptyId of whichever pane is active', () => {
    // Two side-by-side leaves; activePaneId selects the target. This is the
    // reported bug: navigating the active pane must change the focus target.
    const root: Pane = {
      id: 'branch',
      type: 'branch',
      direction: 'horizontal',
      children: [
        leaf('p1', [surface('s1', 'pty-1')], 's1'),
        leaf('p2', [surface('s2', 'pty-2')], 's2'),
      ],
    };
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p2')], activeWorkspaceId: 'w1' })).toBe('pty-2');
  });

  it('follows a same-pane tab switch — picks the active surface ptyId', () => {
    // In-scope per the chosen fix: keyboard tab switches must move focus too.
    const a = leaf('p1', [surface('s1', 'pty-1'), surface('s2', 'pty-2')], 's1');
    const b = leaf('p1', [surface('s1', 'pty-1'), surface('s2', 'pty-2')], 's2');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', a, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', b, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-2');
  });

  it('returns null for a browser surface (no xterm to focus)', () => {
    const root = leaf('p1', [surface('s1', 'pty-1', 'browser')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('returns null for an editor surface', () => {
    const root = leaf('p1', [surface('s1', 'pty-1', 'editor')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('treats an explicit "terminal" surfaceType the same as undefined', () => {
    const root = leaf('p1', [surface('s1', 'pty-1', 'terminal')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-1');
  });

  it('returns null when the active surface has no ptyId yet (mid-create / cleared)', () => {
    const root = leaf('p1', [surface('s1', '')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('returns null when no workspace is active', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'missing' })).toBeNull();
  });

  it('returns null when activePaneId does not resolve to a leaf', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'ghost')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('returns null when activePaneId points at a branch, not a leaf', () => {
    const root: Pane = {
      id: 'branch',
      type: 'branch',
      direction: 'vertical',
      children: [leaf('p1', [surface('s1', 'pty-1')], 's1')],
    };
    // findLeaf only matches leaves, so a branch id resolves to null.
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'branch')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('returns null when the active surface id is missing from the pane', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 'gone');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });
});

// ─── driveFocusToTerminal ────────────────────────────────────────────────────

/** Fake registry + manual raf queue so the retry loop runs deterministically. */
function makeDriverHarness() {
  const registry = new Map<string, { focus(): void }>();
  const focused: string[] = [];
  const listeners = new Set<(id: string) => void>();
  const rafQueue: Array<() => void> = [];

  const deps: FocusDriverDeps = {
    getTerminal: (id) => registry.get(id),
    onRegistered: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    raf: (cb) => rafQueue.push(cb),
    caf: () => undefined,
  };

  return {
    deps,
    focused,
    listenerCount: () => listeners.size,
    register: (id: string) => {
      registry.set(id, { focus: () => focused.push(id) });
      for (const l of [...listeners]) l(id);
    },
    /** Drain pending animation frames (each may schedule the next). */
    runFrames: (n: number) => {
      for (let i = 0; i < n; i++) {
        const cb = rafQueue.shift();
        if (!cb) return;
        cb();
      }
    },
  };
}

describe('driveFocusToTerminal', () => {
  it('focuses immediately when the terminal is already registered, and disarms', () => {
    const h = makeDriverHarness();
    h.register('pty-1');
    h.focused.length = 0;

    driveFocusToTerminal('pty-1', h.deps);

    expect(h.focused).toEqual(['pty-1']);
    // One-shot: a later re-registration (font-change remount, multiview exit)
    // must not yank focus back — the subscription is already disarmed.
    h.register('pty-1');
    expect(h.focused).toEqual(['pty-1']);
    expect(h.listenerCount()).toBe(0);
  });

  it('focuses via the frame retry when registration lands within the window', () => {
    const h = makeDriverHarness();
    driveFocusToTerminal('pty-1', h.deps);
    h.runFrames(3);
    h.register('pty-1'); // registration listener fires first…
    expect(h.focused).toContain('pty-1');
  });

  it('boot-restore: focuses on registration AFTER the frame retries give up', () => {
    const h = makeDriverHarness();
    driveFocusToTerminal('pty-1', h.deps);
    h.runFrames(20); // exhaust all retries (maxTries=10) — registry still empty
    expect(h.focused).toEqual([]);

    // Scrollback restore completes much later and registers the terminal.
    h.register('pty-1');
    expect(h.focused.filter((f) => f === 'pty-1').length).toBeGreaterThan(0);
    expect(h.listenerCount()).toBe(0); // one-shot disarmed after firing
  });

  it('ignores registrations of other terminals', () => {
    const h = makeDriverHarness();
    driveFocusToTerminal('pty-1', h.deps);
    h.runFrames(20);
    h.register('pty-OTHER');
    expect(h.focused).toEqual([]);
    expect(h.listenerCount()).toBe(1); // still armed for the real target
  });

  it('cleanup disarms the subscription so a stale target cannot steal focus', () => {
    const h = makeDriverHarness();
    const cleanup = driveFocusToTerminal('pty-1', h.deps);
    h.runFrames(20);
    cleanup();
    h.register('pty-1');
    expect(h.focused).toEqual([]);
    expect(h.listenerCount()).toBe(0);
  });
});
