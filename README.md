# Pi Web Desktop

`@agegr/pi-web` 的跨平台桌面端(Electron 封装):环境检测、代理配置、版本检测与一键更新、内嵌 Pi Web 的 Web UI。支持**本地**与**远程(SSH)**两种运行模式。

## 功能

- **v1.4.0 SSH 终端增强**：WebGL 渲染(不可用时自动回退)与 Unicode 11 宽度表；Shift+Enter 在 Claude Code 输入框内换行，Ctrl+单击链接用系统浏览器打开；会话带真彩色声明、继承这台服务器的代理设置，可选 tmux 断线保活；粘贴改用 Alt+V，Ctrl+V 原样交给终端里的程序
- **v1.3.0 界面升级**：四张配置卡统一深色开发者工具样式，Iconoir 图标与本地打包字体；pi CLI、Pi Web 和桌面软件分别使用独立品牌图标，去除多余留白以保证小尺寸清晰度
- **Pi Web 操作行**：启动 / 停止 / 重启 / 访问 / 收藏 / 日志，按钮均带图标；主机与端口支持一键复制。「访问」打开应用内服务页，系统浏览器入口在服务页工具栏

- **两个页面**
  - **控制台页**:模式切换 / 环境检测 / 版本更新 / 服务配置与启动 / 代理与远程设置
  - **服务页**:在 Electron 内直接使用 Pi Web 的 Web UI(顶栏可返回控制台、用系统浏览器打开,或**在 code-server 中打开当前项目**)
- **无边框窗口**(Windows):系统标题栏隐藏,由应用顶栏充当标题栏 —— 整条可拖拽、双击最大化,右上角保留**系统原生**的最小化 / 最大化 / 关闭按钮(Win11 贴靠布局照常可用)。服务页与终端视图的紧凑工具栏同样可拖拽,各工具栏右侧的内容自动让出按钮的位置;弹窗打开时顶部仍可拖拽、关闭按钮仍可点。macOS / Linux 保持系统标题栏
- **在编辑器中打开当前项目**:服务页顶栏的「编辑器」按钮 —— **本机目标直接用桌面版 VS Code 打开**,远程目标用 code-server(它是**可选组件**:想用再装,不装不影响任何其它功能)。当前项目目录直接取自服务页里 Pi Web 的界面(Pi Web 侧边栏的当前项目行自带目录)
  - **没装**:询问一句要不要装,选「安装」才装;安装进度写在「更新日志」里,装完自动继续打开
  - **一键安装(远程 Linux amd64 / arm64)**:装的是 code-server 官方的独立发行包,解压到该服务器的 `~/.pi-web-desktop/code-server` —— 不需要 root、不改系统包,卸载就是删掉这个目录(下载约 270MB,解压后约 740MB,磁盘需留出约 1.2GB)。下载和查询版本号都先走该服务器自己的代理设置,不行再试直连。不用 npm:code-server 的 npm 包里嵌套着整棵 `node_modules`,npm 安装会失败
  - **按需启动**:装了但没在运行时,点按钮才启动(与 Pi Web 相同的后台方式),应用退出时回收。本来就在运行的(比如自己配的 systemd 服务)直接用,不会去动它。默认端口 8080 被别的程序占着时自动顺延到第一个空闲端口,并记在服务器上供下次沿用;自己配过监听地址的只在这一次临时顺延,不改配置文件。应用被强杀、覆盖升级时不走正常退出,启动过的实例会留在服务器上 —— 下次点按钮时直接复用并认领回来,退出时一并回收(按服务器上的 pid 文件与进程命令行判定,自己手工起的不会被误认、不会被结束)
  - **登录密码**:窗口落到登录页时,把该服务器上 code-server 的登录密码复制到剪贴板并提示(首次启动时由 code-server 自动生成);已登录会直接进入项目,不打扰。复制以写入真正完成为准:写不进去时(比如剪贴板正被别的程序占着)直接显示密码,不会谎称已复制
  - **地址**:「Code Server 配置」卡里的 code-server 地址是可选项。留空则经 SSH 读那台机器上 code-server 自身的监听配置(`~/.config/code-server/config.yaml` 的 `bind-addr`,没写按默认 8080);填的是「这台服务器的某个端口」时仍由本应用安装 / 按需启动;填的是反向代理下的地址或别的主机时按你填的打开,本应用不代为启动
  - **本机目标**:直接用桌面版 VS Code 打开(找得到 `code` 命令或常见安装位置即可,已开着就复用现有实例);显式填了 code-server 地址时按填的地址开窗口;两者都没有时提示安装 VS Code 或填写地址。本机不提供 code-server 的安装 / 按需启动(其安装包不支持 Windows)
  - 识别当前项目依赖 Pi Web 界面的结构(项目行的 `data-row-key`、当前项目的 `is-current` 标记),另备两条识别路径;Pi Web 改版导致都识别不到时会提示「没能识别出当前项目」,不会打开错误的目录
