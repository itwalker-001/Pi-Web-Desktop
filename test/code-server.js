// code-server 模块自检(离线:SSH 通道替身 + 真实监听本机端口的假 code-server)。
// code-server 是可选组件,这里验证它的「按需」生命周期:地址解析、检测、安装(官方独立发行包)、
// 按需启动、退出回收、登录密码。运行:node test/code-server.js
'use strict';

const path = require('path');
const Module = require('module');
const { createWorld } = require('./helpers/fake-code-server');

const CS_PATH = path.join(__dirname, '..', 'lib', 'code-server.js');

// 每个场景一个独立的「服务器」(W)。模块里的 SSH 函数在加载时绑定一次,所以给它一个稳定的门面,
// 每次调用都转发到「当前」这台
let W = createWorld();
const fakeRemote = {
  exec: (...a) => W.remote.exec(...a),
  sshKeyOf: (...a) => W.remote.sshKeyOf(...a),
};
const fakeProxy = { remoteEnvPrefix: (...a) => W.proxy.remoteEnvPrefix(...a) };
const origLoad = Module._load;
Module._load = function (request, ...args) {
  const fromCs = args[0] && path.resolve(args[0].filename || '') === CS_PATH;
  if (fromCs && request === './remote') return fakeRemote;
  if (fromCs && request === './proxy') return fakeProxy;
  return origLoad.apply(this, [request, ...args]);
};
const cs = require(CS_PATH);

