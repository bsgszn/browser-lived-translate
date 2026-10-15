/**
 * 预览 `player/player.js` 里 `scheduleUtterance()` 打出的那行「整句上屏 · …」——
 * **不需要浏览器**，跑的是**真源码**。
 *
 * ⚠️ 为什么要有这个工具:
 * 那行里第一个字段是「距上屏还有多久」，取自 `at - Date.now()` —— 所以**它会为负**
 * （排期时刻已经过去了）。而它原来无条件印成 `${x}s 后`，于是实测日志里出现了
 *
 *     整句上屏 · **-2.3s 后** · 21 字 · utterance-end · 识别滞后 8.9s
 *
 * 这种自相矛盾的行（"后"是负的）。而这个问题**早在一条注释里被记录过**
 * （见 smoke-test 里 `-11.6s 后` 那句），却一直没人修显示 —— 因为**没有东西能验证它**。
 *
 * 做法:按花括号配对从源码里精确抽出 `scheduleUtterance`，用 `new Function` 在带假全局的
 * 作用域里跑它（`schedule` / `settings` / `diag` 都是假的）—— 不是抄一份实现来测。
 *
 * 用法:
 *   node tools/shown-time-preview.cjs           打印各场景的输出
 *   node tools/shown-time-preview.cjs --check   出现负数就 exit 1（给断言用）
 */
const fs = require('fs');
const path = require('path');

const PLAYER = path.join(__dirname, '..', 'player', 'player.js');

/** 从源码里抽出 `function <name>(...) { ... }` 的完整文本（花括号配对） */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`源码里找不到 function ${name}`);
  const open = src.indexOf('{', start);
  if (open < 0) throw new Error(`${name} 没有函数体`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的花括号不配对`);
}

/**
 * 用真源码跑一次 `scheduleUtterance`。
 *
 * @param {number} offsetMs 排期时刻相对"现在"的偏移：正数 = 还没到点，负数 = 已经迟了
 * @param {object} [utterance] 喂给它的那一段；不传就用一句普通的（`parts` 缺省 → 那行该印 `?`）
 * @returns {string} 那行诊断（没打印就返回空串）
 */
function runOnce(offsetMs, utterance) {
  const src = fs.readFileSync(PLAYER, 'utf8');
  const fnSrc = extractFn(src, 'scheduleUtterance');
  const printed = [];

  const schedule = {
    items: [],
    push(item) {
      const at = Date.now() + offsetMs;
      this.items.push({ ...item, at });
      return at;
    },
  };
  const fake = {
    schedule,
    segs: [],
    settings: { capture: { delaySec: 6.6, syncOffsetMs: 0 } },
    DELAY_MIN_SEC: 3,
    firstAudioAt: Date.now(),
    currentDelayMs: () => 6600,
    diag: (line) => printed.push(line),
    refineEnabled: () => false,
    refiner: null,
    /**
     * ⚠️ `scheduleUtterance` 现在开头会先问一句"这条短段要不要并进上一句"，
     * 所以这个假作用域里必须有它 —— 少了就是 `ReferenceError`，
     * 而这个工具正是那条断言（「后」不能是负的）跑的地方，它一挂断言就红。
     *
     * 这里固定返回 false = **不合并**，也就是走"照常排期"那条路：
     * 本工具要验的是那行「整句上屏」的文案，合并那条路有自己的单测。
     * ⚠️ 合并的行为**不在这里**验 —— 别把这个 stub 当成"合并被测过了"。
     */
    tryMergeTail: () => false,
    Date,
    Math,
    Number,
    String,
    console,
  };
  const keys = Object.keys(fake);
  const fn = new Function(...keys, `${fnSrc}; return scheduleUtterance;`)(...keys.map((k) => fake[k]));
  fn(
    utterance || { text: 'こんにちは、これはテストです', reason: 'utterance-end', start: 0, duration: 2.4 },
  );
  return printed[0] || '';
}

/**
 * 各场景 → [名字, 那行诊断]。
 *
 * ⚠️ 刻意包含**边界**(接近 0)—— 那是"该不该报迟到"最容易判错的地方。
 */
function scenarios() {
  return [
    ['提前 2.1s（正常）', runOnce(2100)],
    ['刚好到点（0.1s 后）', runOnce(100)],
    ['迟到 2.3s（用户实测那次）', runOnce(-2300)],
    ['迟到很多（11.6s，注释里记过的那次）', runOnce(-11600)],
  ];
}

/** 哪一行里出现了负数时长（`-2.3s` 这种）—— 空数组 = 干净 */
function negativeHits() {
  return scenarios()
    .filter(([, line]) => /-\d+(\.\d+)?s/.test(line))
    .map(([name, line]) => `${name}: ${line}`);
}

if (require.main === module) {
  const rows = scenarios();
  let worst = 0;
  for (const [name, line] of rows) {
    worst = Math.max(worst, line.length);
    console.log(`[${name}]\n  ${line}\n`);
  }
  console.log(`最长 ${worst} 字符`);
  const bad = negativeHits();
  if (bad.length) {
    console.log('\n✗ 出现了负数时长（"后"不能是负的）:');
    for (const b of bad) console.log(`  ${b}`);
  } else {
    console.log('✓ 没有负数时长');
  }
  if (process.argv.includes('--check')) process.exit(bad.length ? 1 : 0);
}

module.exports = { scenarios, negativeHits, runOnce, extractFn };
