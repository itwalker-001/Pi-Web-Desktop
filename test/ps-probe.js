// 临时探针:验证 readClipboardFilePaths(当前剪贴板应含 README.md)
const { app } = require('electron');
const fs = require('fs');
const { readClipboardFilePaths } = require('../lib/webview-files');

app.whenReady().then(async () => {
  let out;
  try {
    out = JSON.stringify(await readClipboardFilePaths());
  } catch (e) {
    out = 'THREW ' + String((e && e.message) || e);
  }
  fs.writeFileSync(__dirname + '/ps-probe.out.txt', out);
  app.exit(0);
});
