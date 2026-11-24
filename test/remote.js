// 远程模式手动集成测试:走与 IPC 相同的底层代码路径,验证 SSH 连接 / 环境检测 /
// 远程服务启停 / 直连访问 / 日志回传 / 进程回收。需要一个真实可达的 SSH 服务器。
//
// 运行:
//   node test/remote.js <user@host> [--ssh-port 22] [--key ~/.ssh/id_rsa]
//                       [--remote-port 30141]
//                       [--install]  # 远程未装 pi-web 时顺带执行一键安装
//
// 前置:本机私钥已配置对该服务器的免密登录(公钥在远程 ~/.ssh/authorized_keys);
// 远程防火墙放行服务端口(webview 直连访问)。
'use strict';

const remote = require('../lib/remote');
const remoteEnv = require('../lib/remote-env');
const remoteServer = require('../lib/remote-server');

function parseArgs(argv) {
  const positional = [];
  const opts = { sshPort: 22, key: '', remotePort: 30141, install: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ssh-port') opts.sshPort = parseInt(argv[++i], 10);
    else if (a === '--key') opts.key = argv[++i];
    else if (a === '--remote-port') opts.remotePort = parseInt(argv[++i], 10);
    else if (a === '--install') opts.install = true;
    else positional.push(a);
  }
  if (!positional.length || !positional[0].includes('@')) {
    console.error('用法: node test/remote.js <user@host> [--ssh-port N] [--key 路径] [--remote-port N] [--install]');
    process.exit(2);
  }
  const [user, host] = positional[0].split('@');
  return { user, host, ...opts };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cfg = {
    mode: 'remote',
    registry: '',
    proxy: { enabled: false },
    remote: { host: a.host, port: a.sshPort, user: a.user, keyPath: a.key, remotePort: a.remotePort, hostFingerprint: '' },
  };

  // 1. 连接测试(可达性 + 免密认证 + 指纹)
  console.log(`[1] 测试 SSH 连接 ${a.user}@${a.host}:${a.sshPort} …`);
  const test = await remote.testConnection(cfg);
  console.log(`    连接正常,主机指纹(SHA-256):${test.fingerprint || '(首次,未持久化)'}`);

  // 2. 远程环境检测
  console.log('[2] 远程环境检测…');
  const env = await remoteEnv.detect(cfg);
  console.log(`    node=${env.node.version || '未检出'}  npm=${env.npm.version || '未检出'}  pi=${env.pi.version || '未检出'}  pi-web=${env.piWeb.version || '未检出'}`);
  if (!env.piWeb.ok) {
    if (!a.install) {
      console.log('    远程未安装 pi-web:加 --install 执行一键安装后重试');
      process.exit(1);
    }
    const piPkg = await remoteEnv.resolvePiPackage(cfg);
    const pkg = piPkg && piPkg.name ? piPkg.name : remoteEnv.PI_FALLBACK_PKG;
    console.log(`[2b] 远程一键安装 ${pkg} …`);
    const cmd = remoteEnv.npmInstallCommand(cfg, pkg);
    const res = await remote.exec(cfg, cmd, { timeoutMs: 10 * 60 * 1000, onData: (s) => process.stdout.write(s) });
    if (res.code !== 0) {
      console.error('    安装失败:', (res.stderr || res.stdout).split('\n').slice(-3).join('\n'));
      process.exit(1);
    }
    remoteEnv.clearCache();
  }

  // 3. 最新版本查询(远程视角)
  const latest = await remoteEnv.latestVersion(cfg).catch((e) => {
    console.log('    最新版本查询失败(可忽略):', e.message);
    return null;
  });
  if (latest) console.log(`[3] registry 最新 pi-web=${latest}`);

  // 4. 启动远程服务(webview 直连访问,不做端口转发)
  console.log('[4] 启动远程 pi-web …');
  const logs = [];
  const started = await remoteServer.start(cfg, { onLog: (l) => logs.push(l) });
  console.log(`    started: ${started.url} external=${!!started.external}`);

  // 5. 直连 HTTP 探测(webview 的实际访问路径)
  const probeCode = await fetch(started.url, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.status)
    .catch((e) => `ERR ${e.cause?.code || e.message}`);
  console.log(`[5] 直连探测: HTTP ${probeCode}`, String(probeCode).startsWith('2') || String(probeCode).startsWith('3') ? 'PASS' : 'FAIL');

  // 6. 日志回传(等待两轮轮询)
  await sleep(5000);
  const logText = logs.join('');
  console.log(`[6] 服务日志(${logText.length} 字节)尾部:`, logText.slice(-200).replace(/\n/g, ' | ') || '(无)');

  // 7. 停止 + 远程进程回收
  console.log('[7] 停止远程服务…');
  const stopRes = await remoteServer.stop(cfg);
  console.log('    stop:', JSON.stringify(stopRes));
  await sleep(1500);
  const stillServing = await remoteServer.probeRemote(cfg).catch(() => 'ERR');
  console.log(`    停止后远程端口探测: ${stillServing}`, stillServing === false ? 'PASS(已停止)' : 'FAIL(仍在运行)');

  remote.disconnect();

  if (started.external) {
    console.log('注意:本次连接的是外部已启动的实例,未做停止验证。');
  }
  const ok = String(probeCode).match(/^[23]/) && stillServing === false;
  console.log(ok ? '远程链路验证通过' : '存在问题,请检查上述 FAIL 项');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('测试失败:', e.message || e);
  process.exit(1);
});
