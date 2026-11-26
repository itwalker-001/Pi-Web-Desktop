'use strict';

// SSH 终端会话层:在 remote.js 的 SSH 连接池上开交互式 shell 通道(PTY),渲染层用 xterm.js 呈现;
// 另提供 SFTP 上传(把剪贴板里的截图/复制的文件送到远程 /tmp)。对服务器零安装、零常驻端口:
// 终端与上传都只是现有 SSH 连接上的一个通道。
// 会话启动时会按配置补齐 TUI 程序(Claude Code / pi 等)依赖的环境:真彩色声明、UTF-8 locale 兜底、
// 代理环境变量、可选的 tmux 保活,见 launchScript。

const { randomUUID } = require('crypto');
const { ensureConnected, sshKeyOf, onDisconnect, exec } = require('./remote');
const proxy = require('./proxy');

const TERM_TYPE = 'xterm-256color';

// 断线保活用的 tmux 走独立 socket 与固定会话名:服务器上由本应用开的 tmux 服务端自成一套,
// 不会连到(也打搅不到)用户自己平时开的 tmux 会话
const TMUX_SOCKET = 'pi-web-desktop';
const TMUX_SESSION = 'main';

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// 交互式 shell 的启动命令。经 exec + PTY 执行:sshd 是用登录 shell 的「sh -c」来跑这条命令的,
// 所以外面再包一层 bash,保证里面的语法与登录 shell 是 bash / zsh / sh 无关。依次做:
//   ① 补 TUI 程序依赖的环境:COLORTERM=truecolor(xterm.js 支持 24 位色,支持的程序据此启用);
//      LANG 不是 UTF-8 时挑一个服务器上现成的 UTF-8 locale 兜底,否则中文可能被当成不可打印字符
//   ② 需要时把这台服务器的「代理设置」导出进会话(变量前缀由 lib/proxy.js 产出)
//   ③ 需要时放进 tmux:断线、离开终端后服务器上的程序继续跑,重连即回到原会话。
//      tmux 用探测到的绝对路径:探测走登录 shell(profile 里的 PATH 生效),而这里的 bash -c 只有 sshd 的默认
//      PATH —— tmux 装在 ~/.local/bin、/usr/local/bin 这类位置时,直接写 tmux 会「找不到」,客户端秒退
// 最后 exec 成登录 shell:交互式 + argv[0] 以 - 开头 → 读 /etc/profile 与 ~/.bash_profile / ~/.profile,
// 与 sshd 直接开 login shell 的效果一致(nvm 等写在 profile 里的 PATH 照常生效)。
// 单引号与 $ 都要原样送达远端,所以整段脚本经 shellQuote 包一层
function launchScript({ proxyPrefix = '', tmuxBin = '', tmuxSocket = TMUX_SOCKET } = {}) {
  const steps = [];
  if (proxyPrefix) steps.push(`export ${proxyPrefix}`);
  steps.push('export COLORTERM=truecolor');
  steps.push(
    'case "${LANG:-}" in *[Uu][Tt][Ff]*) ;; *) ' +
      'for l in C.utf8 C.UTF-8 en_US.utf8 en_US.UTF-8; do ' +
      'locale -a 2>/dev/null | grep -qix "$l" && { export LANG="$l"; break; }; ' +
      'done ;; esac'
  );
  if (tmuxBin) steps.push(`exec ${shellQuote(tmuxBin)} -L ${shellQuote(tmuxSocket)} attach-session -t ${TMUX_SESSION}`);
  steps.push('exec -l "$SHELL"');
  return `bash -c ${shellQuote(steps.join('; '))}`;
}

// 每次上传在 /tmp 下创建独立的私有目录,保留原文件名且不覆盖已有文件。
const UPLOAD_DIR = '/tmp';

// id → { id, key, stream, alive }
const sessions = new Map();
let nextId = 1;

const dataHandlers = [];
const exitHandlers = [];

function onTermData(cb) { dataHandlers.push(cb); }
function onTermExit(cb) { exitHandlers.push(cb); }

function emitData(info) { for (const cb of dataHandlers) { try { cb(info); } catch {} } }
function emitExit(info) { for (const cb of exitHandlers) { try { cb(info); } catch {} } }

