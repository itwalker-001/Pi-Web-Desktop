'use strict';

const { ipcMain, shell, BrowserWindow, dialog, clipboard } = require('electron');
const config = require('./config');
const { detect, latestVersion, installedPiWebVersion, globalPkgVersion, resolvePiPackage, PI_WEB_PKG } = require('./env');
const { run, buildEnv, compareSemver } = require('./proc');
const server = require('./server');
const remote = require('./remote');
const remoteEnv = require('./remote-env');
const remoteServer = require('./remote-server');
const proxy = require('./proxy');
const codeServer = require('./code-server');
const localEditor = require('./local-editor');
const term = require('./term');
const { readClipboardFilePaths } = require('./webview-files');

function portOwnerError(cfg) {
  return `端口 ${cfg.port || 30141} 已被外部 pi-web 进程占用(非本应用启动),文件被占用会导致安装失败,请先停止该服务再更新`;
}

function remotePortOwnerError(cfg) {
  const r = (cfg && cfg.remote) || {};
  const where = `${r.user ? `${r.user}@` : ''}${r.host || '远程'} 的端口 ${r.remotePort || 30141}`;
  return `远程 ${where} 已被外部启动的 pi-web 占用(非本应用启动),请先在该服务器上停止它再更新(也可在服务卡点「停止」确认强制结束后重试)`;
}

let updating = false;
let restartAfterUpdate = false;
// 主窗口的取法由 register() 传入;模块顶层的处理函数(开窗口)也要用它,所以存一份
let getMainWindow = () => null;

// 多页面:code-server 每个窗口一个(共享默认 session,代理与登录态一致)
const pages = new Set();

// 开 code-server 用的独立窗口(默认 session:与内嵌页共用代理与登录态)
function openPageWindow(url, { title = 'Pi Web' } = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pages.add(win);
  win.on('closed', () => pages.delete(win));
  win.loadURL(url);
  return win;
}

/* ---------------- code-server:用 code-server 打开 pi-web 的当前项目(可选组件,按需安装 / 按需启动)---------------- */

