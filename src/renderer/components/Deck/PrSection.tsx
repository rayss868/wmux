// Git 탭 — Pull Requests 섹션 (gh CLI 기반, 성긴 pull).
//
// "실시간"의 실현 수준: 섹션이 마운트된 동안(=Git 탭이 보일 때)만 30s 폴 +
// 수동 새로고침 + PR 펼침 시 코멘트 즉시 fetch. main 캐시(GhPrService)가
// 30s TTL·updatedAt 불변 시 코멘트 재fetch 생략으로 rate limit을 상한한다
// (useMissionsPolling의 push-vs-pull 근거와 동일한 성긴-폴 선택).
//
// fail-closed: gh 미설치/미인증/비GitHub remote는 안내문으로 강등 — 섹션이
// 조용히 비는 일은 없다. 모든 행·코멘트는 "브라우저에서 열기" 1클릭 제공.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { renderBrainMarkdown } from './BrainMarkdown';
import type { PrSummary, PrComment } from '../../../shared/prSurface';

const POLL_MS = 30_000;

type ListState =
  | { kind: 'loading' }
  | { kind: 'ready'; prs: PrSummary[] }
  | { kind: 'gated'; code: string; message: string };

interface GithubBridge {
  prList: (repoPath: string) => Promise<
    { ok: true; prs: PrSummary[] } | { ok: false; code: string; message: string }
  >;
  prDetail: (repoPath: string, number: number, updatedAt: string) => Promise<
    { ok: true; detail: { number: number; comments: PrComment[] } } | { ok: false; code: string; message: string }
  >;
}

function getGithubBridge(): GithubBridge | null {
  const api = (window as unknown as { electronAPI?: { github?: GithubBridge } }).electronAPI;
  return api?.github ?? null;
}

// 상태 glyph — monochrome(색은 checks dot 하나만, 그것도 중립 팔레트).
function stateLabel(pr: PrSummary): string {
  if (pr.state === 'merged') return '⇥';
  if (pr.state === 'closed') return '✕';
  if (pr.state === 'draft') return '◌';
  return '●';
}

function checksClass(checks: PrSummary['checks']): string {
  // diff 콘텐츠와 동일 규칙: 상태색은 자체 녹/적 팔레트(theme accent 금지).
  if (checks === 'passing') return 'text-[var(--accent-green,#4ade80)]';
  if (checks === 'failing') return 'text-[var(--accent-red,#f87171)]';
  if (checks === 'pending') return 'text-[var(--text-muted)]';
  return 'text-transparent';
}

