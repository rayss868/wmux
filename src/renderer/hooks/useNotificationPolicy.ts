/**
 * T7 — Notification policy decision function.
 *
 * Pure (stateless, no React/store coupling) function that translates one
 * notification event + the current renderer settings into the ordered list
 * of side-effect actions the listener should execute. Despite the `use*`
 * filename, this is NOT a React hook — the prefix is preserved so the file
 * can live alongside `useNotificationListener.ts` (its sole consumer) and
 * future readers find it via the same `hooks/` naming convention.
 *
 * Rationale for the split (CEO stamp: "boil the lake"):
 * Before T7, every gating decision (active-surface skip, mute, toast/sound/
 * ring/flashFrame fan-out) lived inline in the listener's IPC subscribe
 * callback as a 40-line if/else cascade. That made each new gate require a
 * full integration test with mocked IPC + zustand store, and there were
 * zero unit tests pinning the gate logic itself. Extracting the policy:
 *   - keeps the listener thin (target resolution + dispatch only),
 *   - lets us pin every gate combination in a vitest unit test with no
 *     mocks, no jsdom, no IPC plumbing,
 *   - leaves throttle/debounce on the listener side because those need
 *     long-lived closure state (a stateless policy + a stateful listener
 *     compose cleanly).
 *
 * Action list semantics:
 *   - `addNotification` is the data-preservation action — it ALWAYS comes
 *     first and is the ONLY action emitted for muted workspaces. The
 *     listener relies on this ordering for the "data preserved, surfaces
 *     silent" promise (Policy A4 / T4).
 *   - All other actions (toast/sound/ring/flashFrame) are "surface" actions
 *     gated by user settings. Order between them is stable (the test suite
 *     pins it) but not load-bearing for correctness.
 *
 * Throttling: the policy is intentionally stateless. If `flashFrame` or
 * `playSound` appear in the returned list, the listener's per-call-site
 * `createThrottler` decides whether to actually execute them. Pushing
 * throttle logic into the policy would either (a) require the policy to
 * own mutable state, breaking its purity contract, or (b) require passing
 * throttler handles in via PolicyContext, which double-wires the listener's
 * internal throttler instances into every test fixture for no benefit.
 */

import type { NotificationType } from '../../shared/types';

/**
 * The shape the listener receives over IPC (notification.onNew). Defined
 * here, not re-exported from preload, so the policy stays decoupled from
 * Electron — the test suite can construct one of these directly without
 * having to mock window.electronAPI.
 */
export interface NotifPayload {
  type: NotificationType;
  title: string;
  body: string;
  /** Optional workspace hint. resolveNotificationTarget already used this. */
  workspaceId?: string;
}

/**
 * One side-effect the listener should execute. The listener fans out via a
 * switch on `kind`; new action variants only require adding a switch arm,
 * never a new policy gate inside the listener.
 *
 * `addNotification` payload mirrors the slice's `Omit<Notification, 'id' |
 * 'timestamp' | 'read'>` shape — the listener picks workspaceId + surfaceId
 * off the target and combines with the IPC payload at dispatch time.
 */
export type NotificationAction =
  | {
      kind: 'addNotification';
      payload: NotifPayload;
      workspaceId: string;
      surfaceId?: string;
    }
  | { kind: 'pushToast'; payload: NotifPayload }
  | { kind: 'playSound'; type: NotificationType }
  | { kind: 'flashFrame' }
  | { kind: 'setPaneRing'; paneId: string; ring: 'flash' | 'glow' };

/**
 * Everything the policy needs to decide, lifted out of the listener so the
 * policy stays pure. `paneId` is null for orphan notifications (no surface
 * match in any workspace tree) — `setPaneRing` is suppressed in that case
 * because the renderer has no target to highlight.
 */
