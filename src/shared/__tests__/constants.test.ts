import { afterEach, describe, expect, it } from 'vitest';
import {
  dataSuffix,
  getPipeName,
  getAuthTokenPath,
  getWmuxHomeDir,
  getPidMapDir,
  getTcpPortPath,
} from '../constants';

// WMUX_DATA_SUFFIX 기반 인스턴스 격리. dev 빌드와 packaged 빌드(또는 다른
// 체크아웃의 빌드)가 같은 소켓·토큰·~/.wmux를 두고 충돌하던 문제를 막는다.
describe('dataSuffix 인스턴스 격리', () => {
  const orig = process.env.WMUX_DATA_SUFFIX;
  afterEach(() => {
    if (orig === undefined) delete process.env.WMUX_DATA_SUFFIX;
    else process.env.WMUX_DATA_SUFFIX = orig;
  });

  it('suffix 미설정(packaged 기본) 시 기존 경로를 그대로 유지한다', () => {
    delete process.env.WMUX_DATA_SUFFIX;
    expect(dataSuffix()).toBe('');
    expect(getAuthTokenPath()).toMatch(/\.wmux-auth-token$/);
    expect(getWmuxHomeDir()).toMatch(/\.wmux$/);
    expect(getPidMapDir()).toMatch(/\.wmux[\\/]pid-map$/);
    if (process.platform !== 'win32') {
      expect(getPipeName()).toMatch(/\.wmux\.sock$/);
    }
  });

  it('suffix 설정 시 모든 경로(소켓/토큰/홈/pid-map/tcp)에 격리가 반영된다', () => {
    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(dataSuffix()).toBe('-dev');
    expect(getAuthTokenPath()).toMatch(/\.wmux-dev-auth-token$/);
    expect(getWmuxHomeDir()).toMatch(/\.wmux-dev$/);
    expect(getPidMapDir()).toMatch(/\.wmux-dev[\\/]pid-map$/);
    expect(getTcpPortPath()).toMatch(/\.wmux-dev-tcp-port$/);
    if (process.platform === 'win32') {
      expect(getPipeName()).toContain('wmux-dev-');
    } else {
      expect(getPipeName()).toMatch(/\.wmux-dev\.sock$/);
    }
  });

  it('핵심 불변식: packaged 경로와 dev 경로는 절대 겹치지 않는다', () => {
    delete process.env.WMUX_DATA_SUFFIX;
    const packagedPipe = getPipeName();
    const packagedHome = getWmuxHomeDir();
    const packagedToken = getAuthTokenPath();

    process.env.WMUX_DATA_SUFFIX = '-dev';
    expect(getPipeName()).not.toBe(packagedPipe);
    expect(getWmuxHomeDir()).not.toBe(packagedHome);
    expect(getAuthTokenPath()).not.toBe(packagedToken);
  });
});
