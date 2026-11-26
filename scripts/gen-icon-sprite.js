'use strict';
// 生成 / 核对 index.html 顶部的内联图标符号表(<svg class="icon-sprite"> 里的 <symbol id="i-…">)。
// 界面图标一律用 Iconoir(24 网格、描边 1.5);项目没有构建步骤、CSP 也不允许外链,所以把官方 SVG 内联成符号表,各处 <use> 引用。
// 手抄路径容易出错:增减图标时改下面的 MAP,再用本脚本重新生成。
//
// 源文件(脚本只读取 SVG 文本,不执行包内任何代码):
//   Iconoir       npm 包 iconoir 的 icons/ 目录(下有 regular/ solid/)  ——  例:npm pack iconoir 后解包
//   Simple Icons  npm 包 simple-icons 的 icons/ 目录(只用到 nodedotjs.svg、npm.svg,CC0)
//   pi 的 logo    renderer/vendor/icons/pi-logo.svg(产品方提供的三色 π)
//
// 用法:
//   node scripts/gen-icon-sprite.js <Iconoir icons 目录> [--si <Simple Icons icons 目录>] [--write]
//       不带 --write:把符号表打印到 stdout;带 --write:原位替换 renderer/index.html 里的符号表
//   node scripts/gen-icon-sprite.js <Iconoir icons 目录> --si <Simple Icons icons 目录> --check
//       只核对 index.html 里的符号表与源文件是否一致(退出码 0 = 一致),不写任何文件
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'renderer', 'index.html');
const PI_LOGO = path.join(ROOT, 'renderer', 'vendor', 'icons', 'pi-logo.svg');

// [符号 id, Iconoir 文件(相对 icons 目录), 可选:包一层缩放]
const iconoir = (id, rel, scale) => ({ id, file: rel, scale });
const MAP = [
  iconoir('i-play', 'solid/play'),
  iconoir('i-stop', 'regular/square', 0.72), // Iconoir 没有 stop:取 square 实心化并缩到 72%,和实心的 play 配成一对
  iconoir('i-open', 'regular/open-new-window'),
  iconoir('i-browser', 'regular/open-in-browser'),
  iconoir('i-star', 'regular/star'),
  iconoir('i-page', 'regular/page'),
  iconoir('i-refresh', 'regular/refresh'),
  iconoir('i-terminal', 'regular/terminal'),
  iconoir('i-arrow-left', 'regular/arrow-left'),
  iconoir('i-code', 'regular/code'),
  iconoir('i-brackets', 'regular/code-brackets-square'),
  iconoir('i-computer', 'regular/computer'),
  iconoir('i-server', 'regular/server'),
  iconoir('i-server-connection', 'regular/server-connection'),
  iconoir('i-edit', 'regular/edit-pencil'),
  iconoir('i-xmark', 'regular/xmark'),
  iconoir('i-xmark-circle', 'regular/xmark-circle'),
  iconoir('i-plus', 'regular/plus'),
  iconoir('i-network', 'regular/network'),
  iconoir('i-copy', 'regular/copy'),
  iconoir('i-floppy', 'regular/floppy-disk'),
  iconoir('i-check', 'regular/check'),
  iconoir('i-warning', 'regular/warning-triangle'),
  iconoir('i-warning-circle', 'regular/warning-circle'),
  iconoir('i-help-circle', 'regular/help-circle'),
  // 字段标题前的小图标
  iconoir('i-home', 'regular/home'),
  iconoir('i-db', 'regular/database'), // 「端口」:层叠的圆柱
  iconoir('i-link', 'regular/link'),
  iconoir('i-lock', 'regular/lock'),
  iconoir('i-info', 'regular/info-circle'),
  iconoir('i-tv', 'regular/modern-tv'),
  iconoir('i-window-tabs', 'regular/window-tabs'),
  iconoir('i-package', 'regular/package'),
];

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

// 取 <svg> 外壳里的内容与根节点属性
function readInner(file) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { fail('读不到文件:' + file); }
  const open = src.match(/<svg\b([^>]*)>/);
  if (!open || !src.includes('</svg>')) fail('不是 SVG 文件:' + file);
  let inner = src.slice(open.index + open[0].length, src.lastIndexOf('</svg>'));
  inner = inner.replace(/<title>[\s\S]*?<\/title>/g, '').replace(/\s*\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (/<(script|style|animate|set|foreignObject|image|use)\b/i.test(inner)) fail(file + ' 含脚本 / 外链 / 动画标签,不应内联');
  return { inner, root: open[1] };
}

