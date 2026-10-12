// 给这个扩展存历史版本。
//
// 为什么需要它：这个项目没有 git（机器上没装），而它被反复大改过——
// 有一次要"回退到某个版本但保留某个功能"，只能靠手工一行行拆，很危险。
// 所以改成**自动存**：bump-version.mjs 每次改版本号都会顺手存一份，
// 不依赖任何人记得做这件事。
//
//   node tools/snapshot.mjs                # 标签 auto
//   node tools/snapshot.mjs before-big-change
//   node tools/snapshot.mjs --list         # 只列出已有的快照
//   node tools/snapshot.mjs --prune 20     # 只保留最近 20 份
//
// 存到扩展目录**外面**的 ../_versions/，免得快照本身被打包进扩展。
//
// 注意：下面的函数是 export 出去的，bump-version.mjs 直接 import 调用，
// **不走子进程**。沙箱禁止用管道捕获子进程输出（EPERM），而且同进程调用本来也更简单。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = path.resolve(ROOT, '..', '_versions');
const INDEX = path.join(STORE, 'INDEX.md');

/** 不该进快照的东西 */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '_versions', 'dist', 'build']);
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

/** 纯函数，便于单测：给定目录，列出应当被快照的相对路径 */
export function listFiles(root, rel = '') {
  const out = [];
  const dir = path.join(root, rel);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      out.push(...listFiles(root, r));
    } else if (e.isFile()) {
      if (EXCLUDE_FILES.has(e.name)) continue;
      out.push(r);
    }
  }
  return out;
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 读已有快照（目录名形如 v1.6.1_release_20261011-150311） */
export function listSnapshots() {
  if (!fs.existsSync(STORE)) return [];
  return fs
    .readdirSync(STORE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const m = /^v([^_]+)_([^_]+)_(\d{8}-\d{6})$/.exec(e.name);
      const full = path.join(STORE, e.name);
      let files = 0;
      let bytes = 0;
      for (const rel of listFiles(full)) {
        files += 1;
        try {
          bytes += fs.statSync(path.join(full, rel)).size;
        } catch {
          /* ignore */
        }
      }
      return {
        dir: e.name,
        version: m ? m[1] : '?',
        label: m ? m[2] : '?',
        at: m ? m[3] : '',
        files,
        bytes,
        mtime: fs.statSync(full).mtimeMs,
      };
    })
    .sort((a, b) => a.mtime - b.mtime);
}

export function writeIndex() {
  const items = listSnapshots();
  const lines = [
    '# livedtranslate 历史版本',
    '',
    '由 `tools/snapshot.mjs` 自动生成（`tools/bump-version.mjs` 每次改版本号都会存一份）。',
    '**不要手工编辑本文件**，它下次会被覆盖。',
    '',
    `快照总数：**${items.length}**`,
    '',
    '| 目录 | 版本 | 标签 | 时间 | 文件 | 体积 |',
    '|---|---|---|---|---|---|',
  ];
  for (const it of items.slice().reverse()) {
    lines.push(
      `| \`${it.dir}\` | ${it.version} | ${it.label} | ${it.at} | ${it.files} | ${(it.bytes / 1024 / 1024).toFixed(2)} MB |`,
    );
  }
  lines.push('');
  lines.push('## 还原某一份');
  lines.push('');
  lines.push('```powershell');
  lines.push('# 先把当前状态也存一份，再用快照覆盖（注意：会覆盖当前代码）');
  lines.push('node tools/snapshot.mjs before-restore');
  lines.push('robocopy ..\\_versions\\<目录名> . /MIR /XD node_modules .git');
  lines.push('```');
  lines.push('');
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(INDEX, lines.join('\n'));
}

/** 标签清洗：保留字母数字下划线点、中文、连字符。点要留着，否则 v1.6.1 这种会被吃掉。 */
export function safeLabel(label) {
  return String(label ?? '').replace(/[^\w\u4e00-\u9fa5.-]/g, '') || 'auto';
}

/** 存一份快照。返回 {dirName, dest, files, bytes}；失败会抛。 */
export function createSnapshot(label = 'auto') {
  const safe = safeLabel(label);
  const version = readVersion();
  const dirName = `v${version}_${safe}_${stamp()}`;
  const dest = path.join(STORE, dirName);

  fs.mkdirSync(dest, { recursive: true });
  const files = listFiles(ROOT);
  let bytes = 0;
  for (const rel of files) {
    const from = path.join(ROOT, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    bytes += fs.statSync(from).size;
  }
  writeIndex();
  return { dirName, dest, files: files.length, bytes, version };
}

export function pruneSnapshots(keep = 20) {
  const items = listSnapshots();
  // 注意：即使没有可删的也要重写索引。
  // 之前这里提前 return 了，结果手工删掉快照目录后索引一直是旧的。
  const drop = items.length > keep ? items.slice(0, items.length - keep) : [];
  for (const it of drop) fs.rmSync(path.join(STORE, it.dir), { recursive: true, force: true });
  writeIndex();
  return drop.length;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    const items = listSnapshots();
    if (!items.length) {
      console.log('还没有任何快照。跑 `node tools/snapshot.mjs` 存第一份。');
      return;
    }
    for (const it of items) console.log(`  ${it.at}  v${it.version}  ${it.label}  (${it.files} 文件)`);
    return;
  }

  const pruneAt = args.indexOf('--prune');
  if (pruneAt >= 0) {
    const n = pruneSnapshots(parseInt(args[pruneAt + 1], 10) || 20);
    console.log(`已删除 ${n} 份旧快照。`);
    return;
  }

  const label = args.find((a) => !a.startsWith('--')) || 'auto';
  const r = createSnapshot(label);
  console.log(`已保存快照 v${r.version}（${label}）`);
  console.log(`  位置：${r.dest}`);
  console.log(`  ${r.files} 个文件，${(r.bytes / 1024).toFixed(0)} KB`);
  console.log('  `node tools/snapshot.mjs --list` 可以列出全部历史版本。');
}

// 被 import 时（例如 bump-version.mjs）不执行 main
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
