import { describe, it, expect } from 'vitest';
import { classifyShell, buildSpawnInjection } from '../shell-integration';

// zsh 지원(macOS 기본 셸) — ZDOTDIR 가로채기 방식의 핵심 불변식 검증.
describe('classifyShell', () => {
  it('zsh를 분류한다 (경로/이름/로그인 셸 형태)', () => {
    expect(classifyShell('/bin/zsh')).toBe('zsh');
    expect(classifyShell('zsh')).toBe('zsh');
    expect(classifyShell('-zsh')).toBe('zsh'); // 로그인 셸은 argv[0]에 '-' 접두
  });

  it('기존 셸 분류는 그대로 유지한다', () => {
    expect(classifyShell('/bin/bash')).toBe('bash');
    expect(classifyShell('pwsh')).toBe('pwsh');
    expect(classifyShell('powershell.exe')).toBe('pwsh');
    expect(classifyShell('/usr/bin/fish')).toBeNull();
    expect(classifyShell('')).toBeNull();
  });
});

describe('buildSpawnInjection — zsh', () => {
  it('zsh는 ZDOTDIR을 wmux zsh 디렉토리로 설정한다', () => {
    const inj = buildSpawnInjection('/bin/zsh');
    expect(inj).not.toBeNull();
    // ZDOTDIR 가로채기: wmux 디렉토리를 가리켜야 OSC 133 stub이 로드된다.
    expect(inj?.env.ZDOTDIR).toMatch(/shell-integration[\\/]zsh$/);
    expect(inj?.env.WMUX_SHELL_INTEGRATION).toBe('1');
    expect(inj?.args).toContain('-i');
  });

  it('알 수 없는 셸은 injection이 없다(일반 spawn)', () => {
    expect(buildSpawnInjection('/usr/bin/fish')).toBeNull();
    expect(buildSpawnInjection('cmd.exe')).toBeNull();
  });
});
