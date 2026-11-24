// 创建 GitHub Release + 上传安装包产物(走指定代理)。版本号取自 package.json,发版时无需改本文件:
// tag = 版本号(历史 tag 无 v 前缀),产物名 = `Pi Web Desktop[ Setup] <版本>.exe`,
// Release 正文 = RELEASE.md 里「## 🆕 v<版本>」那一段(到下一个二级标题为止)。运行:node scripts/release-publish.js
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'itwalker-001/Pi-Web-Desktop';
const VERSION = require('../package.json').version;
const TAG = VERSION;
const PROXY = 'http://172.21.170.62:10808';
const ASSETS = [`Pi Web Desktop Setup ${VERSION}.exe`, `Pi Web Desktop ${VERSION}.exe`];

function log(...m) { console.log(new Date().toLocaleTimeString(), ...m); }

function token() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8', timeout: 20000,
  });
  const m = (r.stdout || '').match(/^password=(.+)$/m);
  if (!m) throw new Error('未取到 GitHub 凭据(git credential fill)');
  return m[1].trim();
}

function api(url, method, tok, body, file) {
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', '900', '-x', PROXY, '-X', method, url,
    '-H', `Authorization: token ${tok}`,
    '-H', 'User-Agent: pi-web-desktop-release'];
  if (file) {
    args.push('-H', 'Content-Type: application/octet-stream');
    args.push('--data-binary', '@' + file);
  } else {
    args.push('-H', 'Accept: application/vnd.github+json');
    if (body) {
      // 坑:含 emoji 的 JSON 走 -d 会静默空响应 —— 写入 Windows 可见路径的临时文件再 --data-binary
      const tmp = path.join(os.tmpdir(), `pi-rel-body-${Date.now()}.json`);
      fs.writeFileSync(tmp, JSON.stringify(body));
      args.push('-H', 'Content-Type: application/json', '--data-binary', '@' + tmp);
    }
  }
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 920000 });
  const out = r.stdout || '';
  const nl = out.lastIndexOf('\n');
  const code = nl >= 0 ? out.slice(nl + 1).trim() : '';
  const bodyText = nl >= 0 ? out.slice(0, nl) : out;
  if (r.status !== 0 || !bodyText) {
    console.log('  curl 诊断: exit=' + r.status, 'http=' + code, 'stderr=' + String(r.stderr || '').slice(0, 200));
  }
  try { return JSON.parse(bodyText || '{}'); } catch { return { raw: bodyText.slice(0, 300), http: code }; }
}

// Release 正文:RELEASE.md 里「## 🆕 v<版本>」那一段,到下一个二级标题(下一个版本的段落)为止
function releaseBody() {
  const md = fs.readFileSync(path.join(ROOT, 'RELEASE.md'), 'utf8');
  const start = md.indexOf(`## 🆕 v${VERSION}`);
  if (start < 0) throw new Error(`RELEASE.md 里没有「## 🆕 v${VERSION}」段落`);
  const rest = md.slice(start);
  const next = rest.match(/\n## (?!#)/); // 下一个二级标题(### 小节不算;本段首行不以 \n 开头,不会自匹配)
  return (next ? rest.slice(0, next.index) : rest).trim();
}

(async () => {
  const tok = token();
  log('凭据 OK');

  // 已存在则复用
  let rel = api(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, 'GET', tok);
  if (!rel.id) {
    rel = api(`https://api.github.com/repos/${REPO}/releases`, 'POST', tok, {
      tag_name: TAG,
      name: `v${TAG}`,
      body: releaseBody(),
      draft: false,
      prerelease: false,
    });
    log('创建 Release:', rel.id ? `id=${rel.id}` : JSON.stringify(rel).slice(0, 300));
  } else {
    log('Release 已存在: id=' + rel.id);
  }
  if (!rel.id) process.exit(3);

  // 上传产物(已存在的资产先跳过)
  const existing = new Set((rel.assets || []).map((a) => a.name));
  for (const name of ASSETS) {
    if (existing.has(name)) { log('已上传,跳过:', name); continue; }
    const f = path.join(ROOT, 'dist', name);
    if (!fs.existsSync(f)) { log('缺少产物:', name); continue; }
    const size = (fs.statSync(f).size / 1024 / 1024).toFixed(1);
    log(`上传 ${name} (${size} MB) …`);
    const up = api(`https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
      'POST', tok, null, f);
    log('  →', up.state || up.message || JSON.stringify(up).slice(0, 200), up.browser_download_url || '');
  }

  const final = api(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, 'GET', tok);
  log('Release 地址:', final.html_url);
  log('资产:', (final.assets || []).map((a) => `${a.name}(${(a.size / 1024 / 1024).toFixed(1)}MB)`).join(', '));
  console.log('RELEASE_DONE');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