function build(iconoirDir, siDir) {
  const entries = MAP.map((m) => ({ ...m, file: path.join(iconoirDir, m.file + '.svg'), kind: 'iconoir' }));
  if (siDir) {
    entries.push({ id: 'i-node-logo', file: path.join(siDir, 'nodedotjs.svg'), kind: 'brand', fill: '#5FA04E', viewBox: '0 0 24 24' });
    entries.push({ id: 'i-npm-logo', file: path.join(siDir, 'npm.svg'), kind: 'brand', fill: '#CB3837', viewBox: '0 0 24 24' });
  }
  if (fs.existsSync(PI_LOGO)) entries.push({ id: 'i-pi-logo', file: PI_LOGO, kind: 'brand', fill: null, viewBox: '135 135 530 530' });

  return entries.map((m) => {
    const { inner, root } = readInner(m.file);
    let body = inner;
    let viewBox;
    if (m.kind === 'iconoir') {
      viewBox = (root.match(/viewBox="([^"]+)"/) || [])[1];
      if (viewBox !== '0 0 24 24') fail(`${m.id}: ${m.file} 的 viewBox 不是 24 网格(${viewBox})`);
      // 官方文件里没写线帽 / 转角的图形按 SVG 默认值(平头 / 直角)渲染;页面的 .icon 不设这两项,
      // 这里显式写出来,保证内联后和官方画出来的完全一样
      body = body.replace(/<(path|rect|circle|line|polyline|polygon)\b([^>]*?)\s*(\/?)>/g, (whole, tag, attrs, close) => {
        let a = attrs;
        if (!/\bstroke-linecap=/.test(a)) a += ' stroke-linecap="butt"';
        if (!/\bstroke-linejoin=/.test(a)) a += ' stroke-linejoin="miter"';
        return `<${tag}${a} ${close}>`;
      });
      if (m.scale) body = `<g transform="translate(12 12) scale(${m.scale}) translate(-12 -12)">${body}</g>`;
    } else if (m.fill) {
      viewBox = m.viewBox;
      body = body.replace(/<(path|rect|circle|polygon)\b([^>]*?)\s*(\/?)>/g, (whole, tag, attrs, close) =>
        (/\bfill=/.test(attrs) ? whole : `<${tag}${attrs} fill="${m.fill}" ${close}>`));
    } else {
      viewBox = m.viewBox; // pi 的 logo:三色已写在各条路径上,原样保留
    }
    return { id: m.id, line: `    <symbol id="${m.id}" viewBox="${viewBox}">${body}</symbol>` };
  });
}

function parseArgs(argv) {
  const out = { write: false, check: false, si: '', positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--check') out.check = true;
    else if (a === '--si') out.si = argv[++i] || '';
    else if (a.startsWith('--si=')) out.si = a.slice(5);
    else out.positional.push(a);
  }
  return out;
}

// index.html 里符号表所在的那一段:从 <svg class="icon-sprite" 到它后面第一个 </svg>
function locate(html) {
  const start = html.indexOf('  <svg class="icon-sprite"');
  const end = html.indexOf('</svg>', start);
  if (start < 0 || end < 0) fail('index.html 里找不到图标符号表(<svg class="icon-sprite"> … </svg>)');
  return { start, end: end + '</svg>'.length };
}

const args = parseArgs(process.argv.slice(2));
const iconoirDir = args.positional[0];
if (!iconoirDir || args.positional.length !== 1) fail('用法见文件头注释:node scripts/gen-icon-sprite.js <Iconoir icons 目录> [--si <Simple Icons icons 目录>] [--write | --check]');
if (!fs.existsSync(iconoirDir)) fail('Iconoir icons 目录不存在:' + iconoirDir);

const symbols = build(path.resolve(iconoirDir), args.si ? path.resolve(args.si) : '');

if (args.check) {
  const html = fs.readFileSync(HTML, 'utf8');
  const { start, end } = locate(html);
  const block = html.slice(start, end);
  const current = [...block.matchAll(/<symbol id="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)].map((m) => ({ id: m[1], body: m[2] }));
  const drift = [];
  for (const s of symbols) {
    const hit = current.find((c) => c.id === s.id);
    if (!hit) drift.push(`${s.id}:index.html 里没有`);
    else if (hit.body !== s.line.slice(s.line.indexOf('>') + 1, s.line.lastIndexOf('</symbol>'))) drift.push(`${s.id}:与源文件不一致`);
  }
  for (const c of current) if (!symbols.some((s) => s.id === c.id)) drift.push(`${c.id}:源文件列表(MAP)里没有`);
  if (drift.length) { console.log('FAIL: 图标符号表与源文件不一致:\n  ' + drift.join('\n  ')); process.exit(1); }
  console.log(`图标符号表核对: 通过(${symbols.length} 个符号,与源文件逐个一致)`);
} else if (args.write) {
  const html = fs.readFileSync(HTML, 'utf8');
  const { start, end } = locate(html);
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const block = ['  <svg class="icon-sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">', ...symbols.map((s) => s.line), '  </svg>'].join(eol);
  fs.writeFileSync(HTML, html.slice(0, start) + block + html.slice(end));
  console.log(`已写入 ${path.relative(ROOT, HTML)}:${symbols.length} 个符号`);
} else {
  console.log(['  <svg class="icon-sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">', ...symbols.map((s) => s.line), '  </svg>'].join('\n'));
}
