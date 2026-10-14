/**
 * 预览 `player/player.js` 里的 `snapshotLine()` —— **不需要浏览器**。
 *
 * ⚠️ 为什么要有这个工具:
 * `snapshotLine` 依赖一堆模块级变量（`playback` / `stream` / `appendFails` / …），
 * 所以"把函数抽出来单独跑"会报 `xxx is not defined`。之前有两个会话都卡在这里，
 * 于是**没有人看到过快照补完字段后到底有多长** —— 而"必须是一行"是这个设计里
 * 唯一的硬约束（缓冲区 400 行、面板 60 行，快照太长会把启动阶段挤出去）。
 *
 * 做法:从源码里按花括号配对**精确抽出** `snapshotLine` 的函数体，
 * 用 `new Function` 在一个带假全局的作用域里跑它 —— 跑的是**真源码**，不是抄一份。
 *
 * 用法:
 *   node tools/snapshot-preview.cjs            打印三种场景的快照 + 行长
 *   node tools/snapshot-preview.cjs --max 220  行长超过 220 就 exit 1（给 CI/断言用）
 */
const fs = require('fs');
const path = require('path');

const PLAYER = path.join(__dirname, '..', 'player', 'player.js');

/** 从源码里抽出 `function snapshotLine(...) { ... }` 的完整文本（花括号配对） */
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

/** 造一个假的 video 元素（只实现快照会碰的那几样） */
function fakeVideo(init = {}) {
  const ranges = init.ranges || [];
  return {
    readyState: init.readyState ?? 0,
    paused: init.paused ?? true,
    currentTime: init.currentTime ?? 0,
    buffered: {
      length: ranges.length,
      end: (i) => ranges[i][1],
      start: (i) => ranges[i][0],
    },
  };
}

/** 造一个假的 playback */
function fakePlayback(init = {}) {
  return {
    recorder: init.recorder ?? { mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', state: 'recording' },
    sourceBuffer: init.sourceBuffer ?? { updating: false, buffered: { length: 0 } },
    mediaSource: { readyState: 'open' },
    bytes: init.bytes ?? 0,
    chunks: init.chunks ?? 0,
    actualDelaySec: init.actualDelaySec ?? null,
    locked: init.locked ?? false,
    playBlocked: init.playBlocked ?? false,
    stallCount: init.stallCount ?? 0,
    totalFrames: init.totalFrames ?? 0,
    droppedFrames: init.droppedFrames ?? 0,
  };
}

function buildRunner() {
  const src = fs.readFileSync(PLAYER, 'utf8');
  const fnSrc = extractFn(src, 'snapshotLine');
  // ⚠️ 这里注入的正是那些"模块级变量" —— 它们在真实运行环境里由 player.js 顶层提供
  return new Function(
    '$', 'playback', 'stream', 'appendFails', 'lastAppendError', 'ctx', 'document',
    `${fnSrc}\nreturn snapshotLine;`
  );
}

/** 三种场景:反馈者那种故障 / 健康启动 / 字段全缺（测容错） */
function scenarios() {
  const runner = buildRunner();
  // ⚠️ 必须**调用**它才拿到快照文本 —— 拿到的是函数，忘了调就会打印函数源码本身
  const mk = (...args) => runner(...args)('2s');
  const cases = [];

  // ① 反馈者那种:63 秒、0 字节、无缓冲、video 没动
  cases.push([
    '反馈者那种（0 字节 / 无缓冲 / video 没动）',
    mk(
      () => fakeVideo({ readyState: 0, paused: true, currentTime: 0 }),
      fakePlayback({ bytes: 0, chunks: 0 }),
      { getVideoTracks: () => [{ getSettings: () => ({ width: 2561, height: 1441, frameRate: 60 }) }] },
      0, null, { state: 'running', sampleRate: 48000 }, { visibilityState: 'visible' }
    ),
  ]);

  // ② 健康:有字节、有分片、缓冲在建、还没起播
  cases.push([
    '健康启动（有字节 / 缓冲在建 / 还没起播）',
    mk(
      () => fakeVideo({ readyState: 2, paused: true, currentTime: 0, ranges: [[0, 7.2]] }),
      fakePlayback({ bytes: 14155776, chunks: 57, sourceBuffer: { updating: false, buffered: { length: 3 } } }),
      { getVideoTracks: () => [{ getSettings: () => ({ width: 2560, height: 1440, frameRate: 60 }) }] },
      0, null, { state: 'running', sampleRate: 48000 }, { visibilityState: 'visible' }
    ),
  ]);

  // ③ 正常播放中 + 有过 append 失败
  cases.push([
    '正常播放中（且发生过 append 失败）',
    mk(
      () => fakeVideo({ readyState: 4, paused: false, currentTime: 128.4, ranges: [[0, 135.2]] }),
      fakePlayback({
        bytes: 88080384, chunks: 352, actualDelaySec: 6.6, locked: true,
        stallCount: 0, totalFrames: 396, droppedFrames: 2,
        sourceBuffer: { updating: true, buffered: { length: 3 } },
      }),
      { getVideoTracks: () => [{ getSettings: () => ({ width: 2560, height: 1440, frameRate: 60 }) }] },
      1, 'QuotaExceededError: The SourceBuffer is full', { state: 'running', sampleRate: 48000 },
      { visibilityState: 'visible' }
    ),
  ]);

  // ④ 字段全缺:任何东西取不到都不许抛
  cases.push([
    '字段全缺（测容错，绝不许抛）',
    mk(() => null, null, null, 0, null, null, { visibilityState: 'visible' }),
  ]);

  return cases;
}

function main() {
  const argv = process.argv.slice(2);
  const maxIdx = argv.indexOf('--max');
  const max = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : 0;

  let worst = 0;
  let failed = false;
  for (const [name, text] of scenarios()) {
    const lines = String(text).split('\n');
    const lens = lines.map((l) => l.length);
    worst = Math.max(worst, ...lens);
    console.log(`\n── ${name} ──`);
    lines.forEach((l, i) => console.log(`  [${lens[i]} 字符] ${l}`));
    console.log(`  → ${lines.length} 行 · 最长 ${Math.max(...lens)} 字符`);
    if (lines.length !== 2) {
      console.log(`  ✗ 期望 2 行（录制 / 播放），实际 ${lines.length} 行`);
      failed = true;
    }
  }
  console.log(`\n最长的行:${worst} 字符`);
  if (max > 0 && worst > max) {
    console.log(`✗ 超过了 --max ${max}`);
    process.exit(1);
  }
  if (failed) process.exit(1);
  console.log('✓ 全部合格');
}

module.exports = { extractFn, buildRunner, scenarios, PLAYER };

// 只在直接运行时才打印（被 smoke-test 引去当断言时不要输出）
if (require.main === module) main();
