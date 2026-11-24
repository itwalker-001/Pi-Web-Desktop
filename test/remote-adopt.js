// 远程服务归属自检(离线,mock SSH 通道,不需要真实服务器):验证「自己启动的 pi-web 不会变成不能停、
// 不能更新的外部实例」—— SSH 断连后仍归自己所有;应用非正常退出后遗留的实例下次启动被认领;真正的
// 外部实例照旧不代停;停止会复核结果,停不掉如实报错。运行:node test/remote-adopt.js
'use strict';

const path = require('path');
const Module = require('module');

const REMOTE_SERVER = path.join(__dirname, '..', 'lib', 'remote-server.js');
const LEGACY = 'legacy';
const sigOf = (port) => `pi-web --no-open --hostname 0.0.0.0 --port ${port}`;

// 极简「远程主机」模拟:一张进程表 + pid 文件(按端口各一份,'legacy' 是 v1.1.2 及更早版本共用的那一份),
// 按 remote-server 发来的命令特征做反应
const host = {
  procs: new Map(),    // pid → { args };在表里即存活
  pidfiles: new Map(), // 端口(或 'legacy')→ 记录的 PID
  sshUp: true,
  stubborn: false,     // true:忽略 SIGTERM(模拟停不掉)
  nextPid: 1000,
};
const disconnectHandlers = [];

function serving(port) {
  const re = new RegExp(`--port ${port}(?!\\d)`);
  for (const proc of host.procs.values()) if (re.test(proc.args)) return true;
  return false;
}

// 与远程 shell 里的归属判定同逻辑(ERE 语义):签名前须是 空格或路径分隔符 —— 覆盖 wrap 子 shell
// (nohup pi-web)与 node 启动器(/…/bin/pi-web);裸 pi-web(行首)不匹配,保持外部实例语义
function ownerOf(port, key) {
  const proc = host.procs.get(host.pidfiles.get(key));
  if (!proc) return 0;
  const re = new RegExp(`([ /])${sigOf(port).replace(/\./g, '\\.')}( |$)`);
  return re.test(proc.args) ? host.pidfiles.get(key) : 0;
}

// 模拟 nohup 拉起:$! 是后台子 shell,它的子进程是 pi-web 启动器(与真实 Linux 上的进程形态一致)
function launch(command) {
  const port = /--port (\d+)/.exec(command)[1];
  const wrap = host.nextPid++;
  host.procs.set(wrap, {
    args: `bash -ilc mkdir -p ~/.pi-web-desktop && nohup ${sigOf(port)} >> ~/.pi-web-desktop/server.log 2>&1 < /dev/null & echo $! > …`,
  });
  host.procs.set(host.nextPid++, { args: `node /home/u/.nvm/versions/node/v22.23.2/bin/${sigOf(port)}` });
  host.pidfiles.set(Number(port), wrap);
  return { code: 0, stdout: '', stderr: '' };
}

// 模拟认领检查:先看本端口的 pid 文件,再看旧版共用的那份;都不是自己的就清掉过期文件
function adoptCheck(command) {
  const port = Number(/--port (\d+)/.exec(command)[1]);
  let owner = ownerOf(port, port);
  if (!owner) host.pidfiles.delete(port);
  if (!owner) {
    owner = ownerOf(port, LEGACY);
    if (!owner) host.pidfiles.delete(LEGACY);
  }
  return { code: 0, stdout: `\n__PI_ADOPT__${owner}\n`, stderr: '' };
}

