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

const PID_DIR_NAME = '.pi-web-desktop';
const REMOTE_DIR = `~/${PID_DIR_NAME}`;
const LOG_FILE = `${REMOTE_DIR}/server.log`;
// pid 文件按端口各存一份:同一台机器上不同端口的实例互不覆盖,停一个不会动到别的实例的记录。
// v1.1.2 及更早版本只有一份共用的 server.pid —— 升级前遗留的实例只记在那里,认领时兜底读取
const PID_NAME = (port) => `server-${port}.pid`;
const LEGACY_PID_NAME = 'server.pid';
const pidFile = (port) => `${REMOTE_DIR}/${PID_NAME(port)}`;

function portOf(cfg, key, fallback) {
  const n = Number((cfg && cfg.remote && cfg.remote[key]) || fallback);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return fallback;
  return n;
}

// 远程探测脚本:127.0.0.1:port 是否已有 HTTP 服务(端口是校验过的数字,安全内插)。
// cleanPid:确认端口上已无服务时顺带清掉本端口的 pid 文件(停止后的复核用)
function probeScript(port, { cleanPid = false } = {}) {
  const clean = cleanPid
    ? `\n      try { require('fs').unlinkSync(require('os').homedir() + '/${PID_DIR_NAME}/${PID_NAME(port)}'); } catch {}\n`
    : '';
  return `
    let done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      if (!ok) {${clean}      }
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

// 本应用拉起远程 pi-web 的启动行(与 doStart 的 nohup 命令一致):认领与结束都按它精确匹配
function launchSignature(port) {
  return `pi-web --no-open --hostname 0.0.0.0 --port ${port}`;
}

// 同一启动行的扩展正则(pkill 用)。首位写成 [w] 防止匹配到执行命令的 bash 自身;
// 端口后必须是空格或行尾,停 3014 不会误中 30141
function launchPattern(port) {
  return `pi-[w]eb${launchSignature(port).slice('pi-web'.length).replace(/\./g, '\\.')}( |$)`;
}

// 认领用的 ERE:签名前须是 空格或路径分隔符 —— 应用产生的两种真实进程形态全覆盖:
//   wrap 子 shell `… nohup pi-web …`(空格)、启动器 `node /…/bin/pi-web …`(斜杠)。
// 控制台裸启的 `pi-web …`(行首,前缀为空)不匹配 → 保持「外部实例」语义,不认领。
// 端口后必须是空格或行尾(3014 不误中 30141)。
// ownerCheck 只检查 pid 文件记录的那个 PID,不存在 pkill 那样的自匹配问题,无需 [w] 技巧
function ownerEre(port) {
  return `([ /])${launchSignature(port).replace(/\./g, '\\.')}( |$)`;
}

// 远程 shell 里的归属判定:依次看本端口的 pid 文件与旧版共用的 server.pid,记录的 PID 存活且命令行
// 确为本应用的启动行 → 是自己的实例,PID 写入 $OWNER(否则为 0)。PID 存活 + 命令行匹配两层都要,
// 防 pid 文件过期后 PID 被别的进程复用造成误认领。clean:顺带清掉过期的 pid 文件
function ownerCheck(port, { clean = false } = {}) {
  const ere = ownerEre(port);
  return (
    `D=$HOME/${PID_DIR_NAME}; OWNER=0; ` +
    `for F in "$D/${PID_NAME(port)}" "$D/${LEGACY_PID_NAME}"; do ` +
      `C=$(cat "$F" 2>/dev/null || true); case "$C" in ""|*[!0-9]*) C=0;; esac; A=""; ` +
      `if [ "$C" -gt 0 ] && kill -0 "$C" 2>/dev/null; then A=$(ps -o args= -p "$C" 2>/dev/null || true); fi; ` +
      `if printf '%s' "$A" | grep -Eq "${ere}"; then OWNER="$C"; break; fi; ` +
      (clean ? `rm -f "$F"; ` : '') +
    `done`
  );
}

// 认领检查:归属判定的结果用 __PI_ADOPT__ 标记带回(免疫登录 shell profile 可能输出的杂音)
function adoptCheckScript(port) {
  return `${ownerCheck(port, { clean: true })}; printf '\\n__PI_ADOPT__%s\\n' "$OWNER"`;
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
    this.logOffset = 0;
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
            reject(new Error(`无法从本机直连 ${url} :请确认远程 Pi Web 已启动且防火墙放行该端口`));
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

  // 远程端口已有服务时,判断是不是自己上次拉起的:应用被强杀 / 安装器覆盖升级 / 看门狗自愈重启时
  // 不走正常退出,远程 nohup 的 pi-web 会留在那儿;下次启动若只按「端口被占」处理,就会把自己启动的
  // 实例误判成外部实例 —— 既不能停也不能更新。依据只有远程 pidfile:PID 存活且命令行确为本应用的
  // 启动行才算(对齐本地 lib/server.js 的 pidfile 回收)
  async tryAdoptOrphan(cfg, remotePort) {
    try {
      const { stdout } = await exec(cfg, adoptCheckScript(remotePort), { timeoutMs: 15000 });
      return /__PI_ADOPT__[1-9]\d*/.test(stdout);
    } catch {
      return false; // SSH 抖动等:按外部实例接入,不因认领失败阻断
    }
  }

  // 远程端口已有服务时接入:webview 直连访问,服务必须监听非回环地址,否则无法接入。
  // 自己遗留的孤儿认领回来(可停止 / 可更新),否则按外部实例复用、不代停(对齐本地语义)。返回是否为认领
  async attachServing(cfg, { onLog } = {}) {
    const remotePort = portOf(cfg, 'remotePort', 30141);
    const directUrl = this.serverUrl(cfg);
    const adopted = await this.tryAdoptOrphan(cfg, remotePort);
    await this.waitForReady(directUrl, 15000).catch(() => {
      throw new Error(adopted
        ? `远程端口 ${remotePort} 上的 Pi Web 是本应用上次启动的,但本机无法直连 ${directUrl}:请确认远程防火墙放行该端口`
        : `远程端口 ${remotePort} 已有 Pi Web,但仅监听 127.0.0.1(外部实例),本机无法直连;请在远程以 --hostname 0.0.0.0 启动`);
    });
    this.lastUrl = directUrl;
    this.running = true;
    this.owned = adopted;
    this.external = !adopted;
    this.intentionalStop = false;
    if (onLog) {
      onLog(adopted
        ? `# 远程 ${cfg.remote.host} 端口 ${remotePort} 的 Pi Web 是本应用上次启动的,已重新接管(可停止、可更新):${directUrl}\n`
        : `# 远程 ${cfg.remote.host} 端口 ${remotePort} 已有 Pi Web 在运行,直连复用(外部实例):${directUrl}\n`);
    }
    return adopted;
  }

  // 存活看门狗:连续 2 轮确认远程端口无响应 → 视为服务退出
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

    // 远程端口已有服务:自己上次遗留的认领回来,否则按外部实例复用、不代停(对齐本地语义)
    let alreadyServing;
    try {
      alreadyServing = await this.probeRemote(cfg);
    } catch (err) {
      throw new Error(`无法探测远程服务状态:${err.message}`);
    }

    if (alreadyServing) {
      const adopted = await this.attachServing(cfg, { onLog });
      return { url: this.lastUrl, alreadyRunning: true, adopted, external: !adopted };
    }

    // 由本应用启动:mkdir → (可选)注入代理环境变量 → nohup 后台启动(监听 0.0.0.0)→ 1s 后确认进程仍在
    // 代理经系统指令(环境变量前缀)注入;本机代理由 lib/proxy.js 经 SSH 反向隧道送达。
    // 关键:只能后台化「nohup 这一条简单命令」并把重定向挂在它身上。bash -ilc 下把复合命令
    // (AND 列表或 {} 组,即使整体重定向)放后台,SSH exec 通道不会关闭 —— exec 超时报「启动失败」,
    // 服务实际已启动,用户再次启动就会接入成「外部实例」(2026-11 在 172.16.10.131 上真实发生,
    // 实验复现:复合形态挂通道,简单形态 1.4s 返回)。$! 因此是 pi-web 启动器本体,直接记入 pid 文件
    const proxyPrefix = await proxy.remoteEnvPrefix(cfg).catch(() => '');
    if (proxyPrefix && onLog) onLog('# 已为远程 Pi Web 注入代理环境变量\n');
    if (onLog) onLog(`$ ssh ${cfg.remote.user}@${cfg.remote.host} pi-web --no-open --hostname 0.0.0.0 --port ${remotePort}\n`);
    const launch = await exec(
      cfg,
      `mkdir -p ${REMOTE_DIR}; ` +
        `${proxyPrefix}nohup pi-web --no-open --hostname 0.0.0.0 --port ${remotePort} >> ${LOG_FILE} 2>&1 < /dev/null & ` +
        `echo $! > ${pidFile(remotePort)} && sleep 1 && ` +
        `if ! kill -0 $(cat ${pidFile(remotePort)}) 2>/dev/null; then echo __LAUNCH_FAILED__; tail -n 15 ${LOG_FILE} 2>/dev/null; fi`,
      { timeoutMs: 20000 }
    );
    if (launch.stdout.includes('__LAUNCH_FAILED__')) {
      const tail = launch.stdout.split('__LAUNCH_FAILED__')[1] || launch.stderr || '';
      throw new Error(`远程 Pi Web 启动后立即退出:${tail.trim().split(/\r?\n/).slice(-5).join(' | ') || '无日志输出'}`);
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
    return { url: this.lastUrl };
  }

  // 结束远程 pi-web。owned 路径:按本应用启动行精确匹配 pkill(启动器再把 SIGTERM 转给 Next 子进程),
  // 不按 pid 文件里的数字直接 kill —— 过期 pid 文件的 PID 可能已被别的进程复用;1s 后若进程已不在就
  // 清掉本端口的 pid 文件(还在退出中则留着,交给 stop() 复核时再清)。
  // force 路径(外部实例,用户已确认):宽匹配本端口上一切 pi-web(pkill SIGTERM 优雅)→ fuser/lsof
  // 结束端口上的监听进程(SIGKILL,启动器随之退出),pid 文件交给复核时按需清理。
  // 返回 true 只表示指令已发到远程 —— 不代表进程已退出,SSH 不通、权限不足等都发不出去
  async killRemote(cfg, remotePort, { force = false } = {}) {
    const dir = `$HOME/${PID_DIR_NAME}`;
    try {
      if (force) {
        const broad = `pi-[w]eb .*--port ${remotePort}( |$)`;
        await exec(
          cfg,
          `pkill -f "${broad}" 2>/dev/null || true; ` +
            `if command -v fuser >/dev/null 2>&1; then fuser -k ${remotePort}/tcp 2>/dev/null; ` +
            `elif command -v lsof >/dev/null 2>&1; then lsof -t -i :${remotePort} 2>/dev/null | xargs -r kill 2>/dev/null; fi; true`,
          { timeoutMs: 20000 }
        );
        return true;
      }
      const pattern = launchPattern(remotePort);
      await exec(
        cfg,
        `pkill -f "${pattern}" 2>/dev/null || true; sleep 1; ` +
          `if ! pgrep -f "${pattern}" >/dev/null 2>&1; then rm -f "${dir}/${PID_NAME(remotePort)}"; fi; ` +
          // 旧版共用的 server.pid:记录的进程已不在就一并清掉(还活着可能属于别的实例,留着)
          `L=$(cat "${dir}/${LEGACY_PID_NAME}" 2>/dev/null || true); case "$L" in ""|*[!0-9]*) L=0;; esac; ` +
          `if [ "$L" -gt 0 ] && ! kill -0 "$L" 2>/dev/null; then rm -f "${dir}/${LEGACY_PID_NAME}"; fi; true`,
        { timeoutMs: 20000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  // 停止后的复核:远程端口确实不再响应才算停掉(每 0.8s 探一次,最多约 8s),确认后顺带清掉 pid 文件;
  // SSH 不通时无从确认,按未停止处理
  async confirmGone(cfg) {
    const script = probeScript(portOf(cfg, 'remotePort', 30141), { cleanPid: true });
    for (let i = 0; i < 10; i++) {
      let value = null;
      try {
        ({ value } = await execScript(cfg, script, { timeoutMs: 15000 }));
      } catch {
        return false;
      }
      if (value && value.ok === false) return true;
      if (i < 9) await new Promise((r) => setTimeout(r, 800));
    }
    return false;
  }

  // verify:false 用于应用退出时的收尾(结果没人看,不必等复核)。
  // force:true 用于外部实例 —— 渲染层已弹确认框、用户已知情同意后强制结束(默认仍拒绝代停)
  async stop({ verify = true, force = false } = {}) {
    // 外部实例不属于本应用,未经确认不能替用户结束进程
    if (this.running && !this.owned && !force) {
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
    const sent = await this.killRemote(cfg, portOf(cfg, 'remotePort', 30141), { force });
    if (!verify || (sent && (await this.confirmGone(cfg)))) {
      this.resetState();
      return { stopped: true };
    }
    // 服务多半还活着:保持运行态并如实相告,不假装已停止
    return { error: force
      ? '远程 Pi Web 强制结束未生效(SSH 不通或进程无法结束),请检查连接后重试'
      : '远程 Pi Web 未能停止(SSH 不通或进程拒绝退出),请检查连接后重试' };
  }

  // 应用启动/页面初始化时检测:远程端口上是否已有 pi-web(自己遗留的孤儿会被认领)
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
        await this.attachServing(cfg);
      } catch {
        // 远程服务仅监听回环地址,本机无法直连 → 视为不可接入
        this.lastUrl = '';
      }
    } else {
      this.lastUrl = '';
    }
    return this.state();
  }

  // SSH 管理连接意外断开:不判定服务退出(远程多半仍在运行,直连页面不受影响),归属也不变 ——
  // 自己拉起/认领的实例仍是自己的,否则一次网络抖动就会让它变得不能停、不能更新;
  // 下次操作时 ensureConnected 会自动重连。这里只停日志轮询
  handleDisconnect() {
    if (!this.running) return;
    this.stopWatchers();
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
  stop: async (cfg, opts) => {
    const inst = instances.get(serviceKeyOf(cfg));
    if (!inst) return { stopped: true };
    return inst.stop(opts);
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
    for (const inst of instances.values()) await inst.stop({ verify: false });
  },
};
