// Supervision state slice (X8 pane supervision) — renderer-side mirror of the
// daemon PaneSupervisor's per-session sticky status + restart count, keyed by
// ptyId. Drives the pane supervision badge and the pane-menu Stop/Rearm items.
//
// All fields are TRANSIENT — none enter buildSessionData's allowlist, so a
// saved session never replays a stale supervision verdict. The authoritative
// status lives in the daemon (persisted on the session meta); this slice is
// hydrated from `pty.list` on mount + on `daemon:connected`, then kept live by
// the AppLayout `pty.onSupervisionChanged` / `pty.onRestarted` subscriptions.

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';

export interface SupervisionEntry {
  status: 'armed' | 'stopped';
  restartCount: number;
}

export interface SupervisionSlice {
  /** Per-ptyId supervision state. Absent key = pane is not supervised. */
  supervisionByPtyId: Record<string, SupervisionEntry>;

  /** Set (or replace) a pane's supervision status. `restartCount` defaults to
   *  the current value when omitted so a status-only flip preserves the count. */
  setSupervision: (ptyId: string, status: 'armed' | 'stopped', restartCount?: number) => void;

  /** Bump a pane's restart count by one (status unchanged). Used by the
   *  `pty.onRestarted` listener — a restart never changes the armed status. */
  bumpSupervisionRestart: (ptyId: string) => void;

  /** Drop one pane's entry (pane/pty dispose). */
  clearSupervision: (ptyId: string) => void;

  /**
   * Replace the whole map from a boot/reconnect hydration snapshot. Entries
   * not present in `snapshot` are dropped (a session that lost its supervision
   * policy, or a stale ptyId from a prior daemon generation). Idempotent —
   * safe to call on every `daemon:connected`.
   */
  hydrateSupervision: (snapshot: Record<string, SupervisionEntry>) => void;
}

export const createSupervisionSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  SupervisionSlice
> = (set) => ({
  supervisionByPtyId: {},

  setSupervision: (ptyId, status, restartCount) => set((draft: StoreState) => {
    const prev = draft.supervisionByPtyId[ptyId];
    draft.supervisionByPtyId[ptyId] = {
      status,
      restartCount: restartCount ?? prev?.restartCount ?? 0,
    };
  }),

  bumpSupervisionRestart: (ptyId) => set((draft: StoreState) => {
    const prev = draft.supervisionByPtyId[ptyId];
    // A restart event for a pane we don't yet track (hydration race) seeds the
    // entry as armed — the daemon only restarts armed sessions, so 'armed' is
    // the correct initial status. The very next pty.list hydration corrects it
    // if the guard tripped on the same restart.
    draft.supervisionByPtyId[ptyId] = {
      status: prev?.status ?? 'armed',
      restartCount: (prev?.restartCount ?? 0) + 1,
    };
  }),

  clearSupervision: (ptyId) => set((draft: StoreState) => {
    delete draft.supervisionByPtyId[ptyId];
  }),

  hydrateSupervision: (snapshot) => set((draft: StoreState) => {
    draft.supervisionByPtyId = { ...snapshot };
  }),
});
