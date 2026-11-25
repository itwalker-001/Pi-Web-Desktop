// IPC 层「code-server 打开当前项目」自检(离线:mock electron + 真实 lib/code-server.js + SSH 通道替身)。
// code-server 是可选组件,这里走的是完整流程:目录校验 → 没装时交给渲染层询问 → 一键安装 →
// 按需启动并带回登录密码 → 已在运行则直接用 → 用户自管的地址不代为启动 → 退出回收。
// 运行:node test/ipc-editor.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { createWorld } = require('./helpers/fake-code-server');

const LIB = path.join(__dirname, '..', 'lib');
const IPC_PATH = path.join(LIB, 'ipc.js');
const CS_PATH = path.join(LIB, 'code-server.js');
const LE_PATH = path.join(LIB, 'local-editor.js');

// 本机 VS Code 替身:found 控制找不找得到,open 记下要打开的目录
const localEditor = { found: false, opened: [] };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ipc-editor-'));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ mode: 'local', autoStart: false, proxy: { enabled: false } }));

const handlers = {};
const windows = []; // 每次开窗:{ url, preload, win }
const sent = []; // 主窗口收到的事件:{ channel, payload }
const dialogCalls = [];
const copied = [];
function FakeBrowserWindow(opts) {
  this.opts = opts;
  this.handlers = {}; // 事件名 → 回调列表(attachPasteHooks 用 on;测试用 navigate 触发 did-navigate)
  this.webContents = { on: (ev, cb) => { (this.handlers[ev] = this.handlers[ev] || []).push(cb); } };
  this.on = (ev, cb) => { (this.handlers[ev] = this.handlers[ev] || []).push(cb); };
  this.isDestroyed = () => false;
  this.navigate = (url) => (this.handlers['did-navigate'] || []).forEach((cb) => cb({}, url));
  this.loadURL = (url) => windows.push({ url, preload: (opts.webPreferences || {}).preload, win: this });
}const fakeWin = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } };

// 每个场景一台「服务器」(W);门面把调用转发到当前这台
let W = createWorld();
const copyState = { fail: false, delayMs: 0 }; // 假剪贴板:写入失败 / 写入要等一会儿才完成
const fakeRemote = {
  exec: (...a) => W.remote.exec(...a),
  sshKeyOf: (...a) => W.remote.sshKeyOf(...a),
  testConnection: async () => ({ ok: true }),
  disconnect() {},
  onDisconnect() {},
};
const fakeProxy = { remoteEnvPrefix: (...a) => W.proxy.remoteEnvPrefix(...a) };

const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
      shell: {}, BrowserWindow: FakeBrowserWindow,
      dialog: { showMessageBox: async (...a) => { dialogCalls.push(a); return { response: W.world.dialogResponse === undefined ? 1 : W.world.dialogResponse }; } },
      // 与真实的 Electron 一样:writeText 返回 Promise,写入是异步完成的
      clipboard: {
        writeText: (t) => new Promise((res, rej) => {
          setTimeout(() => {
            if (copyState.fail) rej(new Error('Error while writing to the clipboard'));
            else {
              copied.push(t);
              res();
            }
          }, copyState.delayMs);
        }),
      },
      app: { getPath: () => tmp },
    };
  }
  const fromCs = args[0] && path.resolve(args[0].filename || '') === CS_PATH;
  if (fromCs && request === './remote') return fakeRemote;
  if (fromCs && request === './proxy') return fakeProxy;
  const fromIpc = args[0] && path.resolve(args[0].filename || '') === IPC_PATH;
  if (fromIpc && request === './local-editor') {
    return { open: (dir) => { localEditor.opened.push(dir); return localEditor.found ? { ok: true, bin: '/fake/code' } : { ok: false }; } };
  }
  return origLoad.apply(this, [request, ...args]);
};

const config = require(path.join(LIB, 'config'));
const codeServer = require(CS_PATH);
require(IPC_PATH).register({ getWindow: () => fakeWin, onConfigChange: null });

