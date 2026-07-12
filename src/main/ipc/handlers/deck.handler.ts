// ─── Command Deck — Commander brain IPC handler (Phase 2, per-ws M1.5) ───────
//
// The thin Electron shell that wires real ClaudeSdkAdapters + a webContents
// event sink into (transport-agnostic) CommanderSessionManagers. Registered
// with ipcMain.handle — a RENDERER-ONLY surface, unreachable from the daemon
// pipe / a same-user MCP client (the identical process-boundary trust basis
// channelLocal.handler + fanout.handler rely on).
//
// M1.5: ONE ORCHESTRATOR PER WORKSPACE ("my assistant per project"). The
// single fleet-wide manager became a wsId-keyed map — each workspace gets its
// own conversation, its own busy state (true parallelism: ws-2 never queues
// behind ws-1's turn), and a commander token confined to its own panes.
// Managers are still created LAZILY on a workspace's first deck:send, so idle
// workspaces (and idle wmux sessions) pay nothing. Every DECK_STREAM push is
// enveloped with its workspaceId so the renderer routes events to the right
// per-workspace thread.
//
// The renderer supplies the active workspaceId with every call. That is the
// same renderer-trust basis as the rest of this surface — but the value is
// format-checked because it keys maps and persisted files.

import { ipcMain, app, type BrowserWindow } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type { BrainAdapter, BrainEvent } from '../../deck/BrainAdapter';
import { ClaudeSdkAdapter, buildCommanderSystemPrompt } from '../../deck/ClaudeSdkAdapter';
import {
  CommanderSessionManager,
  type CommanderSendResult,
  type CommanderStatusSnapshot,
} from '../../deck/CommanderSessionManager';
import { loadCommanderSession, saveCommanderSession } from '../../deck/commanderSessionStore';
import { DeckScheduler } from '../../deck/DeckScheduler';
import {
  loadDeckSchedules,
  saveDeckSchedules,
  createSchedule,
  DECK_SCHEDULE_LIMITS,
  type DeckSchedule,
} from '../../deck/deckScheduleStore';

type GetWindow = () => BrowserWindow | null;

export interface RegisterDeckHandlerOptions {
  /** Adapter factory — injected in tests so no SDK subprocess spawns. Defaults
   *  to a fresh ClaudeSdkAdapter (subscription Claude, wmux MCP auto-mounted).
   *  `model` is the orchestrator model override ('' → SDK default);
   *  `workspaceId` binds the commander token to the one workspace this brain
   *  serves. */
  createAdapter?: (opts: { model?: string; workspaceId: string }) => BrainAdapter;
}

/** Fleet-context token budget (~2KB). A larger snapshot is truncated so the
 *  one-shot injection can't blow the turn's context. */
const FLEET_CONTEXT_MAX_CHARS = 2048;

/** Workspace ids key maps and persisted JSON — reject anything that isn't a
 *  plausible id token before it can become a key. */
