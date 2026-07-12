// ─── Command Deck — the one-click loop panel (loop engineering v1) ───────────
//
// The deck-side surface for the workspace loop: a compact toggle chip (lives
// with the quick-action chips) that expands an inline panel above the composer.
// No loop → the ONE-CLICK form (objective + optional done-when checklist +
// autonomy tier + cadence) whose single [Start loop] writes loop-state,
// autonomy caps and the cadence schedule in one action (DECK_LOOP_START).
// Loop exists → the status card (objective · N/M passing · status) with the
// OFF contract buttons ([pause]/[resume]/[stop] — caps drop to DEFAULT,
// schedule cleaned up, all main-side).
//
// v1 posture (plans/loop-engineering-adoption-2026-07-12.md): tier caps at
// `continue` — Full-auto/approval-press is NOT offered here; the checklist is
// HUMAN-authored, read-only context for the brain (no self-scoring); `done`
// never suppresses wakes — the human stops the loop with these buttons.
//
// Self-contained on purpose (the DeckSchedulesPanel pattern): all IPC goes
// through the injected `api` prop (defaulting to window.electronAPI.deck.loop
// in the container), so the whole panel unit-tests under jsdom with a fake api
// and zero store wiring. Renders nothing when the preload is absent.

import { useCallback, useEffect, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { WorkspaceLoopState, LoopTier } from '../../../main/deck/deckLoopStateStore';

export interface DeckLoopApi {
  get: (workspaceId: string) => Promise<{ loop: WorkspaceLoopState | null }>;
  start: (args: {
    workspaceId: string;
    objective: string;
    taskTexts?: string[];
    tier?: LoopTier;
    intervalMinutes?: number;
    iterations?: number;
  }) => Promise<{ ok: boolean; loop?: WorkspaceLoopState; code?: string }>;
  stop: (workspaceId: string) => Promise<{ ok: boolean }>;
  pause: (workspaceId: string) => Promise<{ ok: boolean }>;
  resume: (workspaceId: string) => Promise<{ ok: boolean }>;
}

/** Cadence choices (0 = event-driven only). Values respect main's 5-minute
 *  floor — anything lower is rejected there, never clamped silently. */
const CADENCE_OPTIONS: { minutes: number; labelKey: string; fallback: string }[] = [
  { minutes: 0, labelKey: 'deck.loopCadenceOff', fallback: 'Events only' },
  { minutes: 30, labelKey: 'deck.loopCadence30m', fallback: 'Every 30 min' },
  { minutes: 60, labelKey: 'deck.loopCadence1h', fallback: 'Every hour' },
  { minutes: 360, labelKey: 'deck.loopCadence6h', fallback: 'Every 6 hours' },
  { minutes: 1440, labelKey: 'deck.loopCadence24h', fallback: 'Every day' },
];

export function DeckLoopPanel({
  api,
  workspaceId,
  t: tProp,
}: {
  api?: DeckLoopApi;
  /** The workspace this deck view is bound to — the loop is per-workspace. */
  workspaceId?: string;
  t?: (key: string) => string;
}): React.ReactElement | null {
  const t = tProp ?? (() => '');
  // Optional-chain the whole path — window.electronAPI itself is absent under
  // jsdom and in dev shells without the preload.
  const resolvedApi =
    api ??
    (window.electronAPI as unknown as { deck?: { loop?: DeckLoopApi } } | undefined)?.deck?.loop;
  const [open, setOpen] = useState(false);
  const [loop, setLoop] = useState<WorkspaceLoopState | null>(null);
  const [objective, setObjective] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [tier, setTier] = useState<LoopTier>('report');
  const [cadence, setCadence] = useState(0);
  const [iterations, setIterations] = useState(25);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!resolvedApi || !workspaceId) return;
    try {
      const r = await resolvedApi.get(workspaceId);
      setLoop(r.loop);
    } catch {
      /* main gone — leave the stale view */
    }
  }, [resolvedApi, workspaceId]);

  // The chip label shows live loop state, so hydrate on mount and whenever the
  // deck rebinds to another workspace — not only when the panel opens.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!resolvedApi) return null;

  const handleStart = async (): Promise<void> => {
    setError(null);
    if (!workspaceId) {
      setError(t('deck.loopNoWorkspace') || 'Open a workspace first — a loop belongs to a workspace.');
      return;
    }
    if (!objective.trim()) {
      setError(t('deck.loopNeedsObjective') || 'Give the loop an objective.');
      return;
    }
    const taskTexts = doneWhen
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const res = await resolvedApi.start({
      workspaceId,
      objective,
      ...(taskTexts.length > 0 ? { taskTexts } : {}),
      tier,
      ...(cadence > 0 ? { intervalMinutes: cadence } : {}),
      ...(Number.isFinite(iterations) && iterations >= 1 ? { iterations: Math.floor(iterations) } : {}),
    });
    if (!res.ok) {
      setError(t('deck.loopStartFailed') || 'Could not start the loop.');
      return;
    }
    setObjective('');
    setDoneWhen('');
    void refresh();
  };

  const passing = loop ? loop.tasks.filter((task) => task.passes).length : 0;
  const running = loop?.status === 'running';

  return (
    <>
      <button
        type="button"
        data-deck-loop-toggle
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`px-2.5 py-1 rounded-md text-[12px] transition-opacity hover:opacity-80 ${
          open ? 'text-[var(--accent-blue)]' : 'text-[var(--text-sub)]'
        } bg-[rgba(var(--bg-surface-rgb),0.6)] ${FOCUS_RING}`}
        {...(open ? tokenAttrs('accent', 'text') : tokenAttrs('textSub', 'text'))}
      >
        {/* Amber dot = the loop is alive (running). Same meaning-class as the
            fleet running dots — counts once against the amber budget. */}
        {running && (
          <span
            aria-hidden="true"
            data-deck-loop-live-dot
            className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
            style={{ backgroundColor: 'var(--accent-blue)' }}
          />
        )}
        {loop
          ? `${t('deck.loop') || 'Loop'}${loop.tasks.length > 0 ? ` ${passing}/${loop.tasks.length}` : ''}${
              loop.status === 'paused' ? ` · ${t('deck.loopPaused') || 'paused'}` : ''
            }`
          : t('deck.loopStartChip') || 'Start a loop'}
      </button>

      {open && (
        <div
          data-deck-loop-panel
          className="w-full mt-1.5 rounded-[7px] px-4 py-3 space-y-2 bg-[rgba(var(--bg-surface-rgb),0.55)]"
        >
          {loop ? (
            <>
              {/* Status card — objective is the headline; machine facts in mono. */}
              <div className="flex items-baseline gap-2">
                <span
                  data-deck-loop-objective
                  className="flex-1 text-[12.5px] font-semibold text-[var(--text-main)] leading-relaxed break-words"
                  {...tokenAttrs('textMain', 'text')}
                >
                  {loop.objective}
                </span>
                <span
                  data-deck-loop-status
                  className="text-[10.5px] font-mono shrink-0 text-[var(--text-sub)]"
                  {...tokenAttrs('textSub', 'text')}
                >
                  {loop.status}
                  {loop.tasks.length > 0 ? ` · ${passing}/${loop.tasks.length}` : ''}
                </span>
              </div>
              {loop.tasks.length > 0 && (
                <div className="space-y-0.5" data-deck-loop-tasks>
                  {loop.tasks.map((task) => (
                    <div
                      key={task.id}
                      className={`text-[11.5px] font-mono leading-relaxed ${
                        task.passes ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-sub)]'
                      }`}
                      {...(task.passes ? tokenAttrs('textMuted', 'text') : tokenAttrs('textSub', 'text'))}
                    >
                      [{task.passes ? 'x' : ' '}] {task.text}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2 pt-1">
                {loop.status === 'paused' ? (
                  <button
                    type="button"
                    data-deck-loop-resume
                    onClick={() => {
                      if (workspaceId) void resolvedApi.resume(workspaceId).then(() => refresh());
                    }}
                    className={`px-2.5 py-1 rounded-[4px] text-[12px] font-semibold text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.8)] hover:text-[var(--accent-blue)] transition-colors ${FOCUS_RING}`}
                    {...tokenAttrs('textSub', 'text')}
                  >
                    {t('deck.loopResume') || 'Resume'}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-deck-loop-pause
                    onClick={() => {
                      if (workspaceId) void resolvedApi.pause(workspaceId).then(() => refresh());
                    }}
                    className={`px-2.5 py-1 rounded-[4px] text-[12px] text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.8)] hover:opacity-80 transition-opacity ${FOCUS_RING}`}
                    {...tokenAttrs('textSub', 'text')}
                  >
                    {t('deck.loopPause') || 'Pause'}
                  </button>
                )}
                <button
                  type="button"
                  data-deck-loop-stop
                  onClick={() => {
                    if (workspaceId) void resolvedApi.stop(workspaceId).then(() => refresh());
                  }}
                  className={`px-2.5 py-1 rounded-[4px] text-[12px] text-[var(--accent-red)] hover:opacity-80 transition-opacity ${FOCUS_RING}`}
                  {...tokenAttrs('danger', 'text')}
                >
                  {t('deck.loopStop') || 'Stop loop'}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* The one-click form. */}
              <input
                type="text"
                data-deck-loop-objective-input
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder={t('deck.loopObjectivePlaceholder') || 'Objective — what should this loop accomplish?'}
                className="w-full text-[12.5px] rounded-[4px] px-2.5 py-1.5 bg-[var(--bg-base)] text-[var(--text-main)] border focus:outline-none"
                style={{ borderColor: 'var(--border-soft)' }}
              />
              <textarea
                data-deck-loop-donewhen
                value={doneWhen}
                onChange={(e) => setDoneWhen(e.target.value)}
                rows={2}
                placeholder={t('deck.loopDoneWhenPlaceholder') || 'Done when… (optional, one item per line)'}
                className="w-full text-[11.5px] font-mono rounded-[4px] px-2.5 py-1.5 bg-[var(--bg-base)] text-[var(--text-main)] border focus:outline-none resize-y"
                style={{ borderColor: 'var(--border-soft)' }}
              />
              <div className="flex items-center gap-1.5">
                <select
                  data-deck-loop-tier
                  value={tier}
                  onChange={(e) => setTier(e.target.value === 'continue' ? 'continue' : 'report')}
                  className="text-[11px] font-mono rounded-[4px] px-1.5 py-1 bg-[var(--bg-base)] text-[var(--text-main)] border focus:outline-none"
                  style={{ borderColor: 'var(--border-soft)' }}
                  aria-label={t('deck.loopTier') || 'Autonomy'}
                >
                  <option value="report">{t('deck.loopTierReport') || 'Report only'}</option>
                  <option value="continue">{t('deck.loopTierContinue') || 'Continue (may nudge panes)'}</option>
                </select>
                <input
                  type="number"
                  data-deck-loop-iterations
                  value={iterations}
                  min={1}
                  max={100}
                  onChange={(e) => setIterations(Number(e.target.value))}
                  title={t('deck.loopIterations') || 'Iterations — auto-wakes allowed before the loop pauses for you'}
                  aria-label={t('deck.loopIterations') || 'Iterations'}
                  className="w-[52px] text-[11px] font-mono rounded-[4px] px-1.5 py-1 bg-[var(--bg-base)] text-[var(--text-main)] border focus:outline-none"
                  style={{ borderColor: 'var(--border-soft)' }}
                />
                <select
                  data-deck-loop-cadence
                  value={cadence}
                  onChange={(e) => setCadence(Number(e.target.value))}
                  className="text-[11px] font-mono rounded-[4px] px-1.5 py-1 bg-[var(--bg-base)] text-[var(--text-main)] border focus:outline-none"
                  style={{ borderColor: 'var(--border-soft)' }}
                  aria-label={t('deck.loopCadence') || 'Cadence'}
                >
                  {CADENCE_OPTIONS.map((o) => (
                    <option key={o.minutes} value={o.minutes}>
                      {t(o.labelKey) || o.fallback}
                    </option>
                  ))}
                </select>
                <div className="flex-1" />
                <button
                  type="button"
                  data-deck-loop-start
                  onClick={() => void handleStart()}
                  className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-[4px] text-[12px] font-semibold text-[var(--accent-blue)] bg-[rgba(var(--bg-surface-rgb),0.8)] hover:opacity-80 ${FOCUS_RING}`}
                  {...tokenAttrs('accent', 'text')}
                >
                  {t('deck.loopStart') || 'Start loop'}
                </button>
              </div>
              {error && (
                <div
                  role="alert"
                  data-deck-loop-error
                  className="text-[11.5px] text-[var(--accent-red)]"
                  {...tokenAttrs('danger', 'text')}
                >
                  {error}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

export default DeckLoopPanel;
