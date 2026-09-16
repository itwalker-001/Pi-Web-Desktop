'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  cfg: null,
  env: null,
  update: { installed: null, latest: null, outdated: false },
  server: { running: false, owned: true, external: false, url: '' },
  updating: false,
  detecting: false,
};

let externalPollTimer = null;

/* ---------------- 通用 ---------------- */

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 320);
  }, 3600);
}

function setDot(id, status) {
  const dot = $(id);
  dot.className = 'dot';
  if (status === 'ok') dot.classList.add('dot-ok');
  else if (status === 'bad') dot.classList.add('dot-bad');
  else if (status === 'warn') dot.classList.add('dot-warn');
}

/* ---------------- 环境检测 ---------------- */

async function detectEnv({ silent = false } = {}) {
  if (state.detecting) return;
  state.detecting = true;
  $('redetectBtn').disabled = true;
  for (const id of ['env-node', 'env-npm', 'env-pi', 'env-piweb']) $(id).textContent = '检测中…';

  const res = await window.piApi.detectEnv();
  if (res.ok) {
    state.env = res.env;
    renderEnv(res.env, res.appVersion);
  } else {
    toast(`环境检测失败:${res.error}`, 'err');
  }
  state.detecting = false;
  $('redetectBtn').disabled = false;
  if (!silent && !res.ok) return;
}

function renderEnv(env, appVersion) {
  const rows = [
    ['node', env.node, 'env-node'],
    ['npm', env.npm, 'env-npm'],
    ['pi', env.pi, 'env-pi'],
    ['piweb', env.piWeb, 'env-piweb'],
  ];
  for (const [, item, textId] of rows) {
    setDot(`dot-${textId.replace('env-', '')}`, item.ok ? 'ok' : 'bad');
    $(textId).textContent = item.ok ? `v${item.version}` : '未检测到';
  }
  $('env-pi').title = env.pi.ok ? '' : env.pi.error || '';
  $('env-piweb-extra').textContent = env.piWeb.ok ? '全局包' : '未安装:npm install -g @agegr/pi-web';
  $('env-app').textContent = `v${appVersion || '—'}`;
}

/* ---------------- 版本检测 / 更新 ---------------- */

function renderUpdate() {
  const { installed, latest, outdated } = state.update;
  $('verInstalled').textContent = installed ? `v${installed}` : '未安装';
  $('verLatest').textContent = latest ? `v${latest}` : '—';

  const badge = $('updateBadge');
  badge.className = 'badge';
  if (outdated) {
    badge.classList.add('badge-outdated');
    badge.textContent = `可更新 → v${latest}`;
    $('env-piweb-extra').textContent = `全局包 · 可更新到 v${latest}`;
    setDot('dot-piweb', 'warn');
  } else if (installed && latest) {
    badge.classList.add('badge-latest');
    badge.textContent = '已是最新';
  } else if (!installed) {
    badge.classList.add('badge-error');
    badge.textContent = '未安装';
  }

  const updateBtn = $('updateBtn');
  updateBtn.disabled = false;
  updateBtn.textContent = installed ? '一键更新' : '一键安装';
}

// pi CLI 版本区块(环境检测卡片内)
function renderPiUpdate(pi) {
  const badge = $('piBadge');
  const nameEl = $('piPkgName');
  if (!pi || !pi.resolved) {
    nameEl.textContent = pi && pi.pkg ? `(${pi.pkg})` : '';
    $('piVerInstalled').textContent = '未检测到';
    $('piVerLatest').textContent = '—';
    badge.className = 'badge badge-error';
    badge.textContent = '未安装';
    $('piUpdateBtn').disabled = true;
    $('piCheckBtn').disabled = true;
    return;
  }

  nameEl.textContent = `(${pi.pkg})`;
  const installed = pi.installed;
  $('piVerInstalled').textContent = installed ? `v${installed}` : '未安装';
  $('piVerLatest').textContent = pi.latest ? `v${pi.latest}` : '—';

  const btn = $('piUpdateBtn');
  btn.disabled = false;
  btn.textContent = installed ? '一键更新' : '一键安装';
  $('piCheckBtn').disabled = false;

  badge.className = 'badge';
  badge.title = pi.latestError || '';
  if (!installed) {
    badge.classList.add('badge-error');
    badge.textContent = '未安装';
  } else if (pi.outdated) {
    badge.classList.add('badge-outdated');
    badge.textContent = `可更新 → v${pi.latest}`;
  } else if (pi.latest) {
    badge.classList.add('badge-latest');
    badge.textContent = '已是最新';
  } else {
    badge.classList.add('badge-error');
    badge.textContent = '检测失败';
  }
}

