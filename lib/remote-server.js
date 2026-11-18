'use strict';

// 远程模式的 pi-web 服务管理(镜像 lib/server.js 的接口语义),支持多台服务器:
// 每个「SSH 目标 + 远程端口」对应一个 RemoteService 实例,各自独立运行、互不影响。
//
// SSH 定位为管理通道:环境检测 / 一键安装更新 / 启停服务 / 日志 / 看门狗都经 SSH 执行;
// 远程 pi-web 监听 0.0.0.0,内嵌页(webview)直接访问 http://<远程主机>:<端口>,
// 不做本地端口转发 —— 远程防火墙需放行该端口。

const { exec, execScript, onDisconnect, sshKeyOf } = require('./remote');
const { probe } = require('./server');
const proxy = require('./proxy');

const REMOTE_DIR = '~/.pi-web-desktop';
const LOG_FILE = `${REMOTE_DIR}/server.log`;
const PID_FILE = `${REMOTE_DIR}/server.pid`;

function portOf(cfg, key, fallback) {
  const n = Number((cfg && cfg.remote && cfg.remote[key]) || fallback);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return fallback;
  return n;
}

// 远程探测脚本:127.0.0.1:port 是否已有 HTTP 服务(端口是校验过的数字,安全内插)
function probeScript(port) {
  return `
    let done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      console.log('__PI_JSON_BEGIN__');
      console.log(ok ? '{"ok":true}' : '{"ok":false}');
      console.log('__PI_JSON_END__');
    }
    const req = require('http').get('http://127.0.0.1:${port}/', (res) => { res.resume(); finish(true); });
    req.on('error', () => finish(false));
    req.setTimeout(2500, () => req.destroy(new Error('timeout')));
    req.on('close', () => finish(false));
  `;
}

class RemoteService {
  constructor(sshKey) {
    this.sshKey = sshKey;
    this.running = false;       // 服务(远程)处于运行状态
    this.owned = false;         // 由本应用启动(可停止);外部启动的实例不能停
    this.external = false;      // 远程端口上已有外部启动的 pi-web
    this.intentionalStop = false;
    this.lastUrl = '';
    this.starting = null;       // 并发 start 去重
    this.logTimer = null;       // 日志轮询
    this.watchTimer = null;     // 存活看门狗
    this.logOffset = 0;
    this.watchFailCount = 0;
    this.exitCallback = null;
    this.lastCfg = null;        // 启动时的配置快照,stop 时按它回收
    onDisconnect((key) => {
      if (key === this.sshKey) this.handleDisconnect();
    });
  }

  // 内嵌页直接访问的地址(不做端口转发)
  serverUrl(cfg) {
    const host = (cfg && cfg.remote && cfg.remote.host) || '';
    const port = portOf(cfg, 'remotePort', 30141);
    return `http://${host}:${port}/`;
  }

  state() {
    return { running: this.running, owned: this.owned, external: this.external, url: this.lastUrl };
  }

  isRunning() {
    return this.running;
  }

  isOwned() {
    return this.running && this.owned;
  }

  // 探测远程端口(SSH 内,走远程 127.0.0.1);返回 true / false,SSH 层故障时抛错
  async probeRemote(cfg) {
    const port = portOf(cfg, 'remotePort', 30141);
    const { value } = await execScript(cfg, probeScript(port), { timeoutMs: 15000 });
    if (!value || typeof value.ok !== 'boolean') {
      throw new Error('远程探测失败:未能解析输出');
    }
    return value.ok;
  }

