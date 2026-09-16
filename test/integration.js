// 临时集成测试:走与 IPC 完全相同的底层代码路径,验证服务启停与一键更新。
// 运行:node test/integration.js [--skip-update]
'use strict';

const { run, buildEnv, compareSemver, extractVersion } = require('../lib/proc');
const { installedPiWebVersion, latestVersion, PI_WEB_PKG } = require('../lib/env');
const server = require('../lib/server');

async function main() {
  const skipUpdate = process.argv.includes('--skip-update');
  const cfg = { port: 30141, proxy: { enabled: false, url: '' }, registry: '' };

  // 1. 版本比较
  const cmp = [
    compareSemver('0.9.0', '0.9.1') === -1,
    compareSemver('1.0.0', '0.9.9') === 1,
    compareSemver('2.3.4', '2.3.4') === 0,
    extractVersion('pi version 0.85.1 (build 7)') === '0.85.1',
  ];
  console.log('[1] 版本工具:', cmp.every(Boolean) ? 'PASS' : 'FAIL', cmp);

  // 2. 服务启动 → HTTP 可访问 → 停止 → 端口不再响应
  console.log('[2] 启动 pi-web 服务…');
  const logs = [];
  const started = await server.start(cfg, { onLog: (l) => logs.push(l) });
  console.log('    started:', started.url);
  const probe = await new Promise((resolve) => {
    require('http').get(started.url, (res) => resolve(`HTTP ${res.statusCode}`)).on('error', (e) => resolve(`ERR ${e.code}`));
  });
  console.log('    探测:', probe);
  server.stop();
  await new Promise((r) => setTimeout(r, 1500));
  const after = await new Promise((resolve) => {
    require('http').get(started.url, (res) => resolve(`HTTP ${res.statusCode}`)).on('error', (e) => resolve(`ERR ${e.code}`));
  });
  console.log('    停止后探测:', after, server.isRunning() ? 'FAIL(仍在运行)' : 'PASS(已停止)');
  console.log('    服务日志尾部:', logs.slice(-3).join('').split('\n').filter(Boolean).slice(-3).join(' | '));

  // 2b. 外部实例:端口被占用时 start 应识别并复用,stop 应拒绝并保持运行
  console.log('[2b] 模拟外部启动的 pi-web…');
  const ext = require('child_process').spawn('pi-web --no-open --port 30141', { shell: true, windowsHide: true });
  await new Promise((r) => setTimeout(r, 3000));
  const adopt = await server.start(cfg, {});
  console.log('    start 识别:', JSON.stringify(adopt), adopt.external === true ? 'PASS' : 'FAIL');
  const stopRes = server.stop();
  await new Promise((r) => setTimeout(r, 800));
  const extAlive = await new Promise((resolve) => {
    require('http').get('http://127.0.0.1:30141/', (res) => resolve(`HTTP ${res.statusCode}`)).on('error', (e) => resolve(`ERR ${e.code}`));
  });
  console.log('    stop 返回:', JSON.stringify(stopRes), '外部实例仍在:', extAlive, stopRes.external === true && String(extAlive).startsWith('HTTP') ? 'PASS' : 'FAIL');
  const { killTree } = require('../lib/proc');
  killTree(ext);
  await new Promise((r) => setTimeout(r, 1500));
  server.state();

  if (skipUpdate) return;

  // 3. 更新前版本 & 最新版本
  const before = await installedPiWebVersion(cfg);
  const latest = await latestVersion(cfg);
  console.log(`[3] 更新前 pi-web=${before}, registry 最新=${latest}`);

  // 4. 一键更新(等价于 update:run 的核心逻辑)
  console.log(`[4] 执行 npm install -g ${PI_WEB_PKG}@latest …`);
  const res = await run(`npm install -g ${PI_WEB_PKG}@latest`, {
    env: buildEnv(cfg),
    timeoutMs: 10 * 60 * 1000,
  });
  console.log('    npm 退出码:', res.code);
  if (res.code !== 0) {
    console.log('    stderr 尾部:', res.stderr.split('\n').slice(-5).join('\n    '));
    process.exit(1);
  }
  const afterVer = await installedPiWebVersion(cfg);
  console.log(`[5] 更新后 pi-web=${afterVer}`, compareSemver(afterVer, latest) >= 0 ? 'PASS(已达到最新)' : 'FAIL');
}

main()
  .then(() => {
    console.log('全部完成');
    process.exit(0);
  })
  .catch((e) => {
    console.error('测试失败:', e);
    process.exit(1);
  });
