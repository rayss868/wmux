/**
 * Leading-edge throttle factory.
 *
 * The first `try()` after construction (or after `cancel()`) passes immediately
 * and starts the window. Subsequent `try()` calls within `ms` of that last
 * accepted call return false. Once the window elapses, the next `try()` passes
 * and becomes the new anchor.
 *
 * Used by the notification pipeline to rate-limit sound, flashFrame, and ring
 * emissions without a module-scope mutable map (which leaked state across
 * tests in the original useNotificationListener implementation).
 *
 * Closure-based so each call site gets its own isolated state — pass the
 * handle through `useMemo` and reset it in the `useEffect` cleanup via
 * `cancel()`.
 */

export interface Throttler {
  /** Returns true if call is allowed (window has elapsed since last try). Returns false if currently throttled. */
  try(): boolean;
  /** Reset internal state so the next try() returns true immediately. Used as useEffect cleanup. */
  cancel(): void;
}

/** Create a leading-edge throttler with the given window in milliseconds. */
export function createThrottler(ms: number): Throttler {
  let lastTime: number | null = null;

  const tryFn = (): boolean => {
    const now = Date.now();
    if (lastTime !== null && now - lastTime < ms) return false;
    lastTime = now;
    return true;
  };

  const cancel = (): void => {
    lastTime = null;
  };

  return { try: tryFn, cancel };
}