// 模拟 pkill(+force 时的 fuser):命令里的正则原样拿来匹配进程表,端口边界(3014 / 30141)测的才是真实 pattern;
// force 命令额外按「pi-web + 端口」宽匹配并结束监听者
function kill(command) {
  if (host.stubborn) return { code: 0, stdout: '', stderr: '' };
  const isForce = command.includes('fuser -k');
  const pattern = new RegExp(/pkill -f "(.*?)" 2>\/dev\/null/.exec(command)[1]);
  const port = isForce
    ? Number(/fuser -k (\d+)\/tcp/.exec(command)[1])
    : Number(/server-(\d+)\.pid/.exec(command)[1]);
  const portRe = new RegExp(`--port ${port}(?!\\d)`);
  for (const [pid, proc] of host.procs) {
    if (pattern.test(proc.args) || (isForce && portRe.test(proc.args) && /pi-web/.test(proc.args))) host.procs.delete(pid);
  }
  if (!isForce) {
    const alive = [...host.procs.values()].some((proc) => pattern.test(proc.args));
    if (!alive) host.pidfiles.delete(port); // pgrep … 无匹配 → rm 本端口的 pid 文件
    const legacyPid = host.pidfiles.get(LEGACY);
    if (legacyPid && !host.procs.has(legacyPid)) host.pidfiles.delete(LEGACY); // 旧版那份:进程已不在才清
  }
  return { code: 0, stdout: '', stderr: '' };
}

