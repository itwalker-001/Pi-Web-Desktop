'use strict';

const { ipcMain, shell, BrowserWindow } = require('electron');
const path = require('path');
const { attachPasteHooks } = require('./webview-files');
const config = require('./config');
const { detect, latestVersion, installedPiWebVersion, globalPkgVersion, resolvePiPackage, PI_WEB_PKG } = require('./env');
const { run, buildEnv, compareSemver } = require('./proc');
const server = require('./server');
const remote = require('./remote');
const remoteEnv = require('./remote-env');
const remoteServer = require('./remote-server');
const proxy = require('./proxy');

function portOwnerError(cfg) {
  return `端口 ${cfg.port || 30141} 已被外部 pi-web 进程占用(非本应用启动),文件被占用会导致安装失败,请先停止该服务再更新`;
}

function remotePortOwnerError(cfg) {
  return `远程端口 ${cfg.remote.remotePort || 30141} 已被外部启动的 pi-web 占用(非本应用启动),请先在远程停止该服务再更新`;
}

let updating = false;
let restartAfterUpdate = false;

// 多页面:每个页面一个独立窗口(共享默认 session,代理与登录态一致)
const pages = new Set();

// 允许打开的服务页:本地回环地址,或任一已配置远程服务器的主机(webview 直连远程)
function isAllowedPageUrl(url) {
  if (typeof url !== 'string') return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname;
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') return true;
  return (config.get().remotes || []).some((r) => r.host === host);
}