- **运行模式**(本地与多台远程可同时运行,互不影响)
  - **本地模式**:在本机启动并管理 Pi Web
  - **远程模式**:通过 SSH(免密 RSA 私钥认证)在远程服务器**安装与管理** Pi Web,功能与本地完全一致 —— 远程环境检测、版本检测(即远程环境自身的版本)、一键更新、服务启停、服务日志、内嵌 Web UI
  - **直连访问(不做端口转发)**:远程 Pi Web 以 `--hostname 0.0.0.0` 启动,内嵌页(webview)直接访问 `http://<远程主机>:<端口>`,远程防火墙需放行该端口;SSH 仅作管理通道
  - **多服务器管理**:远程连接卡片中可按 IP 创建/删除/切换多台服务器档案(`user@host` 下拉选择),每台的检测、更新、服务、日志相互独立,可各自同时运行
- **控制台卡片**:①**Pi Web 配置**(系统服务 + 环境检测,卡内左右两栏)②**Code Server 配置**(地址 / 监听端口 / 登录密码 + 安装/更新 + 启动/停止/打开)③**终端配置**(终端主题 + 启动时打开 + 会话开关)④**代理设置**。业务卡跟随当前目标(本机 / 各远程)切换,终端配置为全局共用
- **Code Server 配置卡**(远程为托管模式,本机仅地址):状态行显示未安装/已安装/运行中;**安装 / 更新**从本应用一键装官方独立发行包;**监听端口与登录密码**写入服务器 `~/.config/code-server/config.yaml`(bind-addr 固定 0.0.0.0:端口,密码留空自动生成,明文存于服务器与其自身存储方式一致);**启动/停止**按需启停,想用的端口被占自动顺延;停止非本应用启动的实例需在确认框知情后**强制结束**(宽匹配该端口上的 code-server);**打开**拉起独立窗口(落到登录页自动复制密码)。地址留空 = 本应用检测并按需启动;填反向代理等地址则按填的打开、不代为启动
- **SSH 终端**(目标条终端按钮,仅远程):对当前远程服务器开全屏交互式终端 —— xterm.js 渲染 + 现有 SSH 连接上的 PTY 通道(复用同一套认证/指纹校验/保活),服务器零安装、零常驻端口;断线显示遮罩可一键重连,窗口尺寸自动同步。**Alt+V 三态**:剪贴板是文本 → 按普通粘贴;是截图/图片 → 经 SFTP 上传到服务器 `/tmp` 下的独立私有目录,并把远程路径填入输入行(不带回车,可继续编辑);是复制的文件 → 逐个上传(上限 20 个,同批重名自动加 -N 后缀,分批上传不会覆盖已有文件)。**Ctrl+V 不拦截**,原样发出 `^V`(供 herdr、vim 等里层程序使用);纯文本粘贴用 `Ctrl+Shift+V` 或 Alt+V
- **终端渲染**(xterm.js 6 + 官方 addon,产物随应用打包,离线可用):**WebGL 渲染**加快重绘,拿不到上下文(显卡驱动异常、`--disable-gpu` 自愈模式、远程桌面)或上下文丢失时**自动退回内置渲染器**,终端照常可用;**Unicode 11 宽度表**让 emoji 按两格排(默认表按一格,中文混排时会压住后面的字),并开启超宽字形缩放;输出里的网址可识别,**Ctrl+单击用系统浏览器打开**(直接单击/双击选词不触发,与 Windows Terminal、VS Code 一致);**Shift+Enter 在输入框内换行**(发 `Esc+CR`:Claude Code 据此在输入框内换行而不是提交,已在 v2.1.263 实测;别的程序表现取决于程序本身,例如 pi 1.6 仍会提交,与映射前相同。可在终端配置里关掉,普通 shell 会丢弃该序列)
- **终端会话环境**(主进程 `lib/term.js` 的启动脚本,经 `exec` + PTY 拉起**登录 shell**,profile 里的 PATH 照常生效):自动带 `COLORTERM=truecolor`(xterm.js 支持 24 位色,认这个变量的程序据此启用);`LANG` 不是 UTF-8 时挑服务器上现成的 UTF-8 locale 兜底(已是 UTF-8 则原样不动);**会话继承该服务器的代理设置**(与 Pi Web 启动注入的是同一份,回环代理由 SSH 反向隧道送达;可在终端配置里关掉);**断线保活(可选,需服务器装有 tmux)**:会话放进独立 socket(`tmux -L pi-web-desktop`)的 tmux 里,SSH 断开、离开终端后服务器上的程序继续运行,重连时尝试回到原会话。附着已有会话会保留原 shell 与任务的环境，不会应用新改的代理，也不会重启任务；要应用新代理需主动结束旧会话后新建。状态点与「← 控制台」的说明会带出这个会话是否继承了代理、是否在 tmux 里;想继承代理没成功、开了保活但服务器没有 tmux 都会各提示一条,会话照常可用
- **终端 ↔ 服务页互切**:Pi Web 服务页顶栏「终端」按钮与终端顶栏「Pi Web」按钮直接互切,**切换期间终端会话保留**(不重开 shell);「← 控制台」才是显式结束会话。终端里的「Pi Web」按钮跟随 Pi Web 服务状态:进入终端时自动核对,服务未运行则置灰并说明原因
- **终端主题**:设置卡可选 跟随应用(默认,与控制台同色)/ 亮色 / Dracula / Solarized Dark / Solarized Light / One Dark / Monokai / Nord / Tokyo Night / Gruvbox Dark,均带 ANSI 16 色,所有目标共用;保存设置即生效,已打开的终端热切换
- **启动时打开**(设置里配置,所有目标共用):应用启动后自动进入 **Pi Web 服务页**(服务未就绪则等首次就绪再进)或 **SSH 终端**(仅远程),默认停在控制台
- **两种 SSH 认证**:私钥(免密 passphrase,默认查 ~/.ssh/id_rsa、~/.ssh/id_ed25519,可指定路径)或用户名密码(含 keyboard-interactive 兜底;密码明文保存在本机配置文件)
  - 切换模式或切换服务器只更换控制台的展示与操作对象,不停止任何一方的服务;模式切换按钮上的绿点标示该模式服务是否在运行
