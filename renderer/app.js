'use strict';

const $ = (id) => document.getElementById(id);

// 本地与多台远程服务可同时运行:远程按档案(id)各自维护状态与日志,
// state.mode 决定本地/远程,state.activeRemoteId 决定当前操作的远程档案
const defaultServer = () => ({ running: false, owned: true, external: false, url: '' });

const state = {
  cfg: null,
  mode: 'local',
  activeRemoteId: '',
  remotes: [],
  env: null,
  update: { installed: null, latest: null, outdated: false },
  piUpdate: null, // checkUpdate 返回的 pi 包信息
  servers: { local: defaultServer(), remotes: {} },
  logs: { local: '', remotes: {} },
  updating: false,
  detecting: false,
  updateLog: '',
};

function activeRemote() {
  return state.remotes.find((r) => r.id === state.activeRemoteId) || null;
}

function curServer() {
  if (state.mode === 'local') return state.servers.local;
  return state.servers.remotes[state.activeRemoteId] || defaultServer();
}

function setServer(patch) {
  if (state.mode === 'local') {
    state.servers.local = { ...defaultServer(), ...patch };
  } else {
    state.servers.remotes[state.activeRemoteId] = { ...defaultServer(), ...patch };
  }
}

function otherRunningCount() {
  if (state.mode === 'local') {
    return Object.values(state.servers.remotes).filter((s) => s && s.running).length;
  }
  const n = state.servers.local.running ? 1 : 0;
  for (const [id, s] of Object.entries(state.servers.remotes)) {
    if (s && s.running && id !== state.activeRemoteId) n += 1;
  }
  return n;
}

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
    state.env = null;
    for (const id of ['env-node', 'env-npm', 'env-pi', 'env-piweb']) {
      $(id).textContent = '—';
      setDot(`dot-${id.replace('env-', '')}`, 'bad');
    }
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
  $('env-piweb-extra').textContent = env.piWeb.ok ? '全局包' : '未安装';
  $('env-piweb-extra').title = env.piWeb.ok ? '' : '未安装,可点击「一键安装」';
  $('appVersion').textContent = appVersion ? `v${appVersion}` : '—';
}

/* ---------------- 版本检测 / 更新(内联在 pi / pi-web 行) ---------------- */

function renderUpdate() {
  const { installed, latest, outdated } = state.update;
  const pi = state.piUpdate;

  // pi-web 行:有更新或未安装才显示更新图标
  setDot('dot-piweb', outdated ? 'warn' : installed ? 'ok' : 'bad');
  const piwebCell = $('env-piweb');
  piwebCell.textContent = !installed ? '未安装' : outdated && latest ? `v${installed} → v${latest}` : `v${installed}`;
  piwebCell.title = !installed ? '未安装,点击右侧图标执行 npm install -g @agegr/pi-web' : '';
  const piwebExtra = $('env-piweb-extra');
  piwebExtra.textContent = !installed ? '未安装' : outdated ? '全局包 · 可更新' : '全局包';
  const ub = $('updateBtn');
  ub.hidden = !(outdated || !installed);
  ub.disabled = false;
  ub.title = !installed ? '一键安装' : outdated ? `一键更新 → v${latest}` : '';

  // pi 行:同规则
  const hasPi = !!(pi && pi.resolved);
  const piOutdated = hasPi && pi.outdated;
  setDot('dot-pi', !hasPi || !pi.installed ? 'bad' : piOutdated ? 'warn' : 'ok');
  const piCell = $('env-pi');
  piCell.textContent = hasPi
    ? (!pi.installed ? '未安装' : piOutdated && pi.latest ? `v${pi.installed} → v${pi.latest}` : `v${pi.installed}`)
    : '未检测到';
  piCell.title = hasPi && pi.latestError ? `最新版查询失败:${pi.latestError}` : '';
  const pb = $('piUpdateBtn');
  pb.hidden = !hasPi || !(!pi.installed || piOutdated);
  pb.disabled = !hasPi;
  pb.title = hasPi ? (!pi.installed ? '一键安装' : piOutdated ? `一键更新 → v${pi.latest}` : '') : '未检测到 pi';
}

async function checkUpdate({ silent = false } = {}) {
  const res = await window.piApi.checkUpdate();
  state.update = { installed: res.installed, latest: res.latest, outdated: !!res.outdated };
  state.piUpdate = res.pi || null;
  if (res.env) renderEnv(res.env, res.appVersion);
  renderUpdate();
  if (!res.ok) {
    if (!silent) toast(`检查更新失败:${res.error || '未知错误'}`, 'err');
  }
  return res;
}