ipcMain.handle('page:open', (_e, url) => {
  if (!isAllowedPageUrl(url)) {
    return { ok: false, error: '仅支持打开本地或已配置远程服务器的页面' };
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

// 当前模式对应的检测/更新实现(本地或远程,接口同形)
function envApi(cfg) {
  return cfg.mode === 'remote'
    ? {
        detect: remoteEnv.detect,
        installedPiWebVersion: remoteEnv.installedPiWebVersion,
        latestVersion: remoteEnv.latestVersion,
        globalPkgVersion: remoteEnv.globalPkgVersion,
        resolvePiPackage: remoteEnv.resolvePiPackage,
      }
    : { detect, installedPiWebVersion, latestVersion, globalPkgVersion, resolvePiPackage };
}

// 统一构造 update:check 的返回结构
async function checkUpdateShape(cfg) {
  const api = envApi(cfg);
  const [installed, latest, piPkg] = await Promise.all([
    api.installedPiWebVersion(cfg),
    api.latestVersion(cfg, PI_WEB_PKG),
    api.resolvePiPackage(cfg),
  ]);

  let pi = { resolved: !!piPkg, pkg: piPkg ? piPkg.name : null, installed: piPkg ? piPkg.version : null, latest: null, outdated: false };
  if (piPkg) {
    try {
      pi.latest = await api.latestVersion(cfg, piPkg.name);
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
}

async function restartServerIfNeeded(win) {
  if (!restartAfterUpdate) return;
  restartAfterUpdate = false;
  try {
    const cfg = config.get();
    const res = await startServerRouted(cfg, win);
    send(win, 'server:started', eventTag(cfg, res));
  } catch (err) {
    const cfg = config.get();
    send(win, 'server:exited', eventTag(cfg, { code: null, message: String(err.message || err) }));
  }
}

// 服务事件统一打标:本地 → { mode:'local' },远程 → { mode:'remote', remoteId }
function eventTag(cfg, payload) {
  if (cfg.mode === 'remote') {
    return { ...payload, mode: 'remote', remoteId: (cfg.remote && cfg.remote.id) || '' };
  }
  return { ...payload, mode: 'local' };
}

function startServerRouted(cfg, win) {
  const hooks = {
    onLog: (line) => send(win, 'server:log', eventTag(cfg, { line })),
    onExit: (info) => {
      console.log('[pi] service exited', cfg.mode === 'remote' ? 'remote' : 'local', JSON.stringify(info));
      send(win, 'server:exited', eventTag(cfg, info));
    },
  };
  return cfg.mode === 'remote' ? remoteServer.start(cfg, hooks) : server.start(cfg, hooks);
}

function remoteIdentity(p) {
  return `${p.host}|${p.port}|${p.user}|${p.keyPath}`;
}

// 配置变化后联动:本地/各远程服务可同时运行,模式切换与档案切换不停服务;
// 仅当某档案的连接参数(主机/端口/用户/私钥)变化或档案被删除时,
// 停止该档案的服务并断开其 SSH 连接
async function handleModeConfigChange(prev, next, win) {
  const prevById = new Map(((prev && prev.remotes) || []).map((p) => [p.id, p]));
  const nextById = new Map(((next && next.remotes) || []).map((p) => [p.id, p]));
  let changed = false;

  for (const [id, oldP] of prevById) {
    const newP = nextById.get(id);
    const identityChanged = newP && remoteIdentity(oldP) !== remoteIdentity(newP);
    const removed = !newP;
    if (!identityChanged && !removed) continue;
    changed = true;
    const cfg = { mode: 'remote', remote: oldP };
    await remoteServer.stop(cfg);
    remote.disconnect(cfg);
    if (identityChanged) remote.disconnect({ mode: 'remote', remote: newP }); // 新参数若有旧连接也一并断开
    remoteEnv.clearCache();
    send(win, 'server:exited', { code: 0, intentional: true, mode: 'remote', remoteId: id });
  }
  if (changed) return;

  // remotePort 变化不影响 SSH 连接,但运行中的服务需要重启 —— 由渲染层
  // 对齐本地端口变更的行为处理(保存后自动重启),此处不额外干预。
}

function register({ getWindow, onConfigChange }) {
  // config:get 返回视图化代理(协议下拉单行形态;旧配置在此完成迁移展示)
  ipcMain.handle('config:get', () => {
    const cfg = config.get();
    const px = proxy.parseProxy(cfg);
    return {
      ...cfg,
      proxy: {
        enabled: px.enabled,
        remote: px.remote,
        protocol: px.protocol,
        host: px.host,
        port: px.port,
        bypass: String((cfg.proxy && cfg.proxy.bypass) || ''),
        primaryUrl: px.primaryUrl,
      },
    };
  });

  ipcMain.handle('config:set', async (_e, patch) => {
    const prev = config.get();
    const next = config.save(patch || {});
    if (onConfigChange) await onConfigChange(next);
    await handleModeConfigChange(prev, next, getWindow());
    return next;
  });

  ipcMain.handle('env:detect', async () => {
    const cfg = config.get();
    try {
      const env = await envApi(cfg).detect(cfg);
      return { ok: true, env, appVersion: require('../package.json').version, platform: process.platform, mode: cfg.mode };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // SSH 连接测试:可达性 + 免密私钥认证 + 主机指纹
  ipcMain.handle('remote:test', async () => {
    try {
      const r = await remote.testConnection(config.get());
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('update:check', async () => {
    const cfg = config.get();
    try {
      return await checkUpdateShape(cfg);
    } catch (err) {
      // 查询最新版失败时至少给出本地版本
      try {
        const installed = await envApi(cfg).installedPiWebVersion(cfg);
        return { ok: false, installed, latest: null, outdated: false, error: String((err && err.message) || err), pi: null };
      } catch {
        return { ok: false, installed: null, latest: null, outdated: false, error: String((err && err.message) || err), pi: null };
      }
    }
  });

  // 一键更新:target = 'pi-web' | 'pi',按模式在本地或远程执行 npm install -g <pkg>@latest
  ipcMain.handle('update:run', async (_e, target = 'pi-web') => {
    if (updating) return { ok: false, error: '已有更新任务在进行中' };
    updating = true;
    const win = getWindow();
    const cfg = config.get();
    const isRemote = cfg.mode === 'remote';

    try {
      const api = envApi(cfg);
      let pkgName = PI_WEB_PKG;
      if (target === 'pi') {
        const piPkg = await api.resolvePiPackage(cfg);
        if (!piPkg) return { ok: false, error: '未能定位 pi 对应的全局包,请先安装 pi CLI' };
        pkgName = piPkg.name;
      }

      if (isRemote) {
        // 远程端口被外部实例占用时,包文件同样被锁定
        if (!remoteServer.isOwned(cfg) && (await remoteServer.probeRemote(cfg).catch(() => false))) {
          return { ok: false, error: remotePortOwnerError(cfg) };
        }
      } else {
        // 外部 pi-web 占用端口时,包文件被锁定,npm 全局安装会 EBUSY
        if (!server.isOwned() && (await server.probe(server.serverUrl(cfg)))) {
          return { ok: false, error: portOwnerError(cfg) };
        }
      }

      // 服务在运行时先停止(全局安装会因文件占用失败),完成后自动重启
      const wasRunning = isRemote ? remoteServer.isRunning(cfg) : server.isRunning();
      if (wasRunning) {
        if (isRemote) await remoteServer.stop(cfg);
        else server.stop();
        restartAfterUpdate = true;
        send(win, 'server:exited', eventTag(cfg, { code: 0, intentional: true }));
        await new Promise((r) => setTimeout(r, isRemote ? 1200 : 800));
      }

      let res;
      if (isRemote) {
        const cmd = await remoteEnv.npmInstallCommand(cfg, pkgName);
        send(win, 'update:log', { target, line: `$ ssh ${cfg.remote.user}@${cfg.remote.host} → ${cmd}\n` });
        res = await remote.exec(cfg, cmd, {
          timeoutMs: 10 * 60 * 1000,
          onData: (line) => send(win, 'update:log', { target, line }),
        });
      } else {
        send(win, 'update:log', { target, line: `$ npm install -g ${pkgName}@latest\n` });
        res = await run(`npm install -g ${pkgName}@latest`, {
          env: buildEnv(cfg),
          timeoutMs: 10 * 60 * 1000,
          onData: (line) => send(win, 'update:log', { target, line }),
        });
      }

      if (res.code !== 0) {
        const msg = (res.stderr || res.stdout || '').toString().trim().split(/\r?\n/).slice(-3).join('\n');
        return { ok: false, error: msg || `npm install 退出码 ${res.code}` };
      }

      if (isRemote) remoteEnv.clearCache(); // 全局包已变化,重采版本
      const version = target === 'pi'
        ? await api.globalPkgVersion(cfg, pkgName)
        : await api.installedPiWebVersion(cfg);
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
        ...(await startServerRouted(config.get(), getWindow())),
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('server:stop', async () => {
    const cfg = config.get();
    const r = cfg.mode === 'remote' ? await remoteServer.stop(cfg) : server.stop();
    return { ok: true, ...r };
  });

  ipcMain.handle('server:state', async () => {
    const cfg = config.get();
    if (cfg.mode === 'remote') {
      if (!remoteServer.isOwned(cfg) && !remoteServer.isRunning(cfg)) {
        return remoteServer.refreshExternal(cfg);
      }
      return remoteServer.state(cfg);
    }
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
