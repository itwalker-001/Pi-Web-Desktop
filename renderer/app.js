'use strict';

const $ = (id) => document.getElementById(id);

// 本地与多台远程服务可同时运行:远程按档案(id)各自维护状态与日志,
// state.mode 决定本地/远程,state.activeRemoteId 决定当前操作的远程档案
const defaultServer = () => ({ running: false, owned: true, external: false, url: '' });
const emptyEnvState = () => ({ env: null, update: { installed: null, latest: null, outdated: false }, piUpdate: null });

const state = {
  cfg: null,
  mode: 'local',
  activeRemoteId: '',
  remotes: [],
  // 环境检测结果与版本信息:本机一份、每个远程档案一份(各服务器逐个检测、逐个归档,互不串台)
  envs: { local: { identity: '', ...emptyEnvState() }, remotes: {} },
  // code-server 卡状态:本机一份、每个远程档案一份(检测后填充,见 detectCodeServer)
  cs: { local: null, remotes: {} },
  appVersion: '',
  servers: { local: defaultServer(), remotes: {} },
  logs: { local: '', remotes: {} },
  updating: false,
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
  let n = state.servers.local.running ? 1 : 0; // 注意必须是 let:下面要累加(写成 const 会在多台服务同时运行时抛异常,中断切换目标后的界面刷新)
  for (const [id, s] of Object.entries(state.servers.remotes)) {
    if (s && s.running && id !== state.activeRemoteId) n += 1;
  }
  return n;
}

let externalPollTimer = null;

/* ---------------- 通用 ---------------- */

// ms:停留时长(毫秒),默认约 3.6 秒;需要用户看清或抄录的内容(如 code-server 登录密码)传长一些
function toast(msg, type = '', ms = 3600) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

