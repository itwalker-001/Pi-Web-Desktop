'use strict';

// 代理模块:每份配置 = 协议(HTTP/HTTPS/SOCKS4/SOCKS5)+ 不代理地址列表(通配符/网段),
// 为三类出口产出配置:
//   1) sessionConfig  → Electron session.setProxy(proxyRules + proxyBypassRules),内嵌页面
//   2) childEnv       → 本地子进程环境变量(HTTP(S)_PROXY / ALL_PROXY / NO_PROXY,系统指令)
//   3) remoteEnvPrefix→ 远程命令的环境变量前缀(同为系统指令)
//
// 代理按目标各配一份(不是全局一份):
//   本机(本地目标) → config.json 顶层 proxy
//   每台远程服务器  → 各自档案里的 remotes[i].proxy
// 本机子进程、内嵌页面用本机那份;远程 pi-web 启动注入用那台服务器自己的那份。
//
// 每份代理的配置结构:
//   {
//     enabled: false,
//     protocol: 'http' | 'socks4' | 'socks5',   // http 涵盖 https
//     host: '', port: 0,
//     bypass: '127.0.0.1\n::1\n192.168.0.0/16\n*.internal.example.com',
//   }
// 旧版形态(分协议表 { http, https, socks } / 单一地址 { url })在解析时自动归一到协议行。

