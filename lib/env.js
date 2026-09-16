'use strict';

const fs = require('fs');
const path = require('path');
const { run, buildEnv, extractVersion } = require('./proc');

const PI_WEB_PKG = '@agegr/pi-web';
// pi 未安装时无法从全局包扫描中获得包名,回退到官方发行包
const PI_FALLBACK_PKG = '@earendil-works/pi-coding-agent';

let globalRootCache = null;

async function npmGlobalRoot(cfg) {
  if (globalRootCache) return globalRootCache;
  const { code, stdout, stderr } = await run('npm root -g', {
    env: buildEnv(cfg),
    timeoutMs: 20000,
  });
  if (code !== 0) {
    throw new Error(stderr.trim() || `npm root -g 退出码 ${code}`);
  }
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  globalRootCache = lines[lines.length - 1].trim();
  return globalRootCache;
}

// 直接读全局目录下包的 package.json,比 npm ls 快且稳定
async function globalPkgVersion(cfg, name) {
  try {
    const root = await npmGlobalRoot(cfg);
    const pkgFile = path.join(root, ...name.split('/'), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

async function installedPiWebVersion(cfg) {
  return globalPkgVersion(cfg, PI_WEB_PKG);
}

// 定位提供 pi 命令的全局包(扫描顶层全局包的 bin 字段),结果缓存
let piPkgCache;

async function resolvePiPackage(cfg) {
  if (piPkgCache !== undefined) return piPkgCache;
  try {
    const root = await npmGlobalRoot(cfg);
    const { code, stdout } = await run('npm ls -g --depth=0 --json', {
      env: buildEnv(cfg),
      timeoutMs: 30000,
    });
    if (code === 0) {
      const deps = JSON.parse(stdout).dependencies || {};
      for (const name of Object.keys(deps)) {
        if (name === 'npm' || name === 'corepack') continue;
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(root, ...name.split('/'), 'package.json'), 'utf8'));
          const binNames = typeof pkg.bin === 'string'
            ? [name.split('/').pop()]
            : Object.keys(pkg.bin || {});
          if (binNames.includes('pi')) {
            piPkgCache = { name, version: pkg.version || null };
            return piPkgCache;
          }
        } catch {}
      }
    }
  } catch {}
  // 扫描不到(通常是 pi 未安装)时回退官方包,让「一键安装」仍可执行
  piPkgCache = { name: PI_FALLBACK_PKG, version: null, fallback: true };
  return piPkgCache;
}

// 检测环境:node / npm / pi / pi-web
async function detect(cfg) {
  const env = buildEnv(cfg);
  const [node, npm, pi, piWeb] = await Promise.all([
    run('node -v', { env, timeoutMs: 15000 }),
    run('npm -v', { env, timeoutMs: 20000 }),
    run('pi --version', { env, timeoutMs: 20000 }),
    installedPiWebVersion(cfg),
  ]);

  const item = (res, fallbackText) => {
    const version = extractVersion(res.stdout + res.stderr) || fallbackText || null;
    return { version, ok: res.code === 0 && !!version, error: res.code === 0 ? null : (res.stderr || res.error || '').toString().trim().split(/\r?\n/)[0] || `退出码 ${res.code}` };
  };

  return {
    node: item(node),
    npm: item(npm),
    pi: item(pi),
    piWeb: { version: piWeb, ok: !!piWeb, error: piWeb ? null : '未检测到,请先安装或点击更新' },
  };
}

// 查询 npm registry 上某包的最新版本
async function latestVersion(cfg, pkg = PI_WEB_PKG) {
  const { code, stdout, stderr, error } = await run(`npm view ${pkg} version`, {
    env: buildEnv(cfg),
    timeoutMs: 45000,
  });
  const v = extractVersion(stdout + stderr);
  if (code !== 0 || !v) {
    throw new Error((stderr || (error && error.message) || '').toString().trim().split(/\r?\n/)[0] || `npm view 退出码 ${code}`);
  }
  return v;
}

module.exports = { detect, latestVersion, installedPiWebVersion, globalPkgVersion, resolvePiPackage, PI_WEB_PKG, PI_FALLBACK_PKG };