let failed = 0;
function assert(cond, msg, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}${cond || detail === undefined ? '' : `  [${detail}]`}`);
  if (!cond) failed += 1;
}
const cfgOf = (host, extra = {}) => ({ mode: 'remote', remote: { host, port: 22, user: 'u', ...extra } });

(async () => {
  // 1) 纯函数:bind-addr / 配置 / 地址
  const bind = (s) => JSON.stringify(cs.parseBindAddr(s));
  assert(bind('0.0.0.0:8081') === '{"host":"0.0.0.0","port":"8081"}' && bind('[::]:8080') === '{"host":"::","port":"8080"}', 'bind-addr:通配地址(IPv4 / IPv6)');
  assert(bind('127.0.0.1:8080') === '{"host":"127.0.0.1","port":"8080"}' && bind('10.1.1.1:9090') === '{"host":"10.1.1.1","port":"9090"}', 'bind-addr:回环 / 指定网卡');
  assert(bind(':9090') === '{"host":"","port":"9090"}' && bind('8080') === '{"host":"","port":"8080"}', 'bind-addr:只写端口');
  assert(bind('') === '{"host":"","port":"8080"}', 'bind-addr:没写 → code-server 默认端口 8080');
  const conf = cs.parseConfig('bind-addr: 127.0.0.1:8080\nauth: password\npassword: "p@ss w0rd"\ncert: false\n');
  assert(conf.bindHost === '127.0.0.1' && conf.bindPort === '8080' && conf.auth === 'password' && conf.password === 'p@ss w0rd' && conf.secure === false, 'config.yaml:监听地址 / 认证方式 / 密码(去掉引号)');
  assert(cs.parseConfig('cert: true\nauth: none\n').secure === true && cs.parseConfig('').password === '', 'config.yaml:https、无密码认证、空文件');
  assert(cs.normalizeBase(' 10.9.9.9:9001/ ') === 'http://10.9.9.9:9001' && cs.normalizeBase('ftp://x') === null && cs.normalizeBase('http://') === null && cs.normalizeBase('') === null, '地址规范化:省略协议补 http、去末尾斜杠;错误协议 / 无主机 / 空 → 无效');

  // 2) 检测:装没装、装在哪(系统装的 or 本应用装的)、版本号、监听配置;登录 shell 的杂音不干扰
  W = createWorld({ bin: '/usr/bin/code-server', noise: 'bash: no job control', config: 'bind-addr: 0.0.0.0:8081\ncert: false\n', version: '4.150.2' });
  let info = await cs.inspect(cfgOf('10.0.0.1'));
  assert(info.installed && info.bin === '/usr/bin/code-server' && info.bindPort === '8081' && info.version === '4.150.2', '检测:系统安装的 code-server(含版本号,前面有 shell 杂音也能认出)', JSON.stringify(info));
  W = createWorld({ appBin: true });
  info = await cs.inspect(cfgOf('10.0.0.1'));
  assert(info.installed && /\/\.pi-web-desktop\/code-server\/bin\/code-server$/.test(info.bin) && info.bindPort === '8080', '检测:本应用装在 ~/.pi-web-desktop 下的那份', info.bin);
  W = createWorld();
  info = await cs.inspect(cfgOf('10.0.0.1'));
  assert(info.installed === false && info.bin === '', '检测:没装');

  // 3) 地址解析:哪些由本应用负责安装/按需启动(managed),哪些按用户自管处理
  const cfgL = { mode: 'local', codeServerUrl: '' };
  let t = await cs.resolveTarget(cfgL);
  assert(t.base === 'http://127.0.0.1:8080' && t.managed === false && t.info === null, '本机:默认 127.0.0.1:8080,不由本应用安装/启动', JSON.stringify(t));
  t = await cs.resolveTarget({ mode: 'local', codeServerUrl: 'localhost:8443' });
  assert(t.base === 'http://localhost:8443' && t.managed === false, '本机:填了地址就用填的', t.base);

  W = createWorld({ appBin: true, config: 'bind-addr: 0.0.0.0:8081\n' });
  t = await cs.resolveTarget(cfgOf('10.0.0.1'));
  assert(t.base === 'http://10.0.0.1:8081' && t.managed === true && t.port === 8081, '远程(未填地址):按监听配置 → http://服务器:8081,由本应用按需启动', JSON.stringify(t));
  W = createWorld({ appBin: true, config: 'bind-addr: 127.0.0.1:9090\ncert: true\n' });
  t = await cs.resolveTarget(cfgOf('10.0.0.1'));
  assert(t.base === 'https://10.0.0.1:9090' && t.managed === true, '远程:监听在回环 / 启用了证书 → 仍按该服务器地址访问(启动时改监听 0.0.0.0)', t.base);
  W = createWorld({ appBin: true, config: 'bind-addr: 10.1.1.1:7070\n' });
  t = await cs.resolveTarget(cfgOf('10.0.0.1'));
  assert(t.base === 'http://10.1.1.1:7070', '远程:绑定在指定网卡地址上 → 用那个地址', t.base);
  W = createWorld({ appBin: true });
  t = await cs.resolveTarget(cfgOf('10.0.0.1'));
  assert(t.base === 'http://10.0.0.1:8080' && t.managed === true && t.port === 8080, '远程:还没有配置文件 → 默认端口 8080', t.base);
  t = await cs.resolveTarget(cfgOf('10.0.0.1', { codeServerUrl: '10.0.0.1:9000' }));
  assert(t.base === 'http://10.0.0.1:9000' && t.managed === true && t.port === 9000, '远程(填了「本服务器:端口」):仍由本应用安装/启动,用填的端口', JSON.stringify(t));
  t = await cs.resolveTarget(cfgOf('10.0.0.1', { codeServerUrl: 'https://code.example.com/vscode/' }));
  assert(t.base === 'https://code.example.com/vscode' && t.managed === false, '远程(填了反向代理下的地址):用户自管,本应用不代为启动', t.base);
  t = await cs.resolveTarget(cfgOf('10.0.0.1', { codeServerUrl: 'http://10.9.9.9:9000' }));
  assert(t.managed === false, '远程(填的是别的主机):用户自管');
  let threw = null;
  try { await cs.resolveTarget(cfgOf('10.0.0.1', { codeServerUrl: 'ftp://x' })); } catch (e) { threw = e.message; }
  assert(/无效/.test(threw || ''), '远程(地址无效):明确报错', threw);

  W = createWorld({ bin: '/usr/bin/code-server', config: 'bind-addr: 0.0.0.0:8081\n' });
  const sysTarget = await cs.resolveTarget(cfgOf('10.0.0.1'));
  assert(sysTarget.bin === '/usr/bin/code-server', '解析结果带上安装路径:系统装的 code-server 按它自己的路径启动(不能退回默认路径)', sysTarget.bin);
  W = createWorld({ appBin: true });
  assert((await cs.resolveTarget(cfgOf('10.0.0.1'))).bin === '/home/u/.pi-web-desktop/code-server/bin/code-server', '解析结果带上安装路径:本应用装的那份');

  // 4) 安装(官方独立发行包)
  const installLogs = [];
  W = createWorld();
  let r = await cs.install(cfgOf('10.0.0.1'), { onData: (l) => installLogs.push(l) });
  const TARBALL = 'https://github.com/coder/code-server/releases/download/v4.146.0/code-server-4.146.0-linux-amd64.tar.gz';
  assert(r.ok && r.version === '4.146.0' && r.bin === '~/.pi-web-desktop/code-server/bin/code-server', '安装成功:版本与安装位置', JSON.stringify(r));
  assert(W.events.filter((e) => e.type === 'download').length === 1 && W.events.find((e) => e.type === 'download').url === TARBALL, '下载的是 GitHub Releases 上对应架构的独立发行包', JSON.stringify(W.events.find((e) => e.type === 'download')));
  const dl = W.calls.find((c) => c.includes('curl -fL --progress-bar'));
  assert(/--speed-limit 1024 --speed-time 60/.test(dl) && /--connect-timeout 20/.test(dl) && /-o \/tmp\/code-server-4\.146\.0-linux-amd64\.tar\.gz/.test(dl), '下载带限速保护(长时间不动就放弃)并落到临时文件', dl);
  assert(!/https?_proxy=/.test(dl), '没配代理的服务器:直连下载');
  const extract = W.calls.find((c) => c.startsWith('mkdir -p ~/.pi-web-desktop && tar'));
  assert(/tar -C ~\/\.pi-web-desktop -xzf/.test(extract) && /mv ~\/\.pi-web-desktop\/code-server-4\.146\.0-linux-amd64 ~\/\.pi-web-desktop\/code-server/.test(extract) && /rm -f \/tmp\/code-server/.test(extract), '解压到 ~/.pi-web-desktop/code-server 并清掉临时包(不需要 root)', extract);
  assert(W.events.some((e) => e.type === 'extract') && W.world.appBin === true, '解压后检测得到已安装');
  const progressLines = installLogs.filter((l) => /^下载中 /.test(l)).map((l) => l.trim());
  assert(installLogs.some((l) => l.includes(TARBALL)) && progressLines.join('|') === '下载中 3.2%|下载中 41.7%|下载中 88.1%', '安装日志:给出下载地址,进度每 ≥10% 报一行,不在 100% 重复', progressLines.join('|'));

  // 没有走 npm:npm 包里嵌套整棵 node_modules,安装会失败
  assert(!W.calls.some((c) => /npm (install|i )/.test(c)), '安装不经过 npm');

  // 配了代理的服务器:先经代理下载
  W = createWorld({ proxyPrefix: "https_proxy='http://10.9.9.9:10808' " });
  await cs.install(cfgOf('10.0.0.1'));
  assert(W.events.filter((e) => e.type === 'download').map((e) => e.viaProxy).join(',') === 'true', '配了代理:经该服务器的代理下载');
  assert(W.calls.filter((c) => c.includes('curl -fL --progress-bar')).every((c) => c.startsWith("https_proxy='http://10.9.9.9:10808' curl")), '代理环境变量前缀挂在 curl 命令上');

  // 代理下载失败 → 换直连
  W = createWorld({ proxyPrefix: "https_proxy='http://10.9.9.9:10808' ", downloadFail: 'proxy' });
  const logs2 = [];
  r = await cs.install(cfgOf('10.0.0.1'), { onData: (l) => logs2.push(l) });
  assert(r.ok && W.events.filter((e) => e.type === 'download').map((e) => e.viaProxy).join(',') === 'true,false', '代理下载失败:自动改直连再试', JSON.stringify(W.events.filter((e) => e.type === 'download')));
  assert(logs2.some((l) => /经该服务器的代理.*失败/.test(l)), '日志里说明了代理那一次为什么失败', logs2.filter((l) => /失败/.test(l)).join(' | '));

  // 两条路都不通 / 架构不支持 / 磁盘不足 / 拿不到版本号
  const expectFail = async (label, world, re) => {
    W = world;
    let msg = '';
    try { await cs.install(cfgOf('10.0.0.1')); } catch (e) { msg = e.message; }
    assert(re.test(msg), label, msg.slice(0, 110));
  };
  await expectFail('直连也失败:报错并给出可行方向', createWorld({ downloadFail: 'all' }), /下载 code-server 失败.*github\.com.*代理/);
  await expectFail('两条路都失败:错误里带上两次的原因', createWorld({ proxyPrefix: "https_proxy='http://10.9.9.9:10808' ", downloadFail: 'all' }), /经该服务器的代理.*直连/);
  await expectFail('不支持的 CPU 架构:不下载、明确报错', createWorld({ machine: 'armv7l' }), /不支持的 CPU 架构 armv7l/);
  await expectFail('磁盘空间不足:不下载、明确报错', createWorld({ freeKb: '1000000' }), /磁盘空间不足.*约 977MB/);
  await expectFail('拿不到最新版本号:不下载、明确报错', createWorld({ latestUrl: 'https://github.com/' }), /最新版本号/);
  assert(!W.calls.some((c) => c.includes('curl -fL --progress-bar')), '拿不到版本号时没有发起下载');
  await expectFail('arm64 机器', createWorld({ machine: 'aarch64', downloadFail: 'all' }), /下载 code-server 失败/);
  assert(W.events.find((e) => e.type === 'download').url.endsWith('code-server-4.146.0-linux-arm64.tar.gz'), 'aarch64 机器下载 arm64 包', W.events.find((e) => e.type === 'download').url.slice(-44));
  // 查询最新版本号也要走代理:内网机器直连 GitHub 常常超时(真实环境里就是这样装不上的)
  const lookups = () => W.calls.filter((c) => c.includes('/releases/latest'));
  W = createWorld({ proxyPrefix: "https_proxy='http://10.9.9.9:10808' ", latestFail: 'direct' });
  r = await cs.install(cfgOf('10.0.0.1'));
  assert(r.ok && lookups().length === 1 && lookups()[0].startsWith("https_proxy='http://10.9.9.9:10808' curl"), '配了代理:查询版本号先经代理(直连不通也能装上)', lookups()[0].slice(0, 60));
  W = createWorld({ proxyPrefix: "https_proxy='http://10.9.9.9:10808' ", latestFail: 'proxy' });
  r = await cs.install(cfgOf('10.0.0.1'));
  assert(r.ok && lookups().map((c) => /https?_proxy=/.test(c)).join(',') === 'true,false', '代理查不到版本号:改直连再查', lookups().map((c) => /https?_proxy=/.test(c)).join(','));
  await expectFail('两边都查不到版本号:不下载、明确报错', createWorld({ proxyPrefix: "https_proxy='http://10.9.9.9:10808' ", latestFail: 'all' }), /最新版本号/);
  assert(!W.calls.some((c) => c.includes('curl -fL --progress-bar')), '查不到版本号时没有发起下载');

  // 5) 按需启动 / 登录密码 / 退出回收
  const port = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 127.0.0.1:${port}\nauth: password\npassword: 's3cret-pw'\n` });
  const cfgS = cfgOf('127.0.0.1');
  assert((await cs.reachable(`http://127.0.0.1:${port}`)) === false, '启动前:该端口访问不到');
  const startTarget = await cs.resolveTarget(cfgS);
  const startLogs = [];
  const started = await cs.start(cfgS, startTarget, { onData: (l) => startLogs.push(l) });
  assert(W.isUp(port) && (await cs.reachable(`http://127.0.0.1:${port}`)) === true, '启动后:端口可访问');
  assert(started.url === `http://127.0.0.1:${port}`, '启动后返回访问地址(登录密码由调用方在落到登录页时再读)', JSON.stringify(started));
  const confRead = await cs.readConfig(cfgS);
  assert(confRead.auth === 'password' && confRead.password === 's3cret-pw', 'readConfig:读出服务器上 code-server 的登录密码', JSON.stringify(confRead));
  const sc = W.events.find((e) => e.type === 'start').command;
  const startTail = ` >> ~/.pi-web-desktop/code-server-${port}.log 2>&1 < /dev/null & echo $! > ~/.pi-web-desktop/code-server-${port}.pid`;
  assert(sc === `mkdir -p ~/.pi-web-desktop; nohup '/home/u/.pi-web-desktop/code-server/bin/code-server' --bind-addr 0.0.0.0:${port}${startTail}`, '启动命令:只后台化 nohup 这一条简单命令(重定向挂在它身上),监听 0.0.0.0,记 pid', sc);
  assert(startLogs.some((l) => l.includes(`code-server 已启动:http://127.0.0.1:${port}`)), '启动日志给出访问地址');
  await cs.stopAll();
  assert(W.isUp(port) === false && W.events.filter((e) => e.type === 'kill').length === 1, '退出回收:按 pid 文件结束本应用启动的实例');
  await cs.stopAll();
  assert(W.events.filter((e) => e.type === 'kill').length === 1, '重复回收是空操作');
  const killCmd = W.calls.find((c) => c.startsWith('F=$HOME/.pi-web-desktop/code-server-'));
  assert(killCmd.startsWith(`F=$HOME/.pi-web-desktop/code-server-${port}.pid; OWNER=0; `) && killCmd.includes(`ps -o args= -p "$C"`) && killCmd.includes(`grep -Eq "([ /])code-server --bind-addr 0\\.0\\.0\\.0:${port}( |$)"`) && killCmd.endsWith(`[ "$OWNER" -gt 0 ] && kill "$OWNER"; rm -f ~/.pi-web-desktop/code-server-${port}.pid`), '回收:先按 pid 文件复核命令行确是本应用的启动行,再结束,并清掉 pid 文件', killCmd);

  // 兜底的默认路径带 ~:不能加引号(加了引号 ~ 不展开,会找不到程序)
  const portFallback = await W.freePort();
  await cs.start(cfgS, { base: `http://127.0.0.1:${portFallback}`, port: portFallback, bin: '' }, { timeoutMs: 3000 });
  assert(W.events.filter((e) => e.type === 'start').pop().command.includes('nohup ~/.pi-web-desktop/code-server/bin/code-server --bind-addr'), '兜底默认路径不加引号(~ 才能展开)');
  await cs.stopAll();

  // 配了代理:出站流量沿用该服务器的代理设置
  const port2 = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${port2}\nauth: none\n`, proxyPrefix: "https_proxy='http://10.9.9.9:10808' " });
  const s2 = await cs.start(cfgS, await cs.resolveTarget(cfgS));
  assert(W.events.find((e) => e.type === 'start').command.includes("https_proxy='http://10.9.9.9:10808' nohup"), '启动命令带上该服务器的代理环境变量');
  assert(s2.url === `http://127.0.0.1:${port2}`, '无密码认证(auth: none)的实例照常启动');
  await cs.stopAll();

  // 启动了却一直访问不到:等够了就报错,并带回服务器上的日志尾部
  const port3 = await W.freePort();
  W = createWorld({ appBin: true, startHangs: true, logTail: 'Error: listen EADDRINUSE 0.0.0.0:' + port3, config: `bind-addr: 127.0.0.1:${port3}\n` });
  let msg = '';
  const t0 = Date.now();
  try {
    await cs.start(cfgS, { base: `http://127.0.0.1:${port3}`, port: port3, bin: '/home/u/.pi-web-desktop/code-server/bin/code-server' }, { timeoutMs: 900 });
  } catch (e) {
    msg = e.message;
  }
  assert(msg.includes(`本机访问不到 http://127.0.0.1:${port3}`) && msg.includes('EADDRINUSE'), '启动了却访问不到:报错并带回服务器上的日志尾部', msg.replace(/\n/g, ' | ').slice(0, 150));
  assert(Date.now() - t0 >= 900 && Date.now() - t0 < 5000, '等待时长有上限', Date.now() - t0);

  // 6) 端口被别的程序占着(真实服务器上默认端口常被占):顺延到第一个空闲端口
  W = createWorld({ appBin: true, busyPorts: [8080, 8081, 8082] }); // code-server 自己没配过 → 想用默认端口 8080
  let pt = await cs.resolveTarget(cfgS);
  assert(pt.port === 8080 && pt.base === 'http://127.0.0.1:8080', '启动前:按默认端口 8080 准备', JSON.stringify([pt.port, pt.base]));
  const portLogs = [];
  const st = await cs.start(cfgS, pt, { onData: (l) => portLogs.push(l) });
  assert(st.port === 8083 && st.url === 'http://127.0.0.1:8083' && W.isUp(8083), '8080–8082 被占:顺延到 8083 并在该端口启动', JSON.stringify(st));
  assert(W.events.find((e) => e.type === 'start').command.includes('--bind-addr 0.0.0.0:8083') && portLogs.some((l) => l.includes('端口 8080 已被占用,改用 8083')), '启动命令用的是顺延后的端口,日志说明原因', portLogs.join(' | '));
  assert(W.world.appPort === '8083', 'code-server 自己没配过监听地址:把选定的端口记在服务器上(下次还用它)', W.world.appPort);
  pt = await cs.resolveTarget(cfgS);
  assert(pt.port === 8083 && pt.base === 'http://127.0.0.1:8083', '下次解析:直接用记下的端口', JSON.stringify([pt.port, pt.base]));
  await cs.stopAll();
  assert(W.isUp(8083) === false, '回收的是实际启动的那个端口');

  // 用户自己配过监听地址:端口被占时只在这一次临时顺延,不改它的配置、也不记端口
  W = createWorld({ appBin: true, busyPorts: [9090], config: 'bind-addr: 127.0.0.1:9090\nauth: password\npassword: "user-pw"\n' });
  pt = await cs.resolveTarget(cfgS);
  const st2 = await cs.start(cfgS, pt);
  assert(pt.port === 9090 && st2.port === 9091 && W.world.appPort === '' && W.world.config.includes('bind-addr: 127.0.0.1:9090'), '用户配过 9090 而它被占:本次临时用 9091,不动它的配置', JSON.stringify([pt.port, st2.port, W.world.appPort]));
  const shifted = await cs.resolveTarget(cfgS);
  assert(shifted.port === 9091 && shifted.base === st2.url && await cs.isCodeServer(shifted.base), '显式监听配置顺延后:状态检测复用实际运行端口');
  cs.adopt(cfgS, shifted.info);
  const explicitCfg = { ...cfgS, remote: { ...cfgS.remote, codeServerUrl: 'http://127.0.0.1:9090' } };
  assert((await cs.resolveTarget(explicitCfg)).base === st2.url, '显式托管地址也复用顺延端口,重复认领不会丢失原端口映射');
  await cs.stopAll();
  assert((await cs.resolveTarget(cfgS)).port === 9090, '停止后恢复用户配置端口,不保留过期运行态');

  // code-server 首次运行自动生成的默认配置(bind-addr: 127.0.0.1:8080)不算「用户配过」:
  // 8080 被占时照样顺延并把端口记下来,下次直接用
  W = createWorld({ appBin: true, busyPorts: [8080], config: 'bind-addr: 127.0.0.1:8080\nauth: password\npassword: "gen-pw"\n' });
  pt = await cs.resolveTarget(cfgS);
  assert(pt.info.configured === false, '自动生成的默认配置:不算用户配过', JSON.stringify(pt.info.configured));
  const st5 = await cs.start(cfgS, pt);
  assert(st5.port === 8081 && W.world.appPort === '8081' && (await cs.resolveTarget(cfgS)).port === 8081, '默认配置 + 8080 被占:顺延并记下端口,下次直接用', JSON.stringify([st5.port, W.world.appPort]));
  await cs.stopAll();
  W = createWorld({ appBin: true, config: 'bind-addr: 0.0.0.0:8080\n' });
  assert((await cs.resolveTarget(cfgS)).info.configured === true, '显式写了 0.0.0.0:8080:算用户配过');

  // 端口空闲:就用想用的那个,不画蛇添足
  const portFree = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portFree}\n` });
  pt = await cs.resolveTarget(cfgS);
  const st3 = await cs.start(cfgS, pt);
  assert(pt.port === portFree && st3.port === portFree && W.world.appPort === '', '端口空闲:原端口启动');
  await cs.stopAll();

  // 7) 端口被别的 Web 程序占着(真实服务器上 8080 常这样):不能把别人的网站当成 code-server
  const portForeign = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portForeign}\nauth: password\npassword: 'x'\n` });
  await W.listen(portForeign, { foreign: true });
  assert((await cs.reachable(`http://127.0.0.1:${portForeign}`)) === true && (await cs.isCodeServer(`http://127.0.0.1:${portForeign}`)) === false, '别的 Web 程序占了端口:有 HTTP 响应,但识别得出它不是 code-server', '');
  const portReal = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portReal}\nauth: password\npassword: 'y'\n` });
  await W.listen(portReal);
  assert((await cs.isCodeServer(`http://127.0.0.1:${portReal}`)) === true, '真正的 code-server(按 /healthz 与登录页特征)识别得出', '');
  assert((await cs.isCodeServer(`http://127.0.0.1:${portReal}/vscode`)) === (await cs.isCodeServer('http://127.0.0.1:9')), '带子路径的地址 / 无人监听的端口:不误判', `${await cs.isCodeServer(`http://127.0.0.1:${portReal}/vscode`)} / ${await cs.isCodeServer('http://127.0.0.1:9')}`);
  const closed = await W.freePort();
  assert((await cs.isCodeServer(`http://127.0.0.1:${closed}`)) === false, '无人监听的端口:不是 code-server');

  // 想用的端口被别的程序占着:顺延到下一个端口启动,不去动那个程序
  const portWant = await W.freePort();
  const portNext = portWant + 1;
  W = createWorld({ appBin: true, busyPorts: [portWant], config: `bind-addr: 0.0.0.0:${portWant}\nauth: password\npassword: 'z'\n` });
  await W.listen(portWant, { foreign: true });
  pt = await cs.resolveTarget(cfgS);
  const st4 = await cs.start(cfgS, pt);
  assert(pt.base === `http://127.0.0.1:${portWant}` && st4.port === portNext && st4.url === `http://127.0.0.1:${portNext}` && W.isUp(portWant) && W.isUp(portNext), '想用的端口被别的程序占着:顺延到下一个端口启动,原程序原样不动', JSON.stringify([pt.base, st4.url]));
  const activeTarget = await cs.resolveTarget(cfgS);
  assert(activeTarget.base === st4.url && cs.startedFor(cfgS).includes(activeTarget.port), '顺延后状态地址与 owned 端口一致,不会误判服务未运行');
  await cs.stopAll();
  assert(W.isUp(portNext) === false && W.isUp(portWant) === true, '回收时只结束本应用启动的那个');

  // 8) 上次没正常退出留下的实例(应用被强杀、覆盖升级):按 pid 文件认领回来,退出时一并回收
  const SIG = (bin, p) => `${bin} --bind-addr 0.0.0.0:${p}`; // 本应用启动的那个进程在服务器上的命令行
  const portO = await W.freePort();
  W = createWorld({ appBin: true, noise: 'bash: no job control', config: `bind-addr: 0.0.0.0:${portO}\nauth: password\npassword: 'o-pw'\n` });
  await W.listen(portO); // 那个端口上有 code-server 在跑
  let infoO = await cs.inspect(cfgS);
  assert(infoO.orphans.length === 0, '没有本应用的 pid 文件:不是遗留实例(用户自己的服务不动)', JSON.stringify(infoO.orphans));
  W.world.orphans.push({ port: portO, pid: 31337, args: SIG('/home/u/.pi-web-desktop/code-server', portO) });
  infoO = await cs.inspect(cfgS);
  assert(JSON.stringify(infoO.orphans) === JSON.stringify([portO]) && infoO.bin === '/home/u/.pi-web-desktop/code-server/bin/code-server' && infoO.password === 'o-pw', 'pid 文件在、记的进程命令行确是本应用的启动行:认得出是上次留下的实例', JSON.stringify(infoO));
  W.world.orphans.push({ port: portO + 1, pid: 31338, args: '/usr/bin/code-server --bind-addr 0.0.0.0:' + (portO + 1) });
  assert(JSON.stringify((await cs.inspect(cfgS)).orphans) === JSON.stringify([portO, portO + 1]), '系统装的 code-server 启动的、留在别的端口上的,也都认得出');
  W.world.orphans = [
    { port: portO, pid: 31337, args: SIG('/home/u/.pi-web-desktop/code-server', portO) },
    { port: portO + 1, pid: 31338, args: '' }, // 进程已不在
    { port: portO + 2, pid: 31339, args: 'python3 -m http.server ' + (portO + 2) }, // PID 被别的进程复用
    { port: portO + 3, pid: 31340, args: SIG('/usr/bin/code-server', portO + 39) }, // 端口对不上
    { port: portO + 4, pid: 31341, args: `/usr/bin/code-server --bind-addr 0.0.0.0:${portO + 4}0` }, // 3 位前缀相同不算
  ];
  assert(JSON.stringify((await cs.inspect(cfgS)).orphans) === JSON.stringify([portO]) && W.world.orphans.length === 1 && W.world.orphans[0].port === portO, '过期的 pid 文件(进程已不在 / PID 被复用 / 端口对不上):不算遗留实例,顺带清掉', JSON.stringify(W.world.orphans));
  await W.cleanup();

  // 认领 + 回收:只结束认领回来的那个;用户自己的服务不动;别的服务器不牵连
  const portA = await W.freePort();
  const portB = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portA}\n` });
  await W.listen(portA);
  await W.listen(portB); // 用户自己的服务:没有本应用的 pid 文件
  W.world.orphans = [{ port: portA, pid: 31337, args: SIG('/home/u/.pi-web-desktop/code-server', portA) }];
  cs.adopt(cfgS, await cs.inspect(cfgS));
  cs.adopt(cfgOf('10.0.0.2'), { orphans: [] }); // 另一台服务器上没有遗留实例
  assert(W.events.filter((e) => e.type === 'kill').length === 0 && W.isUp(portA), '认领本身不去动服务器上的进程');
  await cs.stopAll();
  const kills = () => W.events.filter((e) => e.type === 'kill');
  assert(kills().length === 1 && kills()[0].port === portA && kills()[0].owned === true && W.callHosts[W.calls.length - 1] === '127.0.0.1', '退出时回收认领回来的实例,回收命令发给它所在的那台服务器', JSON.stringify(kills()));
  assert(W.isUp(portA) === false && W.isUp(portB) === true && W.world.orphans.length === 0, '用户自己的服务没被动,pid 文件已清掉', `${W.isUp(portA)} / ${W.isUp(portB)} / ${JSON.stringify(W.world.orphans)}`);

  // 认领之后、退出之前 pid 文件过期(PID 被别的进程复用):结束前复核得出不是自己的 → 不结束
  const portC = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portC}\n` });
  await W.listen(portC);
  W.world.orphans = [{ port: portC, pid: 31337, args: SIG('/home/u/.pi-web-desktop/code-server', portC) }];
  cs.adopt(cfgS, await cs.inspect(cfgS));
  W.world.orphans[0].args = 'python3 -m http.server ' + portC;
  await cs.stopAll();
  assert(kills().length === 1 && kills()[0].owned === false && W.isUp(portC) === true && W.world.orphans.length === 0, '结束前复核:PID 已被别的进程复用 → 不结束它,只清掉过期的 pid 文件', JSON.stringify(kills()));

  /* ---------------- 配置卡:写监听配置 / 按目标停止 ---------------- */

  // 写 config.yaml:bind-addr + auth/password 放头部,其余行(cert 等)保留;密码带单引号也安全
  W = createWorld({ appBin: true, config: 'bind-addr: 127.0.0.1:8080\nauth: password\npassword: old\ncert: false\n' });
  let wc = await cs.writeConfig(cfgOf('10.0.0.1'), { port: 8081, password: "p'w 1" });
  assert(wc.bindPort === '8081' && wc.bindHost === '0.0.0.0' && wc.auth === 'password' && wc.password === "p'w 1" && wc.secure === false, '写监听配置:端口/密码生效,返回写后的配置', JSON.stringify(wc));
  assert(/^bind-addr: 0\.0\.0\.0:8081\nauth: password\npassword: p'w 1\n/.test(W.world.config) && W.world.config.includes('cert: false') && !W.world.config.includes('password: old'), '写监听配置:管理键置顶、cert 等其余行保留、旧值被替换', JSON.stringify(W.world.config));
  // 密码留空 + 服务器上已有密码:沿用,不轮换
  wc = await cs.writeConfig(cfgOf('10.0.0.1'), { port: 8082, password: '' });
  assert(wc.bindPort === '8082' && wc.auth === 'password' && wc.password === "p'w 1", '密码留空:沿用服务器上已有的密码', JSON.stringify(wc));
  // 密码留空 + 服务器上也没有:自动生成并写入 —— code-server 4.x 在 auth 缺失时拒绝启动,配置不能缺这两行
  W = createWorld({ appBin: true, config: 'bind-addr: 0.0.0.0:8082\ncert: false\n' });
  wc = await cs.writeConfig(cfgOf('10.0.0.1'), { port: 8082, password: '' });
  assert(wc.auth === 'password' && wc.password.length >= 8 && /^auth: password$/m.test(W.world.config) && /^password: \S+/m.test(W.world.config), '无密码时自动生成,保证 auth/password 始终存在', JSON.stringify(wc));
  // 端口越界:拒绝
  let bad = '';
  try { await cs.writeConfig(cfgOf('10.0.0.1'), { port: 80 }); } catch (e) { bad = e.message; }
  assert(/1024 - 65535/.test(bad), '监听端口越界:拒绝并说明范围', bad);

  // 按目标停止:只结束该服务器上本应用启动/认领的实例;force 才动该端口上的一切监听
  const portD = await W.freePort();
  const portE = await W.freePort();
  W = createWorld({ appBin: true, config: `bind-addr: 0.0.0.0:${portD}\n` });
  await W.listen(portD); // 本应用认领的实例
  await W.listen(portE); // 用户自己的实例(同端口段的另一个)
  W.world.orphans = [{ port: portD, pid: 31337, args: SIG('/home/u/.pi-web-desktop/code-server', portD) }];
  cs.adopt(cfgS, await cs.inspect(cfgS));
  assert(JSON.stringify(cs.startedFor(cfgS)) === `[${portD}]`, 'startedFor:列出该服务器上本应用的实例端口');
  const rStop = await cs.stop(cfgS, { port: portD });
  assert(rStop.ok === true && rStop.ours === 1 && W.isUp(portD) === false && W.isUp(portE) === true, '按目标停止:结束自己的实例,用户的不动', JSON.stringify(rStop));
  assert(cs.startedFor(cfgS).length === 0, '停止后 startedFor 清空');
  // force:该端口上是别人的程序(无 pid 文件)也能结束(portE 上用户实例仍在监听)
  const rForce = await cs.stop(cfgOf('10.0.0.9'), { port: portE, force: true });
  const fk = W.events.filter((e) => e.type === 'force-kill');
  assert(rForce.ok === true && fk.length === 1 && fk[0].port === portE && W.isUp(portE) === false, 'force:结束该端口上的一切监听(发给指定服务器)', JSON.stringify(fk));

  await W.cleanup();
  console.log(failed ? `\n${failed} 项失败` : 'code-server(可选组件,按需安装 / 按需启动 / 配置卡): 全部通过');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('TEST ERR:', e.stack || e.message);
  process.exit(1);
});
