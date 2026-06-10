/**
 * Idle clearing for xterm's hidden IME textarea (issue #167).
 *
 * Why this exists:
 *   xterm.js only clears its hidden helper textarea on blur (and on paste).
 *   Text committed through an IME composition therefore stays in
 *   `textarea.value` after it has already been sent to the PTY: type `abc`
 *   through an IME and the shell has `abc`, but the textarea still says
 *   `abc` for as long as the pane keeps focus.
 *
 *   External input tools that treat the focused element as an ordinary edit
 *   field then "replace" that residue instead of inserting at the caret —
 *   AutoGLM's voice input does this — and every replacement style is
 *   destructive (verified dynamically in scripts/issue-167-ime-wipe-dynamic.mjs
 *   against the real xterm 6.0 bundle; reported upstream as
 *   xtermjs/xterm.js#6012):
 *     • backspace-clear: xterm forwards one DEL (\x7f) per leftover char,
 *       erasing the user's already-typed line (the reported symptom),
 *     • programmatic value swap + keyCode 229: CompositionHelper's diff path
 *       emits a stray DEL and silently drops the new text,
 *     • TSF replacement-range composition: the stale composition start
 *       position slices the committed text.
 *
 *   Keeping the textarea empty while no composition is active removes the
 *   residue, so a field-replacing injector sees nothing to replace and its
 *   text simply inserts.
 *
 * Race safety — xterm reads `textarea.value` in two `setTimeout(0)` paths,
 * and clearing inside either window would corrupt input, so the clear is
 * debounced and re-armed by the events that open those windows:
 *   1. CompositionHelper finalize (compositionend → setTimeout(0) → read):
 *      `compositionstart` cancels any pending clear, and the clear scheduled
 *      by `compositionend` fires a full delay after the finalize read.
 *   2. CompositionHelper._handleAnyTextareaChanges (keydown 229 → captures
 *      oldValue → setTimeout(0) → diffs newValue): every keydown re-arms the
 *      timer, so no clear can fire between a keydown and its 0ms diff.
 *   3. Right-click copy parks the selection text in the textarea and selects
 *      it for the context menu; a non-collapsed selection skips the clear.
 *
 * NOT attached when screenReaderMode is enabled — xterm intentionally
 * retains the textarea text until blur so screen readers can announce it
 * (see CoreBrowserTerminal._handleTextAreaBlur). The call site gates this.
 */

/** Structural subset of HTMLTextAreaElement the guard touches (node-testable). */
export interface ImeResidueGuardTextarea {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Structural subset of xterm's Terminal the guard needs. */
export interface ImeResidueGuardTerminal {
  textarea: ImeResidueGuardTextarea | undefined;
  onData(handler: (data: string) => void): { dispose(): void };
}

/**
 * Idle delay before clearing. Must comfortably exceed xterm's internal
 * setTimeout(0) reads (see "Race safety" above); beyond that the exact value
 * only bounds how soon after the last input an external injector observes an
 * empty field. Voice input always arrives seconds after typing stops.
 */
export const IME_RESIDUE_CLEAR_DELAY_MS = 150;

export function attachImeResidueGuard(
  terminal: ImeResidueGuardTerminal,
  delayMs: number = IME_RESIDUE_CLEAR_DELAY_MS,
): { dispose(): void } {
  const textarea = terminal.textarea;
  if (!textarea) {
    return { dispose: () => undefined };
  }

  let composing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      if (composing) return;
      if (textarea.selectionStart !== textarea.selectionEnd) return;
      if (textarea.value.length === 0) return;
      textarea.value = '';
    }, delayMs);
  };

  const onCompositionStart = (): void => {
    composing = true;
    cancel();
  };
  const onCompositionEnd = (): void => {
    composing = false;
    schedule();
  };
  // Re-arm on every keydown so a pending clear can never fire inside the
  // keydown→setTimeout(0) window of CompositionHelper's 229 diff path.
  const onKeyDown = (): void => {
    if (!composing) schedule();
  };

  textarea.addEventListener('compositionstart', onCompositionStart);
  textarea.addEventListener('compositionend', onCompositionEnd);
  textarea.addEventListener('keydown', onKeyDown);
  const dataDisposable = terminal.onData(() => {
    if (!composing) schedule();
  });

  return {
    dispose: (): void => {
      cancel();
      textarea.removeEventListener('compositionstart', onCompositionStart);
      textarea.removeEventListener('compositionend', onCompositionEnd);
      textarea.removeEventListener('keydown', onKeyDown);
      dataDisposable.dispose();
    },
  };
}
