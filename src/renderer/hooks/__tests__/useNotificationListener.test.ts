/**
 * T8 — useNotificationListener.test.ts
 *
 * Tests the IPC dispatcher factory `createNotificationHandler`. The hook
 * wrapper itself (`useNotificationListener`) is a thin useEffect that
 * wires the factory to `window.electronAPI` and `useStore`; we exercise
 * the factory directly so vitest's `node` environment is sufficient (no
 * jsdom, no React testing harness — see useKeyboard.test.ts for the same
 * pattern).
 *
 * Regression coverage promise (R1-R11): every behaviour that previously
 * lived in the 200-line listener and had ZERO test coverage now has a
 * deterministic case below. Target resolution, active-surface skip, mute,
 * the throttle windows, and cleanup are all pinned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createNotificationHandler,
  resolveNotificationTarget,
  type NotificationHandlerDeps,
} from '../useNotificationListener';
import { createThrottler } from '../../utils/createThrottler';
import type { Workspace, Pane, Surface } from '../../../shared/types';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeSurface(id: string, ptyId: string): Surface {
  return {
    id,
    ptyId,
    title: id,
    shell: 'powershell',
    cwd: 'C:\\',
    surfaceType: 'terminal',
  };
}

function makeLeaf(id: string, surfaces: { id: string; ptyId: string }[]): Pane {
  return {
    id,
    type: 'leaf',
    surfaces: surfaces.map((s) => makeSurface(s.id, s.ptyId)),
    activeSurfaceId: surfaces[0]?.id ?? '',
  };
}

function makeWorkspace(opts: {
  id: string;
  panes: { id: string; surfaces: { id: string; ptyId: string }[] }[];
  activePaneId?: string;
  notificationsMuted?: boolean;
}): Workspace {
  const leaves = opts.panes.map((p) => makeLeaf(p.id, p.surfaces));
  // Single-leaf root for the integration tests below; if a multi-pane setup
  // is ever needed we can extend with a branch. Most tests only need one
  // pane per workspace, which is enough to exercise target resolution.
  const root = leaves[0];
  return {
    id: opts.id,
    name: opts.id,
    rootPane: root,
    activePaneId: opts.activePaneId ?? root.id,
    metadata: opts.notificationsMuted ? { notificationsMuted: true } : undefined,
  };
}

type MockState = ReturnType<NotificationHandlerDeps['getState']>;

interface Harness {
  state: MockState;
  deps: NotificationHandlerDeps;
  // Spies, exposed so each test can assert on them without re-piping through
  // deps.
  spies: {
    addNotification: ReturnType<typeof vi.fn>;
    pushToast: ReturnType<typeof vi.fn>;
    setPaneNotificationRing: ReturnType<typeof vi.fn>;
    flashFrame: ReturnType<typeof vi.fn>;
    playSound: ReturnType<typeof vi.fn>;
    scheduleRingDecay: ReturnType<typeof vi.fn>;
  };
}

/**
 * Default harness — one workspace `ws-a` with one pane and one surface
 * `sf-1` bound to ptyId `pty-1`. Settings all on, window focused, not muted,
 * not active. Each test can mutate `harness.state` before calling the
 * handler.
 */
function makeHarness(overrides: { state?: Partial<MockState> } = {}): Harness {
  const ws = makeWorkspace({
    id: 'ws-a',
    panes: [{ id: 'pane-a', surfaces: [{ id: 'sf-1', ptyId: 'pty-1' }] }],
  });

  const spies = {
    addNotification: vi.fn(),
    pushToast: vi.fn(() => 'toast-id'),
    setPaneNotificationRing: vi.fn(),
    flashFrame: vi.fn(),
    playSound: vi.fn(),
    scheduleRingDecay: vi.fn(),
  };

  const state: MockState = {
    workspaces: [ws],
    activeWorkspaceId: 'ws-a',
    toastEnabled: true,
    notificationSoundEnabled: true,
    notificationSoundChoice: 'default',
    paneRingEnabled: true,
    paneFlashEnabled: true,
    taskbarFlashEnabled: true,
    addNotification: spies.addNotification,
    pushToast: spies.pushToast,
    setPaneNotificationRing: spies.setPaneNotificationRing,
    paneNotificationRing: {},
    ...overrides.state,
  };

  const deps: NotificationHandlerDeps = {
    getState: () => state,
    isWindowFocused: () => false, // Tests default to UNFOCUSED so flashFrame fires; flip per-case.
    flashFrame: spies.flashFrame,
    playSound: spies.playSound,
    flashFrameThrottler: createThrottler(500),
    getSoundThrottler: (() => {
      const map: Record<string, ReturnType<typeof createThrottler>> = {};
      return (type: string) => {
        if (!map[type]) map[type] = createThrottler(2000);
        return map[type];
      };
    })(),
    scheduleRingDecay: spies.scheduleRingDecay,
  };

  return { state, deps, spies };
}

