'use strict';

// 从 SVG 母版生成软件图标(ICO / 各尺寸 PNG)。源文件的 viewBox 已收紧留白,直接用 Chromium 渲染。
// 两份星耀标志各管一处:
//   build/pi-icon-dark.svg(深色底)= 软件图标:exe、快捷方式、任务栏、窗口左上角用的 build/icon.ico;
//   build/pi-icon.svg(透明底)= 界面里的品牌 Logo(顶栏、服务页工具栏),不进 ICO。
// 运行:npx electron scripts/build-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [256, 128, 64, 48, 32, 24, 16];
const ROOT = path.join(__dirname, '..');

// 离屏窗口关掉后不要走默认的退出流程,等文件都写完再 app.exit()。
app.on('window-all-closed', () => {});

function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach((p, i) => {
    const b = i * 16;
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, b);
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, b + 1);
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(p.buf.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += p.buf.length;
  });
  return Buffer.concat([header, dir, ...pngs.map(p => p.buf)]);
}

async function renderSvg(file) {
  const win = new BrowserWindow({
    show: false, width: 800, height: 800, frame: false,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    const svg = fs.readFileSync(file, 'utf8');
    // 作为图片而不是 SVG 文档加载:严格铺满正方形画布,不受源文件 width / height 影响。
    const image = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden"><img src="${image}" style="display:block;width:800px;height:800px"></body></html>`;
    await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    await win.webContents.executeJavaScript('Promise.all(Array.from(document.images, i => i.decode()))');
    await new Promise(resolve => setTimeout(resolve, 150));
    return await win.webContents.capturePage();
  } finally {
    win.destroy();
  }
}

app.whenReady().then(async () => {
  try {
    const display = await renderSvg(path.join(ROOT, 'build', 'pi-icon-dark.svg'));
    fs.mkdirSync(path.join(ROOT, 'build', 'icons'), { recursive: true });
    const pngs = SIZES.map(size => {
      const buf = display.resize({ width: size, height: size, quality: 'best' }).toPNG();
      fs.writeFileSync(path.join(ROOT, 'build', 'icons', `icon-${size}.png`), buf);
      return { size, buf };
    });
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(pngs));
    console.log('[build-icon] OK: ' + SIZES.join('/') + ' PNG + icon.ico');
    app.exit(0);
  } catch (error) {
    console.error('[build-icon] FAIL:', error);
    app.exit(1);
  }
});
