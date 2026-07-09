// 검증 리그 — J2 채택 원자성 + 재직렬화 무결성 (설계 §5, 출하 블로커)
//
// 계약(§3 all-or-nothing): 선택 hunk 단일 패치 1회 git apply는 전부 성공 or 전부
// 미적용이다. 부분 적용 상태가 물리적으로 없으므로, 적용 중 프로세스가 죽어도
// 타겟은 "완전 적용 or 완전 미적용" 둘 중 하나다.
//
// **독립 오라클**(§5 — 리포트 의존 금지): 적용 전 청정 스냅샷을 잡고, 적용 후
// 타겟을 실제 `git` 으로 재검사해 판정한다. 파서·핸들러 리포트를 신뢰하지 않는다.
//
// **실검출 급소**(§5): 재직렬화가 no-newline 마커를 탈락시키면 파일 말미에 개행이
// 오염된다(조용한 코드 오염 — 최악의 결함). 이 리그는 그 오염을 독립 오라클로 잡는다.
// 결함 주입은 WMUX_RIG_J2_DROP_NONEWLINE=1 로 켠다(EVIDENCE 절차):
//   주입 ON → 리그 red(오염 검출) → 주입 OFF(원복) → green.
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUnifiedDiff, reassembleFile, type DiffFile } from '../../src/shared/diffParse';

// 결함 주입 토글(EVIDENCE 절차 전용). 기본 OFF.
const DROP_NONEWLINE = process.env.WMUX_RIG_J2_DROP_NONEWLINE === '1';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// 주입된 결함을 흉내내는 재조립: no-newline 마커 라인을 탈락시킨다(재직렬화 급소).
function reassembleWithFault(file: DiffFile, idxs: number[]): string {
  const clean = reassembleFile(file, idxs);
  if (!DROP_NONEWLINE) return clean;
  // "\ No newline at end of file" 라인을 제거 → git apply가 파일 말미에 개행을 붙임.
  return clean
    .split('\n')
    .filter((l) => !l.startsWith('\\ No newline'))
    .join('\n');
}

describe('J2 채택 원자성 — 독립 git 오라클 (설계 §5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-rig-j2-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // 청정 타겟 repo + 태스크 worktree(미커밋 변경)를 만든다.
  function scenario(baseContent: Record<string, string>, changes: Record<string, string>) {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    g(repo, ['init', '-q', '-b', 'main']);
    g(repo, ['config', 'user.email', 't@t']);
    g(repo, ['config', 'user.name', 't']);
    g(repo, ['config', 'core.autocrlf', 'false']);
    for (const [p, c] of Object.entries(baseContent)) writeFileSync(join(repo, p), c);
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-q', '-m', 'base']);
    const wt = join(dir, 'wt');
    g(repo, ['worktree', 'add', '-q', '-b', 'wtask/x', wt, 'HEAD']);
    for (const [p, c] of Object.entries(changes)) writeFileSync(join(wt, p), c);
    return { repo, wt };
  }

  it('선택 hunk 채택 후 타겟은 "선택분 정확히 반영" — 독립 오라클', () => {
    const { repo, wt } = scenario({ 'a.txt': 'l1\nl2\nl3\n' }, { 'a.txt': 'l1\nCHANGED\nl3\n' });
    const diff = g(wt, ['diff']);
    const file = parseUnifiedDiff(diff).files[0];
    const patch = reassembleWithFault(file, [0]);
    const patchPath = join(dir, 'p.diff');
    writeFileSync(patchPath, patch);
    // 청정 오라클: 적용 전 타겟은 base.
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3\n');
    g(repo, ['apply', patchPath]);
    // 독립 오라클: 타겟을 실제 git으로 재검사.
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('l1\nCHANGED\nl3\n');
  });

  it('no-newline 파일 채택 — 파일 말미 개행 오염 없음(실검출 급소)', () => {
    // base·변경 모두 개행 없이 끝남.
    const { repo, wt } = scenario({ 'a.txt': 'l1\nl2\nl3' }, { 'a.txt': 'l1\nCHANGED\nl3' });
    const diff = g(wt, ['diff']);
    expect(diff).toContain('\\ No newline at end of file');
    const file = parseUnifiedDiff(diff).files[0];
    const patch = reassembleWithFault(file, [0]);
    const patchPath = join(dir, 'p.diff');
    writeFileSync(patchPath, patch);
    g(repo, ['apply', patchPath]);
    // 독립 오라클: 결과가 base와 동일하게 개행 없이 끝나야 한다.
    // 결함 주입(마커 탈락) 시 git이 말미 개행을 붙여 이 어서션이 red가 된다.
    const result = readFileSync(join(repo, 'a.txt'), 'utf8');
    expect(result).toBe('l1\nCHANGED\nl3');
    expect(result.endsWith('\n'), '파일 말미 개행 오염 없음').toBe(false);
  });

  it('all-or-nothing — 잘못된 패치는 타겟을 전혀 건드리지 않음(원자성)', () => {
    const { repo, wt } = scenario({ 'a.txt': 'l1\nl2\nl3\n' }, { 'a.txt': 'l1\nCHANGED\nl3\n' });
    const diff = g(wt, ['diff']);
    const file = parseUnifiedDiff(diff).files[0];
    // 타겟을 미리 드리프트시켜 apply가 실패하도록(컨텍스트 불일치).
    writeFileSync(join(repo, 'a.txt'), 'DIFFERENT\nfile\ncontent\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-q', '-m', 'drift']);
    const before = readFileSync(join(repo, 'a.txt'), 'utf8');
    const patch = reassembleWithFault(file, [0]);
    const patchPath = join(dir, 'p.diff');
    writeFileSync(patchPath, patch);
    let failed = false;
    try {
      g(repo, ['apply', patchPath]);
    } catch {
      failed = true;
    }
    // 독립 오라클: apply가 실패했다면 타겟은 apply 전과 바이트 동일(부분 적용 없음).
    if (failed) {
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe(before);
    }
  });
});
