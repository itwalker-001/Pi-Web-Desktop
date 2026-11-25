// 控制台三大块 / Code Server 配置卡 / 启动视图 运行时验证(手动 E2E:真实 Electron 实例 + 真实 SSH)。
// 运行:node test/ui-runtime.js [user@host](默认 bk@172.16.10.131)
// 验证:①启动视图(startupView=term 直达终端)②控制台三大块结构 ③cs 卡真实检测远程
// ④终端→服务页按钮在服务未启动时的提示路径 ⑤无页面错误。实例用独立 --user-data-dir,结束强杀并清理。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ui-rt-'));
const DEBUG_PORT = 9335;
const [userAtHost = 'bk@172.16.10.131'] = process.argv.slice(2);
const [sshUser, sshHost] = userAtHost.includes('@') ? userAtHost.split('@') : ['bk', userAtHost];

let failed = 0;
function check(cond, msg, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}${cond || detail === undefined ? '' : `  [${detail}]`}`);
  if (!cond) failed += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, tag) => Promise.race([p, sleep(ms).then(() => { throw new Error(`超时:${tag}`); })]);

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
let ws = null;
let msgId = 0;
const pending = new Map();
const pageErrors = [];
function cdpSend(method, params = {}) {
  msgId += 1;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
async function ev(expression) {
  const r = await cdpSend('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`evaluate 异常:${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
  return r.result && r.result.value;
}

async function waitPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('等不到调试页面');
}

let app = null;
async function main() {
  fs.writeFileSync(
    path.join(USER_DATA, 'config.json'),
    JSON.stringify({
      mode: 'remote', activeRemoteId: 'A', defaultMode: 'last', defaultRemoteId: '', port: 30141,
      autoStart: false, registry: '', startupView: 'term',
      remotes: [{ id: 'A', host: sshHost, port: 22, user: sshUser, authType: 'key', keyPath: '', password: '', remotePort: 30141, hostFingerprint: '' }],
    })
  );
  app = spawn(ELECTRON, ['.', `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${DEBUG_PORT}`], { cwd: ROOT, stdio: 'ignore' });
  const wsUrl = await withTimeout(waitPage(), 40000, 'Electron 启动');
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')));
  });
  ws.addEventListener('message', (msg) => {
    const m = JSON.parse(String(msg.data));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails && m.params.exceptionDetails.text);
    }
  });
  await cdpSend('Runtime.enable');

  // 1) 启动视图 = SSH 终端:启动后直接进入终端并渲染远程输出
  await withTimeout(
    (async () => {
      for (let i = 0; i < 80; i++) {
        if (await ev("!document.getElementById('termView').hidden && !!document.querySelector('#termMount .xterm') && document.querySelectorAll('#termMount .xterm-rows > div').length > 0")) return;
        await sleep(500);
      }
      throw new Error('终端未随启动打开');
    })(),
    60000,
    'startupView=term'
  );
  check(true, '启动视图=SSH 终端:应用启动直接进入终端并渲染远程输出');

  // 2) 服务未启动时,终端里的「Pi-web」按钮:提示而不切换
  await sleep(1500);
  await ev("document.querySelector('#termMount textarea') && document.querySelector('#termMount textarea').focus()");
  await ev("document.getElementById('termWebBtn').click()");
  await sleep(800);
  const stillTerm = await ev("document.getElementById('termView').hidden === false");
  const toastSrv = await ev("Array.from(document.querySelectorAll('#toastWrap .toast')).some((t) => /服务未启动/.test(t.textContent))");
  check(stillTerm && toastSrv, '服务未启动:终端→Pi-web 按钮提示「服务未启动」,不切视图');

  // 3) 返回控制台:三大块齐全
  await ev("document.getElementById('termBackBtn').click()");
  await sleep(600);
  const blocks = await ev("Array.from(document.querySelectorAll('#consoleView > section.card .card-head h2')).map((h) => h.textContent.replace(/\\s+/g, ' ').trim().split(' ')[0] + ' ' + (h.textContent.trim().split(' ')[1] || '')).map((s) => s.trim())");
  const titles = await ev("Array.from(document.querySelectorAll('#consoleView > section.card .card-head h2')).map((h) => h.textContent.replace(/\\s+/g, ' ').trim())");
  check(titles.length === 3 && titles[0].startsWith('Pi Web 配置') && titles[1].startsWith('Code Server 配置') && titles[2].startsWith('代理设置'), '控制台为三大块:Pi Web 配置 / Code Server 配置 / 代理设置', JSON.stringify(titles));
  check((await ev("!!document.querySelector('.piweb-grid')")) === true, 'Pi Web 卡内部为 服务|环境检测 两栏');
  check((await ev("!document.getElementById('remoteCodeServerInput')")) === true, '远程弹窗已不再包含 code-server 字段');

  // 4) cs 卡真实检测:连接真实服务器,返回 managed/installed/running 与状态文案
  const probe = await ev("window.piApi.csState({ target: { mode: 'remote', remoteId: 'A' } })");
  check(probe.ok === true && probe.local === false && typeof probe.managed === 'boolean' && probe.info && typeof probe.info.installed === 'boolean', 'cs 卡检测真实服务器成功(结构完整)', JSON.stringify(probe).slice(0, 160));
  await ev("window.detectCodeServer ? 0 : 0"); // (函数在脚本作用域,不直接可达;状态行断言见下)
  await sleep(1500);
  const csText = await ev("document.getElementById('csState').textContent");
  check(/已安装|未安装|运行中|自管|检测失败|检测中/.test(csText), `cs 卡状态行有内容:${csText}`, csText);
  check((await ev("document.getElementById('csPortInput').value !== '' || /未安装|检测失败/.test(csText)")) === true, '检测回填了服务器上的监听端口(或如实显示未装)', csText);

  // 5) 页面无未捕获异常
  check(pageErrors.length === 0, '页面无未捕获异常', pageErrors.slice(0, 3).join(';'));
}

main()
  .catch(async (e) => {
    console.error('RUNTIME ERR:', e.stack || e.message);
    failed += 1;
  })
  .finally(async () => {
    try { if (ws) ws.close(); } catch {}
    if (app && !app.killed) {
      try { process.kill(app.pid); } catch {}
      spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    await sleep(800);
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch {}
    console.log(failed ? `\n${failed} 项失败` : '\n控制台三大块 / cs 配置卡 运行时验证: 全部通过');
    process.exit(failed ? 1 : 0);
  });
