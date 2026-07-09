// ─── TaskPrService — J3 §2 gh 4중 게이트 1클릭 PR ────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { TaskPrService, type PrExec, type CreatePrInput } from '../TaskPrService';

const VALID_PR = 'https://github.com/acme/widget/pull/42';

const INPUT: CreatePrInput = {
  taskId: 'wtask-1',
  verifiedWorkspaceId: 'ws-owner',
  worktreePath: '/wt/task-1',
  branch: 'wtask/task-1-abcd1234',
  title: 'Fix the thing',
};

/** exec 스텁: (cmd,args) 시그니처별로 stdout 반환 또는 throw. 호출 로그 노출. */
function makeExec(
  behavior: (cmd: string, args: string[]) => { stdout: string } | { throw: string },
): { exec: PrExec; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: PrExec = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = behavior(cmd, args);
    if ('throw' in r) {
      const err = new Error(r.throw) as Error & { stderr?: string };
      err.stderr = r.throw;
      throw err;
    }
    return { stdout: r.stdout, stderr: '' };
  };
  return { exec, calls };
}

function isGh(cmd: string): boolean {
  return cmd === 'gh' || cmd === 'gh.exe';
}
function argStr(args: string[]): string {
  return args.join(' ');
}

/** 정상 경로 기본 동작(테스트가 개별 스텁으로 override). */
function happyBehavior(cmd: string, args: string[]): { stdout: string } | { throw: string } {
  const a = argStr(args);
  if (isGh(cmd)) {
    if (a.startsWith('--version')) return { stdout: 'gh version 2.0.0' };
    if (a.startsWith('auth status')) return { stdout: 'Logged in' };
    if (a.startsWith('repo view')) return { stdout: 'main' };
    if (a.startsWith('pr create')) return { stdout: `Creating pull request\n${VALID_PR}` };
    if (a.startsWith('pr list')) return { stdout: VALID_PR };
  }
  if (cmd === 'git') {
    if (a.startsWith('status')) return { stdout: '' }; // clean
    if (a.startsWith('remote')) return { stdout: 'origin' };
    if (a.startsWith('push')) return { stdout: '' };
  }
  return { stdout: '' };
}

function makeService(exec: PrExec, opts?: { daemonOk?: boolean }) {
  const daemonCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const daemon = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      daemonCalls.push({ method, params });
      return { ok: opts?.daemonOk ?? true };
    }),
  };
  const invalidate = vi.fn();
  const svc = new TaskPrService({ daemon, cache: { invalidate }, exec });
  return { svc, daemon, daemonCalls, invalidate };
}