export interface PolicyContext {
  /** `document.hasFocus()` at action-execution time. */
  windowFocused: boolean;
  /**
   * True when the resolved target surface IS the active pane's active
   * surface of the active workspace. We skip the entire notification in
   * that case — the user is already looking at the source and a toast/
   * ring/badge would just be noise.
   */
  isActiveSurface: boolean;
  /** Target workspace's metadata.notificationsMuted === true. */
  isMutedWorkspace: boolean;
  /**
   * Resolved pane id for the ring action. null when the notification has
   * no surface match (e.g. external MCP `notify` without ptyId or workspace
   * hint resolves to active workspace but not to a specific pane). The
   * policy still emits all other actions in that case; only setPaneRing
   * needs a concrete pane id.
   */
  paneId: string | null;
  settings: {
    toastEnabled: boolean;
    notificationSoundEnabled: boolean;
    notificationSoundChoice: 'default' | 'none';
    paneRingEnabled: boolean;
    paneFlashEnabled: boolean;
    taskbarFlashEnabled: boolean;
  };
}

/**
 * Translate one notification into its side-effect list.
 *
 * Priority order:
 *   1. Active-surface skip — return []. Highest precedence: even muted
 *      workspaces never reach here because the user is looking at the
 *      source already. The test suite pins this explicitly (C1, C13).
 *   2. Muted workspace — return [addNotification] only. Data is preserved
 *      in the panel, every surface action is suppressed regardless of
 *      individual toggles.
 *   3. Normal fan-out — addNotification first, then each surface action
 *      gated by its own setting.
 */
export function decideNotificationActions(
  payload: NotifPayload,
  target: { workspaceId: string; surfaceId?: string },
  ctx: PolicyContext,
): NotificationAction[] {
  // 1. Active surface — skip the notification entirely. The user can see
  //    the source terminal, so adding to the badge / popping a toast would
  //    be pure noise. This overrides every other gate including mute,
  //    because a user actively looking at a muted workspace's terminal
  //    still doesn't want a phantom notification logged for what they're
  //    already watching.
  if (ctx.isActiveSurface) {
    return [];
  }

  // The addNotification action is shared between the muted-only path and
  // the full fan-out path. Building it once keeps the workspaceId /
  // surfaceId wiring identical in both branches.
  const addAction: NotificationAction = {
    kind: 'addNotification',
    payload,
    workspaceId: target.workspaceId,
    surfaceId: target.surfaceId,
  };

  // 2. Muted workspace — record the notification (panel still shows it,
  //    badge math still ignores it via the mute flag), but every surface
  //    is silent. Independent of individual toggles by design (A4).
  if (ctx.isMutedWorkspace) {
    return [addAction];
  }

  // 3. Full fan-out. addNotification always leads — the listener relies
  //    on this for both the data-preservation contract and the
  //    workspace lastNotification metadata bump inside addNotification.
  const actions: NotificationAction[] = [addAction];

  if (ctx.settings.toastEnabled) {
    actions.push({ kind: 'pushToast', payload });
  }

  // Sound has two independent gates: the master boolean (legacy toggle)
  // AND the cue choice (T5 expansion). 'none' was added so the OS-toast
  // UI can offer a "silent" preset without forcing the user to also
  // disable the boolean — keeps the two settings concerns orthogonal.
  if (
    ctx.settings.notificationSoundEnabled &&
    ctx.settings.notificationSoundChoice === 'default'
  ) {
    actions.push({ kind: 'playSound', type: payload.type });
  }

  // Ring requires a concrete pane id. Orphan notifications (paneId=null)
  // skip the ring even when the toggle is on — there's nothing to draw a
  // ring around. Flash sub-animation is independently gated: when
  // paneFlashEnabled is false but the ring is on, we fall straight to
  // glow so the user still gets a static affordance without the pulse.
  if (ctx.settings.paneRingEnabled && ctx.paneId !== null) {
    actions.push({
      kind: 'setPaneRing',
      paneId: ctx.paneId,
      ring: ctx.settings.paneFlashEnabled ? 'flash' : 'glow',
    });
  }

  // Taskbar flash only when the window is OUT of focus. A focused window
  // doesn't need taskbar attention — Windows even rejects flashFrame()
  // on the active window. Also gated by user toggle.
  if (ctx.settings.taskbarFlashEnabled && !ctx.windowFocused) {
    actions.push({ kind: 'flashFrame' });
  }

  return actions;
}
