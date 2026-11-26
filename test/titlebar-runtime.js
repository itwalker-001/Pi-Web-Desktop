// 无边框窗口运行时验证(手动 E2E:真实 Electron 实例,Windows 专属)。
// 系统标题栏隐藏后,顶栏与两条紧凑工具栏要充当标题栏 —— 哪里可拖拽、窗口按钮在哪,都是系统层面的命中结果,
// 页内脚本测不到。这里直接问系统(WM_NCHITTEST):某个点落在「标题栏 / 最小化 / 最大化 / 关闭 / 页面」哪一类。
// 覆盖:①控制台视图 ②最窄窗口(920)下内容不钻到窗口按钮底下 ③服务页与终端的紧凑工具栏 ④弹窗打开时仍可拖拽、可关闭。
// 做法:隔离 userData + 本机模式(不连任何服务器);只发窗口消息、不抢前台、不移动鼠标、只截应用自己的窗口。
// 运行:node test/titlebar-runtime.js [--shots](--shots 另存各视图的窗口截图到临时目录,供人工查看)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PS1 = path.join(__dirname, 'helpers', 'win-probe.ps1');
const WITH_SHOTS = process.argv.includes('--shots');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-titlebar-'));
const SHOTS = WITH_SHOTS ? fs.mkdtempSync(path.join(os.tmpdir(), 'pi-titlebar-shots-')) : '';
const PORT = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
function expect(label, actual, want) {
  const ok = String(actual) === String(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${ok ? '' : `  [实际 ${actual},应为 ${want}]`}`);
  if (!ok) failures.push(label);
}
function near(label, actual, want, tol = 1) {
  const ok = Math.abs(Number(actual) - want) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}${ok ? '' : `  [实际 ${actual},应为 ${want}±${tol}]`}`);
  if (!ok) failures.push(label);
}

const ps = (args) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8', windowsHide: true, timeout: 40000 });
// 命中测试 + 可选截图/调整大小。返回每个点的命中码(按传入顺序)和窗口外框尺寸(物理像素)
function runProbe(hwnd, { points = [], shot = '', size = '' }) {
  const args = ['-File', PS1, '-Hwnd', hwnd];
  if (points.length) args.push('-Points', points.map((p) => p.join(',')).join(';'));
  if (shot) args.push('-Shot', shot);
  if (size) args.push('-Size', size.map(Math.round).join(','));
  const map = {};
  let rect = null;
  for (const line of ps(args).split(/\r?\n/)) {
    const h = line.match(/^([\d.]+,[\d.]+)=(-?\d+)$/);
    const r = line.match(/^RECT (\d+)x(\d+) origin (-?\d+),(-?\d+) scale ([\d.]+)$/);
    if (h) map[h[1]] = Number(h[2]);
    else if (r) rect = { w: Number(r[1]), h: Number(r[2]), scale: Number(r[5]) };
    else if (line.trim()) console.log('  ' + line.trim());
  }
  return { hits: points.map((p) => map[`${p[0]},${p[1]}`]), rect };
}
const probe = (hwnd, points, name) => runProbe(hwnd, { points, shot: SHOTS ? path.join(SHOTS, `${name}.png`) : '' }).hits;
const setWindowSize = (hwnd, w, h) => runProbe(hwnd, { size: [w, h] }).rect;
// 窗口按钮(0 最小化 / 1 最大化 / 2 关闭)的中心横坐标:按钮区宽 = 视口宽 − 标题栏区右缘,三格等宽。
// 按钮宽度由系统决定,按实际值算,不写死
const buttonCenter = (controlsLeft, viewportWidth, index) => controlsLeft + ((viewportWidth - controlsLeft) / 3) * (index + 0.5);
const windowButtons = (controlsLeft, viewportWidth) => [0, 1, 2].map((i) => [buttonCenter(controlsLeft, viewportWidth, i), 20]);

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

let app = null;

