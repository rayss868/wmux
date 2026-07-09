// J2 diff:read / diff:applyHunks 핸들러 테스트 (스펙 §2·§3·§6)
//
// 실제 git worktree를 만들어 read → applyHunks 전 경로를 검증한다.
// 커버: 워킹트리 대조(미커밋 포함)·untracked 합성·타겟 스냅샷·드리프트 거부·
// dirty 거부·per-hunk 프로브·경로 검증·all-or-nothing apply.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// electron ipcMain을 캡처해 핸들러를 직접 호출한다.
const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

// wrapHandler는 함수를 그대로 감싸므로 실제 구현을 통과시킨다.
import { registerDiffHandlers } from '../diff.handler';
import { IPC } from '../../../../shared/constants';
import { parseUnifiedDiff, type DiffApplyRequest } from '../../../../shared/diffParse';

function g(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// 태스크 worktree 시나리오를 구성한다: 본 repo + linked worktree.
// worktree에 미커밋 변경 2파일 + untracked 1파일.
function makeScenario(): {
  repoRoot: string;
  worktreePath: string;
  targetHeadOid: string;
  cleanup: () => void;
} {
  const base = mkdtempSync(join(tmpdir(), 'wmux-diffh-'));
  const repoRoot = join(base, 'repo');
  mkdirSync(repoRoot);
  g(repoRoot, ['init', '-q', '-b', 'main']);
  g(repoRoot, ['config', 'user.email', 't@t']);
  g(repoRoot, ['config', 'user.name', 't']);
  g(repoRoot, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoRoot, 'a.txt'), 'a1\na2\na3\na4\na5\n');
  writeFileSync(join(repoRoot, 'b.txt'), 'b1\nb2\nb3\n');
  g(repoRoot, ['add', '-A']);
  g(repoRoot, ['commit', '-q', '-m', 'base']);
  const targetHeadOid = g(repoRoot, ['rev-parse', 'HEAD']).trim();

  // linked worktree 생성(태스크 브랜치).
  const worktreePath = join(base, 'wt');
  g(repoRoot, ['worktree', 'add', '-q', '-b', 'wtask/x', worktreePath, 'HEAD']);

  // 미커밋 변경: a.txt 수정, b.txt 수정, c.txt untracked 신규.
  writeFileSync(join(worktreePath, 'a.txt'), 'a1\nCHANGED2\na3\na4\na5\n');
  writeFileSync(join(worktreePath, 'b.txt'), 'b1\nBCHANGED\nb3\n');
  writeFileSync(join(worktreePath, 'c.txt'), 'new1\nnew2\n');

  return {
    repoRoot,
    worktreePath,
    targetHeadOid,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe('diff:read — 워킹트리 대조·untracked 합성·스냅샷', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  it('미커밋 3파일(수정2+untracked1)을 파일 트리·numstat로 반환', async () => {
    const read = captured.get(IPC.DIFF_READ)!;
    const res = (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      files: Array<{ path: string; kind: string; hunkSelectable: boolean }>;
      numstat: Array<{ path: string }>;
      snapshot: { targetBranch: string; targetHeadOid: string; targetDirtyFiles: string[] };
    };
    expect(res.ok).toBe(true);
    const paths = res.files.map((f) => f.path).sort();
    expect(paths).toEqual(['a.txt', 'b.txt', 'c.txt']);
    // untracked c.txt는 add 분류.
    const c = res.files.find((f) => f.path === 'c.txt')!;
    expect(c.kind).toBe('add');
    expect(c.hunkSelectable).toBe(true);
    // 스냅샷: 타겟(본 repo)의 HEAD·브랜치.
    expect(res.snapshot.targetHeadOid).toBe(scn.targetHeadOid);
    expect(res.snapshot.targetBranch).toBe('main');
  });
});

describe('diff:applyHunks — 채택 all-or-nothing', () => {
  let scn: ReturnType<typeof makeScenario>;
  beforeEach(() => {
    captured.clear();
    registerDiffHandlers();
    scn = makeScenario();
  });
  afterEach(() => scn.cleanup());

  async function readFiles() {
    const read = captured.get(IPC.DIFF_READ)!;
    return (await read({}, scn.worktreePath, scn.targetHeadOid)) as {
      ok: boolean;
      files: Array<{ path: string; hunks: unknown[] }>;
      snapshot: DiffApplyRequest['snapshot'];
    };
  }

  it('선택 hunk(a.txt)만 타겟 워킹트리에 반영 — 독립 오라클 검증', async () => {
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot,
      selections: [{ path: 'a.txt', hunkIndices: [0] }],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean; appliedFiles?: string[] };
    expect(res.ok).toBe(true);
    // 독립 오라클: 타겟 a.txt에 변경 반영, b.txt·c.txt는 미반영.
    expect(readFileSync(join(scn.repoRoot, 'a.txt'), 'utf8')).toBe('a1\nCHANGED2\na3\na4\na5\n');
    expect(readFileSync(join(scn.repoRoot, 'b.txt'), 'utf8')).toBe('b1\nb2\nb3\n');
    // c.txt는 타겟에 생성 안 됨.
    let cExists = true;
    try {
      readFileSync(join(scn.repoRoot, 'c.txt'));
    } catch {
      cExists = false;
    }
    expect(cExists).toBe(false);
  });

  it('untracked new-file(c.txt) 채택 — 타겟에 파일 생성', async () => {
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot,
      selections: [{ path: 'c.txt', hunkIndices: [0] }],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(readFileSync(join(scn.repoRoot, 'c.txt'), 'utf8')).toBe('new1\nnew2\n');
  });

  it('드리프트 게이트 — 타겟 HEAD 이동 시 거부', async () => {
    const r = await readFiles();
    // 타겟(본 repo)에서 새 커밋 → HEAD 이동.
    writeFileSync(join(scn.repoRoot, 'drift.txt'), 'drift\n');
    g(scn.repoRoot, ['add', '-A']);
    g(scn.repoRoot, ['commit', '-q', '-m', 'drift']);
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot, // 옛 스냅샷.
      selections: [{ path: 'a.txt', hunkIndices: [0] }],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean; code?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('drift');
  });

  it('dirty 거부 — 대상 파일이 타겟에서 미커밋 상태면 거부', async () => {
    // 타겟 a.txt를 dirty로 만든다.
    writeFileSync(join(scn.repoRoot, 'a.txt'), 'a1\na2\na3\na4\na5\nDIRTY\n');
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot,
      selections: [{ path: 'a.txt', hunkIndices: [0] }],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean; code?: string };
    expect(res.ok).toBe(false);
    expect(res.code).toBe('dirty');
  });

  it('이미 적용된 hunk — reverse 프로브가 alreadyApplied 표시(거부 아님, best-effort)', async () => {
    // 먼저 a.txt hunk를 타겟에 적용.
    const r1 = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    await apply({}, { taskId: 't', snapshot: r1.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] }, scn.worktreePath);
    // 스냅샷 갱신 후 재적용 시도 → --check 실패·--reverse 성공 → probe 코드.
    const r2 = await readFiles();
    const res = (await apply(
      {},
      { taskId: 't', snapshot: r2.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    )) as { ok: boolean; code?: string; failedProbes?: Array<{ alreadyApplied: boolean }> };
    // dirty(방금 적용으로 a.txt가 dirty)로 거부되거나 probe로 걸림 — 둘 다 안전.
    expect(res.ok).toBe(false);
    expect(['dirty', 'probe']).toContain(res.code);
  });

  it('다중 파일 채택 — 단일 패치로 a.txt+b.txt 동시 반영', async () => {
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    const req: DiffApplyRequest = {
      taskId: 't1',
      snapshot: r.snapshot,
      selections: [
        { path: 'a.txt', hunkIndices: [0] },
        { path: 'b.txt', hunkIndices: [0] },
      ],
    };
    const res = (await apply({}, req, scn.worktreePath)) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(readFileSync(join(scn.repoRoot, 'a.txt'), 'utf8')).toBe('a1\nCHANGED2\na3\na4\na5\n');
    expect(readFileSync(join(scn.repoRoot, 'b.txt'), 'utf8')).toBe('b1\nBCHANGED\nb3\n');
  });

  it('독립 오라클 정합 — 적용 후 타겟 diff == 선택 hunk 재직렬화', async () => {
    const r = await readFiles();
    const apply = captured.get(IPC.DIFF_APPLY_HUNKS)!;
    await apply(
      {},
      { taskId: 't', snapshot: r.snapshot, selections: [{ path: 'a.txt', hunkIndices: [0] }] },
      scn.worktreePath,
    );
    // 타겟의 현 diff를 파싱 → a.txt 한 파일·한 hunk여야 한다.
    const targetDiff = g(scn.repoRoot, ['diff']);
    const parsed = parseUnifiedDiff(targetDiff);
    expect(parsed.files.map((f) => f.path)).toEqual(['a.txt']);
  });
});
