// ─── Command Deck — Commander brain IPC handler (Phase 2, P2c) ───────────────
//
// The thin Electron shell that wires a real ClaudeSdkAdapter + a webContents
// event sink into the (transport-agnostic) CommanderSessionManager. Registered
// with ipcMain.handle — a RENDERER-ONLY surface, unreachable from the daemon
// pipe / a same-user MCP client (the identical process-boundary trust basis
// channelLocal.handler + fanout.handler rely on).
//
// The manager (and its brain subprocess) is created LAZILY on the first
// deck:send: the SDK only spawns when the human actually commands the fleet, so
// idle wmux sessions pay nothing. The renderer supplies the one-shot fleet
// snapshot (`fleetContext`) with that first send — main has no store, the
// renderer owns the live pane/channel projection.

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
   *  `model` is the orchestrator model override ('' → SDK default). */
  createAdapter?: (opts?: { model?: string }) => BrainAdapter;
}

/** Fleet-context token budget (~2KB). A larger snapshot is truncated so the
 *  one-shot injection can't blow the turn's context. */
const FLEET_CONTEXT_MAX_CHARS = 2048;

export function registerDeckHandler(
  getWindow: GetWindow,
  opts: RegisterDeckHandlerOptions = {},
): () => void {
  const createAdapter =
    opts.createAdapter ??
    ((adapterOpts?: { model?: string }) =>
      new ClaudeSdkAdapter(adapterOpts?.model ? { model: adapterOpts.model } : {}));

  // Single Commander session for the whole app (Phase 2 = single commander).
  let manager: CommanderSessionManager | null = null;
  // The model the live manager's adapter was created with ('' = SDK default).
  let managerModel = '';

  const emit = (event: BrainEvent): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC.DECK_STREAM, event);
  };

  const ensureManager = (fleetContext?: string, model = ''): CommanderSessionManager => {
    // Model changed in Settings: swap the brain between turns. The adapter is
    // per-model (the SDK subprocess pins --model at spawn), but the
    // CONVERSATION survives — the new adapter resumes the persisted session
    // id, so this is a model switch mid-thread, not a new thread. Never swap
    // while a turn streams: the busy manager keeps running and the send below
    // gets the normal `busy` reject; the new model applies on the next send.
    if (manager && model !== managerModel && manager.getStatus().status !== 'busy') {
      manager.dispose();
      manager = null;
    }
    if (!manager) {
      managerModel = model;
      // P3a: resume the persisted conversation from the previous app run. A
      // dead id is soft — the adapter falls back to a fresh session.
      const persisted = loadCommanderSession();
      manager = new CommanderSessionManager({
        adapter: createAdapter(model ? { model } : {}),
        sink: emit,
        startOptions: {
          systemPrompt: buildCommanderSystemPrompt(),
          ...(fleetContext ? { fleetContext } : {}),
          ...(persisted ? { resumeSessionId: persisted.sessionId } : {}),
        },
        onSessionId: (sessionId) => {
          // Fire-and-forget: a failed persist only costs continuity next run.
          void saveCommanderSession(sessionId).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn('[deck] failed to persist commander session id:', err);
          });
        },
      });
    }
    return manager;
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
      let fleetContext = typeof req.fleetContext === 'string' ? req.fleetContext : undefined;
      if (fleetContext && fleetContext.length > FLEET_CONTEXT_MAX_CHARS) {
        fleetContext = fleetContext.slice(0, FLEET_CONTEXT_MAX_CHARS) + '\n…(truncated)';
      }
      // Model override: sanitize to a plausible model token — this ends up on
      // the SDK subprocess command line, so reject anything but [A-Za-z0-9._-].
      const rawModel = typeof req.model === 'string' ? req.model.trim() : '';
      const model = /^[A-Za-z0-9._-]{1,64}$/.test(rawModel) ? rawModel : '';
      const mgr = ensureManager(fleetContext, model);
      // Awaits the full turn (events stream over DECK_STREAM meanwhile); the
      // resolved value is only the accept/reject verdict.
      return mgr.send(text);
    }),
  );

  ipcMain.removeHandler(IPC.DECK_INTERRUPT);
  ipcMain.handle(
    IPC.DECK_INTERRUPT,
    wrapHandler(IPC.DECK_INTERRUPT, async (): Promise<{ ok: true }> => {
      manager?.interrupt();
      return { ok: true };
    }),
  );

  ipcMain.removeHandler(IPC.DECK_STATUS);
  ipcMain.handle(
    IPC.DECK_STATUS,
    wrapHandler(IPC.DECK_STATUS, async (): Promise<CommanderStatusSnapshot> => {
      return manager?.getStatus() ?? { status: 'idle', sessionId: null };
    }),
  );

  // ── P3d: orchestrator schedules ─────────────────────────────────────────
  // The tick loop fires due schedules as ordinary brain turns (streamed over
  // DECK_STREAM like any typed command). A scheduled turn reuses the live
  // manager — and its model — or lazily creates one exactly like deck:send.
  const scheduler = new DeckScheduler({
    runTurn: (prompt) => {
      const mgr = ensureManager(undefined, managerModel);
      // A main-originated turn has no renderer-side optimistic message, so the
      // stream would hit a thread with no open turn and be dropped. Announce
      // the turn first — but only when the manager will actually accept it
      // (a busy reject must not open a phantom stuck-streaming bubble). The
      // status check and send are one synchronous sequence, so nothing can
      // interleave between them.
      if (mgr.getStatus().status !== 'idle') {
        return Promise.resolve({ ok: false, code: 'busy' as const });
      }
      emit({ type: 'turn-start', prompt });
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
      const schedules = loadDeckSchedules();
      if (schedules.length >= DECK_SCHEDULE_LIMITS.MAX_SCHEDULES) {
        return { ok: false, code: 'limit' };
      }
      const schedule = createSchedule({
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
      // Only `enabled` is mutable in this cut (pause/resume). Re-enabling a
      // fired one-shot re-arms it at its original time — immediately due.
      if (typeof req.enabled === 'boolean') schedules[idx] = { ...schedules[idx], enabled: req.enabled };
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

  // Guarantee the brain subprocess is torn down on quit even if the caller
  // forgets to invoke the returned cleanup.
  const disposeOnQuit = (): void => manager?.dispose();
  app.once('before-quit', disposeOnQuit);

  return () => {
    app.removeListener('before-quit', disposeOnQuit);
    scheduler.stop();
    manager?.dispose();
    manager = null;
    ipcMain.removeHandler(IPC.DECK_SEND);
    ipcMain.removeHandler(IPC.DECK_INTERRUPT);
    ipcMain.removeHandler(IPC.DECK_STATUS);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_LIST);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_CREATE);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_UPDATE);
    ipcMain.removeHandler(IPC.DECK_SCHEDULES_DELETE);
  };
}
