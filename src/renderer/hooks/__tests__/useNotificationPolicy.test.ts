/**
 * T7 — useNotificationPolicy.test.ts
 *
 * Pure unit tests for `decideNotificationActions`. Vitest's default `node`
 * environment is sufficient — no DOM, no zustand, no IPC mocks. Every gate
 * combination is pinned here so the listener integration tests (T8) can
 * trust the policy and focus on dispatch + throttle plumbing.
 */

import { describe, it, expect } from 'vitest';
import {
  decideNotificationActions,
  type NotifPayload,
  type PolicyContext,
} from '../useNotificationPolicy';

const samplePayload: NotifPayload = {
  type: 'info',
  title: 'sample title',
  body: 'sample body',
};
const sampleTarget = { workspaceId: 'ws-1', surfaceId: 'sf-1' };

/**
 * Default "all toggles on, window focused, inactive pane, not muted, pane
 * id resolved" context. Each test below overrides only the fields it cares
 * about — keeps the cases readable without obscuring which knob is being
 * tested.
 */
function baseCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  const defaults: PolicyContext = {
    windowFocused: true,
    isActiveSurface: false,
    isMutedWorkspace: false,
    paneId: 'pane-1',
    settings: {
      toastEnabled: true,
      notificationSoundEnabled: true,
      notificationSoundChoice: 'default',
      paneRingEnabled: true,
      paneFlashEnabled: true,
      taskbarFlashEnabled: true,
    },
  };
  return {
    ...defaults,
    ...overrides,
    settings: { ...defaults.settings, ...(overrides.settings ?? {}) },
  };
}

describe('decideNotificationActions', () => {
  // C1
  it('returns [] when the target IS the active surface', () => {
    const result = decideNotificationActions(samplePayload, sampleTarget, baseCtx({ isActiveSurface: true }));
    expect(result).toEqual([]);
  });

  // C2
  it('returns only addNotification when the workspace is muted (toggles ignored)', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ isMutedWorkspace: true }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('addNotification');
  });

  // C3
  it('happy path: focused window + inactive pane + all toggles on → add + toast + sound + ring(flash), NO flashFrame', () => {
    const result = decideNotificationActions(samplePayload, sampleTarget, baseCtx());
    expect(result.map((a) => a.kind)).toEqual([
      'addNotification',
      'pushToast',
      'playSound',
      'setPaneRing',
    ]);
    const ring = result.find((a) => a.kind === 'setPaneRing');
    if (ring && ring.kind === 'setPaneRing') {
      expect(ring.ring).toBe('flash');
      expect(ring.paneId).toBe('pane-1');
    }
  });

  // C4
  it('unfocused window with everything else equal → add + toast + sound + ring + flashFrame', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ windowFocused: false }),
    );
    expect(result.map((a) => a.kind)).toEqual([
      'addNotification',
      'pushToast',
      'playSound',
      'setPaneRing',
      'flashFrame',
    ]);
  });

  // C5
  it('toastEnabled=false suppresses pushToast', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ settings: { toastEnabled: false } as PolicyContext['settings'] }),
    );
    expect(result.some((a) => a.kind === 'pushToast')).toBe(false);
    expect(result[0].kind).toBe('addNotification');
  });

  // C6
  it('notificationSoundEnabled=false suppresses playSound', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ settings: { notificationSoundEnabled: false } as PolicyContext['settings'] }),
    );
    expect(result.some((a) => a.kind === 'playSound')).toBe(false);
  });

  // C7
  it('notificationSoundChoice="none" suppresses playSound even when the boolean is on', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({
        settings: {
          notificationSoundEnabled: true,
          notificationSoundChoice: 'none',
        } as PolicyContext['settings'],
      }),
    );
    expect(result.some((a) => a.kind === 'playSound')).toBe(false);
  });

  // C8
  it('paneRingEnabled=false suppresses setPaneRing', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ settings: { paneRingEnabled: false } as PolicyContext['settings'] }),
    );
    expect(result.some((a) => a.kind === 'setPaneRing')).toBe(false);
  });

  // C9
  it('paneFlashEnabled=false (ring on) emits setPaneRing with ring="glow"', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ settings: { paneFlashEnabled: false } as PolicyContext['settings'] }),
    );
    const ring = result.find((a) => a.kind === 'setPaneRing');
    expect(ring).toBeDefined();
    if (ring && ring.kind === 'setPaneRing') {
      expect(ring.ring).toBe('glow');
    }
  });

  // C10
  it('taskbarFlashEnabled=false suppresses flashFrame even when window is unfocused', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({
        windowFocused: false,
        settings: { taskbarFlashEnabled: false } as PolicyContext['settings'],
      }),
    );
    expect(result.some((a) => a.kind === 'flashFrame')).toBe(false);
  });

  // C11
  it('paneId=null suppresses setPaneRing regardless of toggles', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ paneId: null }),
    );
    expect(result.some((a) => a.kind === 'setPaneRing')).toBe(false);
    // Everything else still fires.
    expect(result.map((a) => a.kind)).toEqual(['addNotification', 'pushToast', 'playSound']);
  });

  // C12
  it('addNotification is always first in the returned action list', () => {
    // Three diverse cases — happy path, ring-only, sound-only.
    const cases: PolicyContext[] = [
      baseCtx(),
      baseCtx({ settings: { toastEnabled: false, notificationSoundEnabled: false, taskbarFlashEnabled: false } as PolicyContext['settings'] }),
      baseCtx({
        windowFocused: false,
        settings: { paneRingEnabled: false } as PolicyContext['settings'],
      }),
    ];
    for (const ctx of cases) {
      const result = decideNotificationActions(samplePayload, sampleTarget, ctx);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].kind).toBe('addNotification');
    }
  });

  // C13
  it('active-surface skip takes precedence over mute (still returns [] when both are true)', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ isActiveSurface: true, isMutedWorkspace: true }),
    );
    expect(result).toEqual([]);
  });

  // Extra — orderedness sanity for the full unfocused case.
  it('full unfocused happy path preserves a stable action order', () => {
    const result = decideNotificationActions(
      samplePayload,
      sampleTarget,
      baseCtx({ windowFocused: false }),
    );
    expect(result.map((a) => a.kind)).toEqual([
      'addNotification',
      'pushToast',
      'playSound',
      'setPaneRing',
      'flashFrame',
    ]);
  });

  // Extra — addNotification carries the target IDs verbatim.
  it('addNotification action carries workspaceId and surfaceId from the target', () => {
    const result = decideNotificationActions(samplePayload, sampleTarget, baseCtx());
    const add = result.find((a) => a.kind === 'addNotification');
    expect(add).toBeDefined();
    if (add && add.kind === 'addNotification') {
      expect(add.workspaceId).toBe('ws-1');
      expect(add.surfaceId).toBe('sf-1');
      expect(add.payload).toEqual(samplePayload);
    }
  });
});
