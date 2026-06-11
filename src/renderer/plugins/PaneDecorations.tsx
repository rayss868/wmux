import { useStore } from '../stores';

// Theme-token mapping for the validated color names accepted by
// ui.decoratePane (free-form CSS is rejected main-side).
const COLOR_TOKEN: Record<string, string> = {
  accent: 'var(--accent-cursor)',
  red: 'var(--accent-red)',
  yellow: 'var(--accent-yellow)',
  green: 'var(--accent-green)',
  blue: 'var(--accent-blue)',
};

/**
 * Host-rendered plugin badges for one pane (B-1 ui.pane-decoration).
 * Pure data → DOM: the plugin supplies sanitized text/color via the
 * ui.decoratePane RPC; no plugin DOM ever renders inside a pane.
 * Positioned to the left of where the ZOOM badge sits.
 */
export default function PaneDecorations({ paneId }: { paneId: string }) {
  const decorations = useStore((s) => s.pluginPaneDecorations[paneId]);
  if (!decorations) return null;
  const entries = Object.entries(decorations);
  if (entries.length === 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        top: 4,
        right: 64, // clear of the ZOOM badge slot
        zIndex: 20,
        display: 'flex',
        gap: 4,
        pointerEvents: 'none',
      }}
    >
      {entries.map(([plugin, d]) => (
        <span
          key={plugin}
          title={d.tooltip ?? `${plugin}: ${d.badge}`}
          style={{
            padding: '1px 6px',
            fontSize: 10,
            fontFamily: 'ui-monospace, monospace',
            fontWeight: 700,
            letterSpacing: '0.04em',
            color: 'var(--bg-main)',
            backgroundColor: COLOR_TOKEN[d.color ?? 'accent'] ?? COLOR_TOKEN.accent,
            borderRadius: 3,
            opacity: 0.85,
          }}
        >
          {d.badge}
        </span>
      ))}
    </div>
  );
}
