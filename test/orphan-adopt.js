// 孤儿回收单测:正常拉起写 pidfile → 模拟强杀(不走 stop)→ 下次会话 refreshExternal
// 应回收为 owned → stop 能按 PID 树结束 → pidfile 清理。运行:node test/orphan-adopt.js
'use strict';

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 模拟 electron userData,启用 pidfile 逻辑
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pid-'));
const orig = Module._load;
Module._load = function (req, ...a) {
  if (req === 'electron') return { app: { getPath: () => tmp } };
  return orig.apply(this, [req, ...a]);
};

const server = require('../lib/server');

function assert(cond, msg) {
  console.log(cond ? 'PASS: ' + msg : 'FAIL: ' + msg);
  if (!cond) process.exit(1);
}

(async () => {
  const cfg = { port: 30444, proxy: { enabled: false }, registry: '' };

  // 1) 正常拉起 → pidfile 写入
  await server.start(cfg, {});
  const pidFile = path.join(tmp, 'pi-web.pid');
  assert(fs.existsSync(pidFile), '拉起后写入 pidfile');
  const info = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert(info.pid > 0 && info.port === 30444, 'pidfile 内容 {pid,port} 正确');

  // 2) 模拟应用被强杀:直接丢弃句柄,不调 stop(进程与 pidfile 遗留)

  // 3) 模拟下次会话:refreshExternal 应把孤儿回收为 owned(可停止)
  const st = await server.refreshExternal(cfg);
  assert(st.running && st.owned && !st.external, '孤儿被回收为 owned(端口占用但可停止)');

  // 4) stop 应能按 PID 树结束孤儿进程
  const r = server.stop();
  assert(r.stopped === true, 'stop 返回 stopped');
  await new Promise((res) => setTimeout(res, 1500));
  let alive = false;
  try { process.kill(info.pid, 0); alive = true; } catch {}
  assert(!alive, '孤儿进程已被结束');
  assert(!fs.existsSync(pidFile), 'pidfile 已清理');

  // 5) 端口释放验证
  await new Promise((res) => setTimeout(res, 500));
  const code = await fetch(`http://127.0.0.1:30444/`, { signal: AbortSignal.timeout(3000) })
    .then((x) => x.status).catch(() => 'ERR');
  assert(String(code).startsWith('ERR'), '端口已释放');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('孤儿回收: 全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('TEST ERR:', e.message);
  process.exit(1);
});
