// Channels v2 Step 3a — wake worker tests.
// Pins the safety rules that came out of the live P3' pre-verification:
//   F2 split-write (text, THEN Enter as a separate write),
//   quiet gate, target discipline (never guess), mention backoff + cap +
//   exhaustion broadcast, plain-unread once-per-head-advance, ack reset.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChannelWakeWorker,
  pickTarget,
  MENTION_NUDGE_CAP,
  MENTION_NUDGE_BACKOFF_MS,
  WAKE_QUIET_MS,
  type WakeUnreadEntry,
  type WakeSessionView,
} from '../channelWakeWorker';

function entry(partial: Partial<WakeUnreadEntry>): WakeUnreadEntry {
  return {
    channelId: 'ch-1',
    name: 'general',
    memberId: 'codex',
    lastReadSeq: 2,
    headSeq: 4,
    unread: 2,
    mentionUnread: 0,
    trimmedBeforeCursor: 0,
    ...partial,
  };
}

function session(partial: Partial<WakeSessionView>): WakeSessionView {
  return {
    id: 'pty-1',
    lastDetectedAgent: 'codex',
    lastActivityMs: 0, // long quiet by default
    workspaceId: 'ws-b',
    ...partial,
  };
}

interface Harness {
  worker: ChannelWakeWorker;
  writes: Array<{ sessionId: string; data: string }>;
  broadcasts: Array<Record<string, unknown>>;
  setEntries(e: WakeUnreadEntry[]): void;
  setSessions(s: WakeSessionView[]): void;
  setNow(ms: number): void;
}

function makeHarness(): Harness {
  let entries: WakeUnreadEntry[] = [];
  let sessions: WakeSessionView[] = [];
  let nowMs = 1_000_000;
  const writes: Array<{ sessionId: string; data: string }> = [];
  const broadcasts: Array<Record<string, unknown>> = [];
  const worker = new ChannelWakeWorker({
    memberWorkspaces: () => ['ws-b'],
    unreadFor: () => entries,
    listLiveSessions: () => sessions,
    write: (sessionId, data) => writes.push({ sessionId, data }),
    broadcast: (event) => broadcasts.push(event),
    log: () => {},
    now: () => nowMs,
    enterDelayMs: 1,
  });
  return {
    worker,
    writes,
    broadcasts,
    setEntries: (e) => (entries = e),
    setSessions: (s) => (sessions = s),
    setNow: (ms) => (nowMs = ms),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const flushEnter = () => vi.advanceTimersByTime(5);

describe('ChannelWakeWorker — injection mechanics', () => {
  it('injects the nudge line and the Enter as TWO separate writes (F2)', () => {
    const h = makeHarness();
    h.setEntries([entry({ unread: 2, mentionUnread: 1 })]);
    h.setSessions([session({})]);
    h.worker.tickOnce();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].sessionId).toBe('pty-1');
    expect(h.writes[0].data).toContain('#general: 2 unread (1 mention you)');
    expect(h.writes[0].data).toContain('wmux channel read ch-1 --since 3');
    expect(h.writes[0].data).not.toContain('\r');
    flushEnter();
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1].data).toBe('\r');
  });

  it('respects the quiet gate: a recently-active pane is skipped, then nudged once quiet', () => {
    const h = makeHarness();
    h.setNow(1_000_000);
    h.setEntries([entry({ mentionUnread: 1 })]);
    h.setSessions([session({ lastActivityMs: 1_000_000 - (WAKE_QUIET_MS - 1) })]);
    h.worker.tickOnce();
    expect(h.writes).toHaveLength(0);
    // Quiet long enough now.
    h.setNow(1_000_000 + WAKE_QUIET_MS);
    h.worker.tickOnce();
    expect(h.writes).toHaveLength(1);
  });

  it('strips control characters from the injected line', () => {
    const h = makeHarness();
    h.setEntries([entry({ name: 'gen\x1b[31meral', mentionUnread: 1 })]);
    h.setSessions([session({})]);
    h.worker.tickOnce();
    // eslint-disable-next-line no-control-regex
    expect(h.writes[0].data).not.toMatch(/[\x00-\x1f\x7f]/);
  });
});