- **环境检测**:Node.js、npm、pi CLI、Pi Web(全局包)、桌面端自身的版本,带状态指示(远程模式下检测的是远程机器)。本机与每台远程服务器**各查各的、各存各的**:检测结果按目标归档,切 Tab 立即显示该服务器自己的上次结果并在后台刷新;在途检测不会串到别的服务器,档案改了主机/用户后旧结果作废
- **版本检测**:对比当前模式(本地/远程)的 Pi Web 与 npm registry 最新版,徽标提示「已是最新 / 可更新 / 未安装 / 检测失败」
- **一键更新 / 一键安装**:pi 与 Pi Web 均支持;已安装时执行 `npm install -g <pkg>@latest` 更新,未安装时按钮自动变为「一键安装」执行同一命令完成安装(pi 未安装时使用官方包 @earendil-works/pi-coding-agent)。npm 输出实时回显;更新前自动停掉本应用启动的服务,完成后自动重启
- **代理设置(独立模块 `lib/proxy.js`,协议下拉单行 + 不代理列表;每个目标各一份)**:
  - **按目标配置,不是全局一份**:本机一份、每台远程服务器各一份(存在各自的档案里),互不影响 —— 哪台走代理、走哪个代理逐台配置。代理设置卡跟随当前目标(标题标明「· 本机 / · 远程 主机」),编辑与保存的都是该目标自己的;新增的服务器默认不走代理
  - **支持 SOCKS(v4/v5)**:代理协议下拉选择 —— HTTP / HTTPS 归为一类,SOCKS5 / SOCKS4 各一项;兼容旧版分协议表与单一地址,自动迁移
  - 不代理的地址列表:每行一条,支持通配符(`*.internal.example.com`)与网段(`192.168.0.0/16`);`127.0.0.1 / ::1 / localhost` 始终直连
  - 启用/关闭在目标条上的**盾形代理开关**(高亮+对勾=当前目标的代理已启用);代理设置卡仅保存配置、不改变启用状态
  - **本机**:本机那份代理用于本机子进程(系统指令注入 `HTTP(S)_PROXY / ALL_PROXY / NO_PROXY`)与内嵌页面(`session.setProxy`)。内嵌页面的请求总是从本机发出,所以无论当前目标是哪台远程,页面都用本机这份;已配置的远程主机自动直连
  - **远程**:每台服务器那份代理在 **Pi Web 启动时注入**(环境变量前缀挂在 nohup 命令上,作用于服务的出站 API 流量),运行中的服务重启后生效;地址按该服务器的网络填写。地址是回环(127.0.0.1/localhost)时视为本机(运行本应用的电脑)上的代理,经 **SSH 反向隧道**(`ssh -R` 语义,端口 17890 起)送达,对服务器零侵入,断开连接即失效。远程的 npm 检测/安装命令不注入代理,走远程自身网络;**远程 SSH 终端会话同样注入这份代理**(在终端配置里可关)
  - 可选自定义 npm registry(镜像源),所有目标共用
