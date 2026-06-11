import { describe, it, expect } from 'vitest';
import { TerminalNotificationParser } from '../oscNotification';

// Payloads below are what OscParser hands to handlers: the part AFTER the
// leading `<code>;` of the raw OSC sequence.

describe('TerminalNotificationParser — OSC 9', () => {
  it('parses a plain message as the body with null title', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(9, 'Build finished')).toEqual({
      source: 'osc9',
      title: null,
      body: 'Build finished',
    });
  });

  it('drops ConEmu numeric subcommands (progress etc.)', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(9, '4;1;50')).toBeNull();   // progress
    expect(p.handle(9, '1')).toBeNull();         // bare subcommand
    expect(p.handle(9, '12;anything')).toBeNull();
  });

  it('keeps messages whose first segment is 3+ digits (not a ConEmu code)', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(9, '404 not found')).toEqual({
      source: 'osc9',
      title: null,
      body: '404 not found',
    });
  });

  it('strips control characters and drops empty results', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(9, 'a\x1b[31mb')).toEqual({
      source: 'osc9',
      title: null,
      body: 'a[31mb',
    });
    expect(p.handle(9, '\x01\x02')).toBeNull();
    expect(p.handle(9, '   ')).toBeNull();
  });

  it('caps the body at 4096 chars', () => {
    const p = new TerminalNotificationParser();
    const result = p.handle(9, 'x'.repeat(10_000));
    expect(result?.body.length).toBe(4096);
  });
});

describe('TerminalNotificationParser — OSC 777', () => {
  it('parses notify;title;body', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(777, 'notify;Build;done in 3s')).toEqual({
      source: 'osc777',
      title: 'Build',
      body: 'done in 3s',
    });
  });

  it('rejoins semicolons inside the body', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(777, 'notify;T;a;b;c')).toEqual({
      source: 'osc777',
      title: 'T',
      body: 'a;b;c',
    });
  });

  it('promotes a title-only notification to the body', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(777, 'notify;Just a title')).toEqual({
      source: 'osc777',
      title: null,
      body: 'Just a title',
    });
    expect(p.handle(777, 'notify;Just a title;')).toEqual({
      source: 'osc777',
      title: null,
      body: 'Just a title',
    });
  });

  it('drops non-notify subcommands and empty notifications', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(777, 'other;Title;Body')).toBeNull();
    expect(p.handle(777, 'notify;;')).toBeNull();
    expect(p.handle(777, 'notify')).toBeNull();
  });
});

describe('TerminalNotificationParser — OSC 99 (kitty)', () => {
  it('parses a single-shot notification (default p=title promoted to body)', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(99, ';Hello there')).toEqual({
      source: 'osc99',
      title: null,
      body: 'Hello there',
    });
  });

  it('parses explicit p=body payloads', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(99, 'p=body;The body text')).toEqual({
      source: 'osc99',
      title: null,
      body: 'The body text',
    });
  });

  it('assembles multi-chunk title+body keyed by id', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(99, 'i=t1:d=0:p=title;My ti')).toBeNull();
    expect(p.handle(99, 'i=t1:d=0:p=title;tle')).toBeNull();
    expect(p.handle(99, 'i=t1:d=1:p=body;The body')).toEqual({
      source: 'osc99',
      title: 'My title',
      body: 'The body',
    });
    // State for the id is cleared after finalize.
    expect(p.handle(99, 'i=t1:d=1:p=body;fresh')).toEqual({
      source: 'osc99',
      title: null,
      body: 'fresh',
    });
  });

  it('keeps independent ids separate', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(99, 'i=a:d=0:p=body;AAA')).toBeNull();
    expect(p.handle(99, 'i=b:d=0:p=body;BBB')).toBeNull();
    expect(p.handle(99, 'i=a:d=1;')).toEqual({
      source: 'osc99',
      title: null,
      body: 'AAA',
    });
    expect(p.handle(99, 'i=b:d=1;')).toEqual({
      source: 'osc99',
      title: null,
      body: 'BBB',
    });
  });

  it('decodes base64 payloads when e=1', () => {
    const p = new TerminalNotificationParser();
    const b64 = Buffer.from('encoded message', 'utf8').toString('base64');
    expect(p.handle(99, `e=1;${b64}`)).toEqual({
      source: 'osc99',
      title: null,
      body: 'encoded message',
    });
  });

  it('ignores payloads of unsupported kinds but still finalizes on done', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(99, 'i=x:d=0:p=body;visible')).toBeNull();
    // Final chunk carries an icon payload — ignored, but d=1 finalizes.
    expect(p.handle(99, 'i=x:d=1:p=icon;PNGBYTES')).toEqual({
      source: 'osc99',
      title: null,
      body: 'visible',
    });
  });

  it('ignores unknown metadata keys', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(99, 'a=report:o=always:u=2:p=body;ok')).toEqual({
      source: 'osc99',
      title: null,
      body: 'ok',
    });
  });

  it('drops notifications that end up empty', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(99, ';')).toBeNull();
    expect(p.handle(99, 'd=1;')).toBeNull();
  });

  it('evicts the oldest pending id beyond the cap instead of growing', () => {
    const p = new TerminalNotificationParser();
    for (let i = 0; i < 9; i++) {
      expect(p.handle(99, `i=id${i}:d=0:p=body;chunk${i}`)).toBeNull();
    }
    // id0 was evicted when id8 arrived — finalizing it now yields only the
    // final chunk's payload (a fresh entry), not the original chunk0.
    expect(p.handle(99, 'i=id0:d=1:p=body;tail')).toEqual({
      source: 'osc99',
      title: null,
      body: 'tail',
    });
    // id8 survived.
    expect(p.handle(99, 'i=id8:d=1;')).toEqual({
      source: 'osc99',
      title: null,
      body: 'chunk8',
    });
  });

  it('caps accumulated chars per id at 8KB', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(99, `i=big:d=0:p=body;${'x'.repeat(8000)}`)).toBeNull();
    const result = p.handle(99, `i=big:d=1:p=body;${'y'.repeat(8000)}`);
    // 8192 chars accepted into the pending buffer (8000 x + 192 y), then
    // the final body is capped to its first 4096 chars — all x.
    expect(result?.body.length).toBe(4096);
    expect(result?.body).toBe('x'.repeat(4096));
  });

  it('reset() drops in-flight assembly state', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(99, 'i=r:d=0:p=body;pending')).toBeNull();
    p.reset();
    expect(p.handle(99, 'i=r:d=1;')).toBeNull();
  });
});

describe('TerminalNotificationParser — non-notification codes', () => {
  it('returns null for codes it does not own', () => {
    const p = new TerminalNotificationParser();
    expect(p.handle(7, 'file://host/path')).toBeNull();
    expect(p.handle(133, 'D;0')).toBeNull();
  });
});
