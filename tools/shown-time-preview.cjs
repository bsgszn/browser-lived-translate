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
const DIAGWIN = path.join(__dirname, '..', 'lib', 'diag-window.js');

/**
 * 从**真源码**里抽出 `lib/diag-window.js` 的 `formatAtStamp`（纯函数，无依赖）。
 *
 * ⚠️ 为什么不在这个工具里抄一份：那正是本项目栽过多次的"两份实现只改一份" ✗。
 *    而这个函数没有 import、只用 `Number` / `Math` / `typeof`，所以抽出来就能直接跑 ✓。
 *    （和下面抽 `scheduleUtterance` 是同一套做法。）
 */
function realFormatAtStamp() {
  const src = fs.readFileSync(DIAGWIN, 'utf8');
  const fnSrc = extractFn(src, 'formatAtStamp');
  return new Function(`${fnSrc}; return formatAtStamp;`)();
}

/** 从源码里抽出 `function <name>(...) { ... }` 的完整文本（参数表按括号配对跳过，函数体按花括号配对） */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`源码里找不到 function ${name}`);
  /**
   * ⚠️ 先跳过**参数表**，再找函数体开括号 —— 否则参数默认值里的 `{}` 会被当成函数体 ✗
   *
   * 实测踩到：`formatAtStamp(o = {})` 的第一条 `{` 就在参数默认值里，
   * 于是花括号配对当场归零，抽出来是 `function formatAtStamp(o = {` 这半句，
   * 下游 `new Function` 直接报 `SyntaxError: Unexpected token ';'` ✗
   * —— 和本项目反复栽的"朴素锚点"是同一族（`indexOf` 取到**调用点**而不是定义、
   *    `slice` 固定长度够不到判据）。
   */
  const parenOpen = src.indexOf('(', start);
  if (parenOpen < 0) throw new Error(`${name} 没有参数表`);
  let pdepth = 0;
  let parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    const c = src[i];
    if (c === '(') pdepth++;
    else if (c === ')') {
      pdepth--;
      if (pdepth === 0) {
        parenClose = i;
        break;
      }
    }
  }
  if (parenClose < 0) throw new Error(`${name} 的参数表括号不配对`);
  const open = src.indexOf('{', parenClose);
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
function runOnce(offsetMs, utterance, deviationMs) {
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
    /**
     * ⚠️ `scheduleUtterance` 现在读的是 `effectiveDelaySec(settings)`，不再是裸的
     * `Number(settings.capture.delaySec)` —— 因为打开「让 Whisper 自己断句」时要在**运行时**
     * 把延迟抬到 10 秒（不写 storage）。少了这个就是 `ReferenceError`，
     * 而那三条「整句上屏」断言正是跑在这里的，会一起红。
     *
     * 这里给 6.6 = 和上面 `settings.capture.delaySec` 一致，也照应 `currentDelayMs` 的 6600。
     * ⚠️ 「抬到 10 秒」那段逻辑**不在这里**验 —— 它在 player.js 里，靠它自己的断言。
     */
    effectiveDelaySec: () => 6.6,
    currentDelayMs: () => 6600,
    /**
     * ⚠️ 排期按**目标值**走之后，那行诊断还要报「实测 vs 目标」的偏差
     * （`scheduleDeviationEma` / `SCHEDULE_DEVIATION_WARN_MS`）。
     * 少了它们就是 `ReferenceError`，而三条「整句上屏」断言正在这儿跑，会一起红 ✗
     *
     * 这里默认给 `null` = **还没测到实测值** ⇒ 不印偏差那一段。
     * 传 `deviationMs` 就预置一个偏差，用来验"偏差会不会真的印出来" ——
     * ⚠️ 只查源码里有没有那几个字是**不够的**（把调用处那一行删掉，源码里照样有，
     *    断言仍然是绿的 ✗ —— 本项目为"断言看着有、实际抓不到"栽过多次）。
     */
    scheduleDeviationEma: deviationMs === undefined ? null : deviationMs,
    scheduleDeviationMs: deviationMs === undefined ? null : deviationMs,
    SCHEDULE_DEVIATION_WARN_MS: 300,
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
    /**
     * ⚠️ `scheduleUtterance` 里还要把「识别文本 / 显示文本」记进 `subLog`（导出诊断用），
     * 所以这个假作用域里必须有它和它的容量上限 —— 少了就是 `ReferenceError`，
     * 而这正是那三条「整句上屏」断言跑的地方，它们会一起红。
     *
     * 这里给**真的数组和真的数字**，不写 stub：push / shift / length 都是真行为，
     * 于是这个工具顺手也覆盖了"记录这一步不会抛"。
     * ⚠️ 导出那一段（读 subLog 生成文本）**不在这里**验 —— 它不在被抽出的函数里。
     */
    subLog: [],
    SUBLOG_KEEP: 120,
    /**
     * ⭐ 「排期时刻 `at`」那一格 —— 它必须和诊断行前缀**同一个刻度**，
     * 而那个刻度就是 `DIAG_T0`（`player.js` 里于模块加载那一刻取 `performance.now()`）。
     * 少了它就是 `ReferenceError`，而这四条「整句上屏」断言正是跑在这里的 ✗
     */
    DIAG_T0: performance.now(),
    /**
     * ⭐ 印 `at=` 用的纯函数 —— **从真源码里抽**（见 `realFormatAtStamp`），
     * 不是在这里抄一份实现。少了它同样是 `ReferenceError`。
     */
    formatAtStamp: realFormatAtStamp(),
    performance,
    Date,
    Math,
    Number,
    String,
    console,
  };
  const keys = Object.keys(fake);
  const fn = new Function(...keys, `${fnSrc}; return scheduleUtterance;`)(...keys.map((k) => fake[k]));
  fn(
    utterance || {
      text: 'こんにちは、これはテストです',
      reason: 'utterance-end',
      start: 0,
      duration: 2.4,
      // ⚠️ 默认带上 `parts`：不带的话四个场景全印「累积 ? 片」，
      //    看这个工具的人会以为那个字段**根本没接线** ✗
      //    （"缺值印 ? 且单位留着"那条路有专门的断言在管，不靠这里演示）
      parts: 1,
    },
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

/**
 * 哪一行里出现了**负数时长** —— 空数组 = 干净。
 *
 * ⚠️ 判据要**盯住那个字段**，不能拿整行扫负号 ✗ ——
 *    原来这里是 `/-\d+(\.\d+)?s/` 扫全行，于是 `at=-2.300s`（排期时刻落在过去，
 *    **合法**）会被当成"负数时长"误报 ✗。
 *    而这条断言真正要不许的只有一件事：**`Xs 后` 里的 X 是负的**（"后"是负的，自相矛盾）。
 *    ⇒ 所以锚点收紧成 `-X.Xs 后` —— 这比原来**更准**，不是放宽：
 *      v2.66.29 那次实测的 `-2.3s 后` 照样会被抓到 ✓
 */
function negativeHits() {
  return scenarios()
    .filter(([, line]) => /-\d+(\.\d+)?s 后/.test(line))
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
