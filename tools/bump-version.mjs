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
import { VERSION_DOC_FILES, scanVersionRefs } from './version-refs.mjs';

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

/**
 * ⚠️ 工作区不干净就**拒绝运行** —— 而且必须在**动任何文件之前**检查。
 *
 * 这条守卫补的是一个真实发生过的洞。`tools/README.md` 里那条约定是
 * 「先提交修复（带详细消息）→ 再 bump-version」，但那个约定**假设了 commit 会成功**：
 *
 *   ① 有人用 `node -e` 写中文提交信息 → PowerShell 吃掉引号 → **commit 失败** ✗
 *   ② 而他脚本的下一行照样跑了 bump-version
 *   ③ 失败之前那句 `git add -A` **已经把修复暂存了**
 *   ④ 本脚本末尾的 `commitAll` 又 `git add -A` 一次 → **把修复一起卷进了版本提交** ✗
 *   → 结果：一条消息只有 `v2.66.52` 的提交里藏着真实改动，
 *     `git log` 读起来像"这条只改了版本号"，而实际改动在里头。
 *
 * 所以这里检查的不是"有没有改动"，而是"**上一步是不是失败了**" ——
 * **干净的工作区才是"上一步成功"的唯一证据**。
 *
 * 检查放在这里（写 manifest.json 之前），因为本脚本自己马上就会弄脏工作区，
 * 放到后面再检查等于白检查。
 *
 * ⚠️ `isDirty` 用的是 `git status --porcelain`，它把**已暂存 / 未暂存 / 未跟踪**三类都算进来 ——
 * 这正是我们要的：末尾那个 `commitAll` 的 `git add -A` 三类都会卷走。
 *
 * ⚠️ `isDirty` 返回 `null` 表示"问不出来"（没装 git / 不是仓库）。
 * 那种情况本脚本末尾本来就会跳过提交，所以**放行**，不要在这里拦。
 */
const dirty = isDirty();
if (dirty === true) {
  if (process.env.LIVEDUB_ALLOW_DIRTY) {
    console.log(
      '\n⚠️ 工作区不干净，但你设了 LIVEDUB_ALLOW_DIRTY —— 照常升版本。\n' +
        '   注意：本脚本末尾那次提交会把下面这些改动**一起**提交进去。',
    );
  } else {
    console.error(
      '\n✗ 工作区不干净，拒绝升版本。\n' +
        '\n' +
        '  这条守卫拦的是「上一步的 commit 失败了，但脚本继续往下跑」——\n' +
        '  那种情况下，本脚本末尾的提交会把你的改动一起卷进那条只有版本号的提交里。\n' +
        '\n' +
        '  先看看有什么：\n' +
        '    git status\n' +
        '    git diff --cached --stat    # 已暂存的（最可疑：commit 失败时会留下这个）\n' +
        '\n' +
        '  如果是你的修复还没提交 —— 那正是本项目的约定：**先提交修复，再升版本**。\n' +
        '    git commit -F <提交信息文件>\n' +
        '\n' +
        '  确实要在脏工作区下升版本（不推荐）：\n' +
        `    LIVEDUB_ALLOW_DIRTY=1 node tools/bump-version.mjs ${arg}`,
    );
    process.exit(1);
  }
}

manifest.version = next;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.version = next;
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`${current} → ${next}`);

// 这些地方在文档里出现过版本号，容易忘记同步。
//
// ⚠️ 判定逻辑在 `version-refs.mjs`，和 `manifest-check.mjs` 的 [6] **共用一份**。
// 以前这里写的是 `line.includes('v' + current)` —— 裸子串，会把文档里的**历史对照例子**
// 也命中（比如记「先提交修复再改版本号」那条约定时写的 `3b1ce5e v2.66.8`），
// 于是每次升版本都报几条不存在的"版本号滞留"。噪音会让人不再看这个提示，所以收紧了。
const stale = [];
for (const rel of VERSION_DOC_FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const r of scanVersionRefs(text, rel)) {
    // 这里找的是**旧版本号**：升完之后还写着旧值的地方就是待同步的。
    if (r.version !== current) continue;
    stale.push(`${rel}:${r.line} ${r.kind === 'badge' ? '徽章 ' : ''}${r.text}`);
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
  /**
   * ⚠️ 这里**必须把话说重**。以前只打一行「⚠️ 自动存档失败（版本号已经改好了，不受影响）」，
   * 在长输出里一滚就过去了 —— 而快照是**这个项目唯一的回退手段**，没存上是要紧事。
   *
   * 这条消息之所以存在，是因为真的出过事：`createSnapshot` 中途抛错、残留半个目录，
   * 而这里把错误吞成一行 ⚠️ —— 磁盘上于是留下一份"2 个文件、没有 manifest.json"的
   * 残缺快照，看起来像成功了。现在 snapshot.mjs 保证失败必清理，这里保证失败能被看见。
   */
  console.log(`\n⚠️⚠️ 自动存档失败 —— **这次没有存下任何快照**`);
  console.log(`   原因：${e?.message || e}`);
  console.log(`   版本号已经改好了（不受影响），但历史版本里会缺这一份。`);
  console.log(`   可以稍后手动补：node tools/snapshot.mjs release`);
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
