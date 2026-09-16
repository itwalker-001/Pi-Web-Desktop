'use strict';

const { app, BrowserWindow, session, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 桌面会话的 PATH 往往不含用户级 Node(nvm / tarball 手动安装),导致环境检测与
// npm 一键安装报 "npm: not found"。这里按平台补充常见位置;npm -g 产物同样落在
// 这些目录(如 ~/.local/node/bin、%APPDATA%\npm),装完即可被检测到。
//
// 优先级:nvm-windows 存在时,其「当前激活版本」的符号链接目录最优先
// (跟随 nvm use);其余候选一律追加到 PATH 末尾——绝不前置遮蔽用户已有环境
// (否则 Program Files\nodejs 会压过 nvm,检测到旧版本)。
(function augmentPath() {
  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';

  // 定位 nvm-windows 的符号链接目录(settings.txt 的 path: / NVM_SYMLINK)
  function nvmSymlinkDir() {
    if (process.env.NVM_SYMLINK) return process.env.NVM_SYMLINK;
    const homes = [process.env.NVM_HOME, path.join(appData, 'nvm'), path.join(home, 'AppData', 'Local', 'nvm'), 'C:\\nvm4w'];
    for (const h of homes) {
      if (!h) continue;
      try {
        const txt = fs.readFileSync(path.join(h, 'settings.txt'), 'utf8');
        const m = txt.match(/^path:\s*(.+)$/mi);
        if (m) return m[1].trim();
      } catch {}
    }
    return null;
  }

  const seenKey = (p) => (isWin ? p.toLowerCase() : p);
  const current = (process.env.PATH || '').split(sep).filter(Boolean);
  const seen = new Set(current.map(seenKey));
  const exists = (p) => {
    try {
      fs.accessSync(p);
      return true;
    } catch {
      return false;
    }
  };

  const prepend = [];
  const append = [];

  // 1) nvm 存在 → 符号链接目录放最前,优先级高于一切已存在的 Node
  const nvmDir = nvmSymlinkDir();
  if (nvmDir && exists(nvmDir) && !seen.has(seenKey(nvmDir))) {
    prepend.push(nvmDir);
    seen.add(seenKey(nvmDir));
  }

  // 2) 其余兜底位置:只在缺失时追加到末尾,不遮蔽现有环境
  const fallbacks = isWin
    ? [
        path.join(appData, 'npm'),                    // npm -g 全局 bin(用户级前缀,非 nvm 场景)
        path.join(programFiles, 'nodejs'),            // Node 默认安装目录(无 nvm 时的兜底)
      ]
    : [
        path.join(home, '.local/node/bin'),           // tarball 手动安装 + npm -g 产物
        path.join(home, '.local/bin'),
        '/usr/local/bin',
      ];
  for (const p of fallbacks) {
    if (exists(p) && !seen.has(seenKey(p))) {
      append.push(p);
      seen.add(seenKey(p));
    }
  }

  if (prepend.length || append.length) {
    process.env.PATH = [...prepend, ...current, ...append].join(sep);
  }
})();
const config = require('./lib/config');
const server = require('./lib/server');
const { register: registerIpc } = require('./lib/ipc');
const { detect, latestVersion } = require('./lib/env');
const { attachWebContentsHooks } = require('./lib/webview-files');

let mainWindow = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// 内嵌浏览器(webview)与主窗口共用默认 session,统一应用代理
async function applySessionProxy(cfg) {
  try {
    if (cfg.proxy && cfg.proxy.enabled && cfg.proxy.url) {
      await session.defaultSession.setProxy({ proxyRules: cfg.proxy.url.trim() });
    } else {
      await session.defaultSession.setProxy({ mode: 'system' });
    }
  } catch {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    title: 'Pi Web Desktop',
    backgroundColor: '#0e1320',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // GPU 初始化失败(如 VMware 下 MESA 加载失败)时 ready-to-show 可能永不触发,
  // 窗口会以 show:false 状态滞留并占住单实例锁。按时间分级处理:
  //   3s 后仍不可见 → 强制 show(内容未就绪时由 backgroundColor 兜底)
  //  10s 后仍不可见 → 看门狗退出释放锁;未试过禁用 GPU 则带 --disable-gpu 自愈重启
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 3000);
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    if (!process.argv.includes('--disable-gpu')) {
      app.relaunch({ args: process.argv.slice(1).concat('--disable-gpu') });
    }
    app.exit(1);
  }, 10000);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('second-instance', () => {
  // 首实例窗口已丢失(如 GPU 异常未显示)时,重新创建而不是让二次启动静默失效
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

// webview 内的文件粘贴/拖拽 → 插入本地路径到 pi-web 输入框
app.on('web-contents-created', (_e, contents) => {
  attachWebContentsHooks(contents, {
    notifyResult: (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('clipboard:pasted', info);
      }
    },
  });
});

app.whenReady().then(async () => {
  await applySessionProxy(config.get());
  registerIpc({
    getWindow: () => mainWindow,
    onConfigChange: applySessionProxy,
  });

  // 不使用应用菜单(界面按钮已覆盖全部功能);置 null 避免 Electron 启用默认英文菜单
  Menu.setApplicationMenu(null);

  // --smoke:无界面自检,输出环境检测结果后退出(CI / 首次验证用)
  if (process.argv.includes('--smoke')) {
    try {
      const cfg = config.get();
      const env = await detect(cfg);
      let latest = null;
      let latestError = null;
      try {
        latest = await latestVersion(cfg);
      } catch (e) {
        latestError = String((e && e.message) || e);
      }
      console.log('[smoke] ' + JSON.stringify({ env, latest, latestError, appVersion: app.getVersion() }, null, 2));
    } catch (e) {
      console.error('[smoke] failed:', e);
      app.exit(1);
      return;
    }
    app.exit(0);
    return;
  }

  createWindow();

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  server.stop();
  app.quit();
});
