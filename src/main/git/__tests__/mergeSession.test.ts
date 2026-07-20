// mergeSession 헬퍼 테스트 — 실제 임시 git repo로 왕복 검증(worktree.handler.test 스타일).
// 충돌 감지 파서(diff-filter=U / NUL), 전제조건 검사, base 해결 폴백,
// verify exit-code 판정, clean 머지→Land / 충돌→Discard 왕복을 커버한다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseNulList,
  detectConflicts,
  checkTargetPreconditions,
  resolveBaseFromGit,
  runVerify,
  createIntegrationWorktree,
  removeIntegrationWorktree,
  runMergeNoCommit,
  landMerge,
  abortIntegrationMerge,
  readMergeState,
  isIntegrationPath,
} from '../mergeSession';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// main 브랜치 + base 커밋 1개짜리 임시 repo.
function makeRepo(): { base: string; repo: string; cleanup: () => void } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'wmux-ms-')));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.email', 't@t']);
  g(repo, ['config', 'user.name', 't']);
  writeFileSync(join(repo, 'f.txt'), 'a\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'base']);
  return { base, repo, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// feat 브랜치에 커밋 하나(main으로 복귀). content로 clean/conflict를 조절.
function addFeat(repo: string, content: string): string {
  g(repo, ['checkout', '-q', '-b', 'feat']);
  writeFileSync(join(repo, 'f.txt'), content);
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'feat']);
  const oid = g(repo, ['rev-parse', 'feat']).trim();
  g(repo, ['checkout', '-q', 'main']);
  return oid;
}

describe('parseNulList — NUL(-z) 구분 파서', () => {
  it('NUL 구분 항목을 분리하고 빈 항목/후행 NUL을 버린다', () => {
    expect(parseNulList('a.txt\0b/c.txt\0')).toEqual(['a.txt', 'b/c.txt']);
    expect(parseNulList('')).toEqual([]);
    expect(parseNulList('only.txt')).toEqual(['only.txt']);
  });
});

describe('isIntegrationPath — 접두 인식', () => {
  it('.wmux-merge- 접두 leaf만 integration으로 인식', () => {
    expect(isIntegrationPath('/x/repo-worktrees/.wmux-merge-feat')).toBe(true);
    expect(isIntegrationPath('/x/repo-worktrees/feat')).toBe(false);
    expect(isIntegrationPath('/x/repo-worktrees/.wmux-merge-feat/')).toBe(true); // 후행 슬래시
  });
});

describe('detectConflicts — 충돌 감지(exit code 아님)', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => (scn = makeRepo()));
  afterEach(() => scn.cleanup());

  it('충돌 머지는 unmerged 파일 목록을 반환, clean 머지는 빈 목록', async () => {
    // main2 vs feat 충돌 세팅.
    const featOid = addFeat(scn.repo, 'FEAT\n');
    writeFileSync(join(scn.repo, 'f.txt'), 'MAIN\n');
    g(scn.repo, ['add', '-A']);
    g(scn.repo, ['commit', '-q', '-m', 'main2']);
    const baseOid = g(scn.repo, ['rev-parse', 'HEAD']).trim();

    const created = await createIntegrationWorktree(scn.repo, baseOid, 'feat');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const merged = await runMergeNoCommit(created.path, featOid);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.outcome.phase).toBe('conflicted');
    expect(merged.outcome.conflicts).toEqual(['f.txt']);

    // detectConflicts 직접 호출도 동일.
    expect(await detectConflicts(created.path)).toEqual(['f.txt']);

    // 정리: abort + remove.
    await abortIntegrationMerge(created.path);
    const rm = await removeIntegrationWorktree(scn.repo, created.path);
    expect(rm.ok).toBe(true);
    expect(existsSync(created.path)).toBe(false);
  });
});

describe('checkTargetPreconditions — 타겟(base) 전제조건', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => (scn = makeRepo()));
  afterEach(() => scn.cleanup());

  it('clean·HEAD==base·MERGE_HEAD 없음 → ok', async () => {
    const r = await checkTargetPreconditions(scn.repo, 'main');
    expect(r.ok).toBe(true);
  });

  it('커밋되지 않은 변경이 있으면 거부', async () => {
    writeFileSync(join(scn.repo, 'f.txt'), 'dirty\n');
    const r = await checkTargetPreconditions(scn.repo, 'main');
    expect(r.ok).toBe(false);
  });

  it('base가 아닌 브랜치(HEAD 불일치)면 거부', async () => {
    // main은 clean이지만 base를 'master'로 요구하면 불일치.
    const r = await checkTargetPreconditions(scn.repo, 'master');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('base(master)');
  });

  it('진행 중 머지(MERGE_HEAD)가 있으면 거부', async () => {
    const featOid = addFeat(scn.repo, 'FEAT\n');
    writeFileSync(join(scn.repo, 'f.txt'), 'MAIN\n');
    g(scn.repo, ['add', '-A']);
    g(scn.repo, ['commit', '-q', '-m', 'main2']);
    // main 워크트리 자체에서 충돌 머지를 걸어 MERGE_HEAD를 남긴다.
    try {
      g(scn.repo, ['merge', '--no-commit', '--no-ff', featOid]);
    } catch {
      /* 충돌로 비0 exit — MERGE_HEAD는 남는다 */
    }
    const r = await checkTargetPreconditions(scn.repo, 'main');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('MERGE_HEAD');
  });
});

