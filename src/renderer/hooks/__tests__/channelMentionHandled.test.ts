// @vitest-environment jsdom
//
// The persisted handled-set is the durable backstop against reload boot-replay
// resurrection (A3). These verify mark/isHandled + that it actually writes to
// localStorage (so it survives a reload) + FIFO bounding.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  isChannelMentionHandled,
  markChannelMentionHandled,
  isChannelMentionDeliveredPersisted,
  markChannelMentionDeliveredPersisted,
  __resetChannelMentionHandledForTests,
} from '../channelMentionHandled';

const KEY = 'wmux.channelMentionHandled.v1';

describe('channelMentionHandled (persisted, bounded)', () => {
  beforeEach(() => {
    __resetChannelMentionHandledForTests();
  });

  it('reports an id as handled only after it is marked', () => {
    expect(isChannelMentionHandled('chmention-ch1-1')).toBe(false);
    markChannelMentionHandled('chmention-ch1-1');
    expect(isChannelMentionHandled('chmention-ch1-1')).toBe(true);
  });

  it('writes to localStorage so a reload (fresh in-memory) still sees it', () => {
    markChannelMentionHandled('chmention-ch1-2');
    const raw = localStorage.getItem(KEY);
    expect(raw).toBeTruthy();
    expect(raw).toContain('chmention-ch1-2');
  });

  it('is idempotent — marking twice keeps a single entry', () => {
    markChannelMentionHandled('dup');
    markChannelMentionHandled('dup');
    const raw = localStorage.getItem(KEY);
    const arr = JSON.parse(raw ?? '[]') as string[];
    expect(arr.filter((x) => x === 'dup')).toHaveLength(1);
  });

  it('FIFO-evicts beyond the cap (oldest forgotten, newest kept)', () => {
    // CAP is 2000; push past it and confirm the very first is evicted, last kept.
    for (let i = 0; i < 2050; i++) markChannelMentionHandled(`id-${i}`);
    expect(isChannelMentionHandled('id-0')).toBe(false); // evicted
    expect(isChannelMentionHandled('id-2049')).toBe(true); // kept
  });
});

describe('channelMentionDelivered (2d persisted set + upgrade seed)', () => {
  const DKEY = 'wmux.channelMentionDelivered.v1';
  const HKEY = 'wmux.channelMentionHandled.v1';

  beforeEach(() => {
    __resetChannelMentionHandledForTests();
  });

  it('mark/is + persists to its own storage key (independent of handled)', () => {
    expect(isChannelMentionDeliveredPersisted('k1')).toBe(false);
    markChannelMentionDeliveredPersisted('k1');
    expect(isChannelMentionDeliveredPersisted('k1')).toBe(true);
    expect(localStorage.getItem(DKEY)).toContain('k1');
    expect(isChannelMentionHandled('k1')).toBe(false);
  });

  it('upgrade seed: no delivered storage + existing handled backlog ⇒ delivered pre-seeded', () => {
    // Simulate a pre-upgrade install: handled entries on disk, no delivered key.
    localStorage.setItem(HKEY, JSON.stringify(['old-1', 'old-2']));
    expect(isChannelMentionDeliveredPersisted('old-1')).toBe(true);
    expect(isChannelMentionDeliveredPersisted('old-2')).toBe(true);
    expect(localStorage.getItem(DKEY)).toContain('old-1');
  });

  it('no seed when the delivered storage key already exists (even empty)', () => {
    localStorage.setItem(HKEY, JSON.stringify(['old-3']));
    localStorage.setItem(DKEY, JSON.stringify([]));
    expect(isChannelMentionDeliveredPersisted('old-3')).toBe(false);
  });
});