// 结束会话并通知渲染层(shell 通道 close 与主动 stop 都会走到这里,幂等)
function kill(id, reason) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  if (s.alive) {
    s.alive = false;
    emitExit({ id, reason });
  }
  try { s.stream.end(); } catch {}
  try { s.stream.close(); } catch {}
}

// SSH 连接断开(网络断开/档案变更/退出回收都会走 remote.disconnect 或连接自断)→
// 该目标上的终端会话一并结束,渲染层收到 term:exit 后显示「已断开」
onDisconnect((key) => {
  for (const s of [...sessions.values()]) {
    if (s.key === key) kill(s.id, 'disconnected');
  }
});

// 服务器上的 tmux(开了「会话保活」才查):返回 { bin, version } 或 null。
// 用登录 shell 查(profile 里的 PATH 生效),bin 必须是绝对路径 —— 后面执行时只有 sshd 的默认 PATH。
// 登录 shell 的 profile 可能打印杂音,所以只认「/ 开头的行」与形如 "tmux <版本>" 的那一段
async function tmuxOf(cfg) {
  try {
    const r = await exec(cfg, 'b=$(command -v tmux 2>/dev/null) || exit 3; printf "__BIN %s\\n" "$b"; tmux -V', { timeoutMs: 15000 });
    if (r.code !== 0) return null;
    const out = String(r.stdout || '');
    const bin = (out.match(/^__BIN (\/[^\r\n]*)$/m) || [])[1] || '';
    const version = (out.match(/\btmux \d[^\r\n]*/) || [''])[0].trim();
    return bin ? { bin, version } : null;
  } catch {
    return null;
  }
}

// 打开交互式 shell(PTY);cols/rows 与渲染层 xterm 尺寸一致,窗口变化时调 resize。
// 返回 { id, key, facts }:facts 描述这个会话的实际形态,供界面如实说明 ——
//   proxy       新建时是否导出代理;附着已有 pane 时为 null(原环境未知)
//   tmuxAttached / proxyRetained  已有会话保留原环境;proxyError 为新建时注入失败原因
//   tmux        'off' 未启用 | 'on' 会话在 tmux 里 | 'missing' 开了保活但服务器没装 tmux(照常开会话)
//   tmuxVersion 形如 "tmux 3.4"
async function start(cfg, { cols = 80, rows = 24, tmuxSocket = TMUX_SOCKET } = {}) {
  const c = await ensureConnected(cfg);
  const key = sshKeyOf(cfg);

  const facts = { proxy: false, proxyError: '', tmux: 'off', tmuxVersion: '', tmuxAttached: false, proxyRetained: false };
  const px = proxy.parseProxy(cfg || {});
  const wantProxy = !!(cfg && cfg.termProxy !== false && px.enabled && px.primary);
  let proxyPrefix = '';
  let tmuxBin = '';
  // 代理前缀(回环代理要先建反向隧道)与 tmux 探测互不依赖,并行准备
  await Promise.all([
    (async () => {
      if (!wantProxy) return;
      try {
        proxyPrefix = await proxy.remoteEnvPrefix(cfg);
        facts.proxy = !!proxyPrefix;
      } catch (err) {
        facts.proxyError = String((err && err.message) || err);
      }
    })(),
    (async () => {
      if (!cfg || !cfg.termTmux) return;
      const tm = await tmuxOf(cfg);
      facts.tmuxVersion = tm ? tm.version : '';
      facts.tmux = tm ? 'on' : 'missing';
      tmuxBin = tm ? tm.bin : '';
    })(),
  ]);

  if (tmuxBin) {
    const tm = `${shellQuote(tmuxBin)} -L ${shellQuote(tmuxSocket)}`;
    const exists = `${tm} has-session -t ${TMUX_SESSION} 2>/dev/null`;
    const width = Math.max(1, Math.floor(Number(cols) || 80));
    const height = Math.max(1, Math.floor(Number(rows) || 24));
    // 不用 -A:只有赢得创建的一方才可宣称新环境生效。
    const r = await exec(cfg,
      `if ${exists}; then printf '__PI_TMUX_ATTACHED\\n'; ` +
      `elif ${tm} new-session -d -s ${TMUX_SESSION} -x ${width} -y ${height} ${shellQuote(launchScript({ proxyPrefix }))}; then printf '__PI_TMUX_CREATED\\n'; ` +
      `elif ${exists}; then printf '__PI_TMUX_ATTACHED\\n'; else exit 1; fi`,
      { timeoutMs: 15000 });
    const attached = /^__PI_TMUX_ATTACHED\r?$/m.test(String(r.stdout || ''));
    if (r.code !== 0 || (!attached && !/^__PI_TMUX_CREATED\r?$/m.test(String(r.stdout || '')))) {
      throw new Error('无法创建或附着 tmux 会话,未更改已有任务');
    }
    facts.tmuxAttached = attached;
    facts.proxyRetained = attached;
    if (attached) {
      facts.proxy = null;
      facts.proxyError = '';
    }
  }

  return new Promise((resolve, reject) => {
    c.exec(launchScript({ proxyPrefix: tmuxBin ? '' : proxyPrefix, tmuxBin, tmuxSocket }), { pty: { term: TERM_TYPE, cols, rows } }, (err, stream) => {
      if (err) return reject(err);
      const id = `t${nextId++}`;
      const s = { id, key, stream, alive: true };
      sessions.set(id, s);
      stream.on('data', (buf) => {
        if (!s.alive) return;
        // 以 Uint8Array 视图直传(不转字符串,防 UTF-8 多字节被块边界截断),渲染层用流式 TextDecoder 解码
        emitData({ id, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) });
      });
      stream.on('close', () => kill(id, 'closed'));
      resolve({ id, key, facts });
    });
  });
}

