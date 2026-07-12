// diff→오케스트레이터 질문 컨텍스트 블록 조립 — 필드·펜싱·캡 계약.
import { describe, it, expect } from 'vitest';
import { buildDiffAskContext, DIFF_ASK_CONTEXT_CAP } from '../diffAskContext';

const base = {
  repoLabel: 'D:/proj/repo',
  branch: 'feat/x',
  file: 'src/a.ts',
  hunkHeader: '@@ -1,3 +1,4 @@',
  hunkBody: ' line1\n+added\n line2',
  question: '이 변경 안전해?',
};

describe('buildDiffAskContext', () => {
  it('repo·branch·file·hunk 헤더를 담고 hunk 본문을 ```diff 펜스로 감싼다', () => {
    const out = buildDiffAskContext(base);
    expect(out).toContain('[diff question]');
    expect(out).toContain('repo: D:/proj/repo');
    expect(out).toContain('branch: feat/x');
    expect(out).toContain('file: src/a.ts');
    expect(out).toContain('hunk: @@ -1,3 +1,4 @@');
    expect(out).toContain('```diff\n line1\n+added\n line2\n```');
    expect(out.trim().endsWith('이 변경 안전해?')).toBe(true);
  });

  it('branch·hunkHeader가 비면 해당 라인 생략, 본문 없으면 펜스 생략', () => {
    const out = buildDiffAskContext({ ...base, branch: '', hunkHeader: '', hunkBody: '' });
    expect(out).not.toContain('branch:');
    expect(out).not.toContain('hunk:');
    expect(out).not.toContain('```');
  });

  it('캡 초과 시 hunk 본문을 통째로 생략(부분 절단 금지) — 경로·헤더·질문은 유지', () => {
    const out = buildDiffAskContext({ ...base, hunkBody: 'x'.repeat(DIFF_ASK_CONTEXT_CAP + 100) });
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(DIFF_ASK_CONTEXT_CAP);
    expect(out).not.toContain('xxx');
    expect(out).toContain('hunk body omitted');
    expect(out).toContain('file: src/a.ts');
    expect(out).toContain('이 변경 안전해?');
  });

  it('hunk 안에 ``` 라인이 있어도 펜스가 조기 종료되지 않는다(Codex P2)', () => {
    const out = buildDiffAskContext({ ...base, hunkBody: ' before\n+```\n after' });
    // 본문의 ``` 보다 긴 펜스(````)로 감싸야 한다.
    expect(out).toContain('````diff\n before\n+```\n after\n````');
  });

  it('본문 생략 후에도 초과하면(질문 자체가 큼) 최종 바이트 캡으로 절단(Codex P3)', () => {
    const out = buildDiffAskContext({
      ...base,
      hunkBody: 'x'.repeat(100),
      question: 'q'.repeat(DIFF_ASK_CONTEXT_CAP + 5000),
    });
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(DIFF_ASK_CONTEXT_CAP);
  });
});
