'use strict';

// 从 build/pi-icon.png 原图生成多尺寸 PNG 与 build/icon.ico(保留原图的形状、配色与渐变)。
// 运行:npx electron scripts/build-icon.js(使用 Electron 的 nativeImage 做高质量缩放)
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [256, 128, 64, 48, 32, 24, 16];
const ROOT = path.join(__dirname, '..');

// 原图的深色底留白很大。按彩色标志 / 白色浏览器徽标的边界裁出方图,
// 四周保留约 6% 安全边距;原始 PNG 不改,仅处理生成的显示资源。
function trimLogo(image) {
  const { width, height } = image.getSize();
  const pixels = image.toBitmap();
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      const high = Math.max(...channels), low = Math.min(...channels);
      if (pixels[offset + 3] < 128 || !((high > 110 && high - low > 45) || low > 150)) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) throw new Error('无法识别图标的前景边界');
  const size = Math.min(width, height, Math.ceil(Math.max(right - left + 1, bottom - top + 1) * 1.12));
  const x = Math.max(0, Math.min(width - size, Math.round((left + right + 1 - size) / 2)));
  const y = Math.max(0, Math.min(height - size, Math.round((top + bottom + 1 - size) / 2)));
  console.log(`[build-icon] 裁剪 ${width}×${height} → ${size}×${size}, 标志占比约 89%`);
  return image.crop({ x, y, width: size, height: size });
}

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

app.whenReady().then(() => {
  try {
    const source = nativeImage.createFromPath(path.join(ROOT, 'build', 'pi-icon.png'));
    if (source.isEmpty()) throw new Error('无法读取 build/pi-icon.png');
    const { width, height } = source.getSize();
    if (width !== height) throw new Error(`应用图标原图必须为正方形,实际为 ${width}×${height}`);
    fs.mkdirSync(path.join(ROOT, 'build', 'icons'), { recursive: true });
    const display = trimLogo(source);
    const webSource = nativeImage.createFromPath(path.join(ROOT, 'renderer', 'vendor', 'icons', 'pi-web.png'));
    if (webSource.isEmpty()) throw new Error('无法读取 Pi Web 品牌原图');
    const webDisplay = trimLogo(webSource);
    fs.writeFileSync(path.join(ROOT, 'renderer', 'vendor', 'icons', 'pi-web-display.png'), webDisplay.resize({ width: 128, height: 128, quality: 'best' }).toPNG());

    const pngs = SIZES.map((size) => {
      const resized = display.resize({ width: size, height: size, quality: 'best' });
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