function confirmAction({ title, message, detail = '', action, danger = false }) {
  const modal = $('confirmModal');
  if (!modal.hidden) return Promise.resolve(false);
  const previousFocus = document.activeElement;
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmDetail').textContent = detail;
  $('confirmDetail').hidden = !detail;
  // 确认键 = 图标 + 动作名(危险操作用警示三角,其余用对勾)
  $('confirmOkLabel').textContent = action;
  $('confirmOkIcon').setAttribute('href', danger ? '#i-warning' : '#i-check');
  $('confirmOkBtn').classList.toggle('danger-solid', danger);
  $('confirmOkBtn').classList.toggle('primary', !danger);
  $('confirmMark').classList.toggle('danger', danger);
  modal.hidden = false;
  $('confirmCancelBtn').focus();
  return new Promise((resolve) => {
    const cancel = () => finish(false);
    const accept = () => finish(true);
    const backdrop = (e) => { if (e.target === modal) cancel(); };
    const keydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      if (e.key === 'Tab') {
        const first = $('confirmCancelBtn');
        const last = $('confirmOkBtn');
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    function finish(confirmed) {
      modal.hidden = true;
      $('confirmCancelBtn').removeEventListener('click', cancel);
      $('confirmOkBtn').removeEventListener('click', accept);
      modal.removeEventListener('mousedown', backdrop);
      document.removeEventListener('keydown', keydown, true);
      if (previousFocus && previousFocus.focus) previousFocus.focus();
      resolve(confirmed);
    }
    $('confirmCancelBtn').addEventListener('click', cancel);
    $('confirmOkBtn').addEventListener('click', accept);
    modal.addEventListener('mousedown', backdrop);
    document.addEventListener('keydown', keydown, true);
  });
}

function setDot(id, status) {
  const dot = $(id);
  dot.className = 'dot';
  if (status === 'ok') dot.classList.add('dot-ok');
  else if (status === 'bad') dot.classList.add('dot-bad');
  else if (status === 'warn') dot.classList.add('dot-warn');
}

/* ---------------- 环境检测 ---------------- */

// 每个目标的检测结果各存一份。远程档案带「连接身份」(主机|SSH 端口|用户|私钥):检测始终对应当前
// 真正配置的那台服务器 —— 档案被改成别的服务器后,旧服务器的结果即作废
function remoteIdentity(r) {
  return r ? `${r.host}|${r.port}|${r.user}|${r.keyPath}` : '';
}

// 某个目标此刻的标识
function targetInfo(mode, remoteId) {
  if (mode !== 'remote') return { mode: 'local', remoteId: '', identity: '' };
  return { mode: 'remote', remoteId, identity: remoteIdentity(state.remotes.find((x) => x.id === remoteId) || null) };
}

function curTarget() {
  return targetInfo(state.mode, state.activeRemoteId);
}

function keyOf(t) {
  return t.mode === 'remote' ? t.remoteId : 'local';
}

function isCurrent(t) {
  return keyOf(t) === currentTargetId();
}

function envSlot(t) {
  if (t.mode !== 'remote') return state.envs.local;
  let slot = state.envs.remotes[t.remoteId];
  if (!slot || slot.identity !== t.identity) {
    slot = { identity: t.identity, ...emptyEnvState() };
    state.envs.remotes[t.remoteId] = slot;
  }
  return slot;
}

// 当前目标的环境检测结果(档案身份变了会自动作废)
function curEnv() {
  return envSlot(curTarget());
}

// 在途请求与序号:各目标的检测互不阻塞;同一目标先后发出的请求,只有最后一个的结果会被采用。
// 在途请求连身份一起记:检测途中档案被改成别的服务器时,新服务器的检测是另一个请求,不能并入旧的那个
const detectInflight = new Map();
const updateInflight = new Map();
const latestSeq = { detect: {}, update: {} };

function pendingOf(map, t) {
  const p = map.get(keyOf(t));
  return p && p.identity === t.identity ? p.promise : null;
}

function setPending(map, t, promise) {
  map.set(keyOf(t), { identity: t.identity, promise });
}

function clearPending(map, t, promise) {
  const p = map.get(keyOf(t));
  if (p && p.promise === promise) map.delete(keyOf(t));
}

// 环境检测:按发起时的目标发起、按目标归档。切走后才到达的响应只存不画 —— 不会把 A 的版本号画到
// B 的页面上,也不会因为 A 还在检测就跳过 B。fresh:绕开在途请求强制重新检测(一键更新之后用)
function detectEnv({ silent = false, fresh = false } = {}) {
  const target = curTarget();
  const key = keyOf(target);
  const pending = pendingOf(detectInflight, target);
  if (pending && !fresh) return pending;
  const seq = (latestSeq.detect[key] = (latestSeq.detect[key] || 0) + 1);

  if (isCurrent(target)) {
    $('redetectBtn').disabled = true;
    // 已有该目标上次的结果:后台静默刷新,不闪「检测中…」
    if (!envSlot(target).env) {
      for (const id of ['env-node', 'env-npm', 'env-pi', 'env-piweb']) $(id).textContent = '检测中…';
    }
  }

  const p = window.piApi.detectEnv(target)
    .catch((err) => ({ ok: false, error: String((err && err.message) || err), identity: target.identity }))
    .then((res) => {
      // 检测期间档案被改成了别的服务器:这是旧服务器的结果,作废
      const stale = res.identity !== targetInfo(target.mode, target.remoteId).identity;
      if (!stale && seq === latestSeq.detect[key]) {
        const slot = envSlot(target);
        slot.env = res.ok ? res.env : null;
        if (res.ok && res.appVersion) state.appVersion = res.appVersion;
        if (isCurrent(target)) {
          if (res.ok) {
            renderEnv(res.env, state.appVersion);
          } else {
            for (const id of ['env-node', 'env-npm', 'env-pi', 'env-piweb']) {
              $(id).textContent = '—';
              setDot(`dot-${id.replace('env-', '')}`, 'bad');
            }
            toast(`环境检测失败:${res.error}`, 'err');
          }
        }
      }
      return res;
    })
    .finally(() => {
      clearPending(detectInflight, target, p);
      if (!pendingOf(detectInflight, curTarget())) $('redetectBtn').disabled = false;
    });
  setPending(detectInflight, target, p);
  return p;
}

// 尚无结果:四项显示「—」,绝不沿用上一个目标的数值
function renderEnvUnknown() {
  for (const id of ['env-node', 'env-npm', 'env-pi', 'env-piweb']) {
    $(id).textContent = '—';
    setDot(`dot-${id.replace('env-', '')}`, '');
  }
  $('env-pi').title = '';
  $('env-pi-extra').textContent = 'pi CLI';
  $('env-piweb-extra').textContent = '—';
  $('env-piweb-extra').title = '';
  $('updateBtn').hidden = true;
  $('piUpdateBtn').hidden = true;
  $('appVersion').textContent = state.appVersion ? `v${state.appVersion}` : '—';
}

// 画出当前目标已归档的检测结果(切 Tab 时立即显示该目标自己的上次结果,随后后台刷新)
function renderEnvState() {
  const slot = curEnv();
  if (slot.env) renderEnv(slot.env, state.appVersion);
  else renderEnvUnknown();
  if (slot.env || slot.update.installed !== null || slot.piUpdate) renderUpdate();
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
  const { update, piUpdate } = curEnv();
  const pi = piUpdate;
  const { installed, latest, outdated } = update;

  // pi-web 行:有更新或未安装才显示更新图标
  setDot('dot-piweb', outdated ? 'warn' : installed ? 'ok' : 'bad');
  const piwebCell = $('env-piweb');
  piwebCell.textContent = !installed ? '未安装' : outdated && latest ? `v${installed} → v${latest}` : `v${installed}`;
  piwebCell.title = !installed ? '未安装,点击右侧图标执行 npm install -g @agegr/pi-web' : '';
  const piwebExtra = $('env-piweb-extra');
  piwebExtra.textContent = !installed ? '未安装' : outdated ? '有更新' : '全局包';
  const ub = $('updateBtn');
  ub.hidden = !(outdated || !installed);
  ub.disabled = false;
  ub.title = !installed ? '一键安装' : outdated ? `一键更新 → v${latest}` : '';

  // pi 行:同规则
  const hasPi = !!(pi && pi.resolved);
  const piOutdated = hasPi && pi.outdated;
  setDot('dot-pi', !hasPi || !pi.installed ? 'bad' : piOutdated ? 'warn' : 'ok');
  $('env-pi-extra').textContent = !hasPi || !pi.installed ? '未安装' : piOutdated ? '有更新' : 'pi CLI';
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

// 版本检测:同样按目标发起、归档 —— 已装版本是那台服务器自己的,最新版也在那台服务器上查
function checkUpdate({ silent = false, fresh = false } = {}) {
  const target = curTarget();
  const key = keyOf(target);
  const pending = pendingOf(updateInflight, target);
  if (pending && !fresh) return pending;
  const seq = (latestSeq.update[key] = (latestSeq.update[key] || 0) + 1);

  const p = window.piApi.checkUpdate(target)
    .catch((err) => ({
      ok: false, installed: null, latest: null, outdated: false, pi: null,
      error: String((err && err.message) || err), identity: target.identity,
    }))
    .then((res) => {
      const stale = res.identity !== targetInfo(target.mode, target.remoteId).identity;
      if (!stale && seq === latestSeq.update[key]) {
        const slot = envSlot(target);
        slot.update = { installed: res.installed, latest: res.latest, outdated: !!res.outdated };
        slot.piUpdate = res.pi || null;
        if (isCurrent(target)) {
          renderUpdate();
          if (!res.ok && !silent) toast(`检查更新失败:${res.error || '未知错误'}`, 'err');
        }
      }
      return res;
    })
    .finally(() => {
      clearPending(updateInflight, target, p);
    });
  setPending(updateInflight, target, p);
  return p;
}

async function runUpdate(target = 'pi-web') {
  if (restartBusy()) return;
  if (state.updating) return;
  state.updating = true;
  const isPi = target === 'pi';
  const btn = isPi ? $('piUpdateBtn') : $('updateBtn');
  const installing = isPi ? !curEnv().piUpdate || !curEnv().piUpdate.installed : !curEnv().update.installed;
  btn.disabled = true;
  btn.classList.add('spinning');
  btn.title = installing ? '安装中…' : '更新中…';
  const tag = isPi ? '[pi] ' : '[Pi Web] ';
  appendLog('update', `\n${tag}—— 开始${installing ? '安装' : '更新'} ——\n`);

  const res = await window.piApi.runUpdate(target);

  state.updating = false;
  btn.classList.remove('spinning');
  btn.disabled = isPi ? !(curEnv().piUpdate && curEnv().piUpdate.resolved) : false;

  if (res.ok) {
    appendLog('update', `${tag}✅ 完成,当前版本 v${res.version}\n`);
    toast(`${isPi ? 'pi' : 'Pi Web'} ${installing ? '已安装' : '已更新'} → v${res.version}`, 'ok');
    // 装完后的结果必须重新取:在途的旧请求(安装前发出)不能冒充最新状态
    await Promise.all([detectEnv({ silent: true, fresh: true }), checkUpdate({ silent: true, fresh: true })]);
  } else {
    appendLog('update', `${tag}❌ ${installing ? '安装' : '更新'}失败:${res.error}\n`);
    toast(`${installing ? '安装' : '更新'}失败:${(res.error || '').split('\n')[0]}`, 'err');
    await checkUpdate({ silent: true });
  }
}

/* ---------------- 服务地址(本地/远程统一为一个 URL) ---------------- */

// 当前 Tab 服务对应的 URL:本地 http://127.0.0.1:端口 / 远程 http://主机:端口。
// 环境检测、版本更新、启停、内嵌页,最终都落到这个地址上。
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
  // 重建内容会丢掉轨道的横向滚动位置:目标多到需要滚动时,选中的目标会被甩出可见范围 → 先记下,画完再还原
  const scrollLeft = wrap.scrollLeft;
  wrap.innerHTML =
    items
      .map((it) => {
        const active = it.id === currentTargetId();
        const isDef = isDefaultTargetId(it.id);
        const acts =
          it.id === 'local'
            ? ''
            : '<span class="tab-acts">' +
              `<span class="tab-act" role="button" tabindex="-1" aria-label="编辑 ${it.label}" data-act="edit" title="编辑"><svg class="icon" aria-hidden="true"><use href="#i-edit"></use></svg></span>` +
              `<span class="tab-act tab-del" role="button" tabindex="-1" aria-label="删除 ${it.label}" data-act="del" title="删除"><svg class="icon" aria-hidden="true"><use href="#i-xmark"></use></svg></span>` +
              '</span>';
        // 图标区分目标类型(本机 / 远程服务器);该目标的服务在运行时,名称后面带一个绿点
        const tabIcon = it.id === 'local' ? '#i-computer' : '#i-server';
        return (
          `<button class="svc-tab${active ? ' active' : ''}${it.running ? ' running' : ''}" data-target="${it.id}" title="${it.label}">` +
          `<svg class="icon" aria-hidden="true"><use href="${tabIcon}"></use></svg><span class="svc-label">${it.label}</span><span class="svc-run"></span>` +
          acts +
          (isDef ? '<span class="svc-def">默认</span>' : '') +
          '</button>'
        );
      })
      .join('') + '<button class="svc-tab svc-add" data-target="__add" title="新增远程服务器" aria-label="新增远程服务器"><svg class="icon" aria-hidden="true"><use href="#i-plus"></use></svg></button>';
  wrap.scrollLeft = scrollLeft;
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
  renderProxyToggle(); // 盾形开关显示的是当前目标的代理状态,随目标切换
  renderCodeServer(); // code-server 卡的状态行与按钮可用性随目标切换
  $('termOpenBtn').disabled = !isRemote; // SSH 终端仅远程可用,本机 Tab 置灰
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

// 代理按目标各配一份(本机一份、每个远程档案一份)。主进程在配置里给出每个目标的代理视图
function proxyViewOf(id) {
  const views = (state.cfg && state.cfg.proxyViews) || {};
  if (id === 'local') return views.local || {};
  return (views.remotes || {})[id] || {};
}

// 当前目标的名称,用于提示文案
function targetLabel() {
  const r = activeRemote();
  return state.mode === 'remote' ? `远程 ${(r && r.host) || '(未配置)'} ` : '本机 ';
}

// 把一份代理写进当前目标:本机 → 顶层 proxy;远程 → 该档案自己的 proxy(其它档案不动)。
// 与该目标已存的代理合并:表单里没有 enabled,保存地址不能把启用状态冲掉
function proxyPatch(form) {
  if (state.mode !== 'remote') return { proxy: form };
  return {
    remotes: state.remotes.map((r) => (r.id === state.activeRemoteId ? { ...r, proxy: { ...(r.proxy || {}), ...form } } : r)),
  };
}

// 代理开关(顶层目标条 🛡):切的是当前目标的 enabled,配置本体在代理设置卡
function renderProxyToggle() {
  const b = $('proxyToggleBtn');
  if (!b) return;
  const p = proxyViewOf(currentTargetId());
  const on = !!(p.enabled && p.primaryUrl);
  b.classList.toggle('on', on);
  const check = b.querySelector('.proxy-check');
  if (check) check.style.display = on ? 'block' : 'none';
  b.title = on
    ? `${targetLabel()}代理已启用:${p.primaryUrl} —— 点击关闭`
    : `${targetLabel()}代理未启用 —— 点击启用(需先在代理设置中填写代理服务器与端口)`;
}

async function toggleProxy() {
  const p = proxyViewOf(currentTargetId());
  const enabling = !(p.enabled && p.primaryUrl);
  if (enabling && (!p.host || !p.port)) {
    toast('请先在代理设置中填写该目标的代理服务器与端口', 'err');
    return;
  }
  const cfg = await window.piApi.setConfig(proxyPatch({
    enabled: enabling,
    protocol: p.protocol,
    host: p.host,
    port: p.port,
    bypass: p.bypass || '',
  }));
  state.cfg = cfg;
  state.remotes = cfg.remotes || [];
  renderMode();
  // 代理在服务启动时才注入:运行中的服务不会因为改了开关而改变出口
  const running = curServer().running;
  toast(
    running
      ? `${targetLabel()}代理已${enabling ? '启用' : '关闭'};服务运行中,下次启动服务时生效`
      : `${targetLabel()}代理已${enabling ? '启用' : '关闭'}`,
    running ? '' : 'ok'
  );
}

// 切换目标 Tab(本机 / 某台远程):不停任何服务,仅切换展示与操作对象
async function switchTarget(id, { force = false } = {}) {
  if (restartBusy()) return;
  if (isCurrentTarget(id) && !force) return;
  if (state.updating) {
    toast('更新任务进行中,请稍后再切换', 'err');
    return;
  }
  const isLocal = id === 'local';
  const patch = isLocal ? { mode: 'local' } : { mode: 'remote', activeRemoteId: id };
  const cfg = await window.piApi.setConfig(patch);
  applyCfg(cfg);
  showConsole();
  fillRemoteForm(activeRemote());
  fillProxyForm(); // 代理卡切换到该目标自己的代理(未保存的编辑随之丢弃)
  fillCodeServerForm(); // code-server 配置卡同样跟随目标
  detectCodeServer({ silent: true }); // 按目标重新检测 code-server 状态(不阻塞切换)
  renderMode();
  renderServer();
  renderEnvState(); // 该目标自己的检测结果:有上次结果就先画,没有则显示「—」
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

// 服务地址(只用于展示):运行中用主进程报告的实际地址;未运行时按当前主机 / 端口推算,
// 拼法与主进程一致(lib/server.js 的 serverUrl、lib/remote-server.js 的 serverUrl)
function serviceAddress() {
  const srv = curServer();
  if (srv.running && srv.url) return srv.url;
  if (state.mode === 'remote') {
    const r = activeRemote();
    return r && r.host ? `http://${r.host}:${r.remotePort || 30141}/` : '—';
  }
  return `http://127.0.0.1:${(state.cfg && state.cfg.port) || 30141}/`;
}

function renderServerUrl() {
  $('serverUrl').textContent = serviceAddress();
}

function renderServer() {
  const srv = curServer();
  const running = srv.running;
  const external = srv.external;
  const modeLabel = state.mode === 'remote'
    ? (activeRemote() && activeRemote().host ? `远程 ${activeRemote().host}` : '远程')
    : '本机';
  // 操作行按运行态启用:启动(唯一的主操作)只在停止时可用;停止 / 重启 / 访问只在运行时可用。
  // 运行中要进服务页用「访问」,所以启动按钮不再兼作「打开」
  const startBtn = $('startBtn');
  startBtn.disabled = running || restartingServer;
  startBtn.title = '启动服务'; // startServer 启动途中会把它改成「启动中…」,这里每次渲染都复位
  $('stopBtn').disabled = !running || restartingServer;
  $('restartBtn').disabled = !running || restartingServer;
  $('openPageBtn').disabled = !running || restartingServer;
  renderTermBar(); // 终端工具栏的「Pi Web」按钮跟随同一服务状态
  // 状态徽标:只放状态,种类写进 data-state 供样式配色(运行中 / 外部启动 / 已停止);地址单独一行显示
  const stateEl = $('serverState');
  stateEl.textContent = running ? `运行中${external ? '(外部启动)' : ''}` : '已停止';
  stateEl.dataset.state = running ? (external ? 'external' : 'running') : 'stopped';
  renderServerUrl();

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
      toast('外部 Pi Web 服务已停止', 'err');
    }
  }, 5000);
}

