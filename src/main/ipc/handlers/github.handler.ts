// Git 탭 PR 섹션 — github:prList / github:prDetail main 핸들러.
//
// 렌더러 전용 IPC(파이프 미노출). 흐름: origin 호스트 감지 → github면 gh
// 게이트(설치·인증) → GhPrService(30s TTL 캐시). 모든 실패는 code를 담아
// fail-soft로 강등 — 렌더러가 게이트 안내문/빈 상태로 렌더한다.
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { detectProviderHost } from '../../github/PrProvider';
import type { PrSummary, PrDetail } from '../../github/PrProvider';
import { ghPrService } from '../../github/GhPrService';

export type GithubPrListResult =
  | { ok: true; prs: PrSummary[] }
  | {
      ok: false;
      code: 'no-remote' | 'unsupported-host' | 'cli-missing' | 'unauthenticated' | 'error';
      message: string;
    };

export type GithubPrDetailResult =
  | { ok: true; detail: PrDetail }
  | { ok: false; code: 'error'; message: string };

async function prList(repoPath: string, force: boolean): Promise<GithubPrListResult> {
  const host = await detectProviderHost(repoPath);
  if (host === 'none') return { ok: false, code: 'no-remote', message: 'no origin remote' };
  if (host !== 'github') {
    // provider 추상화 v1 = GitHub만. GitLab(glab)은 후속 구현체.
    return { ok: false, code: 'unsupported-host', message: 'origin is not a GitHub host' };
  }
  const gate = await ghPrService.gate(repoPath);
  if (!gate.ok) {
    return {
      ok: false,
      code: gate.reason === 'cli-missing' ? 'cli-missing' : 'unauthenticated',
      message: gate.message,
    };
  }
  const res = await ghPrService.listPrs(repoPath, force);
  if (!res.ok) return { ok: false, code: 'error', message: res.error };
  return { ok: true, prs: res.prs };
}

export function registerGithubHandlers(): () => void {
  ipcMain.removeHandler(IPC.GITHUB_PR_LIST);
  ipcMain.handle(
    IPC.GITHUB_PR_LIST,
    wrapHandler(IPC.GITHUB_PR_LIST, async (_e: Electron.IpcMainInvokeEvent, repoPath: unknown, force: unknown) => {
      if (typeof repoPath !== 'string' || !repoPath) {
        return { ok: false, code: 'error', message: 'repoPath required' } satisfies GithubPrListResult;
      }
      return prList(repoPath, force === true);
    }),
  );

  ipcMain.removeHandler(IPC.GITHUB_PR_DETAIL);
  ipcMain.handle(
    IPC.GITHUB_PR_DETAIL,
    wrapHandler(
      IPC.GITHUB_PR_DETAIL,
      async (
        _e: Electron.IpcMainInvokeEvent,
        repoPath: unknown,
        number: unknown,
        updatedAt: unknown,
      ): Promise<GithubPrDetailResult> => {
        if (typeof repoPath !== 'string' || !repoPath) {
          return { ok: false, code: 'error', message: 'repoPath required' };
        }
        if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
          return { ok: false, code: 'error', message: 'valid PR number required' };
        }
        const res = await ghPrService.prDetail(
          repoPath,
          number,
          typeof updatedAt === 'string' ? updatedAt : '',
        );
        if (!res.ok) return { ok: false, code: 'error', message: res.error };
        return { ok: true, detail: res.detail };
      },
    ),
  );

  return () => {
    ipcMain.removeHandler(IPC.GITHUB_PR_LIST);
    ipcMain.removeHandler(IPC.GITHUB_PR_DETAIL);
  };
}
