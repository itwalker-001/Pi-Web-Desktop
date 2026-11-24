// 渲染层「按目标」状态自检(离线:假 DOM + 假 piApi,真实加载 renderer/app.js)。本机与每台远程服务器
// 各自维护自己的状态,页面上显示的始终是当前目标自己的那一份:
//   环境检测 —— 各查各的、各存各的。覆盖:A 的检测在途时切到 B(A 的结果晚到不能画到 B 上、B 的检测
//     不能被跳过)、切回 A 立即显示 A 的结果、切到未配置的新档案、检测期间档案改了主机、同一目标两个
//     请求乱序返回、启动期间切走目标。
//   代理 —— 每个目标各一份。覆盖:盾形开关与代理卡跟随当前目标、开关/保存只落在当前目标、
//     未配置地址时拒绝启用、新档案默认不走代理、registry 仍是所有目标共用。
// 运行:node test/renderer-target.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const proxyModule = require(path.join(__dirname, '..', 'lib', 'proxy.js'));

// PI_RENDERER_APP 可指定被测脚本(默认 renderer/app.js),用于对照修复前的版本
const APP = process.env.PI_RENDERER_APP || path.join(__dirname, '..', 'renderer', 'app.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));

let failed = 0;
function check(cond, msg, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}${cond || detail === undefined ? '' : `  [${detail}]`}`);
  if (!cond) failed += 1;
}

/* ---------- 假 DOM:同一个 id 始终返回同一个元素 ---------- */
function makeEl(tag) {
  const classes = new Set();
  return {
    tagName: tag, textContent: '', innerHTML: '', className: '', hidden: false, disabled: false, title: '',
    value: '', style: {}, dataset: {}, children: [], scrollTop: 0, scrollHeight: 0, _classes: classes, _l: {},
    classList: {
      add: (...c) => { for (const x of c) classes.add(x); },
      remove: (...c) => { for (const x of c) classes.delete(x); },
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
    },
    addEventListener(type, cb) { (this._l[type] = this._l[type] || []).push(cb); },
    removeEventListener() {},
    appendChild(c) { this.children.push(c); },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() {},
    setAttribute(k, v) { this[k] = String(v); },
    getAttribute(k) { return this[k] === undefined ? null : this[k]; },
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    reload() {},
  };
}

const profile = (id, host) => ({
  id, host, port: 22, user: `user-${id.toLowerCase()}`, authType: 'key', password: '', keyPath: '',
  remotePort: 30141, hostFingerprint: `fp-${id}`,
  // 每台服务器自己的代理(各不相同,便于辨认串台)
  proxy: { enabled: true, protocol: 'http', host: `10.9.9.${id.charCodeAt(0) - 64}`, port: 10808, bypass: `*.${id.toLowerCase()}.com` },
});
const PROFILES = [profile('A', '10.0.0.1'), profile('B', '10.0.0.2'), profile('C', '10.0.0.3'), profile('D', '10.0.0.4'), profile('E', '10.0.0.5')];
PROFILES[2].proxy.enabled = false; // C 填了地址但没启用
const BASE_CFG = {
  mode: 'local', defaultMode: 'last', defaultRemoteId: '', port: 30141, autoStart: false,
  proxy: { enabled: false, protocol: 'http', host: '', port: 0, bypass: '' }, // 本机的代理:初始为空
  registry: '',
  remotes: PROFILES,
  activeRemoteId: 'A',
};

// 起一个「应用实例」:真实加载 renderer/app.js;piApi 的检测按目标返回带编号的结果(编号 = 主机末段,
// 本机为 L),behavior[kind][目标] 可注入 delay / fail / installed
function boot(cfgOverrides = {}) {
  const els = new Map();
  const document = {
    body: makeEl('body'),
    activeElement: null,
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl('div')); return els.get(id); },
    createElement: (tag) => makeEl(tag),
    querySelector: () => makeEl('div'),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const cfg = { ...clone(BASE_CFG), ...clone(cfgOverrides) };
  const behavior = { detect: {}, check: {} };
  const calls = []; // [kind, 目标]:每次检测实际查了谁
  const starts = []; // 自启时启动了谁的服务
  let inflight = 0;

  const identityOf = (t) => {
    if (t.mode !== 'remote') return '';
    const r = cfg.remotes.find((x) => x.id === t.remoteId);
    return r ? `${r.host}|${r.port}|${r.user}|${r.keyPath}` : '';
  };
  const respond = async (kind, t) => {
    const key = t.mode === 'remote' ? t.remoteId : 'local';
    const identity = identityOf(t); // 与主进程一致:目标标识在请求发起时定格
    const r = cfg.remotes.find((x) => x.id === t.remoteId);
    const n = t.mode === 'remote' ? (r && r.host ? r.host.split('.').pop() : '0') : 'L';
    const b = behavior[kind][key] || {};
    calls.push([kind, key]);
    inflight += 1;
    try {
      if (b.delay) await sleep(b.delay);
      const tag = { mode: t.mode, remoteId: t.mode === 'remote' ? key : '', identity };
      if (b.fail) return { ok: false, error: `连不上 ${key}`, ...tag };
      if (kind === 'detect') {
        const item = (v) => ({ version: v, ok: true, error: null });
        return { ok: true, env: { node: item(`22.${n}.0`), npm: item(`10.${n}.0`), pi: item(`1.${n}.0`), piWeb: item(`0.17.${n}`) }, appVersion: '9.9.9', ...tag };
      }
      return {
        ok: true, installed: b.installed || `0.17.${n}`, latest: `0.18.${n}`, outdated: false,
        pi: { resolved: true, pkg: `pi-${n}`, installed: `1.${n}.0`, latest: `1.${n}.0`, outdated: false },
        ...tag,
      };
    } finally {
      inflight -= 1;
    }
  };

  // 与主进程返回给渲染层的配置同构:每个目标各自的代理视图(proxyViews)+ 当前目标的 proxy
  const withViews = (c) => {
    const remotes = {};
    for (const r of c.remotes || []) remotes[r.id] = proxyModule.parseProxy({ ...c, mode: 'remote', remote: r });
    const local = proxyModule.parseProxy({ ...c, mode: 'local' });
    const active = (c.remotes || []).find((x) => x.id === c.activeRemoteId) || null;
    const proxy = c.mode === 'remote' && active ? remotes[active.id] : local;
    return { ...clone(c), remote: active ? clone(active) : null, proxy, proxyViews: { local, remotes } };
  };

  const sandbox = {
    console, document, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => { throw new Error('offline'); },
    AbortSignal, URL,
    confirm: () => true,
    location: { href: 'file:///C:/app/renderer/index.html' },
    piApi: {
      getConfig: async () => withViews(cfg),
      setConfig: async (patch) => {
        const p = clone(patch);
        if (p.proxy) p.proxy = { ...cfg.proxy, ...p.proxy }; // 与主进程一致:顶层 proxy 与已存的合并
        Object.assign(cfg, p);
        return withViews(cfg);
      },
      detectEnv: (t) => respond('detect', t || { mode: cfg.mode, remoteId: cfg.activeRemoteId }),
      checkUpdate: (t) => respond('check', t || { mode: cfg.mode, remoteId: cfg.activeRemoteId }),
      serverState: async () => ({ running: false, owned: true, external: false, url: '' }),
      serverStart: async () => { starts.push(cfg.activeRemoteId || 'local'); return { ok: true, url: 'http://started/' }; },
      serverStop: async () => ({ ok: true, stopped: true }),
      runUpdate: async () => ({ ok: false, error: '(测试中不执行更新)' }),
      onUpdateLog() {}, onServerLog() {}, onServerExited() {}, onServerStarted() {}, onPasteResult() {},
    },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP, 'utf8'), ctx, { filename: 'renderer/app.js' });

  // 等到没有在途请求并静默 quietMs(覆盖 init / switchTarget 这类内部串行 await 的流程)
  const settle = async (quietMs = 30) => {
    let quiet = 0;
    for (let i = 0; i < 400 && quiet < quietMs; i++) {
      await sleep(5);
      quiet = inflight === 0 ? quiet + 5 : 0;
    }
  };
  return {
    ctx, cfg, behavior, calls, starts, document, settle,
    S: (expr) => vm.runInContext(expr, ctx),
    el: (id) => document.getElementById(id),
  };
}

const ENVS = ['env-node', 'env-npm', 'env-pi', 'env-piweb'];
const cells = (app) => ENVS.map((id) => app.el(id).textContent);
const detectCalls = (app, key) => app.calls.filter(([k, x]) => k === 'detect' && x === key).length;

(async () => {
  const app = boot();
  await app.settle();

  // T1) 启动:本机检测结果
  check(app.el('env-node').textContent === 'v22.L.0' && app.el('appVersion').textContent === 'v9.9.9', 'T1 启动后显示本机的检测结果', cells(app));

  // T2) 各查各的:切到 A 显示 A 的,切到 B 显示 B 的
  await app.S('switchTarget')('A');
  check(app.el('env-node').textContent === 'v22.1.0' && app.el('env-piweb').textContent === 'v0.17.1' && app.el('envScope').textContent === '· 远程 10.0.0.1', 'T2 切到 A:四项都是 A 的', cells(app));
  await app.S('switchTarget')('B');
  check(app.el('env-node').textContent === 'v22.2.0' && app.el('env-piweb').textContent === 'v0.17.2' && app.el('envScope').textContent === '· 远程 10.0.0.2', 'T2 切到 B:四项都是 B 的(不是先检测的 A 的)', cells(app));
  check(detectCalls(app, 'A') === 1 && detectCalls(app, 'B') === 1 && detectCalls(app, 'local') === 1, 'T2 每个目标各发起了自己的检测', JSON.stringify(app.calls));
  await app.S('switchTarget')('local');
  check(app.el('env-node').textContent === 'v22.L.0', 'T2 切回本机:显示本机的(不是远程的)', cells(app));

  // T3) 切回已检测过的 A:立即显示 A 自己的上次结果,后台刷新期间不闪「检测中…」
  app.behavior.detect.A = { delay: 80 };
  const backToA = app.S('switchTarget')('A');
  await sleep(15);
  check(cells(app).every((c) => !/检测中|—/.test(c)) && app.el('env-node').textContent === 'v22.1.0', 'T3 切回 A:刷新在途时仍显示 A 的上次结果', cells(app));
  await backToA;
  check(app.el('env-node').textContent === 'v22.1.0', 'T3 切回 A:刷新完成后还是 A 的结果', cells(app));

  // T4) C 的检测在途时切到 D(都没有缓存):D 的检测不能被跳过;C 的结果晚到不能画到 D 的页面上
  app.behavior.detect.C = { delay: 160 };
  app.behavior.detect.D = { delay: 10 };
  const pC = app.S('switchTarget')('C');
  await sleep(20);
  check(cells(app).every((c) => c === '检测中…') && app.el('envScope').textContent === '· 远程 10.0.0.3', 'T4 切到 C:检测中', cells(app));
  const pD = app.S('switchTarget')('D');
  await sleep(5);
  check(detectCalls(app, 'D') === 1, 'T4 切到 D:D 的检测立即发起,没有被 C 的在途检测挡住');
  await pD;
  check(app.el('env-node').textContent === 'v22.4.0' && app.el('envScope').textContent === '· 远程 10.0.0.4', 'T4 D 的检测完成:显示 D 的结果', cells(app));
  await pC; // C 的响应此时才到
  check(app.el('env-node').textContent === 'v22.4.0' && app.el('env-piweb').textContent === 'v0.17.4', 'T4 C 的结果晚到:页面仍是 D 的,没有被 C 覆盖', cells(app));
  check(app.S('state').envs.remotes.C.env.node.version === '22.3.0', 'T4 C 的结果归档在 C 名下(切回去就能直接看到)');

  // T5) 切到未配置的新档案:显示「—」,不沿用 D 的数值
  app.S('addRemote')();
  await app.settle();
  check(cells(app).every((c) => c === '—') && app.el('envScope').textContent === '· 远程 ', 'T5 新增未配置档案:四项显示「—」(不是上一台的版本)', cells(app));
  const backToD = app.S('switchTarget')('D');
  await sleep(15);
  check(app.el('env-node').textContent === 'v22.4.0', 'T5 再切回 D:立即显示 D 的结果', cells(app));
  await backToD;

  // T6) 检测在途时档案被改成另一台服务器:旧服务器的结果作废,最终显示新服务器的
  app.behavior.detect.E = { delay: 150 };
  const pE = app.S('switchTarget')('E');
  await sleep(15);
  app.el('remoteHostInput').value = '10.0.0.6';
  const pSave = app.S('saveCurrentRemote')();
  await pE; // 旧主机(.5)的响应此时到达
  check(cells(app).every((c) => c !== 'v22.5.0'), 'T6 档案已改主机:旧服务器的结果没有被画出来', cells(app));
  await pSave;
  await app.settle();
  check(app.el('env-node').textContent === 'v22.6.0' && app.S('state').envs.remotes.E.env.node.version === '22.6.0', 'T6 最终显示并归档的是新服务器(.6)的结果', cells(app));

  // T7) 同一目标先后两个版本检测乱序返回:只有最后一个请求的结果被采用
  app.behavior.check.E = { delay: 120, installed: '0.0.1' };
  const slow = app.S('checkUpdate')({ silent: true, fresh: true });
  app.behavior.check.E = { delay: 0, installed: '0.9.9' };
  await app.S('checkUpdate')({ silent: true, fresh: true });
  check(app.el('env-piweb').textContent === 'v0.9.9', 'T7 后发的请求先到:显示它的结果', app.el('env-piweb').textContent);
  await slow;
  check(app.el('env-piweb').textContent === 'v0.9.9' && app.S('state').envs.remotes.E.update.installed === '0.9.9', 'T7 先发的请求后到:被丢弃,不覆盖新结果');
  app.behavior.check.E = { delay: 40 };
  const before = app.calls.length;
  const [q1, q2] = [app.S('checkUpdate')({ silent: true }), app.S('checkUpdate')({ silent: true })];
  await Promise.all([q1, q2]);
  check(app.calls.length === before + 1, 'T7 同一目标的并发版本检测合并为一次请求');

  // T8) 启动期间切走目标:页面与自启都以切换后的目标为准,不被启动目标的结果污染
  const boot2 = boot({ mode: 'remote', activeRemoteId: 'A', autoStart: true });
  boot2.behavior.detect.A = { delay: 150 };
  boot2.behavior.detect.B = { delay: 10 };
  const pB = boot2.S('switchTarget')('B');
  await sleep(40);
  check(cells(boot2).every((c) => c !== 'v22.1.0'), 'T8 启动检测在途时切到 B:页面上没有出现 A 的结果', cells(boot2));
  await pB;
  await boot2.settle(60);
  check(boot2.el('env-node').textContent === 'v22.2.0' && boot2.el('envScope').textContent === '· 远程 10.0.0.2', 'T8 最终显示 B 的结果(A 的晚到响应没有覆盖)', cells(boot2));
  check(JSON.stringify(boot2.starts) === JSON.stringify(['B']), 'T8 自启作用在切换后的当前目标 B 上(且只启了一次)', JSON.stringify(boot2.starts));

  /* ---------- 代理:每个目标各一份 ---------- */
  const shield = () => app.el('proxyToggleBtn')._classes.has('on');
  const proxyForm = () => ['proxyProtoSelect', 'proxyHostInput', 'proxyPortInput', 'proxyBypassInput'].map((id) => app.el(id).value);
  const storedProxy = (id) => (id === 'local' ? app.cfg.proxy : (app.cfg.remotes.find((x) => x.id === id) || {}).proxy);
  const lastToast = () => app.el('toastWrap').children.slice(-1)[0].textContent;
  const setProxyForm = (proto, host, port, bypass) => {
    app.el('proxyProtoSelect').value = proto;
    app.el('proxyHostInput').value = host;
    app.el('proxyPortInput').value = port;
    app.el('proxyBypassInput').value = bypass;
  };

  // T9a) 代理卡与盾形开关显示当前目标自己的代理
  await app.S('switchTarget')('E');
  check(proxyForm().join('|') === 'http|10.9.9.5|10808|*.e.com' && app.el('proxyScope').textContent === '· 远程 10.0.0.6', 'T9a 代理卡显示当前服务器 E 自己的代理', proxyForm().join('|'));
  check(shield() === true && /远程 10\.0\.0\.6 .*代理已启用:http:\/\/10\.9\.9\.5:10808/.test(app.el('proxyToggleBtn').title), 'T9a 盾形开关:E 已启用', app.el('proxyToggleBtn').title);

  // T9b) 点盾形开关:只改当前这一台
  await app.S('toggleProxy')();
  check(storedProxy('E').enabled === false && storedProxy('B').enabled === true && storedProxy('A').host === '10.9.9.1', 'T9b 关掉 E 的代理:A、B 不受影响');
  check(shield() === false && lastToast() === '远程 10.0.0.6 代理已关闭', 'T9b 盾形开关熄灭,提示点明是哪一台', lastToast());

  // T9c) C 填了地址但没启用:切过去是熄灭的;点一下只启用 C
  await app.S('switchTarget')('C');
  check(shield() === false && proxyForm()[1] === '10.9.9.3', 'T9c 切到未启用的 C:开关熄灭,代理卡是 C 的地址', proxyForm().join('|'));
  await app.S('toggleProxy')();
  check(storedProxy('C').enabled === true && storedProxy('E').enabled === false && shield() === true, 'T9c 启用 C:E 仍是关的');
  await app.S('switchTarget')('E');
  check(shield() === false, 'T9c 再切回 E:开关跟随 E(仍是关的)');

  // T9d) 代理卡保存:只写进当前这一台;registry 仍是所有目标共用
  await app.S('switchTarget')('C');
  setProxyForm('socks5', '10.7.7.7', 1080, '*.new.com\n10.0.0.0/8');
  app.el('registryInput').value = 'https://registry.npmmirror.com';
  await app.S('saveConfig')();
  const cProxy = storedProxy('C');
  check(cProxy.protocol === 'socks5' && cProxy.host === '10.7.7.7' && cProxy.port === 1080 && cProxy.enabled === true && cProxy.bypass === '*.new.com\n10.0.0.0/8', 'T9d 保存:协议/地址/不代理列表写进 C(启用状态保留)', JSON.stringify(cProxy));
  check(storedProxy('D').host === '10.9.9.4' && storedProxy('D').protocol === 'http', 'T9d 保存:D 的代理原样不动');
  check(app.cfg.registry === 'https://registry.npmmirror.com', 'T9d npm Registry 是所有目标共用的');
  check(app.el('proxyToggleBtn').title.includes('socks5://10.7.7.7:1080'), 'T9d 盾形开关提示用上新地址', app.el('proxyToggleBtn').title);

  // T9e) 切换目标:代理卡换成该目标的;未保存的编辑随之丢弃
  setProxyForm('http', '99.99.99.99', 1, '');
  await app.S('switchTarget')('D');
  check(proxyForm().join('|') === 'http|10.9.9.4|10808|*.d.com', 'T9e 切到 D:代理卡是 D 的(上一台未保存的编辑不带走)', proxyForm().join('|'));
  await app.S('switchTarget')('C');
  check(proxyForm().join('|') === 'socks5|10.7.7.7|1080|*.new.com\n10.0.0.0/8', 'T9e 切回 C:显示的是 C 刚保存的那份', proxyForm().join('|'));

  // T9f) 本机:没有地址时拒绝启用;填了再保存 → 只影响本机
  await app.S('switchTarget')('local');
  const localBefore = JSON.stringify(storedProxy('local'));
  check(app.el('proxyScope').textContent === '· 本机' && shield() === false, 'T9f 切到本机:标题「· 本机」,开关熄灭');
  await app.S('toggleProxy')();
  check(lastToast() === '请先在代理设置中填写该目标的代理服务器与端口' && JSON.stringify(storedProxy('local')) === localBefore, 'T9f 本机没有代理地址:拒绝启用、不写配置', lastToast());
  app.el('proxyHostInput').value = '127.0.0.1';
  await app.S('saveConfig')();
  check(lastToast() === '代理服务器与端口需同时填写', 'T9f 只填主机不填端口:校验拦截', lastToast());
  setProxyForm('http', '127.0.0.1', 7897, '');
  await app.S('saveConfig')();
  check(storedProxy('local').host === '127.0.0.1' && storedProxy('local').port === 7897 && shield() === false, 'T9f 本机保存了地址;保存本身不改变启用状态(启用靠盾形开关)');
  await app.S('toggleProxy')();
  check(shield() === true && lastToast() === '本机 代理已启用', 'T9f 点盾形开关后本机代理启用', lastToast());
  check(storedProxy('C').host === '10.7.7.7' && storedProxy('B').enabled === true, 'T9f 本机的改动不影响任何一台远程');
  check(app.el('proxyToggleBtn').title.startsWith('本机 代理已启用:http://127.0.0.1:7897'), 'T9f 盾形开关提示点明「本机」与地址', app.el('proxyToggleBtn').title);

  // T9g) 新增服务器:默认不走代理(在远程模式下新增,新档案成为当前目标)
  await app.S('switchTarget')('B');
  app.S('addRemote')();
  await app.settle();
  const added = app.cfg.remotes[app.cfg.remotes.length - 1];
  check(added.proxy && added.proxy.enabled === false && added.proxy.host === '', 'T9g 新增的服务器默认不带代理', JSON.stringify(added.proxy));
  check(shield() === false && proxyForm()[1] === '' && app.el('proxyScope').textContent === '· 远程 ', 'T9g 盾形开关熄灭、代理卡为空', `${shield()}|${proxyForm().join('|')}`);

  console.log(failed ? `\n${failed} 项失败` : '\n渲染层按目标状态(环境检测 + 代理): 全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('TEST ERR:', e.stack || e.message);
  process.exit(1);
});
