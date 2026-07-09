// J2 — diff:read / diff:applyHunks main 핸들러 (스펙 §2·§3)
//
// diff:read: 태스크 worktree cwd에서 워킹트리 대조 diff를 읽어 파싱·numstat·
//   untracked 합성·타겟 스냅샷을 동봉해 반환(§2).
// diff:applyHunks: 스냅샷 드리프트 게이트 → dirty 거부 → per-hunk 프로브 →
//   선택 hunk 단일 패치 all-or-nothing apply(§3). 타겟 repo 단위 뮤텍스.
import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, normalize } from 'node:path';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import {
  parseUnifiedDiff,
  reassemblePatch,
  synthesizeNewFileDiff,
  DIFF_TOTAL_CAP_BYTES,
  DIFF_FILE_CAP_BYTES,
  type DiffFile,
  type DiffReadResult,
  type DiffReadError,
  type DiffNumstat,
  type DiffTargetSnapshot,
  type DiffApplyRequest,
  type DiffApplyResult,
  type HunkProbe,
} from '../../../shared/diffParse';

const execFileAsync = promisify(execFile);

// git 실행 헬퍼. cwd 고정, 타임아웃·버퍼 캡. throw 대신 stdout/stderr/code 반환.
async function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(e),
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

// 타겟 repo 단위 직렬 큐(§3 R15 — J1 per-repo 뮤텍스 패턴 재사용).
// key = 타겟 repo 경로. J1 TaskWorktreeManager.withRepoLock과 동형이나
// 그 인스턴스는 FanOutService 내부라 additive 원칙상 동일 패턴을 복제.
const repoChains = new Map<string, Promise<unknown>>();
function withRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoChains.get(repoKey) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  repoChains.set(
    repoKey,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// 워크트리 cwd → 본 repo(common dir의 상위) 경로. 실패 시 null.
async function resolveTargetRepo(worktreePath: string): Promise<string | null> {
  const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreePath);
  if (r.code !== 0) return null;
  const commonDir = r.stdout.trim();
  if (!commonDir) return null;
  // common-dir은 `<repo>/.git`. 그 상위가 repo 루트. 단, bare/비표준은 toplevel로 보정.
  const top = await git(['-C', commonDir, 'rev-parse', '--show-toplevel'], worktreePath);
  if (top.code === 0 && top.stdout.trim()) return top.stdout.trim();
  // 폴백: common-dir이 `/x/.git`이면 `/x`.
  return commonDir.replace(/[/\\]\.git[/\\]?$/, '');
}

// 타겟 스냅샷 수집(§2 드리프트 게이트 재료).
async function collectSnapshot(targetRepoPath: string): Promise<DiffTargetSnapshot> {
  const [head, branch, status] = await Promise.all([
    git(['rev-parse', 'HEAD'], targetRepoPath),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], targetRepoPath),
    git(['status', '--porcelain'], targetRepoPath),
  ]);
  const dirty: string[] = [];
  for (const line of status.stdout.split('\n')) {
    if (line.length < 4) continue;
    // 포맷 "XY path". rename은 " -> " 포함 — 우측 경로만.
    const p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    dirty.push(arrow >= 0 ? p.slice(arrow + 4) : p);
  }
  return {
    targetRepoPath,
    targetBranch: branch.stdout.trim(),
    targetHeadOid: head.stdout.trim(),
    targetDirtyFiles: dirty,
  };
}

// numstat 파싱(파일 트리 표시용). binary는 "-\t-\tpath".
function parseNumstat(raw: string): DiffNumstat[] {
  const out: DiffNumstat[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [a, d, ...rest] = parts;
    const path = rest.join('\t');
    out.push({
      path,
      additions: a === '-' ? null : Number.parseInt(a, 10),
      deletions: d === '-' ? null : Number.parseInt(d, 10),
    });
  }
  return out;
}

