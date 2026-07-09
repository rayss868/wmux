// V3 preload — 렌더러가 결과를 main으로 보낼 IPC 채널만 노출(contextIsolation).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('v3bridge', {
  report: (payload) => ipcRenderer.send('v3-result', payload),
});
