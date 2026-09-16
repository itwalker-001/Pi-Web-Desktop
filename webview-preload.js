'use strict';

// webview 的 preload:拦截拖入 guest 页面的文件,把本地路径发回主进程
// (粘贴的拦截在主进程 before-input-event 中做,见 lib/webview-files.js,
//  这里不能再拦 paste —— contents.paste() 会再次触发本页 paste 事件,造成死循环)
const { ipcRenderer, webUtils } = require('electron');

function pathOf(file) {
  try {
    return webUtils.getPathForFile(file);
  } catch {
    return null;
  }
}

for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (e) => e.preventDefault());
}

document.addEventListener(
  'drop',
  (e) => {
    e.preventDefault();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
      .map(pathOf)
      .filter(Boolean);
    if (files.length) ipcRenderer.send('webview:dropped-files', files);
  },
  true
);
