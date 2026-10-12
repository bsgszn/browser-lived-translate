// 找到并调用 git。
//
// 这台机器上 git 不在 PATH 里——是便携版（MinGit）解压在扩展目录**外面**的
// ../_tools/git/。所以不能假设 `git` 这条命令能用，得自己找。
//
// 查找顺序：
//   1. PATH 里的 git（以后用 winget 正装了就自动走这条）
//   2. ../_tools/git/cmd/git.exe            （MinGit 的入口）
//   3. ../_tools/git/ucrt64/bin/git.exe
//   4. Program Files 下的常规安装位置
//
// 找不到时所有函数都安全降级——git 是锦上添花，不该让别的东西跟着挂掉。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 纯函数：从候选路径里挑第一个存在的（便于单测） */
export function pickGit(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function candidates() {
  const out = [];
  // 1. PATH
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    out.push(path.join(dir, 'git.exe'), path.join(dir, 'git'));
  }
  // 2/3. 便携版
  const portable = path.resolve(ROOT, '..', '_tools', 'git');
  out.push(path.join(portable, 'cmd', 'git.exe'));
  out.push(path.join(portable, 'ucrt64', 'bin', 'git.exe'));
  out.push(path.join(portable, 'mingw64', 'bin', 'git.exe'));
  // 4. 常规安装位置
  if (process.env.ProgramFiles) out.push(path.join(process.env.ProgramFiles, 'Git', 'cmd', 'git.exe'));
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'));
  return out;
}

let cached;
/** @returns {string|null} git 可执行文件路径 */
export function findGit() {
  if (cached !== undefined) return cached;
  cached = pickGit(candidates());
  return cached;
}

/**
 * 跑 git 并拿到它的输出。
 *
 * 🔴 这里有个必须绕开的坑：**沙箱禁止用管道捕获子进程输出**。
 * `execFileSync` 默认 `stdio: 'pipe'`，在沙箱下一律 `EPERM`——
 * 这个项目已经在 bump-version 和这里各踩过一次。
 *
 * 解法：把 stdout/stderr 重定向到**文件描述符**（不是管道），跑完再读文件。
 * 输出文件放在 `.git/` 里——git 自己会忽略 `.git` 内部的文件，
 * 所以不会把仓库弄脏，也不会被快照打包进去。
 *
 * @returns {{ok:boolean, out:string, err:string, missing?:boolean}}
 */
export function git(args, { cwd = ROOT } = {}) {
  const exe = findGit();
  if (!exe) return { ok: false, missing: true, out: '', err: '没有找到 git' };

  const dir = path.join(cwd, '.git');
  let ofd;
  let efd;
  let outFile;
  let errFile;
  try {
    fs.mkdirSync(dir, { recursive: true });
    outFile = path.join(dir, 'livedub-cmd.out');
    errFile = path.join(dir, 'livedub-cmd.err');
    ofd = fs.openSync(outFile, 'w');
    efd = fs.openSync(errFile, 'w');
  } catch (e) {
    return { ok: false, out: '', err: `无法创建输出文件：${e?.message || e}` };
  }

  let status = 0;
  let spawnErr = '';
  try {
    const r = spawnSync(exe, args, { cwd, stdio: ['ignore', ofd, efd] });
    status = r.status === null ? 1 : r.status;
    if (r.error) spawnErr = String(r.error.message || r.error);
  } catch (e) {
    spawnErr = String(e?.message || e);
    status = 1;
  } finally {
    try {
      fs.closeSync(ofd);
    } catch {
      /* ignore */
    }
    try {
      fs.closeSync(efd);
    } catch {
      /* ignore */
    }
  }

  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8').replace(/\uFEFF/g, '').trim();
    } catch {
      return '';
    }
  };
  const out = read(outFile);
  const err = read(errFile) || spawnErr;
  for (const f of [outFile, errFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }

  return { ok: status === 0 && !spawnErr, out, err, status };
}

/** 这个目录是不是一个 git 仓库 */
export function isRepo(dir = ROOT) {
  if (!findGit()) return false;
  return fs.existsSync(path.join(dir, '.git'));
}

/** 有没有未提交的改动 */
export function isDirty(dir = ROOT) {
  const r = git(['status', '--porcelain'], { cwd: dir });
  if (!r.ok) return null; // 问不出来（没装 git / 不是仓库），交给调用方决定
  return r.out.length > 0;
}

/** 把当前状态提交一次。没有改动就跳过。 */
export function commitAll(message, { cwd = ROOT } = {}) {
  if (!isRepo(cwd)) return { ok: false, reason: '不是 git 仓库' };
  if (isDirty(cwd) === false) return { ok: true, skipped: true, reason: '没有改动' };

  const add = git(['add', '-A'], { cwd });
  if (!add.ok) return { ok: false, reason: `add 失败：${add.err}` };

  const c = git(['commit', '-q', '-m', message], { cwd });
  if (!c.ok) return { ok: false, reason: `commit 失败：${c.err}` };

  const hash = git(['rev-parse', '--short', 'HEAD'], { cwd });
  return { ok: true, hash: hash.ok ? hash.out : '' };
}

/** 最近 n 条提交，一行一条 */
export function recent(n = 5, { cwd = ROOT } = {}) {
  const r = git(['log', `-${n}`, '--pretty=format:%h %ad %s', '--date=format:%Y-%m-%d %H:%M'], { cwd });
  return r.ok ? r.out.split('\n').filter(Boolean) : [];
}

// ─────────────────────────── 命令行 ───────────────────────────
// 这个文件主要是给别的脚本 import 的，但偶尔也想手动跑一下看看状态。

function main() {
  const args = process.argv.slice(2);
  const exe = findGit();

  if (args.includes('--which')) {
    console.log(exe || '（没找到 git）');
    return;
  }
  if (!exe) {
    console.log('没找到 git。便携版应当在 ../_tools/git/cmd/git.exe。');
    return;
  }
  if (!isRepo()) {
    console.log(`${ROOT} 还不是 git 仓库。`);
    return;
  }

  if (args.includes('--log')) {
    const n = parseInt(args[args.indexOf('--log') + 1], 10) || 15;
    const lines = recent(n);
    if (!lines.length) {
      console.log('还没有任何提交。');
      return;
    }
    for (const l of lines) console.log(`  ${l}`);
    return;
  }

  if (args.includes('--status')) {
    const s = git(['status', '--short']);
    console.log(s.out || '（工作区干净，没有未提交的改动）');
    return;
  }

  if (args.includes('--commit')) {
    const msg = args.slice(args.indexOf('--commit') + 1).join(' ') || '手动提交';
    const r = commitAll(msg);
    if (r.skipped) console.log('没有改动，跳过。');
    else if (r.ok) console.log(`已提交 ${r.hash}`);
    else console.log(`失败：${r.reason}`);
    return;
  }

  console.log(`git: ${exe}`);
  console.log(`仓库: ${ROOT}`);
  console.log('用法: --log [n] | --status | --commit <说明> | --which');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