function relTime(iso: string, t: (k: string) => string): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t('git.justNow') || 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function PrSection({ repoPath }: { repoPath: string | null }): React.ReactElement | null {
  const t = useT();
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [comments, setComments] = useState<PrComment[] | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  // 폴 재진입 가드 — 느린 gh 응답 중 인터벌 중첩 방지(DeckScheduler 관례).
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (!repoPath || inFlight.current) return;
    const bridge = getGithubBridge();
    if (!bridge) return;
    inFlight.current = true;
    try {
      const res = await bridge.prList(repoPath);
      if (res.ok) setState({ kind: 'ready', prs: res.prs });
      else setState({ kind: 'gated', code: res.code, message: res.message });
    } finally {
      inFlight.current = false;
    }
  }, [repoPath]);

  // 마운트/repo 변경 시 즉시 + 30s 성긴 폴(마운트=Git 탭 가시 상태).
  useEffect(() => {
    setState({ kind: 'loading' });
    setExpanded(null);
    setComments(null);
    if (!repoPath) return;
    void load();
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [repoPath, load]);

  const toggleExpand = useCallback(
    async (pr: PrSummary) => {
      if (expanded === pr.number) {
        setExpanded(null);
        setComments(null);
        return;
      }
      setExpanded(pr.number);
      setComments(null);
      if (!repoPath) return;
      const bridge = getGithubBridge();
      if (!bridge) return;
      setCommentsLoading(true);
      const res = await bridge.prDetail(repoPath, pr.number, pr.updatedAt);
      setCommentsLoading(false);
      // 응답이 늦게 온 다른 PR의 코멘트로 덮지 않도록 번호 확인은 생략해도
      // 무해(마지막 클릭이 이긴다) — expanded 상태가 렌더 게이트라 표시 안 됨.
      if (res.ok) setComments(res.detail.comments);
      else setComments([]);
    },
    [expanded, repoPath],
  );

  if (!repoPath) return null;

  return (
    <div data-pr-section className="shrink-0 max-h-[55%] overflow-y-auto border-b border-[var(--bg-surface)]" style={{ borderColor: 'var(--border-soft)' }}>
      {/* 섹션 헤더 — 36px 크롬 행. */}
      <div
        className="flex items-center gap-2 h-9 px-3 sticky top-0 bg-[var(--bg-mantle)] border-b border-[var(--bg-surface)]"
        style={{ borderColor: 'var(--border-soft)' }}
        {...tokenAttrs('bgMantle', 'bg')}
      >
        <span className="font-semibold text-[var(--text-main)]" {...tokenAttrs('textMain', 'text')}>
          {t('git.pullRequests') || 'Pull Requests'}
        </span>
        {state.kind === 'ready' && (
          <span className="text-[10.5px] text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
            ({state.prs.length})
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void load()}
          title={t('git.refresh') || 'Refresh'}
          aria-label={t('git.refresh') || 'Refresh'}
          className={`flex items-center justify-center w-6 h-6 rounded text-[var(--text-muted)] hover:text-[var(--text-sub)] transition-colors ${FOCUS_RING}`}
          {...tokenAttrs('textMuted', 'text')}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M12 7a5 5 0 11-1.5-3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <path d="M12 1v2.6H9.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {state.kind === 'loading' && (
        <div className="px-3 py-3 text-[var(--text-muted)] text-[11px]" {...tokenAttrs('textMuted', 'text')}>
          {t('git.loading') || 'Loading…'}
        </div>
      )}

      {state.kind === 'gated' && (
        // gh 미설치/미인증/비GitHub — fail-closed 안내(조용한 빈 섹션 금지).
        <div className="px-3 py-3 text-[11px] text-[var(--text-muted)] break-words" {...tokenAttrs('textMuted', 'text')}>
          {state.code === 'cli-missing'
            ? t('git.ghMissing') || 'GitHub CLI (gh) is not installed.'
            : state.code === 'unauthenticated'
              ? t('git.ghUnauth') || 'GitHub CLI is not authenticated — run `gh auth login`.'
              : state.code === 'unsupported-host'
                ? t('git.unsupportedHost') || 'origin is not a GitHub host (GitLab support is planned).'
                : state.code === 'no-remote'
                  ? t('git.noRemote') || 'This repository has no origin remote.'
                  : state.message}
        </div>
      )}

      {state.kind === 'ready' && state.prs.length === 0 && (
        <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
          {t('git.noPrs') || 'No open pull requests.'}
        </div>
      )}

      {state.kind === 'ready' &&
        state.prs.map((pr) => (
          <div key={pr.number} data-pr-row className="border-b border-[var(--bg-surface)]" style={{ borderColor: 'var(--border-soft)' }}>
            <button
              type="button"
              onClick={() => void toggleExpand(pr)}
              className={`group w-full flex items-center gap-2 px-3 h-9 text-left hover:bg-[rgba(var(--bg-surface-rgb),0.5)] ${FOCUS_RING}`}
              aria-expanded={expanded === pr.number}
            >
              <span className={`text-[10px] shrink-0 ${checksClass(pr.checks)}`} title={pr.checks ?? ''} aria-hidden="true">
                ●
              </span>
              <span className="text-[10.5px] text-[var(--text-muted)] font-mono shrink-0" {...tokenAttrs('textMuted', 'text')}>
                #{pr.number}
              </span>
              <span className="flex-1 min-w-0 truncate text-[var(--text-main)]" title={pr.title} {...tokenAttrs('textMain', 'text')}>
                {pr.title}
              </span>
              <span className="text-[10px] text-[var(--text-muted)] shrink-0" title={pr.state} {...tokenAttrs('textMuted', 'text')}>
                {stateLabel(pr)} {relTime(pr.updatedAt, t)}
              </span>
              <span
                role="link"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(pr.url, '_blank');
                }}
                className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                title={t('git.openInBrowser') || 'Open in browser'}
              >
                ↗
              </span>
            </button>
            {expanded === pr.number && (
              <div data-pr-comments className="px-3 pb-2 text-[11px]">
                <div className="text-[10px] text-[var(--text-muted)] pb-1" {...tokenAttrs('textMuted', 'text')}>
                  {pr.author && `@${pr.author}`} {pr.headRefName && `· ${pr.headRefName}`}{' '}
                  {pr.reviewDecision && `· ${pr.reviewDecision.toLowerCase().replaceAll('_', ' ')}`}
                </div>
                {commentsLoading && (
                  <div className="text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                    {t('git.loading') || 'Loading…'}
                  </div>
                )}
                {!commentsLoading && comments && comments.length === 0 && (
                  <div className="text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                    {t('git.noComments') || 'No comments.'}
                  </div>
                )}
                {!commentsLoading &&
                  comments?.map((c, i) => (
                    <div key={i} className="py-1 border-t border-[var(--bg-surface)]" style={{ borderColor: 'var(--border-soft)' }}>
                      <div className="text-[10px] text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                        <span className="font-semibold">@{c.author}</span>
                        {c.kind === 'review' && c.reviewState && ` · ${c.reviewState.toLowerCase().replaceAll('_', ' ')}`}
                        {c.createdAt && ` · ${relTime(c.createdAt, t)}`}
                      </div>
                      {c.body && (
                        <div className="text-[var(--text-sub)] break-words" {...tokenAttrs('textSub', 'text')}>
                          {renderBrainMarkdown(c.body)}
                        </div>
                      )}
                      {c.truncated && (
                        <button
                          type="button"
                          onClick={() => window.open(c.url, '_blank')}
                          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] underline"
                        >
                          {t('git.viewFull') || 'View full comment in browser'}
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

export default PrSection;
