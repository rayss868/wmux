// cwd 그럴듯함 검사 — 프롬프트 스크래핑 오탐 방어(공용).
//
// 배경(2026-07-20): 터미널에 표시된 텍스트 속 "PS C:\…>" 같은 문자열을
// 프롬프트 스크래퍼가 진짜 프롬프트로 오인해 macOS 페인의 cwd를 Windows
// 경로로 덮어쓰는 사고. 플랫폼에서 존재할 수 없는 모양의 경로를 거른다.
// 존재 여부(fs)까지는 확인하지 않는다 — 이 모듈은 renderer에서도 쓰인다.

/** 현재 플랫폼에서 실존 가능한 cwd 모양인가. platform 기본값은 실행 환경. */
export function isPlausibleCwd(
  cwd: string,
  platform: NodeJS.Platform | string = typeof process !== 'undefined' ? process.platform : 'linux',
): boolean {
  if (!cwd) return false;
  const isWinShape = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\');
  if (platform === 'win32') return true; // win32는 WSL POSIX 경로도 합법 — 통과
  return !isWinShape;
}