- **旧版配置自动迁移**:v1.1.3 及更早只有全局一份代理。升级后它成为「本机」的代理,每台已有服务器各继承一份地址相同的,启用状态跟随当时「远程模式是否使用代理」(旧开关缺省为使用)—— 行为不变,之后可逐台修改
- **端口占用检测**:启动前探测默认端口(30141)
  - 若已有**外部启动**的 Pi Web(本地端口被占 / 远程端口已有服务),直接内嵌复用并标注「外部」;外部服务消失时自动感知
  - 外部实例默认不代停;点「停止」时远程模式会弹原生确认框,知情后可**强制结束**(宽匹配该端口上的 Pi Web 并结束端口监听进程),本地模式仍仅提示
  - 更新前若发现外部 Pi Web 占用端口(文件锁会导致 EBUSY),会明确提示先停止(或用上述强制结束)
- **服务地址(URL)**:本地与远程统一为一个服务地址 —— 本地 `http://127.0.0.1:端口`、远程 `http://主机:端口`,服务卡实时显示并可一键复制;环境检测、版本更新、启停、内嵌页最终都落到这个地址
- **孤儿进程回收**:应用被强杀/崩溃/覆盖升级时遗留的 Pi Web,下次启动通过 pid 文件自动识别并回收为可停止状态(不会再被误判为「外部启动」而无法停止)。本地与远程均支持:远程按端口记录 `~/.pi-web-desktop/server-<端口>.pid`(兼容旧版共用的 `server.pid`),以「PID 存活 + 命令行确为本应用启动行」双重校验防 PID 复用误认领;SSH 管理连接意外断开不会把自有实例降级为「外部」
- **服务管理**:端口可配置(1024–65535),支持**应用启动模式**默认设置(跟随上次 / 固定本地 / 指定某台远程)、开机自启开关、启动/停止、服务日志、浏览器打开;修改端口并保存时若服务在运行会自动重启(远程改动端口时先按旧端口停掉旧实例);停止远程服务后会复核端口确实释放,停不掉会如实报错并保持运行态
- **主机指纹校验(TOFU)**:远程模式首次连接记录服务器公钥指纹(SHA-256),之后每次连接校验,不一致即拒绝,防范中间人

## 运行

