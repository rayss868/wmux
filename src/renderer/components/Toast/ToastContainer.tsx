/**
 * T4 — Toast container.
 *
 * Renders transient toasts from the `toastSlice`. Each toast auto-dismisses
 * after 5 seconds, and can be dismissed early via the close button.
 *
 * Intentionally minimal — uses existing CSS variables (--bg-mantle,
 * --accent-*, --text-main) so it inherits the active theme.
 */
import { useEffect } from 'react';
import { useStore } from '../../stores';
import type { ToastLevel } from '../../stores/slices/toastSlice';

const AUTO_DISMISS_MS = 5_000;

function levelColor(level: ToastLevel): string {
  switch (level) {
    case 'error':
      return 'var(--accent-red, #f38ba8)';
    case 'warn':
      return 'var(--accent-yellow, #f9e2af)';
    case 'info':
    default:
      return 'var(--accent-blue, #89b4fa)';
  }
}

function ToastItem({ id, message, level }: { id: string; message: string; level: ToastLevel }) {
  const dismissToast = useStore((s) => s.dismissToast);

  useEffect(() => {
    const t = setTimeout(() => dismissToast(id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [id, dismissToast]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 px-3 py-2 rounded-lg shadow-lg max-w-sm text-xs"
      style={{
        backgroundColor: 'var(--bg-mantle)',
        border: `1px solid ${levelColor(level)}`,
        color: 'var(--text-main)',
      }}
    >
      <span
        className="inline-block w-2 h-2 rounded-full mt-1 flex-shrink-0"
        style={{ backgroundColor: levelColor(level) }}
        aria-hidden="true"
      />
      <span className="flex-1 leading-snug">{message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismissToast(id)}
        className="text-[color:var(--text-muted)] hover:text-[color:var(--text-main)] transition-colors flex-shrink-0"
      >
        ✕
      </button>
    </div>
  );
}

export default function ToastContainer() {
  const toasts = useStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[var(--z-toast)] flex flex-col gap-2 pointer-events-none"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem id={t.id} message={t.message} level={t.level} />
        </div>
      ))}
    </div>
  );
}