(async () => {
  if (process.platform !== 'win32') {
    console.log('无边框窗口只在 Windows 启用,本平台无需验证');
    return;
  }
  fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({ mode: 'local', autoStart: false, startupView: '' }));
  app = spawn(EXE, ['.', `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore' });

  let page = null;
  for (let i = 0; i < 80 && !page; i++) {
    try {
      page = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page' && /index\.html/.test(t.url)) || null;
    } catch {}
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('等不到调试页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('CDP 连接失败'))); });
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) p.reject(new Error(d.error.message));
      else p.resolve(d.result);
    } else if (d.method === 'Runtime.exceptionThrown') {
      pageErrors.push(d.params.exceptionDetails && d.params.exceptionDetails.text);
    }
  });
  const send = (method, params = {}) => {
    id += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  await send('Runtime.enable');
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`evaluate 异常:${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result && r.result.value;
  };

  // 窗口句柄(主进程的主窗口;show:false 起步,要等它显示出来)
  let hwnd = '0';
  for (let i = 0; i < 40 && hwnd === '0'; i++) {
    try { hwnd = ps(['-Command', `(Get-Process -Id ${app.pid}).MainWindowHandle.ToInt64()`]).trim(); } catch {}
    if (hwnd === '0') await sleep(500);
  }
  if (hwnd === '0') throw new Error('拿不到主窗口句柄');
  for (let i = 0; i < 40; i++) {
    if (await ev('!!state.cfg && !!document.querySelector(".topbar")')) break;
    await sleep(500);
  }
  await sleep(1200);
  if (SHOTS) console.log('截图目录:', SHOTS);

  const rectSrc = `const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; };`;
  const csSrc = `const cs = (el, p) => getComputedStyle(el).getPropertyValue(p);`;
  // DOMRect 的属性在原型上,要逐个取出才能序列化
  const areaSrc = `const a = navigator.windowControlsOverlay.getTitlebarAreaRect(); const area = { x: a.x, y: a.y, width: a.width, height: a.height };`;
  // 窗口按钮区(titlebar 区域的右缘)与顶栏高度:40 = main.js 的 titleBarOverlay.height = style.css 的 --topbar-h
  const controlsLeftOf = (x) => x.area.x + x.area.width;
  const TOPBAR_H = 40;
  const consoleFacts = () => ev(`(() => { ${rectSrc} ${csSrc} ${areaSrc}
    return {
      area, innerWidth, innerHeight,
      wcoVisible: navigator.windowControlsOverlay.visible, search: location.search,
      hasClass: document.body.classList.contains('wco'),
      topbar: rect(document.querySelector('.topbar')),
      topbarRegion: cs(document.querySelector('.topbar'), '-webkit-app-region'),
      brand: rect(document.querySelector('.brand')),
      chip: rect(document.getElementById('serverChip')),
      scopeLeft: document.querySelector('.scope-bar').getBoundingClientRect().left + parseFloat(cs(document.querySelector('.scope-bar'), 'padding-left')),
      scopeTop: document.querySelector('.scope-bar').getBoundingClientRect().top,
    }; })()`);
  const checkConsole = (f, tag) => {
    expect(`${tag}body 带 .wco(应用自己打的,未经脚本干预)`, f.hasClass, true);
    expect(`${tag}顶栏是可拖拽区`, f.topbarRegion, 'drag');
    expect(`${tag}顶栏高度 = 窗口按钮高度`, f.topbar.h, TOPBAR_H);
    near(`${tag}窗口按钮高度与顶栏一致`, f.area.height, TOPBAR_H);
    near(`${tag}状态芯片与窗口按钮的间距(页面带滚动条)`, controlsLeftOf(f) - f.chip.r, 24);
    near(`${tag}品牌居最左(与目标条左缘对齐)`, f.brand.x, f.scopeLeft);
    near(`${tag}目标条吸顶位置紧跟顶栏`, f.scopeTop, TOPBAR_H);
  };

  /* ---------- 1) 控制台视图(默认 1180 宽) ---------- */
  console.log('\n—— 控制台视图(1180 宽)——');
  const f = await consoleFacts();
  const controlsLeft = controlsLeftOf(f);
  console.log('  基础:', JSON.stringify({ search: f.search, wcoVisible: f.wcoVisible, hasClass: f.hasClass, area: f.area, inner: [f.innerWidth, f.innerHeight] }));
  expect('地址带着主进程的无边框标记', f.search, '?wco=1');
  expect('系统的窗口控制叠加确实可见', f.wcoVisible, true);
  checkConsole(f, '');
  const first = runProbe(hwnd, { points: [[300, 20], [600, 420], ...windowButtons(controlsLeft, f.innerWidth)], shot: SHOTS ? path.join(SHOTS, 'console.png') : '' });
  const h1 = first.hits;
  expect('顶栏空白处 = 标题栏(可拖拽)', h1[0], 2);
  expect('页面内容区 = 页面', h1[1], 1);
  expect('最小化按钮', h1[2], 8);
  expect('最大化按钮', h1[3], 9);
  expect('关闭按钮', h1[4], 20);

  // .wco 开关确实切换两套布局(其它平台没有叠加,沿用原顶栏)
  const noWco = await ev(`(() => { document.body.classList.remove('wco'); const h = document.querySelector('.topbar').offsetHeight; document.body.classList.add('wco'); return h; })()`);
  console.log(`  (信息)去掉 .wco 后顶栏高度回到 ${noWco}px`);
  expect('.wco 开关确实切换顶栏高度', noWco !== f.topbar.h, true);

  /* ---------- 2) 最窄窗口(920):内容最容易钻到按钮底下 ---------- */
  console.log('\n—— 最窄窗口(920 宽)——');
  // 外框 = 页面视口 + 系统边框;按差值把视口收到应用允许的最小宽度
  const outer0 = first.rect;
  const extraW = outer0.w / outer0.scale - f.innerWidth;
  const extraH = outer0.h / outer0.scale - f.innerHeight;
  setWindowSize(hwnd, 920 + extraW, 700 + extraH);
  await sleep(600);
  const n = await consoleFacts();
  console.log('  基础:', JSON.stringify({ inner: [n.innerWidth, n.innerHeight], area: n.area, chipRight: n.chip.r }));
  expect('窗口已变窄', n.innerWidth, 920);
  checkConsole(n, '窄窗口:');

  await ev("showWeb('about:blank')");
  await sleep(2000);
  const webFacts = () => ev(`(() => { ${rectSrc} ${csSrc} ${areaSrc}
    const bar = document.querySelector('.webview-bar');
    return {
      area, innerWidth,
      bar: rect(bar), barRegion: cs(bar, '-webkit-app-region'),
      url: rect(document.getElementById('webUrl')),
      lastBtn: rect(document.getElementById('openBrowserBtn2')),
      refresh: rect(document.getElementById('refreshBtn')),
      btnRegion: cs(document.getElementById('refreshBtn'), '-webkit-app-region'),
      wv: rect(document.getElementById('wv')),
    }; })()`);
  const checkWebBar = (w, tag) => {
    expect(`${tag}工具栏是可拖拽区`, w.barRegion, 'drag');
    expect(`${tag}工具栏高度 = 窗口按钮高度`, w.bar.h, TOPBAR_H);
    expect(`${tag}栏上按钮不参与拖拽`, w.btnRegion, 'no-drag');
    near(`${tag}最后一个按钮与窗口按钮的间距`, controlsLeftOf(w) - w.lastBtn.r, 12);
    near(`${tag}服务页内容紧接在工具栏下方`, w.wv.y, TOPBAR_H);
  };
  const wn = await webFacts();
  console.log('  基础:', JSON.stringify({ innerWidth: wn.innerWidth, lastBtnRight: wn.lastBtn.r, controlsLeft: controlsLeftOf(wn) }));
  checkWebBar(wn, '窄窗口:');
  expect('窄窗口:地址栏文字仍有显示空间', wn.url.w > 40, true);
  probe(hwnd, [[200, 20]], 'web-narrow');

  setWindowSize(hwnd, outer0.w / outer0.scale, outer0.h / outer0.scale);
  await sleep(600);
  await ev('showConsole()');
  await sleep(500);

  /* ---------- 3) 服务页视图(紧凑工具栏) ---------- */
  console.log('\n—— 服务页视图 ——');
  await ev("showWeb('about:blank')");
  await sleep(2000);
  const w = await webFacts();
  const wLeft = controlsLeftOf(w);
  checkWebBar(w, '');
  const h2 = probe(hwnd, [
    [w.url.x + w.url.w / 2, w.url.y + w.url.h / 2],
    [w.refresh.x + w.refresh.w / 2, w.refresh.y + w.refresh.h / 2],
    [buttonCenter(wLeft, w.innerWidth, 2), 20],
    [600, 300],
  ], 'web');
  expect('工具栏空白处 = 标题栏(可拖拽)', h2[0], 2);
  expect('工具栏按钮可点击(不是拖拽区)', h2[1], 1);
  expect('关闭按钮(服务页视图下仍在)', h2[2], 20);
  expect('服务页内容区 = 页面', h2[3], 1);

  /* ---------- 4) 终端视图(紧凑工具栏) ---------- */
  console.log('\n—— 终端视图 ——');
  await ev('showTerm()');
  await sleep(1500);
  const t = await ev(`(() => { ${rectSrc} ${csSrc} ${areaSrc}
    const bar = document.querySelector('.term-bar');
    return {
      area, innerWidth,
      bar: rect(bar), barRegion: cs(bar, '-webkit-app-region'),
      spacer: rect(document.querySelector('#termView .term-bar-flex')),
      lastBtn: rect(document.getElementById('termReconnectBtn')),
      btnRegion: cs(document.getElementById('termReconnectBtn'), '-webkit-app-region'),
      mount: rect(document.getElementById('termMount')),
    }; })()`);
  const tLeft = controlsLeftOf(t);
  expect('工具栏是可拖拽区', t.barRegion, 'drag');
  // 终端栏里的「Pi Web」是图标在上、文字在下的高按钮(既有设计),栏比窗口按钮高;只要求不矮于它
  expect('工具栏不矮于窗口按钮(按钮不会压到终端内容)', t.bar.h >= TOPBAR_H, true);
  expect('栏上按钮不参与拖拽', t.btnRegion, 'no-drag');
  near('最后一个按钮与窗口按钮的间距', tLeft - t.lastBtn.r, 12);
  near('终端内容紧接在工具栏下方', t.mount.y, t.bar.h);
  const h3 = probe(hwnd, [
    [t.spacer.x + t.spacer.w / 2, t.spacer.y + t.spacer.h / 2],
    [t.lastBtn.x + t.lastBtn.w / 2, t.lastBtn.y + t.lastBtn.h / 2],
    [buttonCenter(tLeft, t.innerWidth, 2), 20],
    [600, 400],
  ], 'term');
  expect('工具栏空白处 = 标题栏(可拖拽)', h3[0], 2);
  expect('重连按钮可点击(不是拖拽区)', h3[1], 1);
  expect('关闭按钮(终端视图下仍在)', h3[2], 20);
  expect('终端内容区 = 页面', h3[3], 1);

  /* ---------- 5) 弹窗打开时 ---------- */
  console.log('\n—— 弹窗打开时 ——');
  await ev('showConsole(); openServersModal();');
  await sleep(1000);
  const m = await ev(`(() => { ${rectSrc} ${areaSrc}
    return { area, innerWidth, card: rect(document.querySelector('#remoteModal .modal-card')), open: !document.getElementById('remoteModal').hidden }; })()`);
  const mLeft = controlsLeftOf(m);
  expect('远程服务器弹窗已打开', m.open, true);
  // 左侧:卡片宽 640 居中,盖不到这条带。右侧:拖拽带的右端应紧贴窗口按钮(再往左 6px 仍是标题栏)
  const h4 = probe(hwnd, [[20, 20], [mLeft - 6, 20], [m.card.x + m.card.w / 2, m.card.y + m.card.h / 2], [buttonCenter(mLeft, m.innerWidth, 2), 20]], 'modal');
  expect('弹窗顶部空白带 = 标题栏(仍可拖拽)', h4[0], 2);
  expect('拖拽带右端紧贴窗口按钮(按钮左侧 6px 仍是标题栏)', h4[1], 2);
  expect('弹窗卡片本身 = 页面', h4[2], 1);
  expect('关闭按钮(弹窗之上仍可点)', h4[3], 20);
  await ev('closeServersModal()');

  expect('页面无未捕获异常', pageErrors.length, 0);
  console.log(failures.length ? `\n${failures.length} 项失败` : '\n无边框窗口: 全部通过');
  process.exitCode = failures.length ? 1 : 0;
})().catch((e) => {
  console.error('RUNTIME ERR:', e.stack || e.message);
  process.exitCode = 1;
}).finally(async () => {
  // 只结束这次测试启动的实例(按 PID);不按进程名结束,否则会波及用户自己开着的程序
  if (app && app.pid) {
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await sleep(800);
  }
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch {}
  if (SHOTS) console.log(`截图保留在:${SHOTS}(看完可删除)`);
});