async function checkUpdate({ silent = false } = {}) {
  const badge = $('updateBadge');
  badge.className = 'badge badge-idle';
  badge.textContent = '检测中…';
  const piBadge = $('piBadge');
  piBadge.className = 'badge badge-idle';
  piBadge.textContent = '检测中…';

  const res = await window.piApi.checkUpdate();
  state.update = { installed: res.installed, latest: res.latest, outdated: !!res.outdated };
  renderUpdate();
  renderPiUpdate(res.pi);
  if (res.env) renderEnv(res.env);

  if (!res.ok) {
    badge.className = 'badge badge-error';
    badge.textContent = '检测失败';
    badge.title = res.error || '';
    if (!silent) toast(`检查更新失败:${res.error || '未知错误'}`, 'err');
  }
  return res;
}

async function runUpdate(target = 'pi-web') {
  if (state.updating) return;
  state.updating = true;
  const isPi = target === 'pi';
  const btn = isPi ? $('piUpdateBtn') : $('updateBtn');
  const installing = btn.textContent === '一键安装';
  btn.disabled = true;
  btn.textContent = installing ? '安装中…' : '更新中…';
  const log = isPi ? $('piUpdateLog') : $('updateLog');
  log.hidden = false;
  log.textContent = '';

  const res = await window.piApi.runUpdate(target);

  state.updating = false;
  btn.disabled = false;
  btn.textContent = installing ? '一键安装' : '一键更新';

  if (res.ok) {
    log.textContent += `\n✅ 完成,当前版本 v${res.version}\n`;
    toast(`${isPi ? 'pi' : 'pi-web'} ${installing ? '已安装' : '已更新'} → v${res.version}`, 'ok');
    await Promise.all([detectEnv({ silent: true }), checkUpdate({ silent: true })]);
  } else {
    log.textContent += `\n❌ ${installing ? '安装' : '更新'}失败:${res.error}\n`;
    toast(`${installing ? '安装' : '更新'}失败:${(res.error || '').split('\n')[0]}`, 'err');
    await checkUpdate({ silent: true });
  }
  log.scrollTop = log.scrollHeight;
}

/* ---------------- pi-web 服务 ---------------- */

function renderServer() {
  const running = state.server.running;
  const external = state.server.external;
  $('startBtn').disabled = false;
  $('startBtn').textContent = running ? '打开服务页' : '启动服务';
  $('stopBtn').disabled = !running;
  $('openBrowserBtn').disabled = !running;
  $('serverState').textContent = running
    ? `运行中${external ? '(外部启动)' : ''} · ${state.server.url}`
    : '已停止';

  const chip = $('serverChip');
  chip.className = `chip ${running ? 'chip-running' : 'chip-stopped'}`;
  $('serverChipText').textContent = running
    ? `服务运行中${external ? '(外部)' : ''}`
    : '服务已停止';

  setServerPolling();
}

// 外部启动的实例没有退出事件,靠轮询感知它消失
function setServerPolling() {
  clearInterval(externalPollTimer);
  externalPollTimer = null;
  if (!(state.server.running && state.server.external)) return;
  externalPollTimer = setInterval(async () => {
    try {
      await fetch(state.server.url, { mode: 'no-cors', cache: 'no-store' });
    } catch {
      clearInterval(externalPollTimer);
      externalPollTimer = null;
      state.server = { running: false, owned: true, external: false, url: '' };
      renderServer();
      showConsole();
      toast('外部 pi-web 服务已停止', 'err');
    }
  }, 5000);
}

async function startServer() {
  if (!state.server.running && (!state.env || !state.env.piWeb.ok)) {
    toast('未检测到 pi-web,请先安装或更新', 'err');
    return;
  }
  // 已在运行(含外部实例):直接切到服务页
  if (state.server.running) {
    showWeb(state.server.url);
    return;
  }
  $('startBtn').disabled = true;
  $('startBtn').textContent = '启动中…';

  const res = await window.piApi.serverStart();

  $('startBtn').textContent = '启动服务';
  if (res.ok) {
    state.server = { running: true, owned: !res.external, external: !!res.external, url: res.url };
    renderServer();
    if (res.external) toast('检测到端口已占用,已连接到正在运行的 pi-web');
    showWeb(res.url);
  } else {
    $('startBtn').disabled = false;
    toast(`启动失败:${res.error}`, 'err');
    $('serverLogWrap').open = true;
  }
}