async function startServer(operation) {
  if (operation !== RESTART_CALL && restartBusy()) return;
  if (!curServer().running && (!curEnv().env || !curEnv().env.piWeb.ok)) {
    toast('未检测到 Pi Web,请先安装或更新', 'err');
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
    if (res.external) toast('检测到端口已占用,已连接到正在运行的 Pi Web');
    else if (res.adopted) toast('端口上的 Pi Web 是本应用上次启动的,已重新接管,可直接停止或更新', 'ok');
    showWeb(res.url);
  } else {
    toast(`启动失败:${res.error}`, 'err');
    openLogModal(serverSourceKey());
    renderServer();
  }
}

// 外部实例不代停:把「原处」落到具体的主机与端口上,免得不知道该去哪儿停
function externalStopHint() {
  const r = (state.mode === 'remote' && activeRemote()) || {};
  const port = state.mode === 'remote' ? r.remotePort || 30141 : (state.cfg && state.cfg.port) || 30141;
  const where = state.mode === 'remote'
    ? `远程 ${[r.user, r.host].filter(Boolean).join('@') || '?'} 端口 ${port}`
    : `本机端口 ${port}`;
  return `${where} 上的 Pi Web 不是本应用启动的,本应用不会代停;请在启动它的地方手动停止`;
}

async function stopServer(operation) {
  if (operation !== RESTART_CALL && restartBusy()) return;
  let res = await window.piApi.serverStop();
  // 外部实例(远程):弹原生确认框,用户知情后强制结束;本地保持提示语义(不代停)
  if (res.external && state.mode === 'remote') {
    const confirmed = await confirmAction({
      title: '强制结束 Pi Web',
      message: `该服务不是本应用启动的。仍要结束 ${[activeRemote()?.user, activeRemote()?.host].filter(Boolean).join('@') || '远程服务器'} 端口 ${activeRemote()?.remotePort || 30141} 上的进程吗？`,
      detail: '将结束该端口上的 Pi Web 及其子进程。请确认没有其他人正在使用。',
      action: '强制结束', danger: true,
    });
    if (!confirmed) return;
    res = await window.piApi.serverStop({ force: true });
  }
  if (res.external) {
    toast(externalStopHint(), 'err');
    return;
  }
  if (res.error) {
    toast(res.error, 'err'); // 服务多半还在运行:保持运行态,不能当成已停止
    return;
  }
  setServer(defaultServer());
  renderServer();
  showConsole();
}

// 重启 = 先停、再启动。停止沿用 stopServer 的全部规则(外部实例不代停、停止失败即保持运行态并提示),
// 没停成功就不再叠加启动 —— 避免旧实例还在时又启一个
let restartingServer = false;
const RESTART_CALL = Symbol('restart');
function restartBusy() {
  if (!restartingServer) return false;
  toast('服务重启中,请稍后再操作', 'err');
  return true;
}

async function restartServer() {
  if (restartingServer || !curServer().running) return;
  restartingServer = true;
  renderServer();
  try {
    await stopServer(RESTART_CALL);
    if (curServer().running) return;
    await startServer(RESTART_CALL);
  } finally {
    restartingServer = false;
    renderServer();
  }
}

// 输入框右侧的「复制」:把该输入框当前的值写进剪贴板
async function copyFieldValue(id, what) {
  const value = String($(id).value || '');
  if (!value) return;
  const res = await window.piApi.copyText(value).catch(() => null);
  toast(res && res.ok ? `已复制${what}:${value}` : `复制失败,请手动复制:${value}`, res && res.ok ? 'ok' : 'err');
}

