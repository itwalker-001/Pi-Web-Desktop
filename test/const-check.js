// 静态检查:const 声明的变量不得在后续代码中被重新赋值。
// 运行:node test/const-check.js
'use strict';

// 为什么要单独做这个检查:'use strict' 下给 const 重新赋值会抛 TypeError,但只有执行到那一行才会暴露 ——
// 2026-11-25 这个检查(当时是临时脚本)一下抓到两个已发布版本里的真实 bug:
//   renderer/app.js otherRunningCount:const n 之后 n += 1 → 多台服务同时运行时切换目标抛异常,界面刷新中断;
//   lib/proxy.js remoteEnvPrefix:const ensure 之后再赋值 → 反向隧道路径抛异常并被调用处吞掉,远程 pi-web 不带代理静默启动。
// 两者所在的分支测试都没覆盖到,静态语法检查(node --check)也查不出来。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['renderer/app.js', 'main.js', 'preload.js', ...fs.readdirSync(path.join(ROOT, 'lib')).filter((x) => x.endsWith('.js')).map((x) => 'lib/' + x)];

const hits = [];
for (const f of FILES) {
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const decl = lines[i].match(/^\s*const ([A-Za-z_$][\w$]*) = /);
    if (!decl) continue;
    const name = decl[1].replace(/\$/g, '\\$');
    const indent = lines[i].match(/^\s*/)[0].length;
    const assign = new RegExp('(^|[^.\\w$])' + name + '\\s*(\\+=|-=|\\*=|/=|\\+\\+|--|=[^=])');
    // 只看同一语句块内、同层的 return / 块结束之前的若干行
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
      const line = lines[j];
      const lineIndent = line.match(/^\s*/)[0].length;
      if (lineIndent <= indent && /^(return\b|\})/.test(line.trim())) break;
      if (assign.test(line.replace(/\/\/.*$/, ''))) {
        hits.push(`${f}:${j + 1}  const ${decl[1]}(第 ${i + 1} 行声明)被重新赋值 → ${line.trim().slice(0, 90)}`);
      }
    }
  }
}

if (hits.length) {
  console.log('FAIL: 发现 const 变量被重新赋值(运行到该行会抛 TypeError):');
  for (const h of hits) console.log('  ' + h);
  process.exit(1);
}
console.log(`const 重新赋值检查: 通过(${FILES.length} 个文件)`);