const isLoopbackHost = (h) => /^(localhost|127\.|0\.0\.0\.0$|::1$)/i.test(String(h || ''));

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function rowOf(o) {
  const host = String((o && o.host) || '').trim();
  const port = Number((o && o.port) || 0);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

// 取某个目标的代理配置。缺省按 cfg 的模式取:远程模式 = 激活档案(cfg.remote)自己的那份,
// 否则 = 本机的顶层 proxy。target = 'local' 强制取本机那份(内嵌页面的请求总是从本机发出)
function proxyConfigOf(cfg, target) {
  if (target !== 'local' && cfg && cfg.mode === 'remote' && cfg.remote) {
    return cfg.remote.proxy || {};
  }
  return (cfg && cfg.proxy) || {};
}

// 解析代理配置。兼容三代形态,统一归一为分协议行:
//   1) 新版:{ protocol:'http'|'socks4'|'socks5', host, port }  (UI 协议下拉写入)
//   2) 旧版分协议表:{ http:{host,port}, https:{...}, socks:{host,port,version} }
//   3) 更早:{ url:'socks5://h:p' }
function parseProxy(cfg, target) {
  const p = proxyConfigOf(cfg, target);
  let http = rowOf(p.http);
  let https = rowOf(p.https);
  let socks = rowOf(p.socks);
  let socksVersion = Number(p.socks && p.socks.version) === 4 ? 4 : 5;

  // 新版协议下拉:http/https 同源填两行,socks 填 SOCKS 行
  const proto = String(p.protocol || '').toLowerCase();
  const protoRow = rowOf({ host: p.host, port: p.port });
  if (protoRow && (proto === 'http' || proto === 'socks4' || proto === 'socks5')) {
    if (proto === 'http') {
      http = protoRow;
      https = protoRow;
    } else {
      socks = protoRow;
      socksVersion = proto === 'socks4' ? 4 : 5;
    }
  }

  // 旧版单一地址 → 填入对应行(http/https 地址同时填两行,socks 地址填 SOCKS 行)
  if (!http && !https && !socks && p.url) {
    const m = String(p.url).trim().match(/^(https?|socks4a?|socks5h?):\/\/([^/:]+)(?::(\d+))?\/?$/i);
    if (m) {
      const scheme = m[1].toLowerCase();
      const target = { host: m[2], port: Number(m[3]) || (/^https?$/.test(scheme) ? 80 : 1080) };
      if (/^https?$/.test(scheme)) {
        http = target;
        https = target;
      } else {
        socks = target;
        socksVersion = scheme.includes('4') ? 4 : 5;
      }
    }
  }

  // 不代理列表:本地/远程服务自身永远直连,合并进默认项
  const bypassList = [
    ...new Set(
      String(p.bypass || '')
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .concat(['127.0.0.1', '::1', 'localhost'])
    ),
  ];

  const primary = http
    ? { scheme: 'http', host: http.host, port: http.port }
    : https
      ? { scheme: 'http', host: https.host, port: https.port }
      : socks
        ? { scheme: socksVersion === 4 ? 'socks4' : 'socks5', host: socks.host, port: socks.port }
        : null;

  return {
    enabled: !!p.enabled && !!primary,
    entries: { http, https, socks, socksVersion },
    bypassList,
    bypass: String(p.bypass || ''), // 原始不代理列表(界面回显用)
    primary,
    primaryUrl: primary ? `${primary.scheme}://${primary.host}:${primary.port}` : '',
    // 新版 UI 的单行形态(协议下拉):http/https 归为 'http'
    protocol: primary ? (primary.scheme === 'socks4' ? 'socks4' : primary.scheme === 'socks5' ? 'socks5' : 'http') : 'http',
    host: primary ? primary.host : '',
    port: primary ? primary.port : 0,
  };
}

// bypass 条目 → Chromium proxyBypassRules(不支持 CIDR,过滤之;<local> 覆盖无点主机名)
function bypassToChromium(list) {
  const out = [];
  for (const item of list) {
    if (!item || item === '*') continue;
    if (item.includes('/')) continue; // CIDR 网段 Chromium 不支持
    out.push(item);
  }
  out.push('<local>');
  return out.join(',');
}

// bypass 条目 → 环境变量 NO_PROXY(curl/npm 语义:后缀匹配;支持 CIDR 与 *)
function bypassToEnv(list) {
  const out = [];
  for (const item of list) {
    if (!item) continue;
    if (item === '*') {
      out.push('*');
      continue;
    }
    if (item.includes('/')) {
      out.push(item); // CIDR(curl ≥ 7.86 / 部分 npm 版本支持)
      continue;
    }
    // '*.foo.com' / '*foo.com' → 'foo.com'(NO_PROXY 后缀匹配已含子域)
    out.push(item.replace(/^\*\.?/, ''));
  }
  return out;
}

/* ---------------- 出口 1:Electron session(内嵌页面) ---------------- */

// 内嵌页面的请求总是从本机发出,所以无论当前目标是本机还是哪台远程,页面都用「本机」那份代理
function sessionConfig(cfg) {
  const px = parseProxy(cfg, 'local');
  if (!px.enabled) return { mode: 'system' };
  const e = px.entries;
  const parts = [];
  if (e.http) parts.push(`http=${e.http.host}:${e.http.port}`);
  if (e.https) parts.push(`https=${e.https.host}:${e.https.port}`);
  if (e.socks) parts.push(`${px.entries.socksVersion === 4 ? 'socks4' : 'socks'}=${e.socks.host}:${e.socks.port}`);
  if (!parts.length) return { mode: 'system' };
  // 远程服务页直连访问(不走代理):已配置的远程服务器主机自动加入不代理列表
  const bypass = [...px.bypassList];
  for (const r of (cfg && cfg.remotes) || []) {
    if (r && r.host && !bypass.includes(r.host)) bypass.push(r.host);
  }
  return {
    proxyRules: parts.join(';'),
    proxyBypassRules: bypassToChromium(bypass),
  };
}

/* ---------------- 出口 2:本地子进程环境变量 ---------------- */

function childEnv(cfg, base = process.env) {
  const env = { ...base };
  const px = parseProxy(cfg);
  if (!px.enabled) return env;
  const { http, https, socks, socksVersion } = px.entries;

  if (http) {
    env.HTTP_PROXY = env.http_proxy = `http://${http.host}:${http.port}`;
  }
  if (https) {
    env.HTTPS_PROXY = env.https_proxy = `http://${https.host}:${https.port}`;
  }
  if (socks) {
    const u = `${socksVersion === 4 ? 'socks4' : 'socks5'}://${socks.host}:${socks.port}`;
    env.ALL_PROXY = env.all_proxy = u;
    // 未单独配置 http/https 代理时,让 HTTP(S)_PROXY 也指向 socks(npm 主要读这两个变量)
    if (!http) env.HTTP_PROXY = env.http_proxy = u;
    if (!https) env.HTTPS_PROXY = env.https_proxy = u;
    // Node 24 原生环境代理不支持 socks 协议,关掉避免 npm / pi 子进程启动即崩
    if (!http && !https) env.NODE_USE_ENV_PROXY = '0';
  }
  const noProxy = bypassToEnv(px.bypassList).join(',');
  env.NO_PROXY = env.no_proxy = noProxy;
  return env;
}

/* ---------------- 出口 3:远程命令环境变量前缀 ---------------- */

// 生成远程命令的代理环境变量前缀(如 http_proxy='..' https_proxy='..' no_proxy='..' )。
// 用的是这台服务器(cfg.remote)自己的代理;地址按该服务器的视角填写、直接可达。
// 例外:地址是本机回环(127.0.0.1/localhost)时视为「运行本应用的电脑上的代理」,经 SSH 反向隧道
// 送达:resolveTunnel 返回远程侧监听端口,环境变量指向 127.0.0.1:<该端口>(对服务器零侵入,断开 SSH 即失效)。
// opts.resolveTunnel 可注入(测试用),缺省使用 lib/remote.js 的 ensureReverseTunnel。
async function remoteEnvPrefix(cfg, opts = {}) {
  const px = parseProxy(cfg);
  if (!px.enabled || !px.primary) return '';

  let { scheme, host, port } = px.primary;
  if (isLoopbackHost(host)) {
    // 注意不能写成 const 再赋值:实际运行时不传 opts,那样会在这一行抛
    // 「Assignment to constant variable」,而调用处会把它吞掉 → 远程 pi-web 不带代理静默启动
    const ensure = typeof opts.resolveTunnel === 'function' ? opts.resolveTunnel : require('./remote').ensureReverseTunnel;
    const remotePort = await ensure(cfg, { host, port });
    host = '127.0.0.1';
    port = remotePort;
  }

  const url = `${scheme}://${host}:${port}`;
  const noProxy = bypassToEnv(px.bypassList).join(',');
  return (
    `http_proxy=${shellQuote(url)} https_proxy=${shellQuote(url)} all_proxy=${shellQuote(url)} ` +
    `HTTP_PROXY=${shellQuote(url)} HTTPS_PROXY=${shellQuote(url)} ALL_PROXY=${shellQuote(url)} ` +
    `no_proxy=${shellQuote(noProxy)} NO_PROXY=${shellQuote(noProxy)} `
  );
}

// 供 UI / 文档展示:远程模式代理的实际走向
async function describeRemoteChain(cfg, opts = {}) {
  const px = parseProxy(cfg);
  if (!px.enabled || !px.primary) {
    return { via: 'direct', url: '' };
  }
  if (isLoopbackHost(px.primary.host)) {
    const ensure = opts.resolveTunnel || require('./remote').ensureReverseTunnel;
    try {
      const port = await ensure(cfg, { host: px.primary.host, port: px.primary.port });
      return { via: 'tunnel', url: `${px.primary.scheme}://127.0.0.1:${port}` };
    } catch {
      return { via: 'error', url: `${px.primary.scheme}://127.0.0.1:?(隧道建立失败)` };
    }
  }
  return { via: 'direct', url: px.primaryUrl };
}

module.exports = {
  parseProxy,
  proxyConfigOf,
  sessionConfig,
  childEnv,
  remoteEnvPrefix,
  describeRemoteChain,
  bypassToChromium,
  bypassToEnv,
};
