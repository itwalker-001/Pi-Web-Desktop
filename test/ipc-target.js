// IPC 层「按目标」自检(离线:mock electron 与检测实现):
//   环境检测 —— env:detect / update:check 必须按渲染层指明的目标(本机 / 某个远程档案)执行,
//     即使此刻激活的是另一台;响应带回目标标识(mode + remoteId + 连接身份)供渲染层归档。
//   代理 —— config:get / config:set 给出每个目标各自的代理视图,改动只落在指定目标。
// 运行:node test/ipc-target.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const LIB = path.join(__dirname, '..', 'lib');
const IPC_PATH = path.join(LIB, 'ipc.js');

// 模拟 userData:两台远程档案(各持一份互不相同的代理),本机也有一份;当前激活的是 A
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ipc-'));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  mode: 'remote',
  activeRemoteId: 'A',
  port: 30141,
  autoStart: false,
  proxy: { enabled: true, protocol: 'http', host: '10.9.9.9', port: 9, bypass: '' },
  registry: '',
  remotes: [
    { id: 'A', host: '10.0.0.1', port: 22, user: 'alice', remotePort: 30141, hostFingerprint: 'aa',
      proxy: { enabled: true, protocol: 'socks5', host: '10.1.1.1', port: 1080, bypass: '*.a' } },
    { id: 'B', host: '10.0.0.2', port: 2222, user: 'bob', remotePort: 30142, hostFingerprint: 'bb',
      proxy: { enabled: false, protocol: 'http', host: '10.2.2.2', port: 8080, bypass: '' } },
  ],
}));

const handlers = {};
const fakeElectron = {
  ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
  shell: {},
  BrowserWindow: function BrowserWindow() {},
  dialog: {},
  clipboard: {},
  app: { getPath: () => tmp },
};

// 检测实现的替身:返回值里带上「实际查的是哪台」(远程取主机末段,本机为 L)
const num = (cfg) => (cfg.mode === 'remote' && cfg.remote ? cfg.remote.host.split('.').pop() : 'L');
const mark = (cfg, k) => `${k}-${num(cfg)}`;
const fakeRemoteEnv = {
  PI_WEB_PKG: '@agegr/pi-web',
  detect: async (cfg) => {
    if (!cfg.remote) throw new Error('远程模式未配置主机地址'); // 与真实实现一致:没有档案就无法检测
    return { node: { version: `v22.${num(cfg)}.0`, ok: true }, piWeb: { version: `0.17.${num(cfg)}`, ok: true } };
  },
  installedPiWebVersion: async (cfg) => `0.17.${num(cfg)}`,
  latestVersion: async (cfg, pkg) => {
    if (failLatest.has(num(cfg))) throw new Error(`npm view failed on ${cfg.remote.host}`);
    return `0.18.${num(cfg)}`;
  },
  globalPkgVersion: async (cfg) => `1.0.${num(cfg)}`,
  resolvePiPackage: async (cfg) => ({ name: `pi-${num(cfg)}`, version: `1.0.${num(cfg)}` }),
};
const fakeLocalEnv = {
  detect: async () => ({ node: { version: 'v22.L.0', ok: true }, piWeb: { version: '0.17.L', ok: true } }),
  installedPiWebVersion: async () => '0.17.L',
  latestVersion: async () => '0.18.L',
  globalPkgVersion: async () => '1.0.L',
  resolvePiPackage: async () => ({ name: 'pi-L', version: '1.0.L' }),
  PI_WEB_PKG: '@agegr/pi-web',
};
const failLatest = new Set();

const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'electron') return fakeElectron;
  const fromIpc = args[0] && path.resolve(args[0].filename || '') === IPC_PATH;
  if (fromIpc && request === './remote-env') return fakeRemoteEnv;
  if (fromIpc && request === './env') return fakeLocalEnv;
  return origLoad.apply(this, [request, ...args]);
};

require(IPC_PATH).register({ getWindow: () => null, onConfigChange: null });

function assert(cond, msg, detail) {
  console.log(cond ? 'PASS: ' + msg : 'FAIL: ' + msg + (detail ? `  [${JSON.stringify(detail)}]` : ''));
  if (!cond) process.exit(1);
}