async function runUpdate(target = 'pi-web') {
  if (state.updating) return;
  state.updating = true;
  const isPi = target === 'pi';
  const btn = isPi ? $('piUpdateBtn') : $('updateBtn');
  const installing = isPi
    ? !(state.piUpdate && state.piUpdate.installed)
    : !state.update.installed;
  btn.disabled = true;
  btn.classList.add('spinning');
  btn.title = installing ? '安装中…' : '更新中…';
  const tag = isPi ? '[pi] ' : '[pi-web] ';
  appendLog('update', `\n${tag}—— 开始${installing ? '安装' : '更新'} ——\n`);

  const res = await window.piApi.runUpdate(target);

  state.updating = false;
  btn.classList.remove('spinning');
  btn.disabled = isPi ? !(state.piUpdate && state.piUpdate.resolved) : false;

  if (res.ok) {
    appendLog('update', `${tag}✅ 完成,当前版本 v${res.version}\n`);
    toast(`${isPi ? 'pi' : 'pi-web'} ${installing ? '已安装' : '已更新'} → v${res.version}`, 'ok');
    await Promise.all([detectEnv({ silent: true }), checkUpdate({ silent: true })]);
  } else {
    appendLog('update', `${tag}❌ ${installing ? '安装' : '更新'}失败:${res.error}\n`);
    toast(`${installing ? '安装' : '更新'}失败:${(res.error || '').split('\n')[0]}`, 'err');
    await checkUpdate({ silent: true });
  }
}

/* ---------------- 服务地址(本地/远程统一为一个 URL) ---------------- */

// 当前 Tab 服务对应的 URL:本地 http://127.0.0.1:端口 / 远程 http://主机:端口。
// 环境检测、版本更新、启停、内嵌页、新窗口,最终都落到这个地址上。
/* ---------------- 日志弹窗(服务日志 / 更新日志) ---------------- */

// 日志来源键:'server:local' | 'server:<remoteId>' | 'update'
function serverSourceKey() {
  return state.mode === 'local' ? 'server:local' : `server:${state.activeRemoteId}`;
}

function getLogText(source) {
  if (source === 'update') return state.updateLog || '';
  if (source === 'server:local') return state.logs.local || '';
  return state.logs.remotes[source.slice(7)] || '';
}

let logModalSource = null;

function openLogModal(source) {
  logModalSource = source;
  const r = source.startsWith('server:')
    ? state.remotes.find((x) => x.id === source.slice(7))
    : null;
  $('logModalTitle').textContent = source === 'update'
    ? '更新日志'
    : `服务日志 · ${source === 'server:local' ? '本机' : `${(r && r.user) || ''}${r && r.host ? '@' : ''}${(r && r.host) || '未配置'}`}`;
  const el = $('logModalContent');
  el.textContent = getLogText(source);
  el.scrollTop = el.scrollHeight;
  $('logModal')._piPrevFocus = document.activeElement;
  $('logModal').hidden = false;
  $('logCloseBtn').focus();
}

function closeLogModal() {
  $('logModal').hidden = true;
  logModalSource = null;
  const prev = $('logModal')._piPrevFocus;
  if (prev && prev.focus) prev.focus();
}

// 追加日志:落盘到 state,弹窗开着且正在看该来源时实时刷新
function appendLog(source, text) {
  if (source === 'update') {
    state.updateLog = (state.updateLog || '') + text;
    if (state.updateLog.length > 80000) state.updateLog = state.updateLog.slice(-60000);
  }
  if (logModalSource === source) {
    const el = $('logModalContent');
    el.textContent = getLogText(source);
    el.scrollTop = el.scrollHeight;
  }
}

/* ---------------- 系统服务 Tab(本机 / 各远程) ---------------- */

// 目标 id 是否为「应用启动默认」
function isDefaultTargetId(id) {
  const cfg = state.cfg || {};
  if (cfg.defaultMode === 'local') return id === 'local';
  if (cfg.defaultMode === 'remote') return cfg.defaultRemoteId === id;
  return false;
}

function currentTargetId() {
  return state.mode === 'local' ? 'local' : state.activeRemoteId;
}

