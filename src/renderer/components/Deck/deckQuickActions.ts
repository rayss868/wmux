// ─── Command Deck — recovery re-entry chip ───────────────────────────────────
//
// The deck's chip row is the orchestrator CONTROL bar (Mode · Loop · Schedules
// — the persistent automation controls, rendered directly in CommanderView).
// This builder produces the ONE ephemeral chip that lives alongside them: the
// reboot-recovery re-entry.
//
// After a reboot with recoverable panes, the greeting card offers one-click
// recovery. Once that card is dismissed it hides forever — this chip is the
// re-entry path so the human can still recover the fleet in one click until it
// is actually back. It carries the SAME canned prompt the card sends.
//
// (History: this builder used to also emit always-on "Agent status" / "PR
// status" canned-prompt chips. They were removed — the human types those asks
// directly, and the two chips were noise on a bar meant for controls, not
// canned prompts. Owner request 2026-07-14.)
//
// Pure + store-free so the chip set is unit-testable with plain objects.

import { buildRecoveryPrompt, type RecoveryPane } from './deckRecovery';

export interface DeckQuickAction {
  id: 'recover-fleet';
  /** Chip label (already localized by the builder). */
  label: string;
  /** The canned prompt this chip sends to the brain. */
  prompt: string;
}

/**
 * The chip set for the current deck state. `recover-fleet` appears only while
 * recoverable panes exist — it is the re-entry path after the greeting card
 * was dismissed (the card hides forever; the chip keeps the one-click recovery
 * reachable until the fleet is actually back). Empty otherwise.
 */
export function buildQuickActions(args: {
  recoveryPanes: RecoveryPane[];
  t?: (key: string) => string;
}): DeckQuickAction[] {
  // Default to the empty string (not key-echo) so the English fallbacks apply
  // when no translator is supplied.
  const t = args.t ?? (() => '');
  const actions: DeckQuickAction[] = [];
  if (args.recoveryPanes.length > 0) {
    actions.push({
      id: 'recover-fleet',
      label: t('deck.recoveryRun') || 'Recover agents',
      prompt: buildRecoveryPrompt(args.recoveryPanes),
    });
  }
  return actions;
}
