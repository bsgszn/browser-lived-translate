// 静态完整性检查：没有构建步骤的扩展最容易死在"文件路径写错"上。
// 这里把 manifest、HTML 的 src/href、JS 的 import 与 chrome.runtime.getURL 全部对一遍磁盘。
//
//   node tools/manifest-check.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION_DOC_FILES, scanVersionRefs } from './version-refs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

/**
 * 本次打印了多少条 ✓ —— 给 [9] 的 `--deep` 用来核对"本套自己的条数"。
 * 本文件里 ✓ 是直接 console.log 出去的（几百处），所以这里包一层统计，
 * 比到处加计数器可靠。
 */
let selfPassed = 0;
/** [9] 把基准存在这里，真正"和实际对账"挪到文件末尾做（那时 selfPassed 才完整） */
let deepCanon = null;
let deepCanonTotal = null;
{
  const _log = console.log.bind(console);
  console.log = (...a) => {
    const s = a.map((x) => (typeof x === 'string' ? x : '')).join(' ');
    if (s.includes('✓')) selfPassed++;
    _log(...a);
  };
}

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

  // 文档里出现过版本号的地方最容易忘，顺手对一遍。
  // ⚠️ 判定逻辑在 `version-refs.mjs`，和 `bump-version.mjs` **共用一份** ——
  //    以前两边各写一份，而且 bump-version 用的是裸子串，会把文档里的历史例子也命中。
  const stale = [];
  for (const rel of VERSION_DOC_FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    for (const r of scanVersionRefs(fs.readFileSync(file, 'utf8'), rel)) {
      if (r.version === manifest.version) continue;
      stale.push(`${rel}: ${r.kind === 'badge' ? '徽章 ' : ''}v${r.version}`);
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

    /**
     * ⚠️ 上面只保证「四处互相一致」—— **四处一起写错时它完全沉默**。
     * 这个盲区真被咬到过一次：四处都写 smoke 337 / 合计 614，而实际是 338 / 615，
     * 原因是升版本时只同步了版本号、没同步数字。所以这里补上「和实际对账」。
     *
     * ⚠️ 跑另外三套要几秒到几十秒，所以**只在 `--deep` 下做**，默认保持轻量。
     *
     * ⚠️ 受限沙箱会拒子进程管道（`couldn't create signal pipe` / EPERM，本项目撞过多次）
     *    —— 所以**输出重定向到临时文件、不走管道**；真的起不来就**降级**：
     *    只说明"本次没能实际对账"，**不报失败**。
     *    一个在受限环境里会红的检查，只会训练人忽略它。
     */
    const DEEP = process.argv.includes('--deep');
    deepCanon = canon;
    deepCanonTotal = canonTotal;
    if (!DEEP) {
      console.log('      （只查了四处互相一致；要和实际对账请跑 `node tools/manifest-check.mjs --deep`）');
    } else {
      console.log('      （--deep：本套自己的条数在文件末尾核对 —— 那时所有 ✓ 才都打印完）');
    }
  }
}

