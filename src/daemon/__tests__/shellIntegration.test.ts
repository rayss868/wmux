import { describe, it, expect } from 'vitest';
import { classifyShell, buildSpawnInjection, ZSH_RC } from '../shell-integration';

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

// OSC 133 B 마커는 반드시 zsh의 %{...%} 제로폭 가드로 감싸야 한다.
// 가드 없이 raw escape를 PROMPT에 붙이면 zle가 8바이트를 표시 폭으로
// 오계산 → resize 스윕 중 zrefresh/resetvideo가 SIGBUS로 크래시한다 (RCA 2026-07-05).
describe('ZSH_RC — PROMPT B 마커 폭 가드', () => {
  it('133;B 마커를 %{ ... %} 안에 감싼다', () => {
    // %{ 와 그 다음 %} 사이에 133;B 가 있어야 한다 (사이에 다른 % 프롬프트 이스케이프 없음).
    expect(ZSH_RC).toMatch(/%\{[^%]*133;B[^%]*%\}/);
  });

  it('가드를 씌워도 마커 자체는 여전히 방출된다', () => {
    // 회귀 방지: 폭 가드 때문에 마커가 통째로 사라지면 OSC 133 인덱싱이 깨진다.
    expect(ZSH_RC).toContain('133;B');
    // 가드 없는 옛 형태(PROMPT="${PROMPT}"$'...133;B)가 남아있지 않아야 한다.
    expect(ZSH_RC).not.toMatch(/"\$\{PROMPT\}"\$'\\033\]133;B/);
  });
});