  // 从本机直连探测远程服务(webview 就是这么访问的;同时验证防火墙放行)
  waitForReady(url, timeoutMs = 30000) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const attempt = () => {
        probe(url).then((ok) => {
          if (ok) {
            resolve();
          } else if (Date.now() - startedAt > timeoutMs) {
            reject(new Error(`无法从本机直连 ${url} :请确认远程 pi-web 已启动且防火墙放行该端口`));
          } else {
            setTimeout(attempt, 600);
          }
        });
      };
      attempt();
    });
  }

  stopWatchers() {
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = null;
    }
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  resetState() {
    this.running = false;
    this.owned = false;
    this.external = false;
    this.stopWatchers();
  }

  // 日志增量轮询:tail 从 offset+1 起取新字节,文件大小由 __PI_SIZE__ 标记带回
  startLogPolling(cfg, onLog) {
    this.logOffset = 0;
    this.logTimer = setInterval(async () => {
      const offset = this.logOffset;
      try {
        const cmd =
          `S=$(wc -c < ${LOG_FILE} 2>/dev/null || echo 0); printf '__PI_SIZE__%s\\n' "$S"; ` +
          `if [ "$S" -gt ${offset} ]; then tail -c +$(( ${offset} + 1 )) ${LOG_FILE} 2>/dev/null; fi`;
        const { stdout } = await exec(cfg, cmd, { timeoutMs: 15000 });
        const m = stdout.match(/^__PI_SIZE__(\d+)\n/);
        if (!m) return;
        const size = parseInt(m[1], 10) || 0;
        const chunk = stdout.slice(m[0].length);
        // 日志被截断/轮转 → 重置偏移,下一轮重新取全量
        this.logOffset = size < offset ? 0 : size;
        if (chunk && onLog) onLog(chunk);
      } catch {
        // SSH 抖动等瞬时失败:跳过本轮
      }
    }, 2000);
  }

  // 存活看门狗:连续 2 轮确认远程端口无响应 → 视为服务退出
  startWatchdog(cfg, onExit) {
    this.watchFailCount = 0;
    this.watchTimer = setInterval(async () => {
      try {
        const ok = await this.probeRemote(cfg);
        if (ok) {
          this.watchFailCount = 0;
          return;
        }
      } catch {
        return; // 探测通道异常,不能断定服务已退出
      }
      this.watchFailCount += 1;
      if (this.watchFailCount >= 2) {
        const info = { code: null, intentional: this.intentionalStop };
        this.resetState();
        if (onExit) onExit(info);
      }
    }, 3000);
  }

  async start(cfg, { onLog, onExit } = {}) {
    if (this.starting) return this.starting;
    this.exitCallback = onExit || null;
    this.starting = this.doStart(cfg, { onLog, onExit }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async doStart(cfg, { onLog, onExit } = {}) {
    const remotePort = portOf(cfg, 'remotePort', 30141);
    const directUrl = this.serverUrl(cfg);
    this.lastCfg = cfg;

    if (this.running) {
      return { url: this.lastUrl, alreadyRunning: true };
    }

    // 远程端口已有服务(外部启动):复用、不代停(对齐本地外部实例语义)。
    // webview 直连访问,服务必须监听非回环地址,否则无法接入。
    let alreadyServing;
    try {
      alreadyServing = await this.probeRemote(cfg);
    } catch (err) {
      throw new Error(`无法探测远程服务状态:${err.message}`);
    }

    if (alreadyServing) {
      try {
        await this.waitForReady(directUrl, 15000);
      } catch {
        throw new Error(`远程端口 ${remotePort} 已有 pi-web,但仅监听 127.0.0.1(外部实例),本机无法直连;请在远程以 --hostname 0.0.0.0 启动`);
      }
      this.lastUrl = directUrl;
      this.running = true;
      this.owned = false;
      this.external = true;
      this.intentionalStop = false;
      if (onLog) onLog(`# 远程 ${cfg.remote.host} 端口 ${remotePort} 已有 pi-web 在运行,直连复用(外部实例):${directUrl}\n`);
      this.startWatchdog(cfg, onExit);
      return { url: this.lastUrl, alreadyRunning: true, external: true };
    }

    // 由本应用启动:mkdir → (可选)注入代理环境变量 → nohup 后台启动(监听 0.0.0.0)→ 1s 后确认进程仍在
    // 代理经系统指令(环境变量前缀)注入;本机代理由 lib/proxy.js 经 SSH 反向隧道送达
    const proxyPrefix = await proxy.remoteEnvPrefix(cfg).catch(() => '');
    if (proxyPrefix && onLog) onLog('# 已为远程 pi-web 注入代理环境变量\n');
    if (onLog) onLog(`$ ssh ${cfg.remote.user}@${cfg.remote.host} pi-web --no-open --hostname 0.0.0.0 --port ${remotePort}\n`);
    const launch = await exec(
      cfg,
      `mkdir -p ${REMOTE_DIR} && ` +
        `${proxyPrefix}nohup pi-web --no-open --hostname 0.0.0.0 --port ${remotePort} >> ${LOG_FILE} 2>&1 < /dev/null & ` +
        `echo $! > ${PID_FILE} && sleep 1 && ` +
        `if ! kill -0 $(cat ${PID_FILE}) 2>/dev/null; then echo __LAUNCH_FAILED__; tail -n 15 ${LOG_FILE} 2>/dev/null; fi`,
      { timeoutMs: 20000 }
    );
    if (launch.stdout.includes('__LAUNCH_FAILED__')) {
      const tail = launch.stdout.split('__LAUNCH_FAILED__')[1] || launch.stderr || '';
      throw new Error(`远程 pi-web 启动后立即退出:${tail.trim().split(/\r?\n/).slice(-5).join(' | ') || '无日志输出'}`);
    }

    // 从本机直连等待服务就绪(webview 的实际访问路径,同时验证防火墙)
    try {
      await this.waitForReady(directUrl);
    } catch (err) {
      await this.killRemote(cfg, remotePort);
      this.resetState();
      throw err;
    }

    this.lastUrl = directUrl;
    this.running = true;
    this.owned = true;
    this.external = false;
    this.intentionalStop = false;

    this.startLogPolling(cfg, onLog);
    this.startWatchdog(cfg, onExit);
    return { url: this.lastUrl };
  }

  // 结束远程 pi-web:优先 pid 文件,兜底按端口精确匹配 pkill([w] 防止匹配到 pkill 自身)
  async killRemote(cfg, remotePort) {
    await exec(
      cfg,
      `kill $(cat ${PID_FILE} 2>/dev/null) 2>/dev/null; ` +
        `sleep 1; ` +
        `pkill -f "pi-[w]eb --no-open .*--port ${remotePort}" 2>/dev/null; ` +
        `rm -f ${PID_FILE}`,
      { timeoutMs: 20000 }
    ).catch(() => {});
  }

  async stop() {
    // 外部实例不属于本应用,不能替用户结束进程
    if (this.running && !this.owned) {
      return { external: true };
    }
    if (!this.running) {
      return { stopped: true };
    }
    this.intentionalStop = true;
    const cfg = this.lastCfg;
    if (!cfg) {
      this.resetState();
      return { stopped: true };
    }
    const remotePort = portOf(cfg, 'remotePort', 30141);
    await this.killRemote(cfg, remotePort);
    this.resetState();
    return { stopped: true };
  }

  // 应用启动/页面初始化时检测:远程端口上是否已有(外部启动的)pi-web
  async refreshExternal(cfg) {
    if (this.running) return this.state();
    this.lastCfg = cfg;
    let serving = false;
    try {
      serving = await this.probeRemote(cfg);
    } catch {
      // SSH 不通:保持未运行状态,错误由环境检测/测试连接呈现
      return this.state();
    }
    if (serving) {
      try {
        await this.waitForReady(this.serverUrl(cfg), 15000);
        this.lastUrl = this.serverUrl(cfg);
        this.running = true;
        this.owned = false;
        this.external = true;
        this.startWatchdog(cfg, this.exitCallback);
      } catch {
        // 远程服务仅监听回环地址,本机无法直连 → 视为不可接入
        this.lastUrl = '';
      }
    } else {
      this.lastUrl = '';
    }
    return this.state();
  }

  // SSH 连接意外断开:服务可能仍在远程运行,但本应用无法继续观测;
  // 上报退出让 UI 回到控制台,重连后 refreshExternal 可重新识别(外部实例)
  handleDisconnect() {
    if (!this.running) return;
    const info = { code: null, intentional: false, reason: 'disconnect' };
    this.resetState();
    if (this.exitCallback) this.exitCallback(info);
  }
}

/* ---------------- 实例注册表与模块级接口 ---------------- */

// 服务标识:SSH 目标 + 远程端口(同主机不同 remotePort 视为不同服务)
function serviceKeyOf(cfg) {
  const r = (cfg && cfg.remote) || {};
  return `${r.host}:${Number(r.port) || 22}:${r.user}:${Number(r.remotePort) || 30141}`;
}

const instances = new Map();

function instanceFor(cfg) {
  const key = serviceKeyOf(cfg);
  let inst = instances.get(key);
  if (!inst) {
    inst = new RemoteService(sshKeyOf(cfg));
    instances.set(key, inst);
  }
  return inst;
}

module.exports = {
  start: (cfg, hooks) => instanceFor(cfg).start(cfg, hooks),
  stop: async (cfg) => {
    const inst = instances.get(serviceKeyOf(cfg));
    if (!inst) return { stopped: true };
    return inst.stop();
  },
  state: (cfg) => {
    const inst = instances.get(serviceKeyOf(cfg));
    return inst ? inst.state() : { running: false, owned: false, external: false, url: '' };
  },
  isRunning: (cfg) => {
    const inst = instances.get(serviceKeyOf(cfg));
    return !!(inst && inst.running);
  },
  isOwned: (cfg) => {
    const inst = instances.get(serviceKeyOf(cfg));
    return !!(inst && inst.running && inst.owned);
  },
  refreshExternal: (cfg) => instanceFor(cfg).refreshExternal(cfg),
  probeRemote: (cfg) => instanceFor(cfg).probeRemote(cfg),
  stopAll: async () => {
    for (const inst of instances.values()) await inst.stop();
  },
};