function sessionOf(id) {
  const s = sessions.get(String(id || ''));
  if (!s) throw new Error('终端会话不存在或已断开');
  return s;
}

function write(id, data) {
  sessionOf(id).stream.write(data);
}

function resize(id, cols, rows) {
  sessionOf(id).stream.setWindow(rows, cols, 0, 0);
}

function stop(id) {
  kill(String(id || ''), 'stopped');
}

function stopAll() {
  for (const s of [...sessions.values()]) kill(s.id, 'stopped');
}

/* ---------------- SFTP 上传(剪贴板截图/复制的文件 → /tmp) ---------------- */

// 远程文件名:只留 basename(拒绝对路径与 .. 穿越),去控制字符,超长截断
function sanitizeName(name) {
  let n = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\\/g, '/');
  n = n.split('/').pop() || '';
  n = n.replace(/^\.+$/, '').trim();
  if (!n) n = 'upload.bin';
  return n.slice(0, 200);
}

function sftpOf(c) {
  return new Promise((resolve, reject) => {
    c.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function writeBuffer(sftp, remote, buffer) {
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(remote, { mode: 0o644 });
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    ws.on('error', done);
    ws.on('close', () => done());
    ws.end(buffer);
  });
}

function fastPut(sftp, localPath, remote) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remote, (err) => (err ? reject(err) : resolve()));
  });
}

// items:[{ name, buffer }](内存数据,如截图 PNG)或 [{ localPath }](本地文件);逐个上传到 /tmp 的独立目录,
// 同批重名自动加 -N 后缀。返回远程完整路径列表(顺序与入参一致)
async function upload(cfg, items) {
  if (!Array.isArray(items) || !items.length) throw new Error('没有可上传的内容');
  const c = await ensureConnected(cfg);
  const sftp = await sftpOf(c);
  const used = new Set();
  const paths = [];
  try {
    const dir = `${UPLOAD_DIR}/pi-paste-${randomUUID()}`;
    // mkdir 是独占创建:即便目录碰巧已存在,也直接失败而不写入其中。
    await new Promise((resolve, reject) => {
      sftp.mkdir(dir, { mode: 0o700 }, (err) => err ? reject(err) : resolve());
    });
    for (const it of items) {
      const base = sanitizeName(it.name || String(it.localPath || '').split(/[\\/]/).pop());
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      let name = base;
      for (let i = 1; used.has(name); i++) name = `${stem}-${i}${ext}`;
      const remote = `${dir}/${name}`;
      if (it.buffer !== undefined) await writeBuffer(sftp, remote, Buffer.from(it.buffer));
      else await fastPut(sftp, it.localPath, remote);
      used.add(name);
      paths.push(remote);
    }
  } finally {
    try { sftp.end(); } catch {}
  }
  return paths;
}

module.exports = { start, write, resize, stop, stopAll, upload, onTermData, onTermExit, sanitizeName, launchScript, UPLOAD_DIR };
