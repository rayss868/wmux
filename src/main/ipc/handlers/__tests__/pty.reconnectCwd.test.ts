import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 소스 레벨 회귀 락 (owner-reported 2026-07-19):
 *
 * 앱 재시작 후 데몬의 영속 세션에 재접속(PTY_RECONNECT)하면 워크스페이스
 * 사이드바에 이름만 뜨고 브랜치/포트/PR이 안 뜬다. 원인: 메타데이터 폴은
 * cwdMap에 있는 pane만 처리하고 buildMetadataPayload도 cwd 없으면 즉시 null이라
 * cwd가 없으면 컨텍스트 라인 전체가 사라진다. create 경로는 cwd를 seed하지만
 * reconnect는 데몬이 listSessions 응답에 실어준 cwd를 버렸다. 프롬프트
 * 스크레이프 사후 복구는 PowerShell/bash 프롬프트만 잡고 macOS 기본 zsh는 못
 * 잡으므로("win에선 되는데 mac만 안 됨") 반드시 reconnect에서 seed해야 한다.
 *
 * 재접속 핸들러는 daemonClient RPC에 깊게 결합돼 단위 격리가 어렵다(전체 목킹은
 * 취약). imeCopyPaste / macCtrlPassthrough 락과 동일하게 소스 레벨로 고정한다.
 */

const SRC = readFileSync(
  path.resolve(process.cwd(), 'src/main/ipc/handlers/pty.handler.ts'),
  'utf8',
);

// PTY_RECONNECT 핸들러 본문만 잘라낸다(create 경로의 updateCwd와 섞이지 않게).
const reconnectStart = SRC.indexOf('IPC.PTY_RECONNECT, wrapHandler');
const RECONNECT = reconnectStart > -1 ? SRC.slice(reconnectStart) : '';

describe('PTY_RECONNECT seeds cwd (source-level lock)', () => {
  it('locates the reconnect handler', () => {
    expect(reconnectStart).toBeGreaterThan(-1);
  });

  it('listSessions 응답 타입이 cwd를 포함한다', () => {
    expect(RECONNECT).toMatch(/id: string; cmd: string; state: string; pid\?: number; cwd\?: string/);
  });

  it('재접속 시 세션 cwd로 updateCwd를 호출한다', () => {
    expect(RECONNECT).toMatch(/if \(session\.cwd\) updateCwd\(id, session\.cwd\)/);
  });
});
