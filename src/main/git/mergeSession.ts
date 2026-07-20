// 격리 integration 워크트리 기반 stateful merge session 헬퍼 (B-MVP).
//
// 프리미티브: 사용자의 base 체크아웃(로컬 main 등)을 절대 직접 건드리지 않고,
// base ref에서 분기한 **격리 integration 워크트리**에서 git-native 머지 →
// verify 게이트(exit code) → 성공 시에만 Land로 base를 fast-forward.
//
// 안전 계약(3-모델 리뷰 확정):
//  - 충돌 판정은 merge exit code나 stderr(로케일 종속)가 아니라
//    `git diff --name-only --diff-filter=U -z`의 비어있음 여부로 한다.
//  - 머지 대상은 움직이는 브랜치명이 아니라 캡처된 source OID.
//  - "done" 텍스트는 신뢰하지 않는다 — verify는 오직 프로세스 exit code로 판정.
//  - 세션 정본은 git 디스크 상태(MERGE_HEAD)에서 파생 → 앱 재시작 후에도 복구.
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git } from './git';
import { getGitExecEnv } from '../../shared/execEnv';
import { branchToDirName } from '../../shared/worktreeParse';

const execFileAsync = promisify(execFile);

/** integration 워크트리 디렉토리 leaf 접두 — 재시작 복구 시 인식 마커. */
export const INTEGRATION_PREFIX = '.wmux-merge-';

export type MergePhase = 'merging' | 'conflicted' | 'clean' | 'verifying' | 'verified' | 'failed';

export interface VerifyResult {
  readonly ok: boolean;
  /** 실패한 단계(있으면). */
  readonly failedStep?: 'test' | 'lint';
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  /** 마지막 출력 tail(진단용, cap 적용). */
  readonly output: string;
}

/** 렌더러로 내려가는 세션 공개 스냅샷(내부 OID 등은 handler가 별도 보관). */
export interface MergeSessionStatus {
  readonly sessionId: string;
  readonly baseBranch: string;
  readonly baseCheckoutPath: string;
  readonly sourceBranch: string | null;
  readonly sourceOid: string;
  readonly integrationPath: string;
  readonly phase: MergePhase;
  /** 미해결 충돌 파일(상대경로). */
  readonly conflicts: string[];
  /** 스테이징된 변경 파일 수(요약용). */
  readonly changedFiles: number;
  readonly verify?: VerifyResult;
}

type OkErr = { ok: true } | { ok: false; error: string };

// ── 순수/저수준 헬퍼 (단위 테스트 대상) ─────────────────────────────────────

/** NUL(-z) 구분 리스트 파서. 빈 문자열·후행 NUL은 버린다. */
export function parseNulList(raw: string): string[] {
  return raw.split('\0').filter((s) => s.length > 0);
}

/** integration 워크트리 여부(경로 leaf 접두로 인식). */
export function isIntegrationPath(p: string): boolean {
  return basename(p.replace(/[/\\]+$/, '')).startsWith(INTEGRATION_PREFIX);
}

/**
 * 미해결(unmerged) 경로 목록. 충돌 판정은 이 결과가 비어있는지로만 한다
 * (exit code·stderr 아님 — Codex correctness finding).
 */
export async function detectConflicts(cwd: string): Promise<string[]> {
  const r = await git(['diff', '--name-only', '--diff-filter=U', '-z'], cwd);
  return parseNulList(r.stdout);
}

/** 스테이징된 변경 파일 수(머지 후 index vs HEAD). */
async function countStaged(cwd: string): Promise<number> {
  const r = await git(['diff', '--cached', '--name-only', '-z'], cwd);
  return parseNulList(r.stdout).length;
}

/**
 * gh 없이 순수 git으로 base 브랜치 해결 — `symbolic-ref origin/HEAD` →
 * main/master 폴백. 해결 실패면 null. (resolveBaseBranch의 폴백 경로이자
 * gh 미설치 환경의 정본.)
 */
