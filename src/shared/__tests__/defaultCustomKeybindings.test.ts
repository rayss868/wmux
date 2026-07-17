import { describe, it, expect } from 'vitest';
import {
  buildDefaultCustomKeybindings,
  DEFAULT_CUSTOM_KEYBINDINGS,
  upgradeDefaultKeybindingsForPlatform,
  type CustomKeybinding,
} from '../types';

/** 원본(F7) shipped 기본값 한 벌. */
const pristineF7 = (): CustomKeybinding => ({ ...buildDefaultCustomKeybindings(undefined)[0] });

describe('buildDefaultCustomKeybindings', () => {
  it('seeds Ctrl+7 on macOS (bare F7 = media keys, Ctrl+F7 = OS ^F7 shortcut)', () => {
    const kbs = buildDefaultCustomKeybindings('darwin');
    expect(kbs).toHaveLength(1);
    expect(kbs[0].id).toBe('kb-default-f7');
    expect(kbs[0].key).toBe('Ctrl+7');
    expect(kbs[0].command).toBe('claude --dangerously-skip-permissions');
  });

  it('keeps bare F7 on Windows/Linux', () => {
    for (const platform of ['win32', 'linux', undefined]) {
      const kbs = buildDefaultCustomKeybindings(platform);
      expect(kbs[0].key).toBe('F7');
      // id는 플랫폼과 무관하게 동일해야 백필 매칭이 유지된다.
      expect(kbs[0].id).toBe('kb-default-f7');
    }
  });

  it('exposes a platform-agnostic F7 fallback constant', () => {
    expect(DEFAULT_CUSTOM_KEYBINDINGS[0].key).toBe('F7');
  });
});

describe('upgradeDefaultKeybindingsForPlatform', () => {
  it('upgrades an untouched shipped F7 default to Ctrl+7 on macOS', () => {
    const out = upgradeDefaultKeybindingsForPlatform([pristineF7()], 'darwin');
    expect(out[0].key).toBe('Ctrl+7');
    // 나머지 필드는 보존.
    expect(out[0].id).toBe('kb-default-f7');
    expect(out[0].command).toBe('claude --dangerously-skip-permissions');
  });

  it('upgrades the v3.26 Ctrl+F7 default to Ctrl+7 on macOS (OS ^F7 conflict)', () => {
    const v326: CustomKeybinding = { ...pristineF7(), key: 'Ctrl+F7' };
    const out = upgradeDefaultKeybindingsForPlatform([v326], 'darwin');
    expect(out[0].key).toBe('Ctrl+7');
  });

  it('leaves a user-modified F7 binding alone (different command)', () => {
    const edited: CustomKeybinding = { ...pristineF7(), command: 'vim' };
    const out = upgradeDefaultKeybindingsForPlatform([edited], 'darwin');
    expect(out[0].key).toBe('F7'); // 승격 안 함 — 사용자가 의도적으로 F7 재지정
  });

  it('leaves a user-chosen non-legacy key alone on macOS', () => {
    const custom: CustomKeybinding = { ...pristineF7(), key: 'Ctrl+Shift+1' };
    const out = upgradeDefaultKeybindingsForPlatform([custom], 'darwin');
    expect(out[0].key).toBe('Ctrl+Shift+1');
  });

  it('is a no-op for the shipped F7 on Windows/Linux', () => {
    for (const platform of ['win32', 'linux', undefined]) {
      const out = upgradeDefaultKeybindingsForPlatform([pristineF7()], platform);
      expect(out[0].key).toBe('F7');
    }
  });

  it('normalizes a stray untouched Ctrl+F7 back to F7 on Windows/Linux', () => {
    const stray: CustomKeybinding = { ...pristineF7(), key: 'Ctrl+F7' };
    const out = upgradeDefaultKeybindingsForPlatform([stray], 'win32');
    expect(out[0].key).toBe('F7');
  });

  it('is idempotent — an already-upgraded Ctrl+7 stays put on macOS', () => {
    const upgraded: CustomKeybinding = { ...pristineF7(), key: 'Ctrl+7' };
    const out = upgradeDefaultKeybindingsForPlatform([upgraded], 'darwin');
    expect(out[0].key).toBe('Ctrl+7');
  });
});
