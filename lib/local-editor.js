'use strict';

// 本机目标用什么打开当前项目:优先桌面版 VS Code(code 命令或在常见安装位置)。
// code-server 的安装包只支持 Linux(官方独立发行包)/ 其 npm 包的 postinstall 是 sh 脚本,
// 纯 Windows 上装不上 —— 所以本机不提供安装,装了 VS Code 就直接用。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// code 命令的文件名:Windows 上安装器放的是 code.cmd(也认 code.exe),别处就叫 code
const EXE_NAMES = IS_WIN ? ['code.cmd', 'code.exe'] : ['code', 'code-oss'];

function candidates() {
  const list = [];
  // PATH 里能找到就算装了(安装器勾选「添加到 PATH」就是这种)
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of EXE_NAMES) list.push(path.join(dir, name));
  }
  // 没加进 PATH 的:常见安装位置兜底
  if (IS_WIN) {
    const bins = [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'bin'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'bin'),
    ].filter(Boolean);
    for (const dir of bins) for (const name of EXE_NAMES) list.push(path.join(dir, name));
  } else if (process.platform === 'darwin') {
    list.push('/usr/local/bin/code', '/opt/homebrew/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
  } else {
    list.push('/usr/bin/code', '/usr/local/bin/code', '/usr/bin/code-oss', '/snap/bin/code');
  }
  return list;
}

function find() {
  return candidates().find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) || '';
}

// 在桌面版 VS Code 里打开目录(已开着就复用现有实例)。没装返回 {ok:false},由调用方走别的路
async function open(dir) {
  const bin = find();
  if (!bin) return { ok: false };
  if (IS_WIN && /["\r\n\u0000]/.test(dir)) return { ok: false, error: '项目路径含无效字符' };
  try {
    // cmd 的命令行需要整体引用;通过环境变量传路径,避免路径中的 %、& 等被再次解释。
    const batch = IS_WIN && /\.cmd$/i.test(bin);
    const child = batch
      ? spawn(process.env.comspec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', '""%PI_DESKTOP_CODE_BIN%" "%PI_DESKTOP_CODE_DIR%""'], {
          detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true,
          env: { ...process.env, PI_DESKTOP_CODE_BIN: bin, PI_DESKTOP_CODE_DIR: dir },
        })
      : spawn(bin, [dir], { detached: true, stdio: 'ignore' });
    return await new Promise((resolve) => {
      child.once('error', (err) => resolve({ ok: false, error: err.message }));
      child.once('close', (code) => resolve(code === 0
        ? { ok: true, bin }
        : { ok: false, error: `VS Code 启动失败(退出码 ${code})` }));
    });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = { find, open };