export async function resolveBaseFromGit(cwd: string): Promise<string | null> {
  const sym = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (sym.code === 0) {
    // --short는 refs/remotes/origin/main → 'origin/main'으로 축약. remote 접두 제거.
    const name = sym.stdout.trim().replace(/^origin\//, '');
    if (name) return name;
  }
  for (const cand of ['main', 'master']) {
    const v = await git(['rev-parse', '-q', '--verify', `refs/heads/${cand}`], cwd);
    if (v.code === 0) return cand;
  }
  return null;
}

/** gh 대화형 봉쇄 env(로그인 프롬프트·pager). mac GUI PATH 보정 포함. */
function ghEnv(): NodeJS.ProcessEnv {
  return { ...getGitExecEnv(), GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' };
}

/** `gh repo view` default 브랜치(TaskPrService와 동일 패턴). 실패·부재면 null. */
async function ghDefaultBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      { cwd, timeout: 20_000, windowsHide: true, env: ghEnv() },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** base 브랜치 명시 해결: gh default → git symbolic-ref → main/master. */
export async function resolveBaseBranch(cwd: string): Promise<string | null> {
  return (await ghDefaultBranch(cwd)) ?? (await resolveBaseFromGit(cwd));
}

/**
 * 타겟(base 체크아웃) 전제조건: MERGE_HEAD 없음 · 비detached & HEAD==base ·
 * 완전 clean(status --porcelain 비어있음). base 체크아웃은 여기로 fast-forward
 * 되므로 이 셋이 깨지면 Land가 불일치를 만든다.
 */
export async function checkTargetPreconditions(baseCheckoutPath: string, base: string): Promise<OkErr> {
  const mh = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], baseCheckoutPath);
  if (mh.code === 0) return { ok: false, error: `타겟 워크트리에 진행 중인 머지가 있습니다(MERGE_HEAD)` };
  const sym = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], baseCheckoutPath);
  if (sym.code !== 0) return { ok: false, error: `타겟 워크트리가 detached HEAD 상태입니다` };
  const cur = sym.stdout.trim();
  if (cur !== base) return { ok: false, error: `타겟 워크트리가 base(${base})가 아니라 ${cur}에 있습니다` };
  const st = await git(['status', '--porcelain'], baseCheckoutPath);
  if (st.code !== 0) return { ok: false, error: st.stderr.slice(0, 300) };
  if (st.stdout.trim() !== '') return { ok: false, error: `타겟 워크트리에 커밋되지 않은 변경이 있습니다` };
  return { ok: true };
}

/**
 * 워크트리의 MERGING 상태를 디스크에서 파생(재시작 복구·list 표면화용).
 * MERGE_HEAD 존재 → merging, 있으면 미해결 충돌 수도 함께.
 */
export async function readMergeState(worktreePath: string): Promise<{ merging: boolean; conflicts: number }> {
  const mh = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktreePath);
  if (mh.code !== 0) return { merging: false, conflicts: 0 };
  const conflicts = await detectConflicts(worktreePath);
  return { merging: true, conflicts: conflicts.length };
}

// ── verify 러너 ─────────────────────────────────────────────────────────────

/** Windows는 npm.cmd. mac GUI는 getGitExecEnv PATH로 node/npm(Homebrew) 해결. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export interface VerifyStep {
  readonly step: 'test' | 'lint';
  readonly cmd: string;
  readonly args: string[];
}

/** B-MVP 하드코딩 게이트: `npm test` && `npm run lint`(플랜 §4). */
export const DEFAULT_VERIFY_STEPS: readonly VerifyStep[] = [
  { step: 'test', cmd: NPM, args: ['test'] },
  { step: 'lint', cmd: NPM, args: ['run', 'lint'] },
];

const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_CAP = 4000;

function tail(s: string, cap = OUTPUT_TAIL_CAP): string {
  return s.length <= cap ? s : s.slice(s.length - cap);
}

/**
 * verify 게이트 실행 — 각 단계를 순차 실행, **하나라도 비0 exit면 즉시 실패**.
 * 판정은 오직 exit code. steps는 테스트 주입 가능(기본 npm test/lint).
 */
export async function runVerify(
  cwd: string,
  opts?: { steps?: readonly VerifyStep[]; signal?: AbortSignal; timeoutMs?: number },
): Promise<VerifyResult> {
  const steps = opts?.steps ?? DEFAULT_VERIFY_STEPS;
  let combined = '';
  for (const s of steps) {
    const header = `$ ${s.cmd} ${s.args.join(' ')}\n`;
    try {
      const { stdout, stderr } = await execFileAsync(s.cmd, s.args, {
        cwd,
        timeout: opts?.timeoutMs ?? VERIFY_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: getGitExecEnv(),
        signal: opts?.signal,
      });
      combined += header + stdout + stderr;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; killed?: boolean; signal?: string; name?: string; code?: string };
      combined += header + (err.stdout ?? '') + (err.stderr ?? '');
      const aborted = err.name === 'AbortError' || err.code === 'ABORT_ERR';
      const timedOut = !aborted && err.killed === true;
      return { ok: false, failedStep: s.step, timedOut, aborted, output: tail(combined) };
    }
  }
  return { ok: true, output: tail(combined) };
}

// ── 워크트리·머지·Land/Discard 오케스트레이션 ───────────────────────────────

/**
 * 격리 integration 워크트리 생성 — base OID에서 detached로. 관례 위치는
 * addWorktree와 동형(<main부모>/<main이름>-worktrees/<접두+source>).
 */
