# Pi Web Desktop

`@agegr/pi-web` 的跨平台桌面端(Electron 封装):环境检测、代理配置、版本检测与一键更新、内嵌 pi-web Web UI。支持**本地**与**远程(SSH)**两种运行模式。

## 功能

- **两个页面**
  - **控制台页**:模式切换 / 环境检测 / 版本更新 / 服务配置与启动 / 代理与远程设置
  - **服务页**:在 Electron 内直接使用 pi-web 的 Web UI(顶栏可返回控制台或用系统浏览器打开)
- **运行模式**(本地与多台远程可同时运行,互不影响)
  - **本地模式**:在本机启动并管理 pi-web
  - **远程模式**:通过 SSH(免密 RSA 私钥认证)在远程服务器**安装与管理** pi-web,功能与本地完全一致 —— 远程环境检测、版本检测(即远程环境自身的版本)、一键更新、服务启停、服务日志、内嵌 Web UI
  - **直连访问(不做端口转发)**:远程 pi-web 以 `--hostname 0.0.0.0` 启动,内嵌页(webview)直接访问 `http://<远程主机>:<端口>`,远程防火墙需放行该端口;SSH 仅作管理通道
  - **多服务器管理**:远程连接卡片中可按 IP 创建/删除/切换多台服务器档案(`user@host` 下拉选择),每台的检测、更新、服务、日志相互独立,可各自同时运行
- **两种 SSH 认证**:私钥(免密 passphrase,默认查 ~/.ssh/id_rsa、~/.ssh/id_ed25519,可指定路径)或用户名密码(含 keyboard-interactive 兜底;密码明文保存在本机配置文件)
  - 切换模式或切换服务器只更换控制台的展示与操作对象,不停止任何一方的服务;模式切换按钮上的绿点标示该模式服务是否在运行
- **环境检测**:Node.js、npm、pi CLI、pi-web(全局包)、桌面端自身的版本,带状态指示(远程模式下检测的是远程机器)
- **版本检测**:对比当前模式(本地/远程)的 pi-web 与 npm registry 最新版,徽标提示「已是最新 / 可更新 / 未安装 / 检测失败」
- **一键更新 / 一键安装**:pi 与 pi-web 均支持;已安装时执行 `npm install -g <pkg>@latest` 更新,未安装时按钮自动变为「一键安装」执行同一命令完成安装(pi 未安装时使用官方包 @earendil-works/pi-coding-agent)。npm 输出实时回显;更新前自动停掉本应用启动的服务,完成后自动重启
- **代理设置(独立模块 `lib/proxy.js`,协议下拉单行 + 不代理列表)**:
  - **支持 SOCKS(v4/v5)**:代理协议下拉选择 —— HTTP / HTTPS 归为一类,SOCKS5 / SOCKS4 各一项;兼容旧版分协议表与单一地址,自动迁移
  - 不代理的地址列表:每行一条,支持通配符(`*.internal.example.com`)与网段(`192.168.0.0/16`);`127.0.0.1 / ::1 / localhost` 始终直连
  - 启用/关闭在「系统服务」卡中的**盾形代理开关**(高亮+对勾=已启用);代理设置卡仅保存配置
  - **本地模式**:通过系统指令(环境变量)注入 —— 子进程 `HTTP(S)_PROXY / ALL_PROXY / NO_PROXY`;内嵌页面 `session.setProxy(proxyRules + proxyBypassRules)`
  - **远程模式**:代理即 **pi-web 启动时注入代理指令**(环境变量前缀挂在 nohup 命令上,作用于服务的出站 API 流量);npm 检测/安装命令不注入代理,走远程自身网络。代理地址在本机(127.0.0.1/localhost)时自动经 **SSH 反向隧道**(`ssh -R` 语义,端口 17890 起)送达远程,对服务器零侵入,断开连接即失效
  - 远程代理可通过「远程模式也使用该代理」开关单独关闭;内嵌服务页直连远程主机,已配置的远程主机自动加入不代理列表
  - 可选自定义 npm registry(镜像源),本地与远程均会传递
- **端口占用检测**:启动前探测默认端口(30141)
  - 若已有**外部启动**的 pi-web(本地端口被占 / 远程端口已有服务),直接内嵌复用并标注「外部」;外部服务消失时自动感知
  - 外部实例默认不代停;点「停止」时远程模式会弹原生确认框,知情后可**强制结束**(宽匹配该端口上的 pi-web 并结束端口监听进程),本地模式仍仅提示
  - 更新前若发现外部 pi-web 占用端口(文件锁会导致 EBUSY),会明确提示先停止(或用上述强制结束)
