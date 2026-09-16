'use strict';

const { ipcMain, shell, BrowserWindow } = require('electron');
const path = require('path');
const { attachPasteHooks } = require('./webview-files');
const config = require('./config');
const { detect, latestVersion, installedPiWebVersion, globalPkgVersion, resolvePiPackage, PI_WEB_PKG } = require('./env');
const { run, buildEnv, compareSemver } = require('./proc');
const server = require('./server');

function portOwnerError(cfg) {
  return `端口 ${cfg.port || 30141} 已被外部 pi-web 进程占用(非本应用启动),文件被占用会导致安装失败,请先停止该服务再更新`;
}

let updating = false;
let restartAfterUpdate = false;

// 多页面:每个页面一个独立窗口(共享默认 session,代理与登录态一致)
const pages = new Set();

ipcMain.handle('page:open', (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) {
    return { ok: false, error: '仅支持打开本地服务页面' };
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Pi Web',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 复用 webview 的拖拽文件支持(拖入 → 发回主进程插入路径)
      preload: path.join(__dirname, '..', 'webview-preload.js'),
    },
  });
  pages.add(win);
  win.on('closed', () => pages.delete(win));
  // 独立页面窗口与 webview guest 共用粘贴决策(Ctrl+V 文件路径插入)
  attachPasteHooks(win.webContents, {
    notifyResult: (info) => {
      const main = getWindow();
      if (main && !main.isDestroyed()) main.webContents.send('clipboard:pasted', info);
    },
  });
  win.loadURL(url);
  return { ok: true };
});

function send(win, channel, payload) {
  const wc = win && !win.isDestroyed() ? win.webContents : null;
  if (wc) wc.send(channel, payload);
}

async function restartServerIfNeeded(win) {
  if (!restartAfterUpdate) return;
  restartAfterUpdate = false;
  try {
    const res = await server.start(config.get(), {
      onLog: (line) => send(win, 'server:log', line),
      onExit: (info) => send(win, 'server:exited', info),
    });
    send(win, 'server:started', res);
  } catch (err) {
    send(win, 'server:exited', { code: null, message: String(err.message || err) });
  }
}

function register({ getWindow, onConfigChange }) {
  ipcMain.handle('config:get', () => config.get());

  ipcMain.handle('config:set', async (_e, patch) => {
    const next = config.save(patch || {});
    if (onConfigChange) await onConfigChange(next);
    return next;
  });

  ipcMain.handle('env:detect', async () => {
    try {
      const env = await detect(config.get());
      return { ok: true, env, appVersion: require('../package.json').version, platform: process.platform };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('update:check', async () => {
    const cfg = config.get();
    try {
      const [installed, latest, piPkg] = await Promise.all([
        installedPiWebVersion(cfg),
        latestVersion(cfg, PI_WEB_PKG),
        resolvePiPackage(cfg),
      ]);

      let pi = { resolved: !!piPkg, pkg: piPkg ? piPkg.name : null, installed: piPkg ? piPkg.version : null, latest: null, outdated: false };
      if (piPkg) {
        try {
          pi.latest = await latestVersion(cfg, piPkg.name);
          pi.outdated = !!(pi.installed && pi.latest && compareSemver(pi.installed, pi.latest) < 0);
        } catch (err) {
          pi.latestError = String((err && err.message) || err);
        }
      }

      return {
        ok: true,
        installed,
        latest,
        outdated: !!(installed && latest && compareSemver(installed, latest) < 0),
        pi,
      };
    } catch (err) {
      // 查询最新版失败时至少给出本地版本
      const installed = await installedPiWebVersion(cfg);
      return { ok: false, installed, latest: null, outdated: false, error: String((err && err.message) || err), pi: null };
    }
  });

  // 一键更新:target = 'pi-web' | 'pi',执行 npm install -g <pkg>@latest
  ipcMain.handle('update:run', async (_e, target = 'pi-web') => {
    if (updating) return { ok: false, error: '已有更新任务在进行中' };
    updating = true;
    const win = getWindow();
    const cfg = config.get();
    const wasRunning = server.isRunning();

    try {
      let pkgName = PI_WEB_PKG;
      if (target === 'pi') {
        const piPkg = await resolvePiPackage(cfg);
        if (!piPkg) return { ok: false, error: '未能定位 pi 对应的全局包,请先安装 pi CLI' };
        pkgName = piPkg.name;
      }

      // 外部 pi-web 占用端口时,包文件被锁定,npm 全局安装会 EBUSY
      if (!server.isOwned() && (await server.probe(server.serverUrl(cfg)))) {
        return { ok: false, error: portOwnerError(cfg) };
      }

      // Windows 下全局安装时包文件被占用会失败,先停服务
      if (wasRunning) {
        server.stop();
        restartAfterUpdate = true;
        send(win, 'server:exited', { code: 0, intentional: true });
        await new Promise((r) => setTimeout(r, 800));
      }

      send(win, 'update:log', { target, line: `$ npm install -g ${pkgName}@latest\n` });
      const res = await run(`npm install -g ${pkgName}@latest`, {
        env: buildEnv(cfg),
        timeoutMs: 10 * 60 * 1000,
        onData: (line) => send(win, 'update:log', { target, line }),
      });

      if (res.code !== 0) {
        const msg = (res.stderr || res.stdout || '').toString().trim().split(/\r?\n/).slice(-3).join('\n');
        return { ok: false, error: msg || `npm install 退出码 ${res.code}` };
      }

      const version = target === 'pi'
        ? await globalPkgVersion(cfg, pkgName)
        : await installedPiWebVersion(cfg);
      return { ok: true, target, version };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      updating = false;
      await restartServerIfNeeded(win);
    }
  });

  ipcMain.handle('server:start', async () => {
    try {
      return {
        ok: true,
        ...(await server.start(config.get(), {
          onLog: (line) => send(getWindow(), 'server:log', line),
          onExit: (info) => send(getWindow(), 'server:exited', info),
        })),
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('server:stop', () => {
    const r = server.stop();
    return { ok: true, ...r };
  });

  ipcMain.handle('server:state', async () => {
    const cfg = config.get();
    if (!server.isOwned() && !server.isRunning()) {
      return server.refreshExternal(cfg);
    }
    return server.state();
  });

  ipcMain.handle('shell:open', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, error: '非法链接' };
  });
}

module.exports = { register };
