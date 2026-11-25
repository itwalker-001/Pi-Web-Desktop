'use strict';

// 真实启动临时 CLI:验证带空格/命令行特殊字符的路径、非零退出和异步启动失败。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const editor = require('../lib/local-editor');
const win = process.platform === 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi editor '));
const binDir = path.join(tmp, 'Microsoft VS Code', 'bin');
const bin = path.join(binDir, win ? 'code.cmd' : 'code');
const helper = path.join(tmp, 'record.js');
const result = path.join(tmp, 'result.json');
const savedEnv = { ...process.env };

(async () => {
  try {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(helper, "require('fs').writeFileSync(process.env.PI_LOCAL_EDITOR_RESULT, JSON.stringify(process.argv.slice(2)));");
    process.env.PATH = binDir + path.delimiter + process.env.PATH;
    process.env.PI_LOCAL_EDITOR_NODE = process.execPath;
    process.env.PI_LOCAL_EDITOR_HELPER = helper;
    process.env.PI_LOCAL_EDITOR_RESULT = result;
    fs.writeFileSync(bin, win
      ? '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%PI_LOCAL_EDITOR_NODE%" "%PI_LOCAL_EDITOR_HELPER%" "%~1"\r\n'
      : '#!/bin/sh\nexec "$PI_LOCAL_EDITOR_NODE" "$PI_LOCAL_EDITOR_HELPER" "$@"\n', { mode: 0o755 });
    const dir = path.join(tmp, 'project with spaces & literal %PATH% !');
    fs.mkdirSync(dir);
    let r = await editor.open(dir);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), [dir]);
    console.log('PASS: 真实 CLI 完整收到含空格、&、%、! 的项目路径');

    fs.writeFileSync(bin, win ? '@exit /b 7\r\n' : '#!/bin/sh\nexit 7\n');
    r = await editor.open(dir);
    assert.equal(r.ok, false);
    assert.match(r.error, /7/);
    console.log('PASS: CLI 非零退出返回失败');

    if (win) process.env.comspec = path.join(tmp, 'missing-cmd.exe');
    else fs.chmodSync(bin, 0o644);
    r = await editor.open(dir);
    assert.equal(r.ok, false);
    assert.ok(r.error);
    console.log('PASS: 异步 spawn 错误被捕获');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
