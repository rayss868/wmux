// GhPrService — PrProvider의 GitHub(gh CLI) 구현.
//
// PrStatusCache와 별개 서비스다(의도): 그쪽은 "브랜치→PR 1건, 5분 TTL,
// metadata 5s 폴 기생" 전용 전역 싱글턴이라 계약을 흔들 수 없다. 여기는
// repo 단위 PR "목록"(30s TTL) + PR 코멘트 상세(updatedAt 키 캐시 —
// 목록의 updatedAt이 안 변했으면 재fetch 생략)를 담당한다.
//
// gh 관례는 기존 스택 그대로: 비대화형 env(GH_PROMPT_DISABLED/GH_PAGER/
// NO_COLOR — TaskPrService.GH_ENV와 동일), 버전≠인증 2단 게이트
// (TaskPrService G3), ENOENT → 프로세스 수명 동안 조용히 미가용
// (PrStatusCache.ghAvailable 패턴), never-throw.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PR_COMMENT_BODY_CAP,
  type PrProvider,
  type PrGate,
  type PrListResult,
  type PrDetailResult,
  type PrSummary,
  type PrComment,
} from './PrProvider';

const execFileAsync = promisify(execFile);

const LIST_TTL_MS = 30_000;
const GH_TIMEOUT_MS = 10_000;
const LIST_LIMIT = 30;
/** 캐시 상한 — repo 수 기준(목록)·PR 수 기준(상세). 현실 규모 훨씬 위. */
const MAX_ENTRIES = 128;

const GH_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  GH_PAGER: 'cat',
  NO_COLOR: '1',
};

type Exec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean },
) => Promise<{ stdout: string }>;

// ── gh JSON 페이로드 매핑(순수, 테스트용 export) ────────────────────────────

interface GhListItem {
  number?: number;
  title?: string;
  state?: string;
  isDraft?: boolean;
  author?: { login?: string };
  headRefName?: string;
  updatedAt?: string;
  url?: string;
  reviewDecision?: string;
  statusCheckRollup?: Array<{ status?: string; conclusion?: string; state?: string }> | null;
}

// CI 롤업 3상 — PrStatusCache.mapGhPrView의 규칙을 그대로 복제(그 함수는
// PrStatus 전용 시그니처라 재사용 대신 규칙 복제; 값 계약은 동일).
function mapChecks(rollup: GhListItem['statusCheckRollup']): PrSummary['checks'] {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let failing = false;
  let pending = false;
  for (const c of rollup) {
    const conclusion = (c.conclusion ?? c.state ?? '').toUpperCase();
    const status = (c.status ?? '').toUpperCase();
    if (
      conclusion === 'FAILURE' ||
      conclusion === 'TIMED_OUT' ||
      conclusion === 'CANCELLED' ||
      conclusion === 'ERROR'
    ) {
      failing = true;
    } else if (conclusion === 'PENDING' || (status && status !== 'COMPLETED')) {
      pending = true;
    }
  }
  return failing ? 'failing' : pending ? 'pending' : 'passing';
}

export function mapGhListItem(json: GhListItem): PrSummary | null {
  if (typeof json.number !== 'number' || typeof json.url !== 'string') return null;
  const rawState = (json.state ?? '').toUpperCase();
  const state: PrSummary['state'] =
    rawState === 'MERGED' ? 'merged' : rawState === 'CLOSED' ? 'closed' : json.isDraft ? 'draft' : 'open';
  return {
    number: json.number,
    title: json.title ?? '',
    state,
    author: json.author?.login ?? '',
    headRefName: json.headRefName ?? '',
    updatedAt: json.updatedAt ?? '',
    url: json.url,
    reviewDecision: json.reviewDecision ?? '',
    checks: mapChecks(json.statusCheckRollup),
  };
}

interface GhDetailJson {
  number?: number;
  comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string; url?: string }>;
  reviews?: Array<{
    author?: { login?: string };
    body?: string;
    state?: string;
    submittedAt?: string;
    url?: string;
  }>;
}

function capBody(body: string): { body: string; truncated: boolean } {
  if (Buffer.byteLength(body, 'utf8') <= PR_COMMENT_BODY_CAP) return { body, truncated: false };
  // 문자 단위 절단(UTF-8 바이트 캡 근사) — 표시용이라 정밀 바이트 절단 불요.
  return { body: body.slice(0, PR_COMMENT_BODY_CAP), truncated: true };
}

