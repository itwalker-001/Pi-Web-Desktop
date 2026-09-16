'use strict';

const { spawn, execSync } = require('child_process');

// 为子进程(npm / pi-web)构建环境变量:注入代理与 npm registry
function buildEnv(cfg) {
  const env = { ...process.env };
  const proxy = cfg && cfg.proxy;
  if (proxy && proxy.enabled && proxy.url) {
    const p = proxy.url.trim();
    env.HTTP_PROXY = p;
    env.HTTPS_PROXY = p;
    env.http_proxy = p;
    env.https_proxy = p;
    // 本地 pi-web 服务不走代理
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
    env.no_proxy = 'localhost,127.0.0.1,::1';
    // Node 原生环境代理(24.x)不支持 socks 协议,会导致 npm / pi 子进程启动即崩;
    // 关闭原生处理,npm 用自带的 socks 代理实现读取 HTTP_PROXY 即可
    if (/^socks/i.test(p)) {
      env.NODE_USE_ENV_PROXY = '0';
    }
  }
  if (cfg && cfg.registry && String(cfg.registry).trim()) {
    env.npm_config_registry = String(cfg.registry).trim();
  }
  return env;
}

// 执行 shell 命令,流式回调输出,返回 { code, stdout, stderr, error }
function run(command, { env, cwd, timeoutMs = 60000, onData } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, { shell: true, env, cwd, windowsHide: true });

    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            killTree(child);
          } catch {}
        }, timeoutMs)
      : null;

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, error: error || null });
    };

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onData) onData(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onData) onData(s);
    });
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code, null));
  });
}

// Windows 下 shell 包了一层 cmd,需要按进程树整体结束
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true });
    } catch {}
  } else {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
}

// 从任意输出中提取 x.y.z 版本号
function extractVersion(text) {
  const m = String(text || '').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return m ? m[0] : null;
}

// 比较语义化版本:a>b 返回 1,a<b 返回 -1,相等返回 0
function compareSemver(a, b) {
  const pa = String(a || '0').split(/[-+]/)[0].split('.').map(Number);
  const pb = String(b || '0').split(/[-+]/)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

module.exports = { buildEnv, run, killTree, extractVersion, compareSemver };
