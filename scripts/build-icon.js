'use strict';

// 渲染 build/pi-icon.svg → 多尺寸 PNG → 打包 build/icon.ico
// 运行:npx electron scripts/build-icon.js(需要 Electron 环境做 SVG 光栅化)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [256, 128, 64, 48, 32, 24, 16];
const ROOT = path.join(__dirname, '..');

// 纯 Node 打包 ICO:PNG 直接嵌入 ICO 容器(Vista+ 支持)
function buildIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngs.forEach((p, i) => {
    const b = i * 16;
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, b); // width(0 = 256)
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, b + 1);
    dir.writeUInt8(0, b + 2); // 调色板色数
    dir.writeUInt8(0, b + 3); // reserved
    dir.writeUInt16LE(1, b + 4); // 颜色平面
    dir.writeUInt16LE(32, b + 6); // 位深
    dir.writeUInt32LE(p.buf.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += p.buf.length;
    return p.buf;
  });

  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)]);
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 800,
      frame: false,
      webPreferences: { offscreen: true },
    });
    await win.loadFile(path.join(ROOT, 'build', 'pi-icon.svg'));
    await new Promise((r) => setTimeout(r, 300)); // 等一帧确保光栅化完成

    const page = await win.webContents.capturePage();
    fs.mkdirSync(path.join(ROOT, 'build', 'icons'), { recursive: true });

    const pngs = SIZES.map((size) => {
      const resized = size === 800 ? page : page.resize({ width: size, height: size });
      const buf = resized.toPNG();
      fs.writeFileSync(path.join(ROOT, 'build', 'icons', `icon-${size}.png`), buf);
      return { size, buf };
    });

    const ico = buildIco(pngs);
    fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);
    console.log('[build-icon] OK:', SIZES.join('/'), '+ icon.ico', ico.length, 'bytes');
    app.exit(0);
  } catch (e) {
    console.error('[build-icon] FAIL:', e);
    app.exit(1);
  }
});
