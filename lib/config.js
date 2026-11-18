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
  // 代理:单协议行(protocol: 'http'|'socks4'|'socks5';http 涵盖 https)+ 不代理列表。
  // 兼容字段(http/https/socks 行、旧 url)仅作迁移,由 lib/proxy.js 归一
  proxy: {
    enabled: false,
    protocol: 'http',
    host: '',
    port: 0,
    bypass: '',
    remote: true,
  },
  registry: '',
  port: 30141,
  autoStart: true,
  remotes: [], // [{ id, host, port, user, authType: 'key'|'password', password, keyPath, remotePort, hostFingerprint }]
  activeRemoteId: '',
};

let cached = null;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function normalizeRemotes(list) {
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

// 代理配置归一:保留旧形态字段(http/https/socks 行、url)以便 lib/proxy.js 迁移解析
function normalizeProxy(p) {
  const base = DEFAULTS.proxy;
  const src = p && typeof p === 'object' ? p : {};
  const out = { ...base, ...src };
  // 旧字段不在 DEFAULTS 里,若存在则原样保留(未定义时自然缺失)
  for (const k of ['http', 'https', 'socks', 'url']) {
    if (src[k] !== undefined) out[k] = src[k];
    else if (p && typeof p === 'object' && p[k] !== undefined) out[k] = p[k];
  }
  return out;
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
    remotes: normalizeRemotes(data && data.remotes),
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
  if (patch && patch.remotes !== undefined) next.remotes = normalizeRemotes(patch.remotes);
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