```bash
npm install
npm start          # 启动应用
npm run smoke      # 无界面自检:环境检测结果 + 最新版本查询
node test/scripts-check.js        # 远程模式 stdin 脚本自检(无需 SSH)
node test/const-check.js          # 静态检查:const 声明的变量不得被重新赋值(严格模式下运行到才抛错,语法检查查不出)
node test/proxy-check.js          # 代理模块自检(分协议表/迁移/三类出口/按目标取配置/反向隧道前缀,离线)
node test/remote-tunnel.js        # SSH 反向隧道数据通路自检(替身 ssh2 + 本机真实 TCP 服务,离线)
node test/config-check.js         # 多服务器档案配置逻辑自检(含旧版全局代理 → 每台一份的迁移,离线)
node test/orphan-adopt.js         # 本地孤儿回收自检(拉起→强杀模拟→认领→停止,真实本地服务)
node test/remote-adopt.js         # 远程服务归属自检(认领/断连保持归属/停止复核,mock SSH 离线)
node test/remote-env-cache.js     # 远程环境检测缓存自检(各服务器各查各的/各存各的,mock SSH 离线)
node test/ipc-target.js           # IPC 按目标自检(检测按指明的目标执行;每个目标各自的代理视图,离线)
node test/code-server.js         # code-server 可选组件自检(地址解析/检测/安装/按需启动与回收/密码,离线)
node test/local-editor.js         # 本机编辑器真实 CLI 自检(含空格/特殊字符路径、非零退出与启动失败)
node test/ipc-editor.js           # IPC「code-server 打开当前项目」自检(没装→询问→安装→按需启动→登录密码,离线)
node test/renderer-target.js      # 渲染层按目标自检(假 DOM 真加载 app.js:环境检测/代理切 Tab、晚到响应、多服务同时运行、code-server 按钮、SSH 终端)
node test/term.js                 # SSH 终端自检(会话生命周期/断连联动/启动脚本:真彩色·locale 兜底·代理继承·tmux 路径/Alt+V 剪贴板三态/SFTP 上传与文件名 sanitize,离线)
node test/term-runtime.js [user@host]   # SSH 终端运行时 E2E(隔离实例 + CDP 驱动 + 真实 SSH:渲染器与 Unicode 宽度/键入回显/COLORTERM·locale·代理环境/Shift+Enter/Ctrl+V 原样送达/Alt+V 文本与截图上传/链接 Ctrl+单击(主进程调试口替换 shell.openExternal,不弹浏览器)/视图重排/tmux 断线保活与重连恢复)
node test/ui-runtime.js [user@host]     # 控制台卡片/cs 配置卡/启动视图/终端工具栏 运行时 E2E(隔离实例 + CDP 驱动 + 真实 SSH)
node test/titlebar-runtime.js [--shots]  # 无边框窗口运行时验证(Windows:命中测试拖拽区与窗口按钮、最窄窗口布局、弹窗;--shots 另存各视图窗口截图)
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
  proxy.js         # 代理独立模块:分协议表+不代理列表(每个目标各一份) → session 配置 / 本地子进程 env / 远程命令前缀
  config.js        # 配置持久化(userData/config.json)
  env.js           # 本地环境检测(node/npm/pi/Pi Web)与最新版本查询
  server.js        # 本地 Pi Web 服务管理:启动/停止/端口探测/外部实例识别
  remote.js        # SSH 连接层(ssh2):远程执行、反向隧道(远程回环端口 → 本机服务)、TOFU 指纹
  code-server.js   # code-server 可选组件:检测 / 一键安装(官方独立发行包)/ 按需启动与退出回收 / 登录密码
  remote-env.js    # 远程环境检测与版本查询(经 SSH,stdin 脚本采集全局包信息)
  remote-server.js # 远程 Pi Web 服务生命周期:nohup 启停、日志轮询、存活看门狗
  term.js          # SSH 终端会话:登录 shell 启动脚本(真彩色 / locale 兜底 / 代理 / tmux 保活)、PTY 通道、SFTP 上传
  ipc.js           # IPC handlers(config/env/update/server/shell/remote/editor,按模式路由)
renderer/
  index.html       # 两个页面:控制台(模式切换+远程配置) + 内嵌服务页(webview)
  style.css
  app.js           # 页面逻辑与事件(本机/各远程各自维护服务状态、检测结果与代理)
  vendor/xterm/    # xterm.js 6.0.0 + addon-fit 0.11 / unicode11 0.9 / web-links 0.12 / webgl 0.19(UMD 产物,见 LICENSE-xterm.txt)
test/
  scripts-check.js    # 远程 stdin 脚本自检
  const-check.js      # 静态检查:const 不得被重新赋值
  integration.js      # 本地集成测试
  orphan-adopt.js     # 本地孤儿回收自检(真实本地服务)
  remote-adopt.js     # 远程服务归属自检(mock SSH,离线)
  remote-tunnel.js    # SSH 反向隧道数据通路自检(替身 ssh2,离线)
  remote-env-cache.js # 远程环境检测缓存自检(mock SSH,离线)
  ipc-target.js       # IPC 按目标自检(离线)
  ipc-editor.js       # IPC「code-server 打开当前项目」自检(离线)
  code-server.js      # code-server 可选组件自检(离线)
  helpers/fake-code-server.js # code-server 测试替身:SSH 通道应答 + 真实监听端口的假 code-server
  renderer-target.js  # 渲染层按目标自检(假 DOM,离线)
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
    "enabled": false,
    "protocol": "http",
    "host": "",
    "port": 0,
    "bypass": ""
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
      "hostFingerprint": "…sha256 hex…",
      "proxy": {
        "enabled": true,
        "protocol": "http",
        "host": "172.21.170.62",
        "port": 10808,
        "bypass": "192.168.0.0/16\n172.16.0.0/12\n10.0.0.0/8\n*.internal.example.com"
      }
    },
    {
      "id": "r2",
      "host": "10.0.0.8",
      "port": 22,
      "user": "ubuntu",
      "keyPath": "~/.ssh/id_rsa.work",
      "remotePort": 30141,
      "hostFingerprint": "",
      "codeServerUrl": "",
      "proxy": {
        "enabled": false,
        "protocol": "http",
        "host": "10.0.0.8",
        "port": 7890,
        "bypass": ""
      }
    }
  ]
}
```

