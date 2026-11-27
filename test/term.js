// SSH 终端自检(离线:mock electron + 替身 ssh2 Client,真实 lib/term.js / lib/remote.js / lib/ipc.js)。
// 覆盖:会话生命周期(start/write/resize/stop/断连联动)、启动脚本(exec + PTY、真彩色与 locale 兜底、
// 代理继承及其失败、tmux 保活及服务器没装的情况)、term:paste 剪贴板三态仲裁
// (截图 → SFTP 写 /tmp;复制的文件 → fastPut;文本 → 直返)、上传文件名 sanitize。
// 运行:node test/term.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const LIB = path.join(__dirname, '..', 'lib');
const IPC_PATH = path.join(LIB, 'ipc.js');
const REMOTE_PATH = path.join(LIB, 'remote.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-'));
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify({ mode: 'remote', autoStart: false, activeRemoteId: 'A', remotes: [{ id: 'A', host: '10.0.0.1', port: 22, user: 'u', authType: 'password', password: 'p' }] })
);

let failed = 0;
function assert(cond, msg, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}${cond || detail === undefined ? '' : `  [${JSON.stringify(detail)}]`}`);
  if (!cond) failed += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 替身 ssh2 Client:shell()/sftp() 可编程 ---------- */
const clients = [];
// 交互式 shell 通道替身:只实现 term.js 用到的接口(on/emit/write/end/close/setWindow)
class FakeShell extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts || {};
    this.written = [];
    this.windows = [];
    this.emittedClose = false;
  }
  write(chunk) {
    this.written.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
    return true;
  }
  end() { this.emitClose(); }
  close() { this.emitClose(); }
  emitClose() {
    if (!this.emittedClose) {
      this.emittedClose = true;
      this.emit('close');
    }
  }
  setWindow(rows, cols) { this.windows.push({ rows, cols }); }
  // 测试辅助:模拟远程输出
  output(s) { this.emit('data', Buffer.from(s, 'utf8')); }
}
const remoteFiles = new Map([['/tmp/report.txt', Buffer.from('existing remote file')]]);
const remoteDirs = new Set(['/tmp']);
function makeSftp() {
  return {
    dirs: [],
    mkdir: (remote, opts, cb) => {
      if (remoteDirs.has(remote)) return setImmediate(() => cb(new Error('Already exists')));
      remoteDirs.add(remote);
      sftpCurrent.dirs.push({ remote, mode: opts.mode });
      setImmediate(() => cb(null));
    },
    writes: [], // { remote, buffer } ← 截图等内存数据
    puts: [],   // { localPath, remote } ← 本地文件
    createWriteStream: (remote) => {
      const ws = new EventEmitter();
      ws.end = (buf) => {
        setImmediate(() => {
          remoteFiles.set(remote, Buffer.from(buf));
          sftpCurrent.writes.push({ remote, buffer: buf ? Buffer.from(buf) : null });
          ws.emit('close');
        });
      };
      return ws;
    },
    fastPut: (localPath, remote, cb) => {
      remoteFiles.set(remote, Buffer.from(localPath));
      sftpCurrent.puts.push({ localPath, remote });
      setImmediate(() => cb(null));
    },
    end() {},
  };
}
let sftpCurrent = makeSftp();
// 探测命令的应答通道(不带 PTY 的 exec,如开会话前查 tmux):回放预设输出后以给定退出码结束
class FakeProbe extends EventEmitter {
  constructor(reply) {
    super();
    this.stderr = new EventEmitter();
    setImmediate(() => {
      this.emit('data', Buffer.from(reply.stdout || ''));
      this.emit('close', reply.code === undefined ? 0 : reply.code);
    });
  }
}
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.shells = []; // 带 PTY 的 exec(交互式 shell 通道)
    this.execs = [];  // 每次 exec 的 { cmd, pty }:验证真实的调用形态
    this.probe = null; // 不带 PTY 的 exec 的应答函数(cmd → { code, stdout });为 null 表示 exec 直接报错
    clients.push(this);
  }
  connect() { setImmediate(() => this.emit('ready')); }
  end() { setImmediate(() => this.emit('close')); }
  exec(cmd, opts, cb) {
    if (typeof opts === 'function') [opts, cb] = [null, opts]; // remote.js 的探测不带选项:exec(cmd, cb)
    const pty = (opts && opts.pty) || null;
    this.execs.push({ cmd, pty });
    if (!pty) {
      setImmediate(() => cb(this.probe ? null : new Error('本测试不执行远程命令'), this.probe ? new FakeProbe(this.probe(cmd)) : undefined));
      return;
    }
    const s = new FakeShell(pty);
    this.shells.push(s);
    setImmediate(() => cb(null, s));
  }
  sftp(cb) { setImmediate(() => cb(null, sftpCurrent)); }
}

/* ---------- 替身 electron / webview-files:剪贴板状态可编程(对齐 Electron 44 异步 W3C 形态) ---------- */
const handlers = {};
const sent = []; // 主窗口收到的事件 { channel, payload }
const fakeWin = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } };
const clipState = { image: null, text: '', writes: [], writeFail: false, hasFiles: false, hasThrows: false, hasCalls: [] }; // image: null 或 { mime, bytes };writes 记录经 clipboard:write 写入的文本;hasFiles:类型表里有没有 text/uri-list(= 剪贴板里有复制的文件)
const fileClipboard = []; // 「复制的文件」路径列表
let fileQueries = 0; // 查文件列表(真实实现里是起一次 PowerShell)的次数
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // 假 PNG 头

const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
      shell: {},
      BrowserWindow: function FakeBrowserWindow() {},
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      clipboard: {
        read: async () =>
          clipState.image
            ? [{ types: [clipState.image.mime], getType: async (t) => new Blob([clipState.image.bytes], { type: t }) }]
            : [],
        readText: async () => clipState.text,
        has: async (mime) => {
          clipState.hasCalls.push(mime);
          if (clipState.hasThrows) throw new Error('所请求的剪贴板操作失败');
          return mime === 'text/uri-list' && clipState.hasFiles;
        },
        writeText: async (t) => {
          if (clipState.writeFail) throw new Error('打开剪贴板失败');
          clipState.writes.push(String(t));
          clipState.text = String(t);
        },
      },
      app: { getPath: () => tmp },
    };
  }
  if (request === 'ssh2' && args[0] && path.resolve(args[0].filename || '') === REMOTE_PATH) return { Client: FakeClient };
  if (request === './webview-files' && args[0] && path.resolve(args[0].filename || '') === IPC_PATH) {
    return {
      readClipboardFilePaths: async () => {
        fileQueries += 1;
        return fileClipboard.slice();
      },
    };
  }
  return origLoad.apply(this, [request, ...args]);
};

const term = require(path.join(LIB, 'term'));
require(IPC_PATH).register({ getWindow: () => fakeWin, onConfigChange: null });

const starts = () => handlers['term:start']({}, { target: { mode: 'remote', remoteId: 'A' } });
const write = (id, data) => handlers['term:write']({}, { id, data });
const dataEvents = () => sent.filter((s) => s.channel === 'term:data');
const exitEvents = () => sent.filter((s) => s.channel === 'term:exit');

(async () => {
  assert(!!handlers['term:start'] && !!handlers['term:write'] && !!handlers['term:resize'] && !!handlers['term:stop'] && !!handlers['term:paste'], 'term:* IPC handler 已注册');

  // 1) 本机目标:明确拒绝
  let r = await handlers['term:start']({}, { target: { mode: 'local' } });
  assert(r.ok === false && /仅支持/.test(r.error), '本机目标不能开终端', r);

  // 2) 开会话:走真实 ensureConnected,经 exec + PTY 打开,拿到 xterm-256color 与初始尺寸
  r = await starts();
  const id = r.id;
  assert(r.ok === true && typeof id === 'string' && r.mode === 'remote' && r.remoteId === 'A', '远程目标开会话成功并带目标标识', r);
  const shell = clients[0].shells[0];
  assert(clients.length === 1 && !!shell && shell.opts.term === 'xterm-256color' && shell.opts.cols === 80 && shell.opts.rows === 24, 'PTY 以 xterm-256color 与初始 cols/rows 打开', shell && shell.opts);
  const firstCmd = clients[0].execs[0];
  assert(firstCmd && firstCmd.pty && firstCmd.cmd === term.launchScript({}), '启动命令 = launchScript 的产物,经同一次 exec 连同 PTY 选项下发', firstCmd && firstCmd.cmd);
  assert(r.proxy === false && r.proxyError === '' && r.tmux === 'off' && r.tmuxVersion === '', '没配代理、没开保活:facts 如实返回(不带代理、不在 tmux 里)', r);

  // 3) 键入 → 写进 PTY;远程输出 → term:data 以字节直传(中文多字节不损坏)
  r = await write(id, 'ls -la\r');
  assert(r.ok === true && shell.written.join('') === 'ls -la\r', '键入内容写进 PTY', shell.written);
  shell.output('你好,世界');
  await sleep(20);
  let evs = dataEvents();
  assert(evs.length === 1 && evs[0].payload.id === id && Buffer.from(evs[0].payload.data).toString('utf8') === '你好,世界', '远程输出经 term:data 转发(UTF-8 完整)', evs.map((e) => e.payload.data));
  // 多字节被块边界切开:两个 data 事件拼接后仍是原文(渲染层用流式 TextDecoder 解)
  shell.output('截');
  const half = Buffer.from('断', 'utf8');
  shell.emit('data', half.subarray(0, 1));
  shell.emit('data', half.subarray(1));
  await sleep(20);
  evs = dataEvents();
  const joined = Buffer.concat(evs.slice(1).map((e) => Buffer.from(e.payload.data))).toString('utf8');
  assert(joined === '截断', '多字节跨块:字节原样透传(不在主进程按块转字符串)', joined);

  // 4) resize:越界值被钳制
  r = await handlers['term:resize']({}, { id, cols: 9999, rows: 1 });
  assert(r.ok === true && shell.windows.length === 1 && shell.windows[0].cols === 500 && shell.windows[0].rows === 2, 'resize 越界钳制(cols≤500/rows≥2)', shell.windows);

  // 5) 参数校验:超长输入 / 非法 id
  r = await write(id, 'x'.repeat(65537));
  assert(r.ok === false && /参数不合法/.test(r.error), '超过 64KB 的输入被拒绝', r.error);
  r = await write('t-nope', 'hi');
  assert(r.ok === false && /不存在或已断开/.test(r.error), '未知会话写入报错', r.error);

  // 6) 主动 stop:term:exit 恰好一次,幂等
  r = await handlers['term:stop']({}, { id });
  r = await handlers['term:stop']({}, { id });
  await sleep(20);
  const exits = exitEvents().filter((e) => e.payload.id === id);
  assert(r.ok === true && exits.length === 1, 'stop 触发一次 term:exit,重复 stop 幂等', exits.length);
  r = await write(id, 'x');
  assert(r.ok === false, '已停止的会话不能写入', r);

  // 7) SSH 连接断开(网络断/档案变更):该目标上的会话自动结束
  r = await starts();
  const id2 = r.id;
  clients[0].emit('close'); // 同一条连接断开(remote.js 会通知 term 层)
  await sleep(20);
  assert(exitEvents().some((e) => e.payload.id === id2 && e.payload.reason === 'disconnected'), 'SSH 断开 → 会话以 disconnected 结束', exitEvents().map((e) => e.payload));
  assert(term.stopAll() === undefined, 'stopAll 不抛错');

  /* ---------- term:paste 剪贴板三态 ---------- */
  const WIN = process.platform === 'win32'; // 「有文本且没有文件就不查文件列表」的快路径只在 Windows 上开
  clipState.image = { mime: 'image/png', bytes: pngBytes };
  fileClipboard.length = 0;
  clipState.text = 'leftover text';
  r = await handlers['term:paste']({}, { target: { mode: 'remote', remoteId: 'A' } });
  assert(r.ok === true && r.type === 'uploaded' && r.paths.length === 1, '剪贴板是截图:返回 uploaded 与路径', r);
  assert(/^\/tmp\/pi-paste-[a-f0-9-]+\/pi-paste-\d{8}-\d{6}-\d{3}\.png$/.test(r.paths[0]), '截图按时间戳命名进 /tmp 下的独立目录', r.paths && r.paths[0]);
  assert(sftpCurrent.writes.length === 1 && sftpCurrent.writes[0].remote === r.paths[0] && sftpCurrent.writes[0].buffer.equals(pngBytes), '截图 PNG 字节经 SFTP 写到该路径', sftpCurrent.writes.map((w) => w.remote));

  // 剪贴板同时带着(上一步遗留的)文本:复制的文件仍优先于文本
  clipState.image = null;
  fileClipboard.push('C:\\Users\\x\\my file.png', 'D:\\data\\a.txt');
  clipState.hasFiles = true; // 与真实剪贴板一致:有 CF_HDROP 时类型表里就有 text/uri-list
  sftpCurrent = makeSftp();
  r = await handlers['term:paste']({}, { target: { mode: 'remote', remoteId: 'A' } });
  assert(r.ok === true && r.type === 'uploaded' && r.paths.length === 2, '剪贴板是复制的文件:逐个上传', r);
  assert(sftpCurrent.puts.length === 2 && sftpCurrent.puts.some((p) => path.posix.basename(p.remote) === 'my file.png') && sftpCurrent.puts.some((p) => path.posix.basename(p.remote) === 'a.txt'), '本地文件 fastPut 到独立目录(取 basename)', sftpCurrent.puts.map((p) => p.remote));

  fileClipboard.push('E:\\same\\a.txt'); // 同批重名 → -1 后缀
  sftpCurrent = makeSftp();
  r = await handlers['term:paste']({}, { target: { mode: 'remote', remoteId: 'A' } });
  assert(r.paths.filter((p) => path.posix.basename(p) === 'a.txt').length === 1 && r.paths.some((p) => path.posix.basename(p) === 'a-1.txt'), '同批重名自动加 -N 后缀', r.paths);

  const uploadCfg = require('../lib/config').get();
  const first = await term.upload(uploadCfg, [{ name: 'report.txt', buffer: Buffer.from('first upload') }]);
  const second = await term.upload(uploadCfg, [{ name: 'report.txt', buffer: Buffer.from('second upload') }]);
  assert(first[0] !== second[0] && remoteFiles.get(first[0]).toString() === 'first upload' && remoteFiles.get(second[0]).toString() === 'second upload', '分批上传同名文件:路径不同,先前上传内容保留');
  assert(remoteFiles.get('/tmp/report.txt').toString() === 'existing remote file' && sftpCurrent.dirs.every((d) => d.mode === 0o700), '已有 /tmp 同名文件不受影响,上传目录仅当前用户可访问');
  const writeCount = sftpCurrent.writes.length;
  sftpCurrent.mkdir = (_dir, _opts, cb) => cb(new Error('Already exists'));
  let mkdirFailed = false;
  try { await term.upload(uploadCfg, [{ name: 'report.txt', buffer: Buffer.from('blocked') }]); } catch { mkdirFailed = true; }
  assert(mkdirFailed && sftpCurrent.writes.length === writeCount, '独立目录创建失败时拒绝写入');
  sftpCurrent = makeSftp();

  // 纯文本:类型表说没有文件 → 直接按文本返回,不去查文件列表(查一次要起 PowerShell、两秒多,粘贴不该等它)
  fileClipboard.length = 0;
  clipState.text = 'plain text';
  clipState.hasFiles = false;
  clipState.hasThrows = false;
  clipState.hasCalls.length = 0;
  const queriesBefore = fileQueries;
  r = await handlers['term:paste']({}, { target: { mode: 'remote', remoteId: 'A' } });
  assert(r.ok === true && r.type === 'text' && r.text === 'plain text', '剪贴板是文本:按普通粘贴返回', r);
  if (WIN) {
    assert(clipState.hasCalls.length === 1 && clipState.hasCalls[0] === 'text/uri-list', 'Windows:用 clipboard.has(text/uri-list) 在进程内判断有没有文件', clipState.hasCalls);
    assert(fileQueries === queriesBefore, 'Windows:文本且没有文件 → 不查文件列表(不为此起 PowerShell)', { 之前: queriesBefore, 之后: fileQueries });
  }

  // 问不出来(剪贴板被别的程序占着):按「可能有文件」处理,照旧查文件列表
  clipState.hasThrows = true;
  fileClipboard.push('E:\\copy\\notes.md');
  sftpCurrent = makeSftp();
  r = await handlers['term:paste']({}, { target: { mode: 'remote', remoteId: 'A' } });
  assert(r.ok === true && r.type === 'uploaded' && r.paths.length === 1, 'clipboard.has() 报错:退回查文件列表,文件照常上传', r);

  // 剪贴板里没有文本:即使类型表说没有文件也照查(不能凭一张空的类型表断定没有文件)
  clipState.hasThrows = false;
  clipState.hasFiles = false;
  clipState.text = '';
  fileClipboard.length = 0;
  fileClipboard.push('F:\\pics\\shot.png');
  sftpCurrent = makeSftp();
  r = await handlers['term:paste']({}, { target: { mode: 'remote', remoteId: 'A' } });
  assert(r.ok === true && r.type === 'uploaded' && r.paths.length === 1 && path.posix.basename(r.paths[0]) === 'shot.png', '没有文本:仍查文件列表,复制的是文件就上传', r);

  fileClipboard.length = 0;
  r = await handlers['term:paste']({}, { target: { mode: 'remote', remoteId: 'A' } });
  assert(r.ok === true && r.type === 'text' && r.text === '', '什么都没有(既无图片、文件,也无文本):返回空文本,不报错', r);

  r = await handlers['term:paste']({}, { target: { mode: 'local' } });
  assert(r.ok === false && /仅远程/.test(r.error), '本机目标不能上传', r);

  /* ---------- OSC 52:终端里远端程序请求写入本机剪贴板(clipboard:write) ---------- */
  clipState.writes.length = 0;
  r = await handlers['clipboard:write']({}, '从 herdr 选中的一行');
  assert(r.ok === true && clipState.writes.join('|') === '从 herdr 选中的一行', 'OSC 52 写入:文本原样写进系统剪贴板', r);
  r = await handlers['clipboard:write']({}, '');
  assert(r.ok === true && clipState.writes.length === 2 && clipState.writes[1] === '', 'OSC 52 空负载:写入空串(= 清空剪贴板),空串本身是合法内容', r);
  r = await handlers['clipboard:write']({}, 123);
  assert(r.ok === false && clipState.writes.length === 2, 'clipboard:write 拒绝非字符串', r);
  r = await handlers['clipboard:write']({}, 'x'.repeat(4 * 1024 * 1024 + 1));
  assert(r.ok === false && clipState.writes.length === 2, 'clipboard:write 拒绝超过 4MB 的内容', r);
  clipState.writeFail = true;
  r = await handlers['clipboard:write']({}, '写不进去');
  clipState.writeFail = false;
  assert(r.ok === false && /打开剪贴板失败/.test(r.error) && clipState.writes.length === 2, 'clipboard:write 写入失败(剪贴板被占用):如实返回原因', r);

  /* ---------- 会话启动:launchScript 文本 / 代理继承 / tmux 保活 ---------- */
  // launchScript:整段脚本经单引号包裹送达远端,末尾以登录 shell 收尾
  const plain = term.launchScript({});
  assert(/^bash -c '.*'$/.test(plain) && plain.endsWith(`; exec -l "$SHELL"'`), 'launchScript:bash -c 包裹,exec 成登录 shell', plain);
  assert(plain.includes('export COLORTERM=truecolor') && plain.includes('case "${LANG:-}" in *[Uu][Tt][Ff]*) ;; *)'), 'launchScript:声明真彩色;LANG 已是 UTF-8 就不动', plain);
  assert(
    /case "\$\{LANG:-\}" in \*\[Uu\]\[Tt\]\[Ff\]\*\) ;; \*\) for l in C\.utf8 C\.UTF-8 en_US\.utf8 en_US\.UTF-8; do locale -a 2>\/dev\/null \| grep -qix "\$l" && \{ export LANG="\$l"; break; \}; done ;; esac/.test(plain),
    'launchScript:LANG 不是 UTF-8 时只在服务器现成的 locale 里挑一个兜底',
    plain
  );
  assert(!plain.includes('tmux') && !plain.includes('proxy'), 'launchScript:默认不含代理与 tmux', plain);
  const PROXY_PREFIX = "http_proxy='http://10.9.8.7:3128' NO_PROXY='localhost,10.0.0.0/8' ";
  // 启动命令是 bash -c '<脚本>':脚本里的单引号转义成 '\'';断言脚本内容前先把外层引号还原
  const inner = (cmd) => cmd.replace(/^bash -c '/, '').replace(/'$/, '').replace(/'\\''/g, "'");
  const withProxy = term.launchScript({ proxyPrefix: PROXY_PREFIX });
  assert(
    inner(withProxy) ===
      `export ${PROXY_PREFIX}; export COLORTERM=truecolor; case "\${LANG:-}" in *[Uu][Tt][Ff]*) ;; *) for l in C.utf8 C.UTF-8 en_US.utf8 en_US.UTF-8; do locale -a 2>/dev/null | grep -qix "$l" && { export LANG="$l"; break; }; done ;; esac; exec -l "$SHELL"`,
    'launchScript:代理前缀(已 shellQuote 的 name=value 串)原样放在最前面(还原外层引号后逐字一致)',
    inner(withProxy)
  );
  assert(withProxy.includes(`export http_proxy='\\''http://10.9.8.7:3128'\\'' NO_PROXY='\\''localhost,10.0.0.0/8'\\'' ; export`), 'launchScript:前缀里的单引号随整段脚本一起转义', withProxy.slice(0, 140));
  const withTmux = term.launchScript({ proxyPrefix: PROXY_PREFIX, tmuxBin: '/usr/bin/tmux' });
  assert(inner(withTmux).includes('; exec \'/usr/bin/tmux\' -L \'pi-web-desktop\' attach-session -t main; exec -l "$SHELL"'), 'launchScript:只附着已准备的固定会话,不使用 -A', inner(withTmux));
  assert(inner(term.launchScript({ tmuxBin: '/opt/my tmux/tmux', tmuxSocket: "test's socket" })).includes("exec '/opt/my tmux/tmux' -L 'test'\\''s socket'"), 'launchScript:路径与内部 socket 参数安全引用');

  // 以下各项都从同一条 SSH 连接上开会话:取最近一次 exec 作为被测对象
  const config = require('../lib/config');
  const profileA = () => ({ id: 'A', host: '10.0.0.1', port: 22, user: 'u', authType: 'password', password: 'p' });
  const PROXY = { enabled: true, protocol: 'http', host: '10.9.8.7', port: 3128, bypass: 'localhost,10.0.0.0/8' };
  const setConfig = (patch) => config.save({ termProxy: true, termTmux: false, remotes: [profileA()], ...patch });
  const lastExec = () => clients[clients.length - 1].execs;
  const lastPty = () => lastExec().filter((e) => e.pty).pop();
  const lastProbes = () => lastExec().filter((e) => !e.pty);

  // 代理:配置里给这台服务器配了代理 → 默认继承进会话
  setConfig({ remotes: [{ ...profileA(), proxy: PROXY }] });
  const expectedPrefix = await require('../lib/proxy').remoteEnvPrefix(config.get()); // 真实模块产出的前缀(含不代理列表)
  lastExec().length = 0;
  r = await starts();
  assert(r.ok === true && r.proxy === true && r.proxyError === '', '配了代理且未关闭继承:会话带代理(facts.proxy)', r);
  const ptyCmd = inner(lastPty().cmd);
  assert(
    lastProbes().length === 0 &&
      ptyCmd.startsWith(`export ${expectedPrefix}; export COLORTERM=truecolor;`) &&
      ptyCmd.includes("http_proxy='http://10.9.8.7:3128' https_proxy='http://10.9.8.7:3128'") &&
      ptyCmd.includes("no_proxy='localhost,10.0.0.0/8,127.0.0.1,::1' NO_PROXY='localhost,10.0.0.0/8,127.0.0.1,::1'"),
    '代理环境变量(由 lib/proxy.js 产出)导出进启动脚本,且不额外发起探测',
    ptyCmd
  );
  await handlers['term:stop']({}, { id: r.id });

  setConfig({ termProxy: false, remotes: [{ ...profileA(), proxy: PROXY }] });
  r = await starts();
  assert(r.ok === true && r.proxy === false && r.proxyError === '' && !/proxy=/i.test(lastPty().cmd) && lastPty().cmd.includes('export COLORTERM=truecolor'), '关闭「继承代理」:配了代理也不带,其余环境照常', r);
  await handlers['term:stop']({}, { id: r.id });

  // 想继承但没成(这里是回环代理要建反向隧道,替身没有 forwardIn):说明原因,会话照常可用
  setConfig({ remotes: [{ ...profileA(), proxy: { ...PROXY, host: '127.0.0.1' } }] });
  r = await starts();
  assert(r.ok === true && r.proxy === false && typeof r.id === 'string' && !!r.proxyError && !/proxy=/i.test(lastPty().cmd), '代理注入失败:facts 带原因(proxyError),会话仍然建立', r);
  await handlers['term:stop']({}, { id: r.id });

  // tmux 保活(默认关)
  setConfig();
  lastExec().length = 0;
  r = await starts();
  assert(r.tmux === 'off' && lastProbes().length === 0 && !lastPty().cmd.includes('tmux'), '保活关闭:不探测 tmux,会话不进 tmux', r);
  await handlers['term:stop']({}, { id: r.id });

  // 保活开启 + 服务器有 tmux:会话放进 tmux,facts 带版本;tmux 用探测到的绝对路径执行
  const clientT = clients[clients.length - 1];
  const tmuxProbe = (state) => (cmd) => ({ code: 0, stdout: cmd.includes('command -v tmux') ? '__BIN /home/u/.local/bin/tmux\n登录脚本打印的杂音\ntmux 3.4\r\n' : `__PI_TMUX_${state}\n` });
  clientT.probe = tmuxProbe('CREATED');
  setConfig({ termTmux: true });
  lastExec().length = 0;
  r = await handlers['term:start']({}, { target: { mode: 'remote', remoteId: 'A' } });
  assert(r.ok === true && r.tmux === 'on' && r.tmuxVersion === 'tmux 3.4', '保活开启且服务器有 tmux:facts 报 on 与版本(忽略 profile 杂音)', r);
  const probe = lastProbes()[0];
  assert(!!probe && /command -v tmux/.test(probe.cmd) && /printf "__BIN %s/.test(probe.cmd) && /^bash -ilc '/.test(probe.cmd), '探测 tmux 经登录 shell 执行(profile 里的 PATH 生效),并带出绝对路径', probe && probe.cmd);
  assert(inner(lastPty().cmd).includes("; exec '/home/u/.local/bin/tmux' -L 'pi-web-desktop' attach-session -t main; exec -l \"$SHELL\""), 'PTY 仅附着已准备的 tmux 会话', inner(lastPty().cmd));
  assert(r.tmuxAttached === false && r.proxyRetained === false && lastProbes()[1].cmd.includes('new-session -d -s main -x 80 -y 24') && !lastProbes()[1].cmd.includes('new-session -A'), '原子创建带初始尺寸,不通过 -A 隐式附着', lastProbes()[1]);
  await handlers['term:stop']({}, { id: r.id });

  setConfig({ termTmux: true, remotes: [{ ...profileA(), proxy: PROXY }] });
  r = await starts();
  assert(r.proxy === true && !r.tmuxAttached && lastProbes().pop().cmd.includes('http_proxy=') && !lastPty().cmd.includes('http_proxy='), '新建 pane 的命令继承代理,附着客户端不注入代理', r);
  await handlers['term:stop']({}, { id: r.id });
  clientT.probe = tmuxProbe('ATTACHED');
  r = await starts();
  assert(r.proxy === null && r.tmuxAttached === true && r.proxyRetained === true && r.proxyError === '', '已有会话代理未知,不能伪称新代理生效', r);
  const prepare = inner(lastProbes().pop().cmd);
  assert(/if .*has-session/.test(prepare) && /elif .*new-session -d/.test(prepare) && /elif .*has-session/.test(prepare) && !/kill-session|respawn|set-environment/.test(prepare), '先检查已有会话,竞争创建失败后再确认附着,不重启任务', prepare);
  await handlers['term:stop']({}, { id: r.id });
  setConfig({ termTmux: true, termProxy: false, remotes: [{ ...profileA(), proxy: PROXY }] });
  r = await starts();
  assert(r.proxy === null && r.proxyRetained, '关闭代理继承也不能宣称已有 pane 的代理关闭', r);
  await handlers['term:stop']({}, { id: r.id });
  clientT.probe = (cmd) => cmd.includes('command -v tmux') ? tmuxProbe('CREATED')(cmd) : { code: 1, stdout: '' };
  r = await starts();
  assert(r.ok === false && /无法创建或附着/.test(r.error), '创建失败且不存在可附着会话:报错而非重建或伪报成功', r);

  // command -v 返回的不是绝对路径(别名 / 函数):按没装处理,不冒险执行
  clientT.probe = () => ({ code: 0, stdout: '__BIN tmux\ntmux 3.4\n' });
  r = await starts();
  assert(r.ok === true && r.tmux === 'missing' && !lastPty().cmd.includes('tmux'), 'command -v 只给别名(非绝对路径):按 missing 处理,退回普通登录 shell', r);
  await handlers['term:stop']({}, { id: r.id });

  // 保活开启 + 服务器没装 tmux:如实报 missing,照常开普通会话
  setConfig({ termTmux: true });
  clientT.probe = () => ({ code: 127, stdout: '' });
  r = await starts();
  assert(r.ok === true && r.tmux === 'missing' && r.tmuxVersion === '' && !lastPty().cmd.includes('tmux') && lastPty().cmd.endsWith(`; exec -l "$SHELL"'`), '保活开启但服务器没有 tmux:报 missing,退回普通登录 shell', r);
  await handlers['term:stop']({}, { id: r.id });

  // 探测命令本身出错(连接抖动 / 被拒):同样按「没装」处理,不让会话失败
  clientT.probe = null;
  r = await starts();
  assert(r.ok === true && r.tmux === 'missing', 'tmux 探测出错:按 missing 处理,会话仍然建立', r);
  await handlers['term:stop']({}, { id: r.id });
  setConfig(); // 还原,后面的用例不受影响

  /* ---------- sanitizeName:防路径穿越 ---------- */
  assert(term.sanitizeName('../../etc/passwd') === 'passwd', '路径穿越只留 basename');
  assert(term.sanitizeName('a\\b.txt') === 'b.txt', '反斜杠分隔同样取 basename');
  assert(term.sanitizeName('..') === 'upload.bin' && term.sanitizeName('') === 'upload.bin', '空名/点段兜底');
  assert(term.sanitizeName('x'.repeat(300)).length === 200, '超长文件名截断');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : 'SSH 终端: 全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('TEST ERR:', e.stack || e.message);
  process.exit(1);
});
