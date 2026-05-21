import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Notification } from '../../../shared/types';
import { generateId } from '../../../shared/types';

export interface NotificationSlice {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read'>) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  markAllReadForWorkspace: (workspaceId: string) => void;
  jumpToUnread: () => string | null;
  clearNotifications: () => void;
}

export const createNotificationSlice: StateCreator<StoreState, [['zustand/immer', never]], [], NotificationSlice> = (set, get) => ({
  notifications: [],

  addNotification: (notification) => set((state: StoreState) => {
    state.notifications.push({
      ...notification,
      id: generateId('notif'),
      timestamp: Date.now(),
      read: false,
    });
    // Cap 500 chosen for daemon long-running sessions; eviction prefers read entries (line 26-32).
    if (state.notifications.length > 500) {
      const readOld = state.notifications.findIndex((n) => n.read);
      if (readOld !== -1) {
        state.notifications.splice(readOld, 1);
      } else {
        // 모두 unread면 가장 오래된 것 제거
        state.notifications.shift();
      }
    }
    // Update workspace metadata lastNotification
    const ws = state.workspaces.find((w) => w.id === notification.workspaceId);
    if (ws) {
      if (!ws.metadata) ws.metadata = {};
      ws.metadata.lastNotification = Date.now();
    }
  }),

  markRead: (id) => set((state: StoreState) => {
    const notif = state.notifications.find((n) => n.id === id);
    if (notif) notif.read = true;
  }),

  markAllRead: () => set((state: StoreState) => {
    for (const n of state.notifications) {
      n.read = true;
    }
  }),

  markAllReadForWorkspace: (workspaceId) => set((state: StoreState) => {
    for (const n of state.notifications) {
      if (n.workspaceId === workspaceId) n.read = true;
    }
  }),

  jumpToUnread: () => {
    const state = get();
    const alive = new Set(state.workspaces.map((w) => w.id));
    let best: Notification | null = null;
    for (const n of state.notifications) {
      if (n.read) continue;
      if (!alive.has(n.workspaceId)) continue;
      if (best === null || n.timestamp > best.timestamp) {
        best = n;
      }
    }
    return best ? best.workspaceId : null;
  },

  clearNotifications: () => set((state: StoreState) => {
    state.notifications = [];
  }),
});
