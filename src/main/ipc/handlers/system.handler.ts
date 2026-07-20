// ─── system.handler — macOS 시스템 유틸(내장 화면 끄기) ─────────────────────────
//
// SYSTEM_BUILTIN_DISPLAY('off'|'on'): 맥북 내장 디스플레이의 백라이트만 조절한다.
// macOS엔 "내장 화면만 끄기" 공개 API가 없어(전체 sleep인 pmset은 외장까지 꺼짐),
// 밝기 키 이벤트(key code 145=어둡게 / 144=밝게)를 System Events로 반복 전송하는
// 방식을 쓴다 — 밝기 키는 내장 디스플레이에만 적용되므로 외장 모니터는 그대로 켜져
// 있다. off는 최저(백라이트 완전 소등)까지 20회, on은 중간 밝기 복원으로 10회.
//
// clipboard.handler와 동일 원칙: 셸 인터폴레이션이 없도록 execFile + 고정 스크립트
// (사용자 입력 없음). System Events 제어라 손쉬운 사용(Accessibility) 권한이 필요
// 하며, 미허용 시 osascript가 -1719/assistive access 에러를 내므로 ok:false와 함께
// 권한 안내 코드를 돌려준다(렌더러 토스트용).

import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';

const OSASCRIPT_PATH = '/usr/bin/osascript';
const OSASCRIPT_TIMEOUT_MS = 8000;

function brightnessScript(mode: 'off' | 'on'): string {
  const keyCode = mode === 'off' ? 145 : 144;
  const times = mode === 'off' ? 20 : 10;
  return [
    'tell application "System Events"',
    `repeat ${times} times`,
    `key code ${keyCode}`,
    'end repeat',
    'end tell',
  ].join('\n');
}

export function registerSystemHandlers(): () => void {
  const handler = wrapHandler(
    IPC.SYSTEM_BUILTIN_DISPLAY,
    async (_event, mode: 'off' | 'on'): Promise<{ ok: boolean; code?: string; error?: string }> => {
      if (process.platform !== 'darwin') {
        return { ok: false, code: 'unsupported', error: 'macOS only' };
      }
      if (mode !== 'off' && mode !== 'on') {
        return { ok: false, code: 'bad-mode', error: `unknown mode: ${String(mode)}` };
      }
      return new Promise((resolve) => {
        execFile(
          OSASCRIPT_PATH,
          ['-e', brightnessScript(mode)],
          { timeout: OSASCRIPT_TIMEOUT_MS },
          (err, _stdout, stderr) => {
            if (!err) return resolve({ ok: true });
            const msg = `${err.message} ${stderr || ''}`;
            // 손쉬운 사용 미허용: "not allowed assistive access" / (-1719)
            const denied = /assistive access|not authorized|1002|-1719/i.test(msg);
            resolve({ ok: false, code: denied ? 'accessibility' : 'exec', error: msg.trim() });
          },
        );
      });
    },
  );
  ipcMain.handle(IPC.SYSTEM_BUILTIN_DISPLAY, handler);
  return () => {
    ipcMain.removeHandler(IPC.SYSTEM_BUILTIN_DISPLAY);
  };
}
