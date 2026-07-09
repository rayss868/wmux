// V3 — Electron 렌더러(hidden BrowserWindow, show:false)에서 web 타깃 wasm 로드
// → feed 왕복 → IPC로 결과 회수 → exit code 판정.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

let timeoutHandle;

function finish(code, msg) {
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (msg) console.log(msg);
  app.exit(code);
}

app.whenReady().then(() => {
  console.log('[V3] Electron 렌더러 + web 타깃 wasm');
  console.log(`  electron ${process.versions.electron} / chrome ${process.versions.chrome}`);

  // 렌더러가 결과를 IPC로 되돌려준다.
  ipcMain.on('v3-result', (_evt, payload) => {
    if (payload.ok) {
      let fail = 0;
      const check = (name, cond, got) => {
        if (cond) console.log(`  PASS ${name}`);
        else { console.error(`  FAIL ${name} — ${JSON.stringify(got)}`); fail++; }
      };
      check('wasm cols=80', payload.cols === 80, payload.cols);
      check('wasm rows=24', payload.rows === 24, payload.rows);
      check('feed dirtyRows=1', payload.dirtyRows === 1, payload.dirtyRows);
      check('feed writebackLen=0', payload.writebackLen === 0, payload.writebackLen);
      check('snapshot_row(0) 선두 일치', typeof payload.row0 === 'string' && payload.row0.startsWith('renderer wasm OK'), payload.row0);
      check('CRLF 후 row1', typeof payload.row1 === 'string' && payload.row1.startsWith('second'), payload.row1);
      finish(fail === 0 ? 0 : 1, fail === 0 ? '[V3] OK — 렌더러 wasm 로드·왕복·IPC 회수 성공' : `[V3] FAIL — ${fail}건`);
    } else {
      console.error('[V3] 렌더러 오류:', payload.error);
      finish(1, '[V3] FAIL — 렌더러 예외');
    }
  });

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // 렌더러에서 로컬 wasm fetch 허용 — 스파이크 한정(file:// 로드).
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // 안전장치: 렌더러가 15초 내 응답 없으면 실패.
  timeoutHandle = setTimeout(() => finish(1, '[V3] FAIL — 렌더러 타임아웃(15s)'), 15000);
}).catch((e) => {
  console.error('[V3] main 예외:', e);
  finish(1);
});
