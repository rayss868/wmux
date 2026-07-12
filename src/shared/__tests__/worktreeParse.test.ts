// worktreeParse — `git worktree list --porcelain` 파서 + ref 검증 + dir 이름 도출.
import { describe, it, expect } from 'vitest';
import { parseWorktreePorcelain, validateGitRef, branchToDirName } from '../worktreeParse';

describe('parseWorktreePorcelain', () => {
  it('본 repo + attached 워크트리 2블록 파싱', () => {
    const raw = [
      'worktree D:/proj/repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree D:/proj/repo-worktrees/feat-x',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feat/x',
      '',
    ].join('\n');
    const out = parseWorktreePorcelain(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ path: 'D:/proj/repo', branch: 'main', detached: false, bare: false });
    expect(out[1]).toMatchObject({ path: 'D:/proj/repo-worktrees/feat-x', branch: 'feat/x' });
  });

  it('detached — branch null + detached true', () => {
    const raw = 'worktree /w/dt\nHEAD 3333333333333333333333333333333333333333\ndetached\n';
    const out = parseWorktreePorcelain(raw);
    expect(out[0].branch).toBeNull();
    expect(out[0].detached).toBe(true);
  });

  it('bare — bare true, HEAD 없어도 파싱', () => {
    const raw = 'worktree /w/bare.git\nbare\n';
    const out = parseWorktreePorcelain(raw);
    expect(out[0].bare).toBe(true);
    expect(out[0].headOid).toBe('');
  });

  it('locked(사유 유/무) + prunable 플래그', () => {
    const raw = [
      'worktree /w/a',
      'HEAD 4444444444444444444444444444444444444444',
      'branch refs/heads/a',
      'locked reason with spaces',
      '',
      'worktree /w/b',
      'HEAD 5555555555555555555555555555555555555555',
      'branch refs/heads/b',
      'locked',
      'prunable gitdir file points to non-existent location',
    ].join('\n');
    const out = parseWorktreePorcelain(raw);
    expect(out[0].locked).toBe('reason with spaces');
    expect(out[1].locked).toBe('');
    expect(out[1].prunable).toContain('non-existent');
  });

  it('공백 경로 + CRLF 개행 허용', () => {
    const raw = 'worktree C:/My Projects/repo copy\r\nHEAD 6666666666666666666666666666666666666666\r\nbranch refs/heads/x\r\n';
    const out = parseWorktreePorcelain(raw);
    expect(out[0].path).toBe('C:/My Projects/repo copy');
  });

  it('worktree 라인 없는 블록·빈 입력은 무시', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
    expect(parseWorktreePorcelain('HEAD 7777777\n\n')).toEqual([]);
  });
});

describe('validateGitRef', () => {
  it('정상 브랜치는 trim 후 통과', () => {
    expect(validateGitRef('  feat/x-1  ')).toBe('feat/x-1');
  });
  it.each([
    ['', 'empty'],
    ['-rf', "'-'"],
    ['a..b', "'..'"],
    ['a\x01b', 'control'],
    ['a b', 'invalid ref'],
    ['a~1', 'invalid ref'],
    ['a/', 'suffix'],
    ['a.lock', 'suffix'],
  ])('거부: %j', (bad) => {
    expect(() => validateGitRef(bad as string)).toThrow();
  });
});

describe('branchToDirName', () => {
  it('경로 위험 문자를 -로 접고 양끝 - 제거', () => {
    expect(branchToDirName('feat/orchestrator: v1')).toBe('feat-orchestrator-v1');
    expect(branchToDirName('///')).toBe('worktree');
  });
});
