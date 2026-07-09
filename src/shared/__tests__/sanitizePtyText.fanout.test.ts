// ─── J1 §4 C9 게이트: sanitizePtyText가 initialCommand의 셸 구문을 보존하는가 ──
//
// 이 테스트가 J1 D4(파일 경유 프롬프트 + `{agentCmd} "$(cat {promptPath})"` 한 줄)
// 설계 전체의 판정식이다(스펙 §4·§8 "구현 첫 단계 필수"). pty.handler.ts:490
// 경유 initialCommand는 sanitizePtyText를 통과한다 — `$()` 명령 치환·큰따옴표·
// 역슬래시가 변형·절단되면 프롬프트가 셸에 도달하지 못하고 D4가 무너진다.
//
// sanitizePtyText 계약: NULL(\x00)·C1 제어문자(U+0080~U+009F)만 제거, 그 외 전부
// 보존(shared/types.ts). 아래는 D4 명령줄이 실제로 겪는 문자만 콕 찍어 확정한다.

import { describe, it, expect } from 'vitest';
import { sanitizePtyText } from '../types';

describe('sanitizePtyText — J1 §4 initialCommand 셸 구문 보존', () => {
  it('`$(cat path)` 명령 치환을 변형 없이 보존한다', () => {
    const cmd = 'claude "$(cat /Users/x/.wmux/worktrees/abc/.meta/slug/prompt.md)"';
    expect(sanitizePtyText(cmd)).toBe(cmd);
  });

  it('큰따옴표·역슬래시·달러 기호를 보존한다', () => {
    const cmd = 'claude "$(cat \\"/tmp/p p/prompt.md\\")" # $HOME';
    expect(sanitizePtyText(cmd)).toBe(cmd);
  });

  it('PowerShell 동형(Get-Content -Raw) 명령줄을 보존한다', () => {
    const cmd = 'claude "$(Get-Content -Raw C:\\Users\\x\\.wmux\\prompt.md)"';
    expect(sanitizePtyText(cmd)).toBe(cmd);
  });

  it('개별 셸 메타문자를 모두 보존한다', () => {
    const metas = '$ ( ) " \\ \' ` | & ; < > * ? [ ] { } ~ #';
    expect(sanitizePtyText(metas)).toBe(metas);
  });

  it('경로 안의 공백·유니코드·한글을 보존한다', () => {
    const cmd = 'claude "$(cat /경로 with space/프롬프트.md)"';
    expect(sanitizePtyText(cmd)).toBe(cmd);
  });

  it('NULL·C1 제어문자만 제거하고 나머지는 그대로 둔다(계약 확인)', () => {
    const cmd = 'claude "$(cat p.md)"';
    // \x00(NULL)·\x85(C1 NEL)를 섞어도 명령 본문은 온전해야 한다.
    expect(sanitizePtyText(`\x00${cmd}\x85`)).toBe(cmd);
  });
});