const WORKSPACE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function registerDeckHandler(
  getWindow: GetWindow,
  opts: RegisterDeckHandlerOptions = {},
): () => void {
  const createAdapter =
    opts.createAdapter ??
    ((adapterOpts: { model?: string; workspaceId: string }) =>
      new ClaudeSdkAdapter({
        workspaceId: adapterOpts.workspaceId,
        ...(adapterOpts.model ? { model: adapterOpts.model } : {}),
      }));

  // One Commander session per workspace (M1.5), created lazily on that
  // workspace's first send.
  interface ManagedCommander {
    manager: CommanderSessionManager;
    /** The model the manager's adapter was created with ('' = SDK default). */
    model: string;
  }
  const managers = new Map<string, ManagedCommander>();

  const emit = (workspaceId: string, event: BrainEvent): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.DECK_STREAM, { workspaceId, event });
    }
  };

  const ensureManager = (
    workspaceId: string,
    fleetContext?: string,
    model = '',
  ): CommanderSessionManager => {
    // Model changed in Settings: swap that workspace's brain between turns.
    // The adapter is per-model (the SDK subprocess pins --model at spawn), but
    // the CONVERSATION survives — the new adapter resumes the persisted
    // session id, so this is a model switch mid-thread, not a new thread.
    // Never swap while a turn streams: the busy manager keeps running and the
    // send below gets the normal `busy` reject; the new model applies on the
    // next send.
    const existing = managers.get(workspaceId);
    if (existing && model !== existing.model && existing.manager.getStatus().status !== 'busy') {
      existing.manager.dispose();
      managers.delete(workspaceId);
    }
    const current = managers.get(workspaceId);
    if (current) return current.manager;
    // P3a: resume this workspace's persisted conversation from the previous
    // app run. A dead id is soft — the adapter falls back to a fresh session.
    const persisted = loadCommanderSession(workspaceId);
    const manager = new CommanderSessionManager({
      adapter: createAdapter({ workspaceId, ...(model ? { model } : {}) }),
      sink: (event) => emit(workspaceId, event),
      startOptions: {
        systemPrompt: buildCommanderSystemPrompt(),
        ...(fleetContext ? { fleetContext } : {}),
        ...(persisted ? { resumeSessionId: persisted.sessionId } : {}),
      },
      onSessionId: (sessionId) => {
        // Fire-and-forget: a failed persist only costs continuity next run.
        void saveCommanderSession(workspaceId, sessionId).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[deck] failed to persist commander session id:', err);
        });
      },
    });
    managers.set(workspaceId, { manager, model });
    return manager;
  };

  const readWorkspaceId = (req: Record<string, unknown>): string | null => {
    const raw = typeof req.workspaceId === 'string' ? req.workspaceId : '';
    return WORKSPACE_ID_RE.test(raw) ? raw : null;
  };

  ipcMain.removeHandler(IPC.DECK_SEND);
  ipcMain.handle(
    IPC.DECK_SEND,
    wrapHandler(IPC.DECK_SEND, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<CommanderSendResult> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const text = typeof req.text === 'string' ? req.text : '';
      if (!text.trim()) return { ok: false, code: 'empty' };
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false, code: 'invalid_workspace' };
      let fleetContext = typeof req.fleetContext === 'string' ? req.fleetContext : undefined;
      if (fleetContext && fleetContext.length > FLEET_CONTEXT_MAX_CHARS) {
        fleetContext = fleetContext.slice(0, FLEET_CONTEXT_MAX_CHARS) + '\n…(truncated)';
      }
      // Model override: sanitize to a plausible model token — this ends up on
      // the SDK subprocess command line, so reject anything but [A-Za-z0-9._-].
      const rawModel = typeof req.model === 'string' ? req.model.trim() : '';
      const model = /^[A-Za-z0-9._-]{1,64}$/.test(rawModel) ? rawModel : '';
      const mgr = ensureManager(workspaceId, fleetContext, model);
      // Awaits the full turn (events stream over DECK_STREAM meanwhile); the
      // resolved value is only the accept/reject verdict.
      return mgr.send(text);
    }),
  );

  ipcMain.removeHandler(IPC.DECK_INTERRUPT);
  ipcMain.handle(
    IPC.DECK_INTERRUPT,
    wrapHandler(IPC.DECK_INTERRUPT, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: true }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (workspaceId) managers.get(workspaceId)?.manager.interrupt();
      return { ok: true };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_STATUS);
  ipcMain.handle(
    IPC.DECK_STATUS,
    wrapHandler(IPC.DECK_STATUS, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<CommanderStatusSnapshot> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      const mgr = workspaceId ? managers.get(workspaceId)?.manager : undefined;
      return mgr?.getStatus() ?? { status: 'idle', sessionId: null };
    }),
  );

  // ── P3d: orchestrator schedules ─────────────────────────────────────────
  // The tick loop fires due schedules as ordinary brain turns on their OWN
  // workspace's orchestrator (streamed over DECK_STREAM like any typed
  // command). A scheduled turn reuses that workspace's live manager — and its
  // model — or lazily creates one exactly like deck:send.
  const scheduler = new DeckScheduler({
    runTurn: (prompt, workspaceId) => {
      if (!WORKSPACE_ID_RE.test(workspaceId)) {
        return Promise.resolve({ ok: false, code: 'invalid_workspace' as const });
      }
      const mgr = ensureManager(workspaceId, undefined, managers.get(workspaceId)?.model ?? '');
      // A main-originated turn has no renderer-side optimistic message, so the
      // stream would hit a thread with no open turn and be dropped. Announce
      // the turn first — but only when the manager will actually accept it
      // (a busy reject must not open a phantom stuck-streaming bubble). The
      // status check and send are one synchronous sequence, so nothing can
      // interleave between them.
      if (mgr.getStatus().status !== 'idle') {
        return Promise.resolve({ ok: false, code: 'busy' as const });
      }
      emit(workspaceId, { type: 'turn-start', prompt });
      return mgr.send(prompt);
    },
  });
  scheduler.start();

  ipcMain.removeHandler(IPC.DECK_SCHEDULES_LIST);
  ipcMain.handle(
    IPC.DECK_SCHEDULES_LIST,
    wrapHandler(IPC.DECK_SCHEDULES_LIST, async (): Promise<{ schedules: DeckSchedule[] }> => {
      return { schedules: loadDeckSchedules() };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_SCHEDULES_CREATE);
  ipcMain.handle(
    IPC.DECK_SCHEDULES_CREATE,
    wrapHandler(IPC.DECK_SCHEDULES_CREATE, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean; schedule?: DeckSchedule; code?: string }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const workspaceId = readWorkspaceId(req);
      if (!workspaceId) return { ok: false, code: 'invalid_workspace' };
      const schedules = loadDeckSchedules();
      if (schedules.length >= DECK_SCHEDULE_LIMITS.MAX_SCHEDULES) {
        return { ok: false, code: 'limit' };
      }
      const schedule = createSchedule({
        workspaceId,
        prompt: typeof req.prompt === 'string' ? req.prompt : '',
        nextRunAt: typeof req.nextRunAt === 'number' ? req.nextRunAt : NaN,
        ...(typeof req.intervalMinutes === 'number' ? { intervalMinutes: req.intervalMinutes } : {}),
      });
      if (!schedule) return { ok: false, code: 'invalid' };
      await saveDeckSchedules([...schedules, schedule]);
      return { ok: true, schedule };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_SCHEDULES_UPDATE);
  ipcMain.handle(
    IPC.DECK_SCHEDULES_UPDATE,
    wrapHandler(IPC.DECK_SCHEDULES_UPDATE, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean; code?: string }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const id = typeof req.id === 'string' ? req.id : '';
      const schedules = loadDeckSchedules();
      const idx = schedules.findIndex((s) => s.id === id);
      if (idx === -1) return { ok: false, code: 'not_found' };
      let next = schedules[idx];
      // Re-scoping: a pre-M1.5 schedule (no workspaceId) may be assigned one —
      // exactly once. Owned schedules never migrate between workspaces (delete
      // and recreate instead: the prompt was written for that project).
      const workspaceId = readWorkspaceId(req);
      if (workspaceId && !next.workspaceId) next = { ...next, workspaceId };
      // `enabled` is mutable (pause/resume). Re-enabling a fired one-shot
      // re-arms it at its original time — immediately due. Enabling a schedule
      // that still has no workspace is rejected: there is no orchestrator to
      // run it on.
      if (typeof req.enabled === 'boolean') {
        if (req.enabled && !next.workspaceId) return { ok: false, code: 'no_workspace' };
        next = { ...next, enabled: req.enabled };
      }
      schedules[idx] = next;
      await saveDeckSchedules(schedules);
      return { ok: true };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_SCHEDULES_DELETE);
  ipcMain.handle(
    IPC.DECK_SCHEDULES_DELETE,
    wrapHandler(IPC.DECK_SCHEDULES_DELETE, async (
      _event: Electron.IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<{ ok: boolean }> => {
      const req = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? (raw as Record<string, unknown>)
        : {};
      const id = typeof req.id === 'string' ? req.id : '';
      const schedules = loadDeckSchedules();
      await saveDeckSchedules(schedules.filter((s) => s.id !== id));
      return { ok: true };
    }),
  );

  const disposeAll = (): void => {
    for (const { manager } of managers.values()) manager.dispose();
    managers.clear();
  };

  // Guarantee the brain subprocesses are torn down on quit even if the caller
  // forgets to invoke the returned cleanup.
  app.once('before-quit', disposeAll);

  return () => {
    app.removeListener('before-quit', disposeAll);
    scheduler.stop();
    disposeAll();
    ipcMain.removeHandler(IPC.DECK_SEND);
    ipcMain.removeHandler(IPC.DECK_INTERRUPT);
    ipcMain.removeHandler(IPC.DECK_STATUS);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_LIST);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_CREATE);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_UPDATE);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_DELETE);
  };
}
