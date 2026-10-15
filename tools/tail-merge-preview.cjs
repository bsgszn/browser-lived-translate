/**
 * 预览并验证「合并短段」的**真源码** `tryMergeTail()` —— **不需要浏览器**。
 *
 * ⚠️ 为什么必须有这个工具:
 * 这个功能最容易做错的地方**不是判据**（那部分有纯函数单测），而是**接线**:
 *
 *   ① 合并之后**不能**再建排期条目 —— 否则同一段话上屏两次
 *   ② 合并**不能**动时间轴 —— 第一段的排期时刻必须一个字不变
 *      （用户实测的识别滞后本来就贴着 6.6s 预算，晚 2~5 秒就必然迟到）
 *   ③ prev 已经改不到时**不能**并 —— 否则这条文本凭空消失
 *
 * 而这三点都在 `player/player.js` 里，那是浏览器模块（用到 document），Node 跑不起来。
 * 所以照 `shown-time-preview.cjs` / `snapshot-preview.cjs` 的做法:
 * **按花括号配对从源码抽出真函数**，用假全局跑它 —— 不抄一份实现来测。
 *
 * ⚠️ 抽出来的是真 `tryMergeTail` + 真 `smartCutEnabled`，
 * 而 `tailMergeTrigger` / `mergeTailText` 直接 import 真模块（它们本来就是纯函数）。
 *
 * 用法:
 *   node tools/tail-merge-preview.cjs           打印各场景
 *   node tools/tail-merge-preview.cjs --check   任一不变量被破坏就 exit 1
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PLAYER = path.join(__dirname, '..', 'player', 'player.js');

/** 从源码里抽出 `function <name>(...) { ... }`（花括号配对） */
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

/** 把真 `tailMergeTrigger` / `mergeTailText` 从 ESM 模块里取出来 */
async function loadPure() {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'lib', 'delayed-player.js')).href);
  return { tailMergeTrigger: mod.tailMergeTrigger, mergeTailText: mod.mergeTailText };
}

/**
 * 跑一次真 `tryMergeTail`。
 *
 * @param {{cut?:string, original?:string, rendered?:boolean, queued?:boolean}} prevSpec
 * @param {object} u 刚到的那一段（带 reason / text / start / duration）
 * @param {{smartCut?:boolean}} opts
 * @returns {{merged:boolean, prev:object, pushed:number, lines:string[], renderCount:number, scheduleLen:number}}
 */
async function runOnce(prevSpec, u, { smartCut = true } = {}) {
  const src = fs.readFileSync(PLAYER, 'utf8');
  const mergeFn = extractFn(src, 'tryMergeTail');
  const smartFn = extractFn(src, 'smartCutEnabled');
  const pure = await loadPure();

  const prev = {
    id: 'prev1',
    original: prevSpec.original ?? 'あ'.repeat(20),
    translation: '译文',
    cut: prevSpec.cut ?? 'max-length',
    end: 4.2,
    at: Date.now() + 1234,
  };
  const atBefore = prev.at;
  const items = prevSpec.queued === false ? [] : [prev];
  const rendered = new Map(prevSpec.rendered ? [[prev.id, prev]] : []);
  const lines = [];
  let renderCount = 0;
  let pushed = 0;

  const schedule = {
    items,
    push(item) {
      pushed += 1;
      const at = Date.now();
      this.items.push({ ...item, at });
      return at;
    },
  };
  const settings = { asr: { vad: { vadSmartCut: smartCut } } };
  const segs = [prev];

  const fake = {
    schedule,
    segs,
    rendered,
    settings,
    diag: (line) => lines.push(line),
    renderSubs: () => {
      renderCount += 1;
    },
    tailMergeTrigger: pure.tailMergeTrigger,
    mergeTailText: pure.mergeTailText,
    Number,
    String,
    Date,
    Math,
  };
  const keys = Object.keys(fake);
  const body = `${smartFn}\n${mergeFn}\nreturn tryMergeTail;`;
  const fn = new Function(...keys, body)(...keys.map((k) => fake[k]));
  const merged = fn(u);

  return { merged, prev, pushed, lines, renderCount, scheduleLen: schedule.items.length, atBefore };
}