// dir:pi-web 当前项目目录(渲染层从服务页里识别出来,只接受绝对路径)
ipcMain.handle('editor:open', async (_e, dir) => {
  const absolute = typeof dir === 'string' && ((dir.length > 1 && dir.startsWith('/') && !dir.startsWith('//')) || /^[A-Za-z]:[\\/]/.test(dir));
  if (!absolute || /[\u0000-\u001f\u007f]/.test(dir) || dir.length > 4096) {
    return { ok: false, error: '没能从服务页识别出有效的项目目录' };
  }
  try {
    const cfg = config.get();
    const target = await codeServer.resolveTarget(cfg);
    // 本机目标:优先用桌面版 VS Code 打开(code-server 在 Windows 上装不上,本机不提供安装)。
    // 显式填了 codeServerUrl 的除外 —— 填了就按填的来
    if (cfg.mode !== 'remote' && !target.explicit) {
      const opened = await localEditor.open(dir);
      if (opened.ok) return { ok: true, app: 'vscode' };
    }
    // 上次没正常退出(应用被强杀、覆盖升级)留在服务器上的实例:认领回来,退出时一并回收
    if (target.managed) codeServer.adopt(cfg, target.info);
    if (target.managed && !target.info.installed) {
      // 可选组件:没装不算错误,交给渲染层问用户要不要装
      return { ok: false, needInstall: true, error: `${cfg.remote.host} 上还没有 code-server` };
    }
    // 确认那个地址上跑的是 code-server(端口被别的程序占着时不算),否则按需启动
    if (!(await codeServer.isCodeServer(target.base))) {
      if (!target.managed) {
        const hint = cfg.mode === 'remote'
          ? '该地址按配置里填写的打开,本应用不代为启动'
          : '本机没找到 VS Code,也没有在运行的 code-server —— 安装 VS Code,或在配置文件的 codeServerUrl 里填写一个在运行的 code-server 地址';
        throw new Error(`code-server 没在运行或本机访问不到:${target.base}(${hint})`);
      }
      // 按需启动;想用的端口被占时它会顺延,所以地址以启动后的结果为准
      target.base = (await codeServer.start(cfg, target)).url;
    }
    const url = `${target.base}/?folder=${encodeURIComponent(dir)}`;
    const win = openPageWindow(url, { title: 'code-server', withPasteHooks: false });
    // 窗口落到登录页时,把服务器上 code-server 的登录密码交给用户(渲染层复制并提示)。
    // 已登录会直接进项目、不触发;会话过期退回登录页时会再给一次
    if (target.managed && target.info) {
      let lastLoginUrl = '';
      win.webContents.on('did-navigate', (_e, landed) => {
        if (!/\/login(\?|$)/.test(landed) || landed === lastLoginUrl) return;
        lastLoginUrl = landed;
        codeServer.readConfig(cfg).then((conf) => {
          if (conf.auth === 'password' && conf.password) send(getMainWindow(), 'code-server:password', { password: conf.password, host: cfg.remote.host });
        }).catch(() => {});
      });
    }
    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 安装/更新前的确认(原生对话框,主窗口为父;默认焦点在「取消」)。
// arg = { installed, bin }:已装时文案改为「更新」;系统安装的(不在 ~/.pi-web-desktop 下)
// 说明本应用只能更新自己管理的副本,不动系统包
ipcMain.handle('code-server:confirmInstall', async (_e, arg) => {
  const cfg = config.get();
  const win = getMainWindow();
  const target = cfg.remote ? `${cfg.remote.user}@${cfg.remote.host}` : '该服务器';
  const installed = !!(arg && arg.installed);
  const bin = String((arg && arg.bin) || '');
  const systemBin = installed && /^\//.test(bin) && !/\.pi-web-desktop/.test(bin);
  const downloadNote = '安装的是官方独立发行包,放在该服务器的 ~/.pi-web-desktop/code-server 下:不需要 root、不改系统;下载约 270MB,解压后约 740MB。下载沿用该服务器的代理设置。';
  let opts;
  if (systemBin) {
    opts = {
      type: 'question',
      buttons: ['更新本应用副本', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '更新 code-server',
      message: `${target} 上的 code-server 是系统安装的(${bin}),本应用只能更新自己管理的副本。仍要下载最新版到 ~/.pi-web-desktop/code-server 吗?`,
      detail: '系统包及其正在运行的服务不受影响;两者同时存在时,启动与检测仍优先使用系统那份。',
      noLink: true,
    };
  } else if (installed) {
    opts = {
      type: 'question',
      buttons: ['更新', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '更新 code-server',
      message: `${target} 上的 code-server 要更新到最新版本吗?`,
      detail: `会下载最新版替换本应用管理的副本。${downloadNote}`,
      noLink: true,
    };
  } else {
    opts = {
      type: 'question',
      buttons: ['安装', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '安装 code-server',
      message: `${target} 上还没有 code-server,现在安装吗?`,
      detail: `code-server 是可选组件,不安装不影响其它功能。${downloadNote}`,
      noLink: true,
    };
  }
  const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return { confirmed: res.response === 0 };
});

// 一键安装 code-server(仅远程服务器):进度写进更新日志,与 pi / pi-web 的安装更新互斥
ipcMain.handle('code-server:install', async () => {
  if (updating) return { ok: false, error: '已有安装或更新任务在进行中' };
  updating = true;
  const win = getMainWindow();
  try {
    const cfg = config.get();
    if (cfg.mode !== 'remote' || !cfg.remote) return { ok: false, error: '只能在远程服务器上一键安装 code-server' };
    send(win, 'update:log', { target: 'code-server', line: '\n—— 开始安装 ——\n' });
    const r = await codeServer.install(cfg, { onData: (line) => send(win, 'update:log', { target: 'code-server', line }) });
    send(win, 'update:log', { target: 'code-server', line: `✅ 安装完成,版本 ${r.version}\n` });
    return { ok: true, version: r.version };
  } catch (err) {
    const error = String((err && err.message) || err);
    send(win, 'update:log', { target: 'code-server', line: `❌ 安装失败:${error}\n` });
    return { ok: false, error };
  } finally {
    updating = false;
  }
});

function send(win, channel, payload) {
  const wc = win && !win.isDestroyed() ? win.webContents : null;
  if (wc) wc.send(channel, payload);
}

/* ---------------- code-server 配置卡:状态 / 写监听配置 / 启停 / 打开 ---------------- */

ipcMain.handle('code-server:state', async (_e, arg) => {
  try {
    const cfg = cfgForTarget(arg && arg.target);
    if (cfg.mode !== 'remote' || !(cfg.remote && cfg.remote.host)) {
      // 本机目标:不检测远程,按本机地址视角返回(卡上只允许填地址/打开)
      return { ok: true, local: true, managed: false, running: null, owned: false };
    }
    const target = await codeServer.resolveTarget(cfg);
    const running = await codeServer.isCodeServer(target.base);
    const ownedPorts = codeServer.startedFor(cfg);
    return {
      ok: true,
      local: false,
      managed: target.managed,
      base: target.base,
      port: target.port,
      running,
      owned: ownedPorts.includes(Number(target.port)),
      info: {
        installed: !!(target.info && target.info.installed),
        bin: (target.info && target.info.bin) || '',
        version: (target.info && target.info.version) || '',
        bindPort: (target.info && target.info.bindPort) || '',
        auth: (target.info && target.info.auth) || '',
        password: (target.info && target.info.password) || '',
        configured: !!(target.info && target.info.configured),
        appPort: (target.info && target.info.appPort) || '',
      },
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 写服务器上的 ~/.config/code-server/config.yaml(bind-addr 0.0.0.0:port + auth/password)
ipcMain.handle('code-server:save', async (_e, arg) => {
  try {
    const cfg = cfgForTarget(arg && arg.target);
    if (cfg.mode !== 'remote' || !(cfg.remote && cfg.remote.host)) {
      return { ok: false, error: '监听端口与密码只支持配置远程服务器(本机优先用 VS Code)' };
    }
    const conf = await codeServer.writeConfig(cfg, { port: arg && arg.port, password: arg && arg.password });
    return { ok: true, conf: { bindPort: conf.bindPort, auth: conf.auth, password: conf.password } };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('code-server:start', async (_e, arg) => {
  try {
    const cfg = cfgForTarget(arg && arg.target);
    if (cfg.mode !== 'remote' || !(cfg.remote && cfg.remote.host)) return { ok: false, error: '只能启动远程服务器上的 code-server' };
    const win = getMainWindow();
    const target = await codeServer.resolveTarget(cfg);
    if (!target.managed) return { ok: false, error: '该地址按你的配置打开,本应用不代为启动' };
    if (target.info && target.info.orphans && target.info.orphans.length) codeServer.adopt(cfg, target.info);
    if (await codeServer.isCodeServer(target.base)) return { ok: true, url: target.base, already: true };
    if (!(target.info && target.info.installed)) return { ok: false, needInstall: true, error: `${cfg.remote.host} 上还没有 code-server` };
    const r = await codeServer.start(cfg, target, { onData: (line) => send(win, 'update:log', { target: 'code-server', line }) });
    return { ok: true, url: r.url, port: r.port };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 停止前确认(外部实例,主窗口为父;默认焦点在「取消」)
ipcMain.handle('code-server:confirmForceStop', async (_e, arg) => {
  const cfg = cfgForTarget(arg && arg.target);
  const win = getMainWindow();
  const opts = {
    type: 'warning',
    buttons: ['强制结束', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '强制结束 code-server',
    message: `该 code-server 不是本应用启动的,仍要强制结束 ${cfg.remote ? `${cfg.remote.user}@${cfg.remote.host} 端口 ${arg && arg.port}` : '它'} 吗?`,
    detail: '将结束该端口上监听的 code-server 进程。请确认没有正在编辑的内容未保存。',
    noLink: true,
  };
  const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return { confirmed: res.response === 0 };
});

ipcMain.handle('code-server:stop', async (_e, arg) => {
  try {
    const cfg = cfgForTarget(arg && arg.target);
    if (cfg.mode !== 'remote' || !(cfg.remote && cfg.remote.host)) return { ok: false, error: '只能停止远程服务器上的 code-server' };
    const target = await codeServer.resolveTarget(cfg).catch(() => null);
    const port = (arg && arg.port) || (target && target.port);
    const r = await codeServer.stop(cfg, { port, force: !!(arg && arg.force) });
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 打开 code-server 页面(不带项目目录;没在运行且属托管时按需启动,登录页密码同 editor:open)
ipcMain.handle('code-server:open', async (_e, arg) => {
  try {
    const cfg = cfgForTarget(arg && arg.target);
    const target = await codeServer.resolveTarget(cfg);
    if (target.managed && target.info && target.info.orphans && target.info.orphans.length) codeServer.adopt(cfg, target.info);
    let base = target.base;
    if (!(await codeServer.isCodeServer(base))) {
      if (!target.managed) throw new Error(`code-server 没在运行或访问不到:${base}`);
      if (!(target.info && target.info.installed)) return { ok: false, needInstall: true, error: `${(cfg.remote && cfg.remote.host) || '本机'} 上还没有 code-server` };
      const win = getMainWindow();
      const r = await codeServer.start(cfg, target, { onData: (line) => send(win, 'update:log', { target: 'code-server', line }) });
      base = r.url;
    }
    const page = openPageWindow(base, { title: 'code-server' });
    if (target.managed && target.info) {
      let lastLoginUrl = '';
      page.webContents.on('did-navigate', (_e, landed) => {
        if (!/\/login(\?|$)/.test(landed) || landed === lastLoginUrl) return;
        lastLoginUrl = landed;
        codeServer.readConfig(cfg).then((conf) => {
          if (conf.auth === 'password' && conf.password) send(getMainWindow(), 'code-server:password', { password: conf.password, host: (cfg.remote && cfg.remote.host) || '' });
        }).catch(() => {});
      });
    }
    return { ok: true, url: base };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

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

// 按目标取配置视图:渲染层发起检测时指明查的是哪台(本机 / 某个远程档案),主进程就按它执行,
// 而不是「执行时恰好被激活的那台」—— 请求在途时用户切 Tab,结果也不会落到别的服务器上
function cfgForTarget(target) {
  const cur = config.get();
  if (!target || typeof target !== 'object') return cur; // 未指明目标:取当前激活的
  if (target.mode !== 'remote') return { ...cur, mode: 'local' };
  const profile = (cur.remotes || []).find((r) => r.id === target.remoteId) || null;
  return { ...cur, mode: 'remote', remote: profile };
}

// 检测类响应带上目标标识(mode + remoteId + 连接身份):渲染层据此把结果归档到对应的服务器;
// 身份对不上说明检测期间档案被改成了别的服务器,结果作废。档案已不存在时 identity 为空
function targetTag(cfg, payload, target) {
  if (cfg.mode !== 'remote') return { ...payload, mode: 'local', remoteId: '', identity: '' };
  return {
    ...payload,
    mode: 'remote',
    remoteId: (cfg.remote && cfg.remote.id) || (target && target.remoteId) || '',
    identity: cfg.remote ? remoteIdentity(cfg.remote) : '',
  };
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
    if (!identityChanged && !removed) {
      // 远程端口变了:服务标识含远程端口,按新档案已找不到旧端口上的实例(渲染层重启时的 stop 会落空),
      // 先按旧档案停掉它;渲染层随后在新端口重新启动
      if (newP && Number(oldP.remotePort || 30141) !== Number(newP.remotePort || 30141)) {
        const oldCfg = { mode: 'remote', remote: oldP };
        if (remoteServer.isRunning(oldCfg)) await remoteServer.stop(oldCfg);
      }
      continue;
    }
    changed = true;
    const cfg = { mode: 'remote', remote: oldP };
    await remoteServer.stop(cfg);
    remote.disconnect(cfg);
    if (identityChanged) remote.disconnect({ mode: 'remote', remote: newP }); // 新参数若有旧连接也一并断开
    remoteEnv.clearCache();
    send(win, 'server:exited', { code: 0, intentional: true, mode: 'remote', remoteId: id });
  }
  if (changed) return;

  // remotePort 变化不影响 SSH 连接:旧端口上的实例已在上面停止,新端口上的重启由渲染层处理
  // (对齐本地端口变更的行为:保存后自动重启)。
}

// 给渲染层的配置里带两样代理视图(协议下拉单行形态;旧配置在此完成迁移展示):
//   proxy      → 当前目标的代理(渲染层按它画盾形开关与代理卡)
//   proxyViews → 每个目标各自的({ local, remotes: { 档案 id } }),切 Tab 时不必再往返主进程
function withProxyViews(cfg) {
  const remotes = {};
  for (const r of cfg.remotes || []) {
    remotes[r.id] = proxy.parseProxy({ ...cfg, mode: 'remote', remote: r });
  }
  const local = proxy.parseProxy({ ...cfg, mode: 'local' });
  const current = cfg.mode === 'remote' && cfg.remote && remotes[cfg.remote.id] ? remotes[cfg.remote.id] : local;
  return { ...cfg, proxy: current, proxyViews: { local, remotes } };
}

function register({ getWindow, onConfigChange }) {
  getMainWindow = getWindow;
  ipcMain.handle('config:get', () => withProxyViews(config.get()));

  ipcMain.handle('config:set', async (_e, patch) => {
    const prev = config.get();
    const next = config.save(patch || {});
    if (onConfigChange) await onConfigChange(next);
    await handleModeConfigChange(prev, next, getWindow());
    return withProxyViews(next);
  });

  // 环境检测:按渲染层指明的目标执行(不传则取当前激活的),响应带回目标标识供归档
  ipcMain.handle('env:detect', async (_e, target) => {
    const cfg = cfgForTarget(target);
    try {
      const env = await envApi(cfg).detect(cfg);
      return targetTag(cfg, {
        ok: true,
        env,
        appVersion: require('../package.json').version,
        platform: process.platform,
      }, target);
    } catch (err) {
      return targetTag(cfg, { ok: false, error: String((err && err.message) || err) }, target);
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

  // 版本检测:同样按指明的目标执行,响应带回目标标识
  ipcMain.handle('update:check', async (_e, target) => {
    const cfg = cfgForTarget(target);
    try {
      return targetTag(cfg, await checkUpdateShape(cfg), target);
    } catch (err) {
      // 查询最新版失败时至少给出本地版本
      const fallback = async () => ({ ok: false, installed: await envApi(cfg).installedPiWebVersion(cfg), latest: null, outdated: false, pi: null });
      const shape = await fallback().catch(() => ({ ok: false, installed: null, latest: null, outdated: false, pi: null }));
      return targetTag(cfg, { ...shape, error: String((err && err.message) || err) }, target);
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
        // 远程端口被外部实例占用时,包文件同样被锁定(自己遗留的实例已在 server:state 同步时认领)
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
        if (isRemote) {
          // 停不掉就不装:pi-web 还开着时包文件被占,npm 只会报一堆文件占用错误
          const stopped = await remoteServer.stop(cfg);
          if (stopped.error) return { ok: false, error: stopped.error };
        } else server.stop();
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

  ipcMain.handle('server:stop', async (_e, opts = {}) => {
    const cfg = config.get();
    // force:强制结束(外部实例)。只有渲染层在用户确认过原生对话框后才会带该标志
    const r = cfg.mode === 'remote'
      ? await remoteServer.stop(cfg, { force: !!(opts && opts.force) })
      : server.stop();
    return { ok: true, ...r };
  });

  // 强制结束外部实例前的确认(原生警告框,主窗口为父;取消则不执行)
  ipcMain.handle('stop:confirmForce', async () => {
    const cfg = config.get();
    const win = getWindow();
    const r = (cfg.mode === 'remote' && cfg.remote)
      ? `${[cfg.remote.user, cfg.remote.host].filter(Boolean).join('@')} 的端口 ${cfg.remote.remotePort || 30141}`
      : `本机端口 ${cfg.port || 30141}`;
    const opts = {
      type: 'warning',
      buttons: ['强制结束', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '强制结束 pi-web',
      message: `该 pi-web 不是本应用启动的,仍要强制结束 ${r} 上的进程吗?`,
      detail: '将结束该端口上监听的全部进程(pi-web 及其子进程)。请确认没有他人正在使用该服务。',
      noLink: true,
    };
    const res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return { confirmed: res.response === 0 };
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

  // 写入剪贴板(目前用于把 code-server 的登录密码交给用户)。Electron 的剪贴板接口是异步的:要等写入
  // 真正完成才算复制成功,失败如实返回 —— 不等的话,写不进去时界面仍会提示「已复制到剪贴板」
  ipcMain.handle('shell:copy', async (_e, text) => {
    if (typeof text !== 'string' || !text || text.length > 4096) return { ok: false };
    try {
      await clipboard.writeText(text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  /* ---------------- SSH 终端(远程交互式 shell + Ctrl+V 上传 /tmp) ---------------- */

  // 会话输出/结束推给渲染层(单窗口应用,直接发主窗口;SSH 断开时 term 层会自动结束会话)
  term.onTermData(({ id, data }) => send(getWindow(), 'term:data', { id, data }));
  term.onTermExit(({ id, reason }) => send(getWindow(), 'term:exit', { id, reason }));

  ipcMain.handle('term:start', async (_e, arg) => {
    try {
      const target = arg && arg.target;
      const cfg = cfgForTarget(target);
      if (cfg.mode !== 'remote' || !(cfg.remote && cfg.remote.host)) {
        return { ok: false, error: '终端仅支持已配置的远程服务器' };
      }
      const r = await term.start(cfg, {
        cols: clampInt(arg && arg.cols, 80, 2, 500),
        rows: clampInt(arg && arg.rows, 24, 2, 300),
      });
      return targetTag(cfg, { ok: true, id: r.id }, target);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('term:write', async (_e, arg) => {
    const id = arg && arg.id;
    const data = arg && arg.data;
    if (typeof id !== 'string' || typeof data !== 'string' || !data.length || data.length > 65536) {
      return { ok: false, error: '参数不合法' };
    }
    try {
      term.write(id, data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('term:resize', async (_e, arg) => {
    try {
      term.resize(arg && arg.id, clampInt(arg && arg.cols, 80, 2, 500), clampInt(arg && arg.rows, 24, 2, 300));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('term:stop', async (_e, arg) => {
    const id = arg && arg.id;
    if (typeof id !== 'string') return { ok: false, error: '参数不合法' };
    term.stop(id); // 幂等:会话已不在时静默成功
    return { ok: true };
  });

  // 终端里的 Ctrl+V:主进程做剪贴板三态仲裁 ——
  // ① 截图/图片 → 经 SFTP 上传 /tmp  ② 复制的文件 → 逐个上传  ③ 文本 → 交给渲染层按普通粘贴处理
  ipcMain.handle('term:paste', async (_e, arg) => {
    try {
      const cfg = cfgForTarget(arg && arg.target);
      if (cfg.mode !== 'remote' || !(cfg.remote && cfg.remote.host)) {
        return { ok: false, error: '仅远程服务器支持上传' };
      }
      const img = await readClipboardImage();
      if (img) {
        const ext = (/^image\/([a-z0-9]+)/i.exec(img.mime) || [])[1] || 'png';
        const paths = await term.upload(cfg, [{ name: `pi-paste-${termTimeStamp()}.${ext}`, buffer: img.buffer }]);
        return { ok: true, type: 'uploaded', paths };
      }
      const files = await readClipboardFilePaths();
      if (files.length) {
        const paths = await term.upload(cfg, files.map((p) => ({ localPath: p })));
        return { ok: true, type: 'uploaded', paths };
      }
      const text = await clipboard.readText();
      return { ok: true, type: 'text', text: text.length > 65536 ? text.slice(0, 65536) : text };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

// 截图上传文件名里的时间戳(毫秒精度,同秒多次粘贴也不互相覆盖)
function termTimeStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function clampInt(v, dflt, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// 读剪贴板里的图片(截图等)。Electron 44 的 clipboard 是异步 W3C 形态:
// read() → ClipboardItem[],按 MIME 类型取 Blob(readImage/readBuffer 已不存在)
async function readClipboardImage() {
  try {
    const items = await clipboard.read();
    for (const item of items) {
      const mime = (item.types || []).find((t) => /^image\//i.test(t));
      if (!mime) continue;
      const blob = await item.getType(mime);
      const buffer = Buffer.from(await blob.arrayBuffer());
      if (buffer.length) return { mime, buffer };
    }
  } catch {}
  return null;
}

module.exports = { register };
