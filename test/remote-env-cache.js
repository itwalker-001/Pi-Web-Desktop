// 远程环境检测缓存自检(离线,mock SSH 通道):各服务器的全局包信息必须各查各的、各存各的 ——
// 先检测的那台的结果不能被其余服务器复用。运行:node test/remote-env-cache.js
'use strict';

const path = require('path');
const Module = require('module');

const ENV_PATH = path.join(__dirname, '..', 'lib', 'remote-env.js');

// 三台「服务器」的全局包信息,按 主机/用户 区分;calls 记录每台的采集次数,delays 可注入延迟
const servers = {
  '10.0.0.1/alice': { npmRoot: '/srv/a/lib', piWebVersion: '0.17.0', piPkg: { name: '@scope/pi-a', version: '1.2.3' } },
  '10.0.0.2/bob': { npmRoot: '/srv/b/lib', piWebVersion: '0.15.0', piPkg: null },
  '10.0.0.3/carol': { error: 'npm not found' },
};
const calls = {};
const delays = {};

const fakeRemote = {
  exec: async (_cfg, cmd) => ({ code: 0, stdout: `${cmd === 'node -v' ? 'v22.1.0' : cmd === 'npm -v' ? '10.0.0' : '1.5.0'}\n`, stderr: '' }),
  execScript: async (cfg) => {
    const key = `${cfg.remote.host}/${cfg.remote.user}`;
    calls[key] = (calls[key] || 0) + 1;
    if (delays[key]) await new Promise((r) => setTimeout(r, delays[key]));
    return { code: 0, value: { ...servers[key] }, stderr: '' };
  },
};

const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === './remote' && args[0] && path.resolve(args[0].filename || '') === ENV_PATH) return fakeRemote;
  return origLoad.apply(this, [request, ...args]);
};

const remoteEnv = require(ENV_PATH);
const cfgOf = (host, user) => ({ mode: 'remote', remote: { host, port: 22, user } });

function assert(cond, msg) {
  console.log(cond ? 'PASS: ' + msg : 'FAIL: ' + msg);
  if (!cond) process.exit(1);
}

(async () => {
  const a = cfgOf('10.0.0.1', 'alice');
  const b = cfgOf('10.0.0.2', 'bob');
  const c = cfgOf('10.0.0.3', 'carol');

  // 1) 各查各的:先检测 A,B 的结果不能是 A 的
  assert((await remoteEnv.installedPiWebVersion(a)) === '0.17.0', 'A 的 pi-web 版本');
  assert((await remoteEnv.installedPiWebVersion(b)) === '0.15.0', 'B 的 pi-web 版本是它自己的(不是 A 的)');
  assert((await remoteEnv.resolvePiPackage(a)).name === '@scope/pi-a', 'A 的 pi 包名');
  assert((await remoteEnv.resolvePiPackage(b)).fallback === true, 'B 扫不到 pi 包 → 回退官方包(不是 A 的包名)');
  assert((await remoteEnv.detect(a)).piWeb.version === '0.17.0' && (await remoteEnv.detect(b)).piWeb.version === '0.15.0', 'detect():两台的 pi-web 行各是各的');

  // 2) 各存各的:同一台第二次不再采集
  assert(calls['10.0.0.1/alice'] === 1 && calls['10.0.0.2/bob'] === 1, '每台各缓存一份');
  await remoteEnv.installedPiWebVersion(a);
  assert(calls['10.0.0.1/alice'] === 1, '同一台再次查询走缓存');

  // 3) 缓存键含用户:同主机不同用户是两套全局包
  await remoteEnv.installedPiWebVersion(cfgOf('10.0.0.1', 'dave'));
  assert(calls['10.0.0.1/alice'] === 1 && calls['10.0.0.1/dave'] === 1, '同主机换用户 → 另行采集,不串用');

  // 4) 同一台的并发请求合并为一次采集
  remoteEnv.clearCache();
  delays['10.0.0.2/bob'] = 40;
  const before = calls['10.0.0.2/bob'];
  const vs = await Promise.all([remoteEnv.installedPiWebVersion(b), remoteEnv.installedPiWebVersion(b), remoteEnv.detect(b)]);
  assert(vs[0] === '0.15.0' && vs[1] === '0.15.0' && calls['10.0.0.2/bob'] === before + 1, '并发请求合并:三次查询只采集一次');

  // 5) 失败不留缓存:下一次会重试
  assert((await remoteEnv.installedPiWebVersion(c)) === null, '采集失败 → 版本为 null');
  assert(calls['10.0.0.3/carol'] === 1, '失败的那台被采集过一次');
  assert((await remoteEnv.installedPiWebVersion(c)) === null && calls['10.0.0.3/carol'] === 2, '失败不入缓存,再次查询会重试');
  servers['10.0.0.3/carol'] = { npmRoot: '/srv/c/lib', piWebVersion: '0.16.0', piPkg: null };
  assert((await remoteEnv.installedPiWebVersion(c)) === '0.16.0', '恢复后重试拿到新结果');

  // 6) 按服务器清除:只清那一台
  const snap = { ...calls };
  remoteEnv.clearCache(a);
  await Promise.all([remoteEnv.installedPiWebVersion(a), remoteEnv.installedPiWebVersion(b), remoteEnv.installedPiWebVersion(c)]);
  assert(calls['10.0.0.1/alice'] === snap['10.0.0.1/alice'] + 1, 'clearCache(cfg) 只让该服务器重新采集');
  assert(calls['10.0.0.2/bob'] === snap['10.0.0.2/bob'] && calls['10.0.0.3/carol'] === snap['10.0.0.3/carol'], '其余服务器的缓存保留');

  console.log('远程环境检测缓存: 全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('TEST ERR:', e.stack || e.message);
  process.exit(1);
});