`mode` 为 `local` / `remote`;`remotes` 是远程服务器档案列表(应用内「新增/删除」维护),`activeRemoteId` 指向当前操作的档案;`defaultMode`/`defaultRemoteId` 为应用启动模式默认设置(`last` 跟随上次 / `local` 固定本地 / `remote` 固定远程并激活 `defaultRemoteId` 指定的档案)。本地与所有远程服务可同时运行。`keyPath` 留空时按 `~/.ssh/id_rsa`、`~/.ssh/id_ed25519` 顺序查找;`hostFingerprint` 由应用在首次连接成功后自动写入。

`codeServerUrl`(可选,本机与每个远程档案各一个)指定「编辑器」按钮远程打开的地址(code-server);留空则经 SSH 读那台服务器上 code-server 自身的监听配置(没写按 `8080`)。

终端配置为所有目标共用:`termTheme` 选主题预设(见上),`startupView` 决定启动后自动进入的视图(`''` / `web` / `term`),`termShiftEnter`(默认 `true`)是否把 Shift+Enter 映射成输入框内换行,`termProxy`(默认 `true`)终端会话是否继承**当前目标**的代理,`termTmux`(默认 `false`)是否用 tmux 做断线保活。后三项改的是「新开的会话怎么起」,已在运行的会话不变;旧配置缺少这些字段时按默认值处理。

代理按目标各一份:顶层 `proxy` 是**本机**的代理,每个远程档案的 `proxy` 是**那台服务器**自己的(协议 `http` 涵盖 HTTPS)。v1.1.3 及更早版本的配置只有顶层一份全局代理 —— 读取时自动迁移:它成为本机的代理,每台已有服务器各继承一份,启用状态跟随当时的「远程模式也使用代理」开关。

## 免密 RSA 配置指引

远程模式要求私钥认证且私钥无 passphrase:

```bash
ssh-keygen -t rsa -b 4096              # 一路回车(不设 passphrase)
ssh-copy-id user@远程主机               # 或手动把 ~/.ssh/id_rsa.pub 追加到远程 ~/.ssh/authorized_keys
ssh user@远程主机 'echo ok'             # 验证免密生效
```

远程机器需已安装 Node.js 与 npm(Pi Web 一键安装可在应用内完成)。

## 常见问题