async function stopServer() {
  const res = await window.piApi.serverStop();
  if (res.external) {
    toast('该 pi-web 由外部启动,本应用无法停止;请先在原处停止它', 'err');
    return;
  }
  state.server = { running: false, owned: true, external: false, url: '' };
  renderServer();
  showConsole();
}

function showWeb(url) {
  document.body.classList.add('in-web');
  $('consoleView').hidden = true;
  $('webView').hidden = false;
  $('webUrl').textContent = url;
  const wv = $('wv');
  // webview 的 preload 相对路径按宿主 HTML 目录解析,这里换成绝对路径确保加载
  if (!wv.getAttribute('preload-abs')) {
    const u = new URL('../webview-preload.js', window.location.href);
    const p = decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1');
    wv.setAttribute('preload', p);
    wv.setAttribute('preload-abs', '1');
  }
  const current = wv.getAttribute('src');
  if (!current || current === 'about:blank') wv.setAttribute('src', url);
  else if (current !== url) wv.setAttribute('src', url);
  else wv.reload();
}

function showConsole() {
  document.body.classList.remove('in-web');
  $('webView').hidden = true;
  $('consoleView').hidden = false;
}

/* ---------------- 配置 ---------------- */

function fillConfigForm(cfg) {
  $('portInput').value = cfg.port;
  $('autoStartChk').checked = !!cfg.autoStart;
  $('proxyEnabledChk').checked = !!cfg.proxy.enabled;
  $('proxyUrlInput').value = cfg.proxy.url || '';
  $('registryInput').value = cfg.registry || '';
}

// 代理路径:展示各类流量的实际走向(走代理 / 直连)
function renderProxyPath() {
  const cfg = state.cfg;
  const el = $('proxyPath');
  if (!cfg || !el) return;

  const proxyOn = !!(cfg.proxy && cfg.proxy.enabled && cfg.proxy.url);
  const arrow = '<span class="pp-arrow">──→</span>';

  const npmChain = proxyOn
    ? `npm ${arrow} 代理 <span class="pp-proxy">${cfg.proxy.url}</span> ${arrow} ${cfg.registry || '系统 npm 配置的 registry'}`
    : `npm ${arrow} <span class="pp-direct">直连</span><span class="muted">(按 npm 自身配置,未启用应用代理)</span>`;
  const pageChain = proxyOn
    ? `页面请求 ${arrow} 代理 <span class="pp-proxy">${cfg.proxy.url}</span> ${arrow} 目标站点`
    : `页面请求 ${arrow} <span class="pp-direct">直连</span> ${arrow} 系统代理设置`;
  const localChain = `pi-web 进程 ${arrow} <span class="pp-direct">127.0.0.1:${cfg.port} 直连</span><span class="muted">(始终不走代理)</span>`;

  el.innerHTML = `
    <div class="pp-title">代理路径(当前生效)</div>
    <div class="pp-row"><span class="pp-name">版本检测 / 一键更新</span><span class="pp-chain mono">${npmChain}</span></div>
    <div class="pp-row"><span class="pp-name">内嵌服务页</span><span class="pp-chain mono">${pageChain}</span></div>
    <div class="pp-row"><span class="pp-name">pi-web 本地服务</span><span class="pp-chain mono">${localChain}</span></div>
  `;
}