console.log('\n[10] 单测数量与实际相符');
{
  /**
   * 真踩过的坑：README 里写着「判定逻辑在 `lib/utterance.js`，独立模块、有 **12** 项单测」，
   * 而实际是 11 项。这个数字**只出现一次**，所以 [9] 那套"四处互相核对"覆盖不到它；
   * 它也不会因为别处改动而漂 —— 只会随着测试增删**静静地变成假话**。
   *
   * 判据：数 `smoke-test.mjs` 的 [9] 段里、标题以「整句累积」开头的 `check(...)` 条数。
   *   · 用「段范围 + 标题前缀」定位，**不做括号配平** —— 配平遇到模板字符串里的括号就会错，
   *     而这个项目已经为"看起来对的判据其实不对"栽过多次
   *   · 只匹配行首的 `check('整句累积`，不解析函数体
   *
   * ⚠️ 覆盖面有限，如实说明：它只保证"README 里的数字 == 带那个前缀的 check 条数"。
   *    [9] 段里还有 5 条测字幕排期、翻译窗口的 check，它们**不属于** `lib/utterance.js`，
   *    所以没算进来。哪天给这个模块的测试换了标题前缀，这条会红 ——
   *    那时改前缀的同时也要改这里，别把断言删掉了事。
   */
  const smokePath = path.join(ROOT, 'tools', 'smoke-test.mjs');
  const readmePath = path.join(ROOT, 'README.md');
  const smoke = fs.existsSync(smokePath) ? fs.readFileSync(smokePath, 'utf8').split('\n') : null;
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : null;

  if (!smoke || !readme) {
    failures++;
    console.log('  ✗ 读不到 tools/smoke-test.mjs 或 README.md，无法核对');
  } else {
    const claim = readme.match(/`lib\/utterance\.js`[^\n]*?有\s*(\d+)\s*项单测/);
    const start9 = smoke.findIndex((l) => /console\.log\('\\n\[9\]/.test(l));
    const after9 = smoke.findIndex((l, i) => i > start9 && /console\.log\('\\n\[\d+\]/.test(l));
    const end9 = after9 === -1 ? smoke.length : after9;

    let actual = 0;
    for (let i = start9; i < end9; i++) {
      if (/^\s*check\(\s*'整句累积/.test(smoke[i])) actual++;
    }

    if (!claim) {
      failures++;
      console.log('  ✗ README.md 里找不到「lib/utterance.js … 有 N 项单测」这句，无法核对');
    } else if (start9 === -1) {
      failures++;
      console.log('  ✗ smoke-test.mjs 里找不到 [9] 段，无法核对单测数量');
    } else if (Number(claim[1]) !== actual) {
      failures++;
      console.log(`  ✗ README 说 lib/utterance.js 有 ${claim[1]} 项单测，实际是 ${actual} 项`);
      console.log(`      （smoke-test.mjs [9] 段 L${start9 + 1}~L${end9} 里「整句累积」开头的 check）`);
    } else {
      console.log(`  ✓ lib/utterance.js 的单测数相符：${actual} 项`);
    }
  }
}

/**
 * [9] 的 --deep:和**实际跑出来的**断言数对账。
 *
 * ⚠️ 必须放在文件末尾 —— 上面 [9] 那处做的话 `selfPassed` 还少几条
 *    （[9] 自己和后面几节的 ✓ 都还没打印），实测就是 90 vs 91。
 *
 * ⚠️ 跑另外三套要几秒到几十秒，所以只在 `--deep` 下做。
 * ⚠️ 受限沙箱会拒子进程管道（`couldn't create signal pipe` / EPERM，本项目撞过多次）
 *    —— 输出重定向到临时文件、不走管道；真起不来就**降级**：
 *    说明"本次没能实际对账"，**不报失败**。
 *    一个在受限环境里会红的检查，只会训练人忽略它。
 */
if (deepCanon && process.argv.includes('--deep')) {
  console.log('\n[9d] 文档断言数 vs 实际（--deep）');
  const ORDER4 = ['manifest-check.mjs', 'smoke-test.mjs', 'pipeline-test.mjs', 'worker-test.mjs'];
  const actual = {};
  let degraded = null;
  for (const f of ORDER4) {
    const out = path.join(os.tmpdir(), `mc-deep-${process.pid}-${f}.txt`);
    // ⚠️ 本套要**不带 --deep 重跑一次**才数得准：
    //    在本次进程里数自己的 ✓ 会少 1（[9d] 那行还没打印），多算又会自指。
    const argv = f === 'manifest-check.mjs' ? [path.join(ROOT, 'tools', f)] : [path.join(ROOT, 'tools', f)];
    let fd = null;
    try {
      fd = fs.openSync(out, 'w');
      const r = child_process.spawnSync(process.execPath, argv, {
        cwd: ROOT,
        stdio: ['ignore', fd, fd], // ⚠️ 走文件，不走管道
        timeout: 120000,
      });
      try { fs.closeSync(fd); } catch {}
      fd = null;
      if (r.error || r.status !== 0) {
        degraded = `${f} 退出码 ${r.status}${r.error ? ` / ${r.error.code || r.error.message}` : ''}`;
        break;
      }
      actual[f] = (fs.readFileSync(out, 'utf8').match(/✓/g) || []).length;
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
      degraded = `${f}: ${e?.code || e?.message || e}`;
      break;
    } finally {
      try { fs.unlinkSync(out); } catch {}
    }
  }
  if (degraded) {
    console.log(`  ⚠️ 本次没能实际对账（${degraded}）—— 只做了四处一致性检查，不算失败`);
  } else {
    const mism = [];
    ORDER4.forEach((f, i) => {
      if (actual[f] !== deepCanon[i]) mism.push(`${f}: 实际 ${actual[f]} vs 文档 ${deepCanon[i]}`);
    });
    const actualTotal = ORDER4.reduce((s, f) => s + actual[f], 0);
    if (actualTotal !== deepCanonTotal) mism.push(`合计: 实际 ${actualTotal} vs 文档 ${deepCanonTotal}`);
    if (mism.length) {
      failures++;
      console.log('  ✗ 文档里的断言数和**实际跑出来的**对不上：');
      for (const m of mism) console.log(`      ${m}`);
    } else {
      console.log(`  ✓ 与实际相符（${ORDER4.map((f) => actual[f]).join(' + ')} = ${actualTotal}）`);
    }
  }
}

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
