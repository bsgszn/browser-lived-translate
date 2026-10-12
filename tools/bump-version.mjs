// 版本号唯一的真相在 manifest.json。这个脚本负责把它同步到 package.json，
// 并在改完之后提醒你去更新那些"必须和版本一起动"的地方。
//
//   node tools/bump-version.mjs 1.3.0
//   node tools/bump-version.mjs patch      # 自动 +0.0.1
//
// 存在的理由：这个项目被"改了代码但版本号没动，用户无法判断加载的是哪个构建"
// 坑过不止一次。有脚本至少让这件事变成一条命令。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot } from './snapshot.mjs';
import { commitAll, findGit, isDirty, isRepo } from './git.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(ROOT, 'manifest.json');
const packagePath = path.join(ROOT, 'package.json');

const arg = process.argv[2];
if (!arg) {
  console.error('用法: node tools/bump-version.mjs <新版本号|patch|minor>');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const current = manifest.version;

function nextVersion(cur, kind) {
  const parts = cur.split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  if (kind === 'patch') {
    parts[2] += 1;
  } else if (kind === 'minor') {
    parts[1] += 1;
    parts[2] = 0;
  } else {
    return kind;
  }
  return parts.slice(0, 3).join('.');
}

const next = nextVersion(current, arg);
if (!/^\d+(\.\d+){1,3}$/.test(next)) {
  console.error(`版本号格式不合法：${next}（Chrome 要求 1–4 段数字）`);
  process.exit(1);
}

manifest.version = next;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.version = next;
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`${current} → ${next}`);

// 这些地方在文档里出现过版本号，容易忘记同步
const stale = [];
for (const rel of ['README.md', 'tools/README.md', 'docs/delayed-playback.md']) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (line.includes(`v${current}`)) stale.push(`${rel}: ${line.trim()}`);
    // README 顶部的版本徽章用的是另一种写法（`badge/version-2.58.1-blue`），
    // 不含 `v` 前缀，上面那行抓不到 —— 单独提一句，免得升版本时漏掉它。
    if (line.includes(`version-${current}-`)) stale.push(`${rel}: 徽章 ${line.trim()}`);
  }
}
if (stale.length) {
  console.log('\n以下位置的版本号还停留在旧值，记得一起改：');
  for (const s of stale) console.log(`  ${s}`);
}

// 自动存一份历史版本。
// 这台机器上没有 git，而这个项目被"改了又改、要回退却只能手工拆"坑过，
// 所以把存档挂在这里——不依赖任何人记得做这件事。
//
// 直接 import 调用，**不 spawn 子进程**：沙箱禁止用管道捕获子进程输出（会 EPERM），
// 而且同进程调用本来就更简单。（第一版就是 spawn 的，一测就炸。）
try {
  const r = createSnapshot('release');
  console.log(`\n已自动存档：${r.dirName}`);
  console.log(`  ${r.files} 个文件，${(r.bytes / 1024).toFixed(0)} KB（node tools/snapshot.mjs --list 可列出全部）`);
} catch (e) {
  console.log(`\n⚠️ 自动存档失败（版本号已经改好了，不受影响）：${e?.message || e}`);
}

// 顺便提交一次，这样每个版本号在 git 里都有一个带说明的提交。
// 快照和提交是两套东西：快照是"整份拷贝"，能防住 git 本身出问题；
// 提交能 diff、能看某一行是谁什么时候改的。两个都留着。
if (!findGit()) {
  console.log('\n（没找到 git，跳过提交。装了 git 之后这个步骤会自动生效。）');
} else if (!isRepo()) {
  console.log('\n（这个目录还不是 git 仓库，跳过提交。）');
} else {
  const title = `v${next}`;
  const body = process.env.LIVEDUB_COMMIT_MSG || '';
  const did = commitAll(body ? `${title}\n\n${body}` : title);
  if (did.skipped) console.log(`\n git：没有改动，跳过提交。`);
  else if (did.ok) console.log(`\n git：已提交 ${did.hash}（${title}）`);
  else console.log(`\n⚠️ git 提交失败：${did.reason}`);
}

console.log('\n别忘了在 chrome://extensions 点「重新加载」——否则用户跑的还是旧构建。');