function renderTabs() {
  const wrap = $('svcTabs');
  if (!wrap) return;
  const items = [{ id: 'local', label: '本机', running: !!(state.servers.local && state.servers.local.running) }];
  for (const r of state.remotes) {
    const st = state.servers.remotes[r.id];
    items.push({
      id: r.id,
      label: r.host ? (r.user ? `${r.user}@${r.host}` : r.host) : '(未配置)',
      running: !!(st && st.running),
    });
  }
  wrap.innerHTML =
    items
      .map((it) => {
        const active = it.id === currentTargetId();
        const isDef = isDefaultTargetId(it.id);
        const acts =
          it.id === 'local'
            ? ''
            : '<span class="tab-acts">' +
              `<span class="tab-act" role="button" tabindex="-1" aria-label="编辑 ${it.label}" data-act="edit" title="编辑">✎</span>` +
              `<span class="tab-act tab-del" role="button" tabindex="-1" aria-label="删除 ${it.label}" data-act="del" title="删除">✕</span>` +
              '</span>';
        return (
          `<button class="svc-tab${active ? ' active' : ''}${it.running ? ' running' : ''}" data-target="${it.id}" title="${it.label}">` +
          `<span class="svc-run"></span><span class="svc-label">${it.label}</span>` +
          acts +
          (isDef ? '<span class="svc-def">默认</span>' : '') +
          '</button>'
        );
      })
      .join('') + '<button class="svc-tab svc-add" data-target="__add" title="新增远程服务器">＋</button>';
}

// 应用启动模式:本地 / 远程,是否处于选中目标上
function isCurrentTarget(id) {
  return id === 'local' ? state.mode === 'local' : state.mode === 'remote' && state.activeRemoteId === id;
}

function renderMode() {
  const isRemote = state.mode === 'remote';
  $('localPortField').hidden = isRemote;
  $('remotePortField').hidden = !isRemote;
  const r = activeRemote();
  $('svcHost').value = isRemote ? (r && r.host) || '(未配置)' : '127.0.0.1';
  $('envScope').textContent = isRemote ? `· 远程 ${(r && r.host) || ''}` : '';
  $('serverScope').textContent = isRemote ? `· 远程 ${(r && r.host) || ''}` : '';
  renderTabs();
  renderDefaultBtn();
}

// 设为默认(星标)状态:当前 Tab 是否已是默认
function renderDefaultBtn() {
  const b = $('btnDefault');
  if (!b) return;
  const on = isDefaultTargetId(currentTargetId());
  b.classList.toggle('is-default', on);
  b.title = on ? '已是应用启动默认' : '设为应用启动默认';
}

// 设为应用启动默认
async function setDefaultTarget() {
  const patch =
    state.mode === 'local'
      ? { defaultMode: 'local', defaultRemoteId: '' }
      : { defaultMode: 'remote', defaultRemoteId: state.activeRemoteId };
  const cfg = await window.piApi.setConfig(patch);
  state.cfg = cfg;
  renderMode();
  toast('已设为应用启动默认', 'ok');
}

// 代理开关(顶层目标条 🛡):仅切换 enabled,配置本体在代理设置卡
function renderProxyToggle() {
  const b = $('proxyToggleBtn');
  if (!b) return;
  const p = (state.cfg && state.cfg.proxy) || {};
  const on = !!(p.enabled && p.primaryUrl);
  b.classList.toggle('on', on);
  const check = b.querySelector('.proxy-check');
  if (check) check.style.display = on ? 'block' : 'none';
  b.title = on
    ? `代理已启用:${p.primaryUrl} —— 点击关闭`
    : '代理未启用 —— 点击启用(需先在代理设置中填写服务器与端口)';
}

async function toggleProxy() {
  const p = (state.cfg && state.cfg.proxy) || {};
  const enabling = !(p.enabled && p.primaryUrl);
  if (enabling && (!p.host || !p.port)) {
    toast('请先在代理设置中填写代理服务器与端口', 'err');
    return;
  }
  const cfg = await window.piApi.setConfig({ proxy: { ...p, enabled: enabling } });
  state.cfg = cfg;
  renderProxyToggle();
  toast(enabling ? '代理已启用' : '代理已关闭', 'ok');
}

// 切换目标 Tab(本机 / 某台远程):不停任何服务,仅切换展示与操作对象
async function switchTarget(id, { force = false } = {}) {
  if (isCurrentTarget(id) && !force) return;
  if (state.updating) {
    toast('更新任务进行中,请稍后再切换', 'err');
    return;
  }
  const isLocal = id === 'local';
  const patch = isLocal ? { mode: 'local' } : { mode: 'remote', activeRemoteId: id };
  const cfg = await window.piApi.setConfig(patch);
  applyCfg(cfg);
  state.env = null;
  state.update = { installed: null, latest: null, outdated: false };
  state.piUpdate = null;
  showConsole();
  fillRemoteForm(activeRemote());
  renderMode();
  renderServer();
  // 日志弹窗开着时跟随切换到新目标的日志
  if (logModalSource && logModalSource.startsWith('server:')) openLogModal(serverSourceKey());

  const r = activeRemote();
  if (!isLocal && !(r && r.host && r.user)) {
    toast('请先在「管理服务器」中配置该服务器的主机与用户名', 'err');
    return;
  }

  await detectEnv({ silent: true });
  await checkUpdate({ silent: true });
  const stateRes = await window.piApi.serverState();
  if (isLocal) {
    state.servers.local = { ...defaultServer(), ...stateRes };
  } else {
    state.servers.remotes[state.activeRemoteId] = { ...defaultServer(), ...stateRes };
  }
  renderServer();
}

