'use strict';

// code-server 测试替身:test/code-server.js 与 test/ipc-editor.js 共用。
// 提供一台「远程服务器」的 SSH 通道替身(按命令内容应答,并记录每条命令),以及一个能真实监听本机端口的
// 假 code-server —— 这样「可访问 / 不可访问」是真实的 HTTP 探测结果,不是替身说了算。

const http = require('http');
const net = require('net');

function createWorld(overrides = {}) {
  const world = {
    machine: 'x86_64',
    freeKb: '99999999', // df 的 Available(KB)
    bin: '', // command -v code-server 的结果('' = 系统里没装)
    version: '', // 已安装时的版本号('' 时默认 4.146.0)
    appBin: false, // 本应用装在 ~/.pi-web-desktop/code-server 下的那份是否存在
    config: '', // ~/.config/code-server/config.yaml 的内容
    noise: '', // 登录 shell 可能输出的杂音
    latestUrl: 'https://github.com/coder/code-server/releases/tag/v4.146.0',
    proxyPrefix: '', // 该服务器的代理环境变量前缀('' = 没配代理)
    downloadFail: '', // 'all' | 'proxy' | 'direct':哪种下载方式会失败
    latestFail: '', // 'all' | 'proxy' | 'direct':查询最新版本号时哪种方式会失败
    busyPorts: [], // 已被别的程序占着的端口
    appPort: '', // ~/.pi-web-desktop/code-server-port 里记的端口(本应用为 code-server 选定的)
    orphans: [], // ~/.pi-web-desktop 下还在的 pid 文件:{ port, pid, args };args = 那个 PID 现在的命令行('' = 进程已不在)
    logTail: '',
    ...overrides,
  };
  const calls = []; // 每次远程执行的命令
  const callHosts = []; // 与 calls 一一对应:这条命令发给了哪台服务器
  const events = []; // 关键事件:download / extract / start / kill
  const servers = new Map(); // 端口 → 假 code-server(http.Server)
  const out = (stdout) => ({ code: 0, stdout, stderr: '' });
  // 归属判定(与 lib/code-server.js 的 ownerCheck 同一条规则):PID 存活、命令行确是本应用的启动行
  const owned = (o) => !!o && o.pid > 0 && new RegExp(`([ /])code-server --bind-addr 0\\.0\\.0\\.0:${o.port}( |$)`).test(o.args || '');

  const remote = {
    exec: async (cfg, cmd, opts = {}) => {
      calls.push(cmd);
      callHosts.push(cfg.remote.host);
      if (cmd === 'uname -m') return out(world.machine + '\n');
      if (cmd.startsWith('df -Pk')) return out(world.freeKb + '\n'); // awk 是远程命令的一部分,回来已是纯数字
      if (cmd.includes('/releases/latest')) {
        const viaProxy = /https?_proxy=/.test(cmd);
        if (world.latestFail === 'all' || world.latestFail === (viaProxy ? 'proxy' : 'direct')) throw new Error('远程命令超时(45s)');
        return out(world.latestUrl + '\n');
      }
      // 找第一个空闲端口:从候选里顺延
      if (/^for p in \d+( \d+)+; do ss -ltn/.test(cmd)) {
        const freePort = cmd.match(/^for p in ([\d ]+);/)[1].split(' ').map(Number).find((p) => !world.busyPorts.includes(p));
        return out((freePort === undefined ? '' : String(freePort)) + '\n');
      }
      // 记下为 code-server 选定的端口
      const savePort = cmd.match(/^mkdir -p ~\/\.pi-web-desktop; echo (\d+) > ~\/\.pi-web-desktop\/code-server-port$/);
      if (savePort) {
        world.appPort = savePort[1];
        return out('');
      }
      if (cmd.includes('curl -fL --progress-bar')) {
        const viaProxy = /https?_proxy=/.test(cmd);
        events.push({ type: 'download', viaProxy, url: (cmd.match(/https:\/\/\S+?\.tar\.gz/) || [])[0] });
        if (world.downloadFail === 'all' || world.downloadFail === (viaProxy ? 'proxy' : 'direct')) {
          if (opts.onData) opts.onData('####### 2.0%\r');
          throw new Error('远程命令失败:curl: (28) Operation too slow');
        }
        if (opts.onData) {
          opts.onData('####### 3.2%\r');
          opts.onData('############################ 41.7%\r');
          opts.onData('###################### 88.1%\r');
          opts.onData('#'.repeat(60) + ' 100.0%\n');
        }
        return out('');
      }
      if (cmd.startsWith('mkdir -p ~/.pi-web-desktop && tar')) {
        events.push({ type: 'extract' });
        world.appBin = true;
        return out('');
      }
      if (cmd.includes('__PI_CS_LIVE__')) {
        const bin = world.bin || (world.appBin ? '/home/u/.pi-web-desktop/code-server/bin/code-server' : '');
        // 检测命令里的归属判定带 clean:过期的 pid 文件顺带清掉
        world.orphans = world.orphans.filter((o) => owned(o));
        const ver = bin ? `${world.version || '4.146.0'}\n9cc1033c190703416bbd5ec95d8f7db9f3edb63d\n` : '';
        return out(`${world.noise ? world.noise + '\n' : ''}${bin}\n__PI_CS_VER__\n${ver}__PI_CS_APP_PORT__\n${world.appPort}\n__PI_CS_CFG__\n${world.config}\n__PI_CS_LIVE__\n${world.orphans.map((o) => `${o.port} ${o.pid}\n`).join('')}`);
      }
      if (cmd.startsWith('cat ~/.config/code-server/config.yaml')) return out(world.config);
      // 写监听配置(配置卡「保存配置」):按命令里的新值重排 world.config 并回显(与真实服务器同构)
      if (cmd.startsWith('mkdir -p ~/.config/code-server;')) {
        const port = (cmd.match(/echo bind-addr: 0\.0\.0\.0:(\d+)/) || [])[1];
        // 密码经 shellQuote 转义:单引号变成 '\'';把整个引号段(含转义)取出来
        const pw = (cmd.match(/printf 'password: %s\\n' '((?:[^']|'\\'')*)'/) || [])[1];
        const rest = String(world.config || '').split(/\r?\n/).filter((l) => l && !/^(bind-addr|auth|password):/.test(l));
        const head = [`bind-addr: 0.0.0.0:${port}`];
        if (pw !== undefined) head.push('auth: password', `password: ${pw.replace(/'\\''/g, "'")}`);
        world.config = [...head, ...rest].join('\n');
        return out(world.config + '\n');
      }
      // 强制结束(force):结束该端口上的一切监听
      if (cmd.startsWith('pkill -f "code-[s]erver')) {
        const port = Number((cmd.match(/fuser -k (\d+)\/tcp/) || cmd.match(/-i :(\d+)/) || [])[1]);
        events.push({ type: 'force-kill', port });
        world.orphans = world.orphans.filter((o) => o.port !== port);
        await close(port);
        return out('');
      }
      if (cmd.startsWith('mkdir -p ~/.pi-web-desktop;')) {
        // 按需启动:假 code-server 开始监听该端口(startHangs:模拟启动了却一直访问不到)
        const port = Number((cmd.match(/--bind-addr 0\.0\.0\.0:(\d+)/) || [])[1]);
        events.push({ type: 'start', port, command: cmd });
        // 服务器上留下 pid 文件:记的是 nohup 那条命令的进程,它的命令行就是本应用的启动行
        const bin = (cmd.match(/nohup '?([^ ']+)'? --bind-addr/) || [])[1];
        world.orphans = world.orphans.filter((o) => o.port !== port);
        world.orphans.push({ port, pid: 4242000 + port, args: `${bin} --bind-addr 0.0.0.0:${port}` });
        if (!world.startHangs && !servers.has(port)) await listen(port);
        return out('');
      }
      if (cmd.startsWith('tail -n 8')) return out(world.logTail);
      if (cmd.startsWith('F=$HOME/.pi-web-desktop/code-server-')) {
        // 回收:归属复核通过才结束;pid 文件无论如何都清掉
        const port = Number((cmd.match(/^F=\$HOME\/\.pi-web-desktop\/code-server-(\d+)\.pid;/) || [])[1]);
        const mine = owned(world.orphans.find((o) => o.port === port));
        events.push({ type: 'kill', port, owned: mine });
        world.orphans = world.orphans.filter((o) => o.port !== port);
        if (mine) await close(port);
        return out('');
      }
      throw new Error('替身未实现的远程命令:' + cmd.slice(0, 90));
    },
    sshKeyOf: (cfg) => `${cfg.remote.host}:${cfg.remote.port}:${cfg.remote.user}`,
  };
  const proxy = { remoteEnvPrefix: async () => world.proxyPrefix };

  // 假服务:缺省 behaves like code-server(与真实实例的应答一致);foreign = true 表示那是别的 Web 程序
  // (真实服务器上默认端口 8080 常被这类程序占着)
  function listen(port, { foreign = false } = {}) {
    return new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        if (foreign) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><html><head><title>Sub2API - AI API Gateway</title></head><body>ok</body></html>');
          return;
        }
        if (req.url === '/healthz') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'alive', lastHeartbeat: Date.now() }));
          return;
        }
        if (req.url === '/login' || req.url.startsWith('/login?')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html><head><title>code-server login</title></head><body></body></html>');
          return;
        }
        res.writeHead(302, { location: './login' }); // 真实的 code-server 未登录时就是这样
        res.end();
      });
      s.foreign = foreign;
      servers.set(port, s);
      s.listen(port, '127.0.0.1', resolve);
    });
  }
  async function close(port) {
    const s = servers.get(port);
    if (!s) return;
    servers.delete(port);
    await new Promise((r) => s.close(r));
  }
  // 取一个当前没人监听的本机端口
  function freePort() {
    return new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
  }
  async function cleanup() {
    for (const p of [...servers.keys()]) await close(p);
  }
  return { world, calls, callHosts, events, remote, proxy, isUp: (port) => servers.has(port), listen, close, freePort, cleanup };
}

module.exports = { createWorld };
