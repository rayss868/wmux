// J3 worktask 핸들러 — worktask:read-prompt 왕복 + 파일 소실 재발사 거부(§3·§6).
//
// electron ipcMain을 캡처해 핸들러를 직접 호출한다(diff.handler.test.ts 패턴).
// close·create-pr·scan의 핵심 로직은 서비스 단위 테스트가 담당하고, 여기서는
// 핸들러가 배선한 재발사 경로(prompt.md 실존 검사)를 검증한다.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

const captured = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
}));

import { registerWorktaskHandlers } from '../worktask.handler';
import { IPC } from '../../../../shared/constants';

/** 캡처한 핸들러를 event 인자 없이 payload로 호출. */
async function call(channel: string, payload: unknown): Promise<unknown> {
  const fn = captured.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn({} as unknown, payload);
}

let base: string;
let dispose: () => void;

beforeEach(() => {
  captured.clear();
  base = mkdtempSync(join(tmpdir(), 'wmux-wth-'));
  // 데몬 없음(read-prompt는 데몬 불요) — null 반환.
  dispose = registerWorktaskHandlers(() => null);
});
afterEach(() => {
  dispose();
  rmSync(base, { recursive: true, force: true });
});

/** worktreePath와 그 sibling meta dir(prompt.md 포함)을 만든다. 반환=worktreePath. */
function seedWorktreeWithPrompt(promptBody: string): string {
  const worktreePath = join(base, 'repohash', 'my-task-abcd1234');
  mkdirSync(worktreePath, { recursive: true });
  // metaDirForWorktree = dirname(wt)/.meta/basename(wt).
  const metaDir = join(dirname(worktreePath), '.meta', basename(worktreePath));
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, 'prompt.md'), promptBody, 'utf8');
  return worktreePath;
}

describe('worktask:read-prompt (§3 재발사 재료)', () => {
  it('prompt.md가 존재하면 본문을 반환한다(왕복)', async () => {
    const wt = seedWorktreeWithPrompt('do the thing across the repo');
    const res = (await call(IPC.WORKTASK_READ_PROMPT, { worktreePath: wt })) as
      | { ok: true; text: string }
      | { ok: false; error: string };
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.text).toBe('do the thing across the repo');
  });

  it('prompt.md가 소실되면 재발사를 거부한다(사유 반환)', async () => {
    // worktree만 있고 meta/prompt.md는 없음.
    const worktreePath = join(base, 'repohash', 'gone-task-abcd1234');
    mkdirSync(worktreePath, { recursive: true });
    const res = (await call(IPC.WORKTASK_READ_PROMPT, { worktreePath })) as
      | { ok: true; text: string }
      | { ok: false; error: string };
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toContain('소실');
  });

  it('worktreePath가 없으면 형태 에러', async () => {
    const res = (await call(IPC.WORKTASK_READ_PROMPT, {})) as { ok: false; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('worktreePath');
  });
});