describe('resolveBaseFromGit — 폴백 체인(gh 없이)', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => (scn = makeRepo()));
  afterEach(() => scn.cleanup());

  it('origin/HEAD symbolic-ref가 있으면 그 브랜치명', async () => {
    // origin remote를 bare repo로 흉내내고 origin/HEAD를 설정.
    const remoteBare = join(scn.base, 'remote.git');
    g(scn.base, ['clone', '-q', '--bare', scn.repo, remoteBare]);
    g(scn.repo, ['remote', 'add', 'origin', remoteBare]);
    g(scn.repo, ['fetch', '-q', 'origin']);
    g(scn.repo, ['remote', 'set-head', 'origin', 'main']);
    expect(await resolveBaseFromGit(scn.repo)).toBe('main');
  });

  it('origin 없으면 main/master 폴백', async () => {
    // remote 없음 → symbolic-ref 실패 → refs/heads/main 존재 → 'main'.
    expect(await resolveBaseFromGit(scn.repo)).toBe('main');
  });

  it('main 없고 master만 있으면 master', async () => {
    g(scn.repo, ['branch', '-m', 'main', 'master']);
    expect(await resolveBaseFromGit(scn.repo)).toBe('master');
  });
});

describe('runVerify — exit code 판정(주입 명령)', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => (scn = makeRepo()));
  afterEach(() => scn.cleanup());

  it('모든 단계 exit 0 → ok:true', async () => {
    const res = await runVerify(scn.repo, {
      steps: [
        { step: 'test', cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
        { step: 'lint', cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
      ],
    });
    expect(res.ok).toBe(true);
  });

  it('한 단계라도 비0 exit → ok:false + 실패 단계 기록', async () => {
    const res = await runVerify(scn.repo, {
      steps: [
        { step: 'test', cmd: process.execPath, args: ['-e', 'process.exit(0)'] },
        { step: 'lint', cmd: process.execPath, args: ['-e', 'process.exit(3)'] },
      ],
    });
    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe('lint');
  });
});

describe('clean 머지 → Land 왕복', () => {
  let scn: ReturnType<typeof makeRepo>;
  beforeEach(() => (scn = makeRepo()));
  afterEach(() => scn.cleanup());

  it('격리 워크트리 머지 후 base를 결과로 fast-forward', async () => {
    const featOid = addFeat(scn.repo, 'a\nfeat\n'); // main과 충돌 없는 변경.
    const baseOid = g(scn.repo, ['rev-parse', 'HEAD']).trim();

    const created = await createIntegrationWorktree(scn.repo, baseOid, 'feat');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(isIntegrationPath(created.path)).toBe(true);

    const merged = await runMergeNoCommit(created.path, featOid);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.outcome.phase).toBe('clean');
    expect(merged.outcome.changedFiles).toBe(1);

    // integration은 MERGING 상태여야 함(readMergeState).
    expect(await readMergeState(created.path)).toEqual({ merging: true, conflicts: 0 });

    const landed = await landMerge({
      integrationPath: created.path,
      baseCheckoutPath: scn.repo,
      baseOid,
      base: 'main',
      sourceOid: featOid,
    });
    expect(landed.ok).toBe(true);

    // base(main)가 전진했고, 워킹트리에 feat 변경이 반영됐다.
    const newHead = g(scn.repo, ['rev-parse', 'HEAD']).trim();
    expect(newHead).not.toBe(baseOid);
    expect(g(scn.repo, ['show', 'HEAD:f.txt'])).toBe('a\nfeat\n');
    // 머지 커밋(--no-ff)이라 두 부모를 가진다.
    expect(g(scn.repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length).toBe(3);

    await removeIntegrationWorktree(scn.repo, created.path);
    expect(existsSync(created.path)).toBe(false);
  });

  it('base가 시작 이후 이동하면 Land 거부', async () => {
    const featOid = addFeat(scn.repo, 'a\nfeat\n');
    const baseOid = g(scn.repo, ['rev-parse', 'HEAD']).trim();
    const created = await createIntegrationWorktree(scn.repo, baseOid, 'feat');
    if (!created.ok) return;
    await runMergeNoCommit(created.path, featOid);

    // base 이동(main에 새 커밋).
    writeFileSync(join(scn.repo, 'g.txt'), 'x\n');
    g(scn.repo, ['add', '-A']);
    g(scn.repo, ['commit', '-q', '-m', 'moved']);

    const landed = await landMerge({
      integrationPath: created.path,
      baseCheckoutPath: scn.repo,
      baseOid, // 낡은 OID
      base: 'main',
      sourceOid: featOid,
    });
    expect(landed.ok).toBe(false);
    if (!landed.ok) expect(landed.error).toContain('이동');

    await abortIntegrationMerge(created.path);
    await removeIntegrationWorktree(scn.repo, created.path);
  });
});
