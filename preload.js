'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piApi', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  detectEnv: () => ipcRenderer.invoke('env:detect'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  runUpdate: (target) => ipcRenderer.invoke('update:run', target),
  serverStart: () => ipcRenderer.invoke('server:start'),
  serverStop: () => ipcRenderer.invoke('server:stop'),
  serverState: () => ipcRenderer.invoke('server:state'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  openPage: (url) => ipcRenderer.invoke('page:open', url),

  onUpdateLog: (cb) => ipcRenderer.on('update:log', (_e, line) => cb(line)),
  onServerLog: (cb) => ipcRenderer.on('server:log', (_e, line) => cb(line)),
  onServerExited: (cb) => ipcRenderer.on('server:exited', (_e, info) => cb(info)),
  onServerStarted: (cb) => ipcRenderer.on('server:started', (_e, info) => cb(info)),
  onPasteResult: (cb) => ipcRenderer.on('clipboard:pasted', (_e, info) => cb(info)),
});
