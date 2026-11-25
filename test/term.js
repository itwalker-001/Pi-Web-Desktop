// SSH 终端自检(离线:mock electron + 替身 ssh2 Client,真实 lib/term.js / lib/remote.js / lib/ipc.js)。
// 覆盖:会话生命周期(start/write/resize/stop/断连联动)、term:paste 剪贴板三态仲裁
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
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.shells = [];
    clients.push(this);
  }
  connect() { setImmediate(() => this.emit('ready')); }
  end() { setImmediate(() => this.emit('close')); }
  exec(_cmd, cb) { cb(new Error('本测试不执行远程命令')); }
  shell(opts, cb) {
    const s = new FakeShell(opts);
    this.shells.push(s);
    setImmediate(() => cb(null, s));
  }
  sftp(cb) { setImmediate(() => cb(null, sftpCurrent)); }
}

/* ---------- 替身 electron / webview-files:剪贴板状态可编程(对齐 Electron 44 异步 W3C 形态) ---------- */
const handlers = {};
const sent = []; // 主窗口收到的事件 { channel, payload }
const fakeWin = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push({ channel, payload }) } };
const clipState = { image: null, text: '' }; // image: null 或 { mime, bytes }
const fileClipboard = []; // 「复制的文件」路径列表
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
        writeText: async () => {},
      },
      app: { getPath: () => tmp },
    };
  }
  if (request === 'ssh2' && args[0] && path.resolve(args[0].filename || '') === REMOTE_PATH) return { Client: FakeClient };
  if (request === './webview-files' && args[0] && path.resolve(args[0].filename || '') === IPC_PATH) {
    return { readClipboardFilePaths: async () => fileClipboard.slice() };
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

  // 2) 开会话:走真实 ensureConnected,shell 拿到 xterm-256color 与初始尺寸
  r = await starts();
  const id = r.id;
  assert(r.ok === true && typeof id === 'string' && r.mode === 'remote' && r.remoteId === 'A', '远程目标开会话成功并带目标标识', r);
  const shell = clients[0].shells[0];
  assert(clients.length === 1 && !!shell && shell.opts.term === 'xterm-256color' && shell.opts.cols === 80 && shell.opts.rows === 24, 'PTY 以 xterm-256color 与初始 cols/rows 打开', shell && shell.opts);

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
  clipState.image = { mime: 'image/png', bytes: pngBytes };
  fileClipboard.length = 0;
  clipState.text = 'leftover text';
  r = await handlers['term:paste']({}, { target: { mode: 'remote', remoteId: 'A' } });
  assert(r.ok === true && r.type === 'uploaded' && r.paths.length === 1, '剪贴板是截图:返回 uploaded 与路径', r);
  assert(/^\/tmp\/pi-paste-[a-f0-9-]+\/pi-paste-\d{8}-\d{6}-\d{3}\.png$/.test(r.paths[0]), '截图按时间戳命名进 /tmp 下的独立目录', r.paths && r.paths[0]);
  assert(sftpCurrent.writes.length === 1 && sftpCurrent.writes[0].remote === r.paths[0] && sftpCurrent.writes[0].buffer.equals(pngBytes), '截图 PNG 字节经 SFTP 写到该路径', sftpCurrent.writes.map((w) => w.remote));

  clipState.image = null;
  fileClipboard.push('C:\\Users\\x\\my file.png', 'D:\\data\\a.txt');
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

  fileClipboard.length = 0;
  clipState.text = 'plain text';
  r = await handlers['term:paste']({}, { target: { mode: 'remote', remoteId: 'A' } });
  assert(r.ok === true && r.type === 'text' && r.text === 'plain text', '剪贴板是文本:按普通粘贴返回', r);

  r = await handlers['term:paste']({}, { target: { mode: 'local' } });
  assert(r.ok === false && /仅远程/.test(r.error), '本机目标不能上传', r);

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