- **服务地址(URL)**:本地与远程统一为一个服务地址 —— 本地 `http://127.0.0.1:端口`、远程 `http://主机:端口`,服务卡实时显示并可一键复制;环境检测、版本更新、启停、内嵌页、新窗口最终都落到这个地址
- **孤儿进程回收**:应用被强杀/崩溃/覆盖升级时遗留的 pi-web,下次启动通过 pid 文件自动识别并回收为可停止状态(不会再被误判为「外部启动」而无法停止)。本地与远程均支持:远程按端口记录 `~/.pi-web-desktop/server-<端口>.pid`(兼容旧版共用的 `server.pid`),以「PID 存活 + 命令行确为本应用启动行」双重校验防 PID 复用误认领;SSH 管理连接意外断开不会把自有实例降级为「外部」
- **服务管理**:端口可配置(1024–65535),支持**应用启动模式**默认设置(跟随上次 / 固定本地 / 指定某台远程)、开机自启开关、启动/停止、服务日志、浏览器打开;修改端口并保存时若服务在运行会自动重启(远程改动端口时先按旧端口停掉旧实例);停止远程服务后会复核端口确实释放,停不掉会如实报错并保持运行态
- **主机指纹校验(TOFU)**:远程模式首次连接记录服务器公钥指纹(SHA-256),之后每次连接校验,不一致即拒绝,防范中间人

## 运行

```bash
npm install
npm start          # 启动应用
npm run smoke      # 无界面自检:环境检测结果 + 最新版本查询
node test/scripts-check.js        # 远程模式 stdin 脚本自检(无需 SSH)
node test/config-check.js         # 多服务器档案配置逻辑自检(离线)
node test/proxy-check.js          # 代理模块自检(分协议表/迁移/三类出口,离线)
node test/orphan-adopt.js         # 本地孤儿回收自检(拉起→强杀模拟→认领→停止,真实本地服务)
node test/remote-adopt.js         # 远程服务归属自检(认领/断连保持归属/停止复核,mock SSH 离线)
node test/integration.js          # 本地集成测试:服务启停、外部实例识别、真实更新
node test/remote.js user@host [--key ~/.ssh/id_rsa] [--install]   # 远程链路集成测试(需真实 SSH 服务器)
```

## 打包

```bash
npm run dist:win     # Windows(nsis + portable)
npm run dist:mac     # macOS(dmg)
npm run dist:linux   # Linux(AppImage)
```

产物输出到 `dist/`。`.npmrc` 已配置 npmmirror 的 Electron 二进制镜像;如需其他源自行调整。

> 打包注意:若 shell 里设置了 `HTTP_PROXY/HTTPS_PROXY` 而代理未在线,构建会 `ECONNREFUSED` 失败,清掉代理变量并带 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 重试;Windows 下杀软可能锁住 `dist/win-unpacked.tmp` 导致 rename EPERM,配置里已用 `electronDist: node_modules/electron/dist`(本地已解压的 Electron,复制而非解压改名)规避。产物未做代码签名,首次运行可能触发 SmartScreen 提示。

## 结构

```
main.js            # Electron 主进程入口:窗口、代理、smoke 模式
preload.js         # contextBridge 暴露 piApi(渲染层 ↔ 主进程 IPC)
lib/
  proc.js          # 子进程执行(流式输出)、semver 工具
  proxy.js         # 代理独立模块:分协议表+不代理列表 → session 配置 / 本地子进程 env / 远程命令前缀
  config.js        # 配置持久化(userData/config.json)
  env.js           # 本地环境检测(node/npm/pi/pi-web)与最新版本查询
  server.js        # 本地 pi-web 服务管理:启动/停止/端口探测/外部实例识别
  remote.js        # SSH 连接层(ssh2):远程执行、端口转发隧道、反向隧道、TOFU 指纹
  remote-env.js    # 远程环境检测与版本查询(经 SSH,stdin 脚本采集全局包信息)
  remote-server.js # 远程 pi-web 服务生命周期:nohup 启停、日志轮询、存活看门狗
  ipc.js           # IPC handlers(config/env/update/server/shell/remote,按模式路由)
renderer/
  index.html       # 两个页面:控制台(模式切换+远程配置) + 内嵌服务页(webview)
  style.css
  app.js           # 页面逻辑与事件(本地/远程双服务状态独立维护)
test/
  scripts-check.js # 远程 stdin 脚本自检
  integration.js   # 本地集成测试
  orphan-adopt.js  # 本地孤儿回收自检(真实本地服务)
  remote-adopt.js  # 远程服务归属自检(mock SSH,离线)
  remote.js        # 远程链路集成测试(手动,需真实服务器)
```

