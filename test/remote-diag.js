// 用应用真实配置对配置的远程机器跑一次环境检测,输出每项结果与错误明细。
// 运行:node test/remote-diag.js
'use strict';

const path = require('path');
const Module = require('module');

// 把 electron.app.getPath 指向打包应用的真实 userData,读同一份配置
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'electron') {
    return { app: { getPath: () => path.join(process.env.APPDATA || '', 'Pi Web Desktop') } };
  }
  return origLoad.apply(this, [request, ...args]);
};

const config = require('../lib/config');
const remoteEnv = require('../lib/remote-env');
const remote = require('../lib/remote');

async function main() {
  const cfg = config.get();
  console.log('mode =', cfg.mode, '| active =', cfg.activeRemoteId);
  const r = cfg.remote;
  console.log('remote =', r ? `${r.user}@${r.host}:${r.port} auth=${r.authType} keyPath=${JSON.stringify(r.keyPath)}` : '(none)');

  // 1. 连接测试
  const t = await remote.testConnection(cfg);
  console.log('[连接]', t.ok ? 'OK' : 'FAIL', t.fingerprint ? `fp=${t.fingerprint.slice(0, 16)}…` : '');

  // 2. 逐项命令(与 detect 相同路径,打印原始输出/错误)
  for (const cmd of ['node -v', 'npm -v', 'pi --version']) {
    try {
      const res = await remote.exec(cfg, cmd, { timeoutMs: 25000 });
      console.log(`[${cmd}] code=${res.code} stdout=${JSON.stringify(res.stdout.trim())} stderr=${JSON.stringify(res.stderr.trim().slice(0, 120))}`);
    } catch (e) {
      console.log(`[${cmd}] EXEC-ERROR: ${e.message}`);
    }
  }

  // 3. 完整 detect
  const env = await remoteEnv.detect(cfg);
  console.log('[detect]', JSON.stringify(env, null, 2));

  remote.disconnect();
}

main().catch((e) => {
  console.error('诊断失败:', e.message);
  process.exit(1);
});
