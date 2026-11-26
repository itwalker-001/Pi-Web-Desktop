// SSH 终端运行时验证(手动 E2E:真实 Electron 实例 + 真实 SSH 服务器)。
// 前提:本机能用默认私钥免密登录 user@host(默认 bk@172.16.10.131)。
// 验证内容:
//   渲染(WebGL,或不可用时的回退)与 Unicode 11 宽度 → 键入回显(渲染层→IPC→PTY→SSH 往返)→
//   会话环境(COLORTERM、locale 不被动、代理继承 / 关闭)→ Ctrl+V 原样送达(^V)→ Alt+V 文本粘贴 → Alt+V 截图上传(真实 SFTP 写 /tmp)
//   → 远端文件核对 → Shift+Enter 换行序列 → 链接 Ctrl+单击 → 视图隐藏再显示后的重排 → 主题切换 →
//   tmux 会话保活(服务器有 tmux 才跑完整流程;没有则验证如实报 missing)→ 返回回收。
// 运行:node test/term-runtime.js [user@host]
// 离线隔离验证(不连接 SSH/不启动 Electron):node test/term-runtime.js --check-isolation
//   环境变量 PI_TERM_E2E_ARGS 可给 Electron 追加启动参数(如 "--disable-gpu",验证 WebGL 不可用时的回退)。
// 注意:实例用独立 --user-data-dir 启动,结束时强杀进程并清理目录。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OFFLINE = process.argv.includes('--check-isolation');
const USER_DATA = OFFLINE ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-rt-'));
const { randomUUID } = require('crypto');
const TEST_ID = randomUUID();
const TMUX_SOCKET = `pi-term-e2e-${TEST_ID}`;
const uploadDirs = new Set();
let isolationInstalled = false;
let remoteTouched = false;
const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
function uploadDir(remotePath) {
  // Only directories returned by this run's upload are eligible; never expand globs.
  const match = /^\/tmp\/(pi-paste-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^/\r\n]+$/i.exec(remotePath);
  if (!match) throw new Error(`拒绝清理非上传目录:${remotePath}`);
  return `/tmp/${match[1]}`;
}
// Runs in the main-process inspector before the first terminal opens. Replacing the
// exported launchScript alone would NOT affect start's lexical binding.
function installIsolation(term, socket) {
  const command = term.launchScript({ tmuxBin: '/usr/bin/tmux', tmuxSocket: socket });
  if (!command.includes(socket) || command.includes('pi-web-desktop')) {
    throw new Error('缺少内部 tmuxSocket 注入接口;拒绝接触正式 tmux socket');
  }
  const originalStart = term.start;
  const originalUpload = term.upload;
  const uploads = [];
  term.start = function (cfg, options) {
    return originalStart.call(this, cfg, { ...options, tmuxSocket: socket });
  };
  term.upload = async function (...args) {
    const paths = await originalUpload.apply(this, args);
    uploads.push(...paths);
    return paths;
  };
  return { socket, uploads };
}
const DEBUG_PORT = 9333;
const INSPECT_PORT = 9334; // 主进程调试口(仅测试用,见下方 openedByShell)
const EXTRA_ARGS = (process.env.PI_TERM_E2E_ARGS || '').split(/\s+/).filter(Boolean);
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
const pngFile = USER_DATA && path.join(USER_DATA, 'probe.png');
if (!OFFLINE) fs.writeFileSync(pngFile, PNG);

// 中文 + emoji 一行(base64 送过去再解码:键盘事件逐字键入 emoji 会走另一条输入路径)
const EMOJI_LINE = '完成✅接下来做🎉然后👍测试😀A';
const MARKER = `/tmp/pi-web-desktop-e2e-${TEST_ID}.txt`;