async function saveConfig() {
  const port = parseInt($('portInput').value, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    toast('端口需在 1024 - 65535 之间', 'err');
    return;
  }
  const proxyEnabled = $('proxyEnabledChk').checked;
  const proxyUrl = $('proxyUrlInput').value.trim();
  if (proxyEnabled && !proxyUrl) {
    toast('已启用代理,请填写代理地址', 'err');
    return;
  }
  if (proxyUrl && !/^(https?|socks4a?|socks5h?):\/\//i.test(proxyUrl)) {
    toast('代理地址需以 http://、https:// 或 socks5:// 开头', 'err');
    return;
  }

  const prev = state.cfg;
  const cfg = await window.piApi.setConfig({
    port,
    autoStart: $('autoStartChk').checked,
    proxy: { enabled: proxyEnabled, url: proxyUrl },
    registry: $('registryInput').value.trim(),
  });
  state.cfg = cfg;
  renderProxyPath();
  toast('设置已保存', 'ok');

  // 端口变化且服务运行中 → 自动重启服务
  if (state.server.running && state.server.owned && prev && prev.port !== port) {
    toast('端口已变更,正在重启服务…');
    await window.piApi.serverStop();
    const res = await window.piApi.serverStart();
    if (res.ok) {
      state.server = { running: true, owned: !res.external, external: !!res.external, url: res.url };
      showWeb(res.url);
    } else {
      state.server = { running: false, owned: true, external: false, url: '' };
      showConsole();
      toast(`服务重启失败:${res.error}`, 'err');
    }
    renderServer();
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('redetectBtn').addEventListener('click', () => detectEnv());
  $('checkBtn').addEventListener('click', () => checkUpdate());
  $('updateBtn').addEventListener('click', () => runUpdate('pi-web'));
  $('piCheckBtn').addEventListener('click', () => checkUpdate());
  $('piUpdateBtn').addEventListener('click', () => runUpdate('pi'));

  $('startBtn').addEventListener('click', startServer);
  $('stopBtn').addEventListener('click', stopServer);
  $('openBrowserBtn').addEventListener('click', () => state.server.url && window.piApi.openExternal(state.server.url));
  $('openBrowserBtn2').addEventListener('click', () => state.server.url && window.piApi.openExternal(state.server.url));
  $('refreshBtn').addEventListener('click', () => {
    const wv = $('wv');
    if (wv.getAttribute('src') !== 'about:blank') wv.reload();
  });
  $('newPageBtn').addEventListener('click', () => {
    const wv = $('wv');
    const url = (wv && wv.getAttribute('src')) || state.server.url;
    if (url && url !== 'about:blank') window.piApi.openPage(url);
  });
  $('backBtn').addEventListener('click', showConsole);
  $('saveConfigBtn').addEventListener('click', saveConfig);


  window.piApi.onUpdateLog((payload) => {
    // payload = { target: 'pi-web' | 'pi', line }
    const log = payload && payload.target === 'pi' ? $('piUpdateLog') : $('updateLog');
    log.hidden = false;
    log.textContent += payload.line ?? payload;
    log.scrollTop = log.scrollHeight;
  });

  window.piApi.onServerLog((line) => {
    const log = $('serverLog');
    log.textContent += line;
    if (log.textContent.length > 60000) log.textContent = log.textContent.slice(-40000);
    log.scrollTop = log.scrollHeight;
  });

  window.piApi.onServerExited((info) => {
    state.server = { running: false, owned: true, external: false, url: '' };
    renderServer();
    showConsole();
    if (!info.intentional) {
      toast(`pi-web 服务已退出(code: ${info.code ?? '?'})`, 'err');
      $('serverLogWrap').open = true;
    }
  });

  window.piApi.onServerStarted((info) => {
    state.server = { running: true, owned: true, external: false, url: info.url };
    renderServer();
    toast(`pi-web 已重新启动(更新后自动恢复)`, 'ok');
  });

  // 在 webview 中粘贴/拖入文件 → 已把路径插入聊天输入框
  window.piApi.onPasteResult((info) => {
    if (info.ok) toast(`已插入 ${info.count} 个文件路径到输入框`, 'ok');
    else toast('未找到聊天输入框,请先点击它再粘贴文件', 'err');
  });

  const wv = $('wv');
  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return; // 用户取消/中断
    toast(`页面加载失败:${e.errorDescription || e.errorCode}`, 'err');
  });
}

/* ---------------- 启动 ---------------- */

async function init() {
  bindEvents();

  const cfg = await window.piApi.getConfig();
  state.cfg = cfg;
  fillConfigForm(cfg);
  renderProxyPath();

  await detectEnv({ silent: true });
  await checkUpdate({ silent: true });

  const stateRes = await window.piApi.serverState();
  if (stateRes.running) {
    state.server = stateRes;
    renderServer();
  }

  if (cfg.autoStart && state.env && state.env.piWeb.ok && !state.server.running) {
    await startServer();
  } else {
    renderServer();
  }
}

init();
