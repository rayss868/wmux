// macOS GUI 런치(Dock/Finder/Spotlight)로 뜬 프로세스는 launchd의 최소 PATH
// (/usr/bin:/bin:/usr/sbin:/sbin)만 물려받고, ~/.zshrc·~/.zprofile이 깔아주는
// Homebrew PATH(/opt/homebrew/bin 등)를 상속받지 못한다 — 잘 알려진 macOS 고유
// 문제. Windows는 git 설치 시 PATH가 레지스트리(시스템/사용자 환경변수)에
// 등록돼 모든 프로세스에 전역 상속되므로 이 문제가 없다.
//
// execFile('git', …)가 이 PATH만 보고 실행되면 Homebrew로 설치한 git을 못 찾아
// ENOENT로 조용히 실패한다(호출부들이 "quiet absence"를 계약으로 삼고 있어
// 사용자에게는 그냥 기능이 안 뜨는 것으로만 보인다 — owner-reported 2026-07-19,
// 워크스페이스 사이드바의 브랜치 동기화 배지가 macOS에서 안 뜨던 원인).

import { isMac } from './platform';

/** 표준 Homebrew(Apple Silicon/Intel) + 시스템 git 설치 경로. */
const MAC_PATH_FALLBACKS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

let cachedEnv: NodeJS.ProcessEnv | null = null;

/**
 * `process.env`를 그대로 execFile에 넘기면 안전하지 않은 macOS 전용 상황을
 * 보정한 env를 반환한다 — mac에서만 PATH에 Homebrew/시스템 경로를 덧붙이고,
 * 그 외 플랫폼에서는 `process.env`를 그대로 반환(재계산 없음).
 */
export function getGitExecEnv(): NodeJS.ProcessEnv {
  if (!isMac) return process.env;
  if (cachedEnv) return cachedEnv;

  const existing = (process.env.PATH || '').split(':').filter(Boolean);
  const merged = [...new Set([...existing, ...MAC_PATH_FALLBACKS])];
  cachedEnv = { ...process.env, PATH: merged.join(':') };
  return cachedEnv;
}
