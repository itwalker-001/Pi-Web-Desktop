'use strict';

// SSH 连接层:基于 ssh2(纯 JS),负责远程命令执行、本地端口转发隧道与主机指纹校验(TOFU)。
// 支持多台远程服务器:按 host:port:user 维护连接注册表,同一目标复用一条连接,
// 不同目标各自独立连接;exec 等接口按 cfg 里的 remote 档案自动路由。

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

// key('host:port:user') → { conn, connecting, revPort, revTarget, tcpHooked }
const connections = new Map();
const disconnectHandlers = [];

function remoteCfg(cfg) {
  const r = (cfg && cfg.remote) || {};
  return {
    id: r.id !== undefined ? String(r.id) : undefined,
    host: String(r.host || '').trim(),
    port: Number(r.port) || 22,
    user: String(r.user || '').trim(),
    authType: r.authType === 'password' ? 'password' : 'key',
    password: String(r.password || ''),
    keyPath: String(r.keyPath || '').trim(),
    hostFingerprint: String(r.hostFingerprint || '').trim(),
  };
}

// SSH 连接标识(不含 remotePort:同目标共享一条连接)
function sshKey(r) {
  return `${r.host}:${r.port}:${r.user}`;
}

function sshKeyOf(cfg) {
  return sshKey(remoteCfg(cfg));
}

// 配置完整性检查(不发起网络请求)
function validate(cfg) {
  const r = remoteCfg(cfg);
  if (!r.host) throw new Error('远程模式未配置主机地址');
  if (!r.user) throw new Error('远程模式未配置用户名');
  if (!(r.port > 0 && r.port < 65536)) throw new Error('SSH 端口不合法');
  return r;
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 定位私钥:配置路径优先,否则按惯例尝试 id_rsa / id_ed25519
function resolveKeyFile(r) {
  const candidates = r.keyPath
    ? [expandHome(r.keyPath)]
    : [path.join(os.homedir(), '.ssh', 'id_rsa'), path.join(os.homedir(), '.ssh', 'id_ed25519')];
  for (const p of candidates) {
    try {
      fs.accessSync(p);
      return p;
    } catch {}
  }
  throw new Error(
    r.keyPath
      ? `未找到私钥文件:${r.keyPath}(请检查路径)`
      : '未找到 SSH 私钥(默认查找 ~/.ssh/id_rsa、~/.ssh/id_ed25519,可在远程设置中指定路径)'
  );
}

// ssh2 错误 → 用户可读的中文提示(认证失败提示按认证方式区分)
function friendlyError(err, r) {
  const msg = String((err && err.message) || err || '');
  const code = (err && err.code) || '';
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) {
    return new Error('无法连接到远程主机:连接被拒绝,请检查主机地址与 SSH 端口');
  }
  if (code === 'ENOTFOUND' || /ENOTFOUND|could not resolve/i.test(msg)) {
    return new Error('远程主机地址无法解析,请检查主机名是否正确');
  }
  if (code === 'ETIMEDOUT' || /ETIMEDOUT|timed? ?out/i.test(msg)) {
    return new Error('连接远程主机超时,请检查网络与防火墙');
  }
  if (code === 'EHOSTUNREACH' || /EHOSTUNREACH|ECONNRESET/i.test(msg)) {
    return new Error('远程主机不可达或连接被重置');
  }
  if (/All configured authentication methods failed/i.test(msg)) {
    if (r && r.authType === 'password') {
      return new Error('SSH 认证失败:用户名或密码不正确(或服务器禁止密码登录,仅允许密钥)');
    }
    return new Error('SSH 认证失败:请确认私钥已配置免密登录(公钥需加入远程 ~/.ssh/authorized_keys)');
  }
  if (/Cannot parse privateKey|Invalid private key/i.test(msg)) {
    return new Error('私钥文件无法解析:格式不受支持或已加密(本应用仅支持免密私钥)');
  }
  if (/Host denied|host key verification|KEY_EXCHANGE_FAILED.*[Hh]ost/i.test(msg)) {
    return new Error('主机指纹校验失败:远程服务器密钥与上次记录不一致,请确认环境安全');
  }
  return new Error(msg || 'SSH 连接失败');
}