// diff:read 구현.
async function readDiff(
  worktreePath: string,
  targetHeadOid: string,
): Promise<DiffReadResult | DiffReadError> {
  const targetRepoPath = await resolveTargetRepo(worktreePath);
  if (!targetRepoPath) {
    return { ok: false, error: '타겟 repo를 찾을 수 없음(worktree 손상?)', code: 'no-repo' };
  }

  // targetHeadOid 미지정 시 타겟 repo의 현 HEAD를 사용(렌더러가 미리 알 필요 없음).
  let headOid = targetHeadOid;
  if (!headOid) {
    const h = await git(['rev-parse', 'HEAD'], targetRepoPath);
    headOid = h.code === 0 ? h.stdout.trim() : '';
  }

  // mergeBase = merge-base HEAD {targetHeadOid} — 단일 출처(§2 G8).
  const mb = await git(['merge-base', 'HEAD', headOid], worktreePath);
  const mergeBase = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : headOid;

  // 1-arg 워킹트리 대조(미커밋 포함). untracked 제외 — 별도 합성.
  const diffRes = await git(['diff', mergeBase], worktreePath);
  if (diffRes.code !== 0) {
    return { ok: false, error: `git diff 실패: ${diffRes.stderr.slice(0, 200)}`, code: 'diff-fail' };
  }
  const numRes = await git(['diff', '--numstat', mergeBase], worktreePath);

  // untracked 수집 → 정식 new-file 헤더 합성(§2 R4).
  const utRes = await git(['status', '--porcelain', '-uall'], worktreePath);
  const untracked: string[] = [];
  for (const line of utRes.stdout.split('\n')) {
    if (line.startsWith('?? ')) untracked.push(line.slice(3));
  }

  let diffText = diffRes.stdout;
  const truncated: string[] = [];
  const extraNumstat: DiffNumstat[] = [];

  for (const rel of untracked) {
    try {
      const full = join(worktreePath, rel);
      const stat = await readFile(full);
      if (stat.length > DIFF_FILE_CAP_BYTES) {
        truncated.push(rel);
        extraNumstat.push({ path: rel, additions: null, deletions: null });
        continue;
      }
      // 바이너리 휴리스틱: NUL 바이트 존재.
      if (stat.includes(0)) {
        truncated.push(rel);
        extraNumstat.push({ path: rel, additions: null, deletions: null });
        continue;
      }
      const content = stat.toString('utf8');
      diffText += synthesizeNewFileDiff(rel, content);
      const lineCount = content.length === 0 ? 0 : content.replace(/\n$/, '').split('\n').length;
      extraNumstat.push({ path: rel, additions: lineCount, deletions: 0 });
    } catch {
      // 읽기 실패(레이스로 삭제 등) — 조용히 건너뜀.
    }
  }

  // 총량 캡(§2). 초과 시 파싱은 하되 큰 파일은 표시 전용 마킹.
  if (Buffer.byteLength(diffText, 'utf8') > DIFF_TOTAL_CAP_BYTES) {
    return {
      ok: false,
      error: 'diff 총량이 2MB를 초과 — 표시 전용(채택 불가). 커밋 단위를 좁혀 재열람.',
      code: 'too-large',
    };
  }

  const parsed = parseUnifiedDiff(diffText);
  // 파일당 캡 초과 파일을 truncated로(파싱은 유지하되 안내).
  const files: DiffFile[] = [];
  for (const f of parsed.files) {
    const size = f.headerBlock.length + f.hunks.reduce((s, h) => s + h.bodyLines.join('\n').length, 0);
    if (size > DIFF_FILE_CAP_BYTES && !truncated.includes(f.path)) truncated.push(f.path);
    files.push(f);
  }

  const snapshot = await collectSnapshot(targetRepoPath);
  const numstat = [...parseNumstat(numRes.stdout), ...extraNumstat];

  return { ok: true, files, numstat, snapshot, truncated };
}

