'use strict';

// code-server 是可选组件:想用再装、点了才启动。只针对远程 Linux 服务器,本机目标只按配置的地址打开。
//
//   安装:官方独立发行包(GitHub Releases 上的 code-server-<版本>-linux-<架构>.tar.gz),解压到
//         ~/.pi-web-desktop/code-server —— 免 root、不碰系统包、卸载就是删目录。
//         不用 npm:code-server 的 npm 包里嵌套着整棵 node_modules,npm(尤其走镜像源)解包会失败,官方也不推荐。
//         下载沿用「那台服务器自己的代理设置」(内网机器直连 GitHub 常常不动),不行再试直连。
//   启动:点「code-server」按钮而它没在运行时才启动(与 pi-web 相同的后台方式),应用退出时回收;
//         已经在运行的(比如用户自己配的 systemd 服务)直接用,不去动它。
//         应用被强杀、安装器覆盖升级时不走正常退出,启动过的实例会留在服务器上:下次点按钮时认领回来,退出时一并回收。
//   登录:首次运行会自动生成 ~/.config/code-server/config.yaml(含随机密码);由本应用启动的实例把密码回显给用户。

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { exec, sshKeyOf } = require('./remote');
const proxy = require('./proxy');

const DIR = '~/.pi-web-desktop/code-server';
const BIN = `${DIR}/bin/code-server`;
const CONFIG_FILE = '~/.config/code-server/config.yaml';
// code-server 自己没配过监听地址时,本应用为它选定的端口记在这里(默认端口常被别的程序占着)
const PORT_FILE = '~/.pi-web-desktop/code-server-port';
const RELEASES = 'https://github.com/coder/code-server/releases';
const DEFAULT_PORT = 8080; // code-server 自身的默认端口
const DOWNLOAD_TIMEOUT = 20 * 60 * 1000;
const START_TIMEOUT = 40000;

const stateFile = (port, ext) => `~/.pi-web-desktop/code-server-${port}.${ext}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// 本次运行中由本应用启动的实例:退出时回收(key = SSH 目标 + 端口)。认领回来的上次遗留实例也在其中
const started = new Map();

/* ---------------- 地址 ---------------- */

// 规范化 code-server 地址:允许省略协议(按 http),去掉末尾斜杠;不是合法的 http(s) 地址则返回 null
function normalizeBase(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  // 写了协议但不是 http/https(如 ftp://)→ 无效,不能硬拼成 http://ftp://…
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  if (!scheme) s = `http://${s}`;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    return s.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

const loopback = (h) => /^localhost$/i.test(h) || /^127\./.test(h) || h === '::1';
const wildcard = (h) => h === '' || h === '0.0.0.0' || /^0:0:0:0:0:0:0:0$|^::0?$/.test(h);
const hostPart = (h) => (h.includes(':') ? `[${h}]` : h); // IPv6 字面量要加方括号

// bind-addr 的几种写法:0.0.0.0:8080 / 127.0.0.1:8080 / :8080 / 8080 / [::]:8080;没写则默认端口 8080
function parseBindAddr(value) {
  const bind = String(value || '').trim();
  if (/^\d+$/.test(bind)) return { host: '', port: bind };
  const m = bind.match(/^(\[.*?\]|[^:]*):(\d+)$/);
  return m ? { host: m[1].replace(/^\[|\]$/g, ''), port: m[2] } : { host: '', port: String(DEFAULT_PORT) };
}

const unquote = (v) => String(v || '').trim().replace(/^(["'])(.*)\1$/, '$2');

// 解析 code-server 的 config.yaml(只取用得到的几项)
function parseConfig(text) {
  const line = (key) => unquote((String(text || '').match(new RegExp(`^${key}:\\s*(.*)$`, 'm')) || [])[1]);
  const bind = parseBindAddr(line('bind-addr'));
  return {
    bindHost: bind.host,
    bindPort: bind.port,
    secure: /^true$/i.test(line('cert')),
    auth: line('auth'),
    password: line('password'),
  };
}

// 确认某个地址上跑的是 code-server。「端口有 HTTP 响应」不够:真实服务器上默认端口 8080 常被别的
// Web 程序占着,只看有没有响应会把别人的网站当成 code-server 打开。code-server 的两个特征:
//   /healthz → {"status":"alive",…};未登录时 /login 是标题为「code-server login」的登录页
async function isCodeServer(base) {
  const root = String(base).replace(/\/+$/, '');
  const get = (url, timeoutMs = 4000) => new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    try {
      const req = lib.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          if (body.length < 8192) body += d;
        });
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location || '', body }));
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
  const health = await get(`${root}/healthz`);
  if (health && health.status === 200 && /"status"\s*:\s*"alive"/.test(health.body)) return true;
  const login = await get(`${root}/login`);
  return !!(login && login.status === 200 && /<title>\s*code-server login\s*<\/title>/i.test(login.body));
}