// 建立(或复用)SSH 连接;同一 host:port:user 只连一次,配置变化自动重连
function ensureConnected(cfg) {
  const r = validate(cfg);
  const key = sshKey(r);
  let entry = connections.get(key);
  if (entry && entry.conn) return Promise.resolve(entry.conn);
  if (entry && entry.connecting) return entry.connecting;

  entry = entry || {};
  connections.set(key, entry);

  const p = new Promise((resolve, reject) => {
    // 认证材料:密码 或 私钥(按档案 authType 二选一)
    let privateKey = null;
    if (r.authType === 'password') {
      if (!r.password) {
        reject(new Error('未填写 SSH 密码,请在远程连接配置中填写'));
        return;
      }
    } else {
      const keyFile = resolveKeyFile(r);
      try {
        privateKey = fs.readFileSync(keyFile);
      } catch (e) {
        reject(new Error(`读取私钥失败:${e.message}`));
        return;
      }
    }

    const c = new Client();
    let settled = false;
    let handshakeFp = '';

    // 部分服务器禁用直接密码认证、只开 keyboard-interactive:这里一并兜底
    c.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
      try {
        finish(prompts.map(() => r.password || ''));
      } catch {}
    });

    c.on('ready', () => {
      if (settled) return;
      settled = true;
      entry.conn = c;
      entry.connecting = null;
      // TOFU:首次连接记录指纹并持久化,供后续连接校验
      if (handshakeFp && handshakeFp !== r.hostFingerprint) {
        try {
          require('./config').save({ remote: { id: r.id, hostFingerprint: handshakeFp } });
        } catch {}
      }
      resolve(c);
    });
    c.on('error', (err) => {
      const fe = friendlyError(err, r);
      if (!settled) {
        settled = true;
        entry.connecting = null;
        try { c.end(); } catch {}
        reject(fe);
      }
      // 已就绪后的异常(网络抖动等):交给 close 统一清理
    });
    c.on('close', () => {
      const wasReady = entry.conn === c;
      if (wasReady) {
        entry.conn = null;
        // 反向隧道的远程监听随连接消失而失效
        entry.revPort = 0;
        entry.revTarget = null;
        for (const cb of disconnectHandlers) {
          try { cb(key); } catch {}
        }
      }
      if (entry.connecting) entry.connecting = null;
    });

    c.connect({
      host: r.host,
      port: r.port,
      username: r.user,
      privateKey: privateKey || undefined,
      // 密码认证:password + keyboard-interactive 双通道(私钥认证时为 undefined)
      password: r.authType === 'password' ? r.password : undefined,
      tryKeyboard: r.authType === 'password',
      readyTimeout: 15000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      // TOFU:首次连接记录指纹;之后必须匹配,不匹配直接拒绝(防中间人)
      hostHash: 'sha256',
      hostVerifier: (hex) => {
        handshakeFp = String(hex);
        if (!r.hostFingerprint) return true;
        return handshakeFp === r.hostFingerprint;
      },
    });
  });
  entry.connecting = p;
  p.catch(() => {
    if (entry.connecting === p) entry.connecting = null;
  });
  return p;
}

// shell 单引号转义:值包进 '…',内部 ' → '\''
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// 远程执行命令(经 bash -ilc 包装(交互+登录),确保写在 ~/.bashrc 的 nvm 等 PATH 生效 —— .bashrc 常带「非交互直接 return」守卫,纯 -lc 加载不到)
// host/user 等只进 ssh2 API,绝不拼进 shell;命令参数全部经 shellQuote。
async function exec(cfg, command, { timeoutMs = 60000, onData } = {}) {
  const c = await ensureConnected(cfg);
  const wrapped = `bash -ilc ${shellQuote(command)}`;
  return new Promise((resolve, reject) => {
    c.exec(wrapped, (err, stream) => {
      if (err) return reject(friendlyError(err));
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            try { stream.close(); } catch {}
          }, timeoutMs)
        : null;

      stream.on('data', (d) => {
        const s = d.toString();
        stdout += s;
        if (onData) onData(s);
      });
      stream.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        if (onData) onData(s);
      });
      stream.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`远程命令超时(${Math.round(timeoutMs / 1000)}s):${command.slice(0, 80)}`));
          return;
        }
        // bash 交互模式(-i)在无 tty 下会输出两条固定告警,属正常噪音,过滤之
        stderr = stderr.replace(/^bash: (cannot set terminal process group|no job control)[^\n]*\n?/gm, '');
        resolve({ code, stdout, stderr, timedOut: false });
      });
    });
  });
}