// 패치 내부 경로 검증(§3 R16): a/ b/ 정규화 후 .. 거부·절대경로 거부.
function patchPathsSafe(patch: string): boolean {
  for (const line of patch.split('\n')) {
    let p: string | null = null;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      p = line.slice(4).split('\t')[0];
    } else if (line.startsWith('diff --git ')) {
      // "diff --git a/x b/y" — 두 경로 모두 검사.
      const m = line.match(/^diff --git (\S+) (\S+)$/);
      if (m) {
        for (const raw of [m[1], m[2]]) {
          const s = raw.replace(/^[ab]\//, '');
          if (s !== '/dev/null' && (isAbsolute(s) || normalize(s).startsWith('..'))) return false;
        }
      }
      continue;
    }
    if (p === null) continue;
    if (p === '/dev/null') continue;
    const s = p.replace(/^[ab]\//, '');
    if (isAbsolute(s) || normalize(s).startsWith('..')) return false;
  }
  return true;
}

// diff:applyHunks 구현.
async function applyHunks(req: DiffApplyRequest, worktreePath: string): Promise<DiffApplyResult> {
  const targetRepoPath = await resolveTargetRepo(worktreePath);
  if (!targetRepoPath) {
    return { ok: false, error: '타겟 repo를 찾을 수 없음', code: 'apply' };
  }

  return withRepoLock(targetRepoPath, async (): Promise<DiffApplyResult> => {
    // ① 드리프트 게이트(§2·§3): 스냅샷의 HEAD/브랜치가 현재와 일치해야 함.
    const cur = await collectSnapshot(targetRepoPath);
    if (
      cur.targetHeadOid !== req.snapshot.targetHeadOid ||
      cur.targetBranch !== req.snapshot.targetBranch
    ) {
      return { ok: false, error: '타겟이 이동됨 — diff 재열람 필요', code: 'drift' };
    }

    // 선택 파일의 diff를 재계산(태스크 worktree 기준). read와 동일 소스.
    const read = await readDiff(worktreePath, req.snapshot.targetHeadOid);
    if (!read.ok) return { ok: false, error: read.error, code: 'apply' };

    // 선택 파일 매핑 + 채택 가능성 검증.
    const selMap = new Map<string, readonly number[]>();
    for (const s of req.selections) selMap.set(s.path, s.hunkIndices);
    const selectedFiles: Array<{ file: DiffFile; hunkIndices: readonly number[] }> = [];
    for (const f of read.files) {
      const idxs = selMap.get(f.path);
      if (!idxs || idxs.length === 0) continue;
      if (!f.hunkSelectable) {
        return {
          ok: false,
          error: `${f.path}: rename·binary·mode 변경은 채택 불가`,
          code: 'unsupported',
        };
      }
      selectedFiles.push({ file: f, hunkIndices: idxs });
    }
    if (selectedFiles.length === 0) {
      return { ok: false, error: '선택된 hunk 없음', code: 'apply' };
    }

    // ② dirty 거부(§3): 대상 파일이 현재 dirty면 거부.
    const dirtySet = new Set(cur.targetDirtyFiles);
    for (const sf of selectedFiles) {
      if (dirtySet.has(sf.file.path)) {
        return {
          ok: false,
          error: `${sf.file.path}: 타겟에 미커밋 변경 있음 — 충돌 방지로 거부`,
          code: 'dirty',
        };
      }
    }

    const patch = reassemblePatch(selectedFiles);
    if (!patchPathsSafe(patch)) {
      return { ok: false, error: '패치 내부 경로 검증 실패(.. 또는 절대경로)', code: 'path' };
    }

    // ③ per-hunk 프로브(§3): 각 hunk 개별 --check + --reverse --check.
    const failedProbes: HunkProbe[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'wmux-diff-'));
    try {
      for (const sf of selectedFiles) {
        for (const idx of sf.hunkIndices) {
          const single = reassemblePatch([{ file: sf.file, hunkIndices: [idx] }]);
          const pPath = join(dir, `probe-${Math.random().toString(36).slice(2)}.diff`);
          await writeFile(pPath, single);
          const check = await git(['apply', '--check', pPath], targetRepoPath);
          const reverse = await git(['apply', '--reverse', '--check', pPath], targetRepoPath);
          const probe: HunkProbe = {
            path: sf.file.path,
            hunkIndex: idx,
            applicable: check.code === 0,
            alreadyApplied: reverse.code === 0,
          };
          if (!probe.applicable && !probe.alreadyApplied) failedProbes.push(probe);
        }
      }
      if (failedProbes.length > 0) {
        return {
          ok: false,
          error: '일부 hunk가 타겟에 적용 불가 — 선택 해제 후 재시도',
          code: 'probe',
          failedProbes,
        };
      }

      // ④ 단일 패치 all-or-nothing apply(§3). --unsafe-paths 금지.
      const patchPath = join(dir, 'apply.diff');
      await writeFile(patchPath, patch);
      const applied = await git(['apply', patchPath], targetRepoPath);
      if (applied.code !== 0) {
        return {
          ok: false,
          error: `git apply 실패(타겟 미변경): ${applied.stderr.slice(0, 200)}`,
          code: 'apply',
        };
      }
      return { ok: true, appliedFiles: selectedFiles.map((s) => s.file.path) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

export function registerDiffHandlers(): () => void {
  ipcMain.removeHandler(IPC.DIFF_READ);
  ipcMain.handle(
    IPC.DIFF_READ,
    wrapHandler(
      IPC.DIFF_READ,
      async (
        _event: Electron.IpcMainInvokeEvent,
        worktreePath: unknown,
        targetHeadOid: unknown,
      ): Promise<DiffReadResult | DiffReadError> => {
        if (typeof worktreePath !== 'string' || !worktreePath) {
          return { ok: false, error: 'worktreePath 필요', code: 'bad-args' };
        }
        // targetHeadOid는 선택 — 미지정 시 타겟 repo HEAD로 도출.
        const head = typeof targetHeadOid === 'string' ? targetHeadOid : '';
        return readDiff(worktreePath, head);
      },
    ),
  );

  ipcMain.removeHandler(IPC.DIFF_APPLY_HUNKS);
  ipcMain.handle(
    IPC.DIFF_APPLY_HUNKS,
    wrapHandler(
      IPC.DIFF_APPLY_HUNKS,
      async (
        _event: Electron.IpcMainInvokeEvent,
        req: unknown,
        worktreePath: unknown,
      ): Promise<DiffApplyResult> => {
        if (typeof worktreePath !== 'string' || !worktreePath) {
          return { ok: false, error: 'worktreePath 필요', code: 'apply' };
        }
        const r = req as DiffApplyRequest;
        if (!r || !r.snapshot || !Array.isArray(r.selections)) {
          return { ok: false, error: 'applyHunks 요청 형식 오류', code: 'apply' };
        }
        return applyHunks(r, worktreePath);
      },
    ),
  );

  return () => {
    ipcMain.removeHandler(IPC.DIFF_READ);
    ipcMain.removeHandler(IPC.DIFF_APPLY_HUNKS);
  };
}
