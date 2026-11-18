// 发版守望:轮询网络(代理 7897 或直连),通了即自动 push + 创建 GitHub Release + 上传产物。
// 运行:node scripts/release-watch.js(后台);日志打 stdout。
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const REPO = 'itwalker-001/Pi-Web-Desktop';
const TAG = '1.1.0';
const ASSETS = ['Pi Web Desktop Setup 1.1.0.exe', 'Pi Web Desktop 1.1.0.exe'];
const POLL_MS = 30000;
const MAX_TRIES = 60; // 最长 ~30 分钟

function git(args, env) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function curlHead(url, proxy) {
  const args = ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '8', url];
  if (proxy) args.splice(1, 0, '-x', proxy);
  const r = spawnSync('curl', args, { encoding: 'utf8', timeout: 15000 });
  return r.stdout && r.stdout.trim().startsWith(('2'));
}

// 从 GCM 取 github.com 凭据(API token 用,不回显)
function githubToken() {
  try {
    const input = 'protocol=https\nhost=github.com\n\n';
    const r = spawnSync('git', ['credential', 'fill'], { input, encoding: 'utf8', timeout: 15000 });
    const m = (r.stdout || '').match(/^password=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function api(url, method, token, body, proxy, isAsset, file) {
  const args = ['-s', '--max-time', '600', '-X', method, url,
    '-H', `Authorization: token ${token}`,
    '-H', 'User-Agent: pi-web-desktop-release'];
  if (!isAsset) args.push('-H', 'Accept: application/vnd.github+json');
  if (body) args.push('-d', JSON.stringify(body));
  if (isAsset) {
    args.push('-H', `Content-Type: application/octet-stream`);
    args.push('--data-binary', `@${file}`);
  }
  if (proxy) args.splice(1, 0, '-x', proxy);
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 620000 });
  try { return JSON.parse(r.stdout || '{}'); } catch { return { raw: (r.stdout || '').slice(0, 300) }; }
}

function releaseBody() {
  // RELEASE.md 的 v1.1.0 段落作为 Release 正文
  const md = fs.readFileSync(path.join(ROOT, 'RELEASE.md'), 'utf8');
  const start = md.indexOf('## 🆕 v1.1.0 新增');
  const end = md.indexOf('## 🛠 v1.0.3 新增');
  return start >= 0 ? md.slice(start, end > start ? end : undefined).trim() : md.slice(0, 2000);
}

async function main() {
  for (let i = 1; i <= MAX_TRIES; i++) {
    const proxy = 'http://127.0.0.1:7897';
    const via = curlHead('https://github.com', proxy) ? proxy : (curlHead('https://github.com', null) ? 'direct' : null);
    if (!via) {
      console.log(`[${new Date().toLocaleTimeString()}] ${i}/${MAX_TRIES} 网络不通(代理/直连均不可达),${POLL_MS / 1000}s 后重试…`);
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    console.log(`[${new Date().toLocaleTimeString()}] 网络可用(${via === 'direct' ? '直连' : '代理 7897'}),开始发版`);

    const gp = via === 'direct' ? ['-c', 'http.proxy=', '-c', 'https.proxy='] : ['-c', `http.proxy=${via}`, '-c', `https.proxy=${via}`];

    // 1) push main + tag
    const p1 = git([...gp, 'push', 'origin', 'HEAD:main']);
    console.log('push main:', p1.code === 0 ? 'OK' : p1.out.slice(-200));
    if (p1.code !== 0) { console.log('push 失败,继续守望下一轮'); await new Promise((r) => setTimeout(r, POLL_MS)); continue; }
    const p2 = git([...gp, 'push', 'origin', `refs/tags/${TAG}`]);
    console.log('push tag:', p2.code === 0 ? 'OK' : p2.out.slice(-200));

    // 2) token + 创建 Release
    const token = githubToken();
    if (!token) { console.log('未取到 GitHub 凭据,停止(代码已推送,Release 请手动建)'); process.exit(2); }
    let rel = api(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, 'GET', token, null, via === 'direct' ? null : via);
    if (!rel.id) {
      rel = api(`https://api.github.com/repos/${REPO}/releases`, 'POST', token, {
        tag_name: TAG,
        name: `v${TAG}`,
        body: releaseBody(),
        draft: false,
        prerelease: false,
      }, via === 'direct' ? null : via);
    }
    if (!rel.id) { console.log('创建 Release 失败:', JSON.stringify(rel).slice(0, 300)); process.exit(3); }
    console.log('Release id =', rel.id, rel.html_url);

    // 3) 上传产物
    const uploadProxy = via === 'direct' ? null : via;
    for (const name of ASSETS) {
      const f = path.join(DIST, name);
      if (!fs.existsSync(f)) { console.log('缺少产物:', name); continue; }
      const url = `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`;
      const up = api(url, 'POST', token, null, uploadProxy, true, f);
      console.log('上传', name, ':', up.state || up.message || 'done');
    }
    console.log('RELEASE_DONE', rel.html_url);
    process.exit(0);
  }
  console.log('超时:30 分钟内网络未恢复,退出。网络恢复后重跑:node scripts/release-watch.js');
  process.exit(1);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
