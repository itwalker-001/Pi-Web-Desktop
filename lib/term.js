'use strict';

// SSH 终端会话层:在 remote.js 的 SSH 连接池上开交互式 shell 通道(PTY),渲染层用 xterm.js 呈现;
// 另提供 SFTP 上传(把剪贴板里的截图/复制的文件送到远程 /tmp)。对服务器零安装、零常驻端口:
// 终端与上传都只是现有 SSH 连接上的一个通道。

const { randomUUID } = require('crypto');
const { ensureConnected, sshKeyOf, onDisconnect } = require('./remote');

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

// 打开交互式 shell(PTY);cols/rows 与渲染层 xterm 尺寸一致,窗口变化时调 resize
async function start(cfg, { cols = 80, rows = 24 } = {}) {
  const c = await ensureConnected(cfg);
  const key = sshKeyOf(cfg);
  return new Promise((resolve, reject) => {
    c.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
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
      resolve({ id, key });
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

module.exports = { start, write, resize, stop, stopAll, upload, onTermData, onTermExit, sanitizeName, UPLOAD_DIR };
