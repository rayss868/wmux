// PR 표면 provider 계약 — Git 탭의 PR 목록·코멘트가 소비하는 정규화 타입.
//
// v1 구현은 GitHub(gh CLI, GhPrService) 하나지만, 인터페이스는 호스트 중립으로
// 잡는다(오너 결정): GitLab은 glab CLI가 커맨드 대칭이라 후속 PR에서 구현체만
// 추가하면 된다. provider 선택은 origin remote의 호스트로 감지한다.
import { git } from '../git/git';
import type { PrSummary, PrComment, PrDetail } from '../../shared/prSurface';

// wire 타입은 shared/prSurface.ts가 정본(렌더러와 공유). 여기서 재노출해
// main 쪽 소비자(GhPrService/핸들러)의 import 표면을 한 곳으로 유지한다.
export type { PrSummary, PrComment, PrDetail };
export { PR_COMMENT_BODY_CAP } from '../../shared/prSurface';

export type PrGate =
  | { ok: true }
  | { ok: false; reason: 'cli-missing' | 'unauthenticated'; message: string };

export type PrListResult = { ok: true; prs: PrSummary[] } | { ok: false; error: string };
export type PrDetailResult = { ok: true; detail: PrDetail } | { ok: false; error: string };

/** 호스트 중립 provider 계약 — GhPrService가 v1 구현. */
export interface PrProvider {
  /** CLI 존재·인증 게이트. 실패는 사용자 안내 문구를 담아 fail-closed. */
  gate(repoPath: string): Promise<PrGate>;
  listPrs(repoPath: string): Promise<PrListResult>;
  prDetail(repoPath: string, number: number, updatedAt: string): Promise<PrDetailResult>;
}

export type ProviderHost = 'github' | 'unknown' | 'none';

/** origin remote URL → provider 호스트. 순수 파서(테스트용 export). */
export function classifyRemoteUrl(url: string): ProviderHost {
  const trimmed = url.trim();
  if (!trimmed) return 'none';
  // https://github.com/o/r(.git) | git@github.com:o/r.git | ssh://git@github.com/o/r
  const m = trimmed.match(/^(?:https?:\/\/|git@|ssh:\/\/(?:[^@/]+@)?)([^/:]+)/i);
  const host = m?.[1]?.toLowerCase() ?? '';
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  return 'unknown';
}

/** repo의 origin 호스트 감지 — remote 없으면 'none'. */
export async function detectProviderHost(repoPath: string): Promise<ProviderHost> {
  const r = await git(['remote', 'get-url', 'origin'], repoPath);
  if (r.code !== 0) return 'none';
  return classifyRemoteUrl(r.stdout);
}