describe('J3 §2 gh 게이트(버전·인증)', () => {
  it('gh 미설치: gh-missing + 브라우저 폴백', async () => {
    const { exec } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('--version') ? { throw: 'not found' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('gh-missing');
    expect(res.browseFallback).toBeTruthy();
  });

  it('gh 미인증(버전은 있음): gh-unauth', async () => {
    const { exec } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('auth status') ? { throw: 'not logged in' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('gh-unauth');
  });
});

describe('J3 §2 dirty 차단(CX7)', () => {
  it('미커밋 변경이 있으면 push 전에 dirty로 차단', async () => {
    const { exec, calls } = makeExec((cmd, args) =>
      cmd === 'git' && argStr(args).startsWith('status') ? { stdout: ' M file.ts\n' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('dirty');
    // push가 실행되지 않았어야 한다(차단 후 중단).
    expect(calls.find((c) => c.cmd === 'git' && c.args[0] === 'push')).toBeUndefined();
  });
});

describe('J3 §2 no-origin(fork·다중 remote 자동 추측 금지 §7·CL9)', () => {
  it('origin remote 부재는 명시 에러', async () => {
    const { exec } = makeExec((cmd, args) =>
      cmd === 'git' && argStr(args).startsWith('remote') ? { stdout: 'upstream\nfork' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('no-origin');
  });
});

describe('J3 §2 정상 1클릭 PR', () => {
  it('push + pr create(--base 명시) + prUrl 커밋 + invalidate', async () => {
    const { exec, calls } = makeExec(happyBehavior);
    const { svc, daemonCalls, invalidate } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.prUrl).toBe(VALID_PR);

    // push -u origin -- {branch}(F6 세퍼레이터).
    const push = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
    expect(push?.args).toEqual(['push', '-u', 'origin', '--', INPUT.branch]);

    // pr create에 --base가 실 값(main)으로 실렸는지.
    const create = calls.find((c) => isGh(c.cmd) && c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create?.args).toContain('--base');
    const baseIdx = create!.args.indexOf('--base');
    expect(create!.args[baseIdx + 1]).toBe('main');
    // --head도 브랜치로 명시.
    expect(create!.args).toContain('--head');

    // prUrl 데몬 커밋 + PrStatusCache invalidate.
    const upd = daemonCalls.find((c) => c.method === 'task.mission.update');
    expect(upd?.params.prUrl).toBe(VALID_PR);
    expect(invalidate).toHaveBeenCalledWith(INPUT.worktreePath, INPUT.branch);
  });

  it('F6 — repo view 실패면 base 추측 없이 명시 에러(pr create 안 함)', async () => {
    const { exec, calls } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('repo view') ? { throw: 'no default' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
    expect(res.error).toContain('base');
    // base 미상이면 pr create를 시도하지 않는다(엉뚱한 base 방지).
    expect(calls.find((c) => isGh(c.cmd) && c.args[0] === 'pr' && c.args[1] === 'create')).toBeUndefined();
  });

  it('F6 — defaultBranchRef 빈 응답도 명시 에러', async () => {
    const { exec } = makeExec((cmd, args) =>
      isGh(cmd) && argStr(args).startsWith('repo view') ? { stdout: '' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
  });
});

describe('J3 §2 멱등 재진입(CX5+G4)', () => {
  it('pr create 실패 → pr list로 기존 URL 회수 수렴', async () => {
    const { exec } = makeExec((cmd, args) => {
      const a = argStr(args);
      if (isGh(cmd) && a.startsWith('pr create')) return { throw: 'a pull request already exists' };
      if (isGh(cmd) && a.startsWith('pr list')) return { stdout: VALID_PR };
      return happyBehavior(cmd, args);
    });
    const { svc, daemonCalls } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.recovered).toBe(true);
    expect(res.prUrl).toBe(VALID_PR);
    // 회수 경로도 prUrl을 커밋한다.
    expect(daemonCalls.find((c) => c.method === 'task.mission.update')?.params.prUrl).toBe(VALID_PR);
  });

  it('pr create 실패 + 기존 PR도 없음 → pr-failed', async () => {
    const { exec } = makeExec((cmd, args) => {
      const a = argStr(args);
      if (isGh(cmd) && a.startsWith('pr create')) return { throw: 'boom' };
      if (isGh(cmd) && a.startsWith('pr list')) return { stdout: '' };
      return happyBehavior(cmd, args);
    });
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
  });
});

describe('J3 §2 URL 검증(G5)', () => {
  it('pr create가 비-github URL을 뱉으면 회수 실패 시 pr-failed', async () => {
    const { exec } = makeExec((cmd, args) => {
      const a = argStr(args);
      if (isGh(cmd) && a.startsWith('pr create')) return { stdout: 'https://evil.example.com/pull/1' };
      if (isGh(cmd) && a.startsWith('pr list')) return { stdout: '' };
      return happyBehavior(cmd, args);
    });
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('pr-failed');
  });
});

describe('J3 §2 push 실패', () => {
  it('git push 실패는 push-failed', async () => {
    const { exec } = makeExec((cmd, args) =>
      cmd === 'git' && argStr(args).startsWith('push') ? { throw: 'permission denied' } : happyBehavior(cmd, args),
    );
    const { svc } = makeService(exec);
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('push-failed');
  });
});

describe('J3 §2 prUrl 커밋 실패(비치명)', () => {
  it('데몬 update 실패는 commitPending으로 표기(PR 자체는 성공)', async () => {
    const { exec } = makeExec(happyBehavior);
    const { svc } = makeService(exec, { daemonOk: false });
    const res = await svc.createPr(INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.commitPending).toBe(true);
    expect(res.prUrl).toBe(VALID_PR);
  });
});
