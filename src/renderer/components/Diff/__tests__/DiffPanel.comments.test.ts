// J2 F10 — diff 코멘트 역조회 추출 로직 테스트.
//
// 미션 채널 메시지에서 이 태스크의 diff-comment 앵커(data.kind==='diff-comment'
// && taskId 일치)만 추출하는 순수 함수를 검증한다.
import { describe, it, expect } from 'vitest';
import { extractDiffComments } from '../DiffPanel';

describe('extractDiffComments — F10 앵커 역조회', () => {
  it('taskId·kind 일치하는 diff-comment만 추출(작성자·본문·시각 포함)', () => {
    const messages = [
      // 대상 코멘트.
      {
        text: 'looks good',
        memberName: 'alice',
        postedAt: 1000,
        data: { kind: 'diff-comment', taskId: 'wtask-1', file: 'a.txt', hunkHeader: '@@ -1,3 +1,4 @@' },
      },
      // 다른 태스크 — 제외.
      {
        text: 'other task',
        memberName: 'bob',
        postedAt: 2000,
        data: { kind: 'diff-comment', taskId: 'wtask-2', file: 'x.txt', hunkHeader: '' },
      },
      // 일반 채팅(kind 없음) — 제외.
      { text: 'hi', memberName: 'carol', postedAt: 3000, data: undefined },
    ];
    const out = extractDiffComments(messages, 'wtask-1');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      file: 'a.txt',
      hunkHeader: '@@ -1,3 +1,4 @@',
      author: 'alice',
      text: 'looks good',
      postedAt: 1000,
    });
  });

  it('file 없는 앵커·kind 불일치는 무시', () => {
    const messages = [
      { text: 'no file', memberName: 'a', postedAt: 1, data: { kind: 'diff-comment', taskId: 'wtask-1' } },
      { text: 'wrong kind', memberName: 'b', postedAt: 2, data: { kind: 'other', taskId: 'wtask-1', file: 'a.txt' } },
    ];
    expect(extractDiffComments(messages, 'wtask-1')).toEqual([]);
  });

  it('memberName·hunkHeader 결측 시 안전 기본값', () => {
    const messages = [
      { text: 't', postedAt: 5, data: { kind: 'diff-comment', taskId: 'wtask-1', file: 'a.txt' } },
    ];
    const out = extractDiffComments(messages, 'wtask-1');
    expect(out[0].author).toBe('(unknown)');
    expect(out[0].hunkHeader).toBe('');
  });
});