(async () => {
  assert(!!handlers['env:detect'] && !!handlers['update:check'], 'IPC handler 已注册');

  // 1) 激活的是 A,但指明查 B → 查的是 B
  let res = await handlers['env:detect']({}, { mode: 'remote', remoteId: 'B' });
  assert(res.ok && res.env.node.version === 'v22.2.0', 'env:detect 按指明的目标 B 执行(此刻激活的是 A)', res.env.node);
  assert(res.mode === 'remote' && res.remoteId === 'B' && res.identity === '10.0.0.2|2222|bob|', '响应带回 B 的目标标识', res);

  // 2) 指明查本机(此刻是远程模式)→ 查本机
  res = await handlers['env:detect']({}, { mode: 'local' });
  assert(res.ok && res.env.node.version === 'v22.L.0', 'env:detect 按指明的目标「本机」执行', res.env.node);
  assert(res.mode === 'local' && res.remoteId === '' && res.identity === '', '本机响应的目标标识', res);

  // 3) 不指明 → 取当前激活的(A)
  res = await handlers['env:detect']({}, undefined);
  assert(res.ok && res.env.node.version === 'v22.1.0' && res.remoteId === 'A', '不指明目标 → 查当前激活的 A');

  // 4) 目标档案已不存在 → 明确失败,不抛出、不误查别的服务器
  res = await handlers['env:detect']({}, { mode: 'remote', remoteId: 'gone' });
  assert(res.ok === false && !!res.error && res.remoteId === 'gone' && !res.env, '档案已删除:返回失败而不是查到别的服务器', res);

  // 5) update:check 同理
  res = await handlers['update:check']({}, { mode: 'remote', remoteId: 'B' });
  assert(res.ok && res.installed === '0.17.2' && res.latest === '0.18.2' && res.pi.pkg === 'pi-2', 'update:check 按目标 B 执行(已装版本、最新版、pi 包都是 B 的)', res);
  assert(res.remoteId === 'B' && res.identity === '10.0.0.2|2222|bob|', 'update:check 响应带回 B 的目标标识');
  res = await handlers['update:check']({}, { mode: 'local' });
  assert(res.ok && res.installed === '0.17.L' && res.mode === 'local', 'update:check 按目标「本机」执行', res);

  // 6) 最新版查询失败:至少给出该目标的已装版本,并仍带目标标识
  failLatest.add('2');
  res = await handlers['update:check']({}, { mode: 'remote', remoteId: 'B' });
  assert(res.ok === false && res.installed === '0.17.2' && !!res.error && res.remoteId === 'B', '最新版查询失败:保留 B 的已装版本与目标标识', res);

  // 7) 代理按目标:config:get 给出每个目标各自的代理视图;proxy 是当前目标的那份
  let view = await handlers['config:get']({}, undefined);
  assert(view.proxy.primaryUrl === 'socks5://10.1.1.1:1080', 'config:get 的 proxy 是当前目标(激活的 A)的代理', view.proxy);
  assert(view.proxyViews.local.primaryUrl === 'http://10.9.9.9:9', 'config:get:本机的代理视图', view.proxyViews.local);
  const viewB = view.proxyViews.remotes.B;
  assert(viewB.enabled === false && viewB.protocol === 'http' && viewB.host === '10.2.2.2' && viewB.port === 8080, 'config:get:B 的代理视图(与 A、本机各不相同)', viewB);
  assert(view.proxyViews.remotes.A.bypass === '*.a', 'config:get:视图带回原始不代理列表(界面回显用)');

  // 8) 只改 B 的代理(此刻激活的仍是 A)
  view = await handlers['config:set']({}, {
    remotes: view.remotes.map((r) => (r.id === 'B' ? { ...r, proxy: { ...r.proxy, enabled: true, bypass: '*.b' } } : r)),
  });
  assert(view.proxyViews.remotes.B.enabled === true && view.proxyViews.remotes.B.bypass === '*.b', 'config:set:B 的代理已更新', view.proxyViews.remotes.B);
  assert(view.proxyViews.remotes.A.enabled === true && view.proxyViews.remotes.A.bypass === '*.a' && view.proxyViews.local.enabled === true, 'config:set:改 B 不影响 A 与本机');
  assert(view.proxy.primaryUrl === 'socks5://10.1.1.1:1080', 'config:set:返回的 proxy 仍是当前目标 A 的');

  // 9) 只改本机的代理:两台远程不受影响
  view = await handlers['config:set']({}, { proxy: { enabled: false } });
  assert(view.proxyViews.local.enabled === false && view.proxyViews.remotes.A.enabled === true && view.proxyViews.remotes.B.enabled === true, 'config:set:关掉本机的代理,远程不受影响');

  // 10) 切换目标:proxy 视图跟随
  view = await handlers['config:set']({}, { activeRemoteId: 'B' });
  assert(view.proxy.enabled === true && view.proxy.host === '10.2.2.2', 'config:set:切换目标后 proxy 视图跟随到 B', view.proxy);

  // 11) 落盘:每个档案各持一份
  const rawCfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert(rawCfg.remotes[0].proxy.bypass === '*.a' && rawCfg.remotes[1].proxy.bypass === '*.b' && rawCfg.proxy.enabled === false, '落盘:各档案的代理各存各的,顶层 proxy 是本机的');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('IPC 按目标(环境检测 + 代理): 全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('TEST ERR:', e.stack || e.message);
  process.exit(1);
});