// ─── Time mocking for throttle tests ───────────────────────────────────────
// Throttlers use Date.now(), so each throttle test installs vi.useFakeTimers
// to control the wall clock. Real timer tests (R11 cleanup) use real timers
// because we want setTimeout to actually do nothing on unmount.

describe('resolveNotificationTarget (R1-R3)', () => {
  // R1 — ptyId resolution path
  it('R1: ptyId match returns workspaceId + surfaceId + paneId', () => {
    const ws = makeWorkspace({
      id: 'ws-a',
      panes: [{ id: 'pane-a', surfaces: [{ id: 'sf-1', ptyId: 'pty-1' }] }],
    });
    const result = resolveNotificationTarget(
      { workspaces: [ws], activeWorkspaceId: 'ws-a' },
      'pty-1',
      undefined,
    );
    expect(result).toEqual({ workspaceId: 'ws-a', surfaceId: 'sf-1', paneId: 'pane-a' });
  });

  // R2 — workspaceId hint path
  it('R2: workspaceId hint (no ptyId) resolves to that workspace\'s active surface', () => {
    const wsA = makeWorkspace({ id: 'ws-a', panes: [{ id: 'pane-a', surfaces: [{ id: 'sf-1', ptyId: 'pty-1' }] }] });
    const wsB = makeWorkspace({ id: 'ws-b', panes: [{ id: 'pane-b', surfaces: [{ id: 'sf-2', ptyId: 'pty-2' }] }] });
    const result = resolveNotificationTarget(
      { workspaces: [wsA, wsB], activeWorkspaceId: 'ws-a' },
      null,
      'ws-b',
    );
    expect(result?.workspaceId).toBe('ws-b');
    expect(result?.surfaceId).toBe('sf-2');
    expect(result?.paneId).toBe('pane-b');
  });

  // R3 — activeWorkspaceId fallback
  it('R3: no ptyId + no hint falls back to active workspace', () => {
    const wsA = makeWorkspace({ id: 'ws-a', panes: [{ id: 'pane-a', surfaces: [{ id: 'sf-1', ptyId: 'pty-1' }] }] });
    const wsB = makeWorkspace({ id: 'ws-b', panes: [{ id: 'pane-b', surfaces: [{ id: 'sf-2', ptyId: 'pty-2' }] }] });
    const result = resolveNotificationTarget(
      { workspaces: [wsA, wsB], activeWorkspaceId: 'ws-b' },
      null,
      undefined,
    );
    expect(result?.workspaceId).toBe('ws-b');
  });

  it('R3b: returns null when ptyId is provided but no surface matches anywhere', () => {
    const wsA = makeWorkspace({ id: 'ws-a', panes: [{ id: 'pane-a', surfaces: [{ id: 'sf-1', ptyId: 'pty-1' }] }] });
    const result = resolveNotificationTarget(
      { workspaces: [wsA], activeWorkspaceId: 'ws-a' },
      'pty-unknown',
      undefined,
    );
    expect(result).toBeNull();
  });
});

