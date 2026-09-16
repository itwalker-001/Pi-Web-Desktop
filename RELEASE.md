# Pi Web Desktop v1.0.3 发布说明

> `@agegr/pi-web` 的跨平台桌面端:环境检测、代理配置、pi/pi-web 一键安装与更新、多窗口内嵌 Web UI。

## 🆕 v1.0.3 新增

- **独立页面窗口支持粘贴/拖拽文件路径**:「新窗口」打开的页面与主窗口能力完全一致——聊天输入框里 Ctrl+V 粘贴复制的文件自动插入路径,拖入文件自动插入全部路径(此前新窗口缺少该能力)

## 🛠 v1.0.2 新增

- **服务页多窗口**:顶栏新增「新窗口」按钮,一键再开一个独立的 Pi Web 页面,可拖到不同显示器分屏使用;关闭窗口不影响后台服务
- **pi / pi-web 一键安装**:未安装时按钮自动变为「一键安装」,直接执行 `npm install -g <包名>@latest`;pi 未安装时自动回退官方包 `@earendil-works/pi-coding-agent`
- **环境检测 nvm 优先**:存在 nvm-windows 时优先使用当前激活版本的 Node,不再被 Program Files 下的旧版本遮蔽(修复"终端里有、应用检测不到");无 nvm 时自动补全 `%APPDATA%\npm`、`~/.local` 等常见目录

## 🛠 v1.0.1 基础能力(继承)

- **环境检测**:Node.js / npm / pi CLI / pi-web / 桌面端版本与状态一目了然
- **版本检测与一键更新**:对比 npm registry 最新版,一键执行 `npm install -g @agegr/pi-web@latest`,npm 输出实时回显;更新前自动停服、完成后自动恢复
- **pi-web 服务管理**:端口可配、开机自启、启停控制、服务日志、端口占用识别(外部实例自动接入复用,不误杀)
- **代理设置**:支持 http/https/socks5,作用于版本检测、更新与内嵌页面;本地服务始终直连;「代理路径」可视化展示各类流量走向
- **内嵌 Web UI**:Electron 内直接使用 pi-web 全部功能(会话、文件浏览器、Git worktree 切换)
- **窗口看门狗与自愈**:GPU 初始化失败时强制显示窗口,超时自动带 `--disable-gpu` 重启,二次启动自动恢复
- **粘贴文件路径**:向内嵌页面拖入/粘贴文件,自动把路径插入聊天输入框
- **兼容性修复**:socks5 代理下自动关闭 Node 24 原生环境代理(npm 走自带 socks 支持),避免子进程启动即崩

## 📦 下载

| 文件 | 平台 | 说明 |
|---|---|---|
| `Pi Web Desktop Setup 1.0.3.exe` | Windows x64 | 安装版(NSIS,可选目录) |
| `Pi Web Desktop 1.0.3.exe` | Windows x64 | 便携版,免安装 |
| `pi-web-desktop_1.0.3_amd64.deb` | Linux amd64 | Debian / Ubuntu 安装包 |

## 📖 安装与升级

**Windows**:关闭正在运行的旧版本后运行 `Setup 1.0.3.exe`;便携版直接双击。首次运行如提示 SmartScreen,选择「仍要运行」(应用未做代码签名)。

**Linux**:

```bash
sudo dpkg -i pi-web-desktop_1.0.3_amd64.deb
# 缺少依赖时:
sudo apt -f install
```

**使用前提**:系统需已安装 Node.js ≥ 18 与 npm;pi / pi-web 未安装时可直接使用应用内「一键安装」。pi-web 的会话数据与 pi CLI 共用(`~/.pi/agent`)。

## 📝 已知限制

- 应用与安装包未做代码签名,首次运行可能触发杀软/SmartScreen 提示
- Node 24 原生环境代理不支持 socks 协议:pi / pi-web 的上游流量在 socks 代理下为直连(npm 与内嵌页面正常走代理);需要 pi 走代理时请使用 http 代理地址(如 `http://<ip>:<端口>`,实测部分 socks 端口同时支持 http 代理协议)
- deb 包按 Ubuntu 24.04 制作,其他发行版未验证