let failed = 0;
function assert(cond, msg, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}${cond || detail === undefined ? '' : `  [${JSON.stringify(detail)}]`}`);
  if (!cond) failed += 1;
}
const open = (dir) => handlers['editor:open']({}, dir);
const lastUrl = () => (windows.length ? windows[windows.length - 1].url : null);
const starts = () => W.events.filter((e) => e.type === 'start');
const updateLogs = () => sent.filter((s) => s.channel === 'update:log' && s.payload.target === 'code-server').map((s) => s.payload.line).join('');
const profile = (host, extra = {}) => ({ id: 'A', host, port: 22, user: 'u', remotePort: 30141, hostFingerprint: '', ...extra });
const DIR = '/home/u/proj';
const FOLDER = '?folder=%2Fhome%2Fu%2Fproj';

(async () => {
  assert(!!handlers['editor:open'] && !!handlers['code-server:confirmInstall'] && !!handlers['code-server:install'] && !!handlers['shell:copy'], 'IPC handler 已注册');

  // 1) 项目目录校验:只接受绝对路径;不合法时不查地址、不开窗口
  config.save({ mode: 'remote', activeRemoteId: 'A', codeServerUrl: '', remotes: [profile('127.0.0.1')] });
  for (const bad of ['', 'relative/path', '//share/x', '/a\nb', '/a\u0000b', 42, null, '/', 'C:proj']) {
    const r = await open(bad);
    assert(r.ok === false && /没能从服务页识别出有效的项目目录/.test(r.error) && !r.needInstall, `目录不合法时拒绝:${JSON.stringify(bad)}`, r);
  }
  assert(windows.length === 0 && W.calls.length === 0, '目录不合法:没有开窗口,也没有发起 SSH');

  // 2) 没装 code-server(可选组件):不算错误,交给渲染层问用户;不去下载
  W = createWorld();
  let r = await open(DIR);
  assert(r.ok === false && r.needInstall === true && /127\.0\.0\.1 上还没有 code-server/.test(r.error), '没装:返回 needInstall,由渲染层询问是否安装', r);
  assert(windows.length === 0 && !W.calls.some((c) => c.includes('curl')), '没装:不开窗口、不下载');

  // 3) 装了但没在运行 → 按需启动
  // 模拟窗口导航;密码是异步读出再发事件的,等它送达
  const nav = async (w, url) => {
    w.navigate(url);
    await new Promise((res) => setTimeout(res, 40));
  };
  const pwEvents = () => sent.filter((s) => s.channel === 'code-server:password').map((s) => s.payload);
  const port = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${port}\nauth: password\npassword: 'pw-123'\n` });
  r = await open(DIR);
  assert(r.ok === true && r.url === `http://127.0.0.1:${port}/${FOLDER}`, '装了但没在运行:按需启动', r);
  assert(W.isUp(port) && starts().length === 1 && lastUrl() === r.url && !windows[windows.length - 1].preload, '已在监听、窗口已开(不加载粘贴钩子)');
  // 再点一次:已在运行,直接用,不重复启动
  r = await open(DIR);
  assert(r.ok && starts().length === 1, '已在运行:直接用,不重复启动', r);

  // 登录密码:窗口真的落到登录页时才交给用户 —— 已登录直接进项目不给,会话过期退回登录页再给一次
  const winPw = windows[windows.length - 1].win;
  assert(pwEvents().length === 0, '刚开窗时不去读密码');
  await nav(winPw, `http://127.0.0.1:${port}/${FOLDER}`);
  assert(pwEvents().length === 0, '已登录(直接进项目):不给密码');
  await nav(winPw, `http://127.0.0.1:${port}/login?folder=%2Fhome%2Fu%2Fproj`);
  assert(pwEvents().length === 1 && pwEvents()[0].password === 'pw-123' && pwEvents()[0].host === '127.0.0.1', '落到登录页:把服务器上 code-server 的登录密码交给用户', JSON.stringify(pwEvents()));
  await nav(winPw, `http://127.0.0.1:${port}/login?folder=%2Fhome%2Fu%2Fproj`);
  assert(pwEvents().length === 1, '同一个登录页不重复给');
  await nav(winPw, `http://127.0.0.1:${port}/`);
  await nav(winPw, `http://127.0.0.1:${port}/login`);
  assert(pwEvents().length === 2, '会话过期退回登录页:再给一次');

  // 无密码认证的实例:落到登录页也没有密码可给
  const portNone = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portNone}\nauth: none\n` });
  await open(DIR);
  await nav(windows[windows.length - 1].win, `http://127.0.0.1:${portNone}/login`);
  assert(pwEvents().length === 2, '无密码认证:不给密码');

  // 系统自己装的 code-server:按它自己的路径启动
  const portSys = await W.freePort();
  W = createWorld({ bin: '/usr/bin/code-server', config: `bind-addr: 127.0.0.1:${portSys}\n` });
  r = await open(DIR);
  assert(r.ok && r.url === `http://127.0.0.1:${portSys}/${FOLDER}` && starts()[0].command.includes("nohup '/usr/bin/code-server' --bind-addr 0.0.0.0:" + portSys), '系统安装的 code-server:按它自己的路径启动(监听改 0.0.0.0 以便本机访问)', starts()[0].command.slice(0, 90));

  // 3b) 想用的端口被别的 Web 程序占着(真实服务器上 8080 常这样):不能把它当成 code-server 打开,
  //     顺延到下一个端口按需启动,窗口开在真正是 code-server 的地址上
  const portBusy = await W.freePort();
  W = createWorld({ appBin: true, busyPorts: [portBusy], config: `bind-addr: 0.0.0.0:${portBusy}\nauth: password\npassword: 'pw-busy'\n` });
  await W.listen(portBusy, { foreign: true });
  const nBefore = windows.length;
  r = await open(DIR);
  assert(r.ok === true && r.url === `http://127.0.0.1:${portBusy + 1}/${FOLDER}` && lastUrl() === r.url, '端口被别的 Web 程序占着:不开到它的地址上,顺延端口启动真正的 code-server', JSON.stringify(r));
  assert(!windows.slice(nBefore).some((w) => w.url.includes(`:${portBusy}/`)) && W.isUp(portBusy) && W.isUp(portBusy + 1), '那个程序原样没被动过', `${W.isUp(portBusy)} / ${W.isUp(portBusy + 1)}`);
  await nav(windows[windows.length - 1].win, `http://127.0.0.1:${portBusy + 1}/login`);
  const pwBusy = pwEvents().slice(-1)[0];
  assert(!!pwBusy && pwBusy.password === 'pw-busy', '顺延后的实例:落到登录页时给的密码是它的', JSON.stringify(pwBusy));
  const shiftedState = await handlers['code-server:state']({}, { target: { mode: 'remote', remoteId: 'A' } });
  const shiftedStarts = starts().length;
  const reopened = await open(DIR);
  assert(shiftedState.ok && shiftedState.running && shiftedState.owned && shiftedState.port === portBusy + 1, '顺延实例状态:运行中、归属正确且返回实际端口', shiftedState);
  assert(reopened.ok && reopened.url === r.url && starts().length === shiftedStarts, '重复打开顺延实例:复用已有服务,不再启动新实例', reopened);

  // 4) 用户自管的地址(反向代理后面 / 别的主机):访问不到就说明,不代为启动
  const portDead = await W.freePort();
  W = createWorld({ appBin: true });
  config.save({ remotes: [profile('127.0.0.1', { codeServerUrl: 'https://code.example.com/vscode/' })] });
  let before = starts().length;
  r = await open(DIR);
  assert(r.ok === false && /没在运行或本机访问不到:https:\/\/code\.example\.com\/vscode.*不代为启动/.test(r.error) && starts().length === before, '反向代理下的地址:访问不到时说明原因,不代为启动', r);
  config.save({ remotes: [profile('127.0.0.1', { codeServerUrl: 'http://10.9.9.9:9000' })] });
  before = starts().length;
  r = await open(DIR);
  assert(r.ok === false && starts().length === before, '别的主机上的地址:不代为启动', r);

  // 填的就是「本服务器:端口」→ 仍由本应用启动,用填的端口
  W = createWorld({ appBin: true, config: 'bind-addr: 127.0.0.1:8080\n' });
  config.save({ remotes: [profile('127.0.0.1', { codeServerUrl: `127.0.0.1:${portDead}` })] });
  r = await open(DIR);
  assert(r.ok === true && r.url === `http://127.0.0.1:${portDead}/${FOLDER}`, '填了「本服务器:端口」:按该端口按需启动', r);
  config.save({ remotes: [profile('127.0.0.1', { codeServerUrl: 'ftp://x' })] });
  before = windows.length;
  r = await open(DIR);
  assert(r.ok === false && /无效/.test(r.error) && windows.length === before, '地址无效:报错且不开窗口', r);

  // 5) 本机目标:优先用桌面版 VS Code 打开;没装才看在运行的 code-server;都不行就说明怎么办
  const portLocal = await W.freePort();
  W = createWorld();
  localEditor.found = true;
  config.save({ mode: 'local', codeServerUrl: '', remotes: [profile('127.0.0.1')] });
  const winBeforeLocal = windows.length;
  r = await open('C:\\proj');
  assert(r.ok === true && r.app === 'vscode' && localEditor.opened.slice(-1)[0] === 'C:\\proj' && windows.length === winBeforeLocal && W.calls.length === 0, '本机(装了 VS Code):直接用它打开,不开窗口、不发 SSH', JSON.stringify([r, localEditor.opened.slice(-1)]));
  // 显式填了 codeServerUrl:按填的来(不偷偷改用 VS Code)
  config.save({ codeServerUrl: `http://127.0.0.1:${portLocal}` });
  const nVscode = localEditor.opened.length;
  await W.listen(portLocal);
  r = await open('C:\\proj');
  assert(r.ok === true && r.url === `http://127.0.0.1:${portLocal}/?folder=C%3A%5Cproj` && starts().length === 0 && localEditor.opened.length === nVscode, '本机(填了地址且在运行):按填的地址开窗口,不动 VS Code', r);
  const pwBeforeLocal = pwEvents().length;
  await nav(windows[windows.length - 1].win, `http://127.0.0.1:${portLocal}/login`);
  assert(pwEvents().length === pwBeforeLocal, '本机目标:不知道密码从哪读,不给密码');
  // 没装 VS Code、也没在运行的 code-server:说明两条出路
  localEditor.found = false;
  config.save({ codeServerUrl: '' });
  r = await open('C:\\proj');
  assert(r.ok === false && /本机没找到 VS Code.*codeServerUrl/.test(r.error) && W.calls.length === 0, '本机(没装 VS Code、code-server 没在运行):说明安装 VS Code 或填 codeServerUrl,不发 SSH', r);

  // 6) 安装前的确认框:默认焦点在「取消」
  config.save({ mode: 'remote', codeServerUrl: '', remotes: [profile('10.0.0.1')] });
  let c = await handlers['code-server:confirmInstall']({}, undefined);
  const dlg = dialogCalls[dialogCalls.length - 1];
  const opts = dlg[dlg.length - 1];
  assert(c.confirmed === false && opts.buttons[0] === '安装' && opts.buttons[1] === '取消' && opts.defaultId === 1 && opts.cancelId === 1, '确认框:默认选中「取消」', opts.buttons);
  assert(/u@10\.0\.0\.1 上还没有 code-server/.test(opts.message) && /可选组件/.test(opts.detail) && /不需要 root/.test(opts.detail), '确认框:说明是哪台服务器、可选、免 root', opts.message);
  W = createWorld({ dialogResponse: 0 });
  c = await handlers['code-server:confirmInstall']({}, undefined);
  assert(c.confirmed === true, '确认框:选「安装」才继续');

  // 7) 一键安装:进度写进更新日志;失败如实返回;与其它安装/更新互斥
  W = createWorld();
  r = await handlers['code-server:install']({}, undefined);
  assert(r.ok === true && r.version === '4.146.0' && /—— 开始安装 ——/.test(updateLogs()) && /下载中 /.test(updateLogs()) && /✅ 安装完成,版本 4\.146\.0/.test(updateLogs()), '安装成功:日志进「更新日志」', r);
  assert(sent.filter((s) => s.channel === 'update:log').every((s) => s.payload.target === 'code-server'), '安装日志的 target 是 code-server(渲染层据此打标签)');

  W = createWorld({ downloadFail: 'all' });
  r = await handlers['code-server:install']({}, undefined);
  assert(r.ok === false && /下载 code-server 失败/.test(r.error) && /❌ 安装失败/.test(updateLogs()), '安装失败:原因返回并写进日志', r);

  W = createWorld();
  const first = handlers['code-server:install']({}, undefined);
  const second = await handlers['code-server:install']({}, undefined);
  assert(/已有安装或更新任务在进行中/.test(second.error) && (await first).ok === true, '安装进行中:再次安装被拒(与安装/更新互斥)', second);
  W = createWorld();
  config.save({ mode: 'local', codeServerUrl: '' });
  r = await handlers['code-server:install']({}, undefined);
  assert(r.ok === false && /只能在远程服务器上一键安装/.test(r.error) && W.calls.length === 0, '本机目标:不提供一键安装', r);

  // 8) 复制到剪贴板(把登录密码交给用户):写入是异步的,等它真正完成才算成功;写不进去时如实返回
  copyState.fail = false;
  copyState.delayMs = 30;
  let settled = false;
  const cpP = handlers['shell:copy']({}, 'abc').then((r) => { settled = true; return r; });
  await new Promise((res) => setTimeout(res, 5));
  assert(settled === false, '写入还没完成:不提前报成功');
  const cp = await cpP;
  assert(cp.ok === true && copied[copied.length - 1] === 'abc', '复制完成:返回成功');
  copyState.fail = true;
  const cpFail = await handlers['shell:copy']({}, 'abc');
  copyState.delayMs = 0;
  assert(cpFail.ok === false && /writing to the clipboard/.test(cpFail.error || ''), '写入失败:如实返回失败与原因(界面据此改为直接显示密码)', JSON.stringify(cpFail));
  copyState.fail = false;
  for (const bad of ['', 42, null, 'x'.repeat(5000)]) assert((await handlers['shell:copy']({}, bad)).ok === false && copied[copied.length - 1] === 'abc', `拒绝复制:${JSON.stringify(bad) === '""' ? '空' : typeof bad}`);

  // 9) 「新窗口」已下掉(本地用 VS Code、远程用 code-server):page:open 不再注册;剩下的窗口只有 code-server 的,不带粘贴 preload
  assert(!('page:open' in handlers), 'page:open 已随「新窗口」按钮移除');
  const portS9 = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portS9}\n` });
  config.save({ mode: 'remote', codeServerUrl: '', remotes: [profile('127.0.0.1')] });
  const n0 = windows.length;
  await open(DIR);
  const pw = windows.slice(n0).pop();
  assert(!!pw && (pw.preload === undefined || pw.preload === ''), 'code-server 窗口不加载 webview 的「粘贴文件路径」preload', pw && pw.preload);
  await codeServer.stopAll();

  // 10) 退出回收:只回收本应用启动的实例
  const portA = await W.freePort();
  const portB = await W.freePort(); // 用户自己的服务:本来就在运行,不是本应用启动的
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portA}\n` });
  await W.listen(portB);
  config.save({ mode: 'remote', codeServerUrl: '', remotes: [profile('127.0.0.1')] });
  await open(DIR);
  await handlers['editor:open']({}, '/other'); // 再开一次:portA 已在运行,不会重复启动
  await codeServer.stopAll();
  assert(W.isUp(portA) === false && W.isUp(portB) === true, '退出回收:结束本应用启动的实例,不动用户自己的服务', `A=${W.isUp(portA)} B=${W.isUp(portB)}`);

  // 11) 上次应用被强杀留在服务器上的实例:再点按钮直接复用,并认领回来(退出时一并回收)
  const portO = await W.freePort();
  const portU = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portO}\nauth: password\npassword: 'orphan-pw'\n` });
  await W.listen(portO);
  await W.listen(portU); // 用户自己起的服务:没有本应用的 pid 文件
  W.world.orphans.push({ port: portO, pid: 31337, args: `/home/u/.pi-web-desktop/code-server --bind-addr 0.0.0.0:${portO}` });
  const nStart = starts().length;
  r = await open(DIR);
  assert(r.ok === true && r.url === `http://127.0.0.1:${portO}/${FOLDER}` && starts().length === nStart && lastUrl() === r.url, '上次留在服务器上的实例还在运行:直接用它打开,不重复启动', JSON.stringify(r));
  await nav(windows[windows.length - 1].win, `http://127.0.0.1:${portO}/login`);
  const pwOrphan = pwEvents().slice(-1)[0];
  assert(!!pwOrphan && pwOrphan.password === 'orphan-pw', '落到登录页:密码照给', JSON.stringify(pwOrphan));
  await codeServer.stopAll();
  assert(W.isUp(portO) === false && W.isUp(portU) === true && W.world.orphans.length === 0, '认领回来的实例退出时回收;用户自己的服务不动', `${W.isUp(portO)} / ${W.isUp(portU)} / ${JSON.stringify(W.world.orphans)}`);

  // pid 文件过期(PID 已被别的进程复用):不算遗留实例。在运行的实例照样直接用,退出时不回收
  const portR = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portR}\n` });
  await W.listen(portR);
  W.world.orphans.push({ port: portR, pid: 31338, args: 'python3 -m http.server ' + portR });
  r = await open(DIR);
  assert(r.ok === true && r.url === `http://127.0.0.1:${portR}/${FOLDER}` && W.world.orphans.length === 0, '过期 pid 文件:在运行的实例照样直接用,过期文件顺带清掉', JSON.stringify(r));
  await codeServer.stopAll();
  assert(W.isUp(portR) === true && W.events.filter((e) => e.type === 'kill').length === 0, '不算本应用启动的:退出时不回收');

  /* ---------- Code Server 配置卡的管理 handler(state/save/start/stop/打开) ---------- */
  const csState = () => handlers['code-server:state']({}, { target: { mode: 'remote', remoteId: 'A' } });
  const csStart2 = () => handlers['code-server:start']({}, { target: { mode: 'remote', remoteId: 'A' } });
  const portS = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portS}\nauth: password\npassword: old-pw\ncert: false\n` });
  config.save({ mode: 'remote', activeRemoteId: 'A', codeServerUrl: '', remotes: [profile('127.0.0.1')] });
  let st = await csState();
  assert(st.ok === true && st.managed === true && st.running === false && st.info.installed === true && String(st.port) === String(portS) && st.info.password === 'old-pw', 'state:按目标返回托管状态(安装/端口/密码),未运行', JSON.stringify(st).slice(0, 200));
  // save:把监听端口/密码写进服务器 config.yaml
  r = await handlers['code-server:save']({}, { target: { mode: 'remote', remoteId: 'A' }, port: 18000 + (portS % 1000), password: 'new-pw' });
  assert(r.ok === true && String(r.conf.bindPort) === String(18000 + (portS % 1000)) && r.conf.password === 'new-pw' && /^bind-addr: 0\.0\.0\.0:/.test(W.world.config), 'save:端口/密码写入 config.yaml', JSON.stringify(r));
  // start:没运行且已安装 → 真启动(假世界监听端口);浏览器事件带 update:log
  r = await csStart2();
  assert(r.ok === true && !!r.url && W.events.some((e) => e.type === 'start'), 'start:按需启动并返回地址', JSON.stringify(r));
  st = await csState();
  assert(st.ok === true && st.running === true && st.owned === true, '启动后 state:运行中且为本应用启动', JSON.stringify(st).slice(0, 160));
  assert(sent.some((s) => s.channel === 'update:log' && s.payload.target === 'code-server'), '启动日志进「更新日志」');
  // stop:结束自己的实例
  r = await handlers['code-server:stop']({}, { target: { mode: 'remote', remoteId: 'A' }, port: st.port });
  assert(r.ok === true && r.ours >= 1, 'stop:结束本应用启动的实例', JSON.stringify(r));
  // confirmForceStop:默认取消(无外部实例时也应有可用返回值,不能抛「getWindow is not defined」)
  const cf = await handlers['code-server:confirmForceStop']({}, { target: { mode: 'remote', remoteId: 'A' }, port: 12345 });
  assert(cf && typeof cf.confirmed === 'boolean' && dialogCalls.length > 0, 'confirmForceStop:弹原生确认框并返回布尔', JSON.stringify(cf));
  // open:按需启动并开窗口(无需 folder)
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portS}\n` });
  const nWin = windows.length;
  r = await handlers['code-server:open']({}, { target: { mode: 'remote', remoteId: 'A' } });
  assert(r.ok === true && windows.length === nWin + 1 && !String(lastUrl()).includes('folder=') && String(lastUrl()).startsWith('http://127.0.0.1:'), 'open:启动并按地址开独立窗口(不带 folder)', JSON.stringify({ r, url: lastUrl() }));

  await W.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : 'IPC code-server 打开当前项目 + 配置卡管理(可选组件,按需安装/启动): 全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('TEST ERR:', e.stack || e.message);
  process.exit(1);
});