function ps(args) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', ...args], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      resolve({ err: err && String(err.message), stdout: String(stdout || '') });
    });
  });
}
const setClipboardText = async (t) => {
  let result;
  for (let attempt = 0; attempt < 8; attempt++) {
    result = await ps(['-Command', `Set-Clipboard -Value ${JSON.stringify(t).replace(/"/g, "'")}`]);
    if (!result.err) return result;
    await sleep(250);
  }
  return result;
};
// PowerShell 单引号字符串里反斜杠是字面量,不需转义;路径里有单引号的场景不存在(临时目录)
const setClipboardImage = () =>
  ps([
    '-STA', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;` +
    `$i=[System.Drawing.Image]::FromFile('${pngFile}');` +
    `[System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()`,
  ]);

function ssh(cmd) {
  if (OFFLINE) throw new Error('离线检查禁止 SSH');
  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `${sshUser}@${sshHost}`, cmd], { timeout: 20000 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/* ---------- 极简 CDP 客户端(Node 24 全局 WebSocket):渲染页与主进程调试口各一条连接 ---------- */
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
function connectCdp(wsUrl, label) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let msgId = 0;
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error(`${label}:CDP WebSocket 连接失败`)));
  });
  ws.addEventListener('message', (msg) => {
    const m = JSON.parse(String(msg.data));
    if (!m.id || !pending.has(m.id)) return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`${label}:${m.error.message}`));
    else p.resolve(m.result);
  });
  return opened.then(() => ({
    send: (method, params = {}) => {
      const id = ++msgId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => { try { ws.close(); } catch {} },
  }));
}
let page = null;     // 渲染页
let mainProc = null; // 主进程调试口(仅测试用)
async function evaluateIn(cdp, expression, label) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`${label}求值异常:${(d.exception && d.exception.description) || d.text} ← ${expression.slice(0, 80)}`);
  }
  return r.result && r.result.value;
}
const ev = (expression) => evaluateIn(page, expression, '页面');
const mainEv = (expression) => evaluateIn(mainProc, expression, '主进程');

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

/* ---------- 页面侧取数:都从 xterm 缓冲区读(WebGL 渲染器下页面里没有行节点) ---------- */
// 终端屏上的可见文本(可见区各行,换行拼接)
const SCREEN_TEXT = `(() => {
  const t = termState && termState.term;
  if (!t) return '';
  const b = t.buffer.active;
  const rows = [];
  for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
    const line = b.getLine(y);
    if (line) rows.push(line.translateToString(true));
  }
  return rows.join('\\n');
})()`;
const termText = () => ev(SCREEN_TEXT);
const waitTermText = async (re, tag, ms = 20000) => {
  let last = '';
  for (let i = 0; i < ms / 250; i++) {
    last = await termText();
    if (re.test(last)) return last;
    await sleep(250);
  }
  throw new Error(`等不到 ${tag};屏幕末尾:\n${last.slice(-700)}`);
};
// 含 needle 的那一行:每个字符占的格数(宽字符的第二格不计)
const lineCells = (needle) => ev(`(() => {
  const t = termState.term;
  const b = t.buffer.active;
  for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
    const line = b.getLine(y);
    if (!line || !line.translateToString(true).includes(${JSON.stringify(needle)})) continue;
    const cells = [];
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x);
      if (c.getWidth()) cells.push({ chars: c.getChars(), width: c.getWidth() });
    }
    return cells;
  }
  return null;
})()`);
// needle 首次出现处中心点的页面坐标(给鼠标事件用)。
// 优先取「以 needle 开头」的行(命令的输出行),别取回显出来的命令行 —— 那行 URL 后面还跟着分隔符
const pointOf = (needle) => ev(`(() => {
  const t = termState.term;
  const b = t.buffer.active;
  const r = t.element.querySelector('.xterm-screen').getBoundingClientRect();
  const cw = r.width / t.cols;
  const ch = r.height / t.rows;
  const hits = [];
  for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
    const line = b.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    const x = text.indexOf(${JSON.stringify(needle)});
    if (x >= 0) hits.push({ x, y, trimmed: text.trimStart().startsWith(${JSON.stringify(needle)}) });
  }
  const hit = hits.find((h) => h.trimmed) || hits[0];
  return hit ? { x: r.left + (hit.x + 0.5) * cw, y: r.top + (hit.y - b.viewportY + 0.5) * ch } : null;
})()`);
const RENDERER_INFO = `(() => {
  const mount = document.getElementById('termMount');
  const canvases = Array.from(mount.querySelectorAll('.xterm-screen canvas'));
  const main = canvases[canvases.length - 1];
  const rect = main ? main.getBoundingClientRect() : null;
  return {
    webgl: canvases.length > 0, // WebGL 渲染器画在 canvas 上;回退后是 DOM 行节点
    domRows: mount.querySelectorAll('.xterm-rows').length > 0,
    canvases: canvases.length,
    dpr: window.devicePixelRatio,
    // 画布分辨率应与显示尺寸 × 缩放一致(高分屏下只画出四分之一画面就是这里不对)
    canvasOk: rect ? Math.abs(main.width - rect.width * window.devicePixelRatio) <= 2 : null,
    unicode: termState.term.unicode.activeVersion,
  };
})()`;
const overlayText = () => ev("document.getElementById('termOverlay').hidden ? '' : document.getElementById('termOverlayText').textContent");

let app = null;
async function main() {
  // 预写隔离配置:仅一个远程档案、不自启服务。给它配一个用不到的代理地址:终端会话默认继承代理,
  // 这里验证环境变量确实进了会话(不会真有请求走它)
  const profile = { id: 'A', host: sshHost, port: 22, user: sshUser, authType: 'key', keyPath: '', password: '', remotePort: 30141, hostFingerprint: '' };
  const PROXY = { enabled: true, protocol: 'http', host: '10.255.255.1', port: 3128, bypass: '' };
  fs.writeFileSync(
    path.join(USER_DATA, 'config.json'),
    JSON.stringify({
      mode: 'remote', activeRemoteId: 'A', defaultMode: 'last', defaultRemoteId: '', port: 30141, autoStart: false,
      registry: '', termProxy: true, termTmux: false,
      remotes: [{ ...profile, proxy: PROXY }],
    })
  );
  // No pre-run remote deletion: every run owns a fresh socket and marker.
  let tmuxOnServer = '';

  // 主进程开一个调试口(仅测试用):把 shell.openExternal 换成记录器,这样能验证「链接确实交给了系统浏览器」,
  // 又不会真弹出浏览器。页面里的 piApi 是 contextBridge 暴露的对象,不允许替换,只能在这一层拦
  const inspectArg = EXTRA_ARGS.find((a) => /^--inspect/.test(a));
  const launchArgs = [...(inspectArg ? [] : [`--inspect=${INSPECT_PORT}`]), '.', `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${DEBUG_PORT}`, ...EXTRA_ARGS];
  app = spawn(ELECTRON, launchArgs, { cwd: ROOT, stdio: 'ignore' });
  page = await connectCdp(await withTimeout(waitPage(), 40000, 'Electron 启动'), '页面');
  await page.send('Runtime.enable');
  let openedByShell = null; // null = 没能拦到 shell.openExternal(链接的真实点击就不做)
  const inspectTargets = await getJson(`http://127.0.0.1:${inspectArg ? (inspectArg.split('=')[1] || 9229) : INSPECT_PORT}/json/list`).catch(() => []);
  const inspectTarget = inspectTargets.find((t) => t.type === 'node');
  if (!inspectTarget) throw new Error('没有主进程调试口;不能隔离 tmux,中止测试');
  if (inspectTarget) {
    mainProc = await connectCdp(inspectTarget.webSocketDebuggerUrl, '主进程');
    const isolatedSocket = await mainEv(`(() => {
      const term = process.mainModule.require(${JSON.stringify(path.join(ROOT, 'lib', 'term.js'))});
      globalThis.__termRuntimeIsolation = (${installIsolation.toString()})(term, ${JSON.stringify(TMUX_SOCKET)});
      return globalThis.__termRuntimeIsolation.socket;
    })()`);
    if (isolatedSocket !== TMUX_SOCKET) throw new Error('测试 socket 注入失败');
    isolationInstalled = true;
    // 主进程调试口的全局作用域里没有 require(那是主模块的局部变量),要从 process.mainModule 取
    const stubbed = await mainEv(`(() => {
      const electron = process.mainModule.require('electron');
      globalThis.__openedLinks = [];
      electron.shell.openExternal = (u) => { globalThis.__openedLinks.push(String(u)); return Promise.resolve(); };
      return electron.shell.openExternal.name !== 'openExternal';
    })()`).catch((e) => { console.log('(信息)替换 shell.openExternal 失败:' + e.message); return false; });
    if (stubbed) openedByShell = () => mainEv('globalThis.__openedLinks.slice()');
    // Keep the inspector even if link interception fails: cleanup needs upload paths.
  }
  if (!isolationInstalled) throw new Error('tmux 隔离未安装');
  remoteTouched = true;
  tmuxOnServer = (await ssh(`bash -ilc "command -v tmux" 2>/dev/null | tail -1`)).stdout.trim();

  // 等应用脚本执行完并完成初始化。不能只看按钮是否 disabled:脚本执行前它本来就没被禁用,
  // 过早放行会让后面的求值撞上「termState 未定义」
  const appReady = "typeof termState === 'object' && !!document.getElementById('termOpenBtn') && !document.getElementById('termOpenBtn').disabled";
  for (let i = 0; i < 40; i++) {
    if (await ev(appReady)) break;
    await sleep(500);
  }
  check((await ev(appReady)) === true, '远程模式:终端入口可用');
  const ua = await ev('navigator.userAgent');
  console.log(`(信息)运行时:${(/Chrome\/[\d.]+/.exec(ua) || [''])[0]};Electron 附加参数:${EXTRA_ARGS.join(' ') || '无'}`);

  /* ---------- 键盘与执行助手 ---------- */
  const key = async (params) => {
    try {
      return await page.send('Input.dispatchKeyEvent', params);
    } catch (e) {
      throw new Error(`${e.message} ← ${JSON.stringify(params)}`); // 报错里带上被拒的按键参数
    }
  };
  // windowsVirtualKeyCode 必须给对:直接拿字符的 ASCII 码,会把 $ ! " # % & ' ( ) - . 等变成
  // Home / PageUp / PageDown / End / 方向键 / Insert / Delete(xterm 按 keyCode 判定按键)。
  // 这里给出美式键盘上「未按 Shift 的那个键」的码,Shift 状态由 text 带的字符体现
  const VK = { ' ': 32, '`': 192, '-': 189, '=': 187, '[': 219, ']': 221, '\\': 220, ';': 186, "'": 222, ',': 188, '.': 190, '/': 191 };
  const UNSHIFT = { '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };
  const vkOf = (ch) => {
    const base = UNSHIFT[ch] || ch;
    if (/[0-9]/.test(base)) return 48 + Number(base);
    if (/[a-z]/i.test(base)) return base.toUpperCase().charCodeAt(0);
    return VK[base] || 0;
  };
  // CDP 派发的是可信按键(页面里合成的 KeyboardEvent 不被 xterm 的按键管线采信)
  const typeText = async (s) => {
    for (const ch of s) {
      const vk = vkOf(ch);
      await key({ type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk });
      await key({ type: 'keyUp', key: ch, windowsVirtualKeyCode: vk });
    }
  };
  const enter = (kind, modifiers) => {
    const p = { type: kind, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
    if (kind === 'keyDown') Object.assign(p, { text: '\r', unmodifiedText: '\r' });
    if (modifiers) p.modifiers = modifiers;
    return p;
  };
  const pressEnter = () => key(enter('keyDown', 0)).then(() => key(enter('keyUp', 0)));
  const pressShiftEnter = () => key(enter('keyDown', 8)).then(() => key(enter('keyUp', 8))); // modifiers 8 = Shift
  const pressCtrl = (ch, code) => key({ type: 'rawKeyDown', modifiers: 2, key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    .then(() => key({ type: 'keyUp', modifiers: 2, key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }));
  const pressAlt = (ch, code) => key({ type: 'rawKeyDown', modifiers: 1, key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    .then(() => key({ type: 'keyUp', modifiers: 1, key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }));
  // 在远端执行一条命令并等它结束。每次用唯一的结束标记,且命令行里把它拆开写(__D"ONE_n__),
  // 回显出来的命令行拼不出完整标记 —— 只有命令真正跑完、输出到屏幕,才会出现(复用同一个标记会被
  // 屏幕上遗留的旧标记立刻命中,读到的还是命令执行前的画面)
  let runSeq = 0;
  const run = async (cmd, name, ms = 15000) => {
    runSeq += 1;
    const done = `__DONE_${runSeq}__`;
    await typeText(`${cmd}; echo __D"${done.slice(3)}"`);
    await pressEnter();
    return withTimeout(waitTermText(new RegExp(done.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name, ms), ms + 5000, name);
  };
  const waitSession = (tag) => withTimeout(
    (async () => {
      for (let i = 0; i < 90; i++) {
        if (await ev("!!(termState.term && termState.id)")) return;
        const txt = await overlayText();
        if (txt) throw new Error(`会话没建立,遮罩提示:${txt}`);
        await sleep(500);
      }
      throw new Error('会话未建立');
    })(),
    45000,
    `会话建立:${tag}`
  );
  const openTerm = async (tag) => {
    await ev("document.getElementById('termOpenBtn').click()");
    await waitSession(tag);
    await sleep(1500); // 等 xterm 输入侧完全就绪(渲染完成立刻打字会被吞掉)
    await ev("document.querySelector('#termMount textarea').focus()");
  };
  const backToConsole = async (tag) => {
    await ev("document.getElementById('termBackBtn').click()");
    await sleep(800);
    check((await ev("document.getElementById('termView').hidden")) === true, `${tag}:返回控制台,终端视图隐藏`);
  };

  /* 1) 打开终端 */
  await openTerm('首个会话');
  check(true, '终端视图打开,会话建立');
  check((await ev("document.getElementById('termTitle').textContent")) === `${sshUser}@${sshHost}`, '标题为当前目标', await ev("document.getElementById('termTitle').textContent"));
  check((await overlayText()) === '', '无断开 / 失败遮罩');

  /* 2) 渲染器与宽度表 */
  const renderer = await ev(RENDERER_INFO);
  console.log(`(信息)渲染器:${JSON.stringify(renderer)}`);
  check(renderer.webgl !== renderer.domRows, '渲染器二选一:WebGL(画布)或回退后的 DOM 行节点', JSON.stringify(renderer));
  check(renderer.webgl === false || renderer.canvasOk === true, 'WebGL 画布分辨率与显示尺寸 × 缩放一致(高分屏不缺像素)', JSON.stringify(renderer));
  check(renderer.unicode === '11', '宽度表为 Unicode 11(emoji 按两格排)', renderer.unicode);

  /* 3) 键入命令并回车:完整往返(渲染层→termWrite→PTY→SSH→term:data→xterm) */
  const out = await run('echo RUNTIME_OK_7f3d', '命令回显');
  check(/^RUNTIME_OK_7f3d$/m.test(out), '键入命令 → 远端执行 → 回显(round-trip;结束标记里带着引号也原样送达)');

  /* 4) 会话环境:登录 shell、真彩色声明、locale 不被动、代理继承(默认开) */
  // 取命令的输出行(行首锚定:回显出来的命令行前面带着提示符,不会误中)
  const outputLine = (text, head) => (text.match(new RegExp(`^${head}([^\\n]*)`, 'm')) || ['', ''])[1];
  // 命令里不要出现 !:交互式 bash 里 "!$…" 会触发历史展开
  const env = await run('echo __ENV "$COLORTERM|$LANG|$https_proxy|$0"', '会话环境');
  const envLine = `__ENV ${outputLine(env, '__ENV ')}`;
  console.log(`(信息)会话环境:${envLine}`);
  check(/^__ENV truecolor\|/.test(envLine), 'COLORTERM=truecolor 已带进会话', envLine);
  check(/\|[^|]*[Uu][Tt][Ff]-?8\|/.test(envLine), '已有的 UTF-8 locale 原样保留', envLine);
  check(/\|http:\/\/10\.255\.255\.1:3128\|/.test(envLine), '终端会话继承了这台服务器的代理设置(环境变量)', envLine);
  check(/\|-(\/[^|]*\/)?[a-z]*sh$/.test(envLine), '是登录 shell(读 profile,nvm 等的 PATH 生效)', envLine);
  check((await ev("document.getElementById('termStatusDot').title")) === '已继承这台服务器的代理设置', '状态点说明:已继承代理', await ev("document.getElementById('termStatusDot').title"));
  const nodePath = `/${outputLine(await run('command -v node', 'node 路径', 8000), '/')}`;
  check(/\/bin\/node$/.test(nodePath), '登录 shell 的 PATH 里有 node(nvm 等 profile 已生效)', nodePath);

  /* 5) Alt+V 智能粘贴文本(Ctrl+V 原样送达在 raw 段一并验证) */
  const clipboardReady = await setClipboardText('PASTE_TEXT_OK_91');
  if (clipboardReady.err) throw new Error(`无法准备测试剪贴板:${clipboardReady.err}`);
  await sleep(400);
  await ev('termState.term.focus()');
  await pressAlt('v', 'KeyV');
  await withTimeout(waitTermText(/PASTE_TEXT_OK_91/, '文本粘贴回显'), 15000, '文本粘贴回显');
  check(true, 'Alt+V 文本:粘贴进输入行');
  await pressCtrl('c', 'KeyC'); // 清掉输入行(不执行这段文本)

  // Ctrl+Shift+V(README 里写的另一条纯文本粘贴):确认在 Electron 里真能取到剪贴板并送进终端
  await setClipboardText('CSV_PASTE_OK_31');
  await sleep(400);
  await key({ type: 'rawKeyDown', modifiers: 10, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 })
    .then(() => key({ type: 'keyUp', modifiers: 10, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 }));
  await sleep(1500);
  const csvText = await termText();
  check(/CSV_PASTE_OK_31/.test(csvText), 'Ctrl+Shift+V:文本粘贴进输入行(必须真能取到剪贴板,不能让 README 说不存在的快捷键)', csvText.slice(-160));
  await pressCtrl('c', 'KeyC');

  /* 6) Alt+V 截图上传:真实剪贴板位图 → SFTP → /tmp,路径填入输入行 */
  await setClipboardImage();
  await sleep(400);
  await pressAlt('v', 'KeyV');
  const up = await withTimeout(waitTermText(/\/tmp\/pi-paste-/, '上传路径填入输入行'), 30000, '上传路径填入输入行');
  const returnedPaths = await mainEv('globalThis.__termRuntimeIsolation.uploads.slice()');
  for (const remotePath of returnedPaths) uploadDirs.add(uploadDir(remotePath));
  const uploaded = returnedPaths.find((p) => p.endsWith('.png') && up.includes(p));
  const m = uploaded ? [uploaded] : null;
  check(!!m, 'Alt+V 截图:上传后路径填入输入行', up.slice(-120));
  // 远端核对:文件存在、是 PNG(剪贴板往返会再编码,字节数与本地原件不同是正常的)
  if (m) {
    const ls = await ssh(`s=$(stat -c %s ${shellQuote(m[0])} 2>/dev/null); h=$(od -An -tx1 -N4 ${shellQuote(m[0])} 2>/dev/null | tr -d ' \\n'); echo "$s $h"`);
    const [size, hex] = ls.stdout.trim().split(/\s+/);
    check(Number(size) > 0 && Number(size) < 102400 && hex === '89504e47', `远端文件存在且为有效 PNG(${size}B)`, `${m[0]} → ${ls.stdout.trim() || ls.stderr.slice(0, 80)}`);
  }
  // 收尾:清掉这条命令行(Ctrl+C),避免遮住后续断言
  await pressCtrl('c', 'KeyC');
  await sleep(600);

  /* 7) Shift+Enter:发的是换行序列(Esc+CR),普通 Enter 仍是 CR。用 cat -v 把收到的字节按记号法回显
        (raw 模式下没有信号、不缓冲;timeout 到点自动结束并恢复终端) */
  // withCtrlV:顺带验证 Ctrl+V 原样送达;tmux 段不需要,关掉少一次输入
  const rawEcho = async (seconds, withCtrlV = true) => {
    await typeText(`stty raw -echo; timeout ${seconds} cat -v; stty sane`);
    await pressEnter();
    await sleep(1500);
    await pressShiftEnter();
    await sleep(400);
    await pressEnter();
    await sleep(1200);
    const before = await termText();
    if (withCtrlV) {
      await pressCtrl('v', 'KeyV');
      await sleep(400);
      await pressEnter();
      await sleep(1200);
    }
    const after = await termText();
    await sleep(seconds * 1000); // 等 timeout 到点、终端恢复,再继续后面的步骤
    return { before, after };
  };
  const rawOut = await rawEcho(8);
  const caretOut = (rawOut.before.match(/\^\[[\^A-Z]{0,3}[\^A-Z]{0,3}/g) || []).join(' ');
  check(caretOut.replace(/\s+$/, '') === '^[^M^M', 'Shift+Enter 发出 Esc+CR,Enter 发出 CR(远端 cat -v 回显 ^[^M 后跟 ^M)', caretOut);
  check(/\^V\^M/.test(rawOut.after.slice(-400)), 'Ctrl+V 原样送到远端(cat -v 回显 ^V),不再被应用当作粘贴拦截', rawOut.after.slice(-160));

  /* 8) 链接:悬停识别;直接单击 / 双击选词不打开;Ctrl+单击交给系统浏览器 */
  const LINK = 'https://example.com/pi-web-desktop';
  await run(`echo ${LINK}`, '链接行输出');
  const linkPoint = await pointOf(LINK);
  const click = async (count, modifiers) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: linkPoint.x, y: linkPoint.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: linkPoint.x, y: linkPoint.y, button: 'left', buttons: 1, clickCount: count, modifiers });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: linkPoint.x, y: linkPoint.y, button: 'left', buttons: 0, clickCount: count, modifiers });
  };
  if (!linkPoint) {
    check(false, '链接行在屏幕上(取坐标)', String(linkPoint));
  } else {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: linkPoint.x, y: linkPoint.y });
    await sleep(500);
    check((await ev("termState.term.element.querySelector('.xterm-screen').classList.contains('xterm-cursor-pointer')")) === true, '悬停在链接上:光标变手形(链接已被识别)');
    if (openedByShell) {
      await click(1, 0); // 直接单击
      await sleep(300);
      await click(1, 0);
      await click(2, 0); // 双击选词
      await sleep(300);
      check((await openedByShell()).length === 0, '直接单击 / 双击选词:不打开链接', JSON.stringify(await openedByShell()));
      await ev('termState.term.clearSelection()');
      await click(1, 2); // Ctrl+单击(modifiers 2 = Ctrl)
      await sleep(600);
      check(JSON.stringify(await openedByShell()) === JSON.stringify([LINK]), 'Ctrl+单击:链接交给系统浏览器打开(shell.openExternal)', JSON.stringify(await openedByShell()));
      // 主窗口对 window.open 的兜底:不新开窗口,http(s) 链接同样交给系统浏览器
      const denied = await ev("(() => { const w = window.open('https://example.com/from-window-open'); return w === null; })()");
      await sleep(600);
      check(denied === true && JSON.stringify((await openedByShell()).slice(-1)) === JSON.stringify(['https://example.com/from-window-open']), '页面里的 window.open:拿不到新窗口,链接转交系统浏览器', JSON.stringify(await openedByShell()));
      check((await mainEv("process.mainModule.require('electron').BrowserWindow.getAllWindows().length")) === 1, '整个过程只有主窗口一个窗口');
    } else {
      console.log('(信息)没能拦到主进程的 shell.openExternal:跳过链接的真实点击(避免弹出浏览器),只验证了悬停识别');
    }
    await ev('termState.term.clearSelection()');
    await ev('termState.term.focus()');
  }

  /* 9) emoji 宽度:Unicode 11 下每个 emoji 占两格,紧跟的中文不会被压住 */
  await run(`echo ${Buffer.from(EMOJI_LINE, 'utf8').toString('base64')} | base64 -d; echo`, 'emoji 行输出');
  const cells = await lineCells('完成');
  const widthOf = (chars) => (cells || []).filter((c) => c.chars === chars).map((c) => c.width);
  check(
    widthOf('✅')[0] === 2 && widthOf('🎉')[0] === 2 && widthOf('👍')[0] === 2 && widthOf('😀')[0] === 2 &&
      widthOf('完')[0] === 2 && widthOf('A')[0] === 1,
    'emoji 与中文各占两格、英文占一格',
    JSON.stringify(cells)
  );

  /* 10) 视图隐藏再显示(与 Pi Web 服务页互切时的情形):重排后画布尺寸正确、会话照常可键入 */
  await ev("document.getElementById('termView').hidden = true");
  await sleep(500);
  await ev("document.getElementById('termView').hidden = false; refitTerm()");
  await sleep(800);
  const afterRefit = await ev(RENDERER_INFO);
  check(afterRefit.webgl === renderer.webgl && (afterRefit.webgl === false || afterRefit.canvasOk === true), '视图切回:渲染器不变,画布尺寸仍正确', JSON.stringify(afterRefit));
  await run('echo __AFTER_REFIT_5c1e', '重排后键入');
  check(true, '视图切回:会话保留,键入照常');

  /* 11) 关闭「继承代理」:新会话不再带代理 */
  await backToConsole('关闭继承代理前');
  await ev('window.piApi.setConfig({ termProxy: false })');
  await openTerm('无代理会话');
  const noProxy = `__NOPX ${outputLine(await run('echo __NOPX "[${https_proxy:-unset}]"', '无代理环境'), '__NOPX ')}`;
  check(/__NOPX \[unset\]/.test(noProxy), '关闭「继承代理」:新会话不带代理环境变量', noProxy);
  check((await ev("document.getElementById('termStatusDot').title")) === '会话状态', '关闭继承后:状态点不再提代理', await ev("document.getElementById('termStatusDot').title"));

  /* 12) 主题切换:新会话用新主题,渲染器不受影响 */
  await backToConsole('换主题前');
  await ev("document.getElementById('termThemeSelect').value = 'dracula'; document.getElementById('termSaveBtn').click()");
  await sleep(600);
  await openTerm('换主题会话');
  const themed = await ev("({ bg: termState.term.options.theme.background, fg: termState.term.options.theme.foreground, webgl: document.querySelectorAll('#termMount .xterm-screen canvas').length > 0 })");
  check(themed.bg === '#282a36' && themed.fg === '#f8f8f2', '主题预设落在新会话上', JSON.stringify(themed));
  check(themed.webgl === renderer.webgl, '换主题后渲染器不变', JSON.stringify(themed));
  await run('echo __THEMED_OK', '换主题后键入');
  check(true, '换主题后会话照常');
  await backToConsole('换主题后');

  /* 13) tmux 会话保活 */
  await ev('window.piApi.setConfig({ termTmux: true })');
  await openTerm('保活会话');
  const facts = await ev('termState.facts');
  console.log(`(信息)服务器上的 tmux:${tmuxOnServer || '未安装 / 不在登录 shell 的 PATH 里'};会话 facts:${JSON.stringify(facts)}`);
  if (facts.tmux === 'on') {
    const dotTitle = await ev("document.getElementById('termStatusDot').title");
    check(/会话保活已开启/.test(dotTitle) && /需重连确认/.test(await ev("document.getElementById('termBackBtn').title")), '开了保活:状态点与返回按钮如实说明需重连确认', dotTitle);
    const tm = `__TMUX=${outputLine(await run('echo __TMUX="$TMUX"', 'tmux 环境变量'), '__TMUX=')}`;
    check(tm.includes(`/${TMUX_SOCKET},`) && /,\d+,\d+$/.test(tm), '会话在本轮唯一 socket 的 tmux 里', tm);
    if (!tm.includes(`/${TMUX_SOCKET},`)) throw new Error('实际 tmux socket 不匹配;中止测试');
    // tmux 里的 Shift+Enter:确认序列穿过 tmux 后没变
    const tmRaw = await rawEcho(6, false);
    const tmCaret = (tmRaw.before.match(/\^\[[\^A-Z]{0,3}[\^A-Z]{0,3}/g) || []).join(' ');
    check(tmCaret.replace(/\s+$/, '') === '^[^M^M', 'tmux 里 Shift+Enter 仍是 Esc+CR(序列穿过 tmux 不变)', tmCaret);
    // Arm after rawEcho; abort if the delayed task finishes before confirmed
    // disconnection, rather than falsely claiming it survived a disconnect.
    await run(`export E2E_VAR=kept-5a9c; (sleep 30; echo __SURVIVED > ${shellQuote(MARKER)}) < /dev/null > /dev/null 2>&1 & echo __ARMED`, '布置后台任务');
    const markerAbsent = async () => {
      const result = await ssh(`test ! -e ${shellQuote(MARKER)}`);
      if (result.code !== 0) throw new Error('marker 已存在或 SSH 核对失败;不能证明断线期间完成');
    };
    await markerAbsent();
    // 制造一次真实的 SSH 断开:改档案的连接身份,主进程会断开该连接
    const cfgNow = await ev('window.piApi.getConfig()');
    await ev(`window.piApi.setConfig({ remotes: ${JSON.stringify(cfgNow.remotes.map((r) => ({ ...r, keyPath: 'e2e-identity-change' })))}})`);
    const dropped = await withTimeout(
      (async () => {
        for (let i = 0; i < 60; i++) {
          const txt = await overlayText();
          if (txt) return txt;
          await sleep(250);
        }
        throw new Error('未断开');
      })(),
      20000,
      '等待断线'
    );
    check(/tmux 任务可能保留,需重连确认/.test(dropped), 'SSH 断开:遮罩不保证任务存活,提示重连确认', dropped);
    await markerAbsent(); // Confirm it was still pending after SSH disconnected.
    await ev(`window.piApi.setConfig({ remotes: ${JSON.stringify(cfgNow.remotes)}})`);
    let completedWhileDisconnected = false;
    for (let i = 0; i < 90; i++) {
      if ((await ssh(`cat ${shellQuote(MARKER)} 2>/dev/null`)).stdout.trim() === '__SURVIVED') {
        completedWhileDisconnected = true;
        break;
      }
      await sleep(500);
    }
    if (!completedWhileDisconnected) throw new Error('断线期间后台任务没有完成');
    await ev("document.getElementById('termOverlayReconnect').click()");
    await waitSession('重连');
    await sleep(1500);
    // 断线重连后「视图还在、焦点回到终端输入框」是能继续打字的前提(曾因 server:exited 把人切回控制台而整段失效)
    const afterReconnect = await ev(`(() => ({
      viewVisible: !document.getElementById('termView').hidden,
      active: document.activeElement && (document.activeElement.className || document.activeElement.tagName),
    }))()`);
    console.log('(信息)重连后:' + JSON.stringify(afterReconnect));
    await ev('termState.term.focus()');
    // 先经 IPC 直接写一条命令,再走键盘:区分「会话输入通路没通」和「按键没到 xterm(焦点问题)」
    await ev(`window.piApi.termWrite({ id: termState.id, data: 'echo __DIRECT_1\\r' })`);
    await sleep(1800);
    const afterDirect = await termText();
    check(afterReconnect.viewVisible && /textarea/.test(String(afterReconnect.active)) && /__DIRECT_1/.test(afterDirect), '重连后:留在终端视图、焦点在输入框、IPC 写入的命令被执行', JSON.stringify(afterReconnect));
    const backOk = await run('echo __BACK_OK_1', '重连后键入', 10000);
    check(/^__BACK_OK_1$/m.test(backOk), '重连后键入照常(按键到达 xterm)', backOk.slice(-200));
    const resumed = `__RESUMED ${outputLine(await run(`echo __RESUMED "VAR=$E2E_VAR M=$(cat ${shellQuote(MARKER)})"`, '重连后核对'), '__RESUMED ')}`;
    check(/__RESUMED VAR=kept-5a9c M=__SURVIVED$/.test(resumed), '重连后回到原会话:变量还在,断线期间后台任务照常跑完', resumed);
  } else {
    check(facts.tmux === 'missing', '开了保活但服务器没有 tmux:如实报 missing(不是「已开启」)', JSON.stringify(facts));
    check(!/保活/.test(await ev("document.getElementById('termStatusDot').title")), '没有 tmux:状态点不谎报保活', await ev("document.getElementById('termStatusDot').title"));
    const toastTexts = await ev("Array.from(document.querySelectorAll('#toastWrap > *')).map((e) => e.textContent).join(' | ')");
    check(/没有安装 tmux/.test(toastTexts), '没有 tmux:提示一次原因', toastTexts);
    await run('echo __PLAIN_OK_88ab', '退回普通会话');
    check(true, '没有 tmux:退回普通登录 shell,会话照常');
  }
  await backToConsole('保活会话之后');

  // Remote cleanup lives exclusively in finally, including on assertion errors.
}

function cleanupCommands(dirs) {
  return [
    `bash -ilc ${shellQuote(`if command -v tmux >/dev/null 2>&1; then tmux -L ${shellQuote(TMUX_SOCKET)} kill-server 2>/dev/null || { tmux -L ${shellQuote(TMUX_SOCKET)} list-sessions >/dev/null 2>&1; test $? -eq 1; }; fi`)}`,
    ...Array.from(dirs, (dir) => {
      if (uploadDir(`${dir}/probe.png`) !== dir) throw new Error('无效的上传清理目录');
      return `rm -rf -- ${shellQuote(dir)}`;
    }),
    `rm -f -- ${shellQuote(MARKER)}`,
  ];
}
async function cleanupRemote() {
  if (!remoteTouched) return;
  // Read actual upload return values even if screen matching or later tests threw.
  if (mainProc && isolationInstalled) {
    try {
      const paths = await withTimeout(mainEv('globalThis.__termRuntimeIsolation.uploads.slice()'), 5000, '读取上传清理列表');
      for (const p of paths) uploadDirs.add(uploadDir(p));
    } catch (e) {
      check(false, '读取本轮上传目录失败', e.message);
    }
  }
  for (const command of cleanupCommands(uploadDirs)) {
    try {
      const result = await ssh(command);
      check(result.code === 0, '本轮远端资源清理', result.stderr);
    } catch (e) {
      check(false, '本轮远端资源清理异常', e.message);
    }
  }
}

async function checkIsolationOffline() {
  const assert = require('assert/strict');
  const vm = require('vm');
  const sandbox = { module: { exports: {} }, require: (id) => {
    if (id === './remote') return { onDisconnect() {} };
    if (id === './proxy') return {};
    return require(id);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'lib', 'term.js'), 'utf8'), sandbox);
  const production = sandbox.module.exports;
  let received;
  const term = {
    launchScript: production.launchScript,
    start(cfg, options) { received = { cfg, options }; return 'started'; },
    async upload() { return [`/tmp/pi-paste-${TEST_ID}/probe.png`]; },
  };
  const state = installIsolation(term, TMUX_SOCKET);
  assert.equal(term.start({}, { cols: 80, tmuxSocket: 'forbidden' }), 'started');
  assert.equal(received.options.tmuxSocket, TMUX_SOCKET);
  assert.equal(received.options.cols, 80);
  await term.upload();
  assert.equal(state.uploads.length, 1);
  const dir = uploadDir(state.uploads[0]);
  assert.throws(() => uploadDir('/tmp/pi-paste-*/probe.png'));
  assert.throws(() => uploadDir('/tmp/runtime-other.txt'));
  assert.throws(() => installIsolation({ launchScript: () => 'tmux -L pi-web-desktop' }, TMUX_SOCKET));
  const commands = cleanupCommands(new Set([dir]));
  assert.equal(commands.length, 3);
  assert(commands[0].includes(TMUX_SOCKET));
  assert(!commands[0].includes('-L pi-web-desktop'));
  assert(commands[1].includes(dir));
  assert(commands[2].includes(MARKER));
  assert(commands.every((cmd) => !cmd.includes('*')));
  const source = fs.readFileSync(__filename, 'utf8');
  const raw = source.indexOf('const tmRaw = await rawEcho(6, false)');
  const armed = source.indexOf('await run(`export E2E_VAR=');
  const beforeDrop = source.indexOf('await markerAbsent();', armed);
  const dropped = source.indexOf('const dropped =', beforeDrop);
  const afterDrop = source.indexOf('await markerAbsent();', dropped);
  const completed = source.indexOf('if (!completedWhileDisconnected)', afterDrop);
  const reconnect = source.indexOf("await ev(\"document.getElementById('termOverlayReconnect')", completed);
  assert(raw > 0 && raw < armed && armed < beforeDrop && beforeDrop < dropped && dropped < afterDrop && afterDrop < completed && completed < reconnect);
  assert(source.includes('try { await cleanupRemote(); }'));
  console.log('PASS: offline isolation (production launchScript, inspector wrapper, upload allowlist, exact cleanup); no SSH/Electron started');
}

(OFFLINE ? checkIsolationOffline() : main())
  .then(async () => {
    if (!OFFLINE) console.log(failed ? `\n${failed} 项失败` : '\nSSH 终端运行时验证主体完成;继续 finally 清理');
  })
  .catch(async (e) => {
    console.error('RUNTIME ERR:', e.stack || e.message);
    failed += 1;
  })
  .finally(async () => {
    try { await cleanupRemote(); } catch (e) { check(false, '远端收尾失败', e.message); }
    for (const c of [page, mainProc]) { try { if (c) c.close(); } catch {} }
    if (app && !app.killed) {
      try { process.kill(app.pid); } catch {}
      spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    await sleep(800);
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch {}
    process.exit(failed ? 1 : 0);
  });