/* ---------------- pi-web 服务(启停/轮询) ---------------- */

function renderServer() {
  const srv = curServer();
  const running = srv.running;
  const external = srv.external;
  const modeLabel = state.mode === 'remote'
    ? (activeRemote() && activeRemote().host ? `远程 ${activeRemote().host}` : '远程')
    : '本机';
  // 图标按钮:启动▶/打开↗ 按运行态切换,tooltip 走原生 title
  const startBtn = $('startBtn');
  startBtn.disabled = false;
  startBtn.classList.toggle('running', running);
  startBtn.title = running ? '打开服务页' : '启动服务';
  $('stopBtn').disabled = !running;
  $('openBrowserBtn').disabled = !running;
  $('serverState').textContent = running
    ? `运行中${external ? '(外部启动)' : ''} · ${srv.url}`
    : '已停止';

  const chip = $('serverChip');
  chip.className = `chip ${running ? 'chip-running' : 'chip-stopped'}`;
  const others = otherRunningCount();
  $('serverChipText').textContent = running
    ? `${modeLabel}服务运行中${external ? '(外部)' : ''}${others ? ` · 另有 ${others} 个在运行` : ''}`
    : others
      ? `另有 ${others} 个服务运行中`
      : '服务已停止';

  renderMode(); // Tab 活动态/运行点/默认标记跟随
  setServerPolling();
}

// 外部启动的实例没有退出事件,靠轮询感知它消失
function setServerPolling() {
  clearInterval(externalPollTimer);
  externalPollTimer = null;
  const srv = curServer();
  if (!(srv.running && srv.external)) return;
  const mode = state.mode;
  const remoteId = state.activeRemoteId;
  let pollFails = 0;
  externalPollTimer = setInterval(async () => {
    try {
      await fetch(srv.url, { mode: 'no-cors', cache: 'no-store' });
      pollFails = 0;
    } catch {
      pollFails += 1;
      if (pollFails < 3) return; // 连续 3 次(≈15s)才判定消失,过滤瞬时抖动
      clearInterval(externalPollTimer);
      externalPollTimer = null;
      if (mode === 'local') state.servers.local = defaultServer();
      else state.servers.remotes[remoteId] = defaultServer();
      renderServer();
      showConsole();
      toast('外部 pi-web 服务已停止', 'err');
    }
  }, 5000);
}

async function startServer() {
  if (!curServer().running && (!state.env || !state.env.piWeb.ok)) {
    toast('未检测到 pi-web,请先安装或更新', 'err');
    return;
  }
  // 已在运行(含外部实例):先探活再进服务页(远程已无看门狗,按需检测代替)
  if (curServer().running) {
    const url = curServer().url;
    try {
      await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    } catch {
      setServer(defaultServer());
      renderServer();
      toast('服务已停止或不可达,请重新启动', 'err');
      return;
    }
    showWeb(url);
    return;
  }
  const startBtn = $('startBtn');
  startBtn.disabled = true;
  startBtn.title = '启动中…';

  const res = await window.piApi.serverStart();

  startBtn.disabled = false;
  if (res.ok) {
    setServer({ running: true, owned: !res.external, external: !!res.external, url: res.url });
    renderServer();
    if (res.external) toast('检测到端口已占用,已连接到正在运行的 pi-web');
    showWeb(res.url);
  } else {
    toast(`启动失败:${res.error}`, 'err');
    openLogModal(serverSourceKey());
    renderServer();
  }
}