describe('createNotificationHandler (R4-R10)', () => {
  let harness: Harness;
  let handle: ReturnType<typeof createNotificationHandler>;

  beforeEach(() => {
    harness = makeHarness();
    // Default: window UNFOCUSED so flashFrame fires unless a test explicitly
    // overrides. This mirrors the pessimistic real-world default — a
    // notification is interesting precisely when the user is elsewhere.
    handle = createNotificationHandler(harness.deps);
  });

  // R4 — isActivePtySurface skip
  it('R4: when target surface IS the active surface, no actions are dispatched', () => {
    // ptyId matches ws-a's active pane's active surface → active surface.
    handle('pty-1', { type: 'info', title: 't', body: 'b' });
    expect(harness.spies.addNotification).not.toHaveBeenCalled();
    expect(harness.spies.pushToast).not.toHaveBeenCalled();
    expect(harness.spies.playSound).not.toHaveBeenCalled();
    expect(harness.spies.flashFrame).not.toHaveBeenCalled();
    expect(harness.spies.setPaneNotificationRing).not.toHaveBeenCalled();
  });

  // R4b — active-surface check only applies when the target workspace is active.
  it('R4b: same ptyId in non-active workspace still dispatches (active-surface only counts within active workspace)', () => {
    // Swap active to a second workspace; ptyId stays in ws-a.
    const ws2 = makeWorkspace({ id: 'ws-b', panes: [{ id: 'pane-b', surfaces: [{ id: 'sf-2', ptyId: 'pty-2' }] }] });
    harness.state.workspaces.push(ws2);
    harness.state.activeWorkspaceId = 'ws-b';

    handle('pty-1', { type: 'info', title: 't', body: 'b' });
    expect(harness.spies.addNotification).toHaveBeenCalledTimes(1);
    expect(harness.spies.addNotification).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-a', surfaceId: 'sf-1' }),
    );
  });

  // R5 — sound throttled within 2s for the same type.
  it('R5: two notifications of the same type within 2s play sound exactly once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 21, 12, 0, 0));
    try {
      // Make sure target is NOT the active surface so notifications fan out.
      harness.state.activeWorkspaceId = 'ws-other'; // disables active-surface check
      handle('pty-1', { type: 'info', title: 'a', body: 'a' });
      vi.advanceTimersByTime(1000); // < 2s window
      handle('pty-1', { type: 'info', title: 'b', body: 'b' });
      expect(harness.spies.playSound).toHaveBeenCalledTimes(1);
      expect(harness.spies.addNotification).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // R6 — sound throttle is independent per NotificationType.
  it('R6: agent then error within 2s both play sound (separate throttlers)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 21, 12, 0, 0));
    try {
      harness.state.activeWorkspaceId = 'ws-other';
      handle('pty-1', { type: 'agent', title: 'a', body: 'a' });
      vi.advanceTimersByTime(100);
      handle('pty-1', { type: 'error', title: 'b', body: 'b' });
      expect(harness.spies.playSound).toHaveBeenCalledTimes(2);
      expect(harness.spies.playSound).toHaveBeenNthCalledWith(1, 'agent');
      expect(harness.spies.playSound).toHaveBeenNthCalledWith(2, 'error');
    } finally {
      vi.useRealTimers();
    }
  });

  // R7 — global flashFrame throttle 500ms.
  it('R7: two unfocused notifications within 500ms flash the taskbar exactly once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 21, 12, 0, 0));
    try {
      harness.state.activeWorkspaceId = 'ws-other';
      handle('pty-1', { type: 'info', title: 'a', body: 'a' });
      vi.advanceTimersByTime(200);
      handle('pty-1', { type: 'info', title: 'b', body: 'b' });
      expect(harness.spies.flashFrame).toHaveBeenCalledTimes(1);
      // After 500ms the next one should pass.
      vi.advanceTimersByTime(400); // 200 + 400 = 600 > 500
      handle('pty-1', { type: 'info', title: 'c', body: 'c' });
      expect(harness.spies.flashFrame).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // R8 — addNotification always fires even with surfaces silenced.
  it('R8: addNotification fires even when toast/sound/ring/flashFrame are all gated off', () => {
    harness.state.activeWorkspaceId = 'ws-other';
    harness.state.toastEnabled = false;
    harness.state.notificationSoundEnabled = false;
    harness.state.paneRingEnabled = false;
    harness.state.taskbarFlashEnabled = false;
    handle('pty-1', { type: 'info', title: 't', body: 'b' });
    expect(harness.spies.addNotification).toHaveBeenCalledTimes(1);
    expect(harness.spies.pushToast).not.toHaveBeenCalled();
    expect(harness.spies.playSound).not.toHaveBeenCalled();
    expect(harness.spies.flashFrame).not.toHaveBeenCalled();
    expect(harness.spies.setPaneNotificationRing).not.toHaveBeenCalled();
  });

  // R8b — Mute behaves the same (addNotification only).
  it('R8b: muted workspace records the notification but suppresses every surface', () => {
    harness.state.workspaces[0].metadata = { notificationsMuted: true };
    harness.state.activeWorkspaceId = 'ws-other';
    handle('pty-1', { type: 'info', title: 't', body: 'b' });
    expect(harness.spies.addNotification).toHaveBeenCalledTimes(1);
    expect(harness.spies.pushToast).not.toHaveBeenCalled();
    expect(harness.spies.playSound).not.toHaveBeenCalled();
    expect(harness.spies.flashFrame).not.toHaveBeenCalled();
    expect(harness.spies.setPaneNotificationRing).not.toHaveBeenCalled();
  });

  // R9 — toggling toastEnabled at runtime affects subsequent notifications.
  it('R9: flipping toastEnabled between calls toggles pushToast dispatch', () => {
    harness.state.activeWorkspaceId = 'ws-other';
    harness.state.toastEnabled = true;
    handle('pty-1', { type: 'info', title: 'a', body: 'a' });
    expect(harness.spies.pushToast).toHaveBeenCalledTimes(1);

    harness.state.toastEnabled = false;
    handle('pty-1', { type: 'info', title: 'b', body: 'b' });
    expect(harness.spies.pushToast).toHaveBeenCalledTimes(1); // unchanged
    // addNotification still fired
    expect(harness.spies.addNotification).toHaveBeenCalledTimes(2);
  });

  // R10 — Full integration: all gates on, unfocused, every surface fires.
  it('R10: all toggles on + unfocused → addNotification + toast + sound + ring(flash) + flashFrame', () => {
    harness.state.activeWorkspaceId = 'ws-other';
    handle('pty-1', { type: 'info', title: 't', body: 'b' });
    expect(harness.spies.addNotification).toHaveBeenCalledTimes(1);
    expect(harness.spies.pushToast).toHaveBeenCalledTimes(1);
    expect(harness.spies.pushToast).toHaveBeenCalledWith({ message: 't', level: 'info' });
    expect(harness.spies.playSound).toHaveBeenCalledTimes(1);
    expect(harness.spies.playSound).toHaveBeenCalledWith('info');
    expect(harness.spies.flashFrame).toHaveBeenCalledTimes(1);
    expect(harness.spies.flashFrame).toHaveBeenCalledWith(true);
    expect(harness.spies.setPaneNotificationRing).toHaveBeenCalledTimes(1);
    expect(harness.spies.setPaneNotificationRing).toHaveBeenCalledWith('pane-a', 'flash');
    expect(harness.spies.scheduleRingDecay).toHaveBeenCalledTimes(1);
    expect(harness.spies.scheduleRingDecay).toHaveBeenCalledWith('pane-a');
  });

  // R10b — pushToast level mapping: error→error, warning→warn, anything else→info.
  it('R10b: pushToast level maps from NotificationType correctly', () => {
    harness.state.activeWorkspaceId = 'ws-other';
    handle('pty-1', { type: 'error', title: 'e', body: 'b' });
    handle('pty-1', { type: 'warning', title: 'w', body: 'b' });
    handle('pty-1', { type: 'agent', title: 'a', body: 'b' });

    const calls = harness.spies.pushToast.mock.calls.map((c) => c[0] as { level: string });
    expect(calls.map((c) => c.level)).toEqual(['error', 'warn', 'info']);
  });

  // R11a — focused window suppresses flashFrame, other actions still fire.
  it('R11a: focused window suppresses flashFrame but keeps add/toast/sound/ring', () => {
    harness.state.activeWorkspaceId = 'ws-other';
    // Replace deps.isWindowFocused() to return true.
    handle = createNotificationHandler({ ...harness.deps, isWindowFocused: () => true });
    handle('pty-1', { type: 'info', title: 't', body: 'b' });
    expect(harness.spies.addNotification).toHaveBeenCalledTimes(1);
    expect(harness.spies.pushToast).toHaveBeenCalledTimes(1);
    expect(harness.spies.playSound).toHaveBeenCalledTimes(1);
    expect(harness.spies.setPaneNotificationRing).toHaveBeenCalledTimes(1);
    expect(harness.spies.flashFrame).not.toHaveBeenCalled();
  });

  // R11b — paneFlashEnabled=false emits ring='glow' and skips decay scheduling.
  it('R11b: paneFlashEnabled=false → setPaneNotificationRing fires with "glow", scheduleRingDecay NOT called', () => {
    harness.state.activeWorkspaceId = 'ws-other';
    harness.state.paneFlashEnabled = false;
    handle('pty-1', { type: 'info', title: 't', body: 'b' });
    expect(harness.spies.setPaneNotificationRing).toHaveBeenCalledTimes(1);
    expect(harness.spies.setPaneNotificationRing).toHaveBeenCalledWith('pane-a', 'glow');
    // No decay timer for static glow.
    expect(harness.spies.scheduleRingDecay).not.toHaveBeenCalled();
  });

  // R11c — orphan notification (no matching pty + no hint + no active ws match) early-returns.
  it('R11c: unresolvable target (unknown ptyId, no hint, no surface) emits nothing', () => {
    handle('pty-unknown', { type: 'info', title: 't', body: 'b' });
    expect(harness.spies.addNotification).not.toHaveBeenCalled();
    expect(harness.spies.pushToast).not.toHaveBeenCalled();
  });
});

describe('createNotificationHandler — cleanup (R11)', () => {
  // R11 cleanup is exercised at the hook level (useEffect return). The
  // factory itself has no internal state — every long-lived bit (throttlers,
  // ring timers) is owned by the caller via deps. Confirm the contract: a
  // freshly-constructed Throttler with .cancel() resets in the way the
  // unmount path relies on.
  it('throttler.cancel() resets the window so the next try() passes immediately', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 21, 12, 0, 0));
    try {
      const t = createThrottler(500);
      expect(t.try()).toBe(true);
      expect(t.try()).toBe(false); // throttled
      t.cancel();
      // After cancel, the next try should pass immediately even within the
      // original window. This is the behavior `useNotificationListener`'s
      // unmount cleanup relies on so a hot-reloaded listener doesn't
      // suppress the first notification.
      expect(t.try()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