/** 各场景的不变量检查 —— 返回失败描述（空数组 = 全过） */
async function invariants() {
  const bad = [];
  const tail = { text: 'あ'.repeat(4), duration: 1.0, start: 4.3, reason: 'utterance-end', cut: 'max-length' };

  // ① 该并的并了，而且**没有建新条目** + **时间轴没动**
  {
    const r = await runOnce({ queued: true }, tail, { smartCut: true });
    if (!r.merged) bad.push('max-length 的短尾巴该并却没并');
    if (r.pushed !== 0) bad.push(`合并时还建了 ${r.pushed} 条排期条目 —— 同一条字幕会上屏两次`);
    if (r.scheduleLen !== 1) bad.push(`排期队列长度变成 ${r.scheduleLen}（应当仍是 1）`);
    if (r.prev.at !== r.atBefore) bad.push('合并动了排期时刻 —— 时间轴必须一个字不变');
    if (!r.prev.original.includes('あ'.repeat(4)) || r.prev.original.length <= 20) bad.push('尾巴文本没并进去');
    if (r.prev.translation !== '译文') bad.push('合并把已有译文清空了 —— renderable 会扣住它最多 4 秒，时间就变了');
    if (r.prev.gen !== 1) bad.push('没有让在飞的那份译文作废（gen 没加）');
    if (r.prev.translated !== false) bad.push('没有要求重翻');
    if (!r.lines.some((l) => l.includes('上屏时刻不变'))) bad.push('没有留下"并进上一句"的诊断行');
  }

  // ② 已经上屏的那条 → 就地替换（要重画），而且同样不建新条目
  {
    const r = await runOnce({ queued: false, rendered: true }, tail, { smartCut: true });
    if (!r.merged) bad.push('已上屏的那条也该能并（原地替换）');
    if (r.renderCount !== 1) bad.push(`已上屏时应当重画一次，实际 ${r.renderCount} 次`);
    if (r.pushed !== 0) bad.push('已上屏那条合并时也建了新条目');
  }

  // ③ prev 既不在队里、也不在屏上 → **不能并**（否则文本凭空消失）
  {
    const r = await runOnce({ queued: false, rendered: false }, tail, { smartCut: true });
    if (r.merged) bad.push('prev 已经改不到了却还是并了 —— 这条文本会消失');
    if (r.prev.original.length !== 20) bad.push('不该并的时候改了 prev 的文本');
  }

  // ④ 合理断句关着 → max-length 那条路不并
  {
    const r = await runOnce({ queued: true }, tail, { smartCut: false });
    if (r.merged) bad.push('合理断句关着时不该并 max-length 那条路');
  }

  // ⑤ ⭐ 合理断句关着，但来的是 watchdog 碎片 → **必须并**（用户实测的边界）
  {
    const u = { text: 'あ'.repeat(6), duration: 1.2, start: 4.3, reason: 'watchdog', cut: 'silence' };
    const r = await runOnce({ queued: true, cut: 'silence' }, u, { smartCut: false });
    if (!r.merged) bad.push('合理断句关着时，watchdog 碎片也必须并（用户实测的边界）');
    if (r.pushed !== 0) bad.push('watchdog 合并时建了新条目');
  }

  // ⑥ 开关读的是同一个字段、同一种判法（缺字段 = 开）
  {
    const src = fs.readFileSync(PLAYER, 'utf8');
    const smartFn = extractFn(src, 'smartCutEnabled');
    const fn = new Function('settings', `${smartFn}; return smartCutEnabled;`)({ asr: {} });
    if (fn() !== true) bad.push('老配置里没有 vadSmartCut 字段时应当算**开**');
    const fn2 = new Function('settings', `${smartFn}; return smartCutEnabled;`)({ asr: { vad: { vadSmartCut: false } } });
    if (fn2() !== false) bad.push('显式关掉时应当算关');
  }

  return bad;
}

const SCENARIOS = [
  ['max-length 短尾巴（开关开着）', { queued: true }, { text: 'ああああ', duration: 1.0, start: 4.3, reason: 'utterance-end', cut: 'max-length' }, { smartCut: true }],
  ['watchdog 碎片（开关关着）', { queued: true, cut: 'silence' }, { text: 'ああああああ', duration: 1.2, start: 4.3, reason: 'watchdog', cut: 'silence' }, { smartCut: false }],
  ['后一段不短（3+3 那种）', { queued: true }, { text: 'あ'.repeat(12), duration: 3, start: 4.3, reason: 'utterance-end', cut: 'max-length' }, { smartCut: true }],
  ['prev 已经改不到了', { queued: false, rendered: false }, { text: 'ああああ', duration: 1.0, start: 4.3, reason: 'utterance-end', cut: 'max-length' }, { smartCut: true }],
];

if (require.main === module) {
  (async () => {
    for (const [name, prevSpec, u, opts] of SCENARIOS) {
      const r = await runOnce(prevSpec, u, opts);
      console.log(`[${name}]`);
      console.log(`  并了=${r.merged} · 新建排期条目=${r.pushed} · 队列长度=${r.scheduleLen} · 排期时刻变了=${r.prev.at !== r.atBefore}`);
      console.log(`  ${r.lines[0] || '(没有诊断行)'}`);
      console.log('');
    }
    const bad = await invariants();
    if (bad.length) {
      console.log('✗ 不变量被破坏:');
      for (const b of bad) console.log(`  · ${b}`);
    } else {
      console.log('✓ 全部不变量成立（不建新条目 / 时间轴不动 / 改不到就不并 / 开关边界正确）');
    }
    if (process.argv.includes('--check')) process.exit(bad.length ? 1 : 0);
  })().catch((e) => {
    console.log('异常:', e?.message || e);
    process.exit(1);
  });
}

module.exports = { runOnce, invariants, extractFn };
