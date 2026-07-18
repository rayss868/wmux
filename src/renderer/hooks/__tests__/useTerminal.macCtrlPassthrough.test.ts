import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 소스 레벨 회귀 락 (owner-reported 2026-07-19):
 *
 * macOS에서 앱 단축키는 cmdOrCtrl=metaKey(useKeyboard)라, xterm 핸들러가
 * Ctrl+D/K/I/N/T/,/` 를 삼켜 DOM으로 버블시키면 앱 액션도 안 걸리고 PTY에도
 * 못 가서 readline 컨트롤 문자(Ctrl+D EOF, Ctrl+I Tab, Ctrl+K kill-line …)가
 * 통째로 죽는다. mac에서는 literal-Ctrl 바인딩(b=프리픽스, m=북마크,
 * Ctrl+Arrow)만 버블시키고 나머지는 PTY로 통과해야 한다.
 *
 * 또한 mac은 복사가 Cmd+C 전담이므로 Ctrl+C는 선택영역이 있어도 항상
 * SIGINT여야 한다(복사 가로채기는 비-mac 한정).
 *
 * imeCopyPaste 락과 동일하게, jsdom이 xterm 커스텀 키 핸들러 + IME를 충실히
 * 못 돌리므로 소스 레벨로 고정한다.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/hooks/useTerminal.ts'),
  'utf8',
);

const handlerStart = SRC.indexOf('attachCustomKeyEventHandler');
const HANDLER = SRC.slice(handlerStart);

describe('useTerminal macOS Ctrl passthrough (source-level lock)', () => {
  it('locates the custom key event handler', () => {
    expect(handlerStart).toBeGreaterThan(-1);
  });

  it('mac 버블 목록은 literal-Ctrl 바인딩(b, m, Arrow)만 담는다', () => {
    expect(HANDLER).toMatch(
      /isMacKeys\s*\?\s*\['b', 'm', 'ArrowUp', 'ArrowDown'\]/,
    );
    expect(HANDLER).toMatch(
      /isMacKeys\s*\?\s*\['KeyB', 'KeyM', 'ArrowUp', 'ArrowDown'\]/,
    );
  });

  it('비-mac 버블 목록은 기존 전체 집합을 유지한다 (win/linux 무회귀)', () => {
    expect(HANDLER).toMatch(
      /\[',', 'b', 'd', 'k', 'i', 'n', 't', 'm', 'ArrowUp', 'ArrowDown', '`'\]/,
    );
  });

  it('Ctrl+`와 Ctrl+=/-/0 줌 버블은 비-mac 한정이다', () => {
    expect(HANDLER).toMatch(/!isMacKeys && e\.ctrlKey && !e\.shiftKey && e\.code === 'Backquote'/);
    expect(HANDLER).toMatch(/!isMacKeys && e\.ctrlKey && !e\.shiftKey && \(\s*\n?\s*e\.key === '='/);
  });

  it('Ctrl+C 복사 가로채기는 비-mac 한정 — mac은 항상 SIGINT', () => {
    expect(HANDLER).toMatch(
      /!isMac && e\.ctrlKey && !e\.shiftKey && \(e\.key === 'c' \|\| e\.code === 'KeyC'\)/,
    );
  });

  it('Ctrl+V 붙여넣기 가로채기는 비-mac 한정 — mac은 quoted-insert로 PTY 통과', () => {
    expect(HANDLER).toMatch(
      /!isMac && e\.ctrlKey && !e\.shiftKey && \(e\.key === 'v' \|\| e\.code === 'KeyV'\)/,
    );
  });
});