// 模拟远程 node 探测脚本:按端口回答是否有服务;带 unlinkSync 的(停止复核)在确认无服务时清本端口的 pid 文件
function probe(script) {
  const port = Number(/127\.0\.0\.1:(\d+)\//.exec(script)[1]);
  if (script.includes('unlinkSync') && !serving(port)) host.pidfiles.delete(port);
  return { code: 0, value: { ok: serving(port) }, stdout: '', stderr: '' };
}

const fakeRemote = {
  exec: async (_cfg, command) => {
    if (!host.sshUp) throw new Error('SSH 连接失败');
    if (command.includes('nohup pi-web --no-open')) return launch(command);
    if (command.includes('__PI_ADOPT__')) return adoptCheck(command);
    if (command.includes('pkill -f')) return kill(command);
    return { code: 0, stdout: '', stderr: '' };
  },
  execScript: async (_cfg, script) => {
    if (!host.sshUp) throw new Error('SSH 连接失败');
    return probe(script);
  },
  onDisconnect: (cb) => disconnectHandlers.push(cb),
  sshKeyOf: (cfg) => `${cfg.remote.host}:${cfg.remote.port}:${cfg.remote.user}`,
};

// 只替换 lib/remote-server.js 看到的 SSH 通道与直连探测,其余模块保持原样
const origLoad = Module._load;
Module._load = function (request, ...args) {
  const fromRemoteServer = args[0] && path.resolve(args[0].filename || '') === REMOTE_SERVER;
  if (fromRemoteServer && request === './remote') return fakeRemote;
  if (fromRemoteServer && request === './server') {
    return { probe: async (url) => serving(/:(\d+)\//.exec(url)[1]) };
  }
  return origLoad.apply(this, [request, ...args]);
};

// 重新加载模块 = 模拟应用重启:实例注册表(内存里的归属)全部清零,远程进程与 pid 文件原样留着
function newSession() {
  delete require.cache[REMOTE_SERVER];
  return require(REMOTE_SERVER);
}

function assert(cond, msg) {
  console.log(cond ? 'PASS: ' + msg : 'FAIL: ' + msg);
  if (!cond) process.exit(1);
}

const cfg = { mode: 'remote', remote: { host: '10.0.0.8', port: 22, user: 'u', remotePort: 30141 }, proxy: { enabled: false } };
const onPort = (port) => ({ ...cfg, remote: { ...cfg.remote, remotePort: port } });

(async () => {
  let rs = newSession();

  // 1) 本应用拉起 → 归属自己
  let res = await rs.start(cfg, {});
  assert(res.url === 'http://10.0.0.8:30141/' && !res.external, '由本应用拉起');
  let st = rs.state(cfg);
  assert(st.running && st.owned && !st.external, '拉起后归属自己(owned)');

  // 2) SSH 管理连接意外断开 → 归属不变(过去会被降级成「外部实例」,从此不能停、不能更新)
  disconnectHandlers[disconnectHandlers.length - 1]('10.0.0.8:22:u');
  st = rs.state(cfg);
  assert(st.running && st.owned && !st.external, 'SSH 断连后仍是 owned,不再降级为外部实例');

  // 3) 断连后 stop:重连后发 kill,并复核端口确实已释放
  res = await rs.stop(cfg);
  assert(res.stopped === true, '断连后 stop 成功');
  assert(!serving(30141) && !host.pidfiles.has(30141), '远程进程已结束,pid 文件已清理');
  assert(rs.state(cfg).running === false, 'stop 后状态复位');

  // 4) 应用非正常退出(强杀 / 安装器覆盖升级 / 看门狗自愈重启):进程与 pid 文件留在远程,内存态全丢
  await rs.start(cfg, {});
  rs = newSession();
  assert(rs.isRunning(cfg) === false, '新会话对遗留实例一无所知');
  st = await rs.refreshExternal(cfg);
  assert(st.running && st.owned && !st.external, '下次启动把遗留实例认领为 owned(不再误判成「外部启动」)');
  assert(rs.isOwned(cfg), '认领后 isOwned 为 true(更新流程不再被「外部占用」拦下)');
  res = await rs.stop(cfg);
  assert(res.stopped === true && !serving(30141), '认领来的实例可以停止');

  // 5) server:start 路径(不经 server:state 直接启动)同样认领
  await rs.start(cfg, {});
  rs = newSession();
  res = await rs.start(cfg, {});
  assert(res.adopted === true && !res.external, 'server:start 路径同样认领');
  await rs.stop(cfg);

  // 6) 升级前(v1.1.2 及更早)遗留的实例只记在共用的 server.pid 里 → 也要认得回来
  await rs.start(cfg, {});
  host.pidfiles.set(LEGACY, host.pidfiles.get(30141));
  host.pidfiles.delete(30141);
  rs = newSession();
  st = await rs.refreshExternal(cfg);
  assert(st.running && st.owned && !st.external, '只记在旧版 server.pid 里的遗留实例同样被认领');
  res = await rs.stop(cfg);
  assert(res.stopped === true && !serving(30141) && !host.pidfiles.has(LEGACY), '认领旧版遗留实例后可停止,server.pid 一并清理');

  // 7) 真正的外部实例(不是本应用启动的,没有 pid 文件)→ 照旧不代停
  host.procs.set(host.nextPid++, { args: `node /usr/local/bin/${sigOf(30141)}` });
  rs = newSession();
  st = await rs.refreshExternal(cfg);
  assert(st.running && st.external && !st.owned, '无 pid 文件的实例仍判为外部');
  let before = host.procs.size;
  res = await rs.stop(cfg);
  assert(res.external === true && host.procs.size === before, '外部实例 stop 返回 external,且不结束任何进程');

  // 8) pid 文件过期 / PID 被别的进程复用 / 指向别的端口的实例 → 都不认领,过期 pid 文件被清理
  host.pidfiles.set(30141, 424242);
  st = await newSession().refreshExternal(cfg);
  assert(st.external && !st.owned && !host.pidfiles.has(30141), 'pid 文件里的 PID 早已不存在:不认领,过期文件被清理');

  const reused = host.nextPid++;
  host.procs.set(reused, { args: 'node /app/server.js' });
  host.pidfiles.set(LEGACY, reused);
  st = await newSession().refreshExternal(cfg);
  assert(st.external && !st.owned && !host.pidfiles.has(LEGACY), 'PID 被无关进程复用:不认领');
  host.procs.delete(reused);

  const other = host.nextPid++;
  host.procs.set(other, { args: `bash -ilc mkdir -p ~/.pi-web-desktop && nohup ${sigOf(30142)} >> …` });
  host.pidfiles.set(30141, other);
  st = await newSession().refreshExternal(cfg);
  assert(st.external && !st.owned && !host.pidfiles.has(30141), 'pid 文件指向别的端口的实例:不认领');
  host.procs.clear();
  host.pidfiles.clear();

  // 8b) 外部实例 + 用户已确认(force):强制结束;SSH 不通如实报错;stopAll(退出收尾)绝不强制
  host.procs.set(host.nextPid++, { args: `node /usr/local/bin/pi-web --port 30141` }); // 手工启动形态
  rs = newSession();
  st = await rs.refreshExternal(cfg);
  assert(st.running && st.external && !st.owned, '手工启动的实例判为外部');
  before = host.procs.size;
  res = await rs.stop(cfg);
  assert(res.external === true && host.procs.size === before, '未确认时 stop 仍拒绝,不动任何进程');
  res = await rs.stop(cfg, { force: true });
  assert(res.stopped === true && !serving(30141), 'force 强制结束外部实例');
  assert(rs.state(cfg).running === false, 'force 后状态复位');

  host.procs.set(host.nextPid++, { args: `node /usr/local/bin/pi-web --port 30141` });
  rs = newSession();
  await rs.refreshExternal(cfg);
  host.sshUp = false;
  res = await rs.stop(cfg, { force: true });
  assert(!!res.error && rs.state(cfg).running, 'force 遇 SSH 不通:如实报错并保持运行态');
  host.sshUp = true;
  res = await rs.stop(cfg, { force: true });
  assert(res.stopped === true && !serving(30141), '恢复后 force 成功');

  host.procs.set(host.nextPid++, { args: `node /usr/local/bin/pi-web --port 30141` });
  const s2 = newSession();
  await s2.refreshExternal(cfg);
  await s2.stopAll();
  assert(serving(30141), 'stopAll(退出收尾)不强制结束外部实例');
  host.procs.clear();

  // 9) 停止会复核:进程拒绝退出 / SSH 不通 → 如实报错并保持运行态,不假装已停止
  rs = newSession();
  await rs.start(cfg, {});
  const recorded = host.pidfiles.get(30141);
  host.stubborn = true;
  res = await rs.stop(cfg);
  st = rs.state(cfg);
  assert(!!res.error && !res.stopped, '进程拒绝退出:stop 返回 error');
  assert(st.running && st.owned && host.pidfiles.get(30141) === recorded, '进程拒绝退出:保持运行态,pid 文件保留(下次仍可认领)');
  host.stubborn = false;
  host.sshUp = false;
  res = await rs.stop(cfg);
  assert(!!res.error && rs.state(cfg).running, 'SSH 不通:stop 返回 error,保持运行态');
  host.sshUp = true;
  res = await rs.stop(cfg);
  assert(res.stopped === true && !serving(30141), '恢复后再次 stop 成功');

  // 10) 同一台机器多个端口:停 3014 不误杀 30141,也不动 30141 的 pid 文件(否则重启后它又会被判成外部)
  await rs.start(onPort(3014), {});
  await rs.start(onPort(30141), {});
  const pid30141 = host.pidfiles.get(30141);
  res = await rs.stop(onPort(3014));
  assert(res.stopped === true && !serving(3014) && serving(30141), '停 3014:30141 不受影响');
  assert(host.pidfiles.get(30141) === pid30141 && host.procs.has(pid30141), "停 3014:30141 的 pid 文件完好");
  const adopter = newSession();
  st = await adopter.refreshExternal(onPort(30141));
  assert(st.running && st.owned && !st.external, '另一会话仍能把 30141 认领为 owned');
  await adopter.stopAll(); // 应用退出收尾:stopAll 停的是本会话注册表里的实例(verify:false,不等复核)
  assert(!serving(30141), 'stopAll 结束其余实例');

  // 11) 运行中改远程端口:实例仍登记在旧端口下,按新档案 stop 会落空(lib/ipc.js 因此按旧档案停)
  rs = newSession();
  await rs.start(cfg, {});
  res = await rs.stop(onPort(30142));
  assert(res.stopped === true && serving(30141), '按新档案 stop 落空,旧端口上的实例还在');
  res = await rs.stop(cfg);
  assert(res.stopped === true && !serving(30141), '按旧档案 stop 才停得掉');

  console.log('远程服务归属: 全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('TEST ERR:', e.stack || e.message);
  process.exit(1);
});
