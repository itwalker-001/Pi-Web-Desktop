'use strict';

// 远程模式的环境检测与版本查询(镜像 lib/env.js 的语义,命令经 SSH 在远程执行)。
// npm 全局包信息用一段 node 脚本在远程一次性采集(脚本经 stdin 传入,免引号转义),
// 输出包裹在 __PI_JSON_BEGIN__/__PI_JSON_END__ 标记里,登录 shell 的杂音不会干扰解析。

const { exec, execScript } = require('./remote');
const { extractVersion } = require('./proc');

const PI_WEB_PKG = '@agegr/pi-web';
const PI_FALLBACK_PKG = '@earendil-works/pi-coding-agent';

// 在远程 node 里跑的全局包采集脚本(对齐 env.js 的 resolvePiPackage 扫描逻辑)
const GLOBAL_INFO_SCRIPT = `
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
function out(obj) {
  console.log('__PI_JSON_BEGIN__');
  console.log(JSON.stringify(obj));
  console.log('__PI_JSON_END__');
}
try {
  const root = execSync('npm root -g', { encoding: 'utf8', timeout: 20000 }).trim().split(/\\r?\\n/).pop();
  const result = { npmRoot: root, piWebVersion: null, piPkg: null };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, '@agegr', 'pi-web', 'package.json'), 'utf8'));
    result.piWebVersion = pkg.version || null;
  } catch (e) {}
  try {
    const names = fs.readdirSync(root).flatMap((n) => {
      if (n.startsWith('@')) {
        try { return fs.readdirSync(path.join(root, n)).map((m) => n + '/' + m); } catch (e) { return []; }
      }
      return [n];
    });
    for (const name of names) {
      if (name === 'npm' || name === 'corepack') continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, ...name.split('/'), 'package.json'), 'utf8'));
        const binNames = typeof pkg.bin === 'string' ? [name.split('/').pop()] : Object.keys(pkg.bin || {});
        if (binNames.includes('pi')) { result.piPkg = { name: name, version: pkg.version || null }; break; }
      } catch (e) {}
    }
  } catch (e) {}
  out(result);
} catch (err) {
  out({ error: String((err && err.message) || err) });
}
`;

// 采集结果缓存:按服务器(主机:SSH 端口:用户)各存一份 —— 各台机器的全局包互不相干,先检测的那台
// 的结果不能被其余服务器复用。值存 Promise:同一台机器的并发请求合并为一次采集;失败即剔除,可重试。
// 远程 npm 安装后需 clearCache()
const globalInfoCache = new Map();

function cacheKey(cfg) {
  const r = (cfg && cfg.remote) || {};
  return `${String(r.host || '').trim()}:${Number(r.port) || 22}:${String(r.user || '').trim()}`;
}

async function fetchGlobalInfo(cfg) {
  const { code, value, stderr } = await execScript(cfg, GLOBAL_INFO_SCRIPT, { timeoutMs: 45000 });
  if (!value) {
    throw new Error(
      (stderr || '').trim().split(/\r?\n/)[0] ||
      (code !== 0 ? `远程全局包采集失败(退出码 ${code})` : '远程全局包采集失败:未能解析输出')
    );
  }
  if (value.error) throw new Error(`远程 npm 全局目录获取失败:${value.error}`);
  return value;
}

function globalInfo(cfg) {
  const key = cacheKey(cfg);
  let p = globalInfoCache.get(key);
  if (!p) {
    p = fetchGlobalInfo(cfg).catch((err) => {
      globalInfoCache.delete(key); // 失败不留缓存,下次重试
      throw err;
    });
    globalInfoCache.set(key, p);
  }
  return p;
}

// 不带 cfg 清空全部(如一键安装后);带 cfg 只清该服务器的
function clearCache(cfg) {
  if (cfg) globalInfoCache.delete(cacheKey(cfg));
  else globalInfoCache.clear();
}

async function installedPiWebVersion(cfg) {
  try {
    const info = await globalInfo(cfg);
    return info.piWebVersion || null;
  } catch {
    return null;
  }
}

