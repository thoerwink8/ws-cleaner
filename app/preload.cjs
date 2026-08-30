// 渲染进程与主进程的最小桥。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wsCleaner', {
  version: () => ipcRenderer.invoke('app:version'),
  settings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  settingsFile: () => ipcRenderer.invoke('settings:file'),
  scanStart: () => ipcRenderer.invoke('scan:start'),
  size: (path) => ipcRenderer.invoke('size:get', path),
  preview: (path, agent) => ipcRenderer.invoke('preview:session', { path, agent }),
  deleteItems: (items) => ipcRenderer.invoke('delete:items', { items }),
  reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
  openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
  onBatch: (cb) => ipcRenderer.on('scan:batch', (_e, p) => cb(p)),
  onDone: (cb) => ipcRenderer.on('scan:done', (_e, p) => cb(p)),
  onError: (cb) => ipcRenderer.on('scan:error', (_e, p) => cb(p)),
  onCache: (cb) => ipcRenderer.on('scan:cache', (_e, p) => cb(p)),
  minimize: () => ipcRenderer.send('win:min'),
  maximize: () => ipcRenderer.send('win:max'),
  quit: () => ipcRenderer.send('app:quit'),
});
