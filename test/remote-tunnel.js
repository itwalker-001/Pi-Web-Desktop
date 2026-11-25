// SSH 反向隧道数据通路自检(离线:替身 ssh2 Client + 本机真实的 TCP 服务)。
// 隧道的意义是「远程 127.0.0.1:<端口> 上的连接 → 回到本机的某个服务」,所以要验证的不只是端口分配,
// 还有数据真的双向流动。此前实现里监听的事件名写成了 'tcp'(ssh2 派发的是 'tcp connection'),
// 钩子从不触发,隧道从未真正通过 —— 端口分配类断言发现不了。
// 运行:node test/remote-tunnel.js
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const ROOT = path.join(__dirname, '..');
const REMOTE_PATH = path.join(ROOT, 'lib', 'remote.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tunnel-')); // electron 替身的 userData(remote.js → ./config)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function assert(cond, msg, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}${cond || detail === undefined ? '' : `  [${detail}]`}`);
  if (!cond) failed += 1;
}

/* ---------- ssh2 替身:记录 forwardIn,并可模拟「远程发来一条转发连接」 ---------- */
const clients = [];
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.forwarded = [];
    clients.push(this);
  }
  connect() { setImmediate(() => this.emit('ready')); }
  end() { setImmediate(() => this.emit('close')); }
  exec(_cmd, cb) { cb(new Error('本测试不执行远程命令')); }
  forwardIn(bindAddr, port, cb) { this.forwarded.push([bindAddr, port]); setImmediate(() => cb(null, port)); }
  unforwardIn(bindAddr, port) { this.forwarded = this.forwarded.filter(([, p]) => p !== port); }
}

const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'electron') return { app: { getPath: () => tmp } };
  if (request === 'ssh2' && args[0] && path.resolve(args[0].filename || '') === REMOTE_PATH) return { Client: FakeClient };
  return origLoad.apply(this, [request, ...args]);
};
const remote = require(REMOTE_PATH);

// 本机「代理」:收到请求就回一行带标记的 HTTP 响应,并记下请求行
function startLocal(name) {
  const hits = [];
  const server = net.createServer((socket) => {
    socket.once('data', (buf) => {
      hits.push(buf.toString().split('\r\n')[0]);
      socket.end(`HTTP/1.1 200 OK\r\nX-Local: ${name}\r\nContent-Length: 2\r\n\r\nok`);
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })));
}

// 模拟远程经隧道发来一条连接;返回「远程那一侧」的可读可写流与接受/拒绝状态
function incomingFromRemote(client, destPort, event = 'tcp connection') {
  const channel = new PassThrough(); // ssh2 的 accept() 返回的 Channel:与远程之间的双向流
  let state = 'pending';
  client.emit(event, { destIP: '127.0.0.1', destPort, srcIP: '127.0.0.1', srcPort: 40000 }, () => { state = 'accepted'; return channel; }, () => { state = 'rejected'; });
  return { channel, state: () => state };
}
// 从远程那一侧读到的内容里取出本机服务的回应(PassThrough 也会把测试自己写入的请求回显出来)
function responseOf(channel) {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      if (buf.includes('X-Local:')) {
        channel.off('data', onData);
        resolve(buf.slice(buf.indexOf('HTTP/1.1 200')).replace(/\r\n/g, ' '));
      }
    };
    channel.on('data', onData);
    setTimeout(() => { channel.off('data', onData); resolve(''); }, 3000);
  });
}
const done = (conn) => { conn.channel.end(); conn.channel.destroy(); };

(async () => {
  const cfg = { mode: 'remote', remote: { host: '10.0.0.1', port: 22, user: 'u', authType: 'password', password: 'p', hostFingerprint: '' } };
  const a = await startLocal('proxy-a');
  const b = await startLocal('proxy-b');

  // 1) 建立隧道:远程 127.0.0.1:17890 → 本机 proxy-a
  const remotePort = await remote.ensureReverseTunnel(cfg, { host: '127.0.0.1', port: a.port });
  assert(remotePort === 17890 && clients.length === 1, '隧道端口从 17890 起', remotePort);
  assert(clients[0].forwarded.length === 1 && clients[0].forwarded[0][0] === '127.0.0.1' && clients[0].forwarded[0][1] === 17890, '在远程的回环地址上登记转发', JSON.stringify(clients[0].forwarded));

  // 2) 远程发来连接:请求数据要到达本机服务,回应要回到远程那一侧
  const c1 = incomingFromRemote(clients[0], remotePort);
  c1.channel.write('GET http://example.invalid/ HTTP/1.1\r\nHost: example.invalid\r\n\r\n');
  const res1 = await responseOf(c1.channel);
  assert(c1.state() === 'accepted', '远程发来的转发连接被接受(事件名 tcp connection)', c1.state());
  assert(a.hits.length === 1 && a.hits[0] === 'GET http://example.invalid/ HTTP/1.1', '请求数据到达本机服务', JSON.stringify(a.hits));
  assert(res1.includes('X-Local: proxy-a'), '本机服务的回应回到远程那一侧', res1);
  done(c1);

  // 3) 换目标:沿用同一条连接的隧道,改指向 proxy-b
  const remotePort2 = await remote.ensureReverseTunnel(cfg, { host: '127.0.0.1', port: b.port });
  const c2 = incomingFromRemote(clients[0], remotePort2);
  c2.channel.write('GET http://b.invalid/ HTTP/1.1\r\n\r\n');
  const res2 = await responseOf(c2.channel);
  assert(clients.length === 1 && b.hits.length === 1 && a.hits.length === 1 && res2.includes('X-Local: proxy-b'), '换目标后新连接去到新的本机服务(旧目标不再收到)', res2);
  done(c2);

  // 4) 连接意外断开再重连:转发钩子要挂到新的那条连接上
  clients[0].emit('close');
  await sleep(20);
  const remotePort3 = await remote.ensureReverseTunnel(cfg, { host: '127.0.0.1', port: a.port });
  const c3 = incomingFromRemote(clients[1], remotePort3);
  c3.channel.write('GET http://after-reconnect.invalid/ HTTP/1.1\r\n\r\n');
  const res3 = await responseOf(c3.channel);
  assert(clients.length === 2 && c3.state() === 'accepted', '断开后按需重连,新连接上的转发钩子生效', `${clients.length} 个 Client / ${c3.state()}`);
  assert(a.hits.length === 2 && res3.includes('X-Local: proxy-a'), '重连后数据仍然双向流通', res3);
  done(c3);

  // 5) 没有转发目标时(连接已断):直接拒绝远程连接,不让它一直挂着
  clients[1].emit('close');
  await sleep(20);
  const c4 = incomingFromRemote(clients[1], remotePort3);
  assert(c4.state() === 'rejected' && a.hits.length === 2, '没有转发目标:拒绝远程连接', c4.state());
  done(c4);

  // 6) 旧的事件名 'tcp' 不是 ssh2 派发的:按它监听收不到任何连接
  const remotePort4 = await remote.ensureReverseTunnel(cfg, { host: '127.0.0.1', port: a.port });
  const c5 = incomingFromRemote(clients[2], remotePort4, 'tcp');
  c5.channel.write('GET http://wrong-event.invalid/ HTTP/1.1\r\n\r\n');
  await sleep(200);
  assert(c5.state() === 'pending' && a.hits.length === 2, "按旧事件名 'tcp' 监听收不到连接(这正是此前隧道不通的原因)", c5.state());
  done(c5);

  remote.disconnect(cfg);
  a.server.close();
  b.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} 项失败` : 'SSH 反向隧道数据通路: 全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('TEST ERR:', e.stack || e.message);
  process.exit(1);
});
