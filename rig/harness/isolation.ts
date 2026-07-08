// 검증 리그 — 런 격리 컨텍스트 (설계 §2 / G2)
//
// 시나리오당 fresh 임시 홈 + `WMUX_DATA_SUFFIX='-rig-{runId}'`. runId는 전 OS 필수
// (win32 named pipe는 파일시스템 밖 전역 네임스페이스라 suffix의 runId만이 병렬 런
// 격리 수단 — §2, Codex M4). 홈 오버라이드는 4종 전부: HOME(posix) +
// USERPROFILE·APPDATA·LOCALAPPDATA(win32) — 경로 헬퍼가 `USERPROFILE || HOME`
// (`src/shared/constants.ts:287,:342`)이고 기존 도그푸드도 같은 관례(Codex M3).
//
// suffix 문자열은 데몬 스폰 env와 PipeClient가 반드시 단일 상수를 공유한다
// (v1 리뷰에서 `-rig` vs `-rig-{id}` 발산이 인증 미스매치를 만들었다 — Claude 축①).
// 그래서 파이프 주소·토큰 경로 파생을 이 모듈에서 한 곳으로 계산해 RigContext에 실어둔다.
//
// 실증(오케스트레이터 스파이크 1d): macOS에서 `os.homedir()`는 HOME 오버라이드를
// 추종하므로(getpwuid 실패 시 $HOME) 데몬의 `getWmuxDir()`(`src/daemon/config.ts:11`,
// os.homedir 기반)·소켓 위치·토큰 위치가 전부 임시 홈 안으로 격리된다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** runId 카운터 — 한 프로세스 안에서 여러 컨텍스트를 만들 때 pid만으로는 충돌하므로 증가시킨다. */
let runIdCounter = 0;

export interface RigContext {
  /** 이 런의 고유 식별자 (pid + counter). 실패 로그·아티팩트 상관에 쓴다. */
  readonly runId: string;
  /** `-rig-{runId}` — 데몬 스폰 env와 PipeClient가 공유하는 단일 suffix 상수. */
  readonly suffix: string;
  /** mkdtemp로 만든 임시 홈 절대경로. teardown에서 통째로 삭제된다. */
  readonly home: string;
  /** 데몬 스폰에 넘길 격리 env (4종 홈 + WMUX_DATA_SUFFIX). */
  readonly env: NodeJS.ProcessEnv;
  /** 데몬 제어 파이프 주소 (unix: 소켓 경로 / win32: named pipe). */
  readonly daemonPipePath: string;
  /** 데몬 auth token 파일 경로 (`{홈}/.wmux{suffix}/daemon-auth-token`). */
  readonly daemonTokenPath: string;
}

/**
 * 새 격리 런 컨텍스트를 만든다. 임시 홈을 mkdtemp로 물리 생성하고, 데몬이 상속할
 * env와 파생 경로(파이프·토큰)를 계산해 실어 반환한다. 프로세스 스폰이나 소켓 연결은
 * 하지 않는다 — 순수 컨텍스트 팩토리(RigDaemon/PipeClient가 소비).
 */
export function createRigContext(): RigContext {
  const runId = `${process.pid}-${runIdCounter++}`;
  const suffix = `-rig-${runId}`;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-rig-'));

  // win32 경로 헬퍼가 참조하는 AppData 하위도 미리 만든다(존재 안 하면 데몬이
  // 재귀 생성하긴 하지만, 도그푸드 관례를 따라 명시). posix에선 무해.
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    WMUX_DATA_SUFFIX: suffix,
  };
  // win32에서 USERPROFILE보다 우선하는 HOMEDRIVE/HOMEPATH가 상속되면 격리를 깬다
  // (도그푸드 a2a-symmetric-reply-dogfood.mjs:58과 동일한 방어).
  delete env.HOMEDRIVE;
  delete env.HOMEPATH;

  const username = os.userInfo().username || 'default';
  const daemonPipePath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\wmux-daemon${suffix}-${username}`
      : path.join(home, `.wmux-daemon${suffix}.sock`);

  // 데몬 토큰은 파일명이 아니라 디렉토리가 suffix-aware
  // (`getDaemonAuthTokenPath` → `getWmuxHomeDir()`/`.wmux{suffix}/daemon-auth-token`
  //  — `src/shared/constants.ts:342` 부근).
  const daemonTokenPath = path.join(home, `.wmux${suffix}`, 'daemon-auth-token');

  return { runId, suffix, home, env, daemonPipePath, daemonTokenPath };
}

/**
 * 컨텍스트의 임시 홈을 삭제한다. 프로세스 트리 kill은 RigDaemon.teardown이 책임지므로
 * (데몬 핸들을 소유한 쪽) 이 함수는 홈 삭제만 한다 — 순서: 데몬 kill → removeRigHome.
 * force+recursive라 이미 지워졌거나 부재해도 throw하지 않는다.
 */
export function removeRigHome(ctx: RigContext): void {
  try {
    fs.rmSync(ctx.home, { recursive: true, force: true });
  } catch {
    // best-effort: 임시 홈이라 다음 OS temp 청소가 결국 걷어간다.
  }
}