function showWeb(url) {
  document.body.classList.remove('in-term');
  document.body.classList.add('in-web');
  $('consoleView').hidden = true;
  $('termView').hidden = true; // 与终端视图互斥;终端会话不被销毁,切回来继续用
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
  document.body.classList.remove('in-term');
  $('webView').hidden = true;
  $('termView').hidden = true;
  $('consoleView').hidden = false;
}

/* ---------------- SSH 终端(远程交互式 shell,Ctrl+V 上传 /tmp) ---------------- */

// 单会话模型:一次只有一个终端会话,关闭视图即停止会话;重连 = 销毁旧会话再开新的
const termState = {
  term: null,         // xterm Terminal 实例
  fit: null,          // FitAddon(容器尺寸 → cols/rows)
  decoder: null,      // 流式 UTF-8 解码(防多字节被数据块边界截断)
  id: '',             // 当前会话 id(主进程 term.js 维护)
  target: null,       // 会话对应的目标({ mode, remoteId, identity })
  resizeTimer: 0,
  resizeObserver: null,
  pasting: false,     // Ctrl+V 处理中(上传耗时,防重入)
};

// 需要引号才安全时用单引号包住(与主进程 remote.js 的 shellQuote 同规则)
function termShellQuote(p) {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(p) ? `'${String(p).replace(/'/g, "'\\''")}'` : p;
}

function showTerm() {
  document.body.classList.remove('in-web');
  document.body.classList.add('in-term');
  $('consoleView').hidden = true;
  $('webView').hidden = true;
  $('termView').hidden = false;
  refreshServerState(); // 进入终端即核对 pi-web 服务状态(可能已在别处启停)
}

function closeTerm() {
  destroyTerm();
  document.body.classList.remove('in-term');
  $('termView').hidden = true;
  $('consoleView').hidden = false;
}

// 结束会话并释放渲染层资源(重连/关闭视图共用;幂等)
function destroyTerm() {
  if (termState.resizeObserver) {
    termState.resizeObserver.disconnect();
    termState.resizeObserver = null;
  }
  clearTimeout(termState.resizeTimer);
  if (termState.id) {
    const id = termState.id;
    termState.id = '';
    window.piApi.termStop({ id }).catch(() => {});
  }
  if (termState.term) {
    try { termState.term.dispose(); } catch {}
    termState.term = null;
  }
  termState.fit = null;
  termState.decoder = null;
  termState.target = null;
  $('termMount').innerHTML = '';
  $('termOverlay').hidden = true;
  setDot('termStatusDot', '');
}

function showTermDisconnected(msg) {
  setDot('termStatusDot', 'bad');
  $('termOverlayText').textContent = msg || '连接已断开';
  $('termOverlay').hidden = false;
}

async function openTerm() {
  const t = curTarget();
  if (t.mode !== 'remote') {
    toast('SSH 终端仅支持远程服务器', 'err');
    return;
  }
  const rem = state.remotes.find((x) => x.id === t.remoteId) || null;
  if (!rem || !rem.host || !rem.user) {
    toast('请先在远程设置中配置主机与用户名', 'err');
    return;
  }
  // 与 pi-web 服务页互切回来的场景:同目标的会话还活着就直接复用(不重开 shell)
  if (termReusableFor(t)) {
    showTerm();
    refitTerm();
    return;
  }
  showTerm();
  await startTermSession(t);
}

// 终端会话是否仍是该目标的活跃会话(互切时直接复用)
function termReusableFor(t) {
  return !!(termState.id && termState.term && termState.target && keyOf(termState.target) === keyOf(t));
}

// 重进终端视图:按当前容器尺寸重算 cols/rows 并同步 PTY(隐藏期间输出已持续写入缓冲区)
function refitTerm() {
  if (!termState.term || !termState.fit) return;
  try { termState.fit.fit(); } catch {}
  if (termState.id) {
    window.piApi
      .termResize({ id: termState.id, cols: termState.term.cols, rows: termState.term.rows })
      .catch(() => {});
  }
  termState.term.focus();
}

// 终端工具栏的「Pi Web」按钮跟随当前目标的 pi-web 服务状态(与 Pi Web 卡的停止/打开按钮同一依据):
// 服务不在运行时置灰,tooltip 说明原因 —— 不让用户点了才知道不可用
function renderTermBar() {
  const srv = curServer();
  const ready = !!(srv.running && srv.url);
  const btn = $('termWebBtn');
  btn.disabled = !ready;
  btn.title = ready
    ? '切换到 Pi Web 服务页(终端会话在两视图间切换时保留)'
    : 'Pi Web 服务未运行:请先在控制台启动服务';
}

// 重新查询当前目标的 pi-web 服务状态(进入终端视图时调用)
async function refreshServerState() {
  const t = curTarget();
  let res;
  try {
    res = await window.piApi.serverState();
  } catch {
    return; // 查询失败:保持现有状态
  }
  // 在途时用户切了目标:结果不落到别的服务器上
  if (keyOf(curTarget()) !== keyOf(t)) return;
  if (state.mode === 'local') {
    state.servers.local = { ...defaultServer(), ...res };
  } else {
    state.servers.remotes[state.activeRemoteId] = { ...defaultServer(), ...res };
  }
  renderServer();
}

// 终端 → pi-web 服务页(会话保留在后台,「终端」按钮切回来接着用)
function openWebFromTerm() {
  const url = curServer().url;
  if (!url) {
    toast('Pi Web 服务未启动,请先在控制台启动服务', 'err');
    return;
  }
  showWeb(url);
}

