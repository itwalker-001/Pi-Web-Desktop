// 校验远程模式的 stdin 脚本在 node 下可直接执行且输出可解析(无需真实 SSH)。
// 运行:node test/scripts-check.js
'use strict';

const { execFileSync } = require('child_process');
const { GLOBAL_INFO_SCRIPT } = require('../lib/remote-env');

function run(input, args = []) {
  return execFileSync('node', args, { input, encoding: 'utf8', timeout: 120000 });
}

function extract(out) {
  const m = out.match(/__PI_JSON_BEGIN__\r?\n([\s\S]*?)\r?\n?__PI_JSON_END__/);
  return m ? JSON.parse(m[1]) : null;
}

function main() {
  // 1. 全局包采集脚本:本地执行,应输出 npmRoot 与合法的 JSON 结构
  const info = extract(run(GLOBAL_INFO_SCRIPT));
  console.log('[1] GLOBAL_INFO_SCRIPT:', JSON.stringify(info));
  if (!info || typeof info.npmRoot !== 'string' || !info.npmRoot) throw new Error('npmRoot 缺失');
  if (!('piWebVersion' in info) || !('piPkg' in info)) throw new Error('字段缺失');

  // 2. 探测脚本(remote-server 内联构造同样格式):构造一个探测本机空闲端口的实例应返回 ok:false
  const probeScript = `
    let done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      console.log('__PI_JSON_BEGIN__');
      console.log(ok ? '{"ok":true}' : '{"ok":false}');
      console.log('__PI_JSON_END__');
    }
    const req = require('http').get('http://127.0.0.1:59999/', (res) => { res.resume(); finish(true); });
    req.on('error', () => finish(false));
    req.setTimeout(2500, () => req.destroy(new Error('timeout')));
    req.on('close', () => finish(false));
  `;
  const probe = extract(run(probeScript));
  console.log('[2] probe(空闲端口):', JSON.stringify(probe));
  if (!probe || probe.ok !== false) throw new Error('空闲端口探测应返回 ok:false');

  console.log('PASS');
}

main();
