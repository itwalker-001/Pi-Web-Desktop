# Pi Web Desktop

`@agegr/pi-web` 的跨平台桌面端(Electron 封装):环境检测、代理配置、版本检测与一键更新、内嵌 pi-web Web UI。

## 功能

- **两个页面**
  - **控制台页**:环境检测 / 版本更新 / 服务配置与启动 / 代理设置
  - **服务页**:在 Electron 内直接使用 pi-web 的 Web UI(顶栏可返回控制台或用系统浏览器打开)
- **环境检测**:Node.js、npm、pi CLI、pi-web(全局包)、桌面端自身的版本,带状态指示
- **版本检测**:对比本地 pi-web 与 npm registry 最新版,徽标提示「已是最新 / 可更新 / 未安装 / 检测失败」
- **一键更新 / 一键安装**:pi 与 pi-web 均支持;已安装时执行 `npm install -g <pkg>@latest` 更新,未安装时按钮自动变为「一键安装」执行同一命令完成安装(pi 未安装时使用官方包 @earendil-works/pi-coding-agent)。npm 输出实时回显;更新前自动停掉本应用启动的服务,完成后自动重启
- **代理设置**:HTTP/HTTPS/SOCKS 代理,同时作用于
  - npm 版本检测与更新(注入 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量)
  - 内嵌页面的网络请求(`session.setProxy`)
  - 可选自定义 npm registry(镜像源)
  - 本地 pi-web 服务(127.0.0.1)始终不走代理
- **端口占用检测**:启动前探测默认端口(30141)
  - 若已有**外部启动**的 pi-web,直接内嵌复用并标注「外部」;本应用不代停外部进程,外部服务消失时自动感知
  - 更新前若发现外部 pi-web 占用端口(文件锁会导致 EBUSY),会明确提示先停止
- **服务管理**:端口可配置(1024–65535),支持开机自启开关、启动/停止、服务日志、浏览器打开;修改端口并保存时若服务在运行会自动重启

## 运行

```bash
npm install
npm start          # 启动应用
npm run smoke      # 无界面自检:环境检测结果 + 最新版本查询
node test/integration.js   # 集成测试:服务启停、外部实例识别、真实更新
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
  proc.js          # 子进程执行(流式输出)、代理环境变量、semver 工具
  config.js        # 配置持久化(userData/config.json)
  env.js           # 环境检测(node/npm/pi/pi-web)与最新版本查询
  server.js        # pi-web 服务管理:启动/停止/端口探测/外部实例识别
  ipc.js           # IPC handlers(config/env/update/server/shell)
renderer/
  index.html       # 两个页面:控制台 + 内嵌服务页(webview)
  style.css
  app.js           # 页面逻辑与事件
test/
  integration.js   # 集成测试
```

## 配置文件

`%APPDATA%/pi-web-desktop/config.json`(macOS/Linux 为用户数据目录):

```json
{
  "proxy": { "enabled": true, "url": "socks5://127.0.0.1:1080" },
  "registry": "",
  "port": 30141,
  "autoStart": true
}
```

## 常见问题

- **更新报 EBUSY / 文件被占用**:有 pi-web 进程占着包目录。若是本应用启动的,更新时会自动停止;若是外部启动的,请先手动停止。
- **检查更新失败**:多为网络/代理问题,确认代理地址可达,或填写国内 registry 镜像。
- **pi 未检测到**:pi-web 依赖 pi CLI,先全局安装 pi 后点「重新检测」。