## 配置文件

`%APPDATA%/pi-web-desktop/config.json`(macOS/Linux 为用户数据目录):

```json
{
  "mode": "local",
  "defaultMode": "last",
  "defaultRemoteId": "",
  "proxy": {
    "enabled": true,
    "protocol": "http",
    "host": "172.21.170.62",
    "port": 10808,
    "bypass": "192.168.0.0/16\n172.16.0.0/12\n10.0.0.0/8\n*.internal.example.com",
    "remote": true
  },
  "registry": "",
  "port": 30141,
  "autoStart": true,
  "activeRemoteId": "r1",
  "remotes": [
    {
      "id": "r1",
      "host": "192.168.1.100",
      "port": 22,
      "user": "root",
      "keyPath": "",
      "remotePort": 30141,
      "hostFingerprint": "…sha256 hex…"
    },
    {
      "id": "r2",
      "host": "10.0.0.8",
      "port": 22,
      "user": "ubuntu",
      "keyPath": "~/.ssh/id_rsa.work",
      "remotePort": 30141,
      "hostFingerprint": ""
    }
  ]
}
```

`mode` 为 `local` / `remote`;`remotes` 是远程服务器档案列表(应用内「新增/删除」维护),`activeRemoteId` 指向当前操作的档案;`defaultMode`/`defaultRemoteId` 为应用启动模式默认设置(`last` 跟随上次 / `local` 固定本地 / `remote` 固定远程并激活 `defaultRemoteId` 指定的档案)。本地与所有远程服务可同时运行。`keyPath` 留空时按 `~/.ssh/id_rsa`、`~/.ssh/id_ed25519` 顺序查找;`hostFingerprint` 由应用在首次连接成功后自动写入。

## 免密 RSA 配置指引

远程模式要求私钥认证且私钥无 passphrase:

```bash
ssh-keygen -t rsa -b 4096              # 一路回车(不设 passphrase)
ssh-copy-id user@远程主机               # 或手动把 ~/.ssh/id_rsa.pub 追加到远程 ~/.ssh/authorized_keys
ssh user@远程主机 'echo ok'             # 验证免密生效
```

远程机器需已安装 Node.js 与 npm(pi-web 一键安装可在应用内完成)。

## 常见问题

- **更新报 EBUSY / 文件被占用**:有 pi-web 进程占着包目录。若是本应用启动的(含上次遗留、已被自动认领回收的),更新时会自动停止;若是外部启动的,会提示具体的主机与端口,请在该服务器上手动停止。
- **「该 pi-web 由外部启动,无法停止」**:v1.1.3 起远程模式不会再对自己启动的实例误报 —— SSH 断开保持归属、重启后凭 pid 文件认领;确实不是本应用启动的,点「停止」并在确认框中选择「强制结束」即可(会结束该端口上的全部进程)。
- **检查更新失败**:多为网络/代理问题,确认代理地址可达,或填写国内 registry 镜像。(远程模式默认经环境变量走应用代理,本机代理经 SSH 反向隧道送达;也可关闭「远程模式也使用该代理」让远程直连。)
- **远程服务页打不开(超时)**:远程 pi-web 需监听 0.0.0.0 且防火墙放行服务端口(应用启动的实例已自动监听 0.0.0.0);外部手动启动的实例若只监听 127.0.0.1 将无法直连接入。
- **远程走代理失败**:确认远程服务器 sshd 允许 TCP 转发(`AllowTcpForwarding yes`,反向隧道需要);代理需接受来自远程的回环连接。socks 代理对 npm 生效需 npm ≥ 7(支持 socks 代理地址)。
- **pi 未检测到**:pi-web 依赖 pi CLI,先全局安装 pi 后点「重新检测」。(远程模式在远程机器上检测/安装。)
- **SSH 认证失败**:私钥方式确认公钥已加入远程 `~/.ssh/authorized_keys` 且私钥未设 passphrase;密码方式确认用户名密码正确、服务器未禁用密码登录(`PasswordAuthentication yes`)。
- **主机指纹校验失败**:远程服务器重装/换 IP 后公钥变化会被拒绝;确认安全后删除配置文件中对应档案的 `hostFingerprint` 重新连接。
- **远程找不到 node/npm/pi-web**:应用已用登录+交互 shell(`bash -ilc`)执行远程命令以加载 nvm 等 PATH;若仍失败,确认远程 `ssh user@host 'bash -ilc "node -v"'` 可用。
