import { describe, it, expect, vi } from 'vitest';
import { OscParser, OscEvent } from '../OscParser';

describe('OscParser', () => {
  function collectEvents(parser: OscParser, data: string): OscEvent[] {
    const events: OscEvent[] = [];
    parser.onOsc((e) => events.push(e));
    parser.process(data);
    return events;
  }

  it('should parse OSC 7 (CWD) with BEL terminator', () => {
    const parser = new OscParser();
    const events = collectEvents(parser, '\x1b]7;file:///home/user\x07');
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(7);
    expect(events[0].data).toBe('file:///home/user');
  });

  it('should parse OSC 7 with ST (ESC \\) terminator', () => {
    const parser = new OscParser();
    const events = collectEvents(parser, '\x1b]7;file:///home/user\x1b\\');
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(7);
    expect(events[0].data).toBe('file:///home/user');
  });

  it('should parse OSC 9 notification', () => {
    const parser = new OscParser();
    const events = collectEvents(parser, '\x1b]9;Hello World\x07');
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(9);
    expect(events[0].data).toBe('Hello World');
  });

  it('should parse OSC 777 notification', () => {
    const parser = new OscParser();
    const events = collectEvents(parser, '\x1b]777;notify;Title;Body text\x07');
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(777);
    expect(events[0].data).toBe('notify;Title;Body text');
  });

  it('should parse OSC 7727 (git branch) with BEL terminator', () => {
    const parser = new OscParser();
    const events = collectEvents(parser, '\x1b]7727;main\x07');
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(7727);
    expect(events[0].data).toBe('main');
  });

  it('should parse OSC 7727 (git branch) with ST terminator', () => {
    const parser = new OscParser();
    const events = collectEvents(parser, '\x1b]7727;feature/my-branch\x1b\\');
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(7727);
    expect(events[0].data).toBe('feature/my-branch');
  });

  it('should parse OSC 7727 with branch names containing special chars', () => {
    const parser = new OscParser();
    const events = collectEvents(parser, '\x1b]7727;fix/issue-123_test\x07');
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(7727);
    expect(events[0].data).toBe('fix/issue-123_test');
  });

  it('should strip OSC sequences from returned data', () => {
    const parser = new OscParser();
    parser.onOsc(() => {});
    const cleaned = parser.process('before\x1b]7727;main\x07after');
    expect(cleaned).toBe('beforeafter');
  });

  it('should handle multiple OSC sequences in one chunk', () => {
    const parser = new OscParser();
    const events: OscEvent[] = [];
    parser.onOsc((e) => events.push(e));
    parser.process('\x1b]7;file:///tmp\x07hello\x1b]7727;develop\x07world');
    expect(events).toHaveLength(2);
    expect(events[0].code).toBe(7);
    expect(events[1].code).toBe(7727);
    expect(events[1].data).toBe('develop');
  });

  it('should handle split data across multiple process calls', () => {
    const parser = new OscParser();
    const events: OscEvent[] = [];
    parser.onOsc((e) => events.push(e));
    parser.process('\x1b]7727;fea');
    expect(events).toHaveLength(0);
    parser.process('ture/split\x07');
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(7727);
    expect(events[0].data).toBe('feature/split');
  });

  it('should ignore OSC without semicolon', () => {
    const parser = new OscParser();
    const events = collectEvents(parser, '\x1b]nosemicolon\x07');
    expect(events).toHaveLength(0);
  });

  it('should ignore OSC with non-numeric code', () => {
    const parser = new OscParser();
    const events = collectEvents(parser, '\x1b]abc;data\x07');
    expect(events).toHaveLength(0);
  });
});
