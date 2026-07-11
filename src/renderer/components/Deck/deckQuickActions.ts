// ─── Command Deck — quick-action chips (P3c) ─────────────────────────────────
//
// Canned-prompt chips above the Commander composer: the operations a human
// runs many times a day become one click instead of retyped prose. Each chip
// just sends a fixed prompt to the brain — no new IPC, no new permissions.
//
// The PR chip is the deliberate one: the brain has NO shell of its own (gh /
// Bash are absent from the D2 allow-list, on purpose), so its prompt tells the
// brain to DELEGATE — type the command into a worker pane with terminal_send
// and read the result back. Zero added grants, and the evidence stays visible
// in a pane the human can jump to.
//
// Pure + store-free so the chip set is unit-testable with plain objects.

import { buildRecoveryPrompt, type RecoveryPane } from './deckRecovery';

export interface DeckQuickAction {
  id: 'fleet-status' | 'pr-status' | 'recover-fleet';
  /** Chip label (already localized by the builder). */
  label: string;
  /** The canned prompt this chip sends to the brain. */
  prompt: string;
}

/** Fleet health in one glance — the brain reads each pane's screen. */
export const FLEET_STATUS_PROMPT = [
  'Give me a fleet status report. For each agent pane, read its screen with',
  'terminal_read and summarize it in one line: what it is working on, and',
  'whether it is running, waiting for input, idle, or showing an error.',
  'Lead with anything that needs my attention.',
].join('\n');

/** PR overview via DELEGATION — the brain has no shell (D2), so it must run
 *  `gh pr status` through a worker pane and read the output back. */
export const PR_STATUS_PROMPT = [
  "Check the status of this project's open pull requests. You have no shell of",
  'your own — delegate: find a pane sitting at a shell prompt and run',
  '`gh pr status` there with terminal_send (submit: true), then read the output',
  'with terminal_read. If every pane is busy or running an agent, ask an idle',
  'agent pane to check and report back instead. Summarize per PR: title, CI',
  'state, review state, and anything blocked on me.',
].join('\n');

/**
 * The chip set for the current deck state. `recover-fleet` appears only while
 * recoverable panes exist — it is the re-entry path after the greeting card
 * was dismissed (the card hides forever; the chip keeps the one-click recovery
 * reachable until the fleet is actually back).
 */
export function buildQuickActions(args: {
  recoveryPanes: RecoveryPane[];
  t?: (key: string) => string;
}): DeckQuickAction[] {
  // Default to the empty string (not key-echo) so the English fallbacks apply
  // when no translator is supplied.
  const t = args.t ?? (() => '');
  const actions: DeckQuickAction[] = [
    {
      id: 'fleet-status',
      label: t('deck.qaFleetStatus') || 'Fleet status',
      prompt: FLEET_STATUS_PROMPT,
    },
    {
      id: 'pr-status',
      label: t('deck.qaPrStatus') || 'PR status',
      prompt: PR_STATUS_PROMPT,
    },
  ];
  if (args.recoveryPanes.length > 0) {
    actions.push({
      id: 'recover-fleet',
      label: t('deck.recoveryRun') || 'Recover fleet',
      prompt: buildRecoveryPrompt(args.recoveryPanes),
    });
  }
  return actions;
}