describe('ChannelWakeWorker — re-nudge policy', () => {
  it('mention unread: re-nudges with backoff up to the cap, then broadcasts exhaustion ONCE', () => {
    const h = makeHarness();
    h.setEntries([entry({ mentionUnread: 1 })]);
    h.setSessions([session({})]);
    let t = 1_000_000;
    for (let i = 0; i < MENTION_NUDGE_CAP; i++) {
      h.setNow(t);
      h.worker.tickOnce();
      flushEnter();
      // Immediately re-ticking within the backoff window must NOT re-nudge.
      h.worker.tickOnce();
      expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(i + 1);
      t += (MENTION_NUDGE_BACKOFF_MS[i + 1] ?? 0) + 1;
    }
    // Budget exhausted → no more writes, one exhaustion broadcast.
    h.setNow(t + 10_000_000);
    h.worker.tickOnce();
    h.worker.tickOnce();
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(MENTION_NUDGE_CAP);
    const exhausted = h.broadcasts.filter((b) => b['type'] === 'channel.nudgeExhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({ channelId: 'ch-1', workspaceId: 'ws-b', memberId: 'codex' });
  });

  it('ack (unread=0) resets the episode: a fresh unread gets a fresh nudge budget', () => {
    const h = makeHarness();
    h.setSessions([session({})]);
    h.setEntries([entry({ mentionUnread: 1 })]);
    h.worker.tickOnce();
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(1);
    // Ack lands → unread 0 → tracker cleared.
    h.setEntries([entry({ unread: 0, mentionUnread: 0 })]);
    h.worker.tickOnce();
    // New mention episode nudges immediately again (budget reset).
    h.setEntries([entry({ mentionUnread: 1, headSeq: 9, lastReadSeq: 8, unread: 1 })]);
    h.worker.tickOnce();
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(2);
  });

  it('plain unread: nudges ONCE, and again only after the head advances', () => {
    const h = makeHarness();
    h.setSessions([session({})]);
    h.setEntries([entry({ unread: 2, mentionUnread: 0, headSeq: 4 })]);
    h.worker.tickOnce();
    h.worker.tickOnce();
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(1);
    // New message arrives (head advances) → one more nudge allowed.
    h.setEntries([entry({ unread: 3, mentionUnread: 0, headSeq: 5 })]);
    h.worker.tickOnce();
    h.worker.tickOnce();
    expect(h.writes.filter((w) => w.data !== '\r')).toHaveLength(2);
  });
});

describe('pickTarget — never guess', () => {
  it('prefers the slug-matching non-claude session', () => {
    const target = pickTarget(
      [
        session({ id: 'a', lastDetectedAgent: 'claude' }),
        session({ id: 'b', lastDetectedAgent: 'codex' }),
        session({ id: 'c', lastDetectedAgent: undefined }),
      ],
      'ws-b',
      'codex',
    );
    expect(target?.id).toBe('b');
  });

  it('falls back to the ONLY non-claude session when no slug matches', () => {
    const target = pickTarget(
      [session({ id: 'a', lastDetectedAgent: 'claude' }), session({ id: 'b', lastDetectedAgent: undefined })],
      'ws-b',
      'reviewer',
    );
    expect(target?.id).toBe('b');
  });

  it('returns null on ambiguity (two non-claude sessions, no slug match)', () => {
    expect(
      pickTarget(
        [session({ id: 'a', lastDetectedAgent: undefined }), session({ id: 'b', lastDetectedAgent: 'codex' })],
        'ws-b',
        'reviewer',
      ),
    ).toBeNull();
  });

  it('returns null when the only live session is a claude pane (Stop-hook owns it)', () => {
    expect(pickTarget([session({ id: 'a', lastDetectedAgent: 'claude' })], 'ws-b', 'codex')).toBeNull();
    // …and a claude pane is never picked even when the memberId literally
    // says "claude" — the generic injector must not double-nudge that path.
    expect(pickTarget([session({ id: 'a', lastDetectedAgent: 'claude' })], 'ws-b', 'claude')).toBeNull();
  });

  it('never targets a session from another workspace', () => {
    expect(pickTarget([session({ id: 'a', workspaceId: 'ws-other' })], 'ws-b', 'codex')).toBeNull();
  });
});