async function globalPkgVersion(cfg, name) {
  const info = await globalInfo(cfg);
  if (name === PI_WEB_PKG) return info.piWebVersion || null;
  if (info.piPkg && info.piPkg.name === name) return info.piPkg.version || null;
  return null;
}

// 定位提供 pi 命令的全局包;扫描不到时回退官方包(对齐本地 env.js)
async function resolvePiPackage(cfg) {
  try {
    const info = await globalInfo(cfg);
    if (info.piPkg && info.piPkg.name) return info.piPkg;
  } catch {}
  return { name: PI_FALLBACK_PKG, version: null, fallback: true };
}

// 远程环境检测:node / npm / pi / pi-web,输出结构与本地 detect() 完全一致
async function detect(cfg) {
  const item = (res, fallbackText) => {
    const version = extractVersion(res.stdout + res.stderr) || fallbackText || null;
    return {
      version,
      ok: res.code === 0 && !!version,
      error: res.code === 0 ? null : (res.stderr || res.error || '').toString().trim().split(/\r?\n/)[0] || `退出码 ${res.code}`,
    };
  };

  const [node, npm, pi] = await Promise.all([
    exec(cfg, 'node -v', { timeoutMs: 20000 }).catch((err) => ({ code: 1, stdout: '', stderr: String(err.message || err), error: err })),
    exec(cfg, 'npm -v', { timeoutMs: 30000 }).catch((err) => ({ code: 1, stdout: '', stderr: String(err.message || err), error: err })),
    exec(cfg, 'pi --version', { timeoutMs: 30000 }).catch((err) => ({ code: 1, stdout: '', stderr: String(err.message || err), error: err })),
  ]);

  let piWeb = { version: null, ok: false, error: '未检测到,请先安装或点击更新' };
  // node 不在时采集脚本必然失败,直接给出 node 缺失提示(注意:用 item() 归一后的结果判断)
  const nodeItem = item(node);
  if (nodeItem.ok) {
    try {
      const v = await installedPiWebVersion(cfg);
      piWeb = v ? { version: v, ok: true, error: null } : piWeb;
    } catch (err) {
      piWeb = { version: null, ok: false, error: String((err && err.message) || err) };
    }
  } else {
    piWeb = { version: null, ok: false, error: '远程未检测到 Node.js,无法查询 pi-web' };
  }

  return { node: nodeItem, npm: item(npm), pi: item(pi), piWeb };
}

// 查询 npm registry 上某包的最新版本(在远程执行,走远程机器自身网络;
// 代理仅注入 pi-web 启动,npm 命令不注入;cfg.registry 镜像源会传递给远程 npm)
async function latestVersion(cfg, pkg = PI_WEB_PKG) {
  const registry = cfg && cfg.registry && String(cfg.registry).trim();
  const registryPrefix = registry ? `npm_config_registry=${quote(registry)} ` : '';
  const { code, stdout, stderr } = await exec(cfg, `${registryPrefix}npm view ${quote(pkg)} version`, { timeoutMs: 60000 });
  const v = extractVersion(stdout + stderr);
  if (code !== 0 || !v) {
    throw new Error((stderr || '').trim().split(/\r?\n/)[0] || `npm view 退出码 ${code}`);
  }
  return v;
}

// 远程一键安装/更新命令(registry 镜像源传递,包名经 shell 转义;不注入代理)
async function npmInstallCommand(cfg, pkg) {
  const registry = cfg && cfg.registry && String(cfg.registry).trim();
  const registryPrefix = registry ? `npm_config_registry=${quote(registry)} ` : '';
  return `${registryPrefix}npm install -g ${quote(pkg)}@latest`;
}

// shell 单引号转义(与 lib/remote.js 保持一致的规则)
function quote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

module.exports = {
  detect,
  latestVersion,
  npmInstallCommand,
  installedPiWebVersion,
  globalPkgVersion,
  resolvePiPackage,
  clearCache,
  PI_WEB_PKG,
  PI_FALLBACK_PKG,
  GLOBAL_INFO_SCRIPT, // 导出供测试:本地用 node 直接执行验证输出格式
};
