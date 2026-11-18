// lib/proxy.js 离线测试:协议下拉单行 / 旧版迁移 / 三类出口(session/childEnv/远程前缀)。
// 运行:node test/proxy-check.js
'use strict';

const proxy = require('../lib/proxy');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('PASS:', msg);
}

async function main() {
  let px;

  // 0. 新版协议下拉单行(当前 UI 形态)
  px = proxy.parseProxy({ proxy: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: 7890, bypass: '*.lan' } });
  assert(px.entries.socks && px.entries.socksVersion === 5 && !px.entries.http, '新版单行:socks5 协议映射到 SOCKS 行');
  assert(px.primaryUrl === 'socks5://127.0.0.1:7890' && px.protocol === 'socks5', '新版单行:primaryUrl/protocol 正确');
  px = proxy.parseProxy({ proxy: { enabled: true, protocol: 'http', host: 'h9', port: 9 } });
  assert(px.entries.http && px.entries.https && px.entries.http.host === 'h9', '新版单行:http 协议同时填 http+https 行');
  const scNew = proxy.sessionConfig({ proxy: { enabled: true, protocol: 'socks4', host: 's4', port: 4 } });
  assert(scNew.proxyRules === 'socks4=s4:4', '新版单行:session proxyRules socks4');

  // 1. 旧版分协议表解析
  px = proxy.parseProxy({
    proxy: {
      enabled: true,
      http: { host: '172.21.170.62', port: 10808 },
      socks: { host: '127.0.0.1', port: 7890, version: 5 },
      bypass: '192.168.0.0/16\n*.internal.example.com',
    },
  });
  assert(px.enabled === true, '分协议表:enabled');
  assert(px.entries.http && px.entries.http.port === 10808, '分协议表:http 行');
  assert(px.entries.socks && px.entries.socksVersion === 5, '分协议表:socks 行 v5');
  assert(px.primaryUrl === 'http://172.21.170.62:10808', 'primary 取 http 行');
  assert(px.protocol === 'http' && px.host === '172.21.170.62' && px.port === 10808, '分协议表:归一为单行形态');
  assert(px.bypassList.includes('192.168.0.0/16') && px.bypassList.includes('*.internal.example.com'), 'bypass 用户项保留');
  assert(px.bypassList.includes('127.0.0.1') && px.bypassList.includes('localhost') && px.bypassList.includes('::1'), 'bypass 默认直连项合并');

  // 2. 更早的单一 url 迁移
  px = proxy.parseProxy({ proxy: { enabled: true, url: 'socks5://127.0.0.1:1080' } });
  assert(px.entries.socks && px.entries.socks.host === '127.0.0.1' && px.entries.socksVersion === 5, '旧 url socks5:// → socks 行 v5');
  assert(px.primaryUrl === 'socks5://127.0.0.1:1080', '旧 url socks:primaryUrl 保持 socks 协议');
  px = proxy.parseProxy({ proxy: { enabled: true, url: 'http://172.21.170.62:10808' } });
  assert(px.entries.http && px.entries.https && px.entries.http.host === '172.21.170.62', '旧 url http:// → http+https 两行');
  assert(!proxy.parseProxy({ proxy: { enabled: true } }).enabled, '启用但无任何代理行 → 视为未启用');

  // 3. sessionConfig
  let sc = proxy.sessionConfig({ proxy: { enabled: false } });
  assert(sc.mode === 'system', '未启用 → session 跟随系统');
  sc = proxy.sessionConfig({
    proxy: {
      enabled: true,
      http: { host: 'h1', port: 1 },
      https: { host: 'h2', port: 2 },
      socks: { host: 'h3', port: 3, version: 4 },
      bypass: '10.0.0.0/8\n*.x.com',
    },
  });
  assert(sc.proxyRules === 'http=h1:1;https=h2:2;socks4=h3:3', 'session proxyRules 分协议拼接(socks4)');
  assert(sc.proxyBypassRules.includes('*.x.com') && !sc.proxyBypassRules.includes('10.0.0.0/8') && sc.proxyBypassRules.includes('<local>'), 'session bypass 过滤 CIDR、保留通配符、附加 <local>');
  // 远程主机自动进不代理列表(服务页直连)
  const scRemote = proxy.sessionConfig({
    remotes: [{ host: '172.16.10.131', remotePort: 30141 }],
    proxy: { enabled: true, protocol: 'http', host: 'h1', port: 1, bypass: '' },
  });
  assert(scRemote.proxyBypassRules.includes('172.16.10.131'), 'session bypass 自动加入已配置远程主机');

  // 4. childEnv(本地子进程系统指令;base 传空对象,避免宿主环境污染断言)
  let env = proxy.childEnv({ proxy: { enabled: true, http: { host: 'h1', port: 1 }, bypass: '*.foo.com\n192.168.0.0/16' } }, {});
  assert(env.HTTP_PROXY === 'http://h1:1' && env.http_proxy === 'http://h1:1', 'childEnv:HTTP_PROXY 注入');
  assert(env.NO_PROXY.includes('foo.com') && env.NO_PROXY.includes('192.168.0.0/16') && env.NO_PROXY.includes('127.0.0.1'), 'childEnv:NO_PROXY 通配符转后缀 + CIDR 保留 + 默认直连');
  assert(!('NODE_USE_ENV_PROXY' in env), 'childEnv:http 代理无需关闭原生代理');
  env = proxy.childEnv({ proxy: { enabled: true, url: 'socks5://127.0.0.1:1080' } }, {});
  assert(env.HTTP_PROXY === 'socks5://127.0.0.1:1080' && env.ALL_PROXY === 'socks5://127.0.0.1:1080', 'childEnv:纯 socks 时 HTTP(S)_PROXY 也指向 socks(兼容 npm)');
  assert(env.NODE_USE_ENV_PROXY === '0', 'childEnv:纯 socks → 关闭 Node 原生环境代理');
  env = proxy.childEnv({ proxy: { enabled: false } }, {});
  assert(!('HTTP_PROXY' in env) && !('NO_PROXY' in env), 'childEnv:未启用不注入');

  // 5. remoteEnvPrefix(远程系统指令)
  let pre = await proxy.remoteEnvPrefix({ proxy: { enabled: false } });
  assert(pre === '', '远程前缀:未启用 → 空');
  pre = await proxy.remoteEnvPrefix({ proxy: { enabled: true, remote: false, http: { host: 'h', port: 1 } } });
  assert(pre === '', '远程前缀:remote 关闭 → 空');
  pre = await proxy.remoteEnvPrefix({ proxy: { enabled: true, http: { host: '172.21.170.62', port: 10808 }, bypass: '*.foo.com' } });
  assert(pre.includes("http_proxy='http://172.21.170.62:10808'") && pre.includes("HTTP_PROXY='http://172.21.170.62:10808'"), '远程前缀:非本机代理直传地址');
  assert(pre.includes('no_proxy=') && pre.includes("'foo.com,127.0.0.1"), '远程前缀:no_proxy 注入');
  pre = await proxy.remoteEnvPrefix(
    { proxy: { enabled: true, socks: { host: '127.0.0.1', port: 7890, version: 5 } } },
    { resolveTunnel: async () => 17890 }
  );
  assert(pre.includes("http_proxy='socks5://127.0.0.1:17890'"), '远程前缀:本机 socks 代理 → SSH 反向隧道端口重写');
  pre = await proxy.remoteEnvPrefix(
    { proxy: { enabled: true, protocol: 'http', host: 'localhost', port: 7897 } },
    { resolveTunnel: async () => 17891 }
  );
  assert(pre.includes("https_proxy='http://127.0.0.1:17891'"), '远程前缀:localhost http 代理 → 隧道端口重写');

  console.log('proxy 模块: 全部通过');
}

main();