// HTTP 探测:有响应(任何状态码)就算有服务在监听 —— 只是「有人在听」,不代表是 code-server
function reachable(base, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(base);
    } catch {
      resolve(false);
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    try {
      const req = lib.get(base, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

/* ---------------- 远程服务器上的检测 ---------------- */

// 本应用拉起 code-server 的启动行(与 start 的 nohup 命令一致):认领与回收都按它精确匹配
const launchSignature = (port) => `code-server --bind-addr 0.0.0.0:${port}`;

// 远程 shell 里的归属判定:本端口的 pid 文件里记的 PID 存活、且命令行确为本应用的启动行 → 是自己留下的实例,
// PID 写入 $OWNER(否则为 0)。两层都要:防 pid 文件过期后 PID 被别的进程复用造成误认领、误结束。
// clean:顺带清掉过期的 pid 文件(与 pi-web 的 ownerCheck 相同的做法)
function ownerCheck(port, { clean = false } = {}) {
  const ere = `([ /])${launchSignature(port).replace(/\./g, '\\.')}( |$)`;
  return (
    `F=$HOME/.pi-web-desktop/code-server-${port}.pid; OWNER=0; ` +
    `C=$(cat "$F" 2>/dev/null || true); case "$C" in ""|*[!0-9]*) C=0;; esac; A=""; ` +
    `if [ "$C" -gt 0 ] && kill -0 "$C" 2>/dev/null; then A=$(ps -o args= -p "$C" 2>/dev/null || true); fi; ` +
    `if printf '%s' "$A" | grep -Eq "${ere}"; then OWNER="$C"; fi; ` +
    (clean ? `[ "$OWNER" -gt 0 ] || rm -f "$F"; ` : '')
  );
}

// 一次 SSH 查看:装没装(系统装的,或本应用装在 ~/.pi-web-desktop 下的)、版本号、它的监听配置、
// 本应用为它选过的端口,以及上次没正常退出时留在服务器上的实例
// (pid 文件还在、记的进程也确是本应用启动的那个;过期的 pid 文件顺带清掉)
async function inspect(cfg) {
  const r = await exec(
    cfg,
    `B=$(command -v code-server 2>/dev/null || true); ` +
      `[ -n "$B" ] || { [ -x ${BIN} ] && B="$HOME/.pi-web-desktop/code-server/bin/code-server"; }; ` +
      `[ -n "$B" ] && echo "$B"; ` +
      `echo __PI_CS_VER__; [ -n "$B" ] && "$B" --version 2>/dev/null | head -n 2 || true; ` +
      `echo __PI_CS_APP_PORT__; cat ${PORT_FILE} 2>/dev/null || true; ` +
      `echo __PI_CS_CFG__; cat ${CONFIG_FILE} 2>/dev/null || true; ` +
      `echo __PI_CS_LIVE__; ` +
      `for F in $HOME/.pi-web-desktop/code-server-*.pid; do [ -e "$F" ] || continue; P=\${F##*/code-server-}; P=\${P%.pid}; ` +
      `${ownerCheck('$P', { clean: true })}[ "$OWNER" -gt 0 ] && echo "$P $OWNER"; done; true`,
    { timeoutMs: 20000 }
  );
  const [headPart = '', afterPort = ''] = String(r.stdout || '').split('__PI_CS_APP_PORT__');
  const [binText = '', verText = ''] = headPart.split('__PI_CS_VER__');
  const [appPortText = '', afterCfg = ''] = afterPort.split('__PI_CS_CFG__');
  const [cfgText = '', liveText = ''] = afterCfg.split('__PI_CS_LIVE__');
  // 登录 shell 可能先输出一些杂音:取最后一个非空行,且必须像个 code-server 路径
  const lines = binText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const found = lines.length ? lines[lines.length - 1] : '';
  const installed = /code-server/.test(found);
  // 版本号:--version 前两行里取第一个 x.y.z 形态
  const version = (verText.match(/(\d+\.\d+\.\d+)/) || [])[1] || '';
  const appPort = appPortText.trim();
  const conf = parseConfig(cfgText);
  // 登录 shell 的杂音同样可能落在这一段:只认「端口 PID」形态的行
  const orphans = liveText.split(/\r?\n/).filter((s) => /^\d+ \d+\s*$/.test(s)).map((s) => Number(s.trim().split(' ')[0]));
  // 「用户配过监听地址」指配置里写了非默认值:code-server 首次运行会自动生成 bind-addr: 127.0.0.1:8080,
  // 那不算用户的选择(本机也访问不到),端口照样可以由本应用选定并记下来
  const generated = (!conf.bindHost || loopback(conf.bindHost)) && Number(conf.bindPort) === DEFAULT_PORT;
  return {
    installed,
    bin: installed ? found : '',
    version,
    ...conf,
    configured: /^bind-addr:/m.test(cfgText) && !generated,
    appPort: /^\d+$/.test(appPort) ? appPort : '',
    orphans,
  };
}

// 解析当前目标的 code-server:
//   base     访问地址
//   managed  是否由本应用负责安装 / 按需启动(远程目标,且地址就是「那台服务器的某个端口」)
//   port     按需启动时用的端口
//   info     远程上的安装与监听配置(本机目标为 null)
// 临时顺延端口只影响运行态;配置仍保留用户选择的端口。只认远程复核后仍存活的本应用实例。
function runningPort(cfg, info, requestedPort) {
  const live = info.orphans || [];
  if (live.includes(requestedPort)) return requestedPort;
  for (const port of live) {
    const item = started.get(`${sshKeyOf(cfg)}:${port}`);
    if (item && item.requestedPort === requestedPort) return port;
  }
  return requestedPort;
}

async function resolveTarget(cfg) {
  const isRemote = !!(cfg && cfg.mode === 'remote' && cfg.remote);
  const own = String(((isRemote ? cfg.remote : cfg) || {}).codeServerUrl || '').trim();
  if (!isRemote) {
    const explicit = normalizeBase(own);
    return { base: explicit || `http://127.0.0.1:${DEFAULT_PORT}`, managed: false, port: DEFAULT_PORT, info: null, bin: '', explicit: !!explicit };
  }

  const info = await inspect(cfg);
  const bindHost = info.bindHost;
  // 监听在回环或任意接口上的,从本机访问都走该服务器的主机地址;绑定在指定网卡地址上的用那个地址
  const host = loopback(bindHost) || wildcard(bindHost) ? cfg.remote.host : bindHost;
  // code-server 自己没配过监听地址时,优先用本应用先前为它选定的端口(默认端口常被别的程序占着)
  const configuredPort = !info.configured && info.appPort ? Number(info.appPort) : Number(info.bindPort) || DEFAULT_PORT;
  // 自动地址也可复用上次异常退出留下的实例,其 PID/命令行已经由 inspect 校验。
  const chosenPort = runningPort(cfg, info, configuredPort);
  const autoPort = chosenPort === configuredPort && !info.orphans.includes(configuredPort)
    ? info.orphans[0] || chosenPort : chosenPort;
  const auto = `${info.secure ? 'https' : 'http'}://${hostPart(host)}:${autoPort}`;
  if (!own) return { base: auto, managed: true, port: autoPort, info, bin: info.bin, explicit: false };

  // 显式填了地址:只有「就是这台服务器的某个端口」才交给本应用安装/启动;带路径(反向代理后面)或别的域名按用户自管处理
  const base = normalizeBase(own);
  if (!base) throw new Error('服务器配置里填写的 code-server 地址无效');
  let u;
  try {
    u = new URL(base);
  } catch {
    u = null;
  }
  const managed = !!u && u.hostname === cfg.remote.host && (u.pathname === '/' || u.pathname === '');
  const explicitPort = u && u.port ? Number(u.port) : u && u.protocol === 'https:' ? 443 : 80;
  const port = managed ? runningPort(cfg, info, explicitPort) : Number(info.bindPort) || DEFAULT_PORT;
  if (managed && port !== explicitPort) u.port = String(port);
  return { base: managed ? u.href.replace(/\/$/, '') : base, managed, port, info, bin: info.bin, explicit: true };
}

/* ---------------- 安装(官方独立发行包,免 root) ---------------- */

// curl --progress-bar 的输出里挑出进度,每前进 ≥10% 报一行(一个数据块里可能带多个进度值,逐个看)
function progressReporter(onData) {
  let last = -10;
  return (chunk) => {
    for (const m of String(chunk).matchAll(/(\d+(?:\.\d+)?)%/g)) {
      const pct = Number(m[1]);
      if (pct - last >= 10 && pct < 100) {
        last = pct;
        onData(`下载中 ${pct}%\n`);
      }
    }
  };
}

async function install(cfg, { onData } = {}) {
  const log = (line) => onData && onData(line);
  const lastLine = (s) => String(s || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';

  const archMap = { x86_64: 'amd64', aarch64: 'arm64', arm64: 'arm64' };
  const machine = lastLine((await exec(cfg, 'uname -m', { timeoutMs: 20000 })).stdout);
  const arch = archMap[machine];
  if (!arch) throw new Error(`不支持的 CPU 架构 ${machine || '(未知)'}:目前只提供 linux-amd64 / linux-arm64 的 code-server`);

  // 磁盘空间:下载包约 270MB + 解压后约 740MB
  const free = Number((await exec(cfg, 'df -Pk "$HOME" | tail -n 1 | awk \'{print $4}\'', { timeoutMs: 20000 })).stdout.trim());
  if (Number.isFinite(free) && free < 1.2 * 1024 * 1024) {
    throw new Error(`该服务器磁盘空间不足(剩余约 ${Math.round(free / 1024)}MB,安装 code-server 需要约 1.2GB)`);
  }

  const viaProxy = await proxy.remoteEnvPrefix(cfg).catch(() => '');
  // 最新版本号:同样先走该服务器的代理(内网机器直连 GitHub 常常超时),不行再直连
  let version = '';
  let lookupError = '';
  for (const prefix of viaProxy ? [viaProxy, ''] : ['']) {
    try {
      const latest = await exec(cfg, `${prefix}curl -fsSLI -o /dev/null -w '%{url_effective}' --max-time 25 ${RELEASES}/latest`, { timeoutMs: 45000 });
      version = ((latest.stdout || '').match(/\/tag\/v(\d+\.\d+\.\d+)/) || [])[1] || '';
      if (version) break;
    } catch (err) {
      lookupError = err.message;
    }
  }
  if (!version) throw new Error(`没能获取 code-server 的最新版本号(该服务器访问 github.com 失败?${lookupError ? ` ${lookupError}` : ''})`);

  const file = `code-server-${version}-linux-${arch}.tar.gz`;
  const tmp = `/tmp/${file}`;
  const url = `${RELEASES}/download/v${version}/${file}`;
  log(`$ ssh ${cfg.remote.user}@${cfg.remote.host} → 下载 ${url}\n`);

  // 先走该服务器的代理设置(没配就不走),不行再换另一条。限速保护:60 秒内不足 1KB/s 就放弃,避免卡死
  const attempts = viaProxy ? [['经该服务器的代理', viaProxy], ['直连', '']] : [['直连', '']];
  const errors = [];
  let downloaded = false;
  for (const [label, prefix] of attempts) {
    log(`# 下载(${label})…\n`);
    try {
      await exec(
        cfg,
        `${prefix}curl -fL --progress-bar --connect-timeout 20 --speed-limit 1024 --speed-time 60 -o ${tmp} ${quote(url)}`,
        { timeoutMs: DOWNLOAD_TIMEOUT, onData: progressReporter(log) }
      );
      downloaded = true;
      break;
    } catch (err) {
      errors.push(`${label}:${err.message}`);
      log(`# ${errors[errors.length - 1]}\n`);
    }
  }
  if (!downloaded) {
    throw new Error(`下载 code-server 失败(${errors.join(';')})。请确认该服务器能访问 github.com,或在它的代理设置里配一个可用代理`);
  }
  log('# 下载完成,解压到 ~/.pi-web-desktop/code-server …\n');
  await exec(
    cfg,
    `mkdir -p ~/.pi-web-desktop && tar -C ~/.pi-web-desktop -xzf ${tmp} && ` +
      `rm -rf ${DIR} && mv ~/.pi-web-desktop/code-server-${version}-linux-${arch} ${DIR} && rm -f ${tmp}`,
    { timeoutMs: 300000 }
  );
  return { ok: true, version, bin: BIN };
}

/* ---------------- 按需启动 / 退出回收 ---------------- */

async function readConfig(cfg) {
  const r = await exec(cfg, `cat ${CONFIG_FILE} 2>/dev/null || true`, { timeoutMs: 20000 });
  return parseConfig(r.stdout);
}

// 服务器上第一个空闲的端口:从想用的端口起依次顺延(真实服务器上默认端口常被别的程序占着)
async function pickFreePort(cfg, want) {
  const candidates = [];
  for (let p = Math.max(1024, want); p < Math.min(want + 60, 65536); p++) candidates.push(p);
  const r = await exec(
    cfg,
    `for p in ${candidates.join(' ')}; do ss -ltn 2>/dev/null | grep -qE ":$p( |$)" || { echo $p; break; }; done`,
    { timeoutMs: 20000 }
  );
  const picked = Number(String(r.stdout || '').trim().split(/\r?\n/).pop());
  return picked >= 1024 && picked < 65536 ? picked : want;
}

// 启动后等它可访问,返回实际使用的地址 { url, port }。登录密码不在这里取:由调用方在窗口真的落到登录页时再读
async function start(cfg, target, { onData, timeoutMs = START_TIMEOUT } = {}) {
  let { port } = target;
  // 想用的端口被别的程序占着就顺延到第一个空闲端口。code-server 自己没配过监听地址时,把选定的端口记下来
  // 下次还用它;用户自己配过的只在这一次临时顺延(不改它的配置文件)
  const free = await pickFreePort(cfg, port).catch(() => port);
  if (free !== port) {
    if (target.info && !target.info.configured) {
      await exec(cfg, `mkdir -p ~/.pi-web-desktop; echo ${free} > ${PORT_FILE}`, { timeoutMs: 20000 }).catch(() => {});
    }
    if (onData) onData(`# 端口 ${port} 已被占用,改用 ${free}\n`);
    port = free;
  }
  // 本应用管理的地址就是「主机:端口」,不带路径
  const endpoint = new URL(target.base);
  endpoint.port = String(port);
  const base = endpoint.href.replace(/\/$/, '');
  // 出站流量沿用该服务器的代理设置(装扩展、连市场时用得上)
  const proxyPrefix = await proxy.remoteEnvPrefix(cfg).catch(() => '');
  // 检测得到的 bin 是绝对路径,加引号防特殊字符;兜底的默认路径带 ~(不能加引号,否则不展开),且不含空格
  const binCmd = target.bin ? quote(target.bin) : BIN;
  await exec(
    cfg,
    `mkdir -p ~/.pi-web-desktop; ` +
      // 只后台化 nohup 这一条简单命令并把重定向挂在它身上(与 pi-web 相同:复合命令放后台会让 SSH 通道挂住)
      `${proxyPrefix}nohup ${binCmd} --bind-addr 0.0.0.0:${port} >> ${stateFile(port, 'log')} 2>&1 < /dev/null & ` +
      `echo $! > ${stateFile(port, 'pid')}`,
    { timeoutMs: 20000 }
  );
  started.set(`${sshKeyOf(cfg)}:${port}`, { cfg, port, requestedPort: target.port });
  if (onData) onData(`# code-server 已启动:${base}\n`);

  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    if (await isCodeServer(base)) return { url: base, port };
    await sleep(1000);
  }
  const tail = await exec(cfg, `tail -n 8 ${stateFile(port, 'log')} 2>/dev/null`, { timeoutMs: 20000 }).catch(() => ({ stdout: '' }));
  started.delete(`${sshKeyOf(cfg)}:${port}`);
  throw new Error(
    `code-server 启动了,但本机访问不到 ${base}(端口可能被占用,或防火墙未放行)。` +
      `服务器上的日志:\n${String(tail.stdout || '').trim().split(/\r?\n/).slice(-4).join('\n') || '(空)'}`
  );
}

// 应用被强杀、安装器覆盖升级时不走正常退出,按需启动的 code-server 会留在服务器上。下次点按钮时按 pid 文件认领回来
// (PID 存活且命令行确为本应用的启动行,见 inspect),退出时一并回收 —— 与 pi-web 的孤儿认领相同
function adopt(cfg, info) {
  for (const port of (info && info.orphans) || []) {
    const key = `${sshKeyOf(cfg)}:${port}`;
    started.set(key, { ...started.get(key), cfg, port });
  }
}

// 应用退出时回收本应用启动的实例;用户自己的服务不在其中,不会被动。
// 结束前按 pid 文件复核归属:不直接 kill 文件里的数字 —— 过期的 pid 文件里,PID 可能已被别的进程复用
async function stopAll() {
  const items = [...started.values()];
  started.clear();
  await Promise.all(
    items.map(({ cfg, port }) =>
      exec(cfg, `${ownerCheck(port)}[ "$OWNER" -gt 0 ] && kill "$OWNER"; rm -f ${stateFile(port, 'pid')}`, { timeoutMs: 15000 }).catch(() => {})
    )
  );
}

/* ---------------- 配置卡:写监听配置 / 按目标停止 ---------------- */

// 某台服务器上由本应用启动(或认领)的实例端口列表
function startedFor(cfg) {
  const prefix = `${sshKeyOf(cfg)}:`;
  return [...started.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v.port);
}

// 写 ~/.config/code-server/config.yaml:bind-addr 0.0.0.0:<port>(本应用启动一律监听任意网卡,webview 直连)
// 与 auth/password 放到文件头部,其余行(cert 等)原样保留。
// 密码永不缺失:显式给了就用;留空则沿用服务器上已有的;再没有就随机生成 ——
// code-server 4.x 在 auth 缺失时直接拒绝启动("Please pass in a password via the config file or environment
// variable"),自动生成只发生在首次创建配置文件时。返回写后的配置(含生效密码,供卡上回填)
async function writeConfig(cfg, { port, password } = {}) {
  const p = Math.floor(Number(port));
  if (!(p >= 1024 && p < 65536)) throw new Error('监听端口需在 1024 - 65535 之间');
  let pw = String(password || '');
  if (!pw) {
    const cur = await readConfig(cfg).catch(() => ({ password: '' }));
    pw = cur.password || crypto.randomBytes(9).toString('base64url');
  }
  const r = await exec(
    cfg,
    `mkdir -p ~/.config/code-server; F=~/.config/code-server/config.yaml; touch "$F"; ` +
      `sed -i '/^bind-addr:/d;/^auth:/d;/^password:/d' "$F"; ` +
      `{ echo bind-addr: 0.0.0.0:${p}; echo auth: password; printf 'password: %s\\n' ${quote(pw)}; cat "$F"; } > "$F.new" && mv "$F.new" "$F" && cat "$F"`,
    { timeoutMs: 20000 }
  );
  return parseConfig(r.stdout);
}

// 停止该服务器上的 code-server:先结束本应用启动/认领的实例(按 pid 复核归属);
// force=true(用户已在确认框知情)再宽匹配结束该端口上的一切 code-server 监听进程 —— 与 pi-web 的强制结束同一惯用法
async function stop(cfg, { port, force = false } = {}) {
  const prefix = `${sshKeyOf(cfg)}:`;
  const items = [...started.entries()].filter(([k]) => k.startsWith(prefix));
  for (const [k, { cfg: c, port: p }] of items) {
    started.delete(k);
    await exec(c, `${ownerCheck(p)}[ "$OWNER" -gt 0 ] && kill "$OWNER"; rm -f ${stateFile(p, 'pid')}`, { timeoutMs: 15000 }).catch(() => {});
  }
  if (force && port) {
    const broad = `code-[s]erver .*--bind-addr 0.0.0.0:${port}( |$)`;
    await exec(
      cfg,
      `pkill -f "${broad}" 2>/dev/null || true; ` +
        `if command -v fuser >/dev/null 2>&1; then fuser -k ${port}/tcp 2>/dev/null; ` +
        `elif command -v lsof >/dev/null 2>&1; then lsof -t -i :${port} 2>/dev/null | xargs -r kill 2>/dev/null; fi; rm -f ${stateFile(port, 'pid')}; true`,
      { timeoutMs: 20000 }
    ).catch(() => {});
  }
  return { ok: true, ours: items.length };
}

module.exports = { normalizeBase, parseBindAddr, parseConfig, reachable, isCodeServer, inspect, resolveTarget, install, start, stop, stopAll, adopt, readConfig, writeConfig, startedFor, DEFAULT_PORT, DIR, BIN };
