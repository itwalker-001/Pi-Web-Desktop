'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { buildEnv, killTree } = require('./proc');

let child = null;        // 本应用启动的 pi-web 子进程(带 shell)
let external = false;    // 端口上已有外部启动的 pi-web 实例
let intentionalStop = false;
let lastUrl = '';
let adoptedPid = 0;      // 孤儿回收:上次会话拉起、应用被强杀后遗留的进程 PID
let lastCfg = null;

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

/* ---------------- 孤儿回收(pidfile) ---------------- */
// 应用被强杀(taskkill/崩溃)时,正常关闭清理不会执行,本应用拉起的 pi-web 会遗留。
// 拉起成功时把 {pid, port} 写入 userData/pi-web.pid;下次会话发现端口被占时,
// 若 pid 仍存活且命令行确为 pi-web,则识别为「自己上次拉起的」并回收为可停止状态。

function pidFile() {
  try {
    const { app } = require('electron');
    return path.join(app.getPath('userData'), 'pi-web.pid');
  } catch {
    return null; // 纯 node 测试环境:不启用
  }
}

function writePid(pid, cfg) {
  const f = pidFile();
  if (!f) return;
  try {
    fs.writeFileSync(f, JSON.stringify({ pid, port: (cfg && cfg.port) || 30141 }));
  } catch {}
}

function clearPid() {
  const f = pidFile();
  if (!f) return;
  try { fs.unlinkSync(f); } catch {}
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Windows 下确认 PID 的命令行包含 pi-web(防 PID 复用误杀)
function pidIsPiWeb(pid) {
  if (process.platform !== 'win32') return true;
  try {
    const out = execSync(
      `powershell.exe -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    );
    return /pi-web/i.test(out);
  } catch {
    return false;
  }
}

// 尝试把端口上的占用者识别为自己遗留的孤儿;成功则回收为 owned
function tryAdoptOrphan(cfg) {
  const f = pidFile();
  if (!f) return false;
  let info;
  try {
    info = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return false;
  }
  if (!info || !Number.isInteger(info.pid) || info.pid <= 0) return false;
  if (info.port !== ((cfg && cfg.port) || 30141)) return false;
  if (!pidAlive(info.pid) || !pidIsPiWeb(info.pid)) {
    clearPid();
    return false;
  }
  adoptedPid = info.pid;
  // 最小句柄:让 isOwned()/isRunning() 生效;stop 走 adoptedPid 分支按 PID 树结束
  child = { pid: adoptedPid };
  external = false;
  return true;
}

// 按 PID 结束整棵进程树
function killPidTree(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {}
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
          reject(new Error('启动超时:Pi Web 服务未在预期时间内响应,请查看服务日志'));
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
  lastCfg = cfg;
  if (child) return { url, alreadyRunning: true };

  // 端口已被占用:优先识别为自己上次拉起的孤儿(回收为可停止),否则视为外部实例
  if (await probe(url)) {
    if (tryAdoptOrphan(cfg)) {
      return { url, alreadyRunning: true, adopted: true };
    }
    external = true;
    return { url, alreadyRunning: true, external: true };
  }

  external = false;
  adoptedPid = 0;
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
      if (child === c) {
        child = null;
        clearPid(); // 自身退出,pidfile 一并清除
      }
      if (onExit) onExit({ code, intentional: intentionalStop });
    });

    waitForReady(cfg)
      .then(() => {
        writePid(c.pid, cfg);
        resolve({ url });
      })
      .catch((err) => {
        killTree(c);
        reject(err);
      });
  });
}

// 应用启动/页面初始化时检测:默认端口上是否已有 pi-web 在运行(含孤儿回收)
async function refreshExternal(cfg) {
  if (child) return state();
  lastCfg = cfg;
  const url = serverUrl(cfg);
  lastUrl = url;
  if (await probe(url)) {
    if (!tryAdoptOrphan(cfg)) external = true;
  } else {
    external = false;
  }
  return state();
}

function stop() {
  // 外部实例不属于本应用,不能替用户结束进程
  if (external && !child) {
    return { external: true };
  }
  if (!child) {
    clearPid();
    return { stopped: true };
  }
  intentionalStop = true;
  if (adoptedPid) {
    // 孤儿回收的进程:按 PID 树结束
    killPidTree(adoptedPid);
    adoptedPid = 0;
  } else {
    const c = child;
    killTree(c);
  }
  child = null;
  external = false;
  clearPid();
  return { stopped: true };
}

module.exports = { start, stop, probe, serverUrl, isRunning, isOwned, state, refreshExternal };
