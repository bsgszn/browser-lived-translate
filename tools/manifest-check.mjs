// 静态完整性检查：没有构建步骤的扩展最容易死在"文件路径写错"上。
// 这里把 manifest、HTML 的 src/href、JS 的 import 与 chrome.runtime.getURL 全部对一遍磁盘。
//
//   node tools/manifest-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function must(label, rel) {
  if (exists(rel)) {
    console.log(`  ✓ ${label} → ${rel}`);
  } else {
    failures++;
    console.log(`  ✗ ${label} → ${rel}  （文件不存在）`);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

console.log('\n[1] manifest.json');
const manifestPath = path.join(ROOT, 'manifest.json');
const raw = fs.readFileSync(manifestPath);

if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
  failures++;
  console.log('  ✗ manifest.json 带 BOM（Chrome 可能解析失败）');
} else {
  console.log('  ✓ manifest.json 无 BOM');
}

const text = raw.toString('utf8');
if (text.includes('\uFFFD')) {
  failures++;
  console.log('  ✗ manifest.json 不是合法 UTF-8');
} else {
  console.log('  ✓ manifest.json 是合法 UTF-8');
}

let manifest;
try {
  manifest = JSON.parse(text);
  console.log('  ✓ manifest.json 是合法 JSON');
} catch (e) {
  failures++;
  console.log(`  ✗ manifest.json 解析失败：${e.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) {
  failures++;
  console.log(`  ✗ manifest_version 应为 3，实际 ${manifest.manifest_version}`);
} else {
  console.log('  ✓ manifest_version = 3');
}

console.log('\n[2] manifest 引用的文件');
for (const [size, p] of Object.entries(manifest.icons || {})) must(`icons[${size}]`, p);
for (const [size, p] of Object.entries(manifest.action?.default_icon || {})) must(`action.default_icon[${size}]`, p);
if (manifest.action?.default_popup) must('action.default_popup', manifest.action.default_popup);
if (manifest.background?.service_worker) must('background.service_worker', manifest.background.service_worker);
if (manifest.options_page) must('options_page', manifest.options_page);
for (const cs of manifest.content_scripts || []) {
  for (const f of cs.js || []) must('content_scripts.js', f);
  for (const f of cs.css || []) must('content_scripts.css', f);
}
for (const war of manifest.web_accessible_resources || []) {
  for (const f of war.resources || []) must('web_accessible_resources', f);
}

console.log('\n[3] HTML 里的 src / href');
const htmlFiles = walk(ROOT).filter((f) => f.endsWith('.html'));
for (const file of htmlFiles) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');
  const refs = [...src.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:|data:|#|mailto:)/.test(ref)) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ref));
    must(`${rel} → ${ref}`, target);
  }
}

console.log('\n[4] JS 里的 import 与 chrome.runtime.getURL');
const jsFiles = walk(ROOT).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const GETURL_RE = /chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]\s*\)/g;

for (const file of jsFiles) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');

  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // 只检查相对导入
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    must(`${rel} import`, target);
  }
  for (const m of src.matchAll(GETURL_RE)) {
    must(`${rel} getURL`, m[1]);
  }
}

console.log('\n[5] JS 里引用的 DOM id 是否都在 HTML 中');
const idPairs = [
  ['options/options.js', 'options/options.html'],
  ['popup/popup.js', 'popup/popup.html'],
];
for (const [jsRel, htmlRel] of idPairs) {
  const html = fs.readFileSync(path.join(ROOT, htmlRel), 'utf8');
  const present = new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
  const js = fs.readFileSync(path.join(ROOT, jsRel), 'utf8');

  const wanted = new Set();
  // options.js 的声明式绑定表：['someId', 'kind', 'path']
  for (const m of js.matchAll(/\[\s*'([A-Za-z][\w-]*)'\s*,\s*'(?:text|number|checkbox)'\s*,/g)) wanted.add(m[1]);
  // 两处都会用的 $('id') 取元素写法
  for (const m of js.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) wanted.add(m[1]);

  const missing = [...wanted].filter((id) => !present.has(id));
  if (missing.length === 0) {
    console.log(`  ✓ ${jsRel} 引用的 ${wanted.size} 个 id 在 ${htmlRel} 中都存在`);
  } else {
    failures += missing.length;
    console.log(`  ✗ ${jsRel} 引用了 ${htmlRel} 里不存在的 id：${missing.join(', ')}`);
  }
}

console.log('\n[6] 版本一致性');
{
  // 这个项目被"改了代码忘记升版本号，用户无法判断加载的是哪个构建"坑过多次。
  // 版本号唯一的真相是 manifest.json；package.json 必须跟它一致，否则先报出来。
  const pkgPath = path.join(ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.log('  ⚠ 没有 package.json，跳过');
  } else {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version !== manifest.version) {
      failures++;
      console.log(`  ✗ package.json 版本 (${pkg.version}) 与 manifest.json (${manifest.version}) 不一致，跑 tools/bump-version.mjs 同步`);
    } else {
      console.log(`  ✓ manifest.json 与 package.json 版本一致：${manifest.version}`);
    }
  }

  // 文档里出现过版本号的地方最容易忘，顺手对一遍
  const stale = [];
  for (const rel of ['README.md', 'tools/README.md']) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/livedtranslate v(\d+\.\d+\.\d+)/);
      if (m && m[1] !== manifest.version) stale.push(`${rel}: livedtranslate v${m[1]}`);
      // ⚠️ README 顶部那枚版本徽章是**另一个**写法（`badge/version-2.58.1-blue`），
      // 上面那个正则抓不到它 —— 于是它会在下次升版本时静默落后。
      const b = line.match(/badge\/version-(\d+\.\d+\.\d+)-/);
      if (b && b[1] !== manifest.version) stale.push(`${rel}: 徽章 version-${b[1]}`);
    }
  }
  if (stale.length) {
    failures += stale.length;
    console.log(`  ✗ 文档里的版本号还是旧的（当前 ${manifest.version}）：`);
    for (const s of stale) console.log(`      ${s}`);
  } else {
    console.log('  ✓ 文档里的版本号与 manifest 一致');
  }
}

console.log('\n[7] AudioWorklet 接线');
{
  // 真踩过的坑：player.js 里创建了 AudioWorkletNode 却忘了先 addModule()，
  // 运行时抛 "AudioWorklet does not have a valid AudioWorkletGlobalScope"。
  // 这类错误只在浏览器里才炸，静态检查能提前挡住。
  //
  // 检查前必须剥掉注释：注释里出现的 `new AudioWorkletNode` 会造成假阳性
  // （第一版就被自己写的说明文字骗了）。
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const workletPath = path.join(ROOT, 'offscreen/pcm-worklet.js');
  const workletSrc = stripComments(fs.readFileSync(workletPath, 'utf8'));
  const reg = workletSrc.match(/registerProcessor\(\s*['"]([^'"]+)['"]/);
  if (!reg) {
    failures++;
    console.log('  ✗ pcm-worklet.js 里找不到 registerProcessor');
  } else {
    const processorName = reg[1];
    console.log(`  ✓ 处理器已注册：${processorName}`);
    for (const rel of ['offscreen/offscreen.js', 'player/player.js']) {
      const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      const nodeIdx = src.indexOf('new AudioWorkletNode');
      if (nodeIdx < 0) continue;
      const addIdx = src.indexOf('audioWorklet.addModule');
      if (addIdx < 0 || addIdx > nodeIdx) {
        failures++;
        console.log(`  ✗ ${rel} 创建了 AudioWorkletNode 但没先 addModule()`);
      } else {
        console.log(`  ✓ ${rel} 先 addModule() 再创建节点`);
      }
      if (!src.includes(`'${processorName}'`)) {
        failures++;
        console.log(`  ✗ ${rel} 用的处理器名与注册名不一致`);
      } else {
        console.log(`  ✓ ${rel} 处理器名一致`);
      }
    }
  }
}

console.log('\n[8] 关键约束');
if (manifest.background?.type !== 'module') {
  failures++;
  console.log('  ✗ background.type 必须是 "module"（代码用了 ESM import）');
} else {
  console.log('  ✓ background.type = "module"');
}

const contentSrc = fs.readFileSync(path.join(ROOT, 'content/content.js'), 'utf8');
if (/^\s*import\s/m.test(contentSrc)) {
  failures++;
  console.log('  ✗ content.js 含 import：内容脚本是经典脚本，不能用 ESM');
} else {
  console.log('  ✓ content/content.js 是经典脚本（无 import）');
}

if (!(manifest.permissions || []).includes('offscreen')) {
  failures++;
  console.log('  ✗ 缺少 offscreen 权限');
} else {
  console.log('  ✓ 已声明 offscreen 权限');
}

if (!(manifest.permissions || []).includes('tabCapture')) {
  failures++;
  console.log('  ✗ 缺少 tabCapture 权限');
} else {
  console.log('  ✓ 已声明 tabCapture 权限');
}

console.log('\n[9] 文档里的断言数');
{
  /**
   * 真踩过的坑：四套断言数在文档里**写了三遍** ——
   *   · README.md 目录树（`│ ├── smoke-test.mjs   335 项：…`）
   *   · README.md 汇总行（`四套一共 **608 项断言**（87 + 335 + 126 + 60）`）
   *   · tools/README.md 跑测试那节（`node tools/smoke-test.mjs  # 335 项：…` + `合计 **608 项断言**`）
   * 升版本、加断言时只会改其中一处 —— 实测到 README.md 目录树停在 80/333，
   * 而 tools/README.md 更旧（80/295、合计 561，落后 48 项）。
   * 本文件原本只校验版本号和徽章，完全不碰这些数字。
   *
   * 基准取 README.md 汇总行里那串 `a + b + c + d`（它是维护时一直被更新的那一份），
   * 然后要求另外三处都跟它一致。
   *
   * ⚠️ **这条断言只保证"四处互相一致"，不保证"和实际跑出来的数一致"** ——
   *    实际核对要跑另外三套，那需要 spawn 子进程，而受限沙箱会拒管道
   *    （`couldn't create signal pipe` / EPERM，本项目撞过多次），而且很慢。
   *    所以基准行自己也错了的话，这条帮不上忙；那时只能靠人跑一遍四套。
   *    但"只改一处、其它三处漂掉"这一类（真实发生的那一类）它能全抓住。
   */
  const ORDER = ['manifest-check.mjs', 'smoke-test.mjs', 'pipeline-test.mjs', 'worker-test.mjs'];

  const readDoc = (rel) => {
    const p = path.join(ROOT, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };

  // 「xxx-test.mjs」后面不远处的一个「N 项」——两种文档的排版不同，所以留了 40 字符余量
  const grabTree = (text) => {
    const out = {};
    for (const m of text.matchAll(/([\w-]+\.mjs)[^\n]{0,40}?(\d+)\s*项/g)) {
      if (ORDER.includes(m[1])) out[m[1]] = Number(m[2]);
    }
    return out;
  };
  // 「… **N 项断言**」
  const grabTotal = (text) => {
    const m = text.match(/(\d+)\s*项断言/);
    return m ? Number(m[1]) : null;
  };

  const mainDoc = readDoc('README.md');
  const toolsDoc = readDoc('tools/README.md');

  // 基准：README.md 汇总行括号里那串四项和
  const base4 = mainDoc && mainDoc.match(/(\d+(?:\s*\+\s*\d+){3})\s*[）)]/);
  if (!base4) {
    failures++;
    console.log('  ✗ README.md 里找不到「（a + b + c + d）」形式的汇总行，无法确定基准');
  } else {
    const canon = base4[1].split('+').map((x) => Number(x.trim()));
    const canonTotal = canon.reduce((a, b) => a + b, 0);
    const problems = [];

    // ① README.md 自己的目录树
    const mTree = grabTree(mainDoc);
    ORDER.forEach((f, i) => {
      if (typeof mTree[f] !== 'number') problems.push(`README.md 目录树缺 ${f}`);
      else if (mTree[f] !== canon[i]) problems.push(`README.md 目录树 ${f}: ${mTree[f]} vs 基准 ${canon[i]}`);
    });
    // ② README.md 的合计
    const mTotal = grabTotal(mainDoc);
    if (mTotal !== canonTotal) problems.push(`README.md 合计: ${mTotal} vs 基准 ${canonTotal}`);

    // ③ tools/README.md 的目录树
    if (!toolsDoc) {
      problems.push('读不到 tools/README.md');
    } else {
      const tTree = grabTree(toolsDoc);
      ORDER.forEach((f, i) => {
        if (typeof tTree[f] !== 'number') problems.push(`tools/README.md 缺 ${f} 的项数`);
        else if (tTree[f] !== canon[i]) problems.push(`tools/README.md ${f}: ${tTree[f]} vs 基准 ${canon[i]}`);
      });
      // ④ tools/README.md 的合计
      const tTotal = grabTotal(toolsDoc);
      if (tTotal !== canonTotal) problems.push(`tools/README.md 合计: ${tTotal} vs 基准 ${canonTotal}`);
    }

    if (problems.length) {
      failures++;
      console.log(`  ✗ 文档里的断言数与基准（${canon.join(' + ')} = ${canonTotal}）对不上：`);
      for (const p of problems) console.log(`      ${p}`);
    } else {
      console.log(`  ✓ 四处一致（${canon.join(' + ')} = ${canonTotal}）：README.md 目录树 / README.md 合计 / tools/README.md 目录树 / tools/README.md 合计`);
    }
  }
}

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