// 在远程 node 里执行一段脚本(脚本经 stdin 传入,规避引号转义问题)。
// 脚本需把结果打印在 __PI_JSON_BEGIN__ / __PI_JSON_END__ 标记之间,
// 以免疫登录 shell profile 可能输出的杂音。返回 { code, value, stdout, stderr }。
async function execScript(cfg, script, { timeoutMs = 60000 } = {}) {
  const c = await ensureConnected(cfg);
  return new Promise((resolve, reject) => {
    c.exec('bash -ilc node', (err, stream) => {
      if (err) return reject(friendlyError(err));
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            try { stream.close(); } catch {}
          }, timeoutMs)
        : null;

      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`远程脚本执行超时(${Math.round(timeoutMs / 1000)}s)`));
          return;
        }
        let value = null;
        const m = stdout.match(/__PI_JSON_BEGIN__\r?\n([\s\S]*?)\r?\n?__PI_JSON_END__/);
        if (m) {
          try { value = JSON.parse(m[1]); } catch {}
        }
        resolve({ code, value, stdout, stderr });
      });

      stream.end(script);
    });
  });
}

// 连接测试:验证可达性 + 私钥认证 + 返回主机指纹
async function testConnection(cfg) {
  const r = validate(cfg);
  await exec(cfg, 'echo ok', { timeoutMs: 20000 });
  let stored = '';
  try {
    const cur = require('./config').get();
    const profile = (cur.remotes || []).find((p) => p.id === r.id) || cur.remote;
    stored = (profile && profile.hostFingerprint) || '';
  } catch {
    stored = r.hostFingerprint || ''; // 无 electron 环境(纯 node 测试)时用入参
  }
  return { ok: true, fingerprint: stored };
}

/* ---------------- SSH 反向隧道(把本机代理送达远程) ---------------- */

// 在远程 127.0.0.1 上开监听端口,转发回本机的 host:port(即 `ssh -R`,对服务器零侵入)。
// 用于远程模式注入代理:远程命令的环境变量指向 127.0.0.1:<返回端口>,流量经 SSH 回到本机代理。
// 同一连接按目标复用;目标变化时先撤销旧的再重建。固定端口段优先(17890 起),冲突自动顺延。
async function ensureReverseTunnel(cfg, { host, port }) {
  const c = await ensureConnected(cfg);
  const key = sshKeyOf(cfg);
  const entry = connections.get(key);

  if (entry.revPort && entry.revTarget && entry.revTarget.host === host && entry.revTarget.port === port) {
    return entry.revPort;
  }
  if (entry.revPort) {
    try { c.unforwardIn('127.0.0.1', entry.revPort); } catch {}
    entry.revPort = 0;
  }

  if (!entry.tcpHooked) {
    entry.tcpHooked = true;
    c.on('tcp', (info, accept) => {
      const target = entry.revTarget;
      if (!target) {
        try { accept().end(); } catch {}
        return;
      }
      const socket = accept();
      const local = net.connect(target.port, target.host);
      socket.pipe(local);
      local.pipe(socket);
      socket.on('error', () => { try { local.destroy(); } catch {} });
      local.on('error', () => { try { socket.destroy(); } catch {} });
    });
  }
  entry.revTarget = { host, port };

  const candidates = [17890, 17891, 17892, 17893, 17894, 17895, 17896, 17897, 17898, 17899, 0];
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const want = candidates.shift();
      if (want === undefined) {
        reject(new Error('SSH 反向隧道建立失败:远程端口均被占用'));
        return;
      }
      c.forwardIn('127.0.0.1', want, (err, assigned) => {
        if (!err) {
          entry.revPort = assigned || want;
          resolve(entry.revPort);
          return;
        }
        if (candidates.length) attempt();
        else reject(new Error(`SSH 反向隧道建立失败:${err.message || err}`));
      });
    };
    attempt();
  });
}

function isConnected(cfg) {
  if (!cfg) return connections.size > 0;
  try {
    const entry = connections.get(sshKeyOf(cfg));
    return !!(entry && entry.conn);
  } catch {
    return false;
  }
}

// 注册连接意外断开回调(参数为断开连接的 key,即 'host:port:user');触发后不移除
function onDisconnect(cb) {
  disconnectHandlers.push(cb);
}

// 断开连接:带 cfg 只断该档案(并关其隧道),不带则断开全部
function disconnect(cfg) {
  const drop = (key) => {
    const entry = connections.get(key);
    if (!entry) return;
    if (entry.tunnelServer) {
      try { entry.tunnelServer.close(); } catch {}
    }
    if (entry.conn) {
      try { entry.conn.end(); } catch {}
    }
    connections.delete(key);
  };
  if (cfg) {
    try {
      drop(sshKeyOf(cfg));
    } catch {}
  } else {
    for (const key of [...connections.keys()]) drop(key);
  }
}

module.exports = {
  exec,
  execScript,
  testConnection,
  ensureReverseTunnel,
  isConnected,
  onDisconnect,
  disconnect,
  validate,
  sshKeyOf,
};
