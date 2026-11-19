// 一次性:创建 GitHub Release 1.1.0 + 上传两个 exe(走指定代理)。运行后删除。
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO = 'itwalker-001/Pi-Web-Desktop';
const TAG = '1.1.0';
const PROXY = 'http://172.21.170.62:10808';
const ASSETS = ['Pi Web Desktop Setup 1.1.0.exe', 'Pi Web Desktop 1.1.0.exe'];

function log(m) { console.log(new Date().toLocaleTimeString(), m); }

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
    if (body) args.push('-d', JSON.stringify(body));
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

function releaseBody() {
  const md = fs.readFileSync(path.join(ROOT, 'RELEASE.md'), 'utf8');
  const start = md.indexOf('## 🆕 v1.1.0 新增');
  const end = md.indexOf('## 🛠 v1.0.3 新增');
  return start >= 0 ? md.slice(start, end > start ? end : undefined).trim() : md.slice(0, 2000);
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
