'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('piApi', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  detectEnv: (target) => ipcRenderer.invoke('env:detect', target),
  checkUpdate: (target) => ipcRenderer.invoke('update:check', target),
  runUpdate: (target) => ipcRenderer.invoke('update:run', target),
  serverStart: () => ipcRenderer.invoke('server:start'),
  serverStop: (opts) => ipcRenderer.invoke('server:stop', opts),
  confirmForceStop: () => ipcRenderer.invoke('stop:confirmForce'),
  serverState: () => ipcRenderer.invoke('server:state'),
  remoteTest: () => ipcRenderer.invoke('remote:test'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  openInEditor: (dir) => ipcRenderer.invoke('editor:open', dir),
  confirmInstallCodeServer: (arg) => ipcRenderer.invoke('code-server:confirmInstall', arg),
  installCodeServer: () => ipcRenderer.invoke('code-server:install'),
  csState: (target) => ipcRenderer.invoke('code-server:state', target),
  csSave: (arg) => ipcRenderer.invoke('code-server:save', arg),
  csStart: (target) => ipcRenderer.invoke('code-server:start', target),
  csStop: (arg) => ipcRenderer.invoke('code-server:stop', arg),
  csConfirmForceStop: (arg) => ipcRenderer.invoke('code-server:confirmForceStop', arg),
  csOpen: (target) => ipcRenderer.invoke('code-server:open', target),
  copyText: (text) => ipcRenderer.invoke('shell:copy', text),
  setClipboardText: (text) => ipcRenderer.invoke('clipboard:write', text),
  termStart: (arg) => ipcRenderer.invoke('term:start', arg),
  termWrite: (arg) => ipcRenderer.invoke('term:write', arg),
  termResize: (arg) => ipcRenderer.invoke('term:resize', arg),
  termStop: (arg) => ipcRenderer.invoke('term:stop', arg),
  termPaste: (arg) => ipcRenderer.invoke('term:paste', arg),
  // code-server 窗口落到登录页时触发:把服务器上的登录密码交给用户
  onCodeServerPassword: (cb) => ipcRenderer.on('code-server:password', (_e, info) => cb(info)),

  onUpdateLog: (cb) => ipcRenderer.on('update:log', (_e, line) => cb(line)),
  onServerLog: (cb) => ipcRenderer.on('server:log', (_e, line) => cb(line)),
  onServerExited: (cb) => ipcRenderer.on('server:exited', (_e, info) => cb(info)),
  onServerStarted: (cb) => ipcRenderer.on('server:started', (_e, info) => cb(info)),
  onPasteResult: (cb) => ipcRenderer.on('clipboard:pasted', (_e, info) => cb(info)),
  // SSH 终端:会话输出(字节流)与结束事件
  onTermData: (cb) => ipcRenderer.on('term:data', (_e, info) => cb(info)),
  onTermExit: (cb) => ipcRenderer.on('term:exit', (_e, info) => cb(info)),
});
