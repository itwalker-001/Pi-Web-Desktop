// config.js 多档案逻辑离线测试(mock electron 的 app.getPath,使用临时目录)。
// 运行:node test/config-check.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-web-desktop-cfg-'));
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'electron') {
    return { app: { getPath: () => tmpDir } };
  }
  return origLoad.apply(this, [request, ...args]);
};

const config = require('../lib/config');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('PASS:', msg);
}

function main() {
  // 1. 默认值
  let cfg = config.get();
  assert(cfg.mode === 'local', '默认 mode=local');
  assert(cfg.defaultMode === 'last' && cfg.defaultRemoteId === '', '默认启动模式 = 跟随上次');
  assert(Array.isArray(cfg.remotes) && cfg.remotes.length === 0, '默认 remotes 为空数组');
  assert(cfg.remote === null, '无档案时 computed remote 为 null');

  // 2. 新增多档案
  cfg = config.save({
    remotes: [
      { id: 'r1', host: '192.168.1.100', user: 'root', remotePort: 30141 },
      { id: 'r2', host: '10.0.0.8', user: 'ubuntu', remotePort: 30141, keyPath: '~/.ssh/id_work' },
    ],
    activeRemoteId: 'r2',
  });
  assert(cfg.remotes.length === 2, '保存两台服务器档案');
  cfg = config.save({ defaultMode: 'remote', defaultRemoteId: 'r2' });
  assert(cfg.defaultMode === 'remote' && cfg.defaultRemoteId === 'r2', '启动模式可设为指定远程');
  cfg = config.save({ defaultMode: 'last', defaultRemoteId: '' });
  assert(cfg.remote && cfg.remote.id === 'r2' && cfg.remote.host === '10.0.0.8', 'computed remote 指向激活档案 r2');
  assert(cfg.remotes[1].port === 22 && cfg.remotes[1].remotePort === 30141, '缺省字段归一(port=22, remotePort=30141)');

  // 3. 切换激活档案
  cfg = config.save({ activeRemoteId: 'r1' });
  assert(cfg.remote && cfg.remote.id === 'r1', '切换激活档案后 computed remote 跟随');

  // 4. 单档案补丁按 id 定位(TOFU 指纹写入路径)
  cfg = config.save({ remote: { id: 'r2', hostFingerprint: 'abc123' } });
  assert(cfg.remotes[1].hostFingerprint === 'abc123', '按 id 定位写入 hostFingerprint');
  assert(cfg.remote.id === 'r1', '补丁不改变激活档案');

  // 5. 非法 activeRemoteId 回退到首个档案
  cfg = config.save({ activeRemoteId: 'nope' });
  assert(cfg.activeRemoteId === 'r1' && cfg.remote.id === 'r1', '非法 activeRemoteId 回退 remotes[0]');

  // 6. 持久化内容不含计算属性 remote
  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  assert(!('remote' in raw) && Array.isArray(raw.remotes), '落盘 JSON 不含 computed remote,含 remotes 数组');

  // 7. 重新加载(缓存失效路径:直接读文件验证迁移)
  delete require.cache[require.resolve('../lib/config')];
  const config2 = require('../lib/config');
  const cfg2 = config2.get();
  assert(cfg2.remotes.length === 2 && cfg2.remote.id === 'r1', '重新加载后档案与激活项一致');

  // 8. 旧版单档案 remote → remotes[0] 迁移
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({ mode: 'remote', port: 30200, remote: { host: '1.2.3.4', user: 'root', hostFingerprint: 'ff' } }),
    'utf8'
  );
  delete require.cache[require.resolve('../lib/config')];
  const config3 = require('../lib/config');
  const cfg3 = config3.get();
  assert(cfg3.remotes.length === 1 && cfg3.remotes[0].host === '1.2.3.4' && cfg3.remotes[0].hostFingerprint === 'ff', '旧版单档案迁移为 remotes[0]');
  assert(cfg3.activeRemoteId === cfg3.remotes[0].id && cfg3.remote.host === '1.2.3.4', '迁移后激活指向该档案');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('config 多档案逻辑: 全部通过');
}

main();
