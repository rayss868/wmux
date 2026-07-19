import { describe, it, expect, vi, beforeEach } from 'vitest';

// macOS GUI 런치는 launchd 최소 PATH만 물려받아 Homebrew git을 못 찾는다 —
// execFile('git', …)이 이 PATH만 보고 조용히 실패하면서 워크스페이스 사이드바의
// 브랜치 동기화 배지가 macOS에서 안 뜨던 원인이었다(owner-reported 2026-07-19).
// getGitExecEnv()가 mac에서만 Homebrew/시스템 경로를 PATH에 보강하는지 고정한다.

vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>();
  return { ...actual, isMac: true };
});

describe('getGitExecEnv', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('macOS: Homebrew/시스템 경로를 PATH에 보강한다', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try {
      const { getGitExecEnv } = await import('../execEnv');
      const env = getGitExecEnv();
      expect(env.PATH).toContain('/opt/homebrew/bin');
      expect(env.PATH).toContain('/usr/local/bin');
      expect(env.PATH).toContain('/usr/bin'); // 기존 PATH 보존
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('macOS: 이미 PATH에 있는 경로는 중복 추가하지 않는다', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/opt/homebrew/bin:/usr/bin';
    try {
      const { getGitExecEnv } = await import('../execEnv');
      const env = getGitExecEnv();
      const occurrences = (env.PATH ?? '').split(':').filter((p) => p === '/opt/homebrew/bin').length;
      expect(occurrences).toBe(1);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe('getGitExecEnv on non-mac', () => {
  it('process.env를 그대로 반환한다(재계산 없음)', async () => {
    vi.doMock('../platform', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../platform')>();
      return { ...actual, isMac: false };
    });
    vi.resetModules();
    const { getGitExecEnv } = await import('../execEnv');
    expect(getGitExecEnv()).toBe(process.env);
  });
});