export async function createIntegrationWorktree(
  mainWt: string,
  baseOid: string,
  sourceLeaf: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const parent = join(dirname(mainWt), `${basename(mainWt)}-worktrees`);
  const leaf = INTEGRATION_PREFIX + (branchToDirName(sourceLeaf) || 'src');
  const path = resolve(parent, leaf);
  if (existsSync(path)) return { ok: false, error: `integration 경로가 이미 존재합니다: ${path}` };
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const r = await git(['worktree', 'add', '--detach', path, baseOid], mainWt);
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) };
  return { ok: true, path };
}

/** integration 워크트리 제거 — 우리 소유의 일회용 표면이라 --force 안전. */
export async function removeIntegrationWorktree(mainWt: string, integrationPath: string): Promise<OkErr> {
  const r = await git(['worktree', 'remove', '--force', integrationPath], mainWt);
  if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 300) };
  return { ok: true };
}

export interface MergeOutcome {
  readonly phase: 'clean' | 'conflicted';
  readonly conflicts: string[];
  readonly changedFiles: number;
}

/**
 * `git merge --no-commit --no-ff <source-OID>`(캡처 OID) 실행 후 충돌 판정.
 * unmerged>0 → conflicted. unmerged==0 && 비0 exit → 운영 실패(구분). 그 외 clean.
 */
export async function runMergeNoCommit(
  integrationPath: string,
  sourceOid: string,
): Promise<{ ok: true; outcome: MergeOutcome } | { ok: false; error: string }> {
  const m = await git(['merge', '--no-commit', '--no-ff', sourceOid], integrationPath);
  const conflicts = await detectConflicts(integrationPath);
  if (conflicts.length > 0) {
    return { ok: true, outcome: { phase: 'conflicted', conflicts, changedFiles: await countStaged(integrationPath) } };
  }
  if (m.code !== 0) {
    // unmerged 0 + 비0 exit = 운영 실패(충돌 아님). "Already up to date"는 exit 0이라 여기 안 옴.
    return { ok: false, error: (m.stderr || m.stdout).slice(0, 300) };
  }
  return { ok: true, outcome: { phase: 'clean', conflicts: [], changedFiles: await countStaged(integrationPath) } };
}

export interface LandParams {
  readonly integrationPath: string;
  readonly baseCheckoutPath: string;
  readonly baseOid: string;
  readonly base: string;
  readonly sourceOid: string;
}

/**
 * Land — base OID 재검증 후 integration 결과를 커밋하고 base를 그 결과로
 * fast-forward. base가 이동했거나 미해결 충돌이 남았으면 거부.
 */
export async function landMerge(
  p: LandParams,
): Promise<{ ok: true; landedOid: string; alreadyUpToDate?: boolean } | { ok: false; error: string }> {
  // 1) base 재검증 — 시작 이후 이동/오염되지 않았나.
  const head = await git(['rev-parse', 'HEAD'], p.baseCheckoutPath);
  if (head.code !== 0) return { ok: false, error: 'base 워크트리 HEAD 확인 실패' };
  if (head.stdout.trim() !== p.baseOid) {
    return { ok: false, error: '머지 시작 이후 base가 이동했습니다 — Discard 후 다시 시도하세요' };
  }
  const pre = await checkTargetPreconditions(p.baseCheckoutPath, p.base);
  if (!pre.ok) return { ok: false, error: pre.error };

  // 2) integration 상태 재검증 후 커밋.
  const mh = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], p.integrationPath);
  if (mh.code === 0) {
    if (mh.stdout.trim() !== p.sourceOid) return { ok: false, error: 'integration MERGE_HEAD가 예상 source와 다릅니다' };
    const conflicts = await detectConflicts(p.integrationPath);
    if (conflicts.length > 0) return { ok: false, error: '미해결 충돌이 남아 있습니다' };
    const c = await git(['commit', '--no-edit'], p.integrationPath);
    if (c.code !== 0) return { ok: false, error: c.stderr.slice(0, 300) };
  }
  const landed = await git(['rev-parse', 'HEAD'], p.integrationPath);
  const landedOid = landed.stdout.trim();
  if (landedOid === p.baseOid) {
    // 전진할 것 없음(already up to date).
    return { ok: true, landedOid, alreadyUpToDate: true };
  }

  // 3) base를 integration 결과로 fast-forward(index·워킹트리 일관 갱신).
  const ff = await git(['merge', '--ff-only', landedOid], p.baseCheckoutPath);
  if (ff.code !== 0) return { ok: false, error: `base fast-forward 실패: ${ff.stderr.slice(0, 300)}` };
  return { ok: true, landedOid };
}

/** Discard — integration의 진행 중 머지를 abort(있을 때만). 워크트리 제거는 호출부. */
export async function abortIntegrationMerge(integrationPath: string): Promise<void> {
  const mh = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], integrationPath);
  if (mh.code === 0) await git(['merge', '--abort'], integrationPath);
}