- **更新报 EBUSY / 文件被占用**:有 Pi Web 进程占着包目录。若是本应用启动的(含上次遗留、已被自动认领回收的),更新时会自动停止;若是外部启动的,会提示具体的主机与端口,请在该服务器上手动停止。
- **「该 Pi Web 由外部启动,无法停止」**:v1.1.3 起远程模式不会再对自己启动的实例误报 —— SSH 断开保持归属、重启后凭 pid 文件认领;确实不是本应用启动的,点「停止」并在确认框中选择「强制结束」即可(会结束该端口上的全部进程)。
- **检查更新失败**:多为网络/代理问题,确认代理地址可达,或填写国内 registry 镜像。(本机的检测/安装命令走本机那份代理,可用目标条上的盾形开关关闭;远程的检测/安装命令不注入代理,走那台服务器自身网络。)
- **远程服务页打不开(超时)**:远程 Pi Web 需监听 0.0.0.0 且防火墙放行服务端口(应用启动的实例已自动监听 0.0.0.0);外部手动启动的实例若只监听 127.0.0.1 将无法直连接入。
- **远程走代理失败**:代理地址按**该服务器**的网络填写,确认从那台服务器可达;填 `127.0.0.1` 表示用本机(运行本应用的电脑)上的代理,经 SSH 反向隧道送达 —— 此时远程 sshd 需允许 TCP 转发(`AllowTcpForwarding yes`),且代理需接受来自远程的回环连接。代理在该服务器的 Pi Web 启动时注入:改了之后要重启它的服务才生效。socks 代理对 npm 生效需 npm ≥ 7(支持 socks 代理地址)。
- **pi 未检测到**:Pi Web 依赖 pi CLI,先全局安装 pi 后点「重新检测」。(远程模式在远程机器上检测/安装。)
- **SSH 认证失败**:私钥方式确认公钥已加入远程 `~/.ssh/authorized_keys` 且私钥未设 passphrase;密码方式确认用户名密码正确、服务器未禁用密码登录(`PasswordAuthentication yes`)。
- **主机指纹校验失败**:远程服务器重装/换 IP 后公钥变化会被拒绝;确认安全后删除配置文件中对应档案的 `hostFingerprint` 重新连接。
- **远程找不到 node/npm/Pi Web**:应用已用登录+交互 shell(`bash -ilc`)执行远程命令以加载 nvm 等 PATH;若仍失败,确认远程 `ssh user@host 'bash -ilc "node -v"'` 可用。
- **「编辑器」按钮(远程)**:那台服务器没装 code-server 时会问要不要装(可选组件,取消即可)。一键安装下载 code-server 官方的独立发行包(约 270MB),先走该服务器自己的代理设置、不行再试直连;两边都不通会报「下载 code-server 失败」—— 确认它能访问 github.com,或在它的代理设置里配一个可用代理。不需要 root,但磁盘要留出约 1.2GB。只支持 Linux amd64 / arm64;本机目标不提供安装。装了但没在运行时,点按钮才会启动,应用退出时回收。
- **code-server 窗口停在登录页**:密码会自动复制到剪贴板并弹出提示(该服务器 `~/.config/code-server/config.yaml` 里的 `password`),直接粘贴即可。自己装的 code-server 若监听在回环地址(`127.0.0.1`)且没在运行,本应用启动它时会改为监听 `0.0.0.0`(仅本次启动,不改配置文件);它已经在运行时则原样使用。
- **终端里 Claude Code 的 Shift+Enter 不换行**:确认「终端配置」里的「Shift+Enter 在输入框内换行」没被关掉(改完对新开的会话生效);Claude Code 自带的两条换行方式也一直可用:`Ctrl+J`,或行尾打一个 `\` 再回车。**pi(1.6 实测)里 Shift+Enter 仍是提交**,与映射前相同,这个开关对它没有影响
- **开了断线保活却提示服务器没有 tmux**:服务器上需要有 tmux(系统包或放在登录 shell PATH 里的位置都行 —— 应用用登录 shell 找到它的绝对路径再执行)。本应用的保活会话在独立的 `tmux -L pi-web-desktop` 服务端里,不会碰到你自己平时用的 tmux 会话;想彻底清掉就在服务器上执行 `tmux -L pi-web-desktop kill-server`。
- **终端里的命令不走代理 / 走了不该走的代理**:终端会话只继承**当前服务器那份**代理,且可在「终端配置」里关掉;地址填回环(`127.0.0.1`/`localhost`)表示用运行本应用的电脑上的代理,经 SSH 反向隧道送达,要求远程 sshd 允许 TCP 转发。
- **终端里的链接点不开**:需要按住 Ctrl(⌘)再单击(直接单击是定位光标/选词);链接只认 http/https,地址交给系统默认浏览器打开,应用内不会新开窗口。
- **没能从服务页识别出当前项目**:先在 Pi Web 里打开一个项目;若 Pi Web 改版导致识别路径全部失效,可到 [Issues](https://github.com/itwalker-001/Pi-Web-Desktop/issues) 反馈。
- **顶栏没有「另有 N 个在运行」**:应用启动时只探测当前目标的服务状态;其它服务器(和本机)的服务要切换过去访问一次后,才会被计入。
