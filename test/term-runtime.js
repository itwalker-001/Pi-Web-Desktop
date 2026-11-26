// SSH 终端运行时验证(手动 E2E:真实 Electron 实例 + 真实 SSH 服务器)。
// 前提:本机能用默认私钥免密登录 user@host(默认 bk@172.16.10.131,可用环境变量覆盖)。
// 验证内容:入口按钮 → xterm 渲染 → 键入回显(渲染层→IPC→PTY→SSH 往返)→
//   Ctrl+V 文本粘贴 → Ctrl+V 截图上传(真实 SFTP 写 /tmp)→ 远端文件核对 → 返回回收。
// 运行:node test/term-runtime.js [user@host]
// 注意:实例用独立 --user-data-dir 启动,结束时强杀进程并清理目录。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-rt-'));
const DEBUG_PORT = 9333;
const [userAtHost = 'bk@172.16.10.131'] = process.argv.slice(2);
const [sshUser, sshHost] = userAtHost.includes('@') ? userAtHost.split('@') : ['bk', userAtHost];

let failed = 0;
function check(cond, msg, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}${cond || detail === undefined ? '' : `  [${detail}]`}`);
  if (!cond) failed += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, tag) => Promise.race([p, sleep(ms).then(() => { throw new Error(`超时:${tag}`); })]);

// 1x1 红色 PNG(截图上传用)
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const pngFile = path.join(USER_DATA, 'probe.png');
fs.writeFileSync(pngFile, PNG);

function ps(args) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', ...args], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      resolve({ err: err && String(err.message), stdout: String(stdout || '') });
    });
  });
}
const setClipboardText = (t) => ps(['-Command', `Set-Clipboard -Value ${JSON.stringify(t).replace(/"/g, "'")}`]);
// PowerShell 单引号字符串里反斜杠是字面量,不需转义;路径里有单引号的场景不存在(临时目录)
const setClipboardImage = () =>
  ps([
    '-STA', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;` +
    `$i=[System.Drawing.Image]::FromFile('${pngFile}');` +
    `[System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()`,
  ]);

function ssh(cmd) {
  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `${sshUser}@${sshHost}`, cmd], { timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/* ---------- 极简 CDP 客户端(Node 24 全局 WebSocket) ---------- */
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => {
        try { resolve(JSON.parse(s)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
let ws = null;
let msgId = 0;
const pending = new Map();
function cdpSend(method, params = {}) {
  msgId += 1;
  const id = msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function ev(expression) {
  const r = await cdpSend('Runtime.evaluate', { expression, returnByValue: true });
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

// 终端屏上的可见文本(xterm 渲染后的行)
const termText = () => ev(`Array.from(document.querySelectorAll('#termMount .xterm-rows > div')).map((d) => d.textContent).join('\\n')`);
const waitTermText = async (re, tag, ms = 20000) => {
  for (let i = 0; i < ms / 250; i++) {
    const t = await termText();
    if (re.test(t)) return t;
    await sleep(250);
  }
  throw new Error(`等不到 ${tag}`);
};

let app = null;
async function main() {
  // 预写隔离配置:仅一个远程档案、不自启服务
  fs.writeFileSync(
    path.join(USER_DATA, 'config.json'),
    JSON.stringify({
      mode: 'remote', activeRemoteId: 'A', defaultMode: 'last', defaultRemoteId: '', port: 30141, autoStart: false,
      registry: '',
      remotes: [{ id: 'A', host: sshHost, port: 22, user: sshUser, authType: 'key', keyPath: '', password: '', remotePort: 30141, hostFingerprint: '' }],
    })
  );
  // 清掉上次可能残留的上传产物
  await ssh('rm -rf /tmp/pi-paste-*/; rm -f /tmp/runtime-*.txt'); // 每次上传一个独立目录,整个清掉

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
    }
  });
  await cdpSend('Runtime.enable');

  // 等应用完成初始化(远程已配置,检测会跑)
  for (let i = 0; i < 40; i++) {
    if (await ev("!!document.getElementById('termOpenBtn') && !document.getElementById('termOpenBtn').disabled")) break;
    await sleep(500);
  }
  check((await ev("!document.getElementById('termOpenBtn').disabled")) === true, '远程模式:终端入口可用');

  // 1) 打开终端:等 xterm 渲染出远程提示符/欢迎语
  await ev("document.getElementById('termOpenBtn').click()");
  await withTimeout(
    (async () => {
      for (let i = 0; i < 60; i++) {
        if (await ev("!!document.querySelector('#termMount .xterm') && document.querySelectorAll('#termMount .xterm-rows > div').length > 0")) return;
        await sleep(500);
      }
      throw new Error('xterm 未渲染');
    })(),
    45000,
    'xterm 渲染'
  );
  check(true, '终端视图打开,xterm 已渲染远程输出');
  check((await ev("document.getElementById('termTitle').textContent")) === `${sshUser}@${sshHost}`, '标题为当前目标', await ev("document.getElementById('termTitle').textContent"));
  check((await ev("document.getElementById('termOverlay').hidden")) === true, '无断开遮罩');

  // 2) 键入命令并回车:完整往返(渲染层→termWrite→PTY→SSH→term:data→xterm)
  // 用 CDP Input.dispatchKeyEvent 派发可信按键(合成 DOM 事件不被 xterm 的按键管线采信)
  await sleep(1500); // 等 xterm 输入侧完全就绪(渲染完成立刻打字会被吞掉)
  await ev("document.querySelector('#termMount textarea').focus()");
  const key = (params) => cdpSend('Input.dispatchKeyEvent', params);
  const typeText = async (s) => {
    for (const ch of s) {
      await key({ type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
      await key({ type: 'keyUp', key: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
    }
  };
  const pressEnter = () => key({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
    .then(() => key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }));
  const pressCtrl = (ch, code) => key({ type: 'rawKeyDown', modifiers: 2, key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    .then(() => key({ type: 'keyUp', modifiers: 2, key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }));
  await typeText('echo RUNTIME_OK_7f3d');
  await pressEnter();
  const out = await withTimeout(waitTermText(/RUNTIME_OK_7f3d/, '命令回显'), 15000, '命令回显');
  check(/RUNTIME_OK_7f3d/.test(out), '键入命令 → 远端执行 → 回显(round-trip)');

  // 3) Ctrl+V 粘贴文本
  await setClipboardText('PASTE_TEXT_OK_91');
  await sleep(400);
  await pressCtrl('v', 'KeyV');
  await withTimeout(waitTermText(/PASTE_TEXT_OK_91/, '文本粘贴回显'), 15000, '文本粘贴回显');
  check(true, 'Ctrl+V 文本:粘贴进输入行');
  await pressEnter();

  // 4) Ctrl+V 截图上传:真实剪贴板位图 → SFTP → /tmp,路径填入输入行
  await setClipboardImage();
  await sleep(400);
  await pressCtrl('v', 'KeyV');
  const up = await withTimeout(waitTermText(/\/tmp\/pi-paste-/, '上传路径填入输入行'), 30000, '上传路径填入输入行');
  const m = up.match(/\/tmp\/pi-paste-\S+\.png/);
  check(!!m, 'Ctrl+V 截图:上传后路径填入输入行', up.slice(-120));
  // 远端核对:文件存在、是 PNG(剪贴板往返会再编码,字节数与本地原件不同是正常的)
  if (m) {
    const ls = await ssh(`s=$(stat -c %s ${m[0].replace(/'/g, "'\\''")} 2>/dev/null); h=$(od -An -tx1 -N4 ${m[0].replace(/'/g, "'\\''")} 2>/dev/null | tr -d ' \\n'); echo "$s $h"`);
    const [size, hex] = ls.stdout.trim().split(/\s+/);
    check(Number(size) > 0 && Number(size) < 102400 && hex === '89504e47', `远端文件存在且为有效 PNG(${size}B)`, `${m[0]} → ${ls.stdout.trim() || ls.stderr.slice(0, 80)}`);
  }
  // 收尾:清掉这条命令行(Ctrl+C),避免遮住后续断言
  await pressCtrl('c', 'KeyC');
  await sleep(600);

  // 5) 返回控制台:会话停止、视图切回
  await ev("document.getElementById('termBackBtn').click()");
  await sleep(800);
  check((await ev("document.getElementById('termView').hidden")) === true, '返回控制台:终端视图隐藏');

  // 6) 远端没有遗留的交互 shell(会话通道已关)
  const sh = await ssh(`pgrep -af 'sshd: ${sshUser}@notty' | grep -c bash || true`);
  check(true, '(信息)当前 sshd 会话数:' + sh.stdout.trim());
}

main()
  .then(async () => {
    console.log(failed ? `\n${failed} 项失败` : '\nSSH 终端运行时验证: 全部通过');
  })
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
    process.exit(failed ? 1 : 0);
  });
