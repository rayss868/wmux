// Terminal desktop-notification escape sequences: OSC 9 / OSC 777 / OSC 99.
//
// Sits next to the OSC 133 prompt-marker parsing on the PTY data hot path —
// OscParser already extracts every OSC sequence, so this module only pays
// for payload parsing on the (rare) notification codes. Normative rules are
// frozen in docs/internal/fable-window-schema-freeze.md §1; keep both in
// sync when changing behavior.
//
// Stateless codes (9, 777) parse one sequence → one notification. OSC 99
// (kitty desktop-notification protocol) supports multi-chunk assembly keyed
// by id, so the parser is a per-PTY stateful object — one instance per
// bridge, like OscParser itself.

export interface TerminalNotification {
  source: 'osc9' | 'osc777' | 'osc99';
  /** Sanitized title, null when the sequence carried no separate title. */
  title: string | null;
  /** Sanitized body; never empty (empty notifications return null instead). */
  body: string;
}

export const NOTIFICATION_OSC_CODES: readonly number[] = [9, 99, 777];

const MAX_TITLE_CHARS = 256;
const MAX_BODY_CHARS = 4096;
// OSC 99 assembly bounds: a hostile/buggy program can open chunks (d=0)
// forever; cap both the number of in-flight ids and the bytes per id.
const MAX_PENDING_IDS = 8;
const MAX_PENDING_CHARS = 8 * 1024;

// Strip C0 (except nothing — notifications are plain text) and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

function sanitize(text: string, maxLen: number): string {
  return text.replace(CONTROL_CHARS, '').slice(0, maxLen).trim();
}

/**
 * OSC 9 — iTerm2-style `ESC ] 9 ; message ST`. ConEmu overloads the same
 * code with numeric subcommands (`9;4;1;50` progress, `9;1;...` etc.);
 * those are terminal-control, not notifications. A first segment of 1–2
 * digits is treated as a ConEmu subcommand and dropped — a genuine message
 * that is *only* a short number is a false negative we accept (frozen rule).
 */
function parseOsc9(data: string): TerminalNotification | null {
  const firstSeg = data.indexOf(';') === -1 ? data : data.slice(0, data.indexOf(';'));
  if (/^\d{1,2}$/.test(firstSeg)) return null;
  const body = sanitize(data, MAX_BODY_CHARS);
  if (!body) return null;
  return { source: 'osc9', title: null, body };
}

/**
 * OSC 777 — urxvt extension `ESC ] 777 ; notify ; title ; body ST`.
 * Only the `notify` subcommand is a notification; anything else is dropped.
 * Body may itself contain semicolons.
 */
function parseOsc777(data: string): TerminalNotification | null {
  const parts = data.split(';');
  if (parts[0] !== 'notify') return null;
  let title: string | null = sanitize(parts[1] ?? '', MAX_TITLE_CHARS);
  let body = sanitize(parts.slice(2).join(';'), MAX_BODY_CHARS);
  if (!body && title) {
    // Title-only notification: promote the title to the body.
    body = title.slice(0, MAX_BODY_CHARS);
    title = null;
  } else if (!title) {
    title = null;
  }
  if (!body) return null;
  return { source: 'osc777', title: title || null, body };
}

interface PendingOsc99 {
  title: string[];
  body: string[];
  chars: number;
}

/**
 * Per-PTY notification parser. Handles all three codes; OSC 99 multi-chunk
 * assembly state lives here, bounded by MAX_PENDING_IDS / MAX_PENDING_CHARS.
 */
export class TerminalNotificationParser {
  /** OSC 99 in-flight chunked notifications, keyed by `i=` id. Map preserves
   *  insertion order, which is what the overflow eviction relies on. */
  private pending = new Map<string, PendingOsc99>();

  /**
   * Feed one extracted OSC sequence. Returns a completed notification, or
   * null when the sequence is not a notification (ConEmu subcommand, unknown
   * 777 subcommand, empty after sanitization) or is an unfinished OSC 99
   * chunk (`d=0`).
   */
  handle(code: number, data: string): TerminalNotification | null {
    switch (code) {
      case 9: return parseOsc9(data);
      case 777: return parseOsc777(data);
      case 99: return this.handleOsc99(data);
      default: return null;
    }
  }

  /**
   * OSC 99 — kitty desktop-notification protocol:
   * `ESC ] 99 ; <metadata> ; <payload> ST` where metadata is `:`-separated
   * `k=v`. Supported keys: `i` (id), `d` (done, default 1), `p` (payload
   * kind: title|body; others carried but their payload is ignored),
   * `e` (`1` = payload is base64). Chunks sharing an id accumulate until a
   * `d≠0` chunk finalizes the notification.
   */
  private handleOsc99(data: string): TerminalNotification | null {
    const sep = data.indexOf(';');
    const metadata = sep === -1 ? data : data.slice(0, sep);
    const rawPayload = sep === -1 ? '' : data.slice(sep + 1);

    let id = '';
    let done = true;
    let payloadKind = 'title';
    let base64 = false;
    if (metadata.length > 0) {
      for (const pair of metadata.split(':')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const key = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (key === 'i') id = value;
        else if (key === 'd') done = value !== '0';
        else if (key === 'p') payloadKind = value;
        else if (key === 'e') base64 = value === '1';
        // All other keys (a, o, u, c, g, ...) are accepted and ignored.
      }
    }

    let payload = rawPayload;
    if (base64 && payload.length > 0) {
      // Guard the decode input: a single chunk can't usefully carry more than
      // MAX_PENDING_CHARS of decoded text (the assembler caps total accepted
      // chars anyway), so cap the base64 source before decoding to avoid a
      // large transient allocation from a hostile multi-MB chunk. base64 is
      // ~4/3 the byte size, so 2× the char cap is a safe over-estimate.
      if (payload.length > MAX_PENDING_CHARS * 2) {
        payload = payload.slice(0, MAX_PENDING_CHARS * 2);
      }
      try {
        payload = Buffer.from(payload, 'base64').toString('utf8');
      } catch {
        payload = '';
      }
    }

    let entry = this.pending.get(id);
    if (!entry) {
      entry = { title: [], body: [], chars: 0 };
      if (this.pending.size >= MAX_PENDING_IDS) {
        // Evict the oldest in-flight id rather than growing unbounded.
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      this.pending.set(id, entry);
    }

    if (payloadKind === 'title' || payloadKind === 'body') {
      const room = MAX_PENDING_CHARS - entry.chars;
      if (room > 0 && payload.length > 0) {
        const accepted = payload.slice(0, room);
        (payloadKind === 'title' ? entry.title : entry.body).push(accepted);
        entry.chars += accepted.length;
      }
    }

    if (!done) return null;

    this.pending.delete(id);
    let title: string | null = sanitize(entry.title.join(''), MAX_TITLE_CHARS);
    let body = sanitize(entry.body.join(''), MAX_BODY_CHARS);
    if (!body && title) {
      body = title.slice(0, MAX_BODY_CHARS);
      title = null;
    }
    if (!body) return null;
    return { source: 'osc99', title: title || null, body };
  }

  /** Drop all in-flight OSC 99 assembly state (PTY teardown). */
  reset(): void {
    this.pending.clear();
  }
}
