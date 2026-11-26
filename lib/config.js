'use strict';

// 配置持久化(userData/config.json)。
// 远程服务器支持多个档案:remotes 数组 + activeRemoteId 指向当前操作的档案;
// get() 额外提供计算属性 remote = 当前激活的档案,下游模块(remote.js 等)无需感知多档案。

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  mode: 'local', // 'local' | 'remote'
  // 应用启动模式:'last' 跟随上次 | 'local' 固定本地 | 'remote' 固定远程(配合 defaultRemoteId)
  defaultMode: 'last',
  defaultRemoteId: '',
  // 本机(本地目标)的代理:单协议行(protocol: 'http'|'socks4'|'socks5';http 涵盖 https)+ 不代理列表。
  // 每台远程服务器各有一份,存在各自的档案里(remotes[i].proxy),互不相干。
  // 兼容字段(http/https/socks 行、旧 url)仅作迁移,由 lib/proxy.js 归一
  proxy: {
    enabled: false,
    protocol: 'http',
    host: '',
    port: 0,
    bypass: '',
  },
  registry: '',
  port: 30141,
  autoStart: true,
  // 启动时自动打开哪个全屏视图:''=停在控制台 / 'web'=Pi Web 服务页 / 'term'=SSH 终端(仅远程)
  startupView: '',
  // SSH 终端主题:'auto'=跟随应用色板;其余预设见 renderer/app.js 的 TERM_THEMES(所有目标共用)
  termTheme: 'auto',
  // SSH 终端会话(所有目标共用;改动对新开的会话生效,已在运行的会话不变)
  termShiftEnter: true, // Shift+Enter 发「输入框内换行」序列(Esc+CR):Claude Code 这类程序据此换行而不是提交
  termProxy: true,      // 会话继承该服务器「代理设置」里的代理(与 Pi Web 启动时注入的是同一份)
  termTmux: false,      // 断线保活:会话放进服务器上的 tmux,断线 / 离开终端后程序继续运行(需服务器已装 tmux)
  // 本机的 code-server 地址(可选):留空则按默认端口 8080;每台远程服务器也各有一个(remotes[i].codeServerUrl)
  codeServerUrl: '',
  // [{ id, host, port, user, authType: 'key'|'password', password, keyPath, remotePort, hostFingerprint, proxy, codeServerUrl }]
  remotes: [],
  activeRemoteId: '',
};

let cached = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// 代理配置归一:保留旧形态字段(http/https/socks 行、url)以便 lib/proxy.js 迁移解析。
// 旧的「远程模式也使用」开关(proxy.remote)随全局代理一起取消,不再保留
function normalizeProxy(p) {
  const base = DEFAULTS.proxy;
  const src = p && typeof p === 'object' ? p : {};
  const out = { ...base, ...src };
  delete out.remote;
  // 旧字段不在 DEFAULTS 里,若存在则原样保留(未定义时自然缺失)
  for (const k of ['http', 'https', 'socks', 'url']) {
    if (src[k] !== undefined) out[k] = src[k];
    else if (p && typeof p === 'object' && p[k] !== undefined) out[k] = p[k];
  }
  return out;
}

// 旧版只有全局一份代理,由 proxy.remote 决定远程模式是否沿用。升级后每个远程档案各持一份:
// 旧版档案(没有自己的 proxy 字段)沿用当时全局代理的地址,启用状态跟随那个开关 —— 行为不变。
// 开关从原始配置里读:normalizeProxy 已把它去掉
function legacyRemoteProxy(globalProxy) {
  const usedByRemote = !globalProxy || typeof globalProxy !== 'object' || globalProxy.remote !== false;
  const { enabled, ...address } = normalizeProxy(globalProxy);
  return normalizeProxy({ ...address, enabled: !!enabled && usedByRemote });
}

// legacyProxy:档案缺少自己的 proxy 时采用的默认值(读取旧配置时取全局代理的迁移结果)
function normalizeRemotes(list, legacyProxy) {
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && typeof r === 'object').map((r, i) => ({
    id: String(r.id !== undefined ? r.id : `r${i}`),
    host: String(r.host || '').trim(),
    port: Number(r.port) || 22,
    user: String(r.user || '').trim(),
    authType: r.authType === 'password' ? 'password' : 'key',
    password: String(r.password || ''),
    keyPath: String(r.keyPath || '').trim(),
    remotePort: Number(r.remotePort) || 30141,
    hostFingerprint: String(r.hostFingerprint || '').trim(),
    proxy: r.proxy !== undefined ? normalizeProxy(r.proxy) : normalizeProxy(legacyProxy()),
    codeServerUrl: String(r.codeServerUrl || '').trim(),
  }));
}

// 旧版单档案 remote 对象 → 迁移为 remotes[0]
function migrateLegacy(data) {
  if (data && data.remote && typeof data.remote === 'object' && (!Array.isArray(data.remotes) || !data.remotes.length)) {
    data = { ...data, remotes: [{ id: 'r-legacy', ...data.remote }], activeRemoteId: 'r-legacy' };
  }
  return data;
}

function activeProfileOf(stored) {
  const remotes = stored.remotes || [];
  const id = remotes.some((r) => r.id === stored.activeRemoteId) ? stored.activeRemoteId : (remotes[0] && remotes[0].id) || '';
  const profile = remotes.find((r) => r.id === id) || null;
  return { activeRemoteId: id, remote: profile };
}

function load() {
  if (cached) return cached;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {}
  data = migrateLegacy(data);
  const stored = {
    ...DEFAULTS,
    ...data,
    proxy: normalizeProxy(data && data.proxy),
    remotes: normalizeRemotes(data && data.remotes, () => legacyRemoteProxy(data && data.proxy)),
    activeRemoteId: String((data && data.activeRemoteId) || ''),
  };
  const { activeRemoteId, remote } = activeProfileOf(stored);
  stored.activeRemoteId = activeRemoteId;
  cached = { ...stored, remote };
  return cached;
}

function save(patch) {
  const prev = load();
  const next = { ...prev };

  // 多档案整体更新(渲染层)
  if (patch && patch.remotes !== undefined) next.remotes = normalizeRemotes(patch.remotes, () => legacyRemoteProxy(prev.proxy));
  if (patch && patch.activeRemoteId !== undefined) next.activeRemoteId = String(patch.activeRemoteId);

  // 单档案补丁(TOFU 指纹写入等):按 id 定位,缺省改当前激活档案
  if (patch && patch.remote && typeof patch.remote === 'object') {
    const targetId = patch.remote.id !== undefined ? String(patch.remote.id) : next.activeRemoteId;
    next.remotes = next.remotes.map((p) => (p.id === targetId ? { ...p, ...patch.remote, id: p.id } : p));
  }

  next.proxy = normalizeProxy({ ...prev.proxy, ...((patch && patch.proxy) || {}) });
  for (const k of Object.keys(patch || {})) {
    if (!['proxy', 'remote', 'remotes', 'activeRemoteId'].includes(k)) next[k] = patch[k];
  }

  const { activeRemoteId, remote } = activeProfileOf(next);
  next.activeRemoteId = activeRemoteId;

  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  // 持久化时去掉计算属性 remote,避免与 remotes 冗余存储
  const { remote: _drop, ...persist } = next;
  fs.writeFileSync(configPath(), JSON.stringify(persist, null, 2), 'utf8');
  cached = { ...next, remote };
  return cached;
}

function get() {
  return load();
}

module.exports = { get, save, DEFAULTS };
