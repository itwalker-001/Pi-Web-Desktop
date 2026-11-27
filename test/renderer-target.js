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
// 模拟浏览器往 xterm 的输入框派发一次按键。真实 xterm 6 调用完自定义处理器,不管它返回 true / false,
// 都不会替它阻止浏览器的默认动作;只要事件没被 preventDefault,浏览器就照常执行 ——
// Ctrl+V / Ctrl+Shift+V 的默认动作是原生 paste(xterm 自己的监听器把系统剪贴板里的文本粘进终端)。
// 2026-11-26 踩过:应用接管了 Ctrl+V 却没阻止默认动作,结果同一段文本粘了两份
function pressKey(t, init, clipText = '') {
  const ev = {
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    ...init,
  };
  const handled = t.keyHandler(ev);
  const pasteCombo = (ev.ctrlKey || ev.metaKey) && !ev.altKey && String(ev.key).toLowerCase() === 'v';
  if (!ev.prevented && ev.type === 'keydown' && pasteCombo && clipText) t.paste(clipText); // 浏览器派发的原生 paste 事件
  return { handled, ev };
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
    removeEventListener(type, cb) { this._l[type] = (this._l[type] || []).filter((fn) => fn !== cb); },
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
    // <webview> 的方法:在服务页里执行脚本。测试里用 _exec 模拟页面的返回
    executeJavaScript(code) { return this._exec ? this._exec(code) : Promise.reject(new Error('guest not ready')); },
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
function boot(cfgOverrides = {}, { wco = false } = {}) {
  const els = new Map();
  const document = {
    body: makeEl('body'),
    activeElement: null,
    _l: {},
    getElementById(id) {
      if (!els.has(id)) {
        const el = makeEl('div');
        el.focus = () => { document.activeElement = el; };
        els.set(id, el);
      }
      return els.get(id);
    },
    createElement: (tag) => makeEl(tag),
    querySelector: () => makeEl('div'),
    querySelectorAll: () => [],
    addEventListener(type, cb) { (this._l[type] = this._l[type] || []).push(cb); },
    removeEventListener(type, cb) { this._l[type] = (this._l[type] || []).filter((fn) => fn !== cb); },
  };
  // 与 index.html 初始一致:两个全屏视图默认隐藏(假 DOM 的 hidden 默认是 false,需显式种子)
  document.getElementById('webView').hidden = true;
  document.getElementById('termView').hidden = true;
  document.getElementById('confirmModal').hidden = true;
  const cfg = { ...clone(BASE_CFG), ...clone(cfgOverrides) };
  const behavior = { detect: {}, check: {} };
  const calls = []; // [kind, 目标]:每次检测实际查了谁
  const starts = []; // 自启时启动了谁的服务
  const editorOpens = []; // 传给主进程 editor:open 的项目目录
  const hooks = {}; // 渲染层注册的事件回调(测试里用来触发)
  // code-server:主进程返回的替身。reply 是 editor:open 的返回;needInstall / password / error 都靠替换它来模拟
  const editor = {
    reply: async () => ({ ok: true, url: 'http://127.0.0.1:8080/?folder=x' }),
    confirm: { confirmed: false }, // 安装确认框的回答
    confirmReply: null, // 设为 Error 可模拟确认框调用失败
    installReply: { ok: true, version: '4.146.0' },
    confirms: 0,
    installs: 0,
    copied: [], // 传给复制接口的文本
    copyOk: true,
  };
  const timers = []; // setTimeout 的时长参数(验证提示停留多久)
  const warns = []; // console.warn(增强项加载失败时的原因)
  let inflight = 0;

  // code-server 配置卡的桩:reply 是 csState 的返回(默认已安装、未运行、托管)
  const cs = {
    reply: {
      ok: true, local: false, managed: true, running: false, owned: false, base: 'http://10.0.0.1:8080', port: 8080,
      info: { installed: true, bin: '/home/u/.pi-web-desktop/code-server/bin/code-server', version: '4.146.0', bindPort: '8080', auth: 'password', password: 'pw-old', configured: true, appPort: '' },
    },
    saveReply: null, startReply: null, stopReply: null, confirmReply: null, openReply: null,
  };
  const csCalls = { state: [], save: [], start: [], stop: [] };

  // SSH 终端:xterm 替身 + term:* 调用记录(验证渲染层发起的真实调用形态)
  const terminals = []; // startTermSession 创建的 FakeTerminal
  const termCalls = []; // 渲染层发起的 term:*
  const term = { pasteReply: { ok: true, type: 'text', text: '' }, startReply: null, ctorThrows: false }; // termPaste / termStart 的应答;ctorThrows 让 xterm 构造失败
  const openedLinks = []; // 交给系统浏览器打开的地址
  const clipWrites = []; // 经 OSC 52 写进系统剪贴板的文本
  // xterm addon 替身:每个实例都记进 addons.created;addons.webglThrows 模拟拿不到 WebGL 上下文;
  // addons.fail = 某个 kind 时,该 addon 在 activate 时抛错
  const addons = { created: [], webglThrows: false, fail: '' };
  class FakeAddon {
    constructor(kind) { this.kind = kind; this.disposed = false; addons.created.push(this); }
    activate() {
      if (addons.fail === this.kind) throw new Error(`boom ${this.kind}`);
    }
    dispose() { this.disposed = true; }
  }
  class FakeTerminal {
    constructor(opts) {
      if (term.ctorThrows) throw new Error('xterm boom'); // 模拟 xterm 自身初始化失败
      this.opts = opts;
      this.options = { theme: opts && opts.theme }; // xterm 支持运行时改主题
      this.unicode = { activeVersion: '6' }; // 真实 xterm 默认是 6 版宽度表
      this.cols = 80;
      this.rows = 24;
      this.display = '';
      this.pasted = [];
      this.addons = [];
      this.disposed = false;
      terminals.push(this);
    }
    // 与真实 xterm 一致:loadAddon 时激活;paste 最终也走 onData(程序开着括号粘贴模式时内容外面包一层标记)
    loadAddon(a) { this.addons.push(a); if (a.activate) a.activate(this); }
    // OSC 处理器登记处(真实 xterm 的 term.parser.registerOscHandler);测试里直接调用 osc[52] 模拟远端发来的序列
    parser = { osc: {}, registerOscHandler(code, cb) { this.osc[code] = cb; return { dispose() {} }; } };
    open() {}
    focus() {}
    write(s) { this.display += s; }
    paste(s) { this.pasted.push(s); if (this.dataCb) this.dataCb(s); }
    dispose() { this.disposed = true; }
    onData(cb) { this.dataCb = cb; }
    attachCustomKeyEventHandler(cb) { this.keyHandler = cb; }
  }
  const FitAddonStub = { FitAddon: class { activate() {} fit() {} dispose() {} } };
  const Unicode11AddonStub = { Unicode11Addon: class extends FakeAddon { constructor() { super('unicode11'); } } };
  const WebLinksAddonStub = { WebLinksAddon: class extends FakeAddon { constructor(handler) { super('web-links'); this.handler = handler; } } };
  const WebglAddonStub = {
    WebglAddon: class extends FakeAddon {
      constructor() {
        super('webgl');
        if (addons.webglThrows) throw new Error('WebGL2 not supported null'); // 真实 addon 拿不到上下文时就这样抛
      }
      onContextLoss(cb) { this.lossCb = cb; }
    },
  };

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
    console: Object.assign({}, console, { warn: (...a) => warns.push(a.map((x) => String((x && x.message) || x)).join(' ')) }), // warn 记下来断言,不刷屏
    document, setTimeout: (...a) => { timers.push(a[1]); return setTimeout(...a); }, clearTimeout, setInterval, clearInterval,
    fetch: async () => { throw new Error('offline'); },
    AbortSignal, URL, URLSearchParams, TextDecoder, atob, btoa,
    confirm: () => true,
    location: { href: 'file:///C:/app/renderer/index.html', search: wco ? '?wco=1' : '' }, // 无边框窗口:主进程把决定随地址带来
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    ResizeObserver: class { observe() {} disconnect() {} },
    Terminal: FakeTerminal,
    FitAddon: FitAddonStub,
    Unicode11Addon: Unicode11AddonStub,
    WebLinksAddon: WebLinksAddonStub,
    WebglAddon: WebglAddonStub,
    piApi: {
      getConfig: async () => withViews(cfg),
      setConfig: async (patch) => {
        const p = clone(patch);
        if (p.proxy) p.proxy = { ...cfg.proxy, ...p.proxy }; // 与主进程一致:顶层 proxy 与已存的合并
        Object.assign(cfg, p);
        return withViews(cfg);
      },
      openExternal: async (url) => { openedLinks.push(url); return { ok: true }; },
      detectEnv: (t) => respond('detect', t || { mode: cfg.mode, remoteId: cfg.activeRemoteId }),
      checkUpdate: (t) => respond('check', t || { mode: cfg.mode, remoteId: cfg.activeRemoteId }),
      serverState: async () => ({ running: !!behavior.serverUrl, owned: true, external: false, url: behavior.serverUrl || '' }),
      serverStart: async () => { starts.push(cfg.activeRemoteId || 'local'); return { ok: true, url: 'http://started/' }; },
      serverStop: async () => ({ ok: true, stopped: true }),
      openInEditor: async (dir) => { editorOpens.push(dir); return editor.reply(dir); },
      confirmInstallCodeServer: async (arg) => { editor.confirms += 1; editor.confirmArg = arg; return editor.confirmReply instanceof Error ? Promise.reject(editor.confirmReply) : editor.confirm; },
      installCodeServer: async () => { editor.installs += 1; return editor.installReply; },
      copyText: async (text) => { editor.copied.push(text); return { ok: editor.copyOk }; },
      setClipboardText: async (text) => { clipWrites.push(text); return { ok: true }; },
      runUpdate: async () => ({ ok: false, error: '(测试中不执行更新)' }),
      termStart: async (arg) => {
        termCalls.push({ api: 'start', arg });
        // startReply 可带会话事实(proxy / proxyError / tmux / tmuxVersion),与主进程 term:start 的返回同构
        return clone(term.startReply || { ok: true, id: 't-1', mode: 'remote', remoteId: (arg && arg.target && arg.target.remoteId) || '' });
      },
      termWrite: async (arg) => { termCalls.push({ api: 'write', arg }); return { ok: true }; },
      termResize: async (arg) => { termCalls.push({ api: 'resize', arg }); return { ok: true }; },
      termStop: async (arg) => { termCalls.push({ api: 'stop', arg }); return { ok: true }; },
      termPaste: async (arg) => { termCalls.push({ api: 'paste', arg }); return clone(term.pasteReply); },
      // code-server 配置卡:reply 可整体替换;默认 = 已安装未运行的托管实例
      csState: async (t) => { csCalls.state.push(t || { mode: cfg.mode, remoteId: cfg.activeRemoteId }); return clone(cs.reply); },
      csSave: async (arg) => { csCalls.save.push(clone(arg)); return clone(cs.saveReply || { ok: true, conf: { bindPort: String((arg && arg.port) || 8080), auth: 'password', password: (arg && arg.password) || '' } }); },
      csStart: async (t) => { csCalls.start.push(t); return clone(cs.startReply || { ok: true, url: 'http://10.0.0.1:8080' }); },
      csStop: async (arg) => { csCalls.stop.push(clone(arg)); return clone(cs.stopReply || { ok: true, ours: 1 }); },
      csConfirmForceStop: async () => clone(cs.confirmReply || { confirmed: false }),
      csOpen: async () => clone(cs.openReply || { ok: true, url: 'http://10.0.0.1:8080' }),
      onUpdateLog(cb) { hooks.updateLog = cb; }, onCodeServerPassword(cb) { hooks.codeServerPassword = cb; }, onServerLog() {}, onServerExited(cb) { hooks.serverExited = cb; },
      onServerStarted(cb) { hooks.serverStarted = cb; }, onPasteResult() {},
      onTermData(cb) { hooks.termData = cb; }, onTermExit(cb) { hooks.termExit = cb; },
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
    ctx, cfg, behavior, calls, starts, editorOpens, editor, timers, hooks, document, settle, termCalls, terminals, term, cs, csCalls,
    openedLinks, addons, warns, clipWrites,
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

  /* ---------- 在 code-server 中打开当前项目 ---------- */
  const S = app.S;
  // 与真实 pi-web 侧边栏同形的迷你 DOM:项目行带 data-row-key="group:<目录>",当前项目行带 is-current,
  // 展开着的项目组其开关带 aria-expanded="true",会话行里的链接是 ?session=<id>
  const node = (attrs = {}, parent = null) => ({
    attrs,
    parent,
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    closest(sel) {
      for (let e = this; e; e = e.parent) if (sel === '[data-row-key]' && 'data-row-key' in e.attrs) return e;
      return null;
    },
  });
  const dom = (bySelector) => ({ querySelector: (sel) => (sel in bySelector ? bySelector[sel] : null) });
  const GROUP_CUR = '.session-tree-group.is-current';
  const GROUP_OPEN = '.session-tree-group [aria-expanded="true"]';
  const SESSION_CUR = '.session-tree-session.is-current a[href*="session="], .session-tree-session[aria-current] a[href*="session="]';
  const runIn = (code, bySelector) => new Function('document', 'location', `"use strict"; return (${code});`)(dom(bySelector), { href: 'http://10.0.0.2:30141/' });

  const DIR_SCRIPT = S('PROJECT_DIR_SCRIPT');
  check(runIn(DIR_SCRIPT, { [GROUP_CUR]: node({}, node({ 'data-row-key': 'group:/home/walker/proj-a' })) }) === '/home/walker/proj-a', 'T10a 识别①:当前项目行(is-current)的 data-row-key 就是项目目录');
  check(runIn(DIR_SCRIPT, { [GROUP_CUR]: node({}, node({ 'data-row-key': 'session:group:xyz' })), [GROUP_OPEN]: node({}, node({ 'data-row-key': 'group:/home/walker/proj-b' })) }) === '/home/walker/proj-b', 'T10b 识别②:当前行不是项目时,退到展开着的项目组');
  check(runIn(DIR_SCRIPT, { [GROUP_OPEN]: node({}, node({ 'data-row-key': 'group:/srv/团队 仓库/x' })) }) === '/srv/团队 仓库/x', 'T10c 目录含空格/中文原样返回');
  check(runIn(DIR_SCRIPT, { [GROUP_CUR]: node({}, node({})), [GROUP_OPEN]: node({}, null) }) === '', 'T10d 行上没有 data-row-key 时返回空(不乱猜)');

  const sessionLink = node({ href: '?session=01ab-cd' }, node({ 'data-row-key': 'session:group:01ab-cd' }));
  check(runIn(S('CURRENT_SESSION_ID_SCRIPT'), { [SESSION_CUR]: sessionLink }) === '01ab-cd', 'T10e 识别③:从当前会话链接取出会话 id');
  check(runIn(S('CURRENT_SESSION_ID_SCRIPT'), {}) === '', 'T10f 识别③:没有当前会话链接时返回空');
  const cwdScript = S('sessionCwdScript')('01ab-cd');
  check(cwdScript.includes("fetch('/api/sessions'") && cwdScript.includes('s.id === "01ab-cd"') && cwdScript.includes('.cwd'), 'T10g 识别③:按会话 id 到会话列表接口里取 cwd');

  const wv = app.el('wv');
  let execCalls = 0;
  const setPage = ({ primary = '', sessionId = '', apiCwd = '', reject = false } = {}) => {
    wv._exec = async (code) => {
      execCalls += 1;
      if (reject) throw new Error('guest not ready');
      if (code === DIR_SCRIPT) return primary;
      if (code === S('CURRENT_SESSION_ID_SCRIPT')) return sessionId;
      if (code.startsWith("fetch('/api/sessions'")) return apiCwd;
      throw new Error('unexpected script: ' + code.slice(0, 40));
    };
  };
  const editorOpens = app.editorOpens;
  const opened = () => editorOpens.length;
  // 当前目标的服务状态(走与 startServer 相同的 setServer 路径写入)
  const setRunning = (on) => S(`setServer({ running: ${on}, owned: true, external: false, url: 'http://10.0.0.2:30141/' })`);
  setRunning(false);
  setPage({ primary: '/x' });
  let n = opened();
  await S('openCurrentProjectInEditor')();
  check(editorOpens.length === n && execCalls === 0 && lastToast() === '服务未运行,请先启动服务', 'T10h 服务未运行:提示,不去读页面', lastToast());

  setRunning(true);
  setPage({ primary: '/home/walker/proj-a' });
  n = opened();
  await S('openCurrentProjectInEditor')();
  check(editorOpens.length === n + 1 && editorOpens[n] === '/home/walker/proj-a', 'T10i 识别到当前项目 → 把目录交给主进程打开', JSON.stringify(editorOpens.slice(n)));
  check(lastToast().includes('正在用 code-server 打开 /home/walker/proj-a'), 'T10i 提示正在打开哪个目录', lastToast());

  setPage({ sessionId: '01ab-cd', apiCwd: '/home/walker/from-api' });
  n = opened();
  await S('openCurrentProjectInEditor')();
  check(editorOpens[n] === '/home/walker/from-api', 'T10j 识别①②落空 → 走会话接口拿到目录');

  setPage({ reject: true });
  n = opened();
  await S('openCurrentProjectInEditor')();
  check(editorOpens.length === n && lastToast() === '没能从服务页识别出当前项目,请先在 Pi Web 中打开一个项目', 'T10k 服务页还没加载好/不是 Pi Web:如实提示,不打开', lastToast());

  app.editor.reply = async () => ({ ok: false, error: '远程 10.0.0.9 上没有找到 code-server(未安装,或不在该用户的 PATH 里);也可以在服务器配置里填写 code-server 地址' });
  setPage({ primary: '/home/walker/proj-a' });
  await S('openCurrentProjectInEditor')();
  check(lastToast() === '无法用 code-server 打开:远程 10.0.0.9 上没有找到 code-server(未安装,或不在该用户的 PATH 里);也可以在服务器配置里填写 code-server 地址', 'T10l 主进程解析地址失败:原样转达原因', lastToast());
  app.editor.reply = async () => ({ ok: true, url: 'http://10.0.0.2:8080/?folder=x' });

  const clickHandlers = (app.el('openEditorBtn')._l.click || []);
  check(clickHandlers.length === 1 && clickHandlers[0] === S('openCurrentProjectInEditor'), 'T10m 服务页顶栏按钮已绑定(「新窗口」按钮已下掉,只剩编辑器按钮)');
  n = opened();
  await clickHandlers[0]();
  check(editorOpens.length === n + 1, 'T10m 点按钮即打开当前项目');

  // code-server 地址:已从远程弹窗挪到「Code Server 配置卡」,按目标读写(用独立本机实例验证)
  const appCs = boot();
  await appCs.settle();
  const csToasts = () => appCs.el('toastWrap').children.map((c) => c.textContent);
  const csLastToast = () => csToasts().slice(-1)[0] || '';
  check(!('codeServerUrl' in appCs.S('readRemoteForm')()), 'T10n 远程弹窗表单不再携带 code-server 地址');
  appCs.el('codeServerUrlInput').value = 'http://10.9.9.9:9000';
  appCs.el('csSaveBtn')._l.click[0]();
  await appCs.settle();
  check(appCs.S('state').cfg.codeServerUrl === 'http://10.9.9.9:9000', 'T10q 配置卡保存:地址写进当前目标的配置');
  appCs.el('codeServerUrlInput').value = 'ftp://x';
  appCs.el('csSaveBtn')._l.click[0]();
  await appCs.settle();
  check(csLastToast() === 'code-server 地址需形如 http://主机:端口' && appCs.S('state').cfg.codeServerUrl === 'http://10.9.9.9:9000', 'T10o 地址格式不对:校验拦截,不覆盖已存地址', csLastToast());
  for (const u of ['10.9.9.9:9000', 'https://code.example.com/vscode/']) {
    appCs.el('codeServerUrlInput').value = u;
    appCs.el('csSaveBtn')._l.click[0]();
    await appCs.settle();
  }
  check(appCs.S('state').cfg.codeServerUrl === 'https://code.example.com/vscode/', 'T10p 省略协议 / 带子路径:均可保存');

  /* ---------- 多台服务同时运行(「另有 N 个在运行」)---------- */
  // 全新的实例。此前 otherRunningCount 把计数器写成了 const:另一台服务在运行时 renderServer() 抛异常,
  // 切换目标后的环境检测等刷新全部中断 —— 页面停在上一台的结果上(像「检测没按服务器逐个查询」)
  const appM = boot();
  await appM.settle();
  const setSrv = (key, on) => appM.S(`state.servers.${key} = { running: ${on}, owned: true, external: false, url: 'http://x/' }`);
  const chip = () => appM.el('serverChipText').textContent;
  const safe = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

  setSrv('remotes.B', true); // B 的服务在运行,切到 A
  let err = await safe(() => appM.S('switchTarget')('A'));
  check(err === null, 'T11a 另一台服务在运行时切换目标不抛异常', err);
  check(appM.el('env-node').textContent === 'v22.1.0' && appM.el('envScope').textContent === '· 远程 10.0.0.1', 'T11b 切换后环境检测照常刷新为新目标自己的', cells(appM).join('|'));
  check(chip().includes('另有 1 个在运行') || chip() === '另有 1 个服务运行中', 'T11c 顶栏计数:另有 1 个服务在运行', chip());

  setSrv('remotes.A', true);
  setSrv('local', true); // 远程 A、B 与本机三台都在运行
  err = await safe(() => appM.S('stopServer')());
  check(err === null && chip() === '另有 2 个服务运行中', 'T11d 停止当前服务:不抛异常,其余两台照常计为运行中', `${err} | ${chip()}`);
  err = await safe(() => appM.S('startServer')());
  check(err === null && chip().includes('另有 2 个在运行'), 'T11e 重新启动:不抛异常', `${err} | ${chip()}`);
  err = await safe(() => appM.S('switchTarget')('local'));
  check(err === null && chip() === '另有 2 个服务运行中' && appM.el('env-node').textContent === 'v22.L.0', 'T11f 切到本机:不抛异常,两台远程计为运行中,环境检测是本机的', `${err} | ${chip()}`);

  /* ---------- code-server 可选组件:没装 → 询问 → 安装 → 再打开;登录密码 ---------- */
  const appC = boot();
  await appC.settle();
  const E = appC.editor;
  const C = appC.S;
  const opensC = appC.editorOpens.length;
  C("setServer({ running: true, owned: true, external: false, url: 'http://10.0.0.1:30141/' })");
  appC.el('wv')._exec = async (code) => (code === C('PROJECT_DIR_SCRIPT') ? '/home/walker/proj' : '');
  const toastsC = () => [...appC.el('toastWrap').children].map((c) => c.textContent);
  const lastToastC = () => toastsC().slice(-1)[0];
  const clickC = () => C('openCurrentProjectInEditor')();
  const NEED_INSTALL = { ok: false, needInstall: true, error: '10.0.0.1 上还没有 code-server' };
  const OPENED = { ok: true, url: 'http://10.0.0.1:8080/?folder=%2Fhome%2Fwalker%2Fproj' };

  // a) 没装:问一句;不装就到此为止
  E.reply = async () => NEED_INSTALL;
  E.confirm = { confirmed: false };
  await clickC();
  check(E.confirms === 1 && E.installs === 0 && appC.editorOpens.length === opensC + 1 && lastToastC() === '正在用 VS Code 打开 /home/walker/proj', 'T12a 没装 code-server:询问一次;选择不安装就到此为止(本机目标文案是 VS Code)', JSON.stringify([E.confirms, E.installs, appC.editorOpens.length - opensC, lastToastC()]));
  E.confirmReply = new Error('dialog failed');
  await clickC();
  check(E.installs === 0 && appC.editorOpens.length === opensC + 2, 'T12b 确认框调用失败:按「不安装」处理,不擅自安装');
  E.confirmReply = null;

  // b) 选择安装:安装完成后自动再打开
  E.confirm = { confirmed: true };
  let openCalls = 0;
  E.reply = async () => (openCalls++ % 2 === 0 ? NEED_INSTALL : OPENED);
  E.installReply = { ok: true, version: '4.146.0' };
  await clickC();
  check(E.installs === 1 && appC.editorOpens.length === opensC + 4 && appC.editorOpens.slice(-2).every((d) => d === '/home/walker/proj'), 'T12c 选择安装:安装一次,完成后用同一个项目目录再打开', JSON.stringify(appC.editorOpens.slice(-2)));
  check(toastsC().includes('正在安装 code-server,进度见「更新日志」…') && toastsC().includes('code-server 安装完成(版本 4.146.0)'), 'T12c 提示:安装中 / 安装完成(带版本)', toastsC().slice(-3).join(' | '));
  check(appC.el('logModal').hidden === false && appC.el('logModalTitle').textContent === '更新日志', 'T12c 安装期间自动打开「更新日志」');

  // c) 安装进行中:不能切换目标
  let release = null;
  E.reply = async () => NEED_INSTALL;
  E.installReply = new Promise((resolve) => { release = () => resolve({ ok: true, version: '1.0.0' }); });
  const pending = clickC();
  await appC.settle(30);
  check(C('state.updating') === true, 'T12d 安装进行中:进入互斥状态');
  await C('switchTarget')('B');
  check(C('state.mode') === 'local' && toastsC().includes('更新任务进行中,请稍后再切换'), 'T12d 安装进行中:切换目标被拦下', C('state.mode') + ' / ' + toastsC().slice(-1)[0]);
  await C('installCodeServer')();
  check(E.installs === 2 && toastsC().includes('已有安装或更新任务在进行中,请稍后再试'), 'T12d 安装进行中:重复安装被拦下', E.installs);
  release();
  await pending;
  check(C('state.updating') === false, 'T12d 安装结束:互斥解除');

  // d) 安装失败:如实提示(只取第一行),不再尝试打开
  E.reply = async () => NEED_INSTALL;
  E.installReply = { ok: false, error: '下载 code-server 失败(直连:超时)\n详情第二行' };
  const beforeFail = appC.editorOpens.length;
  await clickC();
  check(lastToastC() === 'code-server 安装失败:下载 code-server 失败(直连:超时)' && appC.editorOpens.length === beforeFail + 1 && C('state.updating') === false, 'T12e 安装失败:提示原因,不再尝试打开,互斥解除', lastToastC());

  // e) 打开失败:原因停留久一些
  E.reply = async () => ({ ok: false, error: 'code-server 没在运行或本机访问不到:http://10.0.0.1:8080' });
  await clickC();
  check(lastToastC() === '无法用 VS Code 打开:code-server 没在运行或本机访问不到:http://10.0.0.1:8080' && appC.timers.includes(9000), 'T12f 打开失败:原样转达原因,提示停留 9 秒', appC.timers.slice(-1)[0]);

  // f) 窗口落到登录页时:密码复制到剪贴板并显示(点击按钮本身不去读密码)
  E.copied.length = 0;
  E.reply = async () => ({ ...OPENED, password: 'should-be-ignored' });
  await clickC();
  check(E.copied.length === 0, 'T12g 点击按钮(已登录可直接进项目):不去读密码、不动剪贴板');
  check(typeof appC.hooks.codeServerPassword === 'function' && appC.hooks.codeServerPassword === C('showCodeServerPassword'), 'T12g 已订阅「落到登录页」事件');
  E.copyOk = true;
  await appC.hooks.codeServerPassword({ password: 'pw-12345', host: '10.0.0.1' });
  check(E.copied[E.copied.length - 1] === 'pw-12345' && lastToastC() === 'code-server 需要登录,密码已复制到剪贴板:pw-12345' && appC.timers.slice(-1)[0] === 15000, 'T12g 落到登录页:密码复制到剪贴板,提示停留 15 秒', `${E.copied.slice(-1)[0]} / ${appC.timers.slice(-1)[0]}ms`);
  E.copyOk = false;
  await appC.hooks.codeServerPassword({ password: 'pw-12345' });
  check(lastToastC() === 'code-server 需要登录,密码如下:pw-12345', 'T12h 复制失败:提示里直接给出密码', lastToastC());
  const copiedBefore = E.copied.length;
  const toastBefore = toastsC().length;
  await appC.hooks.codeServerPassword({});
  await appC.hooks.codeServerPassword({ password: '' });
  check(E.copied.length === copiedBefore && toastsC().length === toastBefore, 'T12i 没有密码可给(无密码认证 / 读取失败):不提示、不动剪贴板');
  check(appC.timers.includes(3600), 'T12j 普通提示仍是默认时长');

  // g) 更新日志里的 code-server 行带自己的标签
  appC.hooks.updateLog({ target: 'code-server', line: '下载中 3.2%\n' });
  appC.hooks.updateLog({ target: 'pi', line: 'npm install\n' });
  appC.hooks.updateLog({ target: 'pi-web', line: 'npm install\n' });
  check(C("getLogText('update')").includes('[code-server] 下载中 3.2%\n') && !C("getLogText('update')").includes('[Pi Web] [code-server]'), 'T12k 「更新日志」里 code-server 的行带自己的标签,不会被标成 Pi Web');

  // T13) SSH 终端:入口开关、真实调用形态、Ctrl+V 三态、断开与回收
  const app2 = boot({ mode: 'remote', activeRemoteId: 'A' });
  await app2.settle();
  check(app2.el('termOpenBtn').disabled === false, 'T13 远程模式:终端入口可用');
  app2.el('termOpenBtn')._l.click[0]();
  await app2.settle();
  const startCall = app2.termCalls.find((c) => c.api === 'start');
  check(!!startCall && startCall.arg.target.mode === 'remote' && startCall.arg.target.remoteId === 'A' && startCall.arg.cols === 80 && startCall.arg.rows === 24, 'T13 点击入口:termStart 带当前目标与初始尺寸', startCall && startCall.arg);
  check(app2.el('termView').hidden === false && app2.el('termTitle').textContent === 'user-a@10.0.0.1' && app2.document.body._classes.has('in-term'), 'T13 终端视图打开,标题为当前目标', app2.el('termTitle').textContent);
  const t0 = app2.terminals[0];
  check(!t0.disposed && app2.el('termOverlay').hidden === true, 'T13 会话建立:xterm 实例在用,无断开遮罩');
  t0.dataCb('ls\r');
  await app2.settle();
  const w1 = app2.termCalls.filter((c) => c.api === 'write').pop();
  check(!!w1 && w1.arg.id === 't-1' && w1.arg.data === 'ls\r', 'T13 键入经 termWrite 送进会话', w1 && w1.arg);
  app2.hooks.termData({ id: 't-1', data: Buffer.from('你好') });
  await app2.settle();
  check(t0.display === '你好', 'T13 会话输出写入 xterm(UTF-8 解码)', t0.display);
  app2.term.pasteReply = { ok: true, type: 'text', text: 'hello' };
  const altV = pressKey(t0, { type: 'keydown', altKey: true, key: 'v' }, 'hello');
  const altGrV = pressKey(t0, { type: 'keydown', ctrlKey: true, altKey: true, key: 'v' }, 'hello');
  const ctrlShiftV = pressKey(t0, { type: 'keydown', ctrlKey: true, shiftKey: true, key: 'v' }, 'hello');
  await app2.settle();
  check(altV.handled === true && altGrV.handled === true && ctrlShiftV.handled === true, 'T13 Alt+V / AltGr(Ctrl+Alt)+V / Ctrl+Shift+V 都不拦截(原样交给浏览器与 xterm)');
  check(app2.termCalls.every((c) => c.api !== 'paste'), 'T13 这三个组合不走应用的剪贴板仲裁(不读剪贴板、不上传)', app2.termCalls);
  check(t0.pasted.length === 1 && t0.pasted[0] === 'hello', 'T13 其中只有 Ctrl+Shift+V 由浏览器原生粘贴一次;Alt+V、AltGr+V 不粘贴', t0.pasted);
  t0.pasted.length = 0;
  const ctrlV = pressKey(t0, { type: 'keydown', ctrlKey: true, key: 'v' }, 'hello');
  await app2.settle();
  check(ctrlV.handled === false && ctrlV.ev.prevented === true && ctrlV.ev.stopped === true, 'T13 Ctrl+V 被应用接管,且阻止了浏览器的默认动作(xterm 6 不会代劳)');
  check(t0.pasted.length === 1 && t0.pasted[0] === 'hello', 'T13 文本剪贴板:只粘一份(应用粘一次,浏览器没有再原生粘贴一次)', t0.pasted);
  app2.term.pasteReply = { ok: true, type: 'uploaded', paths: ['/tmp/pi-paste-1.png', '/tmp/my file.png'] };
  t0.pasted.length = 0;
  pressKey(t0, { type: 'keydown', ctrlKey: true, key: 'v' }, 'hello');
  await app2.settle();
  const w2 = app2.termCalls.filter((c) => c.api === 'write').pop();
  check(!!w2 && w2.arg.data === "/tmp/pi-paste-1.png '/tmp/my file.png'", 'T13 上传完成:远程路径填入输入行(含空格的加引号)', w2 && w2.arg.data);
  check(t0.pasted.length === 1 && t0.pasted[0] === "/tmp/pi-paste-1.png '/tmp/my file.png'", 'T13 上传路径经 xterm 的 paste 送入(程序开着括号粘贴模式时会被识别为粘贴,而不是逐字键入);系统剪贴板里哪怕还有旧文本也不会被原生粘贴带进来', t0.pasted);
  // 返回控制台:会话停止、xterm 释放
  app2.el('termBackBtn')._l.click[0]();
  await app2.settle();
  const stopCalls = app2.termCalls.filter((c) => c.api === 'stop');
  check(app2.el('termView').hidden === true && t0.disposed && stopCalls.length === 1 && stopCalls[0].arg.id === 't-1' && !app2.document.body._classes.has('in-term'), 'T13 返回控制台:会话停止、资源释放、视图切回');
  // 重新打开后模拟 SSH 断开:遮罩提示;退出后的返回不再重复 stop(会话 id 已清)
  app2.el('termOpenBtn')._l.click[0]();
  await app2.settle();
  app2.hooks.termExit({ id: 't-1', reason: 'disconnected' });
  await app2.settle();
  check(app2.el('termOverlay').hidden === false && /断开/.test(app2.el('termOverlayText').textContent), 'T13 SSH 断开:显示断开遮罩');
  app2.el('termBackBtn')._l.click[0]();
  await app2.settle();
  check(app2.terminals[1].disposed && app2.termCalls.filter((c) => c.api === 'stop').length === 1, 'T13 会话已断开后的返回:不再发起多余的 stop');
  // 本机模式:入口置灰,点击不开会话
  const app3 = boot();
  await app3.settle();
  check(app3.el('termOpenBtn').disabled === true, 'T13 本机模式:终端入口置灰');
  app3.el('termOpenBtn')._l.click[0]();
  await app3.settle();
  check(app3.termCalls.length === 0 && app3.el('termView').hidden === true && app3.terminals.length === 0, 'T13 本机模式:点击不开会话');

  // T14) SSH 终端 ↔ pi-web 服务页互切:会话保留,返回控制台才结束
  const app4 = boot({ mode: 'remote', activeRemoteId: 'A' });
  app4.behavior.serverUrl = 'http://10.0.0.1:30141';
  await app4.settle();
  app4.el('termOpenBtn')._l.click[0]();
  await app4.settle();
  const t4 = app4.terminals[0];
  check(app4.termCalls.filter((c) => c.api === 'start').length === 1, 'T14 打开终端:一次 termStart');
  check(app4.el('termWebBtn').disabled === false, 'T14 pi-web 运行中:终端的「Pi-web」按钮可选');
  app4.el('termWebBtn')._l.click[0](); // 终端 → 服务页
  await app4.settle();
  check(app4.el('webView').hidden === false && app4.el('termView').hidden === true && !t4.disposed && app4.termCalls.filter((c) => c.api === 'stop').length === 0, 'T14 切到服务页:终端会话保留(不 stop、不 dispose)');
  app4.el('webTermBtn')._l.click[0](); // 服务页 → 终端
  await app4.settle();
  check(app4.el('termView').hidden === false && app4.termCalls.filter((c) => c.api === 'start').length === 1, 'T14 切回终端:复用同一会话(没有第二次 termStart)');
  t4.dataCb('whoami\r');
  await app4.settle();
  const w4 = app4.termCalls.filter((c) => c.api === 'write').pop();
  check(!!w4 && w4.arg.id === 't-1', 'T14 复用的会话仍可键入');
  app4.el('termBackBtn')._l.click[0](); // 返回控制台 = 显式结束
  await app4.settle();
  check(t4.disposed && app4.termCalls.filter((c) => c.api === 'stop').length === 1 && app4.el('termView').hidden === true, 'T14 返回控制台:会话结束');
  // pi-web 未运行:终端的「Pi-web」按钮置灰(tooltip 说明原因),不是点了才提示;服务启停时按钮跟着变
  const app4b = boot({ mode: 'remote', activeRemoteId: 'A' });
  await app4b.settle();
  app4b.el('termOpenBtn')._l.click[0]();
  await app4b.settle();
  check(app4b.el('termWebBtn').disabled === true && /未运行/.test(app4b.el('termWebBtn').title), 'T14 pi-web 未运行:终端的「Pi-web」按钮置灰,tooltip 说明原因', app4b.el('termWebBtn').title);
  app4b.hooks.serverStarted({ mode: 'remote', remoteId: 'A', url: 'http://10.0.0.1:30141' });
  await app4b.settle();
  check(app4b.el('termWebBtn').disabled === false, 'T14 终端开着时服务启动:按钮随之变为可选');
  app4b.hooks.serverExited({ mode: 'remote', remoteId: 'A', code: 0, intentional: true });
  await app4b.settle();
  check(app4b.el('termWebBtn').disabled === true, 'T14 服务停止:按钮随之置灰');

  // T15) 启动时打开:SSH 终端 / Pi-web 服务页(服务就绪后首次打开)
  const app5 = boot({ mode: 'remote', activeRemoteId: 'A', startupView: 'term' });
  await app5.settle();
  check(app5.terminals.length === 1 && app5.el('termView').hidden === false, 'T15 startupView=term:启动即进入终端');
  const app6 = boot({ mode: 'remote', activeRemoteId: 'A', startupView: 'web' });
  app6.behavior.serverUrl = 'http://10.0.0.1:30141';
  await app6.settle();
  check(app6.el('webView').hidden === false && app6.el('consoleView').hidden === true, 'T15 startupView=web 且服务在运行:启动即进入服务页');
  const app7 = boot({ mode: 'remote', activeRemoteId: 'A', startupView: 'web' });
  app7.behavior.serverUrl = ''; // 服务未运行:等服务就绪事件
  await app7.settle();
  check(app7.el('webView').hidden === true, 'T15 服务未就绪:不抢开服务页');
  await app7.hooks.serverStarted({ mode: 'remote', remoteId: 'A', url: 'http://10.0.0.1:30141' });
  await app7.settle();
  check(app7.el('webView').hidden === false, 'T15 服务首次就绪:自动进入服务页');
  const app8 = boot({ mode: 'local', startupView: 'term' });
  await app8.settle();
  check(app8.el('consoleView').hidden === false && app8.terminals.length === 0, 'T15 本机 + startupView=term:不打开终端,停在控制台');

  // T17) 终端主题:配置预设 / 新会话生效 / 保存即热切换
  const appT = boot({ mode: 'remote', activeRemoteId: 'A', termTheme: 'dracula' });
  await appT.settle();
  appT.el('termOpenBtn')._l.click[0]();
  await appT.settle();
  const tT = appT.terminals[0];
  check(!!tT && tT.opts.theme && tT.opts.theme.background === '#282a36', 'T17 termTheme=dracula:新会话用该主题', tT && tT.opts.theme);
  check(appT.el('termThemeSelect').value === 'dracula', 'T17 设置卡回显当前主题');
  appT.el('termThemeSelect').value = 'light';
  appT.el('termSaveBtn')._l.click[0]();
  await appT.settle();
  check(appT.S('state').cfg.termTheme === 'light' && tT.options.theme && tT.options.theme.background === '#f6f8fa', 'T17 终端配置卡保存:主题落盘且活会话立即切换', JSON.stringify(tT.options.theme));
  const appT2 = boot({ mode: 'remote', activeRemoteId: 'A' });
  await appT2.settle();
  appT2.el('termOpenBtn')._l.click[0]();
  await appT2.settle();
  check(appT2.terminals[0].opts.theme.background === '#0e1320', 'T17 默认 auto:主题取应用色板', appT2.terminals[0].opts.theme.background);
  const appT3 = boot({ mode: 'remote', activeRemoteId: 'A', termTheme: 'solarized-light' });
  await appT3.settle();
  appT3.el('termOpenBtn')._l.click[0]();
  await appT3.settle();
  const th3 = appT3.terminals[0].opts.theme;
  check(th3.background === '#fdf6e3' && th3.brightGreen === '#586e75', 'T17 新预设生效且带 ANSI 16 色(solarized-light)', JSON.stringify(th3).slice(0, 120));

  // T18) 终端增强:addon 装配 / Unicode 11 宽度表 / 链接(Ctrl+单击走系统浏览器)/ Shift+Enter 换行 /
  //      WebGL 不可用与丢上下文的回退 / 会话事实的提示 / 会话类开关
  const appU = boot({ mode: 'remote', activeRemoteId: 'A' });
  await appU.settle();
  appU.el('termOpenBtn')._l.click[0]();
  await appU.settle();
  const tU = appU.terminals[0];
  const addonOf = (t, kind) => (t.addons || []).find((a) => a.kind === kind);
  const writesOf = (app) => app.termCalls.filter((c) => c.api === 'write');
  check(tU.addons.map((a) => a.kind || 'fit').join(',') === 'fit,unicode11,web-links,webgl', 'T18 新会话依次装 fit → unicode11 → web-links → webgl', tU.addons.map((a) => a.kind || 'fit').join(','));
  check(tU.unicode.activeVersion === '11' && tU.opts.rescaleOverlappingGlyphs === true, 'T18 宽度表切到 Unicode 11,并开启超宽字形缩放', `${tU.unicode.activeVersion} / ${tU.opts.rescaleOverlappingGlyphs}`);
  check(tU.opts.allowProposedApi === true, 'T18 终端开启 allowProposedApi(切换宽度表的 term.unicode 是提议中接口,不开则访问即抛错 → 会话都建不起来)', tU.opts.allowProposedApi);
  addonOf(tU, 'web-links').handler({ ctrlKey: false }, 'https://example.com/plain-click');
  check(appU.openedLinks.length === 0, 'T18 链接:没按修饰键的单击不打开(在链接上双击选词不会误开网页)', appU.openedLinks);
  addonOf(tU, 'web-links').handler({ ctrlKey: true }, 'https://example.com/a?b=1');
  check(appU.openedLinks.length === 1 && appU.openedLinks[0] === 'https://example.com/a?b=1', 'T18 链接:Ctrl+单击 → 交给系统浏览器打开(openExternal),不走 window.open', appU.openedLinks);
  // OSC 52(远端程序请求写入本机剪贴板):herdr 这类自己接管鼠标的全屏程序,「选中即复制」靠它把文本送回本机。
  // 终端不处理的话复制会静默失败,剪贴板停在旧内容上,随后 Ctrl+V 送上去的就是旧的那张图
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const osc = tU.parser.osc[52];
  check(typeof osc === 'function', 'T18 终端登记了 OSC 52 处理器');
  const oscHandled = osc(`c;${b64('从 herdr 选中的一行\n第二行 😀')}`);
  await appU.settle();
  check(oscHandled === true && appU.clipWrites[appU.clipWrites.length - 1] === '从 herdr 选中的一行\n第二行 😀', 'T18 OSC 52 写入:base64 的 UTF-8 文本原样写进系统剪贴板', JSON.stringify(appU.clipWrites));
  const writesBeforeOsc = appU.clipWrites.length;
  osc('c;?'); // 读取请求:不应答(服务器上的程序读不走本机剪贴板)
  osc(`p;${b64('primary selection')}`);
  osc(`q;${b64('secondary selection')}`);
  osc('c;!!!!not-base64!!!!');
  osc(`c;${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')}`); // 不是合法的 UTF-8
  osc(`c;${b64('半截').slice(0, 5)}`); // 被截断的 base64
  osc(`c;${b64('夹带').replace(/=+$/, '')}#`); // 夹带非法字符
  await appU.settle();
  check(appU.clipWrites.length === writesBeforeOsc, 'T18 OSC 52 不应答读取请求(?);其它选择区(p / q)与非法负载一律不写剪贴板', JSON.stringify(appU.clipWrites.slice(writesBeforeOsc)));
  osc('c;');
  await appU.settle();
  check(appU.clipWrites[appU.clipWrites.length - 1] === '', 'T18 OSC 52 空负载 = 清空剪贴板(写入空串)', JSON.stringify(appU.clipWrites.slice(-1)));
  osc(`${b64('不带填充等号')}`.length ? `c;${b64('不带填充等号').replace(/=+$/, '')}` : 'c;');
  await appU.settle();
  check(appU.clipWrites[appU.clipWrites.length - 1] === '不带填充等号', 'T18 OSC 52 负载末尾没有填充等号也能正确解码', JSON.stringify(appU.clipWrites.slice(-1)));
  const writesBefore = writesOf(appU).length;
  const shiftEnterDown = pressKey(tU, { type: 'keydown', key: 'Enter', shiftKey: true });
  check(shiftEnterDown.handled === false && shiftEnterDown.ev.prevented === true, 'T18 Shift+Enter 被映射(不再当作 Enter),并阻止了浏览器的默认动作(否则输入框里会被塞进一个换行)');
  await appU.settle();
  const newlineWrite = writesOf(appU).pop();
  check(writesOf(appU).length === writesBefore + 1 && !!newlineWrite && newlineWrite.arg.data === '\x1b\r' && newlineWrite.arg.id === 't-1', 'T18 Shift+Enter 发的是换行序列 Esc+CR', newlineWrite && newlineWrite.arg);
  const untouched = [
    pressKey(tU, { type: 'keydown', key: 'Enter' }),
    pressKey(tU, { type: 'keydown', key: 'Enter', shiftKey: true, ctrlKey: true }),
    pressKey(tU, { type: 'keydown', key: 'Enter', shiftKey: true, altKey: true }),
    pressKey(tU, { type: 'keydown', key: 'Enter', shiftKey: true, metaKey: true }),
    pressKey(tU, { type: 'keyup', key: 'Enter', shiftKey: true }),
  ];
  check(untouched.every((k) => k.handled === true && k.ev.prevented === false), 'T18 普通 Enter、带 Ctrl/Alt/Meta 的 Enter、keyup 都不受影响(不拦,也不替浏览器做主)');
  await appU.settle();
  check(writesOf(appU).length === writesBefore + 1, 'T18 上面这些组合不产生额外写入');
  const shiftEnterPress = pressKey(tU, { type: 'keypress', key: 'Enter', shiftKey: true });
  check(shiftEnterPress.handled === false && shiftEnterPress.ev.prevented === true, 'T18 Shift+Enter 的 keypress 也被拦并阻止(否则 xterm 会再发一个 \\r:换了行还把内容提交了)');
  const plainEnterPress = pressKey(tU, { type: 'keypress', key: 'Enter' });
  check(plainEnterPress.handled === true && plainEnterPress.ev.prevented === false, 'T18 普通 Enter 的 keypress 不受影响');
  await appU.settle();
  check(writesOf(appU).length === writesBefore + 1, 'T18 keypress 被拦且不重复发送换行序列');
  check(appU.el('termHint').textContent === 'Ctrl+V:粘贴;截图/文件自动上传到 /tmp 并填入路径', 'T18 终端提示只有 Ctrl+V 一条', appU.el('termHint').textContent);
  addonOf(tU, 'webgl').lossCb();
  check(addonOf(tU, 'webgl').disposed === true && tU.disposed === false && appU.termCalls.filter((c) => c.api === 'stop').length === 0, 'T18 WebGL 上下文丢失:只卸渲染器,终端实例与会话保留');

  // WebGL 拿不到上下文(构造即抛):清掉残留画布,会话照常建立
  const appU4 = boot({ mode: 'remote', activeRemoteId: 'A' });
  appU4.addons.webglThrows = true;
  await appU4.settle();
  const strayCanvases = [makeEl('canvas'), makeEl('canvas')];
  const removedCanvases = [];
  strayCanvases.forEach((c) => (c.remove = () => removedCanvases.push(c)));
  appU4.el('termMount').querySelectorAll = () => strayCanvases.slice();
  appU4.el('termOpenBtn')._l.click[0]();
  await appU4.settle();
  check(
    !!appU4.terminals[0] && addonOf(appU4.terminals[0], 'webgl') === undefined && removedCanvases.length === 2 &&
      appU4.termCalls.filter((c) => c.api === 'start').length === 1 && appU4.el('termOverlay').hidden === true,
    'T18 WebGL 不可用:不装渲染器、清掉残留画布,终端照常建立',
    `${appU4.terminals.length} / ${removedCanvases.length}`
  );
  check(appU4.terminals[0].unicode.activeVersion === '11' && !!addonOf(appU4.terminals[0], 'web-links'), 'T18 WebGL 不可用时,宽度表与链接不受影响');
  check(appU4.warns.some((w) => /^WebGL 渲染器不可用,已回退到内置渲染器: WebGL2 not supported null$/.test(w)), 'T18 WebGL 不可用:原因写进 console.warn(可诊断,不刷屏)', JSON.stringify(appU4.warns));

  // 某一项增强加载时抛错:只丢这一项,终端照常建立,其余增强仍在
  const appU7 = boot({ mode: 'remote', activeRemoteId: 'A' });
  appU7.addons.fail = 'unicode11';
  await appU7.settle();
  appU7.el('termOpenBtn')._l.click[0]();
  await appU7.settle();
  const tU7 = appU7.terminals[0];
  check(
    !!tU7 && appU7.termCalls.filter((c) => c.api === 'start').length === 1 && appU7.el('termOverlay').hidden === true &&
      tU7.unicode.activeVersion === '6' && !!addonOf(tU7, 'web-links') && !!addonOf(tU7, 'webgl'),
    'T18 宽度表加载失败:只丢这一项,会话照常建立,链接与 WebGL 仍在',
    JSON.stringify([!!tU7, tU7 && tU7.addons.map((a) => a.kind || 'fit')])
  );
  check(appU7.warns.some((w) => /^Unicode 11 宽度表未能启用: boom unicode11$/.test(w)), 'T18 宽度表加载失败:原因写进 console.warn', JSON.stringify(appU7.warns));
  appU7.el('termBackBtn')._l.click[0]();
  await appU7.settle();

  // xterm 自身初始化失败:不留一片空白,遮罩上给出原因,也不发起会话
  const appU8 = boot({ mode: 'remote', activeRemoteId: 'A' });
  appU8.term.ctorThrows = true;
  await appU8.settle();
  appU8.el('termOpenBtn')._l.click[0]();
  await appU8.settle();
  check(
    appU8.el('termView').hidden === false && appU8.el('termOverlay').hidden === false &&
      appU8.el('termOverlayText').textContent === '终端初始化失败:xterm boom' && appU8.termCalls.length === 0,
    'T18 xterm 初始化抛错:遮罩给出原因(不留空白),不发起会话',
    appU8.el('termOverlayText').textContent
  );
  appU8.el('termBackBtn')._l.click[0]();
  await appU8.settle();
  check(appU8.el('consoleView').hidden === false, 'T18 初始化失败后仍可返回控制台');

  // 会话事实与断线提示不能承诺已有任务的环境或存活状态。
  check(appU.el('termStatusDot').title === '会话状态' && appU.el('termBackBtn').title === '返回控制台', 'T18 普通会话:状态点与返回按钮是默认说明');
  const appU2 = boot({ mode: 'remote', activeRemoteId: 'A' });
  await appU2.settle();
  appU2.term.startReply = { ok: true, id: 't-1', mode: 'remote', remoteId: 'A', proxy: true, tmux: 'on', tmuxVersion: 'tmux 3.4' };
  appU2.el('termOpenBtn')._l.click[0]();
  await appU2.settle();
  check(/已继承这台服务器的代理设置/.test(appU2.el('termStatusDot').title) && /tmux 3\.4/.test(appU2.el('termStatusDot').title) && /需重连确认/.test(appU2.el('termBackBtn').title), 'T18 继承了代理且在 tmux 里:状态点与返回按钮如实说明', `${appU2.el('termStatusDot').title} | ${appU2.el('termBackBtn').title}`);
  appU2.hooks.termExit({ id: 't-1', reason: 'disconnected' });
  await appU2.settle();
  check(/可能保留.*需重连确认/.test(appU2.el('termOverlayText').textContent) && !/仍在|即可恢复/.test(appU2.el('termOverlayText').textContent), 'T18 保活会话断线:不保证任务存活,需重连确认', appU2.el('termOverlayText').textContent);
  appU2.term.startReply = { ok: true, id: 't-2', mode: 'remote', remoteId: 'A', proxy: null, tmux: 'on', tmuxAttached: true, proxyRetained: true };
  appU2.el('termReconnectBtn')._l.click[0]();
  await appU2.settle();
  check(appU2.S('termState.facts.proxy') === null && /保留原环境.*代理状态未知/.test(appU2.el('termStatusDot').title) && !/已继承/.test(appU2.el('termStatusDot').title), 'T18 附着已有会话:状态未知,保留原环境而非本次代理设置', appU2.el('termStatusDot').title);
  check(appU2.el('toastWrap').children.some((c) => /本次设置不会更改已有任务/.test(c.textContent)), 'T18 附着提示不承诺环境更改生效');
  appU2.hooks.termExit({ id: 't-2', reason: 'closed' });
  await appU2.settle();
  check(appU2.el('termOverlayText').textContent === '终端通道已关闭;任务状态需重连确认', 'T18 closed 与断线区分,不保证程序存活', appU2.el('termOverlayText').textContent);
  appU.hooks.termExit({ id: 't-1', reason: 'disconnected' });
  await appU.settle();
  check(appU.el('termOverlayText').textContent === 'SSH 连接已断开', 'T18 普通会话断线:遮罩文案不变', appU.el('termOverlayText').textContent);
  // 服务退出事件(SSH 管理连接断开时主进程也会发)不该把正在用终端的人切回控制台:
  // 否则「已断开」遮罩和「重连」按钮都落在看不见的视图里,用户只能自己摸回终端
  appU.hooks.serverExited({ mode: 'remote', remoteId: 'A', code: 0, intentional: true });
  await appU.settle();
  check(
    appU.el('termView').hidden === false && appU.el('consoleView').hidden === true && appU.document.body._classes.has('in-term') && !appU.terminals[0].disposed,
    'T18 终端里收到 server:exited:留在终端视图(遮罩与重连可见),不被切回控制台,会话也不销毁',
    JSON.stringify([appU.el('termView').hidden, appU.el('consoleView').hidden])
  );
  appU.el('termBackBtn')._l.click[0]();
  await appU.settle();
  check(appU.el('consoleView').hidden === false, 'T18 之后手动返回控制台照常');
  const appU3 = boot({ mode: 'remote', activeRemoteId: 'A' });
  await appU3.settle();
  appU3.term.startReply = { ok: true, id: 't-1', mode: 'remote', remoteId: 'A', proxy: false, proxyError: '反向隧道建立失败', tmux: 'missing', tmuxVersion: '' };
  appU3.el('termOpenBtn')._l.click[0]();
  await appU3.settle();
  const toastsU3 = appU3.el('toastWrap').children.map((c) => c.textContent);
  check(
    !!appU3.terminals[0] && !appU3.terminals[0].disposed &&
      toastsU3.includes('这台服务器没有安装 tmux,本次会话不支持断线保活') &&
      toastsU3.includes('代理设置未能带入终端:反向隧道建立失败'),
    'T18 代理注入失败、服务器没装 tmux:各提示一条,会话照常建立',
    JSON.stringify(toastsU3)
  );
  check(appU3.el('termStatusDot').title === '会话状态', 'T18 没继承成代理、没进 tmux:状态点不谎报', appU3.el('termStatusDot').title);

  // 会话类开关:回显 / 保存与提示 / 关闭后 Shift+Enter 不再映射 / 旧配置缺字段时按默认
  const appU5 = boot({ mode: 'remote', activeRemoteId: 'A', termShiftEnter: false, termProxy: false, termTmux: true });
  await appU5.settle();
  check(appU5.el('termShiftEnterCheck').checked === false && appU5.el('termProxyCheck').checked === false && appU5.el('termTmuxCheck').checked === true, 'T18 设置卡回显三个会话开关');
  appU5.el('termOpenBtn')._l.click[0]();
  await appU5.settle();
  check(appU5.el('termHint').textContent === 'Ctrl+V:粘贴;截图/文件自动上传到 /tmp 并填入路径', 'T18 关闭换行映射:提示保持 Ctrl+V 一条(Shift+Enter 不写进提示)', appU5.el('termHint').textContent);
  const writesU5 = writesOf(appU5).length;
  const offDown = pressKey(appU5.terminals[0], { type: 'keydown', key: 'Enter', shiftKey: true });
  const offPress = pressKey(appU5.terminals[0], { type: 'keypress', key: 'Enter', shiftKey: true });
  check(offDown.handled === true && offPress.handled === true && offDown.ev.prevented === false && offPress.ev.prevented === false, 'T18 关闭换行映射:Shift+Enter(keydown 与 keypress)交回 xterm 默认处理(等同 Enter),应用不替浏览器做主');
  await appU5.settle();
  check(writesOf(appU5).length === writesU5, 'T18 关闭换行映射:不写换行序列');
  appU5.el('termProxyCheck').checked = true;
  appU5.el('termSaveBtn')._l.click[0]();
  await appU5.settle();
  const cfgU5 = appU5.S('state').cfg;
  const toastsU5 = () => appU5.el('toastWrap').children.map((c) => c.textContent);
  check(cfgU5.termProxy === true && cfgU5.termShiftEnter === false && cfgU5.termTmux === true, 'T18 保存:三个开关原样落盘', JSON.stringify([cfgU5.termShiftEnter, cfgU5.termProxy, cfgU5.termTmux]));
  check(toastsU5().slice(-1)[0] === '终端配置已保存;环境设置仅用于新建会话,附着已有 tmux 会话会保留原环境', 'T18 保存不承诺重新打开已有会话会改变环境', toastsU5().slice(-1)[0]);
  appU5.el('termSaveBtn')._l.click[0](); // 没再改开关
  await appU5.settle();
  check(toastsU5().slice(-1)[0] === '终端配置已保存', 'T18 开关没变:普通保存提示', toastsU5().slice(-1)[0]);
  const appU6 = boot({ mode: 'remote', activeRemoteId: 'A' });
  await appU6.settle();
  check(appU6.el('termShiftEnterCheck').checked === true && appU6.el('termProxyCheck').checked === true && appU6.el('termTmuxCheck').checked === false, 'T18 旧配置没有这些字段:按默认回显(换行开、继承代理开、保活关)');

  // T19) 无边框窗口:探测到窗口控制叠加才给 body 打 .wco(样式据此让顶栏可拖拽、给窗口按钮让位)
  const appW = boot({ mode: 'local' }, { wco: true });
  await appW.settle();
  const appW2 = boot({ mode: 'local' });
  await appW2.settle();
  check(appW.document.body._classes.has('wco') === true && appW2.document.body._classes.has('wco') === false, 'T19 窗口控制叠加:有则 body.wco,没有则不打');

  // T16) Code Server 配置卡:状态渲染/按钮可用性/保存/启停/外部实例确认
  const app9 = boot({ mode: 'remote', activeRemoteId: 'A' });
  await app9.settle();
  check(/已安装,未运行/.test(app9.el('csState').textContent) && /v4\.146\.0/.test(app9.el('csState').textContent) && app9.el('csStartBtn').disabled === false && app9.el('csStopBtn').disabled === true, 'T16 已安装未运行:状态含版本号,按钮可用性正确', app9.el('csState').textContent);
  // 重新检测按钮:手动再查一次
  const stateCallsBefore = app9.csCalls.state.length;
  app9.el('csRedetectBtn')._l.click[0]();
  await app9.settle();
  check(app9.csCalls.state.length === stateCallsBefore + 1, 'T16 重新检测:立即按当前目标再查一次', app9.csCalls.state.length);
  // 已安装时点「更新」:显示当前目标与下载影响,取消不安装
  app9.el('csInstallBtn')._l.click[0]();
  check(!app9.el('confirmModal').hidden && /更新/.test(app9.el('confirmTitle').textContent) && /270MB/.test(app9.el('confirmDetail').textContent), 'T16 更新确认:显示动作及下载影响');
  app9.el('confirmCancelBtn')._l.click[0]();
  await app9.settle();
  check(app9.editor.installs === 0 && app9.el('confirmModal').hidden, 'T16 取消更新:不安装且关闭弹层');
  check(String(app9.el('csPortInput').value) === '8080' && app9.el('csPasswordInput').value === 'pw-old', 'T16 检测回填服务器上的端口与密码');
  // 保存:地址进档案 + 端口/密码写服务器 config.yaml
  app9.el('codeServerUrlInput').value = '';
  app9.el('csPortInput').value = '8081';
  app9.el('csPasswordInput').value = 'pw-new';
  app9.el('csSaveBtn')._l.click[0]();
  await app9.settle();
  const saveCall = app9.csCalls.save[0];
  check(!!saveCall && saveCall.port === 8081 && saveCall.password === 'pw-new' && saveCall.target.remoteId === 'A', 'T16 保存:端口/密码经 csSave 写服务器(带目标)', saveCall);
  // 启动(桩状态先就位,启动后检测到「运行中」)
  app9.cs.reply = { ...app9.cs.reply, running: true, owned: true };
  app9.el('csStartBtn')._l.click[0]();
  await app9.settle();
  check(app9.csCalls.start.length === 1 && /运行中/.test(app9.el('csState').textContent) && app9.el('csStopBtn').disabled === false, 'T16 启动后:状态=运行中,停止可用', app9.el('csState').textContent);
  // 停止:本应用启动的直接停
  app9.cs.reply = { ...app9.cs.reply, running: false, owned: false };
  app9.el('csStopBtn')._l.click[0]();
  await app9.settle();
  check(app9.csCalls.stop.length === 1 && app9.csCalls.stop[0].force !== true, 'T16 自己启动的实例:直接停止(不带 force)');
  // 外部实例:先确认,取消则不动;确认后 force 停该端口
  await app9.S('setCsState')({ running: true, owned: false });
  const cancelStop = app9.el('csStopBtn')._l.click[0]();
  check(!app9.el('confirmModal').hidden && /强制结束/.test(app9.el('confirmTitle').textContent), 'T16 外部实例:弹出危险操作确认');
  app9.el('confirmCancelBtn')._l.click[0]();
  await cancelStop;
  await app9.settle();
  check(app9.csCalls.stop.length === 1 && /非本应用启动/.test(app9.el('csState').textContent), 'T16 外部实例:未确认前不代停', `${app9.csCalls.stop.length} 次 stop`);
  const acceptStop = app9.el('csStopBtn')._l.click[0]();
  app9.el('confirmOkBtn')._l.click[0]();
  await acceptStop;
  await app9.settle();
  const stopCall = app9.csCalls.stop[1];
  check(!!stopCall && stopCall.force === true && String(stopCall.port) === '8080', 'T16 确认后:force 停止该端口', stopCall);
  // 本机:端口/密码隐藏,只能打开
  const app10 = boot();
  await app10.settle();
  check(app10.el('csPortField').hidden === true && app10.el('csPasswordField').hidden === true && app10.el('csOpenBtn').disabled === false, 'T16 本机:隐藏端口/密码,「打开」可用');
  // 远程弹窗已不再包含 code-server 字段(表单读取不含它)
  check(!('codeServerUrl' in app9.S('readRemoteForm')()), 'T16 远程弹窗表单不再携带 code-server 地址');
  // 切换目标:自动按新目标检测 code-server(此前漏检,卡上显示「自管/未检测」像"检测不出来")
  await app9.S('switchTarget')('B');
  await app9.settle();
  check(app9.csCalls.state.some((t) => t && t.target && t.target.remoteId === 'B'), 'T16 切换目标:自动按新目标检测 code-server', JSON.stringify(app9.csCalls.state.map((t) => t && t.target && t.target.remoteId)));

  // 删除档案:弹窗入口也能删除;取消或点遮罩不改目标,确认才删除
  const previousCount = app9.cfg.remotes.length;
  app9.el('remoteModal').hidden = false;
  app9.el('remoteDelBtn').focus();
  app9.el('remoteDelBtn')._l.click[0]();
  check(!app9.el('confirmModal').hidden && /删除/.test(app9.el('confirmTitle').textContent), 'T16 远程弹窗删除按钮:打开确认框');
  let escapeStopped = false;
  app9.document._l.keydown.at(-1)({ key: 'Escape', preventDefault() {}, stopPropagation() { escapeStopped = true; } });
  await app9.settle();
  check(escapeStopped && app9.el('remoteModal').hidden === false && app9.document.activeElement === app9.el('remoteDelBtn'), 'T16 Esc 仅关闭确认框,远程弹窗保留且焦点回到删除按钮');
  app9.el('remoteDelBtn')._l.click[0]();
  app9.el('confirmModal')._l.mousedown[0]({ target: app9.el('confirmModal') });
  await app9.settle();
  check(app9.cfg.remotes.length === previousCount && app9.el('confirmModal').hidden, 'T16 点确认框遮罩:不删除服务器');
  const remove = app9.S('delRemote')('B');
  app9.el('confirmOkBtn')._l.click[0]();
  await remove;
  check(app9.cfg.remotes.length === previousCount - 1 && !app9.cfg.remotes.some((r) => r.id === 'B'), 'T16 确认后:删除指定的远程档案');

  // T17) code-server 慢响应切换目标:按发起目标归档、释放 checking,失败与身份变更也可恢复。
  const app11 = boot();
  await app11.settle();
  app11.S("state.mode = 'remote'; state.activeRemoteId = 'A'");
  let finishCs;
  let csRequests = 0;
  app11.ctx.piApi.csState = () => {
    csRequests += 1;
    return new Promise((resolve) => { finishCs = resolve; });
  };
  const pendingCs = app11.S('detectCodeServer')();
  app11.S("state.activeRemoteId = 'B'");
  finishCs({ ...app11.cs.reply, base: 'http://A:8080' });
  await pendingCs;
  check(app11.S('state.cs.remotes.A').checking === false && app11.S('state.cs.remotes.A').base === 'http://A:8080' && !app11.S('state.cs.remotes.B'), 'T17 A 的晚到响应归档 A 并解除检测状态,不污染 B');
  app11.S("state.activeRemoteId = 'A'");
  app11.ctx.piApi.csState = async () => { csRequests += 1; return app11.cs.reply; };
  await app11.S('detectCodeServer')();
  check(csRequests === 2 && !app11.S('csStateOf')().checking, 'T17 切回 A 后可以再次检测');
  app11.ctx.piApi.csState = async () => { throw new Error('IPC disconnected'); };
  await app11.S('detectCodeServer')();
  check(!app11.S('csStateOf')().checking && /IPC disconnected/.test(app11.S('csStateOf')().error), 'T17 请求拒绝也解除检测状态');
  app11.ctx.piApi.csState = () => new Promise((resolve) => { finishCs = resolve; });
  const oldIdentityCs = app11.S('detectCodeServer')();
  app11.S("state.remotes = state.remotes.map(r => r.id === 'A' ? { ...r, host: '10.0.0.99' } : r)");
  app11.ctx.piApi.csState = async () => ({ ...app11.cs.reply, base: 'http://new-host:8080' });
  await app11.S('detectCodeServer')();
  finishCs({ ...app11.cs.reply, base: 'http://old-host:8080' });
  await oldIdentityCs;
  check(app11.S('csStateOf')().base === 'http://new-host:8080', 'T17 档案身份变化后旧结果不覆盖新主机');

  // T18) 连接完成前关闭或重连:晚到的会话必须停止,不能接管新终端。
  const app12 = boot({ mode: 'remote', activeRemoteId: 'A' });
  await app12.settle();
  const connections = [];
  app12.ctx.piApi.termStart = () => new Promise((resolve) => connections.push(resolve));
  const opening = app12.S('openTerm')();
  app12.S('closeTerm')();
  connections.shift()({ ok: true, id: 'closed-before-connect' });
  await opening;
  check(!app12.S('termState.id') && app12.el('termView').hidden && app12.termCalls.some((c) => c.api === 'stop' && c.arg.id === 'closed-before-connect'), 'T18 连接前关闭:晚到的 SSH 会话被停止,视图保持关闭');
  const oldOpening = app12.S('openTerm')();
  const newOpening = app12.S('startTermSession')(app12.S('curTarget')());
  connections[1]({ ok: true, id: 'new-session' });
  await newOpening;
  connections[0]({ ok: true, id: 'old-session' });
  await oldOpening;
  check(app12.S('termState.id') === 'new-session' && app12.termCalls.some((c) => c.api === 'stop' && c.arg.id === 'old-session'), 'T18 连续重连乱序返回:新会话保留,旧会话回收');
  let finishPaste;
  app12.ctx.piApi.termPaste = () => new Promise((resolve) => { finishPaste = resolve; });
  const pendingPaste = app12.S('handleTermPaste')();
  app12.S('closeTerm')();
  finishPaste({ ok: true, type: 'uploaded', paths: ['/tmp/old-upload'] });
  await pendingPaste;
  check(!app12.termCalls.some((c) => c.api === 'write' && c.arg.data === '/tmp/old-upload'), 'T18 关闭后到达的上传结果不会写入其他终端');

  // T20) Pi Web 操作行(重启 / 访问 / 复制)与按钮的运行态互斥:
  //   重启 = 先停再启,没停成功(外部实例 / 停止失败)就不叠加启动;访问 = 探活后进服务页,不重复启动;复制 = 写剪贴板并提示
  const app13 = boot({ mode: 'local' });
  await app13.settle();
  const svcCalls = [];
  app13.ctx.piApi.serverStop = async () => { svcCalls.push('stop'); return { ok: true, stopped: true }; };
  app13.ctx.piApi.serverStart = async () => { svcCalls.push('start'); return { ok: true, url: 'http://restarted/' }; };
  const setLocalRunning = (on) => app13.S(on
    ? "state.servers.local = { running: true, owned: true, external: false, url: 'http://before/' }; renderServer(); 0"
    : 'state.servers.local = defaultServer(); renderServer(); 0');
  const toast13 = () => app13.el('toastWrap').children.slice(-1)[0];
  setLocalRunning(true);
  check(app13.el('startBtn').disabled === true && app13.el('stopBtn').disabled === false && app13.el('restartBtn').disabled === false && app13.el('openPageBtn').disabled === false, 'T20 服务运行中:启动置灰,停止 / 重启 / 访问可用');
  setLocalRunning(false);
  check(app13.el('startBtn').disabled === false && app13.el('stopBtn').disabled === true && app13.el('restartBtn').disabled === true && app13.el('openPageBtn').disabled === true, 'T20 服务已停止:启动可用,停止 / 重启 / 访问置灰');
  app13.el('restartBtn')._l.click[0](); // 按钮本就不可点:即使处理器被调到也不该做任何事
  await app13.settle();
  check(svcCalls.length === 0, 'T20 服务已停止时重启:不发任何请求', svcCalls.join(','));
  setLocalRunning(true);
  app13.el('restartBtn')._l.click[0]();
  await app13.settle();
  check(svcCalls.join(',') === 'stop,start' && app13.S('curServer')().url === 'http://restarted/', 'T20 重启:先停止再启动,结果是重新启动后的服务', svcCalls.join(','));
  app13.S('showConsole(); 0');
  for (const [name, reply] of [['外部实例', { external: true }], ['停止失败', { error: '端口占用,停止失败' }]]) {
    svcCalls.length = 0;
    setLocalRunning(true);
    app13.ctx.piApi.serverStop = async () => { svcCalls.push('stop'); return reply; };
    app13.el('restartBtn')._l.click[0]();
    await app13.settle();
    check(svcCalls.join(',') === 'stop' && app13.S('curServer')().running === true, `T20 重启但没停掉(${name}):不再启动,服务保持运行`, svcCalls.join(','));
  }
  // 重启在途时不能切目标、改连接档案 / 端口或重复启停;整个 stop + start 都持锁。
  const app14 = boot({ mode: 'remote', activeRemoteId: 'A' });
  await app14.settle();
  app14.S("state.servers.remotes.A = { running: true, owned: true, url: 'http://A/' }; renderServer(); 0");
  const restartCalls = [];
  let finishStop, finishStart;
  app14.ctx.piApi.serverStop = () => {
    restartCalls.push('stop:' + app14.cfg.activeRemoteId);
    return new Promise((resolve) => { finishStop = resolve; });
  };
  app14.ctx.piApi.serverStart = () => {
    restartCalls.push('start:' + app14.cfg.activeRemoteId);
    return new Promise((resolve) => { finishStart = resolve; });
  };
  const restarting = app14.S('restartServer')();
  const beforeProfiles = JSON.stringify(app14.cfg.remotes);
  for (const expr of ["switchTarget('B')", "switchTarget('local', { force: true })", "addRemote()", "delRemote('A')", "editRemote('B')", "selectRemote('B')", 'saveCurrentRemote()', 'testRemote()', 'saveLocalPort()', 'saveRemotePort()', 'startServer()', 'stopServer()', 'restartServer()', 'runUpdate()']) {
    await app14.S(expr);
  }
  check(app14.cfg.activeRemoteId === 'A' && app14.S('state.activeRemoteId') === 'A' && JSON.stringify(app14.cfg.remotes) === beforeProfiles && restartCalls.join(',') === 'stop:A', 'T20 重启停止阶段锁住目标、档案、端口与并发操作', restartCalls.join(','));
  check(app14.el('restartBtn').disabled && app14.el('stopBtn').disabled, 'T20 重启期间禁用启停按钮');
  finishStop({ ok: true, stopped: true });
  await sleep(0);
  await app14.S("switchTarget('B')");
  check(app14.cfg.activeRemoteId === 'A' && restartCalls.join(',') === 'stop:A,start:A', 'T20 重启启动阶段仍锁住原目标', restartCalls.join(','));
  finishStart({ ok: true, url: 'http://A/restarted' });
  await restarting;
  check(!app14.S('restartingServer') && app14.S('curServer')().url === 'http://A/restarted', 'T20 重启完成释放锁并归档原目标');
  await app14.S("switchTarget('B')");
  check(app14.cfg.activeRemoteId === 'B', 'T20 重启后可以正常切换目标');
  app14.S("state.servers.remotes.B = { running: true, owned: true, url: 'http://B/' }; 0");
  app14.ctx.piApi.serverStop = async () => { throw new Error('stop rejected'); };
  let rejected = false;
  try { await app14.S('restartServer')(); } catch { rejected = true; }
  check(rejected && !app14.S('restartingServer'), 'T20 IPC 异常也在 finally 中释放重启锁');
  app14.ctx.piApi.serverStop = async () => ({ external: true });
  const cancelledRestart = app14.S('restartServer')();
  await sleep(0);
  app14.el('confirmCancelBtn')._l.click[0]();
  await cancelledRestart;
  check(!app14.S('restartingServer') && app14.S('curServer')().running && restartCalls.join(',') === 'stop:A,start:A', 'T20 外部实例确认取消后释放锁、不启动');
  // 访问:运行中 → 探活后进入服务页,不重复启动
  svcCalls.length = 0;
  app13.ctx.fetch = async () => ({ ok: true });
  app13.el('openPageBtn')._l.click[0]();
  await app13.settle();
  check(svcCalls.length === 0 && app13.el('webView').hidden === false && app13.el('webUrl').textContent === 'http://before/', 'T20 访问:服务运行中直接进入服务页,不重复启动', `${svcCalls.join(',')} / ${app13.el('webUrl').textContent}`);
  app13.S('showConsole(); 0');
  // 复制:写剪贴板 + 提示;空值不复制;失败时提示里带上可手动复制的内容
  const copied = [];
  app13.ctx.piApi.copyText = async (text) => { copied.push(text); return { ok: true }; };
  app13.el('portInput').value = '30141';
  app13.el('svcHost').value = '';
  await app13.S("copyFieldValue('portInput', '端口')");
  await app13.S("copyFieldValue('svcHost', '主机地址')");
  check(copied.join('|') === '30141' && /已复制端口:30141/.test(toast13().textContent) && toast13().className === 'toast ok', 'T20 复制:写入剪贴板并提示;空值不复制', JSON.stringify(copied));
  app13.ctx.piApi.copyText = async () => ({ ok: false });
  await app13.S("copyFieldValue('portInput', '端口')");
  check(/复制失败[\s\S]*30141/.test(toast13().textContent) && toast13().className === 'toast err', 'T20 复制失败:提示里带上可手动复制的内容', toast13().textContent);

  console.log(failed ? `\n${failed} 项失败` : '\n渲染层按目标状态(环境检测 + 代理 + code-server 配置卡 + 多服务同时运行 + SSH 终端 + 操作行): 全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('TEST ERR:', e.stack || e.message);
  process.exit(1);
});