async function stopServer() {
  const res = await window.piApi.serverStop();
  if (res.external) {
    toast('该 pi-web 由外部启动,本应用无法停止;请先在原处停止它', 'err');
    return;
  }
  setServer(defaultServer());
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

/* ---------------- 远程服务器管理(弹窗) ---------------- */

function renderRemoteSelect() {
  const sel = $('remoteSelect');
  sel.innerHTML = '';
  if (!state.remotes.length) {
    const o = document.createElement('option');
    o.textContent = '尚无远程服务器,点击「新增」创建';
    o.value = '';
    sel.appendChild(o);
    sel.disabled = true;
  } else {
    sel.disabled = false;
    for (const r of state.remotes) {
      const o = document.createElement('option');
      o.value = r.id;
      const st = state.servers.remotes[r.id];
      o.textContent = `${r.user || '?'}@${r.host || '(未配置)'}${st && st.running ? ' ●' : ''}`;
      sel.appendChild(o);
    }
    sel.value = state.activeRemoteId;
  }
  $('remoteDelBtn').disabled = !state.remotes.length;
  $('remoteTestBtn').disabled = !state.remotes.length;
}

function openServersModal() {
  $('remoteModal')._piPrevFocus = document.activeElement;
  $('remoteModal').hidden = false;
  renderRemoteSelect();
  fillRemoteForm(activeRemote());
  $('modalCloseBtn').focus();
}

function closeServersModal() {
  $('remoteModal').hidden = true;
  const prev = $('remoteModal')._piPrevFocus;
  if (prev && prev.focus) prev.focus();
}

function fillRemoteForm(r) {
  r = r || {};
  $('remoteHostInput').value = r.host || '';
  $('remoteSshPortInput').value = r.port || 22;
  $('remoteUserInput').value = r.user || '';
  $('remoteAuthSelect').value = r.authType === 'password' ? 'password' : 'key';
  $('remotePasswordInput').value = r.password || '';
  $('remoteKeyInput').value = r.keyPath || '';
  renderAuthFields();
  $('remoteSrvPortInput').value = r.remotePort || 30141;
}

// 按认证方式显隐:密码框 / 私钥路径框
function renderAuthFields() {
  const isPwd = $('remoteAuthSelect').value === 'password';
  $('remotePasswordField').hidden = !isPwd;
  $('remoteKeyField').hidden = isPwd;
}

function readRemoteForm() {
  return {
    host: $('remoteHostInput').value.trim(),
    port: parseInt($('remoteSshPortInput').value, 10) || 22,
    user: $('remoteUserInput').value.trim(),
    authType: $('remoteAuthSelect').value === 'password' ? 'password' : 'key',
    password: $('remotePasswordInput').value,
    keyPath: $('remoteKeyInput').value.trim(),
  };
}

// 远程表单校验;requireTarget = true 时必须有主机与用户名
function validateRemoteForm(remote, { requireTarget } = {}) {
  if (requireTarget && !remote.host) return '请填写远程主机地址';
  if (requireTarget && !remote.user) return '请填写远程用户名';
  if (remote.host && !(remote.port > 0 && remote.port < 65536)) return 'SSH 端口需在 1 - 65535 之间';
  if (remote.authType === 'password' && requireTarget && remote.host && !remote.password) {
    return '请填写 SSH 登录密码';
  }
  return null;
}

function genRemoteId() {
  return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 把当前弹窗表单内容合并进激活档案并保存整个档案列表(轻校验,允许不完整)
async function persistRemotes() {
  const form = readRemoteForm();
  const err = validateRemoteForm(form, { requireTarget: false });
  if (err) {
    toast(err, 'err');
    return null;
  }
  state.remotes = state.remotes.map((r) => (r.id === state.activeRemoteId ? { ...r, ...form } : r));
  const cfg = await window.piApi.setConfig({ remotes: state.remotes, activeRemoteId: state.activeRemoteId });
  state.cfg = cfg;
  state.remotes = cfg.remotes || [];
  return cfg;
}

function applyCfg(cfg) {
  state.cfg = cfg;
  state.mode = cfg.mode || 'local';
  state.remotes = cfg.remotes || [];
  state.activeRemoteId = cfg.activeRemoteId || '';
}

// 新增一台远程服务器档案并选中,打开弹窗填写
async function addRemote() {
  const id = genRemoteId();
  const profile = {
    id,
    host: '',
    port: 22,
    user: '',
    authType: 'key',
    password: '',
    keyPath: '',
    remotePort: 30141,
    hostFingerprint: '',
  };
  state.remotes = [...state.remotes, profile];
  state.activeRemoteId = id;
  const cfg = await window.piApi.setConfig({ remotes: state.remotes, activeRemoteId: id });
  applyCfg(cfg);
  fillRemoteForm(profile);
  renderMode();
  renderRemoteSelect();
  renderServer();
  openServersModal();
  $('remoteHostInput').focus();
  toast('已新增远程服务器,请填写主机与用户名');
}

// 删除远程服务器(可传 id 供 Tab 上的 ✕ 使用);删的是当前目标时自动切到其余目标/本机
async function delRemote(id) {
  const target = state.remotes.find((r) => r.id === (id || state.activeRemoteId));
  if (!target) return;
  if (!window.confirm(`删除远程服务器 ${target.user || '?'}@${target.host || '?'}?正在运行的服务会被停止。`)) return;
  const wasCurrent = isCurrentTarget(target.id);
  state.remotes = state.remotes.filter((r) => r.id !== target.id);
  if (state.activeRemoteId === target.id) state.activeRemoteId = (state.remotes[0] && state.remotes[0].id) || '';
  const patch = { remotes: state.remotes, activeRemoteId: state.activeRemoteId };
  // 默认启动模式指向被删档案时一并清理
  if (state.cfg && state.cfg.defaultRemoteId === target.id) patch.defaultRemoteId = '';
  const cfg = await window.piApi.setConfig(patch);
  applyCfg(cfg);
  delete state.servers.remotes[target.id];
  delete state.logs.remotes[target.id];
  renderMode();
  renderRemoteSelect();
  renderServer();
  if (wasCurrent) {
    const next = state.remotes.length ? state.remotes[0].id : 'local';
    await switchTarget(next, { force: true });
  } else {
    fillRemoteForm(activeRemote());
  }
  toast('已删除远程服务器', 'ok');
}

// 编辑远程服务器(Tab 上的 ✎):切到该目标并打开弹窗
async function editRemote(id) {
  if (!isCurrentTarget(id)) await switchTarget(id);
  openServersModal();
}

// 弹窗内切换选中的服务器档案:切换操作目标(同 Tab 点击语义)
async function selectRemote(id) {
  if (!id) return;
  closeServersModal();
  await switchTarget(id);
}

// 保存弹窗里的当前服务器配置
async function saveCurrentRemote() {
  const saved = await persistRemotes();
  if (!saved) return;
  renderMode();
  renderRemoteSelect();
  renderServer();
  toast('远程配置已保存', 'ok');

  // 该目标首次具备完整信息时自动检测
  const r = activeRemote();
  if (state.mode === 'remote' && r && r.host && r.user && !state.env) {
    await detectEnv({ silent: true });
    await checkUpdate({ silent: true });
    const st = await window.piApi.serverState();
    state.servers.remotes[state.activeRemoteId] = { ...defaultServer(), ...st };
    renderServer();
  }
}

// 测试 SSH 连接(先保存表单,再由主进程连接验证)
async function testRemote() {
  const remote = readRemoteForm();
  const err = validateRemoteForm(remote, { requireTarget: true });
  if (err) {
    toast(err, 'err');
    return;
  }
  state.remotes = state.remotes.map((r) => (r.id === state.activeRemoteId ? { ...r, ...remote } : r));
  const cfg = await window.piApi.setConfig({ remotes: state.remotes, activeRemoteId: state.activeRemoteId });
  state.cfg = cfg;
  state.remotes = cfg.remotes || [];

  const badge = $('remoteConnBadge');
  badge.className = 'badge badge-idle';
  badge.textContent = '测试中…';
  badge.title = '';
  $('remoteTestBtn').disabled = true;

  const res = await window.piApi.remoteTest();

  $('remoteTestBtn').disabled = false;
  if (res.ok) {
    badge.className = 'badge badge-latest';
    badge.textContent = '连接正常';
    badge.title = `主机指纹(SHA-256):${res.fingerprint || '已记录'}`;
    toast('SSH 连接测试成功', 'ok');
  } else {
    badge.className = 'badge badge-error';
    badge.textContent = '连接失败';
    badge.title = res.error || '';
    toast(`连接失败:${res.error}`, 'err');
  }
}

/* ---------------- 配置 ---------------- */

function fillConfigForm(cfg) {
  $('portInput').value = cfg.port;
  const p = cfg.proxy || {};
  $('proxyProtoSelect').value = ['http', 'socks4', 'socks5'].includes(p.protocol) ? p.protocol : 'http';
  $('proxyHostInput').value = p.host || '';
  $('proxyPortInput').value = p.port || '';
  $('proxyBypassInput').value = p.bypass || '';
  $('registryInput').value = cfg.registry || '';
  fillRemoteForm(activeRemote());
}

// 读取代理表单(协议下拉单行 + 不代理列表 + 远程开关)
function readProxyForm() {
  return {
    protocol: $('proxyProtoSelect').value,
    host: $('proxyHostInput').value.trim(),
    port: parseInt($('proxyPortInput').value, 10) || 0,
    bypass: $('proxyBypassInput').value,
  };
}

// 校验代理表单:服务器与端口要么都填要么都空;启用时必须填写
function validateProxyForm(p) {
  const hasHost = !!p.host;
  const hasPort = p.port > 0 && p.port < 65536;
  if (hasHost !== hasPort) return '代理服务器与端口需同时填写';
  return null;
}

async function saveConfig() {
  const proxyForm = readProxyForm();
  const proxyErr = validateProxyForm(proxyForm);
  if (proxyErr) {
    toast(proxyErr, 'err');
    return;
  }
  const cfg = await window.piApi.setConfig({
    proxy: proxyForm,
    registry: $('registryInput').value.trim(),
  });
  state.cfg = cfg;
  toast('设置已保存', 'ok');
}

// 端口在 Tab 上改动即保存(change 触发);运行中自动重启
async function saveLocalPort() {
  const port = parseInt($('portInput').value, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    toast('端口需在 1024 - 65535 之间', 'err');
    return;
  }
  const prev = state.cfg;
  const cfg = await window.piApi.setConfig({ port });
  state.cfg = cfg;
  toast('端口已保存', 'ok');
  if (state.mode === 'local' && curServer().running && curServer().owned && prev && prev.port !== port) {
    restartAfterPortChange();
  }
}

async function saveRemotePort() {
  if (state.mode !== 'remote') return;
  const p = parseInt($('remoteSrvPortInput').value, 10);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    toast('端口需在 1024 - 65535 之间', 'err');
    return;
  }
  const prev = activeRemote();
  state.remotes = state.remotes.map((r) => (r.id === state.activeRemoteId ? { ...r, remotePort: p } : r));
  const cfg = await window.piApi.setConfig({ remotes: state.remotes });
  state.cfg = cfg;
  state.remotes = cfg.remotes || [];
  renderRemoteSelect();
  toast('端口已保存', 'ok');
  if (curServer().running && curServer().owned && prev && prev.remotePort !== p) {
    restartAfterPortChange();
  }
}

async function restartAfterPortChange() {
  toast('端口已变更,正在重启服务…');
  await window.piApi.serverStop();
  const res = await window.piApi.serverStart();
  if (res.ok) {
    setServer({ running: true, owned: !res.external, external: !!res.external, url: res.url });
    showWeb(res.url);
  } else {
    setServer(defaultServer());
    showConsole();
    toast(`服务重启失败:${res.error}`, 'err');
  }
  renderServer();
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  // 系统服务 Tab(事件委托:点击切换 / ＋ 新增 / ✎ 编辑 / ✕ 删除)
  $('svcTabs').addEventListener('click', (e) => {
    const act = e.target.closest('.tab-act');
    const tab = e.target.closest('.svc-tab');
    if (!tab) return;
    const t = tab.dataset.target;
    if (act) {
      if (t === 'local' || t === '__add') return;
      if (act.dataset.act === 'edit') editRemote(t);
      else delRemote(t);
      return;
    }
    if (t === '__add') addRemote();
    else switchTarget(t);
  });

  // 重新检测 = 已装版本 + registry 最新版(行内不再单独放「检查更新」)
  $('redetectBtn').addEventListener('click', async () => {
    await detectEnv({ silent: true });
    await checkUpdate({ silent: true });
  });
  $('updateBtn').addEventListener('click', () => runUpdate('pi-web'));
  $('piUpdateBtn').addEventListener('click', () => runUpdate('pi'));

  // 远程服务器弹窗(入口:Tab 的 ＋ 新增 / ✎ 编辑)
  $('modalCloseBtn').addEventListener('click', closeServersModal);
  $('remoteModal').addEventListener('mousedown', (e) => {
    if (e.target === $('remoteModal')) closeServersModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('remoteModal').hidden) closeServersModal();
  });
  $('remoteSelect').addEventListener('change', (e) => selectRemote(e.target.value));
  $('remoteAddBtn').addEventListener('click', addRemote);
  $('remoteDelBtn').addEventListener('click', delRemote);
  $('remoteAuthSelect').addEventListener('change', renderAuthFields);
  $('remoteTestBtn').addEventListener('click', testRemote);
  $('remoteSaveBtn').addEventListener('click', saveCurrentRemote);

  // 端口改动即保存(失焦/回车触发),运行中自动重启
  $('portInput').addEventListener('change', saveLocalPort);
  $('remoteSrvPortInput').addEventListener('change', saveRemotePort);
  $('startBtn').addEventListener('click', startServer);
  $('stopBtn').addEventListener('click', stopServer);
  $('openBrowserBtn').addEventListener('click', () => curServer().url && window.piApi.openExternal(curServer().url));
  $('btnDefault').addEventListener('click', setDefaultTarget);
  $('proxyToggleBtn').addEventListener('click', toggleProxy);
  $('openBrowserBtn2').addEventListener('click', () => curServer().url && window.piApi.openExternal(curServer().url));
  $('refreshBtn').addEventListener('click', () => {
    const wv = $('wv');
    if (wv.getAttribute('src') !== 'about:blank') wv.reload();
  });
  $('newPageBtn').addEventListener('click', () => {
    const wv = $('wv');
    const url = (wv && wv.getAttribute('src')) || curServer().url;
    if (url && url !== 'about:blank') window.piApi.openPage(url);
  });
  $('backBtn').addEventListener('click', showConsole);
  $('saveConfigBtn').addEventListener('click', saveConfig);

  // 日志弹窗
  $('svcLogBtn').addEventListener('click', () => openLogModal(serverSourceKey()));
  $('updateLogBtn').addEventListener('click', () => openLogModal('update'));
  $('logCloseBtn').addEventListener('click', closeLogModal);
  $('logCopyBtn').addEventListener('click', async () => {
    if (!logModalSource) return;
    try {
      await navigator.clipboard.writeText(getLogText(logModalSource));
      toast('日志已复制', 'ok');
    } catch {
      toast('复制失败', 'err');
    }
  });
  $('logModal').addEventListener('mousedown', (e) => {
    if (e.target === $('logModal')) closeLogModal();
  });

  // 更新日志(pi / pi-web 同一来源,行首带标签;弹窗开着则实时刷新)
  window.piApi.onUpdateLog((payload) => {
    const tag = payload && payload.target === 'pi' ? '[pi] ' : '[pi-web] ';
    appendLog('update', tag + (payload.line ?? payload));
  });

  // 服务日志按「本地 / 各远程档案」缓存,仅当前 Tab 回显到日志面板
  window.piApi.onServerLog((payload) => {
    const isRemote = payload && payload.mode === 'remote';
    const line = payload && payload.line !== undefined ? payload.line : payload;
    if (isRemote) {
      const rid = payload.remoteId || '';
      state.logs.remotes[rid] = (state.logs.remotes[rid] || '') + (line ?? '');
      if (state.logs.remotes[rid].length > 60000) state.logs.remotes[rid] = state.logs.remotes[rid].slice(-40000);
      if (!(state.mode === 'remote' && rid === state.activeRemoteId)) return;
    } else {
      state.logs.local = state.logs.local + (line ?? '');
      if (state.logs.local.length > 60000) state.logs.local = state.logs.local.slice(-40000);
      if (state.mode !== 'local') return;
    }
    appendLog(serverSourceKey(), '');
  });

  window.piApi.onServerExited((info) => {
    console.warn('[pi] server:exited', JSON.stringify(info));
    const isRemote = info && info.mode === 'remote';
    const isCurrent = isRemote
      ? state.mode === 'remote' && (info.remoteId || '') === state.activeRemoteId
      : state.mode === 'local';
    if (isRemote) state.servers.remotes[info.remoteId || ''] = defaultServer();
    else state.servers.local = defaultServer();
    renderServer();
    if (!isCurrent) return;
    showConsole();
    if (!info.intentional) {
      toast(
        info.reason === 'disconnect'
          ? 'SSH 连接已断开,远程服务状态未知,重连后可重新识别'
          : `pi-web 服务已退出(code: ${info.code ?? '?'})`,
        'err'
      );
      openLogModal(serverSourceKey());
    }
  });

  window.piApi.onServerStarted((info) => {
    const isRemote = info && info.mode === 'remote';
    const isCurrent = isRemote
      ? state.mode === 'remote' && (info.remoteId || '') === state.activeRemoteId
      : state.mode === 'local';
    const st = { running: true, owned: true, external: false, url: info.url };
    if (isRemote) state.servers.remotes[info.remoteId || ''] = st;
    else state.servers.local = st;
    if (!isCurrent) {
      renderServer();
      return;
    }
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
  applyCfg(cfg);
  fillConfigForm(cfg);
  renderMode();
  renderRemoteSelect();
  renderProxyToggle();
  renderServer();

  const r = activeRemote();
  const canDetect = state.mode !== 'remote' || !!(r && r.host && r.user);
  if (canDetect) {
    await detectEnv({ silent: true });
    await checkUpdate({ silent: true });
  }

  const stateRes = await window.piApi.serverState();
  if (state.mode === 'local') {
    state.servers.local = { ...defaultServer(), ...stateRes };
  } else {
    state.servers.remotes[state.activeRemoteId] = { ...defaultServer(), ...stateRes };
  }
  renderServer();

  if (cfg.autoStart && state.env && state.env.piWeb.ok && !curServer().running && canDetect) {
    await startServer();
  }
}
// updateLog 由 appendLog 维护于 state.updateLog

init();