/** comments + (본문 있는) reviews를 시간순 단일 스트림으로 정규화. */
export function mapGhDetail(json: GhDetailJson, prUrl: string): PrComment[] {
  const out: PrComment[] = [];
  for (const c of json.comments ?? []) {
    if (typeof c.body !== 'string') continue;
    const { body, truncated } = capBody(c.body);
    out.push({
      author: c.author?.login ?? '',
      body,
      createdAt: c.createdAt ?? '',
      url: c.url ?? prUrl,
      kind: 'comment',
      reviewState: '',
      truncated,
    });
  }
  for (const r of json.reviews ?? []) {
    // 본문 없는 순수 승인/거부 리뷰도 상태 자체가 정보라 포함한다.
    const raw = typeof r.body === 'string' ? r.body : '';
    const { body, truncated } = capBody(raw);
    out.push({
      author: r.author?.login ?? '',
      body,
      createdAt: r.submittedAt ?? '',
      url: r.url ?? prUrl,
      kind: 'review',
      reviewState: (r.state ?? '').toUpperCase(),
      truncated,
    });
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

// ── 서비스 본체 ───────────────────────────────────────────────────────────────

interface ListEntry {
  value: PrListResult;
  fetchedAt: number;
  pending: Promise<PrListResult> | null;
}

export class GhPrService implements PrProvider {
  private listCache = new Map<string, ListEntry>();
  /** 상세 캐시 — key = repo\0number, updatedAt이 같으면 재fetch 생략. */
  private detailCache = new Map<string, { updatedAt: string; value: PrDetailResult }>();
  private ghAvailable: boolean | null = null;

  constructor(
    private now: () => number = Date.now,
    private exec: Exec = execFileAsync,
  ) {}

  private gh(args: string[], cwd: string): Promise<{ stdout: string }> {
    return this.exec(process.platform === 'win32' ? 'gh.exe' : 'gh', args, {
      cwd,
      timeout: GH_TIMEOUT_MS,
      env: GH_ENV,
      windowsHide: true,
    });
  }

  async gate(repoPath: string): Promise<PrGate> {
    if (this.ghAvailable === false) {
      return { ok: false, reason: 'cli-missing', message: 'GitHub CLI (gh) is not installed' };
    }
    try {
      await this.gh(['--version'], repoPath);
      this.ghAvailable = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') this.ghAvailable = false;
      return { ok: false, reason: 'cli-missing', message: 'GitHub CLI (gh) is not installed' };
    }
    try {
      await this.gh(['auth', 'status'], repoPath);
    } catch {
      return {
        ok: false,
        reason: 'unauthenticated',
        message: 'GitHub CLI is not authenticated — run `gh auth login`',
      };
    }
    return { ok: true };
  }

  async listPrs(repoPath: string): Promise<PrListResult> {
    const key = repoPath.toLowerCase();
    const entry = this.listCache.get(key);
    const now = this.now();
    if (entry) {
      if (entry.pending) return entry.pending;
      if (now - entry.fetchedAt < LIST_TTL_MS) return entry.value;
    }
    const pending = this.fetchList(repoPath)
      .then((value) => {
        this.listCache.set(key, { value, fetchedAt: this.now(), pending: null });
        return value;
      })
      .catch((err) => {
        const value: PrListResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
        this.listCache.set(key, { value, fetchedAt: this.now(), pending: null });
        return value;
      });
    this.listCache.set(key, {
      value: entry?.value ?? { ok: true, prs: [] },
      fetchedAt: entry?.fetchedAt ?? 0,
      pending,
    });
    this.evict(this.listCache);
    return pending;
  }

  private async fetchList(repoPath: string): Promise<PrListResult> {
    try {
      const { stdout } = await this.gh(
        [
          'pr',
          'list',
          '--limit',
          String(LIST_LIMIT),
          '--json',
          'number,title,state,isDraft,author,headRefName,updatedAt,url,reviewDecision,statusCheckRollup',
        ],
        repoPath,
      );
      const arr = JSON.parse(stdout) as GhListItem[];
      const prs = (Array.isArray(arr) ? arr : [])
        .map(mapGhListItem)
        .filter((p): p is PrSummary => p !== null);
      return { ok: true, prs };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { ok: false, error: (e.stderr || e.message || String(err)).slice(0, 300) };
    }
  }

  async prDetail(repoPath: string, number: number, updatedAt: string): Promise<PrDetailResult> {
    const key = `${repoPath.toLowerCase()}\0${number}`;
    const cached = this.detailCache.get(key);
    // updatedAt 불변 → 코멘트 재fetch 생략(rate limit 상한의 핵심).
    if (cached && cached.updatedAt === updatedAt && cached.value.ok) return cached.value;
    try {
      const { stdout } = await this.gh(
        ['pr', 'view', String(number), '--json', 'number,url,comments,reviews'],
        repoPath,
      );
      const json = JSON.parse(stdout) as GhDetailJson & { url?: string };
      const value: PrDetailResult = {
        ok: true,
        detail: { number, comments: mapGhDetail(json, json.url ?? '') },
      };
      this.detailCache.set(key, { updatedAt, value });
      this.evict(this.detailCache);
      return value;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      return { ok: false, error: (e.stderr || e.message || String(err)).slice(0, 300) };
    }
  }

  private evict(cache: Map<string, unknown>): void {
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
}

/** 프로세스 전역 싱글턴 — 30s TTL 창을 모든 호출자가 공유. */
export const ghPrService = new GhPrService();
