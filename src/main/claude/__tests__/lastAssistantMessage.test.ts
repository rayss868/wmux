import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLastAssistantMessage, endsWithQuestion } from '../lastAssistantMessage';

// The regression these guard: an agent.stop wake used to reach the orchestrator
// with no content, so "finished" and "blocked on a question" were
// indistinguishable without scraping the terminal — where a printed question
// looks exactly like text pending in the input box.

describe('endsWithQuestion', () => {
  it('detects a plain question mark on the last line', () => {
    expect(endsWithQuestion('Did the merge land?')).toBe(true);
  });

  it('detects Korean interrogative endings with no question mark', () => {
    // The common real case: agents in this repo are driven in Korean, where a
    // question routinely ends in -까/-는지 and carries no '?' at all.
    expect(endsWithQuestion('브랜치 옮겨서 PR 올릴까')).toBe(true);
    expect(endsWithQuestion('이대로 진행해도 되는지')).toBe(true);
  });

  it('looks only at the LAST line', () => {
    // A question mid-report followed by more work is not a block.
    expect(endsWithQuestion('Should I retry?\nRetried, and it passed.')).toBe(false);
    expect(endsWithQuestion('Done.\nShall I merge?')).toBe(true);
  });

  it('sees through trailing markdown emphasis', () => {
    expect(endsWithQuestion('**머지할까?**')).toBe(true);
  });

  it('does not fire on statements', () => {
    expect(endsWithQuestion('Merged as 08be43f.')).toBe(false);
    expect(endsWithQuestion('CI 6/6 통과했다.')).toBe(false);
    expect(endsWithQuestion('')).toBe(false);
  });
});

describe('readLastAssistantMessage', () => {
  let dir: string;
  let file: string;

  const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;
  const assistantText = (text: string) =>
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-transcript-'));
    file = path.join(dir, 'transcript.jsonl');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the final assistant message and flags a question', () => {
    fs.writeFileSync(file, assistantText('Working on it.') + assistantText('머지할까?'));
    expect(readLastAssistantMessage(file)).toEqual({
      text: '머지할까?',
      endsWithQuestion: true,
    });
  });

  it('skips tool-only assistant turns to find the last spoken text', () => {
    // A turn that only issued tool calls has no text; the human-facing message
    // is the one before it.
    const toolOnly = line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    });
    fs.writeFileSync(file, assistantText('Shall I merge?') + toolOnly);
    expect(readLastAssistantMessage(file)?.text).toBe('Shall I merge?');
  });

  it('ignores user entries', () => {
    fs.writeFileSync(
      file,
      assistantText('All done.') + line({ type: 'user', message: { role: 'user', content: 'ok?' } }),
    );
    const got = readLastAssistantMessage(file);
    expect(got?.text).toBe('All done.');
    expect(got?.endsWithQuestion).toBe(false);
  });

  it('survives a partial leading line from the bounded tail read', () => {
    fs.writeFileSync(file, `{"type":"assist\n${assistantText('Done.')}`);
    expect(readLastAssistantMessage(file)?.text).toBe('Done.');
  });

  it('truncates a long message from the END, keeping the ask', () => {
    const long = `${'x'.repeat(5000)}\nShall I proceed?`;
    fs.writeFileSync(file, assistantText(long));
    const got = readLastAssistantMessage(file);
    expect(got).not.toBeNull();
    expect(got?.text.length).toBeLessThanOrEqual(601);
    expect(got?.text.endsWith('Shall I proceed?')).toBe(true);
    expect(got?.endsWithQuestion).toBe(true);
  });

  it('returns null rather than throwing on a missing or garbage file', () => {
    expect(readLastAssistantMessage(path.join(dir, 'nope.jsonl'))).toBeNull();
    fs.writeFileSync(file, 'not json at all\n{also not\n');
    expect(readLastAssistantMessage(file)).toBeNull();
  });
});