// 终端主题预设:auto = 取应用 design token(与控制台一致);其余为常见配色(带 ANSI 16 色)
const TERM_THEMES = {
  light: {
    background: '#f6f8fa', foreground: '#24292f', cursor: '#4f7cff', cursorAccent: '#f6f8fa', selectionBackground: '#4f7cff44',
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  'solarized-dark': {
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#586e75',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  'solarized-light': {
    background: '#fdf6e3', foreground: '#657b83', cursor: '#657b83', cursorAccent: '#fdf6e3', selectionBackground: '#93a1a1',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#93a1a1', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  'one-dark': {
    background: '#282c34', foreground: '#abb2bf', cursor: '#abb2bf', cursorAccent: '#282c34', selectionBackground: '#3e4451',
    black: '#1e2127', red: '#e06c75', green: '#98c379', yellow: '#d19a66', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
    brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
  },
  monokai: {
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#272822', selectionBackground: '#49483e',
    black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
    brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
  },
  nord: {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
  'tokyo-night': {
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: '#283457',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  },
  'gruvbox-dark': {
    background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945',
    black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
    brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
  },
};

function termThemeOf() {
  const name = (state.cfg && state.cfg.termTheme) || 'auto';
  if (TERM_THEMES[name]) return TERM_THEMES[name];
  const css = getComputedStyle(document.body);
  const accent = css.getPropertyValue('--accent').trim() || '#4f7cff';
  const bg = css.getPropertyValue('--bg').trim() || '#0e1320';
  return {
    background: bg,
    foreground: css.getPropertyValue('--text').trim() || '#e6ebf5',
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: `${accent}44`,
  };
}

async function startTermSession(t) {
  destroyTerm();
  const rem = state.remotes.find((x) => x.id === t.remoteId) || null;
  $('termTitle').textContent = rem && rem.host ? `${rem.user ? `${rem.user}@` : ''}${rem.host}` : '(未配置)';
  setDot('termStatusDot', 'warn');

  // 字体仍取 design token;主题按配置(默认 auto = 应用色板)
  const css = getComputedStyle(document.body);
  const term = new Terminal({
    fontFamily: css.getPropertyValue('--mono').trim() || 'monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    theme: termThemeOf(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('termMount'));
  fit.fit();

  termState.term = term;
  termState.fit = fit;
  termState.decoder = new TextDecoder('utf-8');
  term.focus();

  const res = await window.piApi.termStart({ target: t, cols: term.cols, rows: term.rows })
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
  // 关闭或重连后,旧请求仍可能成功;立即回收晚到的会话,不覆盖当前终端。
  if (termState.term !== term) {
    if (res.ok && res.id) await window.piApi.termStop({ id: res.id }).catch(() => {});
    return;
  }
  if (!res.ok) {
    showTermDisconnected(`连接失败:${res.error}`);
    return;
  }
  termState.id = res.id;
  termState.target = t;
  setDot('termStatusDot', 'ok');

  // 键入 → PTY。粘贴的文本也走这里(xterm 的 paste 是输入语义)
  term.onData((data) => {
    if (termState.id) window.piApi.termWrite({ id: termState.id, data }).catch(() => {});
  });

  // Ctrl+V 拦截:剪贴板是截图/文件 → 上传 /tmp 后把远程路径填入输入行;是文本 → 按普通粘贴
  term.attachCustomKeyEventHandler((e) => {
    if (
      e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey &&
      String(e.key).toLowerCase() === 'v'
    ) {
      handleTermPaste();
      return false;
    }
    return true;
  });

  // 窗口尺寸变化 → 重算 cols/rows 并同步 PTY(100ms 防抖;视图隐藏时尺寸为 0,跳过)
  termState.resizeObserver = new ResizeObserver(() => {
    clearTimeout(termState.resizeTimer);
    termState.resizeTimer = setTimeout(() => {
      if (!termState.term || !termState.fit || !$('termMount').clientHeight) return;
      termState.fit.fit();
      if (termState.id) {
        window.piApi
          .termResize({ id: termState.id, cols: termState.term.cols, rows: termState.term.rows })
          .catch(() => {});
      }
    }, 100);
  });
  termState.resizeObserver.observe($('termMount'));
}

async function handleTermPaste() {
  if (!termState.id || termState.pasting) return;
  const { id, term, target } = termState;
  termState.pasting = true;
  try {
    const res = await window.piApi.termPaste({ target });
    if (termState.id !== id || termState.term !== term) return;
    if (!res.ok) {
      toast(`粘贴失败:${res.error}`, 'err');
      return;
    }
    if (res.type === 'text') {
      if (res.text && termState.term) termState.term.paste(res.text);
      return;
    }
    // 上传完成:把远程路径作为键入内容填进当前输入行(不带回车,可继续编辑或接参数)
    if (termState.term && res.paths && res.paths.length) {
      await window.piApi.termWrite({ id: termState.id, data: res.paths.map(termShellQuote).join(' ') }).catch(() => {});
      toast(`已上传到 /tmp:${res.paths.join(' ')}`, 'ok', 5000);
    }
  } finally {
    termState.pasting = false;
  }
}

function reconnectTerm() {
  startTermSession(curTarget());
}

/* ---------------- 在 code-server 中打开当前项目 ---------------- */

// 在服务页(pi-web 界面)里执行,取出当前项目目录。pi-web 侧边栏里每个项目行都带着自己的目录
// (data-row-key="group:<目录>"),当前项目行另有 is-current 标记。依次尝试三条路径,界面改版后仍有机会识别:
//   ① 当前项目行   ② 展开着的项目组(aria-expanded)   ③ 当前会话 → 查 pi-web 会话接口取 cwd
const PROJECT_DIR_SCRIPT = `(() => {
  const dirOf = (el) => {
    const row = el && el.closest('[data-row-key]');
    const key = row ? row.getAttribute('data-row-key') || '' : '';
    return key.startsWith('group:') ? key.slice(6) : '';
  };
  return dirOf(document.querySelector('.session-tree-group.is-current'))
    || dirOf(document.querySelector('.session-tree-group [aria-expanded="true"]'))
    || '';
})()`;

const CURRENT_SESSION_ID_SCRIPT = `(() => {
  const a = document.querySelector('.session-tree-session.is-current a[href*="session="], .session-tree-session[aria-current] a[href*="session="]');
  if (!a) return '';
  try { return new URL(a.getAttribute('href'), location.href).searchParams.get('session') || ''; } catch (e) { return ''; }
})()`;

// 会话详情接口不带 cwd,会话列表接口带;同源只读请求
const sessionCwdScript = (id) => `fetch('/api/sessions', { cache: 'no-store' })
  .then((r) => r.json())
  .then((j) => ((j && j.sessions) || []).find((s) => s && s.id === ${JSON.stringify(id)}))
  .then((s) => (s && typeof s.cwd === 'string' ? s.cwd : ''))
  .catch(() => '')`;

async function detectCurrentProjectDir(wv) {
  const run = (code) => wv.executeJavaScript(code);
  const primary = await run(PROJECT_DIR_SCRIPT).catch(() => '');
  if (primary) return primary;
  const id = await run(CURRENT_SESSION_ID_SCRIPT).catch(() => '');
  return id ? run(sessionCwdScript(id)).catch(() => '') : '';
}

let openingEditor = false;
async function openCurrentProjectInEditor() {
  if (openingEditor) return;
  if (!curServer().running) {
    toast('服务未运行,请先启动服务', 'err');
    return;
  }
  openingEditor = true;
  try {
    const dir = await detectCurrentProjectDir($('wv'));
    if (!dir) {
      toast('没能从服务页识别出当前项目,请先在 Pi Web 中打开一个项目', 'err');
      return;
    }
    const local = state.mode !== 'remote'; // 与主进程 editor:open 的判断一致(cfg.mode !== 'remote')
    toast(`正在用 ${local ? 'VS Code' : 'code-server'} 打开 ${dir}`);
    let res = await window.piApi.openInEditor(dir);
    // 那台服务器上还没装 code-server(可选组件):问一句要不要装,不装就到此为止
    if (res.needInstall) {
      const c = await window.piApi.confirmInstallCodeServer().catch(() => null);
      if (!c || !c.confirmed) return;
      const installed = await installCodeServer();
      if (!installed.ok) return;
      res = await window.piApi.openInEditor(dir);
    }
    if (!res.ok) {
      toast(`无法用 ${local ? 'VS Code' : 'code-server'} 打开:${res.error}`, 'err', 9000);
      return;
    }
    // 本机目标是在桌面版 VS Code 里打开的(没有本应用的窗口),给一句回执
    if (res.app === 'vscode') toast(`已在 VS Code 中打开:${dir}`, 'ok');
  } finally {
    openingEditor = false;
  }
}

// code-server 窗口落到了登录页:把服务器上 code-server 的登录密码复制并显示出来。
// 已登录会直接进入项目,不会走到这里;会话过期退回登录页时会再触发一次
async function showCodeServerPassword(info) {
  if (!info || !info.password) return;
  const copied = await window.piApi.copyText(info.password).catch(() => null);
  toast(`code-server 需要登录,密码${copied && copied.ok ? '已复制到剪贴板' : '如下'}:${info.password}`, 'ok', 15000);
}

// 一键安装 code-server(可选组件,仅远程服务器):进度写进「更新日志」;
// 期间与 pi / pi-web 的安装更新互斥,也不能切换目标(state.updating)
async function installCodeServer() {
  if (state.updating) {
    toast('已有安装或更新任务在进行中,请稍后再试', 'err');
    return { ok: false };
  }
  state.updating = true;
  appendLog('update', '\n');
  openLogModal('update');
  toast('正在安装 code-server,进度见「更新日志」…');
  try {
    const res = await window.piApi.installCodeServer();
    if (res.ok) toast(`code-server 安装完成(版本 ${res.version})`, 'ok');
    else toast(`code-server 安装失败:${(res.error || '').split('\n')[0]}`, 'err', 9000);
    return res;
  } finally {
    state.updating = false;
  }
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
  if (restartBusy()) return null;
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
  if (restartBusy()) return;
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
    // 新服务器默认不走代理:要哪台走、走哪个代理,逐台各自配置
    proxy: { enabled: false, protocol: 'http', host: '', port: 0, bypass: '' },
    codeServerUrl: '', // 留空:用时自动检测该服务器的 code-server
  };
  state.remotes = [...state.remotes, profile];
  state.activeRemoteId = id;
  const cfg = await window.piApi.setConfig({ remotes: state.remotes, activeRemoteId: id });
  applyCfg(cfg);
  fillRemoteForm(profile);
  fillProxyForm(); // 代理卡跟随目标:新服务器显示它自己的(空的)代理
  renderMode();
  renderRemoteSelect();
  renderServer();
  renderEnvState(); // 新档案还没有任何检测结果:不沿用原目标的数值
  openServersModal();
  $('remoteHostInput').focus();
  toast('已新增远程服务器,请填写主机与用户名');
}

// 删除远程服务器(可传 id 供 Tab 上的 ✕ 使用);删的是当前目标时自动切到其余目标/本机
async function delRemote(id) {
  if (restartBusy()) return;
  const target = state.remotes.find((r) => r.id === (id || state.activeRemoteId));
  if (!target) return;
  if (!await confirmAction({
    title: '删除远程服务器',
    message: `删除 ${target.user || '?'}@${target.host || '?'} 的配置档案？`,
    detail: '正在运行的服务会被停止。此操作无法撤销。',
    action: '删除服务器', danger: true,
  })) return;
  if (restartBusy()) return;
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
  delete state.envs.remotes[target.id];
  renderMode();
  renderRemoteSelect();
  renderServer();
  if (wasCurrent) {
    const next = state.remotes.length ? state.remotes[0].id : 'local';
    await switchTarget(next, { force: true });
  } else {
    fillRemoteForm(activeRemote());
  }
  if ($('remoteModal').hidden) {
    const selected = $('svcTabs').querySelector('.svc-tab.active');
    if (selected) selected.focus();
  } else {
    ($('remoteSelect').disabled ? $('remoteAddBtn') : $('remoteSelect')).focus();
  }
  toast('已删除远程服务器', 'ok');
}

// 编辑远程服务器(Tab 上的 ✎):切到该目标并打开弹窗
async function editRemote(id) {
  if (restartBusy()) return;
  if (!isCurrentTarget(id)) await switchTarget(id);
  openServersModal();
}

// 弹窗内切换选中的服务器档案:切换操作目标(同 Tab 点击语义)
async function selectRemote(id) {
  if (restartBusy()) { renderRemoteSelect(); return; }
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
  fillProxyForm(); // 主机/用户可能被改了:代理卡标题里的服务器随之刷新
  renderEnvState(); // 档案的连接身份可能被改了:那是别的服务器,旧检测结果作废并立即反映到页面
  toast('远程配置已保存', 'ok');

  // 该目标首次具备完整信息时自动检测
  const r = activeRemote();
  if (state.mode === 'remote' && r && r.host && r.user && !curEnv().env) {
    await detectEnv({ silent: true });
    await checkUpdate({ silent: true });
    const st = await window.piApi.serverState();
    state.servers.remotes[state.activeRemoteId] = { ...defaultServer(), ...st };
    renderServer();
  }
}

// 测试 SSH 连接(先保存表单,再由主进程连接验证)
async function testRemote() {
  if (restartBusy()) return;
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
  renderEnvState(); // 表单里的主机/用户可能指向了另一台服务器:旧检测结果作废
  fillProxyForm(); // 代理卡标题里的服务器随之刷新

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
  $('registryInput').value = cfg.registry || '';
  $('startupViewSelect').value = ['web', 'term'].includes(cfg.startupView) ? cfg.startupView : '';
  $('termThemeSelect').value = TERM_THEMES[cfg.termTheme] ? cfg.termTheme : 'auto';
  fillProxyForm();
  fillCodeServerForm();
  fillRemoteForm(activeRemote());
}

// code-server 配置卡跟随当前目标:本机一份(顶层 codeServerUrl)、每台远程一份(档案里的);
// 远程另有监听配置(端口/密码,存服务器上的 ~/.config/code-server/config.yaml),检测后填入
function fillCodeServerForm() {
  const isRemote = state.mode === 'remote';
  const r = activeRemote();
  const st = csStateOf();
  $('codeServerUrlInput').value = isRemote ? (r && r.codeServerUrl) || '' : state.cfg.codeServerUrl || '';
  $('csPortInput').value = st && st.port ? st.port : '';
  $('csPasswordInput').value = st && st.info && st.info.password ? st.info.password : '';
  $('codeServerScope').textContent = isRemote ? `· 远程 ${(r && r.host) || ''}` : '· 本机';
  $('csPortField').hidden = !isRemote;
  $('csPasswordField').hidden = !isRemote;
  $('csHint').textContent = isRemote
    ? '留空地址:本应用检测该服务器的监听端口并按需启动;填「主机:端口」仍由本应用管理,填反向代理等地址则按你填的打开、不代为启动。安装到 ~/.pi-web-desktop/code-server(免 root)。'
    : '本机优先用桌面版 VS Code 打开(见服务页「编辑器」按钮);此处地址留给本机自己跑的 code-server。';
  renderCodeServer();
}

// 保存配置:地址写进本应用配置(本机/该服务器的档案);远程再把端口/密码写到服务器的 config.yaml
async function saveCodeServer() {
  const url = $('codeServerUrlInput').value.trim();
  // 可省略协议(按 http);允许带子路径(反向代理);与主进程 lib/ipc.js 的解析保持一致
  if (url && !/^(https?:\/\/)?(\[[0-9a-f:]+\]|[a-z0-9._~%-]+)(:\d{1,5})?(\/[^\s]*)?$/i.test(url)) {
    toast('code-server 地址需形如 http://主机:端口', 'err');
    return;
  }
  const isRemote = state.mode === 'remote';
  const patch = isRemote ? { remote: { id: state.activeRemoteId, codeServerUrl: url } } : { codeServerUrl: url };
  const cfg = await window.piApi.setConfig(patch);
  state.cfg = cfg;
  state.remotes = cfg.remotes || [];
  if (isRemote) {
    const port = parseInt($('csPortInput').value, 10) || 0;
    const password = $('csPasswordInput').value;
    if (port || password) {
      if (port && !(port >= 1024 && port <= 65535)) {
        toast('监听端口需在 1024 - 65535 之间', 'err');
        return;
      }
      const r = await window.piApi.csSave({ target: curTarget(), port: port || 8080, password });
      if (!r.ok) {
        toast(`保存监听配置失败:${r.error}`, 'err');
        return;
      }
      if (r.conf && r.conf.password) $('csPasswordInput').value = r.conf.password; // 自动生成后回填
    }
  }
  toast('code-server 配置已保存', 'ok');
  await detectCodeServer({ silent: true });
}

/* ---------------- code-server 状态(每目标各一份,与 envs 同构) ---------------- */

const emptyCsState = () => ({ checking: false, loaded: false, managed: false, running: false, owned: false, base: '', port: '', info: null, error: '' });

function csStateOf(t = curTarget()) {
  if (t.mode === 'local') return state.cs.local || (state.cs.local = emptyCsState());
  let st = state.cs.remotes[t.remoteId];
  if (!st || st.identity !== t.identity) {
    st = { ...emptyCsState(), identity: t.identity };
    state.cs.remotes[t.remoteId] = st;
  }
  return st;
}

function setCsState(patch) {
  Object.assign(csStateOf(), patch);
  renderCodeServer();
}

async function detectCodeServer({ silent = false } = {}) {
  if (state.mode === 'local') {
    setCsState({ loaded: true, checking: false });
    return;
  }
  const t = curTarget();
  const st = csStateOf(t);
  if (st.checking) return;
  setCsState({ checking: true });
  if (!silent) setCsStatus('checking', '检测中…');
  try {
    const res = await window.piApi.csState({ target: t });
    // 按发起时的目标归档;档案连接身份变更后,旧结果作废。
    if (targetInfo(t.mode, t.remoteId).identity !== t.identity || state.cs.remotes[t.remoteId] !== st) return;
    Object.assign(st, res.ok ? {
      loaded: true,
      managed: res.managed,
      running: res.running,
      owned: res.owned,
      base: res.base || '',
      port: res.port || (res.info && res.info.bindPort) || '',
      info: res.info || null,
      error: '',
    } : { loaded: true, error: res.error || '检测失败' });
  } catch (err) {
    st.loaded = true;
    st.error = String((err && err.message) || err);
  } finally {
    st.checking = false;
    if (keyOf(curTarget()) === keyOf(t) && curTarget().identity === t.identity && csStateOf() === st) {
      renderCodeServer();
      if (!st.error) fillCodeServerForm();
    }
  }
}

// 状态徽标:文案原样写进 #csState,种类写进 data-state 供样式配色
// (local / checking / error / idle / custom / missing / running / external / stopped)
function setCsStatus(kind, text) {
  const el = $('csState');
  el.dataset.state = kind;
  el.textContent = text;
}

// 状态行 + 按钮可用性(只读渲染,不碰表单输入)
function renderCodeServer() {
  const st = csStateOf();
  const isRemote = state.mode === 'remote';
  if (!isRemote) {
    setCsStatus('local', '本机:按地址打开(优先 VS Code)');
    $('csInstallBtn').disabled = true;
    $('csStartBtn').disabled = true;
    $('csStopBtn').disabled = true;
    $('csOpenBtn').disabled = false;
    return;
  }
  const version = st.info && st.info.version ? ` · v${st.info.version}` : '';
  if (st.checking) {
    setCsStatus('checking', '检测中…');
  } else if (st.error) {
    setCsStatus('error', `检测失败:${st.error.slice(0, 60)}`);
  } else if (!st.loaded) {
    setCsStatus('idle', '未检测');
  } else if (!st.managed) {
    setCsStatus('custom', st.base ? `自管地址 ${st.base}` : '自管');
  } else if (!st.info || !st.info.installed) {
    setCsStatus('missing', '未安装');
  } else if (st.running) {
    setCsStatus(st.owned ? 'running' : 'external', `运行中 ${st.base}${st.owned ? '' : '(非本应用启动)'}${version}`);
  } else {
    setCsStatus('stopped', `已安装,未运行(端口 ${st.port || '?'})${version}`);
  }
  const installed = !!(st.info && st.info.installed);
  // 图标按钮:文案走原生 tooltip(与 Pi Web 卡的操作按钮保持一致)
  const installLabel = installed ? '更新' : '安装 / 更新';
  $('csInstallLabel').textContent = installLabel; // 按钮上的可见文字与 tooltip 一致
  $('csInstallBtn').disabled = st.checking || state.updating;
  $('csInstallBtn').title = installLabel;
  $('csInstallBtn').setAttribute('aria-label', installLabel);
  // 未安装时「安装」才是主操作(蓝底);已安装后主操作是「启动」,更新恢复普通样式
  $('csInstallBtn').classList.toggle('primary', !installed);
  $('csStartBtn').disabled = st.checking || !st.managed || !installed || st.running;
  $('csStopBtn').disabled = st.checking || !st.running;
  $('csOpenBtn').disabled = st.checking || (!st.base && !st.managed);
}

async function csInstall() {
  if (state.mode !== 'remote') {
    toast('本机不安装 code-server(优先用 VS Code)', 'err');
    return;
  }
  const st = csStateOf();
  const installed = !!(st.info && st.info.installed);
  const bin = (st.info && st.info.bin) || '';
  const systemBin = installed && /^\//.test(bin) && !/\.pi-web-desktop/.test(bin);
  const server = activeRemote();
  const target = server ? `${server.user}@${server.host}` : '该服务器';
  const downloadNote = '下载约 270MB，解压后约 740MB；安装到 ~/.pi-web-desktop/code-server，不修改系统包。';
  const confirmed = await confirmAction({
    title: installed ? '更新 code-server' : '安装 code-server',
    message: systemBin
      ? `${target} 使用系统安装的 code-server。本应用只会更新自己管理的副本。`
      : `${target} 上${installed ? '要更新' : '要安装'} code-server 吗？`,
    detail: systemBin
      ? '系统包及正在运行的服务不受影响；检测和启动仍优先使用系统包。' + downloadNote
      : installed ? `将替换本应用管理的副本。${downloadNote}` : `这是可选组件，不安装不影响其他功能。${downloadNote}`,
    action: systemBin ? '更新应用副本' : installed ? '更新' : '安装',
  });
  if (!confirmed) return;
  const r = await window.piApi.installCodeServer();
  if (r.ok) {
    toast(`code-server 安装完成(版本 ${r.version})`, 'ok');
    await detectCodeServer({ silent: true });
  }
}

async function csStart() {
  const st = csStateOf();
  // 启动前先注入监听配置:按卡上当前的端口/密码写服务器 config.yaml,再按新配置启动
  if (state.mode === 'remote' && st.managed) {
    const port = parseInt($('csPortInput').value, 10) || 0;
    const password = $('csPasswordInput').value;
    if (port && !(port >= 1024 && port <= 65535)) {
      toast('监听端口需在 1024 - 65535 之间', 'err');
      return;
    }
    if (port || password) {
      const s = await window.piApi.csSave({ target: curTarget(), port: port || 8080, password });
      if (!s.ok) {
        toast(`注入监听配置失败:${s.error}`, 'err');
        return;
      }
      if (s.conf && s.conf.password) $('csPasswordInput').value = s.conf.password;
      await detectCodeServer({ silent: true }); // 让本次启动用上刚写入的端口
    }
  }
  const r = await window.piApi.csStart({ target: curTarget() });
  if (r.ok) {
    toast(r.already ? 'code-server 已在运行' : `code-server 已启动:${r.url}`, 'ok');
    await detectCodeServer({ silent: true });
  } else if (r.needInstall) {
    toast('还没安装 code-server,先点「安装 / 更新」', 'err');
  } else {
    toast(`启动失败:${r.error}`, 'err', 6000);
  }
}

async function csStop() {
  const st = csStateOf();
  // 非本应用启动的实例:默认不代停,用户知情确认后强制结束(与 pi-web 外部实例同一策略)
  if (st.running && !st.owned) {
    const confirmed = await confirmAction({
      title: '强制结束 code-server',
      message: `该服务不是本应用启动的。仍要结束 ${targetLabel()}端口 ${st.port} 上的进程吗？`,
      detail: '请先保存正在编辑的内容。此操作会结束该端口上的 code-server。',
      action: '强制结束', danger: true,
    });
    if (!confirmed) return;
    const r = await window.piApi.csStop({ target: curTarget(), port: st.port, force: true });
    if (!r.ok) {
      toast(`停止失败:${r.error}`, 'err');
      return;
    }
    toast('已强制结束该端口上的 code-server', 'ok');
  } else {
    const r = await window.piApi.csStop({ target: curTarget(), port: st.port });
    if (!r.ok) {
      toast(`停止失败:${r.error}`, 'err');
      return;
    }
  }
  await detectCodeServer({ silent: true });
}

async function csOpen() {
  const r = await window.piApi.csOpen({ target: curTarget() });
  if (r.ok) return;
  if (r.needInstall) toast('还没安装 code-server,先点「安装 / 更新」', 'err');
  else toast(`打开失败:${r.error}`, 'err', 6000);
}

// 代理卡跟随当前目标:显示的是该目标自己的代理(本机一份、每个远程档案一份)。
// 只在切换目标/保存后调用 —— 不能放进 renderMode 之类的常规渲染,否则会冲掉正在编辑的表单
function fillProxyForm() {
  const p = proxyViewOf(currentTargetId());
  $('proxyProtoSelect').value = ['http', 'socks4', 'socks5'].includes(p.protocol) ? p.protocol : 'http';
  $('proxyHostInput').value = p.host || '';
  $('proxyPortInput').value = p.port || '';
  $('proxyBypassInput').value = p.bypass || '';
  const isRemote = state.mode === 'remote';
  const host = (activeRemote() || {}).host || '';
  $('proxyScope').textContent = isRemote ? `· 远程 ${host}` : '· 本机';
  $('proxyHint').textContent = isRemote
    ? `此处保存的是「${host || '该服务器'}」这台服务器自己的代理,启用/关闭用目标条上的盾形开关;在该服务器的 Pi Web 启动时注入,运行中的服务重启后生效。地址按该服务器的网络填写;填 127.0.0.1 表示用本机(运行本应用的电脑)上的代理,经 SSH 反向隧道送达。`
    : '此处保存的是本机自己的代理,启用/关闭用目标条上的盾形开关。本机 Pi Web 服务(127.0.0.1)始终不走代理;内嵌页面始终使用本机的这份代理。';
}

// 读取代理表单(协议下拉单行 + 不代理列表)
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
  // 代理只写进当前目标;registry 是所有目标共用的
  const cfg = await window.piApi.setConfig({
    ...proxyPatch(proxyForm),
    registry: $('registryInput').value.trim(),
  });
  state.cfg = cfg;
  state.remotes = cfg.remotes || [];
  renderMode();
  const running = curServer().running;
  toast(
    running ? '设置已保存;服务运行中,代理在下次启动服务时生效' : '设置已保存',
    running ? '' : 'ok'
  );
}

// 终端配置卡:终端主题 + 启动时打开(所有目标共用);主题对已打开的终端热切换
async function saveTermConfig() {
  const cfg = await window.piApi.setConfig({
    termTheme: TERM_THEMES[$('termThemeSelect').value] ? $('termThemeSelect').value : 'auto',
    startupView: ['web', 'term'].includes($('startupViewSelect').value) ? $('startupViewSelect').value : '',
  });
  state.cfg = cfg;
  state.remotes = cfg.remotes || [];
  if (termState.term) {
    try { termState.term.options.theme = termThemeOf(); } catch {}
  }
  toast('终端配置已保存', 'ok');
}

// 端口在 Tab 上改动即保存(change 触发);运行中自动重启
async function saveLocalPort() {
  if (restartBusy()) { $('portInput').value = state.cfg.port; return; }
  const port = parseInt($('portInput').value, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    toast('端口需在 1024 - 65535 之间', 'err');
    return;
  }
  const prev = state.cfg;
  const cfg = await window.piApi.setConfig({ port });
  state.cfg = cfg;
  renderServerUrl(); // 端口变了:服务地址那一行跟着变
  toast('端口已保存', 'ok');
  if (state.mode === 'local' && curServer().running && curServer().owned && prev && prev.port !== port) {
    restartAfterPortChange();
  }
}

async function saveRemotePort() {
  if (restartBusy()) { $('remoteSrvPortInput').value = activeRemote()?.remotePort || 30141; return; }
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
  renderServerUrl(); // 端口变了:服务地址那一行跟着变
  renderRemoteSelect();
  toast('端口已保存', 'ok');
  if (curServer().running && curServer().owned && prev && prev.remotePort !== p) {
    restartAfterPortChange();
  }
}

async function restartAfterPortChange() {
  toast('端口已变更,正在重启服务…');
  const stopped = await window.piApi.serverStop();
  if (stopped.error) {
    toast(stopped.error, 'err'); // 旧端口上的实例没停掉,不再叠启一个新实例
    renderServer();
    return;
  }
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
    if (e.key === 'Escape' && !$('confirmModal').hidden) return;
    if (e.key === 'Escape' && !$('logModal').hidden) closeLogModal();
    else if (e.key === 'Escape' && !$('remoteModal').hidden) closeServersModal();
    else if (e.key === 'Escape' && !$('termView').hidden) closeTerm();
  });
  $('remoteSelect').addEventListener('change', (e) => selectRemote(e.target.value));
  $('remoteAddBtn').addEventListener('click', addRemote);
  $('remoteDelBtn').addEventListener('click', () => delRemote());
  $('remoteAuthSelect').addEventListener('change', renderAuthFields);
  $('remoteTestBtn').addEventListener('click', testRemote);
  $('remoteSaveBtn').addEventListener('click', saveCurrentRemote);

  // 端口改动即保存(失焦/回车触发),运行中自动重启
  $('portInput').addEventListener('change', saveLocalPort);
  $('remoteSrvPortInput').addEventListener('change', saveRemotePort);
  $('startBtn').addEventListener('click', startServer);
  $('stopBtn').addEventListener('click', stopServer);
  $('restartBtn').addEventListener('click', restartServer);
  // 访问 = 服务运行中时探活后进入服务页(走 startServer 的「已在运行」分支);按钮仅在运行时可用
  $('openPageBtn').addEventListener('click', startServer);
  // 主机 / 端口输入框右侧的「复制」
  for (const b of document.querySelectorAll('.input-act[data-copy]')) {
    b.addEventListener('click', () => copyFieldValue(b.dataset.copy, b.dataset.what));
  }
  $('btnDefault').addEventListener('click', setDefaultTarget);
  $('proxyToggleBtn').addEventListener('click', toggleProxy);
  $('openBrowserBtn2').addEventListener('click', () => curServer().url && window.piApi.openExternal(curServer().url));
  $('refreshBtn').addEventListener('click', () => {
    const wv = $('wv');
    if (wv.getAttribute('src') !== 'about:blank') wv.reload();
  });
  $('openEditorBtn').addEventListener('click', openCurrentProjectInEditor);
  window.piApi.onCodeServerPassword(showCodeServerPassword);
  $('backBtn').addEventListener('click', showConsole);
  $('saveConfigBtn').addEventListener('click', saveConfig);

  // code-server 配置卡:重新检测、安装/更新、启停、打开、保存
  $('csRedetectBtn').addEventListener('click', () => detectCodeServer());
  $('csInstallBtn').addEventListener('click', csInstall);
  $('csStartBtn').addEventListener('click', csStart);
  $('csStopBtn').addEventListener('click', csStop);
  $('csOpenBtn').addEventListener('click', csOpen);
  $('csSaveBtn').addEventListener('click', saveCodeServer);
  $('termSaveBtn').addEventListener('click', saveTermConfig);

  // SSH 终端:入口/返回/重连 + 与 pi-web 服务页互切 + 会话输出与结束事件
  $('termOpenBtn').addEventListener('click', openTerm);
  $('termBackBtn').addEventListener('click', closeTerm);
  $('termReconnectBtn').addEventListener('click', reconnectTerm);
  $('termOverlayReconnect').addEventListener('click', reconnectTerm);
  $('webTermBtn').addEventListener('click', openTerm);
  $('termWebBtn').addEventListener('click', openWebFromTerm);
  window.piApi.onTermData((info) => {
    if (!termState.term || !info || info.id !== termState.id) return;
    // stream:true:跨数据块缓冲未收尾的多字节序列,中文输出不被截断
    termState.term.write(termState.decoder.decode(new Uint8Array(info.data), { stream: true }));
  });
  window.piApi.onTermExit((info) => {
    if (!info || info.id !== termState.id) return;
    termState.id = '';
    showTermDisconnected(info.reason === 'stopped' ? '会话已关闭' : 'SSH 连接已断开');
  });

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
    // payload = { target: 'pi-web' | 'pi' | 'code-server', line }
    const tag = { pi: '[pi] ', 'code-server': '[code-server] ' }[payload && payload.target] || '[Pi Web] ';
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
          : `Pi Web 服务已退出(code: ${info.code ?? '?'})`,
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
    toast(`Pi Web 已重新启动(更新后自动恢复)`, 'ok');
    tryStartupView(info); // 「启动时打开 Pi Web 服务页」:服务就绪后第一次自动进入
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

// 当前目标是否具备检测条件(远程需已填主机与用户名)
function canDetectTarget() {
  const r = activeRemote();
  return state.mode !== 'remote' || !!(r && r.host && r.user);
}

// 「启动时打开」:按配置自动进入 Pi Web 服务页 / SSH 终端。每次应用运行只自动打开一次;
// 用户已自己切去别的视图则不再打扰。web 在服务未就绪时等首次就绪(onServerStarted)再开
let startupViewOpened = false;
function tryStartupView(info) {
  const want = (state.cfg && state.cfg.startupView) || '';
  if (!want || startupViewOpened) return;
  if (want === 'term') {
    if (state.mode !== 'remote') return;
    if (!$('consoleView').hidden) {
      startupViewOpened = true;
      openTerm();
    }
    return;
  }
  if (want === 'web') {
    const url = (info && info.url) || curServer().url;
    if (url && !$('consoleView').hidden) {
      startupViewOpened = true;
      showWeb(url);
    }
  }
}

// 无边框窗口(Windows):系统标题栏已隐藏,最小化/最大化/关闭是叠加在右上角的原生按钮。
// 是否无边框由主进程决定(main.js 创建窗口时),随页面地址的 ?wco=1 带过来 —— 页面脚本一执行就能同步拿到,
// 第一帧的布局就是对的。(navigator.windowControlsOverlay.visible 在启动瞬间并不可靠:实测偶发为 false,稍后才变)
function applyWindowControls() {
  if (new URLSearchParams(location.search).get('wco') === '1') {
    document.body.classList.add('wco');
  }
}

async function init() {
  applyWindowControls(); // 先于首次渲染,顶栏高度与让位从第一帧起就正确
  bindEvents();

  const cfg = await window.piApi.getConfig();
  applyCfg(cfg);
  fillConfigForm(cfg);
  renderMode();
  renderRemoteSelect();
  renderProxyToggle();
  renderServer();

  if (canDetectTarget()) {
    await detectEnv({ silent: true });
    await checkUpdate({ silent: true });
  }
  if (state.mode === 'remote') detectCodeServer({ silent: true }); // code-server 卡状态(不阻塞启动)

  const stateRes = await window.piApi.serverState();
  if (state.mode === 'local') {
    state.servers.local = { ...defaultServer(), ...stateRes };
  } else {
    state.servers.remotes[state.activeRemoteId] = { ...defaultServer(), ...stateRes };
  }
  renderServer();

  // 启动检测期间用户已切走目标时,以切换后的目标为准:等它在途的检测完成,再决定是否自启
  await (pendingOf(detectInflight, curTarget()) || null);
  if (cfg.autoStart && curEnv().env && curEnv().env.piWeb.ok && !curServer().running && canDetectTarget()) {
    await startServer();
  }
  tryStartupView();
}
// updateLog 由 appendLog 维护于 state.updateLog

init();
