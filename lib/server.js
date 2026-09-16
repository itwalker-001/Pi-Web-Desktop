'use strict';

const http = require('http');
const { spawn } = require('child_process');
const { buildEnv, killTree } = require('./proc');

let child = null;        // 本应用启动的 pi-web 子进程(带 shell)
let external = false;    // 端口上已有外部启动的 pi-web 实例
let intentionalStop = false;
let lastUrl = '';

function serverUrl(cfg) {
  return `http://127.0.0.1:${(cfg && cfg.port) || 30141}/`;
}

function isRunning() {
  return !!child || external;
}

// 本应用是否拥有服务进程(外部实例无法由我们停止)
function isOwned() {
  return !!child;
}

function state() {
  return { running: isRunning(), owned: isOwned(), external, url: lastUrl };
}

// 探测本地 HTTP 服务是否可达
function probe(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// 轮询本地端口,直到 pi-web 的 HTTP 服务可访问
function waitForReady(cfg, timeoutMs = 30000) {
  const target = serverUrl(cfg);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      probe(target).then((ok) => {
        if (ok) {
          resolve();
        } else if (Date.now() - startedAt > timeoutMs) {
          reject(new Error('启动超时:pi-web 服务未在预期时间内响应,请查看服务日志'));
        } else {
          setTimeout(attempt, 500);
        }
      });
    };
    attempt();
  });
}

async function start(cfg, { onLog, onExit } = {}) {
  const url = serverUrl(cfg);
  lastUrl = url;
  if (child) return { url, alreadyRunning: true };

  // 端口已被占用:视为外部 pi-web 实例,直接复用(内嵌展示,不支持由本应用停止)
  if (await probe(url)) {
    external = true;
    return { url, alreadyRunning: true, external: true };
  }

  external = false;
  intentionalStop = false;
  const port = (cfg && cfg.port) || 30141;
  const command = `pi-web --no-open --hostname 127.0.0.1 --port ${port}`;

  return new Promise((resolve, reject) => {
    if (onLog) onLog(`$ ${command}\n`);
    const c = spawn(command, { shell: true, env: buildEnv(cfg), windowsHide: true });
    child = c;

    c.stdout.on('data', (d) => onLog && onLog(d.toString()));
    c.stderr.on('data', (d) => onLog && onLog(d.toString()));
    c.on('error', (err) => {
      if (child === c) child = null;
      reject(err);
    });
    c.on('exit', (code) => {
      if (child === c) child = null;
      if (onExit) onExit({ code, intentional: intentionalStop });
    });

    waitForReady(cfg)
      .then(() => resolve({ url }))
      .catch((err) => {
        killTree(c);
        reject(err);
      });
  });
}

// 应用启动/页面初始化时检测:默认端口上是否已有(外部启动的)pi-web 在运行
async function refreshExternal(cfg) {
  if (child) return state();
  const url = serverUrl(cfg);
  lastUrl = url;
  external = await probe(url);
  return state();
}

function stop() {
  // 外部实例不属于本应用,不能替用户结束进程
  if (external && !child) {
    return { external: true };
  }
  if (!child) return { stopped: true };
  intentionalStop = true;
  const c = child;
  child = null;
  killTree(c);
  external = false;
  return { stopped: true };
}

module.exports = { start, stop, probe, serverUrl, isRunning, isOwned, state, refreshExternal };
