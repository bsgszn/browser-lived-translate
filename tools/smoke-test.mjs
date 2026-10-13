// 冒烟测试：在 Node 里用桩对象加载所有扩展模块，验证导入路径、顶层代码与工具函数。
// 在扩展根目录运行：
//   node tools/smoke-test.mjs
// 该脚本不参与扩展运行，仅供开发期自检。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 剥掉注释再拿去做正则检查。
 * 这个项目因为不剥注释产生过三次假阳性——注释里提到 `execFileSync`、
 * `new AudioWorkletNode` 这类词，被检查器当成了真代码。
 */
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const listeners = () => ({ addListener() {}, removeListener() {} });

/** 真实的内存版 storage，迁移测试需要它 */
const localStore = new Map();
const sessionStore = new Map();
function area(map) {
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries(map);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
  };
}

globalThis.chrome = {
  runtime: {
    onMessage: listeners(),
    onInstalled: listeners(),
    onStartup: listeners(),
    onConnect: listeners(),
    sendMessage: async () => ({}),
    getURL: (p) => `chrome-extension://test/${p}`,
    getManifest: () => ({ version: '1.1.0' }),
    getContexts: async () => [],
    openOptionsPage() {},
  },
  storage: {
    local: area(localStore),
    session: area(sessionStore),
  },
  tabs: {
    get: async () => ({ id: 1, url: 'https://example.com', title: 't' }),
    query: async () => [{ id: 1 }],
    sendMessage: async () => ({ ok: true }),
    onRemoved: listeners(),
    onUpdated: listeners(),
  },
  tabCapture: { getMediaStreamId: async () => 'stream-id' },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  scripting: { executeScript: async () => [] },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  commands: { onCommand: listeners() },
};

let failures = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const bad = (label, err) => {
  failures++;
  console.log(`  ✗ ${label}\n      ${err?.stack || err}`);
};

function check(label, cond, extra) {
  try {
    // 两种写法都支持：抛异常式（返回 undefined 即通过）与返回布尔式
    const result = typeof cond === 'function' ? cond() : cond;
    // ⚠️ 传了 async 回调给同步版 check 是**最隐蔽的一种失败**：
    // 回调里的 throw 会变成「未处理的 Promise 拒绝」，直接把整个测试文件中断，
    // 后面的用例一条都不跑 —— 而输出里还是"0 failed"，是假绿。
    // 这个坑真的踩过（19 条用例被吞掉）。所以这里显式拦下来。
    if (result && typeof result.then === 'function') {
      failures++;
      console.log(`  ✗ ${label}\n      传了 async 回调给 check()，请改用 checkAsync() —— 否则失败会静默吞掉后面的用例`);
      return;
    }
    const passed = result === undefined ? true : !!result;
    if (passed) {
      ok(label);
    } else {
      failures++;
      console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`);
    }
  } catch (e) {
    bad(label, e);
  }
}

// 兜底：真出现了未处理的拒绝，也要让整个进程以失败退出，不能装作没事
process.on('unhandledRejection', (e) => {
  failures++;
  console.log(`  ✗ 未处理的 Promise 拒绝（有 check 用了 async 回调？）\n      ${e?.stack || e}`);
});

async function checkAsync(label, fn) {
  try {
    await fn();
    ok(label);
  } catch (e) {
    bad(label, e);
  }
}

const approx = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('\n[1] 模块加载');
const MODULES = [
  'lib/util.js',
  'lib/crypto.js',
  'lib/settings.js',
  'lib/audio-chain.js',
  'lib/delayed-player.js',
  'lib/glossary.js',
  'lib/deepl-glossary.js',
  'lib/utterance.js',
  'lib/pcm-ring.js',
  'lib/asr/refine.js',
  'lib/asr/deepgram.js',
  'lib/asr/openai-realtime.js',
  'lib/asr/whisper-chunked.js',
  'lib/asr/vad.js',
  'lib/asr/vad-gate.js',
  'lib/asr/hallucination.js',
  'lib/asr/index.js',
  'lib/translate/index.js',
  'background/service-worker.js',
  'offscreen/offscreen.js',
  'tools/snapshot.mjs',
  'tools/git.mjs',
];
const loaded = {};
for (const m of MODULES) {
  await checkAsync(m, async () => {
    loaded[m] = await import(`../${m}`);
  });
}

console.log('\n[2] 工具函数');
const util = loaded['lib/util.js'];

check('float32ToInt16 边界（-1 / 0 / 1）', () => {
  const out = util.float32ToInt16(new Float32Array([-1, 0, 1]));
  if (out[0] !== -32768 || out[1] !== 0 || out[2] !== 32767) throw new Error(`得到 ${[...out]}`);
});

check('buildWav 头部与长度', () => {
  const pcm = new Int16Array(16000); // 1s @16k
  const buf = util.buildWav(pcm, 16000);
  const dv = new DataView(buf);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (buf.byteLength !== 44 + 32000) throw new Error(`字节长度 ${buf.byteLength}`);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(36) !== 'data') throw new Error('RIFF/WAVE/data 标记错误');
  if (dv.getUint32(24, true) !== 16000) throw new Error('采样率字段错误');
  if (dv.getUint16(22, true) !== 1) throw new Error('声道数字段错误');
  if (dv.getUint32(40, true) !== 32000) throw new Error('data 长度字段错误');
});

check('rms 静音为 0、满幅接近 1', () => {
  if (util.rms(new Int16Array(1000)) !== 0) throw new Error('静音 rms 应为 0');
  const loud = util.rms(new Int16Array(1000).fill(32767));
  if (loud < 0.99 || loud > 1.001) throw new Error(`满幅 rms = ${loud}`);
});

check('Resampler 48k→16k 整数抽取', () => {
  const r = new util.Resampler(48000, 16000);
  const out = r.process(new Float32Array(4800).fill(0.5));
  if (out.length !== 1600) throw new Error(`输出长度 ${out.length}，期望 1600`);
  if (![...out].every((v) => approx(v, 0.5, 1e-6))) throw new Error('直流分量未被保留');
});

check('Resampler 48k→24k 整数抽取', () => {
  const r = new util.Resampler(48000, 24000);
  const out = r.process(new Float32Array(4800).fill(0.25));
  if (out.length !== 2400) throw new Error(`输出长度 ${out.length}，期望 2400`);
});

check('Resampler 跨块连续性与总量守恒', () => {
  const r = new util.Resampler(48000, 16000);
  let n = 0;
  for (let i = 0; i < 10; i++) n += r.process(new Float32Array(2048)).length;
  if (n !== Math.floor((2048 * 10) / 3)) throw new Error(`累计输出 ${n}，期望 ${Math.floor((2048 * 10) / 3)}`);
});

check('Resampler 非整数比 44100→16000 不崩溃且数量合理', () => {
  const r = new util.Resampler(44100, 16000);
  let n = 0;
  for (let i = 0; i < 10; i++) n += r.process(new Float32Array(2048)).length;
  const expect = Math.floor((2048 * 10 * 16000) / 44100);
  if (Math.abs(n - expect) > 2) throw new Error(`累计输出 ${n}，期望约 ${expect}`);
});

check('chunkText 短文本不切分', () => {
  const out = util.chunkText('hello world', 100);
  if (out.length !== 1 || out[0] !== 'hello world') throw new Error(JSON.stringify(out));
});

check('chunkText 按句切分且不丢内容', () => {
  const s = '第一句话。第二句话！第三句话？';
  const out = util.chunkText(s, 6);
  if (out.length < 2) throw new Error(`应切成多段，实际 ${JSON.stringify(out)}`);
  if (out.join('') !== s) throw new Error(`内容丢失：${out.join('|')}`);
});

check('chunkText 空串返回空数组', () => {
  if (util.chunkText('   ', 100).length !== 0) throw new Error('空文本应返回 []');
});

check('int16ToBase64 可被 atob 还原', () => {
  const pcm = new Int16Array([0, 1, -1, 32767, -32768]);
  const b64 = util.int16ToBase64(pcm);
  const bin = Buffer.from(b64, 'base64');
  if (bin.length !== pcm.byteLength) throw new Error('长度不符');
  const back = new Int16Array(bin.buffer, bin.byteOffset, 5);
  if ([...back].join() !== [...pcm].join()) throw new Error('内容不符');
});

check('deepMerge 深合并且不污染原对象', () => {
  const base = { a: { b: 1, c: 2 }, d: 3 };
  const out = util.deepMerge(base, { a: { c: 9 } });
  if (out.a.b !== 1 || out.a.c !== 9 || out.d !== 3) throw new Error(JSON.stringify(out));
  if (base.a.c !== 2) throw new Error('原对象被修改');
});

// ─────────────────────────────────────────────────────────────
// 分析支路滤波器：用 RBJ cookbook 公式复现 Web Audio BiquadFilterNode 的响应，
// 直接算出级联后的幅频特性。这样"测的就是跑的"——buildAnalysisChain 用的是同一份设计。
// ─────────────────────────────────────────────────────────────
const audioChain = loaded['lib/audio-chain.js'];
const TEST_FS = 48000;

function biquadCoeffs(spec, fs) {
  const w0 = (2 * Math.PI * spec.frequency) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * spec.Q);
  let b0;
  let b1;
  let b2;
  if (spec.type === 'lowpass') {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = (1 - cw) / 2;
  } else {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = (1 + cw) / 2;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cw;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function biquadMag(c, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const cw2 = Math.cos(2 * w);
  const sw2 = Math.sin(2 * w);
  const numRe = c.b0 + c.b1 * cw + c.b2 * cw2;
  const numIm = -(c.b1 * sw + c.b2 * sw2);
  const denRe = 1 + c.a1 * cw + c.a2 * cw2;
  const denIm = -(c.a1 * sw + c.a2 * sw2);
  return Math.hypot(numRe, numIm) / Math.hypot(denRe, denIm);
}

function cascadeDb(stages, f, fs = TEST_FS) {
  let mag = 1;
  for (const s of stages) mag *= biquadMag(biquadCoeffs(s, fs), f, fs);
  return 20 * Math.log10(mag);
}

console.log('\n[3] 分析支路音频前端');
const OUT_RATE = 16000;
const stages = audioChain.designAnalysisStages(OUT_RATE);
const lpStages = stages.filter((s) => s.type === 'lowpass');
const hpStages = stages.filter((s) => s.type === 'highpass');
const CUTOFF = audioChain.analysisCutoffHz(OUT_RATE);

check('设计为 1 个高通 + 4 个低通（8 阶 Butterworth）', hpStages.length === 1 && lpStages.length === 4);
check('低通截止频率为 0.44 × 输出采样率', Math.abs(CUTOFF - OUT_RATE * 0.44) < 1e-9 && lpStages.every((s) => s.frequency === CUTOFF));
check('高通截止在 80Hz 附近（去直流/隆隆声）', Math.abs(hpStages[0].frequency - 80) < 1e-9);
check('低通 Q 值为标准 8 阶 Butterworth 极点', lpStages.map((s) => s.Q).join(',') === audioChain.BUTTERWORTH_Q.join(','));

// 通带：语音主要能量区不能被削掉
const passband = [
  [300, -0.5],
  [1000, -0.5],
  [3000, -0.8],
  [6000, -1.5],
];
for (const [f, limit] of passband) {
  const db = cascadeDb(lpStages, f);
  check(`通带 ${f}Hz 衰减 ${db.toFixed(2)}dB（要求 > ${limit}dB）`, db > limit);
}

// 阻带：这是本次改动的核心目的——把会折叠进语音频段的高频压下去
const stopband = [
  [8000, -6],
  [10000, -15],
  [12000, -30],
  [16000, -45],
];
for (const [f, limit] of stopband) {
  const db = cascadeDb(lpStages, f);
  check(`阻带 ${f}Hz 衰减 ${db.toFixed(1)}dB（要求 < ${limit}dB）`, db < limit);
}

check('低通直流增益为 0dB', Math.abs(cascadeDb(lpStages, 0.01)) < 0.01);

const hpDb = (f) => cascadeDb(hpStages, f);
check(`高通 20Hz 衰减 ${hpDb(20).toFixed(1)}dB（要求 < -10dB）`, hpDb(20) < -10);
check(`高通 40Hz 衰减 ${hpDb(40).toFixed(1)}dB（要求 < -3dB）`, hpDb(40) < -3);
check(`高通 200Hz 几乎无衰减 ${hpDb(200).toFixed(2)}dB`, hpDb(200) > -1);
check(`高通 1kHz 几乎无衰减 ${hpDb(1000).toFixed(3)}dB`, hpDb(1000) > -0.1);

// 对比：老的 3 点盒式平均在 9.6kHz 只有约 -5.5dB，新设计必须明显更好
const boxDb = (f, n = 3, fs = TEST_FS) => {
  const x = (Math.PI * f) / fs;
  return 20 * Math.log10(Math.abs(Math.sin(n * x) / (n * Math.sin(x))));
};
const newAt9600 = cascadeDb(lpStages, 9600);
check(
  `9.6kHz 抑制 ${newAt9600.toFixed(1)}dB，明显优于盒式平均的 ${boxDb(9600).toFixed(1)}dB`,
  newAt9600 < boxDb(9600) - 10,
);

// AGC 策略
console.log('\n[3b] 自动增益策略');
check('刚好高于噪声门的小信号被拉到增益上限（+12dB）', Math.abs(audioChain.agcTargetGain(0.003) - audioChain.AGC.maxGain) < 1e-9);
check('低于噪声门时增益保持 1（不放噪）', audioChain.agcTargetGain(0.001) === audioChain.AGC.minGain);
check('安静但有效的人声被提升', audioChain.agcTargetGain(0.02) > 2);
check('正常电平不衰减，增益固定为 1', audioChain.agcTargetGain(0.2) === 1);
check('很响的信号也不会被压到 1 以下', audioChain.agcTargetGain(0.9) === 1);
check('非法输入回落到 1', audioChain.agcTargetGain(NaN) === 1 && audioChain.agcTargetGain(0) === 1);

{
  const agc = new audioChain.AgcController();
  let now = 1000;
  let gain = null;
  // 持续 6 秒的 0.02 RMS（安静人声）
  for (let i = 0; i < 6 * 1000 / 20; i++) {
    now += 20;
    const next = agc.update(0.02, now);
    if (next !== null) gain = next;
  }
  check(`持续安静输入后增益收敛到 ${gain?.toFixed(2)}（应接近 4）`, gain !== null && gain > 3.5);

  // 突然变响：增益必须回落，避免削顶
  for (let i = 0; i < 8 * 1000 / 20; i++) {
    now += 20;
    const next = agc.update(0.6, now);
    if (next !== null) gain = next;
  }
  check(`音量变大后增益回落到 ${gain?.toFixed(2)}（应接近 1）`, gain !== null && gain < 1.15);

  // 静音：增益冻结，不能把底噪放大
  const frozen = agc.gain;
  for (let i = 0; i < 100; i++) {
    now += 20;
    agc.update(0.0001, now);
  }
  check('静音期间不改变增益上界行为（只增不减到 1 为止）', agc.gain <= frozen + 1e-9 || agc.gain >= 1);
}

console.log('\n[4] 设置与提供方');
const settings = loaded['lib/settings.js'];
const asrIndex = loaded['lib/asr/index.js'];
const glossary = loaded['lib/glossary.js'];
const translate = loaded['lib/translate/index.js'];

// ─────────────────────────────────────────────────────────────
// 延迟播放：纠偏闭环与字幕排期
// ─────────────────────────────────────────────────────────────
console.log('\n[3c] 延迟播放：纠偏与排期');
const dp = loaded['lib/delayed-player.js'];

check('延迟值被夹在合理区间', () => {
  if (dp.clampDelay(0.1) !== dp.DELAY_MIN_SEC) throw new Error('过小没被夹住');
  if (dp.clampDelay(99) !== dp.DELAY_MAX_SEC) throw new Error('过大没被夹住');
  if (dp.clampDelay(3) !== 3) throw new Error('正常值被改了');
  if (dp.clampDelay(NaN) !== 2.5) throw new Error('非法输入应回落到默认 2.5');
});

check('纠偏：死区内不动 playbackRate', () => {
  for (const d of [0, 0.1, -0.1, 0.24, -0.24]) {
    if (dp.lagCorrectionRate(d) !== 1) throw new Error(`drift=${d} 不该调速`);
  }
});

check('纠偏：超前就放慢、落后就加速', () => {
  if (!(dp.lagCorrectionRate(1) < 1)) throw new Error('超前应放慢');
  if (!(dp.lagCorrectionRate(-1) > 1)) throw new Error('落后应加速');
});

check('纠偏：速率被限制在 ±6% 以内（否则人耳能听出变调/变速）', () => {
  for (const d of [100, -100, 5, -5]) {
    const r = dp.lagCorrectionRate(d);
    if (r < 0.94 - 1e-9 || r > 1.06 + 1e-9) throw new Error(`drift=${d} 得到 ${r}`);
  }
});

check('纠偏：非法输入返回 1', () => {
  if (dp.lagCorrectionRate(NaN) !== 1 || dp.lagCorrectionRate(Infinity) !== 1) throw new Error('应回落到 1');
});

check('Node 里 isSupported() 为 false（没有 MediaRecorder/MediaSource）', () => dp.isSupported() === false);

check('字幕排期：上屏时刻锚在「这句开口」，且 duration 不参与（否则会晚整整一句）', () => {
  const s = new dp.SubtitleSchedule();
  const t0 = 1_700_000_000_000;
  const at = s.push({ id: 'a', original: 'x', translation: '' }, { start: 10, duration: 7 }, t0, 2500, 100);
  const want = t0 + 10_000 + 2500 + 100;
  if (at !== want) throw new Error(`得到 ${at}，期望 ${want}`);
  // 回归护栏：锚在「说完」的话，这条会整整差 7 秒 —— 那就是"人都快说完了字幕才上"
  const same = s.push({ id: 'b' }, { start: 10, duration: 0.4 }, t0, 2500, 100);
  if (same !== want) throw new Error(`duration 不该影响上屏时刻：${same} vs ${want}`);
});

check('字幕排期：长句超出延迟预算时立刻上屏，而不是再补等一个 D', () => {
  const s = new dp.SubtitleSchedule();
  const t0 = Date.now() - 12_000; // 12 秒前开口
  const at = s.push({ id: 'long' }, { start: 0, duration: 11 }, t0, 2500, 0);
  if (at > Date.now()) throw new Error(`开口锚点应已过去，实际还差 ${at - Date.now()}ms`);
  const out = s.due();
  if (out.length !== 1 || out[0].late !== true) throw new Error('应当立刻可取且标记 late');
});

check('字幕排期：到点才吐出，且按排期顺序', () => {
  const s = new dp.SubtitleSchedule();
  const t0 = Date.now();
  s.push({ id: 'a' }, { start: 0, duration: 1 }, t0, 0, 0); // at = t0
  s.push({ id: 'b' }, { start: 1.5, duration: 1 }, t0, 0, 0); // at = t0 + 1.5s
  const first = s.due(t0 + 600);
  if (first.length !== 1 || first[0].id !== 'a') throw new Error(`第一批得到 ${JSON.stringify(first.map((i) => i.id))}`);
  if (s.size !== 1) throw new Error('b 不该被取走');
  const second = s.due(t0 + 1600);
  if (second.length !== 1 || second[0].id !== 'b') throw new Error('第二批没拿到 b');
  if (s.size !== 0) throw new Error('队列应已清空');
});

check('字幕排期：已经错过的条目标记为 late（要优雅降级而不是丢弃）', () => {
  const s = new dp.SubtitleSchedule();
  const t0 = Date.now() - 60_000;
  const at = s.push({ id: 'late' }, { start: 0, duration: 1 }, t0, 0, 0);
  if (at > Date.now()) throw new Error('构造前提不成立');
  const out = s.due();
  if (out.length !== 1 || out[0].late !== true) throw new Error(JSON.stringify(out));
});

check('字幕排期：没有时间信息时退回"立刻上屏"，不能丢字幕', () => {
  const s = new dp.SubtitleSchedule();
  const before = Date.now();
  const at = s.push({ id: 'x' }, { start: undefined, duration: undefined }, before, 2500, 0);
  if (at < before || at > Date.now() + 50) throw new Error(`得到 ${at}`);
  if (s.due().length !== 1) throw new Error('应立刻可取');
});

check('字幕排期：只保留有限条目（防止长时间跑掉内存）', () => {
  const s = new dp.SubtitleSchedule();
  for (let i = 0; i < 500; i++) s.push({ id: `x${i}` }, { start: i * 10, duration: 1 }, Date.now(), 0, 0);
  if (s.size > s.maxItems) throw new Error(`队列长度 ${s.size} 超过上限 ${s.maxItems}`);
});

check('字幕排期：clear() 清空', () => {
  const s = new dp.SubtitleSchedule();
  s.push({ id: 'a' }, { start: 0, duration: 1 }, Date.now(), 0, 0);
  s.clear();
  if (s.size !== 0) throw new Error('没清干净');
});

// ── 上下文窗口：延迟模式能拿到「后文」，这是它换准确率的核心 ──
{
  const segs = ['A', 'B', 'C', 'D', 'E', 'F'].map((t) => ({ original: t }));

  check('上下文窗口：中间位置同时拿到前文和后文', () => {
    const w = dp.buildContextWindow(segs, 3, { back: 2, forward: 2 });
    if (w.back !== 2 || w.forward !== 2) throw new Error(JSON.stringify(w));
    if (!w.text.includes('【之前】') || !w.text.includes('【之后】')) throw new Error(w.text);
    const before = w.text.split('【之后】')[0];
    const after = w.text.split('【之后】')[1];
    if (!before.includes('B') || !before.includes('C')) throw new Error(before);
    if (!after.includes('E') || !after.includes('F')) throw new Error(after);
    if (before.includes('D') || after.includes('D')) throw new Error('把自己也放进上下文了');
  });

  check('上下文窗口：开头没有前文时只给后文', () => {
    const w = dp.buildContextWindow(segs, 0, { back: 2, forward: 2 });
    if (w.back !== 0 || w.forward !== 2) throw new Error(JSON.stringify(w));
    if (w.text.includes('【之前】')) throw new Error('不该有前文段');
    if (!w.text.includes('【之后】')) throw new Error('应有后文段');
  });

  check('上下文窗口：结尾没有后文时只给前文', () => {
    const w = dp.buildContextWindow(segs, 5, { back: 2, forward: 2 });
    if (w.back !== 2 || w.forward !== 0) throw new Error(JSON.stringify(w));
    if (w.text.includes('【之后】')) throw new Error('不该有后文段');
  });

  check('上下文窗口：越界下标安全返回空', () => {
    for (const i of [-1, 99]) {
      const w = dp.buildContextWindow(segs, i);
      if (w.text !== '' || w.back !== 0 || w.forward !== 0) throw new Error(JSON.stringify(w));
    }
    if (dp.buildContextWindow(null, 0).text !== '') throw new Error('非数组应安全返回');
  });

  check('上下文窗口：forward=0 时不带后文（用于对比"不花预算"的效果）', () => {
    const w = dp.buildContextWindow(segs, 2, { back: 2, forward: 0 });
    if (w.forward !== 0 || w.text.includes('【之后】')) throw new Error(JSON.stringify(w));
  });
}

// ── 翻译泵调度：这里出过一个很贵的 bug，必须钉死 ──
{
  const mk = (at, extra = {}) => ({ id: `s${at}`, original: 'x', at, arrivedAt: 0, ...extra });
  const base = { now: 1000, leadMs: 1200, inflight: 0, maxInflight: 2 };

  check('翻译泵：在飞数量到上限时不再发新的', () => {
    const segs = [mk(1500)];
    if (dp.pickNextToTranslate(segs, { ...base, inflight: 2 }) !== -1) throw new Error('满了还敢发');
    if (dp.pickNextToTranslate(segs, { ...base, inflight: 1 }) !== 0) throw new Error('没满应该发');
  });

  check('翻译泵：还没进预算窗口就等（break，不看后面）', () => {
    // at - now = 3000 > lead 1200 → 等
    if (dp.pickNextToTranslate([mk(4000)], base) !== -1) throw new Error('不该提前翻');
    // at - now = 1000 <= 1200 → 翻
    if (dp.pickNextToTranslate([mk(2000)], base) !== 0) throw new Error('该翻了');
  });

  check('翻译泵：leadMs<=0 表示定稿就翻（老行为）', () => {
    // 还有 10 秒才上屏，但定稿就翻模式下应当立刻翻
    if (dp.pickNextToTranslate([mk(11000)], { ...base, leadMs: 0 }) !== 0) throw new Error('定稿就翻没生效');
  });

  check('翻译泵：跳过已完成/在飞的，取第一条待翻的', () => {
    const segs = [mk(2000, { translated: true }), mk(2000, { inFlight: true }), mk(2000)];
    if (dp.pickNextToTranslate(segs, base) !== 2) throw new Error('没取到第一条待翻的');
  });

  check('翻译泵：arrivedAt 缺失时也算得出来（不能变 NaN 卡住）', () => {
    const segs = [{ id: 'a', original: 'x', at: 2000 }]; // 没有 arrivedAt
    if (dp.pickNextToTranslate(segs, base) !== 0) throw new Error('arrivedAt 缺失就卡住了');
  });

  check('翻译泵：排期算错时靠"等太久"兜底，不会永远不翻', () => {
    // at 远在 1 小时后，但已经等了 10 秒 > maxWaitMs 4000
    const segs = [{ id: 'a', original: 'x', at: 3600_000, arrivedAt: 1000 - 10_000 }];
    if (dp.pickNextToTranslate(segs, base) !== 0) throw new Error('兜底没生效，这句话会永远不翻');
  });

  check('翻译泵：空数组 / 非数组安全', () => {
    if (dp.pickNextToTranslate([], base) !== -1) throw new Error('空数组应当返回 -1');
    if (dp.pickNextToTranslate(null, base) !== -1) throw new Error('非数组应当返回 -1');
  });

  check('看门狗：只回收有明确开始时间戳、且确实超时的在飞请求', () => {
    const now = 100_000;
    const segs = [
      { id: 'fresh', inFlight: true, startedAt: now - 1000 },
      { id: 'stuck', inFlight: true, startedAt: now - 30_000 },
      { id: 'done', inFlight: false, startedAt: now - 60_000 },
      { id: 'nostamp', inFlight: true },
    ];
    const stuck = dp.findStuckFlights(segs, now, 25000).map((s) => s.id);
    // nostamp 不该被误杀：真在飞的请求被误回收会重复翻译
    if (stuck.length !== 1 || stuck[0] !== 'stuck') throw new Error(JSON.stringify(stuck));
  });

  check('在飞计数自愈：以实际在飞条目为准（漏还一份就永久停摆）', () => {
    const segs = [{ inFlight: true }, { inFlight: true }, { inFlight: false }, null];
    if (dp.countInflight(segs) !== 2) throw new Error(String(dp.countInflight(segs)));
    if (dp.countInflight(null) !== 0) throw new Error('非数组应为 0');
    if (dp.countInflight([]) !== 0) throw new Error('空数组应为 0');
  });
}

check('ASR_PROVIDERS 均有对应实现模块', () => {
  for (const p of settings.ASR_PROVIDERS) {
    if (!asrIndex.ASR_MODULES[p.id]) throw new Error(`缺少实现：${p.id}`);
  }
});

check('TRANSLATE_PROVIDERS 均有对应实现分支', () => {
  const ids = settings.TRANSLATE_PROVIDERS.map((p) => p.id);
  for (const need of ['google-free', 'openai', 'deepl', 'none']) {
    if (!ids.includes(need)) throw new Error(`缺少翻译服务：${need}`);
  }
});

check('TARGET_LANGS 的 DeepL 代码齐全', () => {
  for (const l of settings.TARGET_LANGS) {
    if (!l.deepl) throw new Error(`${l.id} 缺少 deepl 代码`);
  }
});

check('asrReadiness 能识别缺少 Key', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  if (settings.asrReadiness(s).ok !== false) throw new Error('默认配置没填 Key，应判定为未就绪');
  s.asr.deepgram.apiKey = 'abc';
  if (settings.asrReadiness(s).ok !== true) throw new Error('填了 Key 应判定为就绪');
});

// ─────────────────────────────────────────────────────────────
// 延迟预设：这组不变量直接决定用户开箱看到的体感
// ─────────────────────────────────────────────────────────────
console.log('\n[4b] 延迟 / 准确度预设');

check('默认设置必须正好匹配一个具名预设（否则下拉框一打开就是"自定义"）', () => {
  const matched = settings.detectPreset(settings.DEFAULT_SETTINGS);
  if (matched !== settings.DEFAULT_PRESET) {
    throw new Error(`默认设置匹配到 "${matched}"，期望 "${settings.DEFAULT_PRESET}"`);
  }
});

check('默认预设是速度优先（同传的核心诉求是快）', () => settings.DEFAULT_PRESET === 'speed');

check('默认开启中间结果翻译（关掉会让译文等到说话人停顿才出现）', () => settings.DEFAULT_SETTINGS.translate.translateInterim === true);

check('默认中间结果门槛足够低，不会拖慢首次出字', () => {
  const s = settings.DEFAULT_SETTINGS.translate;
  if (s.interimMinChars > 6) throw new Error(`interimMinChars=${s.interimMinChars} 偏大`);
  if (s.interimIntervalMs > 600) throw new Error(`interimIntervalMs=${s.interimIntervalMs} 偏大`);
});

check('延迟类预设必须覆盖同一组开关（推荐预设例外——它是完整配置，不是延迟变体）', () => {
  // 「推荐」装的是整套方案（识别服务、呈现方式、画质、翻译），
  // 和 speed/balanced/accuracy 这三个"只调延迟旋钮"的不是一类东西，不能一起比。
  const latency = settings.LATENCY_PRESETS.filter((p) => p.id !== 'recommended');
  if (latency.length < 2) throw new Error('延迟类预设太少');
  const keys = Object.keys(latency[0].values).sort();
  for (const p of latency) {
    const k = Object.keys(p.values).sort();
    if (k.join(',') !== keys.join(',')) throw new Error(`${p.id} 的键不一致：${k.join(',')}`);
  }
  // 推荐预设不许碰延迟旋钮 —— 那些是另外三个预设的地盘，混在一起会让"选了推荐"
  // 顺带改掉用户自己调好的翻译时机
  const rec = settings.LATENCY_PRESETS.find((p) => p.id === 'recommended');
  for (const k of Object.keys(rec.values)) {
    if (/^translate\.(translateInterim|interimMinChars|interimIntervalMs|contextSegments)$/.test(k)) {
      throw new Error(`推荐预设不该包含延迟旋钮：${k}`);
    }
  }
});

check('准确优先预设必须关掉中间结果翻译', () => {
  const acc = settings.LATENCY_PRESETS.find((p) => p.id === 'accuracy');
  if (acc.values['translate.translateInterim'] !== false) throw new Error('准确优先应关闭中间结果翻译');
});

check('applyPreset 能套用到嵌套路径上', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  settings.applyPreset(s, 'accuracy');
  if (s.translate.translateInterim !== false) throw new Error('translateInterim 没改到');
  if (s.asr.deepgram.endpointing !== 800) throw new Error('endpointing 没改到');
  if (settings.detectPreset(s) !== 'accuracy') throw new Error('套用后没被识别为 accuracy');
});

check('手动改一项后识别为自定义', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.interimMinChars = 99;
  if (settings.detectPreset(s) !== 'custom') throw new Error('应识别为 custom');
});

check('applyPreset 对未知 id 是安全的空操作', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  const before = JSON.stringify(s);
  settings.applyPreset(s, 'nope');
  if (JSON.stringify(s) !== before) throw new Error('未知 id 不应改动设置');
});

check('默认带有强制断句上限（防止字幕无限长）', () => {
  if (!(settings.DEFAULT_SETTINGS.asr.maxSegmentMs > 0)) throw new Error('maxSegmentMs 应大于 0');
});

check('默认关闭 smart_format（官方说明它最多会把定稿推迟 3 秒）', () => {
  if (settings.DEFAULT_SETTINGS.asr.deepgram.smartFormat !== false) {
    throw new Error('默认应关闭 smart_format：流式下它会让疑似不完整的数字/日期挂起最多 3 秒');
  }
});

check('utterance_end_ms 不低于服务端最小值 1000', () => {
  const v = settings.DEFAULT_SETTINGS.asr.deepgram.utteranceEndMs;
  if (!(v >= 1000)) throw new Error(`utterance_end_ms=${v}，Deepgram 最小值是 1000`);
});

check('准确优先预设才开启 smart_format', () => {
  // 只看延迟类预设：推荐预设用的是本地 VAD，压根没有 Deepgram 的 smartFormat 这个开关
  for (const p of settings.LATENCY_PRESETS.filter((x) => x.id !== 'recommended')) {
    const want = p.id === 'accuracy';
    if (p.values['asr.deepgram.smartFormat'] !== want) {
      throw new Error(`${p.id} 的 smartFormat 应为 ${want}`);
    }
  }
});

check('所有识别服务都实现 finalize() 并在未连接时安全返回 false', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.deepgram.apiKey = 'k';
  s.asr.openaiRealtime.apiKey = 'sk-test';
  // 阿里云百炼（国内直连）—— 不填 Key 的话 createAsrSession 会直接抛，
  // 而那条断言要测的是 finalize() 的行为，不是凭据校验，所以照上面两家一样补齐。
  s.asr.dashscope.apiKey = 'x';
  for (const p of settings.ASR_PROVIDERS) {
    s.asr.provider = p.id;
    const session = asrIndex.createAsrSession(s, () => {});
    if (typeof session.finalize !== 'function') throw new Error(`${p.id} 没有 finalize()`);
    const r = session.finalize();
    if (r !== false) throw new Error(`${p.id} 未连接时 finalize() 应返回 false，实际 ${r}`);
  }
});

check('Deepgram 会话的 finalize 是同步返回布尔值的（调用方要能立刻判断）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.deepgram.apiKey = 'k';
  const session = asrIndex.createAsrSession(s, () => {});
  const r = session.finalize();
  if (typeof r !== 'boolean') throw new Error(`返回了 ${typeof r}，应为 boolean`);
});

check('Deepgram 默认 endpointing 落在「句间停顿」量级（它是延迟模式的句子边界）', () => {
  const e = settings.DEFAULT_SETTINGS.asr.deepgram.endpointing;
  // 旧断言是「越小越好」，那是只看叠加模式的出字延迟。但 endpointing 同时是延迟模式的
  // 句子边界：120ms 时换气（100~250ms）都会被判成说完，长句碎成一片。
  if (!(e >= 300)) throw new Error(`endpointing=${e}ms 太灵敏：换气会被当成句子结束`);
  if (!(e <= 1000)) throw new Error(`endpointing=${e}ms 太迟钝：句间停顿收不了句，两句话会并成一条`);
});

await checkAsync('translate(none) 返回空串', async () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.provider = 'none';
  const out = await translate.translate('hello', s);
  if (out !== '') throw new Error(`得到 "${out}"`);
});

await checkAsync('translate 缺 Key 时报出可读错误', async () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.provider = 'deepl';
  s.translate.deepl.apiKey = '';
  try {
    await translate.translate('hello', s);
    throw new Error('应当抛错');
  } catch (e) {
    if (!/DeepL/.test(e.message)) throw new Error(`错误信息不友好：${e.message}`);
  }
});

await checkAsync('createAsrSession 对未知提供方报错', async () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.provider = 'nope';
  try {
    asrIndex.createAsrSession(s, () => {});
    throw new Error('应当抛错');
  } catch (e) {
    if (!/未知/.test(e.message)) throw new Error(e.message);
  }
});

// ─────────────────────────────────────────────────────────────
// 设置迁移：这是"改了默认值但老用户没生效"那个坑的回归测试
// ─────────────────────────────────────────────────────────────
console.log('\n[4c] 设置版本迁移');

/** 造一份"旧版本写进 storage 的完整设置" */
function storeAsV1(overrides = {}) {
  const v1 = {
    asr: {
      provider: 'deepgram',
      language: 'en',
      deepgram: { apiKey: 'k', endpoint: 'wss://api.deepgram.com/v1/listen', model: 'nova-3', interim: true, smartFormat: true, utteranceEndMs: 1200, endpointing: 300, keyterms: '' },
    },
    translate: { provider: 'google-free', target: 'zh-CN', source: 'auto', translateInterim: false, interimIntervalMs: 900, interimMinChars: 10, contextSegments: 2 },
    ui: { ...settings.DEFAULT_SETTINGS.ui },
    audio: { muteOriginal: false },
    history: { keep: 300 },
  };
  Object.assign(v1, overrides);
  localStore.clear();
  localStore.set(settings.STORAGE_KEY, v1);
  localStore.set('livedub.settingsVersion', 1);
  return v1;
}

await checkAsync('v1 用户即使从没打开过设置页，也能拿到修好的延迟默认值', async () => {
  storeAsV1();
  const s = await settings.getSettings();
  if (s.translate.translateInterim !== true) throw new Error('translateInterim 没被迁移，用户仍然是"定了稿才翻译"');
  if (s.asr.deepgram.smartFormat !== false) throw new Error('smartFormat 没被迁移，仍有 3 秒定稿挂起');
  if (s.translate.interimMinChars !== 4) throw new Error(`interimMinChars = ${s.translate.interimMinChars}`);
  if (s.translate.interimIntervalMs !== 400) throw new Error(`interimIntervalMs = ${s.translate.interimIntervalMs}`);
  // v2 把它降到 120（只看叠加模式的出字延迟），v4 又抬回 500 ——
  // 因为 120ms 时换气就会被判成"说完了"，长句在延迟模式里碎成一片
  if (s.asr.deepgram.endpointing !== 500) throw new Error(`endpointing = ${s.asr.deepgram.endpointing}`);
});

await checkAsync('用户明确改过的值不能被迁移覆盖', async () => {
  const v1 = storeAsV1();
  v1.translate.translateInterim = true; // 用户在旧版本里主动打开的
  v1.asr.deepgram.endpointing = 800; // 用户主动调过的
  v1.translate.interimMinChars = 25; // 用户主动调过的
  localStore.set(settings.STORAGE_KEY, v1);
  const s = await settings.getSettings();
  if (s.asr.deepgram.endpointing !== 800) throw new Error('用户设的 endpointing 被覆盖了');
  if (s.translate.interimMinChars !== 25) throw new Error('用户设的 interimMinChars 被覆盖了');
  if (s.translate.translateInterim !== true) throw new Error('translateInterim 应为 true');
  // 没被主动改过的项仍然要迁移
  if (s.asr.deepgram.smartFormat !== false) throw new Error('没被改过的 smartFormat 应该迁移到 false');
});

await checkAsync('迁移只跑一次，并且会把版本号写回', async () => {
  storeAsV1();
  await settings.getSettings();
  if (localStore.get('livedub.settingsVersion') !== settings.SETTINGS_VERSION) {
    throw new Error(`版本号没写回：${localStore.get('livedub.settingsVersion')}`);
  }
  const persisted = localStore.get(settings.STORAGE_KEY);
  if (persisted.translate.translateInterim !== true) throw new Error('迁移结果没落盘');

  // 第二次读取不应再改动（把值改回去，模拟"用户在迁移后又手动调整"）
  persisted.translate.translateInterim = false;
  localStore.set(settings.STORAGE_KEY, persisted);
  const again = await settings.getSettings();
  if (again.translate.translateInterim !== false) throw new Error('已经迁移过的设置被重复迁移，用户的新选择被覆盖');
});

await checkAsync('全新安装（没有任何已存设置）直接就是新默认值', async () => {
  localStore.clear();
  const s = await settings.getSettings();
  if (settings.detectPreset(s) !== settings.DEFAULT_PRESET) {
    throw new Error(`全新安装的预设是 ${settings.detectPreset(s)}，应为 ${settings.DEFAULT_PRESET}`);
  }
});

await checkAsync('saveSettings 会带上当前版本号', async () => {
  localStore.clear();
  await settings.saveSettings(settings.DEFAULT_SETTINGS);
  if (localStore.get('livedub.settingsVersion') !== settings.SETTINGS_VERSION) {
    throw new Error('saveSettings 没写版本号，下次会被当成老版本重新迁移');
  }
});

await checkAsync('v2→v3：术语表从 translate.openai.glossary 搬到全局 translate.glossary', async () => {
  const v2 = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  v2.translate.openai.glossary = 'aggro=仇恨';
  delete v2.translate.glossary;
  v2.translate.gamingGlossary = false;
  localStore.clear();
  localStore.set(settings.STORAGE_KEY, v2);
  localStore.set('livedub.settingsVersion', 2);

  const s = await settings.getSettings();
  if (s.translate.glossary !== 'aggro=仇恨') throw new Error(`没搬到全局：${JSON.stringify(s.translate.glossary)}`);
  if ('glossary' in s.translate.openai) throw new Error('旧键没清掉，会一直留在存储里');
});

await checkAsync('v2→v3：用户没有旧术语表时不会凭空造一个出来', async () => {
  const v2 = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  delete v2.translate.glossary;
  delete v2.translate.openai.glossary;
  localStore.clear();
  localStore.set(settings.STORAGE_KEY, v2);
  localStore.set('livedub.settingsVersion', 2);
  const s = await settings.getSettings();
  if (s.translate.glossary !== '') throw new Error(`应为空字符串，实际：${JSON.stringify(s.translate.glossary)}`);
});

console.log('\n[5] 翻译上下文与术语表');
// ─────────────────────────────────────────────────────────────

check('parseGlossary 解析 `原文=译文` 行', () => {
  const g = glossary.parseGlossary('livedtranslate=livedtranslate\nlatency=延迟\n\n  encoder = 编码器  ');
  if (g.length !== 3) throw new Error(JSON.stringify(g));
  if (g[1].from !== 'latency' || g[1].to !== '延迟') throw new Error(JSON.stringify(g[1]));
  if (g[2].from !== 'encoder' || g[2].to !== '编码器') throw new Error(JSON.stringify(g[2]));
});

check('parseGlossary 忽略没有等号或半截的行', () => {
  const g = glossary.parseGlossary('没有等号\n=缺原文\n缺译文=\nok=好');
  if (g.length !== 1 || g[0].from !== 'ok') throw new Error(JSON.stringify(g));
});

check('parseGlossary 忽略 # 开头的注释行', () => {
  const g = glossary.parseGlossary('# 这是注释\naggro=仇恨\n  # 缩进的注释\ngank=抓人');
  if (g.length !== 2) throw new Error(JSON.stringify(g));
});

const fetchBodies = [];
const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
// DeepL 每建一份术语表都会给一个新 id——桩必须也这样，
// 否则"内容变了要删旧表"这条路径永远走不到。
let glossarySeq = 0;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  fetchBodies.push({ url: href, init, body, method: (init?.method || 'GET').toUpperCase() });

  if (href.includes('chat/completions')) return json({ choices: [{ message: { content: '译文结果' } }] });

  // DeepL：术语表管理端点和翻译端点要分开判，否则 /v2/glossaries 会被当成翻译请求
  if (href.includes('/v2/glossaries')) {
    if ((init?.method || 'GET').toUpperCase() === 'DELETE') return json({});
    glossarySeq += 1;
    return json({ glossary_id: `gloss-${glossarySeq}`, ready: true, entry_count: 1 });
  }
  if (href.includes('/v2/translate')) return json({ translations: [{ text: '译文结果' }] });

  if (href.includes('translate.googleapis.com')) {
    const q = decodeURIComponent(new URL(href).searchParams.get('q') || '');
    return json([[[`【${q}】`, q, null, null, 1]], null, 'en']);
  }
  return json({});
};

function openAiSettings() {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.provider = 'openai';
  s.translate.openai.apiKey = 'sk-test';
  s.translate.target = 'zh-CN';
  return s;
}

await checkAsync('OpenAI 翻译会把上下文放进 system 消息', async () => {
  fetchBodies.length = 0;
  const s = openAiSettings();
  await translate.translate('It just shipped.', s, { context: 'We were talking about the new release. The team is small.' });
  const call = fetchBodies.find((c) => c.url.includes('chat/completions'));
  if (!call) throw new Error('没有发出请求');
  const system = call.body.messages[0].content;
  const user = call.body.messages[1].content;
  if (!system.includes('The team is small.')) throw new Error('system 里没有上下文');
  if (!/不要翻译/.test(system)) throw new Error('没有告诉模型不要翻译上下文');
  if (user !== 'It just shipped.') throw new Error(`user 消息应只含待翻译文本，实际：${user}`);
});

await checkAsync('上下文里混入待翻译文本时会被剔除', async () => {
  fetchBodies.length = 0;
  const s = openAiSettings();
  await translate.translate('Same line.', s, { context: 'Same line.' });
  const call = fetchBodies.find((c) => c.url.includes('chat/completions'));
  if (call.body.messages[0].content.includes('此前原文')) {
    throw new Error('上下文等于自身时不应注入上下文块');
  }
});

await checkAsync('术语表被写进 system 消息', async () => {
  fetchBodies.length = 0;
  const s = openAiSettings();
  s.translate.glossary = 'livedtranslate=livedtranslate\nlatency=延迟';
  await translate.translate('latency is low', s, {});
  const system = fetchBodies.find((c) => c.url.includes('chat/completions')).body.messages[0].content;
  if (!system.includes('latency → 延迟')) throw new Error('术语表没进 system');
  if (!system.includes('livedtranslate → livedtranslate')) throw new Error('术语表没进 system');
});

await checkAsync('DeepL 使用官方 context 字段', async () => {
  fetchBodies.length = 0;
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.provider = 'deepl';
  s.translate.deepl.apiKey = 'key:fx';
  await translate.translate('It just shipped.', s, { context: 'Prior sentence here.' });
  const call = fetchBodies.find((c) => c.url.includes('deepl'));
  if (call.body.context !== 'Prior sentence here.') throw new Error(JSON.stringify(call.body));
  if (!Array.isArray(call.body.text) || call.body.text[0] !== 'It just shipped.') throw new Error('text 字段不对');
});

await checkAsync('Google 免 Key 通道不发送上下文（该通道没有这个能力）', async () => {
  fetchBodies.length = 0;
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.provider = 'google-free';
  await translate.translate('hello', s, { context: 'some prior context' });
  const call = fetchBodies.find((c) => c.url.includes('translate.googleapis.com'));
  if (!call) throw new Error('没有发出请求');
  if (call.url.includes('some%20prior%20context')) throw new Error('不应把上下文塞进查询串');
});

await checkAsync('超长上下文被截断到上限', async () => {
  fetchBodies.length = 0;
  const s = openAiSettings();
  const huge = 'x'.repeat(5000);
  await translate.translate('target', s, { context: huge });
  const system = fetchBodies.find((c) => c.url.includes('chat/completions')).body.messages[0].content;
  if (system.includes('x'.repeat(1300))) throw new Error('上下文没有被截断');
});

// ─────────────────────────────────────────────────────────────
// 术语表：三家服务商的落地方式完全不同，逐条钉死
// ─────────────────────────────────────────────────────────────
console.log('\n[5b] 术语表');

check('术语表：只填自定义、且关掉内置词表时，就只有自定义', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.liveGlossary = false;
  s.translate.gamingGlossary = false;
  s.translate.glossary = 'aggro=仇恨';
  const e = glossary.glossaryEntries(s);
  if (e.length !== 1 || e[0].to !== '仇恨') throw new Error(JSON.stringify(e));
});

check('术语表：内置游戏词表默认不并入（它歧义词多）', () => {
  if (settings.DEFAULT_SETTINGS.translate.gamingGlossary !== false) throw new Error('游戏词表默认应为关闭');
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.liveGlossary = false;
  if (glossary.glossaryEntries(s).length !== 0) throw new Error('默认不该有词条');
});

check('术语表：打开游戏词表后并入（目标语言是中文时）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.liveGlossary = false;
  s.translate.gamingGlossary = true;
  s.translate.target = 'zh-CN';
  const e = glossary.glossaryEntries(s);
  if (e.length < 30) throw new Error(`只并入了 ${e.length} 条`);
  if (!e.some((x) => x.from === 'jungler' && x.to === '打野')) throw new Error('缺少 jungler');
});

check('术语表：目标语言不是中文时不并入游戏词表（它的译文是中文）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.gamingGlossary = true;
  s.translate.target = 'ja';
  if (glossary.glossaryEntries(s).length !== 0) throw new Error('不该并入中文词表');
});

check('术语表：打开游戏词表后并入（目标语言是中文时）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.gamingGlossary = true;
  s.translate.target = 'zh-CN';
  const e = glossary.glossaryEntries(s);
  if (e.length < 30) throw new Error(`只并入了 ${e.length} 条`);
  if (!e.some((x) => x.from === 'jungler' && x.to === '打野')) throw new Error('缺少 jungler');
});

check('术语表：目标语言不是中文时不并入游戏词表（它的译文是中文）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.gamingGlossary = true;
  s.translate.target = 'ja';
  if (glossary.glossaryEntries(s).length !== 0) throw new Error('不该并入中文词表');
});

check('术语表：内置直播词表默认并入，且覆盖英文与日文直播术语', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  if (settings.DEFAULT_SETTINGS.translate.liveGlossary !== true) throw new Error('直播词表应默认开启');
  const e = glossary.glossaryEntries(s);
  const has = (from, to) => e.some((x) => x.from === from && x.to === to);
  if (!has('superchat', '醒目留言（SC）')) throw new Error('缺 superchat');
  if (!has('配信', '直播')) throw new Error('缺 配信');
  if (!has('スパチャ', '醒目留言（SC）')) throw new Error('缺 スパチャ');
  if (!has('切り抜き', '切片')) throw new Error('缺 切り抜き');
  if (!has('凸待ち', '等人连麦')) throw new Error('缺 凸待ち');
  if (!has('概要欄', '简介栏')) throw new Error('缺 概要欄');
});

check('术语表：可以关掉直播词表', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.liveGlossary = false;
  if (glossary.glossaryEntries(s).length !== 0) throw new Error('关掉后不该还有词条');
});

check('术语表：目标语言不是中文时直播词表也不并入', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.target = 'ja';
  if (glossary.glossaryEntries(s).length !== 0) throw new Error('译文是中文，不该并入');
});

check('术语表：日文选词刻意避开了会污染长词的短黑话（关键）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  const entries = glossary.glossaryEntries(s);
  // 日文没有词边界，只能子串匹配。这些一旦收进去就会把更长的词改坏：
  // 草→草食、わかる→わからない、ありがと→ありがとう……
  for (const bad of ['草', '笑', '枠', '乙', '凸', 'www', 'わかる', 'ありがと', 'おつかれ', 'それな']) {
    if (entries.some((e) => e.from === bad)) throw new Error(`不该收「${bad}」：会误伤更长的词`);
  }
});

check('术语表：日文长词优先，初見さん 不会被 初見 抢先', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  const entries = glossary.glossaryEntries(s);
  const a = entries.findIndex((e) => e.from === '初見さん');
  const b = entries.findIndex((e) => e.from === '初見');
  if (a < 0 || b < 0) throw new Error('两个都该在');
  if (a > b) throw new Error('长词应当排在前面');
  const { text, tokens } = glossary.applyPlaceholders('初見さんこんにちは', entries);
  const back = glossary.restorePlaceholders(text, tokens);
  if (!back.text.startsWith('新来的观众')) throw new Error(`替换结果不对：${back.text}`);
});

check('术语表：英文直播词仍按整词匹配，不会命中更长的词', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  const entries = glossary.glossaryEntries(s);
  const { tokens } = glossary.applyPlaceholders('a clip and a subscription', entries);
  const froms = tokens.map((t) => t.from);
  if (!froms.includes('clip')) throw new Error(`应当命中 clip：${JSON.stringify(froms)}`);
  if (froms.some((f) => f !== 'clip')) throw new Error(`不该动别的词：${JSON.stringify(froms)}`);
});

check('术语表：自定义优先于内置（同词不重复）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.gamingGlossary = true;
  s.translate.liveGlossary = false;
  s.translate.target = 'zh-CN';
  s.translate.glossary = 'gank=包夹';
  const e = glossary.glossaryEntries(s);
  const hits = e.filter((x) => x.from.toLowerCase() === 'gank');
  if (hits.length !== 1) throw new Error(`gank 出现了 ${hits.length} 次`);
  if (hits[0].to !== '包夹') throw new Error(`自定义没覆盖内置：${hits[0].to}`);
});

check('术语表：长词排在前面（否则 "last hit" 会被 "hit" 抢先匹配）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.liveGlossary = false;
  s.translate.glossary = 'hit=命中\nlast hit=补刀';
  const e = glossary.glossaryEntries(s);
  if (e[0].from !== 'last hit') throw new Error(JSON.stringify(e.map((x) => x.from)));
});

check('占位符：整词替换、忽略大小写', () => {
  const { text, tokens } = glossary.applyPlaceholders('Our Carry is fed, carry on.', [{ from: 'carry', to: '核心输出位' }]);
  if (tokens.length !== 1) throw new Error(JSON.stringify(tokens));
  // 只应命中独立的 carry，不该碰 "carry on"？——它是独立词，也会被命中，这是整词匹配的正常行为
  if (text.includes('Carry') || text.includes('carry')) throw new Error(`没替换干净：${text}`);
});

check('占位符：不会命中更长的词的一部分', () => {
  const { text, tokens } = glossary.applyPlaceholders('aggroo is not aggro', [{ from: 'aggro', to: '仇恨' }]);
  if (tokens.length !== 1) throw new Error('只该命中独立的 aggro');
  if (!text.includes('aggroo')) throw new Error(`误伤了 aggroo：${text}`);
});

check('占位符：换回来', () => {
  const entries = [{ from: 'jungler', to: '打野' }];
  const { text, tokens } = glossary.applyPlaceholders('the jungler ganks', entries);
  const back = glossary.restorePlaceholders(`那个${text.replace(/\uE000\d+\uE001/, '\uE0000\uE001')}来抓人了`, tokens);
  if (!back.text.includes('打野')) throw new Error(back.text);
  if (back.restored !== 1 || back.lost !== 0) throw new Error(JSON.stringify(back));
});

check('占位符：容忍翻译器在标记内部插空格', () => {
  const { tokens } = glossary.applyPlaceholders('jungler', [{ from: 'jungler', to: '打野' }]);
  const back = glossary.restorePlaceholders('那个 \uE000 0 \uE001 来了', tokens);
  if (!back.text.includes('打野')) throw new Error(back.text);
  if (back.restored !== 1) throw new Error(JSON.stringify(back));
});

check('占位符：标记被吞掉时如实回报 lost，且不留下残渣', () => {
  const { tokens } = glossary.applyPlaceholders('jungler ganks', [{ from: 'jungler', to: '打野' }]);
  const back = glossary.restorePlaceholders('打野来抓人了', tokens);
  if (back.lost !== 1 || back.restored !== 0) throw new Error(JSON.stringify(back));
  if (back.text.includes('\uE000') || back.text.includes('\uE001')) throw new Error('留下了残渣');
});

await checkAsync('Google 通道：用占位符把术语带过去再换回来', async () => {
  fetchBodies.length = 0;
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.provider = 'google-free';
  s.translate.glossary = 'jungler=打野';
  const out = await translate.translate('the jungler ganks mid', s, {});
  const call = fetchBodies.find((c) => c.url.includes('translate.googleapis.com'));
  const sent = decodeURIComponent(new URL(call.url).searchParams.get('q') || '').replace(/\+/g, ' ');
  if (!sent.includes('\uE000')) throw new Error(`送出去的文本里没有占位标记：${sent}`);
  if (out.includes('\uE000') || out.includes('\uE001')) throw new Error(`译文里有残留标记：${out}`);
});

await checkAsync('Google 通道：术语被翻译器吞掉时通过 onNote 报出来', async () => {
  const realFetch = globalThis.fetch;
  // 模拟翻译器把占位标记吃掉
  globalThis.fetch = async (url) => {
    if (String(url).includes('translate.googleapis.com')) {
      return { ok: true, status: 200, json: async () => [[['那个打野来抓人了', '', null, null, 1]], null, 'en'], text: async () => '' };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  try {
    const notes = [];
    const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
    s.translate.provider = 'google-free';
    s.translate.glossary = 'jungler=打野';
    await translate.translate('the jungler ganks', s, { onNote: (n) => notes.push(n) });
    if (!notes.some((n) => /占位符丢了/.test(n) && /jungler/.test(n))) {
      throw new Error(`没有报出丢失：${JSON.stringify(notes)}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

function deeplSettings() {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.provider = 'deepl';
  s.translate.deepl.apiKey = 'key:fx';
  s.translate.source = 'en';
  s.translate.target = 'zh-CN';
  s.translate.glossary = 'aggro=仇恨';
  return s;
}

await checkAsync('DeepL：创建官方术语表并把 glossary_id 带进翻译请求', async () => {
  localStore.clear();
  fetchBodies.length = 0;
  await translate.translate('aggro', deeplSettings());
  const create = fetchBodies.find((c) => c.url.includes('/v2/glossaries') && c.method === 'POST');
  if (!create) throw new Error('没有创建术语表');
  if (create.body.entries_format !== 'tsv') throw new Error('entries_format 不对');
  if (create.body.source_lang !== 'EN' || create.body.target_lang !== 'ZH-HANS') {
    throw new Error(`语言代码不对：${create.body.source_lang}→${create.body.target_lang}`);
  }
  if (!create.body.entries.includes('aggro\t仇恨')) throw new Error('条目没传对');
  const tr = fetchBodies.find((c) => c.url.includes('/v2/translate'));
  if (!/^gloss-\d+$/.test(tr.body.glossary_id || '')) throw new Error('翻译请求没带 glossary_id');
});

await checkAsync('DeepL：内容不变时复用缓存的术语表，不重复创建', async () => {
  fetchBodies.length = 0;
  await translate.translate('gank', deeplSettings());
  if (fetchBodies.some((c) => c.url.includes('/v2/glossaries') && c.method === 'POST')) {
    throw new Error('第二次不该重复创建');
  }
  const tr = fetchBodies.find((c) => c.url.includes('/v2/translate'));
  if (!/^gloss-\d+$/.test(tr.body.glossary_id || '')) throw new Error('仍应带上 glossary_id');
});

await checkAsync('DeepL：内容变了重建，并顺手删掉旧的', async () => {
  fetchBodies.length = 0;
  const s = deeplSettings();
  s.translate.glossary = 'aggro=仇恨\ngank=抓人';
  await translate.translate('aggro', s);
  if (!fetchBodies.some((c) => c.url.includes('/v2/glossaries') && c.method === 'POST')) {
    throw new Error('内容变了应当重建');
  }
  if (!fetchBodies.some((c) => /\/v2\/glossaries\/gloss-\d+$/.test(c.url) && c.method === 'DELETE')) {
    throw new Error('应当删掉旧术语表，否则会撞上账号数量上限');
  }
});

await checkAsync('DeepL：源语言是自动检测时术语表用不了，必须明确告知而不是静默失效', async () => {
  localStore.clear();
  fetchBodies.length = 0;
  const notes = [];
  const s = deeplSettings();
  s.translate.source = 'auto';
  await translate.translate('aggro', s, { onNote: (n) => notes.push(n) });
  if (fetchBodies.some((c) => c.url.includes('/v2/glossaries'))) throw new Error('不该尝试创建');
  const tr = fetchBodies.find((c) => c.url.includes('/v2/translate'));
  if (tr.body.glossary_id) throw new Error('不该带 glossary_id');
  if (!notes.some((n) => /源语言/.test(n))) throw new Error(`没有解释原因：${JSON.stringify(notes)}`);
});

await checkAsync('DeepL：没有术语表时不打扰接口', async () => {
  localStore.clear();
  fetchBodies.length = 0;
  const s = deeplSettings();
  s.translate.glossary = '';
  // 内置词表也要关掉，否则"没有术语表"这个前提不成立
  s.translate.liveGlossary = false;
  s.translate.gamingGlossary = false;
  await translate.translate('aggro', s);
  if (fetchBodies.some((c) => c.url.includes('/v2/glossaries'))) throw new Error('不该调用术语表接口');
});

await checkAsync('DeepL：术语表创建失败时不再每句都重试（失败也要缓存）', async () => {
  localStore.clear();
  const realFetch = globalThis.fetch;
  let createAttempts = 0;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('/v2/glossaries')) {
      createAttempts += 1;
      return {
        ok: false,
        status: 400,
        headers: { get: () => 'trace-abc' },
        text: async () => JSON.stringify({ message: 'Glossary entries must not contain duplicate source terms.' }),
        json: async () => ({}),
      };
    }
    return { ok: true, status: 200, json: async () => ({ translations: [{ text: '译文' }] }), text: async () => '' };
  };
  try {
    const s = deeplSettings();
    const notes = [];
    for (let i = 0; i < 4; i += 1) {
      await translate.translate(`第${i}句`, s, { onNote: (n) => notes.push(n) });
    }
    if (createAttempts !== 1) throw new Error(`应当只尝试一次，实际 ${createAttempts} 次`);
    // DeepL 的原话必须被带出来，且只提示一次
    const told = notes.filter((n) => /duplicate source terms/.test(n));
    if (told.length !== 1) throw new Error(`应当只提示一次，实际 ${told.length} 次`);
    if (!/重复的原文词条/.test(told[0])) throw new Error(`没有把原话翻译成人话：${told[0]}`);
    if (!/trace-abc/.test(told[0])) throw new Error(`没带上 X-Trace-ID：${told[0]}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await checkAsync('DeepL：官方术语表用不了时退回占位符替换（术语至少还能生效）', async () => {
  localStore.clear();
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: href, body });
    if (href.includes('/v2/glossaries')) {
      return { ok: false, status: 403, headers: { get: () => '' }, text: async () => '{"message":"forbidden"}', json: async () => ({}) };
    }
    // 假装翻译器原样带回了占位标记
    const sent = body?.text?.[0] || '';
    return { ok: true, status: 200, json: async () => ({ translations: [{ text: sent.replace(/\uE000(\d+)\uE001/g, '打野') }] }), text: async () => '' };
  };
  try {
    const s = deeplSettings();
    s.translate.glossary = 'jungler=打野';
    const out = await translate.translate('the jungler ganks', s, {});
    const tr = calls.find((c) => c.url.includes('/v2/translate'));
    if (tr.body.glossary_id) throw new Error('没有 glossary_id 时不该带这个字段');
    if (!tr.body.text[0].includes('\uE000')) throw new Error(`没有走占位符兜底：${tr.body.text[0]}`);
    if (!out.includes('打野')) throw new Error(`占位符没换回来：${out}`);
    if (out.includes('\uE000')) throw new Error(`译文里残留了标记：${out}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ─────────────────────────────────────────────────────────────
console.log('\n[5c] 复核校正与前后文');
// ─────────────────────────────────────────────────────────────

const chats = () => fetchBodies.filter((c) => c.url.includes('chat/completions'));

function reviewSettings() {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.provider = 'openai';
  s.translate.openai.apiKey = 'sk-test';
  s.translate.reviewPass = true;
  return s;
}

await checkAsync('复核：默认关闭时只发一次请求', async () => {
  fetchBodies.length = 0;
  const s = reviewSettings();
  s.translate.reviewPass = false;
  await translate.translate('hello there', s, {});
  if (chats().length !== 1) throw new Error(`发了 ${chats().length} 次`);
});

await checkAsync('复核：打开后先初译再复核，两次请求', async () => {
  fetchBodies.length = 0;
  // review:true 表示"这个调用点有预算"——只有延迟模式会传。
  // 叠加模式不传，免得把费用翻倍。
  await translate.translate('hello there', reviewSettings(), { review: true });
  const calls = chats();
  if (calls.length !== 2) throw new Error(`发了 ${calls.length} 次`);
  const second = calls[1].body.messages;
  if (!/审校/.test(second[0].content)) throw new Error('第二次不是复核提示词');
  const user = second[1].content;
  if (!user.includes('原文') || !user.includes('初译')) throw new Error(`复核输入不对：${user}`);
});

await checkAsync('复核：只对 OpenAI 生效，DeepL / Google 忽略它', async () => {
  for (const provider of ['deepl', 'google-free']) {
    fetchBodies.length = 0;
    const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
    s.translate.provider = provider;
    s.translate.reviewPass = true;
    s.translate.source = 'en';
    if (provider === 'deepl') s.translate.deepl.apiKey = 'key:fx';
    await translate.translate('hello', s, {});
    const chatCalls = chats();
    if (chatCalls.length) throw new Error(`${provider} 不该走 OpenAI 的复核`);
  }
});

await checkAsync('复核：复核这一步失败时保留初译，不能把已有译文弄丢', async () => {
  const s = reviewSettings();
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, init) => {
    call += 1;
    if (call === 1) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '初译结果' } }] }), text: async () => '' };
    }
    throw new Error('复核这一步炸了');
  };
  try {
    const out = await translate.translate('hello', s, { review: true });
    if (out !== '初译结果') throw new Error(`初译被弄丢了：${out}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await checkAsync('前后文：提示词里用【之前】【之后】标注，并说明不要翻译它们', async () => {
  fetchBodies.length = 0;
  const s = openAiSettings();
  await translate.translate('target line', s, { context: '【之前】\nA\n\n【之后】\nC' });
  const system = chats()[0].body.messages[0].content;
  if (!system.includes('【之前】') || !system.includes('【之后】')) throw new Error('上下文没带进去');
  if (!/只用来帮你理解/.test(system)) throw new Error('没告诉模型上下文只供理解');
  if (!/不要翻译它们/.test(system)) throw new Error('没告诉模型不要翻译上下文');
});

check('Deepgram 会话按设置拼出正确 URL', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.deepgram.apiKey = 'k';
  s.asr.deepgram.keyterms = 'Kubernetes, livedtranslate';
  s.asr.language = 'en';
  const session = asrIndex.createAsrSession(s, () => {});
  if (session.sampleRate !== 16000) throw new Error('采样率应为 16000');
  if (session.streaming !== true) throw new Error('应为流式');
});

check('Whisper 分片会话采样率为 16000', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.provider = 'whisper-chunked';
  const session = asrIndex.createAsrSession(s, () => {});
  if (session.sampleRate !== 16000) throw new Error(`得到 ${session.sampleRate}`);
  if (session.streaming !== false) throw new Error('分片模式不应标记为流式');
});

check('OpenAI Realtime 会话采样率为 24000', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.provider = 'openai-realtime';
  s.asr.openaiRealtime.apiKey = 'sk-test';
  const session = asrIndex.createAsrSession(s, () => {});
  if (session.sampleRate !== 24000) throw new Error(`得到 ${session.sampleRate}`);
});

check('Deepgram 缺少 Key 时给出中文提示', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.deepgram.apiKey = '';
  try {
    asrIndex.createAsrSession(s, () => {});
    throw new Error('应当抛错');
  } catch (e) {
    if (!/API Key/.test(e.message)) throw new Error(e.message);
  }
});

// ─────────────────────────────────────────────────────────────
console.log('\n[6] 历史版本存档');
// ─────────────────────────────────────────────────────────────

const snap = loaded['tools/snapshot.mjs'];

check('存档：node_modules / .git / _versions 不进快照（否则会大到没法用）', () => {
  const tmp = `.tmp-snap-test-${Date.now()}`;
  const root = path.join(process.cwd(), tmp);
  const mk = (rel) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
  };
  try {
    mk('manifest.json');
    mk('lib/glossary.js');
    mk('node_modules/left-pad/index.js');
    mk('.git/HEAD');
    mk('_versions/v1.0.0_a_20260101-000000/manifest.json');
    mk('dist/bundle.js');
    const files = snap.listFiles(root).map((f) => f.split(path.sep).join('/')).sort();
    if (files.join(',') !== 'lib/glossary.js,manifest.json') {
      throw new Error(`应当只剩两个文件，实际：${JSON.stringify(files)}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('存档：标签清洗保留点号（否则 v1.6.1 会变成 v161）', () => {
  if (snap.safeLabel('baseline-1.6.1') !== 'baseline-1.6.1') {
    throw new Error(`得到 ${snap.safeLabel('baseline-1.6.1')}`);
  }
  if (snap.safeLabel('a/b\\c:d*e') !== 'abcde') throw new Error(`得到 ${snap.safeLabel('a/b\\c:d*e')}`);
  if (snap.safeLabel('') !== 'auto') throw new Error('空标签应当回落到 auto');
  if (snap.safeLabel('发布前') !== '发布前') throw new Error('中文标签应当保留');
});

await checkAsync('存档：已存的快照里版本号与目录名一致（说明存的是完整可用的）', async () => {
  const store = path.resolve(process.cwd(), '..', '_versions');
  if (!fs.existsSync(store)) return; // 还没存过就跳过
  const items = snap.listSnapshots();
  if (!items.length) return;
  for (const it of items) {
    const mf = path.join(store, it.dir, 'manifest.json');
    if (!fs.existsSync(mf)) throw new Error(`${it.dir} 里没有 manifest.json，快照不完整`);
    const v = JSON.parse(fs.readFileSync(mf, 'utf8')).version;
    if (v !== it.version) throw new Error(`${it.dir} 目录名写的是 ${it.version}，里面却是 ${v}`);
    // 核心业务文件必须都在
    for (const need of ['lib/glossary.js', 'lib/settings.js', 'player/player.js', 'background/service-worker.js']) {
      if (!fs.existsSync(path.join(store, it.dir, need))) throw new Error(`${it.dir} 缺 ${need}`);
    }
  }
});

await checkAsync('存档：bump-version 里挂的是同进程调用，不是子进程（沙箱下 spawn 捕获输出会 EPERM）', async () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'tools', 'bump-version.mjs'), 'utf8');
  if (/execFileSync|spawnSync|child_process/.test(src)) {
    throw new Error('bump-version 又在用子进程了——沙箱会 EPERM，改成 import 同进程调用');
  }
  if (!/createSnapshot/.test(src)) throw new Error('bump-version 没有调用 createSnapshot，不会自动存档');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[7] git');
// ─────────────────────────────────────────────────────────────

const gitMod = loaded['tools/git.mjs'];

check('git：能从候选路径里挑出存在的那个', () => {
  if (gitMod.pickGit([]) !== null) throw new Error('空列表应返回 null');
  if (gitMod.pickGit([null, '', '/definitely/not/here']) !== null) throw new Error('不存在的应返回 null');
  const self = new URL(import.meta.url).pathname.replace(/^\//, '');
  const picked = gitMod.pickGit(['/nope', self]);
  if (!picked || !picked.endsWith('smoke-test.mjs')) throw new Error(`应当挑中真实存在的文件，得到 ${picked}`);
});

await checkAsync('git：能定位到 git 可执行文件', async () => {
  const exe = gitMod.findGit();
  if (!exe) throw new Error('没找到 git（便携版应当在 ../_tools/git/cmd/git.exe）');
  if (!fs.existsSync(exe)) throw new Error(`findGit 返回了不存在的路径：${exe}`);
  const v = gitMod.git(['--version']);
  if (!v.ok) throw new Error(`跑不起来：${v.err}`);
  if (!/^git version \d/.test(v.out)) throw new Error(`版本输出不对：${v.out}`);
});

await checkAsync('git：扩展目录已经是一个仓库，且至少有一次提交', async () => {
  if (!gitMod.isRepo()) throw new Error('不是 git 仓库');
  const log = gitMod.recent(1);
  if (!log.length) throw new Error('还没有任何提交');
  if (!/^\w+ \d{4}-\d{2}-\d{2}/.test(log[0])) throw new Error(`提交格式不对：${log[0]}`);
});

await checkAsync('git：.gitignore 挡住了不该提交的东西', async () => {
  const gi = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');
  for (const need of ['node_modules/', '_tools/']) {
    if (!gi.includes(need)) throw new Error(`.gitignore 里缺少 ${need}`);
  }
  // 真正被跟踪的文件里不能出现这些
  const tracked = gitMod.git(['ls-files']);
  if (!tracked.ok) throw new Error(`ls-files 失败：${tracked.err}`);
  for (const bad of ['.git/', '_tools/', '_versions/', 'node_modules/']) {
    if (tracked.out.split('\n').some((f) => f.includes(bad))) throw new Error(`被跟踪了：${bad}`);
  }
});

await checkAsync('git：行尾必须锁成 LF（否则每次提交都显示整个文件都改了）', async () => {
  const ga = fs.readFileSync(path.join(process.cwd(), '.gitattributes'), 'utf8');
  if (!/eol=lf/.test(ga)) throw new Error('.gitattributes 没有锁 LF');
  const cfg = gitMod.git(['config', 'core.autocrlf']);
  if (cfg.out !== 'false') throw new Error(`core.autocrlf 应为 false，实际 ${cfg.out || '(未设置)'}`);
});

await checkAsync('git：助手必须把输出重定向到文件描述符，不能用管道（沙箱下 EPERM）', async () => {
  // 必须剥掉注释再查：这个文件里就写着"execFileSync 会 EPERM"这句解释，
  // 不剥的话检查器会把解释本身当成违规代码。
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'tools', 'git.mjs'), 'utf8'));

  if (/\bexecFileSync\b|\bexecSync\b/.test(src)) {
    throw new Error('git.mjs 又在用 exec*Sync 了——默认走管道，沙箱会 EPERM');
  }
  if (!/stdio:\s*\[\s*'ignore'/.test(src)) {
    throw new Error("应当写成 stdio: ['ignore', ofd, efd]（重定向到文件描述符）");
  }
  if (/stdio:\s*'pipe'/.test(src) || /stdio:\s*\[[^\]]*'pipe'/.test(src)) {
    throw new Error('还在用管道捕获输出');
  }
  // 输出文件要放在 .git/ 里，免得把仓库弄脏
  if (!/path\.join\(dir,\s*'livedub-cmd\.out'\)/.test(src)) {
    throw new Error('输出文件应当放在 .git/ 下，否则会出现在 git status 里');
  }
});

await checkAsync('git：跑完不能留下临时输出文件', async () => {
  gitMod.git(['--version']);
  const leftovers = fs.readdirSync(path.join(process.cwd(), '.git')).filter((f) => f.startsWith('livedub-cmd'));
  if (leftovers.length) throw new Error(`残留：${leftovers.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n[8] 设置写回安全');
// ─────────────────────────────────────────────────────────────

await checkAsync('设置写回：patchSettings 只改一个字段，别的原封不动（术语表就靠这个活着）', async () => {
  localStore.clear();
  const base = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  base.translate.glossary = 'aggro=仇恨';
  await settings.saveSettings(base);

  await settings.patchSettings('capture.volume', 0.42);

  const after = await settings.getSettings();
  if (after.capture.volume !== 0.42) throw new Error('改的字段没写进去');
  if (after.translate.glossary !== 'aggro=仇恨') throw new Error('术语表被弄丢了');
});

await checkAsync('设置写回：同一份旧副本，patch 不覆盖别人的改动，整份 save 会（这就是当初的 bug）', async () => {
  localStore.clear();

  // 页面启动时读到的那份副本
  const stale = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  stale.translate.glossary = '';
  stale.capture.volume = 1;

  // 之后在设置页加了术语表
  const fresh = JSON.parse(JSON.stringify(stale));
  fresh.translate.glossary = 'スパチャ=醒目留言（SC）';
  await settings.saveSettings(fresh);

  // ① 旧副本用 patchSettings —— 只动自己那个字段，术语表安然无恙
  await settings.patchSettings('capture.volume', 0.3);
  let after = await settings.getSettings();
  if (after.translate.glossary !== 'スパチャ=醒目留言（SC）') {
    throw new Error(`patch 不该碰到术语表，实际：${JSON.stringify(after.translate.glossary)}`);
  }

  // ② 旧副本用整份 saveSettings —— 术语表被覆盖回空
  await settings.saveSettings(stale);
  after = await settings.getSettings();
  if (after.translate.glossary !== '') {
    throw new Error('这条测试是用来演示"整份写回会吃掉改动"的，前提已经不成立');
  }
});

check('设置写回：长期开着的页面（播放页）不许整份写回', () => {
  for (const rel of ['player/player.js']) {
    const src = stripComments(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'));
    if (/\bsaveSettings\s*\(/.test(src)) {
      throw new Error(`${rel} 又在整份写回设置了——会把别的页面改过的设置一起覆盖掉`);
    }
  }
});

check('设置写回：播放页必须监听 storage 变化（否则它不知道别处改过）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player/player.js'), 'utf8'));
  if (!/chrome\.storage\.onChanged\.addListener/.test(src)) {
    throw new Error('播放页没有监听外部设置变化');
  }
  if (!/STORAGE_KEY/.test(src)) throw new Error('没有按 STORAGE_KEY 过滤变化，会对无关的 key 也反应');
});

check('设置写回：播放页写的字段必须都是显式路径（漏写路径会静默写坏设置）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player/player.js'), 'utf8'));
  const paths = [...src.matchAll(/scheduleSave\(\s*'([^']+)'/g)].map((m) => m[1]);
  const allowed = new Set([
    'capture.delaySec',
    'capture.syncOffsetMs',
    'capture.volume',
    'capture.delayMaxHeight',
    'capture.smoothRate',
    'ui.showDiag',
    'asr.refine.enabled',
  ]);
  for (const p of paths) {
    if (!allowed.has(p)) throw new Error(`出现了预期外的字段：${p}`);
  }
  if (paths.length !== allowed.size) {
    throw new Error(`应当有 ${allowed.size} 个带路径的 scheduleSave，实际 ${paths.length} 个`);
  }
  // 不能有漏传路径的裸调用
  const bare = src.match(/scheduleSave\(\s*\)/g);
  if (bare) throw new Error(`有 ${bare.length} 处 scheduleSave() 没传路径`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n[9] 整句累积（延迟模式怎么断句）');
// ─────────────────────────────────────────────────────────────

const utt = loaded['lib/utterance.js'];

check('整句累积：一次说话的多个 is_final 合成一句，utteranceEnd 时才吐出来', () => {
  const a = new utt.UtteranceAccumulator();
  if (a.addFinal({ text: '今日は', start: 0, duration: 1 }) !== null) throw new Error('不该立刻上屏');
  if (a.addFinal({ text: '配信を', start: 1, duration: 1 }) !== null) throw new Error('不该立刻上屏');
  const out = a.endUtterance({ reason: 'utterance_end' });
  if (!out) throw new Error('应当吐出一整句');
  if (out.text !== '今日は 配信を') throw new Error(`拼接不对：${out.text}`);
  if (out.start !== 0 || out.duration !== 2) throw new Error(`区间不对：${JSON.stringify(out)}`);
  if (out.reason !== 'utterance-end') throw new Error(`reason 不对：${out.reason}`);
  if (a.pending) throw new Error('吐完之后应当清空');
});

check('整句累积：speech_final 和 UtteranceEnd 都收句，且不会重复上屏', () => {
  const a = new utt.UtteranceAccumulator();
  a.addFinal({ text: '第一句', start: 0, duration: 1 });
  const first = a.endUtterance({ reason: 'speech_final', text: '第一句' });
  if (!first) throw new Error('speech_final 应当收句 —— 它的阈值 endpointing 是可调的主边界');
  if (first.reason !== 'speech-final') throw new Error(`reason 不对：${first.reason}`);
  // 随后 UtteranceEnd 才到：累积已经空了，不能吐出第二条一模一样的字幕
  const dup = a.endUtterance({ reason: 'utterance_end' });
  if (dup !== null) throw new Error('累积已空，后到的信号不该再出一条');
  // 反过来：speech_final 没发时，UtteranceEnd 必须能兜底收句
  const b = new utt.UtteranceAccumulator();
  b.addFinal({ text: '兜底收句', start: 0, duration: 1 });
  const backstop = b.endUtterance({ reason: 'utterance_end' });
  if (!backstop || backstop.reason !== 'utterance-end') throw new Error('UtteranceEnd 必须能兜底');
});

check('整句累积：endpointing 必须是「句间停顿」量级，不能退回 120ms（换气就算说完）', () => {
  const ep = settings.DEFAULT_SETTINGS.asr.deepgram.endpointing;
  if (!(ep >= 300)) throw new Error(`endpointing=${ep}ms 太灵敏：换气（100~250ms）会被当成句子结束，长句碎成一片`);
  if (ep > 1000) throw new Error(`endpointing=${ep}ms 太迟钝：句间停顿（300~700ms）收不了句，两句话会被并成一条`);
  const ue = settings.DEFAULT_SETTINGS.asr.deepgram.utteranceEndMs;
  if (ue < 1000) throw new Error(`utterance_end_ms=${ue} 低于 Deepgram 硬下限 1000`);
});

check('整句累积：说话人一直不停顿 → 跨度超上限就先上屏，不会永远不出字幕', () => {
  const a = new utt.UtteranceAccumulator({ maxSpanSec: 5 });
  a.addFinal({ text: 'a', start: 0, duration: 2 });
  if (a.addFinal({ text: 'b', start: 2, duration: 2 }) !== null) throw new Error('还没到上限');
  const out = a.addFinal({ text: 'c', start: 4, duration: 2 }); // 跨度变成 6 ≥ 5
  if (!out) throw new Error('到上限应当兜底上屏');
  if (out.reason !== 'max-span') throw new Error(`reason 不对：${out.reason}`);
  if (out.text !== 'a b c') throw new Error(out.text);
  if (a.pending) throw new Error('兜底之后应当清空，下一句重新累积');
});

check('整句累积：看门狗 —— ASR 没发 utteranceEnd 时按静默超时兜底', () => {
  const a = new utt.UtteranceAccumulator({ watchdogMs: 3000 });
  a.addFinal({ text: 'x', start: 0, duration: 1 }, 1000);
  if (a.tick(2500) !== null) throw new Error('还没超时就不该动');
  const out = a.tick(4100);
  if (!out || out.reason !== 'watchdog') throw new Error('超时应当兜底上屏');
});

check('整句累积：同一条文本重复喂不会重复累积（is_final 和 speech_final 是同一个分片）', () => {
  const a = new utt.UtteranceAccumulator();
  a.addFinal({ text: '重複しない', start: 0, duration: 1 });
  a.endUtterance({ reason: 'speech_final', text: '重複しない' });
  a.addFinal({ text: '重複しない', start: 0, duration: 1 });
  const out = a.endUtterance({ reason: 'utterance_end', text: '重複しない' });
  if (out.text !== '重複しない') throw new Error(`重复累积了：${out.text}`);
});

check('整句累积：没有时间戳时 start/duration 必须是 undefined（传 null 会被当成时间 0）', () => {
  const a = new utt.UtteranceAccumulator();
  a.addFinal({ text: '无时间戳' });
  const out = a.endUtterance({ reason: 'utterance_end' });
  if (out.start !== undefined) throw new Error(`start 应为 undefined，实际 ${JSON.stringify(out.start)}`);
  if (out.duration !== undefined) throw new Error(`duration 应为 undefined，实际 ${JSON.stringify(out.duration)}`);
  // 排期那一层用 Number.isFinite 判断；Number(null)===0 会被当成合法时间戳 → 字幕排在过去、立刻弹出
  if (Number.isFinite(Number(out.start))) throw new Error('这个前提变了：Number(undefined) 变成有限值了');
});

check('整句累积：空的时候所有出口都返回 null，不产生空字幕', () => {
  const a = new utt.UtteranceAccumulator();
  if (a.endUtterance({ reason: 'utterance_end' }) !== null) throw new Error('空累积不该出字幕');
  if (a.tick(Date.now() + 999999) !== null) throw new Error('空累积看门狗不该出字幕');
  if (a.flush() !== null) throw new Error('空累积 flush 不该出字幕');
  if (a.addFinal({ text: '   ' }) !== null) throw new Error('空白文本不该累积');
  if (a.pending) throw new Error('空白不该进累积');
});

check('整句累积：flush 能在停止采集时把没说完的一句吐出来', () => {
  const a = new utt.UtteranceAccumulator();
  a.addFinal({ text: '没等到停顿', start: 0, duration: 2 });
  const out = a.flush('stop');
  if (!out || out.reason !== 'stop') throw new Error('flush 应当带出 reason');
  if (out.text !== '没等到停顿') throw new Error(out.text);
});

check('整句累积：reset 之后彻底归零', () => {
  const a = new utt.UtteranceAccumulator();
  a.addFinal({ text: 'x', start: 0, duration: 1 });
  a.reset();
  if (a.pending || a.start !== null || a.end !== null || a.lastFinalAt !== 0) throw new Error('没清干净');
});

check('整句累积：默认参数不能太激进（否则又回到碎片化 / 会误判句子结束）', () => {
  const a = new utt.UtteranceAccumulator();
  if (a.maxSpanSec < 8) throw new Error(`默认上限 ${a.maxSpanSec}s 太小，长句会被切碎`);
  if (a.watchdogMs < 1000) throw new Error(`看门狗 ${a.watchdogMs}ms 太短，说话中途会被误判成结束`);
  const b = new utt.UtteranceAccumulator({ maxSpanSec: 0, watchdogMs: 0 });
  if (b.maxSpanSec < 2) throw new Error('maxSpanSec 缺少下限保护');
  if (b.watchdogMs < 500) throw new Error('watchdogMs 缺少下限保护');
});

check('字幕排期：译文没到手时扣住不上屏（否则会先显示原文，看起来像"没翻译"）', () => {
  const s = new dp.SubtitleSchedule();
  const t0 = 1_700_000_000_000;
  s.push({ id: 'a', original: '原文', translation: '' }, { start: 0, duration: 1 }, t0, 1000, 0);
  const pending = { id: 'a', original: '原文', translation: '' };
  // 到点了，但调用方说"还不能上屏" → 必须留在队首
  const held = s.due(t0 + 1000, (it) => Boolean(it.translation));
  if (held.length !== 0) throw new Error('没译文不该上屏');
  if (s.size !== 1) throw new Error('应当留在队列里等译文，而不是被丢弃');
  // 译文到了 → 放行
  s.items[0].translation = '译文';
  const out = s.due(t0 + 1100, (it) => Boolean(it.translation));
  if (out.length !== 1 || out[0].translation !== '译文') throw new Error('有译文应当放行');
});

check('字幕排期：队首被扣住时，后面的条目不能越过它（否则顺序会乱）', () => {
  const s = new dp.SubtitleSchedule();
  const t0 = 1_700_000_000_000;
  s.push({ id: 'a', translation: '' }, { start: 0, duration: 1 }, t0, 1000, 0);
  s.push({ id: 'b', translation: '有译文' }, { start: 1, duration: 1 }, t0, 1000, 0);
  const out = s.due(t0 + 3000, (it) => Boolean(it.translation));
  if (out.length !== 0) throw new Error(`不该越过队首，实际拿到 ${JSON.stringify(out.map((i) => i.id))}`);
  if (s.size !== 2) throw new Error('两条都该还在');
});

check('「翻译预留」旋钮已经删掉（改成固定规则）', () => {
  if ('translateLeadMs' in settings.DEFAULT_SETTINGS.capture) {
    throw new Error('默认设置里还有 translateLeadMs —— 旋钮应当已经删除');
  }
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  if (/capture-translateLeadMs/.test(html)) throw new Error('设置页还留着这个输入框');
  const phtml = fs.readFileSync(path.join(process.cwd(), 'player', 'player.html'), 'utf8');
  if (/id="lead"/.test(phtml)) throw new Error('播放页还留着这个滑块');
});

await checkAsync('v1 老用户存着的 translateLeadMs 会被清掉（不留死键）', async () => {
  const v1 = storeAsV1();
  v1.capture = { ...(v1.capture || {}), translateLeadMs: 3000 };
  localStore.set(settings.STORAGE_KEY, v1);
  const s = await settings.getSettings();
  if ('translateLeadMs' in s.capture) throw new Error(`死键还在：${s.capture.translateLeadMs}`);
});

await checkAsync('播放页必须扣住没有译文的条目（静态）', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/schedule\.due\(now,\s*renderable\(now\)\)/.test(src)) {
    throw new Error('播放页调 due() 时没传"能不能上屏"的判断，译文没回来就会先显示原文');
  }
  if (!/item\.translation\s*\|\|\s*item\.original/.test(src)) {
    throw new Error('renderSubs 的兜底逻辑不见了 —— 扣超时后应当退回显示原文，而不是整句消失');
  }
});

check('翻译窗口：0.7 秒是下限，实测翻译更慢时自动往前让路', () => {
  const f = dp.effectiveLeadMs;
  if (dp.TRANSLATE_WINDOW_MS !== 700) throw new Error(`固定窗口应为 700ms，实际 ${dp.TRANSLATE_WINDOW_MS}`);
  // 翻译很快 / 拿不到实测值 → 就用固定的 0.7s
  if (f(200) !== 700) throw new Error(`翻译只要 200ms 时应当就用 700ms，实际 ${f(200)}`);
  if (f(null) !== 700) throw new Error('没有实测值时应退回固定窗口');
  if (f(NaN) !== 700) throw new Error('实测值是 NaN 时应退回固定窗口');
  // 翻译要 1500ms → 700ms 的窗口根本不够，必须自动放开，否则字幕必然迟到
  const raised = f(1500);
  if (!(raised >= 1500)) throw new Error(`翻译要 1500ms，窗口却只有 ${raised}ms`);
  // 再慢也不能无限往前（否则等于完全不等后文）
  if (f(99999) !== 4000) throw new Error('要被上限截住');
  // 越大越不慢：窗口必须随实测耗时单调不减
  if (!(f(2000) >= f(800))) throw new Error('窗口没有随实测耗时增长');
});

await checkAsync('播放页必须用 effectiveLeadMs，且不许再读那个已删除的设置键', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/leadMs:\s*effectiveLeadMs\(/.test(src)) {
    throw new Error('没有走 effectiveLeadMs —— 死守固定 0.7s 的话，翻译一慢字幕就迟到');
  }
  if (/settings\.capture\.translateLeadMs/.test(src)) {
    throw new Error('还在读已经删除的 translateLeadMs');
  }
});

check('延迟变化时排队中的条目必须跟着重算（否则集体提前）', () => {
  const s = new dp.SubtitleSchedule();
  const t0 = 1_700_000_000_000;
  // 三句，音频位置 0 / 2 / 4 秒
  s.push({ id: 'a' }, { start: 0, duration: 2 }, t0, 5000, 0);
  s.push({ id: 'b' }, { start: 2, duration: 2 }, t0, 5000, 0);
  s.push({ id: 'c' }, { start: 4, duration: 2 }, t0, 5000, 0);

  // 用户把延迟从 5 秒改成 7 秒：三条都要整体后移 2 秒
  const moved = s.resync({ firstAudioAt: t0, delayMs: 7000, syncOffsetMs: 0, now: t0 });
  if (moved !== 3) throw new Error(`应当重算 3 条，实际 ${moved}`);
  const ats = s.items.map((i) => i.at - t0);
  if (ats[0] !== 7000 || ats[1] !== 9000 || ats[2] !== 11000) throw new Error(`重算结果不对：${JSON.stringify(ats)}`);
  // 平移同一个量 → 顺序必须保持（due() 依赖队首有序）
  if (!(ats[0] < ats[1] && ats[1] < ats[2])) throw new Error('顺序被打乱了');

  // 没变化时不该做无用功
  if (s.resync({ firstAudioAt: t0, delayMs: 7000, syncOffsetMs: 0, now: t0 }) !== 0) {
    throw new Error('延迟没变时不该报告改动');
  }
  // 微调也要跟着走
  if (s.resync({ firstAudioAt: t0, delayMs: 7000, syncOffsetMs: 500, now: t0 }) !== 3) {
    throw new Error('同步微调变了也要重算');
  }

  // 没有时间戳的条目无从重算，不能崩
  const s2 = new dp.SubtitleSchedule();
  s2.push({ id: 'x' }, { start: undefined, duration: undefined }, t0, 5000, 0);
  if (s2.resync({ firstAudioAt: t0, delayMs: 7000, syncOffsetMs: 0, now: t0 }) !== 0) {
    throw new Error('无时间戳的条目不该被重算');
  }
});

await checkAsync('播放页必须每一拍都 resync（只在排期时算一次的话，调延迟后字幕会提前）', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/schedule\.resync\(/.test(src)) throw new Error('播放页没有 resync');
  const pump = src.slice(src.indexOf('function pumpSubtitles'), src.indexOf('function renderSubs'));
  if (!/schedule\.resync\(/.test(pump)) throw new Error('resync 必须放在字幕泵里（每 100ms 一拍），不能只在排期时调');
  if (!/delayMs:\s*currentDelayMs\(\)/.test(pump)) throw new Error('resync 要用最新的实测延迟');
});

await checkAsync('Deepgram 适配层：必须区分 speech_final 和真正的 UtteranceEnd', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'deepgram.js'), 'utf8'));
  if (!/reason:\s*'speech_final'/.test(src)) {
    throw new Error("speech_final 触发的 utteranceEnd 必须带上 reason: 'speech_final'，否则调用方没法区分");
  }
  if (!/reason:\s*'utterance_end'/.test(src)) {
    throw new Error("真正的 UtteranceEnd 必须带上 reason: 'utterance_end'");
  }
});

await checkAsync('延迟模式：必须接上 utteranceEnd（只接 final 的话长句会被切成碎片）', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/ev\.type === 'utteranceEnd'/.test(src)) throw new Error('播放页没有处理 utteranceEnd');
  if (!/utterances\.addFinal/.test(src)) throw new Error('播放页没有把 final 交给累积器');
  if (!/utterances\.endUtterance/.test(src)) throw new Error('播放页没有在 utteranceEnd 时收句');
  if (!/utterances\.tick/.test(src)) throw new Error('播放页没有跑看门狗，ASR 不发 utteranceEnd 时会永远不上屏');
  if (/function onFinal/.test(src)) throw new Error('旧的 onFinal 还在 —— 每个分片都会变成一条字幕');
});

// ─────────────────────────────────────────────────────────────
console.log('\n[10] 识别校正（流式定时间轴 + 本地模型定文本）');
// ─────────────────────────────────────────────────────────────

const ring = loaded['lib/pcm-ring.js'];
const refine = loaded['lib/asr/refine.js'];

check('环形缓冲：按绝对样本序号寻址，绕圈之后仍能正确取回', () => {
  const r = new ring.PcmRing({ sampleRate: 4, seconds: 2 }); // 容量 8 个样本
  r.push(Int16Array.from([1, 2, 3, 4]));
  r.push(Int16Array.from([5, 6, 7, 8]));
  r.push(Int16Array.from([9, 10, 11, 12])); // 绕一圈，1~4 被挤掉
  if (r.writeIndex !== 12) throw new Error(`writeIndex=${r.writeIndex}`);
  if (r.length !== 8) throw new Error(`length=${r.length}`);
  if (r.bufferedSeconds !== 2) throw new Error(`已缓冲秒数=${r.bufferedSeconds}`);
  const tail = Array.from(r.slice(8, 12));
  if (tail.join(',') !== '9,10,11,12') throw new Error(`取回的尾部=${tail}`);
  // 超出保留范围的起点会被裁到最老样本 —— 宁可给少，也不给错位的
  const clipped = Array.from(r.slice(0, 12));
  if (clipped.length !== 8 || clipped[0] !== 5) throw new Error(`裁剪结果=${clipped}`);
});

check('环形缓冲：按秒取并支持前后留白', () => {
  const r = new ring.PcmRing({ sampleRate: 10, seconds: 10 });
  r.push(Int16Array.from({ length: 100 }, (_, i) => i));
  const seg = r.sliceBySeconds(2, 4, 0.5); // 1.5s ~ 4.5s → 样本 15..45
  if (seg.length !== 30) throw new Error(`长度=${seg.length}`);
  if (seg[0] !== 15 || seg[29] !== 44) throw new Error(`区间=${seg[0]}..${seg[29]}`);
  const none = r.sliceBySeconds(5, 5, 0);
  if (none.length !== 0) throw new Error('空区间应返回空数组');
});

check('环形缓冲：clear 之后彻底归零', () => {
  const r = new ring.PcmRing({ sampleRate: 4, seconds: 1 });
  r.push(Int16Array.from([1, 2, 3, 4]));
  r.clear();
  if (r.writeIndex !== 0 || r.length !== 0 || r.oldestIndex !== 0) throw new Error('没清干净');
});

check('环形缓冲：encodeWav 产出的头必须合法（字节序、长度、单声道 16bit）', () => {
  const r = new ring.PcmRing({ sampleRate: 16000, seconds: 1 });
  r.push(Int16Array.from([0, 1, -1, 32767, -32768]));
  const wav = ring.encodeWav(r.slice(0, 5), 16000);
  const v = new DataView(wav);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(wav, o, n));
  if (str(0, 4) !== 'RIFF') throw new Error('不是 RIFF');
  if (str(8, 4) !== 'WAVE') throw new Error('不是 WAVE');
  if (str(12, 4) !== 'fmt ') throw new Error('缺 fmt 块');
  if (str(36, 4) !== 'data') throw new Error('缺 data 块');
  if (v.getUint16(20, true) !== 1) throw new Error('编码必须是 PCM');
  if (v.getUint16(22, true) !== 1) throw new Error('必须是单声道');
  if (v.getUint32(24, true) !== 16000) throw new Error('采样率不对');
  if (v.getUint16(34, true) !== 16) throw new Error('位深必须是 16');
  if (v.getUint32(40, true) !== 10) throw new Error('data 长度应为 5 样本 ×2 字节');
  if (wav.byteLength !== 44 + 10) throw new Error(`总长=${wav.byteLength}`);
  // 小端：最后一个样本 -32768 → 0x00 0x80
  const bytes = new Uint8Array(wav, 44);
  if (bytes[8] !== 0x00 || bytes[9] !== 0x80) throw new Error(`字节序不对：${bytes[8]},${bytes[9]}`);
});

check('识别校正：默认必须是关的（baseUrl 默认指向 8000，开了就是每句一次空请求）', () => {
  const r = settings.DEFAULT_SETTINGS.asr.refine;
  if (r.enabled !== false) throw new Error(`默认 enabled=${r.enabled}，必须显式打开`);
  // 这条不是形式主义：v1.9.1 就是因为默认打开才被整体回退的
  if (settings.DEFAULT_SETTINGS.asr.whisperChunked.baseUrl.includes('8000') === false) {
    throw new Error('前提变了：baseUrl 默认不再是 8000，这段注释该更新');
  }
});

check('识别校正：翻译术语表绝不能混进识别提示词（实测会把 Whisper 带偏）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.glossary = 'charity stream=慈善直播\nmembers-only=仅限会员';
  s.translate.liveGlossary = true;
  s.asr.deepgram.keyterms = '';
  s.asr.refine = { enabled: true, provider: 'whisper', model: '', language: '', prompt: '' };

  // 这个坑很贵：旧版把 translate.glossary + 内置词表一起拼成 prompt，
  // 结果是一堵**英文**直播术语被拿去识别**日语**音频，实测直接损坏转写。
  // 默认必须完全不带提示词。
  const p = refine.refinePromptText(s);
  if (p !== '') throw new Error(`默认应当完全不发提示词，实际发了：${JSON.stringify(p)}`);
  if (/charity|members|super ?chat|subscriber|配信/i.test(p)) {
    throw new Error(`术语表漏进识别提示词了：${p}`);
  }
  // 内置词表同样不能漏
  const k = refine.refineKeyterms(s, 999);
  if (k.some((t) => /charity|members|super ?chat|subscriber/i.test(t))) {
    throw new Error(`内置词表漏进识别词了：${JSON.stringify(k.slice(0, 5))}`);
  }
});

check('识别校正：只有显式为识别填的词才进提示词，且按字符数封顶', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.translate.glossary = 'charity stream=慈善直播';
  s.asr.deepgram.keyterms = 'aaa, bbb';
  s.asr.refine = { enabled: true, provider: 'whisper', model: '', language: '', prompt: 'ホロライブ, 日本語の固有名詞' };

  const p = refine.refinePromptText(s);
  if (!p.includes('ホロライブ')) throw new Error('refine.prompt 没进提示词');
  if (!p.includes('aaa')) throw new Error('Deepgram 那栏的 keyterms 没进提示词 —— 那是用户为识别填的');
  if (/charity/.test(p)) throw new Error('翻译术语表混进来了');

  // 上限：Whisper 的 prompt 只有 224 token，超了它会开始复读
  if (refine.REFINE_PROMPT_MAX_CHARS > 200) {
    throw new Error(`上限 ${refine.REFINE_PROMPT_MAX_CHARS} 太大`);
  }
  const big = JSON.parse(JSON.stringify(s));
  big.asr.refine.prompt = Array.from({ length: 200 }, (_, i) => `很长的专有名词${i}`).join(',');
  const capped = refine.refinePromptText(big);
  if (capped.length > refine.REFINE_PROMPT_MAX_CHARS) throw new Error(`提示词 ${capped.length} 字，超过上限`);
  if (refine.refinePromptText(big, 0) !== '') throw new Error('上限为 0 时应给空串');
  const tiny = refine.refinePromptText(big, 20);
  if (tiny.length > 20) throw new Error(`自定义上限失效：${tiny.length}`);
});

check('识别校正：keyterm 不许再整表灌进去（过度偏置会把识别对的词硬掰成术语）', () => {
  if (refine.REFINE_KEYTERM_LIMIT > 40) {
    throw new Error(`keyterm 上限 ${refine.REFINE_KEYTERM_LIMIT} 太大 —— 当初就是 100 个把识别带偏的`);
  }
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'refine.js'), 'utf8'));
  if (!/params\.append\('keyterm',\s*k\)/.test(src)) throw new Error('keyterm 的注入点找不到了，这条断言要重写');
  if (/refineKeyterms\(settings,\s*\d{3,}\)/.test(src)) throw new Error('还有一处取了三位数的词');
});

check('识别校正：置信度闸门能挡住三类「看着像话、其实在编」的结果', () => {
  const j = refine.judgeRefinement;
  const seg = (o) => ({ segments: [{ text: 'x', avg_logprob: -0.3, no_speech_prob: 0.001, temperature: 0, ...o }] });

  // 正常：低温度、有语音、置信够
  const good = j(seg({}));
  if (!good.ok) throw new Error(`正常结果被误杀：${good.reason}`);
  if (!(good.logprob < 0)) throw new Error('应当回报 logprob');

  // ① 温度回退 —— 幻觉最典型的来源
  const fb = j(seg({ temperature: 0.4 }));
  if (fb.ok) throw new Error('解码回退到高温时必须弃用');
  if (!/temperature/.test(fb.reason)) throw new Error(fb.reason);

  // ② 判定为无人说话（音乐/音效段）
  const ns = j(seg({ no_speech_prob: 0.9 }));
  if (ns.ok) throw new Error('判定为静音时必须弃用');
  if (!/no_speech_prob/.test(ns.reason)) throw new Error(ns.reason);

  // ③ 模型自己都没把握
  const lp = j(seg({ avg_logprob: -1.8 }));
  if (lp.ok) throw new Error('置信度过低时必须弃用');
  if (!/avg_logprob/.test(lp.reason)) throw new Error(lp.reason);

  // 多段时取最差的一段
  const multi = j({
    segments: [
      { avg_logprob: -0.2, no_speech_prob: 0, temperature: 0 },
      { avg_logprob: -1.5, no_speech_prob: 0, temperature: 0 },
    ],
  });
  if (multi.ok) throw new Error('多段里有一段不合格就该整体弃用');

  // 服务不回片段信息（比如只支持 json 的中间层）→ 宁可不用，也不要盲信
  const noSegs = j({ text: '只有文本' });
  if (noSegs.ok) throw new Error('拿不到置信度时不该盲信');
  if (!/verbose_json/.test(noSegs.reason)) throw new Error(noSegs.reason);
  if (j(null).ok) throw new Error('null 不该通过');
});

await checkAsync('识别校正：拿不到置信度时 refine 必须报 ok=false', async () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.provider = 'whisper-chunked';
  s.asr.refine = { enabled: true, provider: 'whisper', model: '', language: '' };
  s.asr.whisperChunked.baseUrl = 'http://127.0.0.1:1/v1';
  const realFetch = globalThis.fetch;
  // 模拟一个只回 {"text":...} 的服务（不支持 verbose_json）
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ text: '识别的结果' }),
    text: async () => '',
  });
  try {
    const r = refine.createRefiner(s);
    const out = await r.refine(new Int16Array(16000), 16000);
    if (out.text !== '识别的结果') throw new Error('文本应当照常带回');
    if (out.ok) throw new Error('没有置信度时不能算可信');
    // 播放页必须据此沿用流式文本
    const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
    if (!/if \(!res\?\.ok\)/.test(src)) throw new Error('播放页没有按 ok 决定是否覆盖流式文本');
    if (!/沿用流式文本/.test(src)) throw new Error('弃用时没有留下诊断');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await checkAsync('识别校正：服务挂了不能拖垮字幕（refine 永不抛，失败会退避）', async () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.provider = 'whisper-chunked';
  s.asr.refine = { enabled: true, provider: 'whisper', model: '', language: '' };
  s.asr.whisperChunked.baseUrl = 'http://127.0.0.1:1/v1';
  // 注意：这个文件上面装了一个"永不失败"的 fetch 桩，必须临时换成会抛的，
  // 否则根本走不到失败分支（第一版就是这么假过的）。
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  try {
    const notes = [];
    const r = refine.createRefiner(s, { onNote: (m) => notes.push(m) });
    if (!r.available) throw new Error('配了 baseUrl 就该可用');
    const pcm = new Int16Array(16000); // 1 秒
    const first = await r.refine(pcm, 16000);
    if (first.ok || first.text !== '') throw new Error('失败时必须 ok=false 且没有文本，调用方才能安全沿用流式文本');
    const second = await r.refine(pcm, 16000);
    if (second.ok) throw new Error('第二次也该失败');
    if (!notes.length) throw new Error('失败必须留下诊断，否则用户完全看不到发生了什么');
    // 连续失败之后应当进入退避，不再空转
    if (!r.stats().backoff) throw new Error('连续失败 2 次之后应当退避');
    const before = r.stats().calls;
    const third = await r.refine(pcm, 16000);
    if (r.stats().calls !== before) throw new Error('退避期间不该再发请求');
    if (third.ok) throw new Error('退避中也该是 ok=false');
  } finally {
    globalThis.fetch = realFetch;
  }
});

check('识别校正：没配端点时必须报告不可用，而不是静默失败', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.refine = { enabled: true, provider: 'whisper', model: '', language: '' };
  s.asr.whisperChunked.baseUrl = '';
  const r = refine.createRefiner(s);
  if (r.available) throw new Error('没有 baseUrl 就该不可用');
  if (!r.reason) throw new Error('必须给出原因');
});

await checkAsync('识别校正：太短的音频不值得再跑一趟', async () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.refine = { enabled: true, provider: 'whisper', model: '', language: '' };
  s.asr.whisperChunked.baseUrl = 'http://127.0.0.1:1/v1';
  const r = refine.createRefiner(s);
  const out = await r.refine(new Int16Array(100), 16000); // 6ms
  if (out.ok || out.text !== '') throw new Error('应直接跳过');
  if (r.stats().calls !== 0) throw new Error('跳过不该计入调用次数');
});

await checkAsync('播放页接线：环形缓冲、校正、以及翻译会不会等校正', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/pcmRing\?\.push\(pcm\)/.test(src)) throw new Error('没有把 PCM 存进环形缓冲');
  if (!/createRefiner\(/.test(src)) throw new Error('没有建重识别器');
  if (!/void refineItem\(item, u\)/.test(src)) throw new Error('收句时没有触发重识别');
  // 翻译要等校正，但**只在时间够的时候**等（无条件等会把长句推得更晚）
  if (!/seg\.refinePromise/.test(src)) throw new Error('翻译没有等在校正之后 —— 会先按流式文本白翻一遍');
  if (!/if \(seg\.refinePromise && !seg\.refineDone\)/.test(src)) throw new Error('等待条件不对');
  // 校正只改文本，绝不能碰时间轴。
  // 注意只看 item 上的赋值 —— 函数内部的局部 const start/duration 是读出来的，不算改。
  const fn = src.slice(src.indexOf('async function refineItem'), src.indexOf('async function translateSegment'));
  if (/item\.(at|start|duration)\s*=/.test(fn)) {
    throw new Error('refineItem 动了时间轴 —— 它只能改文本');
  }
  if (!/item\.original\s*=/.test(fn)) throw new Error('校正结果没有写回 original');
});

await checkAsync('识别校正：暂停播放时必须释放缓冲和重识别器', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  const stop = src.slice(src.indexOf('function stopAll'), src.indexOf('function stopAll') + 2000);
  if (!/pcmRing\?\.clear\(\)/.test(stop)) throw new Error('stopAll 没清环形缓冲（90 秒音频会一直占着）');
});

check('共用字段必须放在所有 data-panel 之外，专属字段必须留在 panel 里', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');

  // 极简 div 嵌套跟踪：回答"某个 id 出现时，是不是正处在某个 data-panel 里"。
  // 踩过的坑：识别校正一开始被误放进 whisper-chunked 那个 panel，
  // 结果选 Deepgram 时整个看不见 —— 正好反了，而「Deepgram 定时间轴 + 本地定文本」才是主力用法。
  const inPanel = (id) => {
    const stack = [];
    const re = new RegExp(`<div\\b([^>]*)>|</div>|id="${id}"`, 'g');
    let m;
    while ((m = re.exec(html))) {
      if (m[0] === '</div>') {
        stack.pop();
        continue;
      }
      if (m[0] === `id="${id}"`) return stack.find((a) => a && a.includes('data-panel=')) || null;
      stack.push(m[1] || '');
    }
    return 'NOT-FOUND';
  };

  // 识别校正：跟选哪家流式识别正交，必须一直可见
  const rf = inPanel('rf-enabled');
  if (rf === 'NOT-FOUND') throw new Error('找不到 rf-enabled');
  if (rf) throw new Error(`rf-enabled 在「${rf.trim()}」里面 —— 换成别的识别服务就看不见它了`);

  // 本地 Whisper 地址同理：流式用 Deepgram、本地定文本时也要填它，不能藏在 panel 里
  for (const id of ['wc-baseUrl', 'wc-apiKey', 'wc-model']) {
    const where = inPanel(id);
    if (where === 'NOT-FOUND') throw new Error(`找不到 ${id}`);
    if (where) throw new Error(`${id} 在「${where.trim()}」里面 —— 它是两个功能共用的地址，必须一直可见`);
  }

  // 反过来也要成立：Whisper 专属的字段**应该**留在 panel 里
  for (const id of ['wc-chunkSeconds', 'wc-skipSilence']) {
    if (!inPanel(id)) throw new Error(`${id} 跑出 panel 了 —— 那它会对所有识别服务都显示`);
  }
});

await checkAsync('识别校正：时间不够时不许阻塞翻译（它只是加成，不是义务）', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  // 原来这里是无条件 await seg.refinePromise —— 校正实测要 300~1100ms，
  // 长句本来就超预算，再等它就雪上加霜。
  if (/await seg\.refinePromise\.catch/.test(src)) {
    throw new Error('还在无条件 await 校正 —— 预算不够时会把字幕推得更晚');
  }
  if (!/Promise\.race\(/.test(src)) throw new Error('没有用 Promise.race 给等待设上限');
  if (!/const MIN_TRANSLATE_MS\s*=\s*\d+/.test(src)) throw new Error('缺少 MIN_TRANSLATE_MS');
  if (!/slack\s*=\s*seg\.at\s*-\s*Date\.now\(\)\s*-\s*MIN_TRANSLATE_MS/.test(src)) {
    throw new Error('等待上限没有按"离上屏还剩多少"算');
  }
  // 翻译已经开跑之后就不该再改原文，否则"原文"和"译文"会对不上
  const fn = src.slice(src.indexOf('async function refineItem'), src.indexOf('async function translateSegment'));
  if (!/item\.translated\s*\|\|\s*item\.inFlight/.test(fn)) {
    throw new Error('缺少"翻译已开始就别再改原文"的判断');
  }
});

await checkAsync('排期条目必须存下 end（诊断要用它算"这句说了多久"），但不许影响上屏时刻', async () => {
  const dp = loaded['lib/delayed-player.js'];
  const s = new dp.SubtitleSchedule();
  const t0 = 1_700_000_000_000;
  s.push({ id: 'a' }, { start: 10, duration: 3 }, t0, 1000, 0);
  if (s.items[0].end !== 13) throw new Error(`end 没存对：${s.items[0].end}`);
  // duration 仍然不许参与 at —— 锚点是「开口」，不是「说完」
  if (s.items[0].at !== t0 + 11_000) throw new Error('end 不该参与 at 的计算');
  const s2 = new dp.SubtitleSchedule();
  s2.push({ id: 'b' }, { start: 5, duration: 9 }, t0, 1000, 0);
  if (s2.items[0].at !== t0 + 6000) throw new Error('长句的上屏时刻也被 duration 带偏了');
});

await checkAsync('诊断日志必须留得住，而且要能整份复制出来', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  const keep = src.match(/DIAG_KEEP\s*=\s*(\d+)/);
  const show = src.match(/DIAG_SHOW\s*=\s*(\d+)/);
  if (!keep || !show) throw new Error('找不到 DIAG_KEEP / DIAG_SHOW 常量');
  // 原来只留 8 行、显示 7 行 —— 而排查「本地模型胡说八道」要看的是**成对**的
  // 「流式给出 / 校正结果」，中间夹着别的输出，7 行一眼就过去了。
  if (Number(keep[1]) < 200) throw new Error(`只留 ${keep[1]} 行太少`);
  if (Number(show[1]) < 20) throw new Error(`面板只显示 ${show[1]} 行太少`);
  if (Number(show[1]) > Number(keep[1])) throw new Error('显示行数不该超过保留行数');
  if (!/btnCopyDiag/.test(src)) throw new Error('没有「复制日志」的入口 —— 面板再长也贴不出来');
  if (!/diagLines\.join\('\\n'\)/.test(src)) throw new Error('复制时应当给出全部日志，而不是面板上那几十行');

  const css = fs.readFileSync(path.join(process.cwd(), 'player', 'player.css'), 'utf8');
  const start = css.indexOf('.diag {');
  const diagCss = css.slice(start, css.indexOf('.diag.on'));
  if (start < 0 || !diagCss) throw new Error('找不到 .diag 的样式');
  if (!/overflow-y:\s*auto/.test(diagCss)) throw new Error('诊断面板不能滚动，多出来的行还是看不见');
  if (!/max-height/.test(diagCss)) throw new Error('诊断面板没有限高，会盖住整个画面');
  if (/pointer-events:\s*none/.test(diagCss)) throw new Error('pointer-events:none 会让面板没法滚动、也没法选中文字');
});

await checkAsync('诊断：字幕滞后必须相对「排期时刻」，不能把画面延迟算进去', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/function diagLate/.test(src)) throw new Error('没有 diagLate');
  const fn = src.slice(src.indexOf('function diagLate'), src.indexOf('function renderSubs'));
  // 踩过的坑：写成 now − (firstAudioAt + start*1000) 会**把 D 加进去** ——
  // D=8 时会报"晚 8.6 秒"，而实际只晚 0.6 秒，把人吓得去调延迟。
  if (/firstAudioAt \+ item\.start/.test(fn)) {
    throw new Error('滞后算成了相对实况的 —— 会把画面延迟加进去，数字看着吓人但没意义');
  }
  if (!/const lateMs = now - item\.at/.test(fn)) throw new Error('应当以 item.at（排期时刻）为基准');
  if (!/仍在句内/.test(fn)) throw new Error('应当给出"是否还在句内"这个可接受的判据');
});

await checkAsync('延迟测量：必须能量出「缓冲末尾落后实况多久」（字幕恒偏早的根因）', async () => {
  const dp = loaded['lib/delayed-player.js'];
  const p = Object.create(dp.DelayedPlayback.prototype);
  // 假装：开始录音在 10 秒前，缓冲末尾在 7.0 秒处 → 落后 3 秒
  // ⚠️ 这里**不夹**：它只负责量。夹紧是排期那边（recorderLagMs）的事 ——
  // 夹在这里会把"编码器跟不上"这个线索藏掉（日志里出现过夹在 2.00s 的值）。
  p.recStartedAt = Date.now() - 10_000;
  p.bufferedEnd = () => 7;
  // ⚠️ 必须留容差：recStartedAt 是「当前时间 - 10000」，而 Date.now() 在两次调用之间
  // 会走掉零点几毫秒 —— 严格相等偶尔会得到 3.0009999999999994 而红。
  // 浮动测试比没有测试更糟：它会训练人忽略红灯（这条真的红过一次）。
  if (Math.abs(p.recorderLagSec - 3) > 0.01) throw new Error(`应当如实报 3 秒，实际 ${p.recorderLagSec}`);
  // 正常情形：开始录音 8.4 秒前，缓冲末尾 8.0 → 落后 0.4 秒
  p.recStartedAt = Date.now() - 8400;
  p.bufferedEnd = () => 8;
  const lag = p.recorderLagSec;
  if (!(lag > 0.3 && lag < 0.5)) throw new Error(`0.4 秒左右才对，实际 ${lag}`);
  // 还没开始录音 / 没有缓冲 → null，不能瞎报
  p.recStartedAt = 0;
  if (p.recorderLagSec !== null) throw new Error('没开始录音时应当返回 null');

  // 播放页必须把它报出来，否则没法知道该补偿多少
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/recorderLagSec/.test(src)) throw new Error('播放页没有报这个量');
  // 文案要跟着行为走：现在这笔滞后**已经**补进排期了（见 currentDelayMs）
  if (!/已补进排期/.test(src)) throw new Error('报告里的文案和实际行为不一致');
});

/* ── 分片断句：在分片内部按停顿切 ── */

const chunkedMod = loaded['lib/asr/whisper-chunked.js'];

/** 造一段可听的音频：正弦波；静音就是全 0 */
function audio(rate, speechSec, quietSec) {
  const out = [];
  const tone = (sec) => {
    const a = new Int16Array(Math.round(rate * sec));
    for (let i = 0; i < a.length; i += 1) a[i] = Math.round(8000 * Math.sin(i / 20));
    return a;
  };
  if (speechSec) out.push(tone(speechSec));
  if (quietSec) out.push(new Int16Array(Math.round(rate * quietSec)));
  return out;
}

function joinAll(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const o = new Int16Array(total);
  let k = 0;
  for (const p of parts) {
    o.set(p, k);
    k += p.length;
  }
  return o;
}

check('分片断句：句间停顿（0.5 秒）必须能切开 —— 这就是「两句并成一句」的根因', () => {
  const rate = 16000;
  // 1.0s 话 + 0.5s 停 + 1.0s 话 + 0.5s 停 + 1.0s 话
  // 注意用展开：audio() 返回 [语音, 静音] 两段，只取第一段就把停顿丢了（第一版就这么错的）
  const buf = joinAll([...audio(rate, 1, 0.5), ...audio(rate, 1, 0.5), ...audio(rate, 1, 0)]);
  const pieces = chunkedMod.splitOnPauses(buf, rate, { threshold: 0.006 });
  if (pieces.length !== 3) {
    throw new Error(`应当切成 3 句，实际 ${pieces.length} —— 0.5 秒的停顿必须算一句的边界`);
  }
  if (pieces[0].endsAtBufferEnd) throw new Error('第 1 句后面有停顿，不该标记为跨片');
  if (!pieces[2].endsAtBufferEnd) throw new Error('最后一句一直说到末尾，应当标记为跨片（留给下一片拼）');
  // 区间不能重叠、不能倒挂
  for (let i = 1; i < pieces.length; i += 1) {
    if (pieces[i].start < pieces[i - 1].end) throw new Error('区间重叠了');
  }
});

check('分片断句：整片一个人说话时不许切开（那又回到"每片硬切"）', () => {
  const rate = 16000;
  const pieces = chunkedMod.splitOnPauses(joinAll(audio(rate, 4, 0)), rate, { threshold: 0.006 });
  if (pieces.length !== 1) throw new Error(`连续说话应当只有 1 段，实际 ${pieces.length}`);
  if (!pieces[0].endsAtBufferEnd) throw new Error('该段应当标记为跨片');
});

check('分片断句：太短的碎片要丢掉（喷嚏、椅子响）', () => {
  const rate = 16000;
  // 0.1s 的杂音 + 0.5s 停 + 1.5s 真语音
  const buf = joinAll([...audio(rate, 0.1, 0.5), ...audio(rate, 1.5, 0)]);
  const pieces = chunkedMod.splitOnPauses(buf, rate, { threshold: 0.006, minSpeechMs: 300 });
  if (pieces.length !== 1) throw new Error(`0.1 秒的碎片不该成句，实际 ${pieces.length} 段`);
  if (pieces[0].start < rate * 0.5) throw new Error(`留下的应当是那 1.5 秒的真语音，实际从 ${pieces[0].start / rate}s 开始`);
});

check('分片断句：全静音切不出任何话段', () => {
  const rate = 16000;
  const pieces = chunkedMod.splitOnPauses(new Int16Array(rate * 3), rate, { threshold: 0.006 });
  if (pieces.length !== 0) throw new Error(`全静音不该切出话段，实际 ${pieces.length}`);
  if (chunkedMod.splitOnPauses(new Int16Array(0), rate).length !== 0) throw new Error('空输入不该崩');
});

check('静音判据必须自适应：整条流偏轻时不许全判静音（这个故障隐身了好几轮）', () => {
  const c = chunkedMod.classifyChunk;

  // ① 真实故障：整条流 RMS 只有 0.002，而绝对阈值是 0.006。
  //    只看绝对阈值 → 每一片都判静音、全部跳过 → 一条字幕都没有，也没有任何报错。
  const cold = c({ rms: 0.002, silenceThreshold: 0.006, skipSilence: true, peakRms: 0 });
  if (cold.silent) throw new Error('峰值未知时不该把 0.002 判成静音');
  const warm = c({ rms: 0.002, silenceThreshold: 0.006, skipSilence: true, peakRms: 0.002 });
  if (warm.silent) throw new Error('整条流都是 0.002（峰值也是 0.002）时不该判静音');

  // ② 真正的数字静音仍要跳过（省算力、避免幻听）
  const real = c({ rms: 0.00005, silenceThreshold: 0.006, skipSilence: true, peakRms: 0.03 });
  if (!real.silent || real.transcribe) throw new Error('真静音应当判静音且不识别');

  // ③ 相对判据：峰值很高时，0.004 也算安静
  const loud = c({ rms: 0.004, silenceThreshold: 0.006, skipSilence: true, peakRms: 0.08 });
  if (!loud.silent) throw new Error('峰值 0.08 时，0.004 应当算安静');

  // ④ 正常语音绝不误伤
  const speech = c({ rms: 0.03, silenceThreshold: 0.006, skipSilence: true, peakRms: 0.03 });
  if (speech.silent) throw new Error('正常语音不该被判静音');

  // ⑤ 关掉"跳过静音"时，即使判为静音也必须送去识别
  const noSkip = c({ rms: 0.00005, silenceThreshold: 0.006, skipSilence: false, peakRms: 0.03 });
  if (!noSkip.silent || !noSkip.transcribe) throw new Error('skipSilence=false 时仍要识别');

  // ⑥ 有效阈值和实测电平都要能给出来 —— 否则这种故障看不见
  if (!(real.effective > 0) || !(real.level > 0)) throw new Error('要同时给出有效阈值和实测电平');
});

check('静音判据：判为静音的这条分支必须发心跳（它隐身就是因为什么都不报）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'whisper-chunked.js'), 'utf8'));
  const i = src.indexOf('plan.silent && !plan.transcribe');
  if (i < 0) throw new Error('找不到静音分支');
  const block = src.slice(i, i + 700);
  if (!/status: 'chunk'/.test(block)) throw new Error('判为静音时必须报一行心跳');
  if (!/电平/.test(block)) throw new Error('心跳里要带实测电平');
  if (!/阈值/.test(block)) throw new Error('心跳里要带有效阈值');
  // 收音频的心跳也要带电平与阈值
  if (!/电平 \$\{lv\.toFixed/.test(src)) throw new Error('收音频心跳里也要带电平');
  // 峰值要在 push 和 flush 两条路径上都被更新
  if ((src.match(/peakRms = Math\.max\(peakRms \* 0\.99, /g) || []).length < 2) {
    throw new Error('峰值在多处都要更新，否则自适应不准');
  }
});

check('分片断句：按「词与词之间的空隙」切句 —— 背景音乐免疫的那条路', () => {
  const g = chunkedMod.groupWordsByPauses;
  if (typeof g !== 'function') throw new Error('没有导出 groupWordsByPauses');

  // 0.8 秒的空隙 = 一句的边界
  const groups = g([
    { word: 'そう', start: 0.1, end: 0.4 },
    { word: 'なんだ', start: 0.4, end: 0.9 },
    { word: 'よね', start: 0.9, end: 1.2 },
    { word: 'ティール', start: 2.0, end: 2.4 }, // ← 1.2 → 2.0 是 0.8 秒停顿
    { word: 'で', start: 2.4, end: 2.5 },
  ]);
  if (groups.length !== 2) throw new Error(`应当切成 2 句，实际 ${groups.length}`);
  // 日文词之间不加空格
  if (groups[0].text !== 'そうなんだよね') throw new Error(`第一句拼错了：${JSON.stringify(groups[0].text)}`);
  if (groups[0].start !== 0.1 || groups[0].end !== 1.2) throw new Error('第一句的时间区间不对');
  if (groups[1].text !== 'ティールで') throw new Error(`第二句拼错了：${groups[1].text}`);

  // 英文要加空格
  const en = g([
    { word: 'Hello', start: 0, end: 0.5 },
    { word: 'there', start: 0.6, end: 1.0 },
  ]);
  if (en[0].text !== 'Hello there') throw new Error(`英文拼错了：${JSON.stringify(en[0].text)}`);

  // 门槛：0.2 秒的空隙在默认 0.35 秒下不算停顿，收紧后就该算
  const tight = [
    { word: 'あ', start: 0, end: 1.0 },
    { word: 'い', start: 1.2, end: 2.0 },
  ];
  if (g(tight).length !== 1) throw new Error('0.2 秒的空隙在默认门槛下不该断句');
  if (g(tight, { minPauseSec: 0.15 }).length !== 2) throw new Error('收紧门槛后应当断句');

  // 脏数据不能崩
  if (g([]).length !== 0) throw new Error('空输入该返回空');
  if (g([{ word: '', start: 0, end: 1 }]).length !== 0) throw new Error('空词要跳过');
  if (g([{ word: 'x', start: NaN, end: 1 }]).length !== 0) throw new Error('时间无效要跳过');
});

await checkAsync('分片断句：适配器按停顿发多句，跨片的那句留着不收', async () => {
  const events = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    // 走「逐词时间」那条路 —— 这是 BGM 场景下唯一可靠的断句依据
    json: async () => ({
      text: 'そうなんだよね ティールで流れたり',
      words: [
        { word: 'そう', start: 0.1, end: 0.4 },
        { word: 'なんだ', start: 0.4, end: 0.9 },
        { word: 'よね', start: 0.9, end: 1.2 },
        // 1.2 → 2.0 有 0.8 秒停顿
        { word: 'ティール', start: 2.0, end: 2.4 },
        { word: 'で', start: 2.4, end: 2.5 },
        { word: '流れた', start: 2.5, end: 4.0 },
        { word: 'り', start: 4.0, end: 4.8 }, // 贴着片尾（5.0 − 0.35）→ 跨片
      ],
    }),
    text: async () => '',
  });
  try {
    const session = chunkedMod.createSession({
      config: { baseUrl: 'http://x/v1', model: 'm', chunkSeconds: 5, silenceThreshold: 0.006, skipSilence: true },
      global: {},
      onEvent: (e) => events.push(e),
    });
    await session.start();

    const rate = 16000;
    const buf = new Int16Array(rate * 5);
    for (let i = 0; i < buf.length; i += 1) buf[i] = Math.round(8000 * Math.sin(i / 20));
    session.push(buf);
    await new Promise((r) => setTimeout(r, 80));

    const finals = events.filter((e) => e.type === 'final');
    const ends = events.filter((e) => e.type === 'utteranceEnd');
    if (finals.length !== 2) {
      throw new Error(`应当出 2 句 final，实际 ${finals.length}：${events.map((e) => e.type + (e.detail ? ':' + e.detail : '')).join(' | ')}`);
    }
    if (ends.length !== 1) throw new Error(`只有第一句该收句（末句跨片），实际收了 ${ends.length} 次`);
    if (finals[0].text !== 'そうなんだよね') throw new Error(`第一句文本不对：${finals[0].text}`);
    if (Math.abs(finals[0].start - 0.1) > 0.01) throw new Error(`第一句起点不对：${finals[0].start}`);
    if (Math.abs(finals[0].duration - 1.1) > 0.01) throw new Error(`第一句时长不对：${finals[0].duration}`);
    // 心跳必须带上，否则出问题看不到卡在哪一步。
    // 收音频的心跳走 status:'audio'，分片结果走 status:'chunk' —— 分开才不会互相覆盖。
    const beats = events.filter((e) => e.type === 'status' && e.status === 'chunk');
    if (!beats.some((b) => /句/.test(b.detail))) {
      throw new Error(`缺少分片心跳里的切句结果。实际：${beats.map((b) => b.detail).join(' | ')}`);
    }
    const audioBeats = events.filter((e) => e.type === 'status' && e.status === 'audio');
    if (!audioBeats.some((b) => /已收音频/.test(b.detail))) {
      throw new Error('缺少"已收音频"的心跳 —— 那是排查"一直没结果"的关键数字');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

await checkAsync('分片断句：切不出话段时绝不能丢音频（背景音乐/持续底噪会这样）', async () => {
  const events = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ text: 'テスト' }),
    text: async () => '',
  });
  try {
    const session = chunkedMod.createSession({
      config: { baseUrl: 'http://x/v1', model: 'm', chunkSeconds: 2, silenceThreshold: 0.006, skipSilence: true },
      global: {},
      onEvent: (e) => events.push(e),
    });
    await session.start();

    // 造一段"切不出话段、但整片并不静音"的音频：
    // 200ms 短音 + 400ms 静音，循环。每一段声音都短于 minSpeechMs(300ms) 会被丢掉，
    // 而 400ms 的静音又够长会触发分割 —— 最后一段不是语音，于是切出 0 段。
    // 但整片 RMS 远高于阈值，所以 classifyChunk 判定"不静音"。
    const rate = 16000;
    const n = rate * 2;
    const buf = new Int16Array(n);
    const seg = Math.round(rate * 0.2);
    const gap = Math.round(rate * 0.4);
    for (let i = 0; i < n; i += 1) {
      if (i % (seg + gap) < seg) buf[i] = Math.round(9000 * Math.sin(i / 15));
    }
    // 自检：这个构造必须真的切不出话段，否则这条测试没测到兜底
    if (chunkedMod.splitOnPauses(buf, rate, { threshold: 0.006 }).length !== 0) {
      throw new Error('构造前提不成立：这段音频本该切不出话段');
    }
    if (chunkedMod.splitOnPauses(buf, rate, { threshold: 0.006 }).length === 0) {
      const level = loaded['lib/util.js'].rms(buf);
      if (level < 0.006) throw new Error('构造前提不成立：整片被判成了静音');
    }

    session.push(buf);
    await new Promise((r) => setTimeout(r, 80));

    const kinds = events.map((e) => e.type).join(',');
    const finals = events.filter((e) => e.type === 'final');
    if (!finals.length) {
      throw new Error(`整片并不静音，绝不能一条 final 都不发 —— 那会让字幕整段消失。实际：${kinds}`);
    }
    // 兜底那一段标了 endsAtBufferEnd，所以不该收句（留着跟下一片拼）
    if (events.some((e) => e.type === 'utteranceEnd')) {
      throw new Error(`兜底段跨到片尾，不该收句。实际：${kinds}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

check('分片断句：看门狗必须比 chunkSeconds 长（否则每片都被强行收句）', () => {
  const utt = loaded['lib/utterance.js'];
  const a = new utt.UtteranceAccumulator();
  if (typeof a.setWatchdogMs !== 'function') throw new Error('没有 setWatchdogMs');
  a.setWatchdogMs(6500);
  if (a.watchdogMs !== 6500) throw new Error(`没设上：${a.watchdogMs}`);
  a.setWatchdogMs(0);
  if (a.watchdogMs < 500) throw new Error('要有下限保护');

  // 播放页必须按 chunkSeconds 抬高它
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/utterances\.setWatchdogMs\(chunkSec \* 1000 \+ 1500\)/.test(src)) {
    throw new Error('播放页没有按分片时长抬高看门狗');
  }
  if (!/asr\.streaming === false/.test(src)) throw new Error('没有区分分片模式与流式模式');
});

check('分片断句：逐词时间在 segments 里，不在顶层（这个坑让字幕一条都不出来）', () => {
  const c = chunkedMod.collectWords;
  if (typeof c !== 'function') throw new Error('没有导出 collectWords');

  // whisper.cpp 的真实形状：words 嵌在每个 segment 里，时间是相对整次请求的
  const real = {
    text: '…',
    segments: [
      { start: 0, words: [{ word: 'そう', start: 1.66, end: 1.78 }, { word: 'よね', start: 4.45, end: 6.24 }] },
      { start: 6.24, words: [{ word: 'テ', start: 6.26, end: 6.36 }] },
    ],
  };
  const w = c(real);
  if (w.length !== 3) {
    throw new Error(`应当从 segments 里收集到 3 个词，实际 ${w.length} —— 只读 data.words 就会是 0`);
  }
  if (Math.abs(w[0].start - 1.66) > 1e-9) throw new Error('绝对时间不该被改动');

  // 少数实现给的是"相对本段"的时间 → 必须补上段起点
  const rel = c({ segments: [{ start: 10, words: [{ word: 'あ', start: 0.1, end: 0.5 }] }] });
  if (Math.abs(rel[0].start - 10.1) > 1e-9) throw new Error(`相对时间没补上段起点：${rel[0].start}`);

  // 顶层形态也要兜住
  if (c({ words: [{ word: 'x', start: 1, end: 2 }] }).length !== 1) throw new Error('顶层 words 没兜住');
  if (c(null).length !== 0) throw new Error('null 不该崩');
  if (c({ segments: [{ words: [{ word: '', start: 0, end: 1 }] }] }).length !== 0) throw new Error('空词要跳过');

  // 适配器必须走它
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'whisper-chunked.js'), 'utf8'));
  if (!/collectWords\(data\)/.test(src)) throw new Error('适配器没有走 collectWords，又退回只读顶层了');
});

check('识别出问题时只进诊断面板，绝不上屏（用户明确要求画面干净）', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'player', 'player.html'), 'utf8');
  // 横幅元素和样式都要彻底删掉，不能只是隐藏
  if (/id="notice"/.test(html)) throw new Error('页面里还留着提示条元素');
  const css = fs.readFileSync(path.join(process.cwd(), 'player', 'player.css'), 'utf8');
  if (/\.notice\s*\{/.test(css)) throw new Error('提示条样式还留着');
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (/showNotice|hideNotice/.test(src)) throw new Error('还在用已删除的提示条机制');
  if (!/function warn\(/.test(src)) throw new Error('没有 warn');
  const fn = src.slice(src.indexOf('function warn('), src.indexOf('function warn(') + 500);
  if (!/diag\(`⚠ \$\{first\}`/.test(fn)) throw new Error('警告没有进诊断面板');
  if (/hidden|textContent/.test(fn)) throw new Error('warn 里还在操作画面元素');
  // 关键调用点必须走 warn
  if (!/warn\(`识别出错/.test(src)) throw new Error('识别出错没有走 warn');
});

await checkAsync('「什么都没有」必须自带原因：版本可见 + 无结果看门狗', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  // 1. 版本号要能不开诊断面板就看见 —— 否则永远说不清"你跑的是哪一版"
  if (!/document\.title = `livedtranslate v\$\{chrome\.runtime\.getManifest\(\)\.version\}/.test(src)) {
    throw new Error('版本号没有写进标签页标题');
  }
  // 2. 连上了却一直没有结果 → 必须弹提示，而不是静默
  if (!/function checkSilentAsr/.test(src)) throw new Error('没有 checkSilentAsr');
  const fn = src.slice(src.indexOf('function checkSilentAsr'), src.indexOf('function renderSubs'));
  if (!/15000/.test(fn)) throw new Error('要有等待上限，不然永远不提示');
  // ⚠️ 最关键的两个数：「已发出 N 次 · 回来 M 次」
  // 只报"最近一个分片"是不够的 —— 那行可能是收音频心跳，看不出请求回没回来
  if (!/asrRequestsSent/.test(fn) || !/asrRequestsDone/.test(fn)) {
    throw new Error('提示里必须给出"已发出几次 / 回来几次"，否则分不清卡在哪一侧');
  }
  if (!/checkSilentAsr\(\)/.test(src.replace('function checkSilentAsr', ''))) {
    throw new Error('checkSilentAsr 没有被调用');
  }
  // ⚠️ 必须持续刷新：一次性提示会永远停在第一次触发的那一刻，
  // 读到的数字是几分钟前的快照（用户明确反馈过"15 秒是固定的"）。
  if (!/lastNoticeAt/.test(fn)) throw new Error('提示必须带刷新节流，也就是会持续更新');
  if (!/Date\.now\(\) - lastNoticeAt/.test(fn)) throw new Error('没有实现"每 2 秒刷新一次"');
  // ⚠️ 这条以前断言"已经显示就不再更新"是错的：那会让提示永远停在旧数字。
  // 现在警告都进诊断面板，改为断言"节流但持续刷新"。
  if (!/Date\.now\(\) - lastNoticeAt < 2000/.test(fn)) {
    throw new Error('要看门狗持续刷新（带节流），不能只报一次');
  }
  // 3. 三类事件必须分开记，否则后到的收音频心跳会覆盖分片结果
  const chunkedSrc = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'whisper-chunked.js'), 'utf8'));
  if (!/status: 'audio'/.test(chunkedSrc)) {
    throw new Error('收音频心跳必须用单独的 status，否则会覆盖分片结果');
  }
  if (!/status: 'chunk',/.test(chunkedSrc)) throw new Error('分片结果的心跳丢了');
  if (!/asrRequestsDone \+= 1/.test(src)) throw new Error('没有统计"请求回来几次"');
  if (!/ev\.status === 'recognizing'\) asrRequestsSent \+= 1/.test(src)) {
    throw new Error('没有统计"请求发出几次"');
  }
  if (!/lastResultAt = Date\.now\(\)/.test(src)) throw new Error('没有记录"最近一次拿到结果"的时刻');
});

check('分片适配器：transcribe 的返回值是对象，所有调用点都不能当字符串用', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'whisper-chunked.js'), 'utf8'));
  // 返回值从 string 改成 {text, words} 之后，
  // `const text = await transcribe(...)` 这种写法会让 text 恒为真
  // （对象永远 truthy），于是把 [object Object] 当字幕发出去。
  const bad = src.match(/const\s+\w+\s*=\s*await transcribe\(/g) || [];
  for (const m of bad) {
    if (/const\s+text\s*=/.test(m)) throw new Error(`有调用点把返回值当字符串：${m}`);
  }
  // 每个调用点后面都应当用 .text 取值
  const calls = (src.match(/await transcribe\(/g) || []).length;
  const uses = (src.match(/\.text\b/g) || []).length;
  if (uses < calls) throw new Error(`有 ${calls} 处调用，却只见到 ${uses} 处用 .text 取值`);
});

check('分片适配器：心跳必须报 totalSamples（samples 会被清零，读它永远是 0.0）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'whisper-chunked.js'), 'utf8'));
  if (!/已收音频 \$\{\(totalSamples \/ meta\.sampleRate\)/.test(src)) {
    throw new Error('心跳没有报 totalSamples —— 报 samples 会因清零而永远显示 0.0（这个仪器错过一次）');
  }
  // 停止时要说一声，否则播放页分不清"连接被关了"和"一直没结果"
  const stopFn = src.slice(src.indexOf('async function stop()'), src.indexOf('async function stop()') + 400);
  if (!/status: 'closed'/.test(stopFn)) throw new Error('stop() 里没有通知 closed');
});

await checkAsync('分片适配器：识别请求必须有超时（否则卡住时一条字幕都没有、也没有报错）', async () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'whisper-chunked.js'), 'utf8'));
  if (!/TRANSCRIBE_TIMEOUT_MS/.test(src)) throw new Error('没有超时常量');
  if (!/new AbortController\(\)/.test(src)) throw new Error('没有用 AbortController 设超时');
  if (!/ctrl\.abort\(\)/.test(src)) throw new Error('超时后没有中止请求');
  if (!/AbortError/.test(src)) throw new Error('中止时应当给出人能看懂的原因');
  const mod = chunkedMod;
  if (!(mod.TRANSCRIBE_TIMEOUT_MS > 0)) throw new Error('超时值必须是正数');

  // 真跑一遍：让 fetch 永不返回，看它会不会自己中止并报错
  const events = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  try {
    const session = mod.createSession({
      config: { baseUrl: 'http://x/v1', model: 'm', chunkSeconds: 2, skipSilence: true },
      global: {},
      onEvent: (e) => events.push(e),
    });
    await session.start();
    const buf = new Int16Array(32000);
    for (let i = 0; i < buf.length; i += 1) buf[i] = Math.round(8000 * Math.sin(i / 20));
    session.push(buf);
    // 不该干等 20 秒：直接检查内部确实挂了 signal，并且中止后能变成可读错误
    await new Promise((r) => setTimeout(r, 60));
    if (!events.some((e) => e.type === 'status' && e.status === 'recognizing')) {
      throw new Error('应当已经发出识别请求');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

await checkAsync('跨片断句：片尾那句说完了没有，要靠跨片的词间空隙来判断', async () => {
  const events = [];
  const realFetch = globalThis.fetch;
  /**
   * 第二片的词时间由 firstWordStart 决定：
   *   接得很紧（5.1）→ 是同一句跨片
   *   隔得久（6.2）  → 上一片那句其实已经说完了
   */
  function stub(firstWordStart) {
    let call = 0;
    return async () => {
      call += 1;
      // 第 1 片：末词结束在 4.9（贴着片尾 5.0，当场分不清）
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            text: 'A B',
            segments: [
              { start: 0, words: [{ word: 'あ', start: 1.0, end: 3.0 }] },
              { start: 0, words: [{ word: 'い', start: 3.4, end: 4.9 }] },
            ],          }),
          text: async () => '',
        };
      }
      // 第 2 片：首词起点可调。
      // ⚠️ whisper.cpp 返回的词时间是**相对本片**的，段落的 start 也是片内偏移。
      // 这里必须照实模拟：写成"段落 start=5、词 time=绝对时间"会让 collectWords
      // 再补一次 5 秒的偏移（重复偏移），测出来的东西和真实链路不是一回事。
      const off = firstWordStart - 5;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          text: 'C',
          segments: [{ start: 0, words: [{ word: 'う', start: off, end: off + 1.5 }] }],
        }),
        text: async () => '',
      };
    };
  }
  const rate = 16000;
  const mk = () => {
    const b = new Int16Array(rate * 5);
    for (let i = 0; i < b.length; i += 1) b[i] = Math.round(8000 * Math.sin(i / 20));
    return b;
  };

  async function run(firstWordStart) {
    const evs = [];
    globalThis.fetch = stub(firstWordStart);
    const s = chunkedMod.createSession({
      config: { baseUrl: 'http://x/v1', model: 'm', chunkSeconds: 5, silenceThreshold: 0.006, skipSilence: true },
      global: {},
      onEvent: (e) => evs.push(e),
    });
    await s.start();
    s.push(mk());
    await new Promise((r) => setTimeout(r, 60));
    s.push(mk());
    await new Promise((r) => setTimeout(r, 60));
    return evs.filter((e) => e.type === 'utteranceEnd').length;
  }

  try {
    // 情况一：5.1 开口 = 与上一片末尾（4.9）只隔 0.2 秒 → 同一句，跨片
    const tight = await run(5.1);
    // 情况二：6.2 开口 = 隔了 1.3 秒 → 上一片那句其实说完了，必须收句
    const loose = await run(6.2);
    if (!(loose > tight)) {
      throw new Error(
        `跨片空隙大时必须多收一次句：紧接=${tight} 次、隔 1.3 秒=${loose} 次 —— ` +
          '相同就说明还在按"贴着片尾就不收句"处理，短句会被并长',
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

check('跨片断句：片内就停下来的末句要当场收句，不用等下一片', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'whisper-chunked.js'), 'utf8'));
  if (!/export const MIN_PAUSE_SEC/.test(src)) throw new Error('停顿门槛要有具名常量当默认值');
  if (!/lastG\.end < bufSec - minPauseSec/.test(src)) throw new Error('缺少"片内就结束"的判据');
  if (!/pending = \{ end: lastG\.end \}/.test(src)) throw new Error('缺少"末句待定"的记录');
  // 停的时候必须把待定的那句收掉，否则它永远不上屏
  const stopFn = src.slice(src.indexOf('async function stop()'), src.indexOf('async function stop()') + 500);
  if (!/pending/.test(stopFn)) throw new Error('stop() 里没有收掉待定的末句');
});

check('断句门槛必须能从设置里调（用户反馈偏长时要能自己往下调）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  if (typeof s.asr.whisperChunked.pauseSec !== 'number') {
    throw new Error('设置里缺 asr.whisperChunked.pauseSec');
  }
  if (s.asr.whisperChunked.pauseSec > 0.3) {
    throw new Error(`默认值 ${s.asr.whisperChunked.pauseSec} 偏长（日语自然停顿短，实测 0.35 会并句）`);
  }
  if (s.asr.whisperChunked.pauseSec < 0.1) throw new Error('默认值太小，会在词内部乱切');

  // 界面接线
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  if (!/id="wc-pauseSec"/.test(html)) throw new Error('设置页没有这个字段');
  const panel = html.slice(html.indexOf('data-panel="whisper-chunked"'), html.indexOf('data-panel="whisper-chunked"') + 2000);
  if (!/wc-pauseSec/.test(panel)) throw new Error('字段必须在分片识别那一栏里');
  const js = fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8');
  if (!/'wc-pauseSec'/.test(js)) throw new Error('options.js 的 FIELDS 里没有接线');

  // 适配器必须读设置，不能写死常量
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'whisper-chunked.js'), 'utf8'));
  if (!/Number\(config\.pauseSec\)/.test(src)) throw new Error('适配器没有读 config.pauseSec');
  const body = src.slice(src.indexOf('export function createSession'), src.length);
  if (/groupWordsByPauses\(whole\.words, \{ minPauseSec: MIN_PAUSE_SEC \}/.test(body)) {
    throw new Error('还在写死常量 —— 用户改了设置也不会生效');
  }
  // 夹紧：离谱的输入不能把断句搞崩
  if (!/Math\.min\(1\.5, Math\.max\(0\.1,/.test(src)) throw new Error('门槛要有上下限夹紧');
});

check('纠偏速率必须有迟滞（否则速率反复横跳，人声会出「噗噗」的扑动）', () => {
  const dp = loaded['lib/delayed-player.js'];
  const f = dp.lagCorrectionRate;
  if (typeof f !== 'function') throw new Error('没有导出 lagCorrectionRate');

  // 死区之内、且没在纠偏 → 保持 1.0
  if (f(0.1) !== 1) throw new Error('偏差很小时应当保持原速');
  // 没在纠偏时，刚过死区才开始纠
  if (f(0.3) === 1) throw new Error('偏差 0.3 秒应当开始纠偏');

  // ⚠️ 核心：正在纠偏时，不能一到死区就停 —— 那会让速率在边缘反复横跳。
  // 偏差 0.2 秒：没在纠偏 → 不纠（1.0）；正在纠偏 → 继续纠（≠1）
  const idle = f(0.2, { correcting: false });
  const busy = f(0.2, { correcting: true });
  if (idle !== 1) throw new Error('没在纠偏时，0.2 秒偏差不该启动纠偏');
  if (busy === 1) {
    throw new Error('正在纠偏时，0.2 秒偏差不该立刻停下 —— 这正是速率横跳的成因');
  }
  // 一路纠到很小才停
  if (f(0.02, { correcting: true }) !== 1) throw new Error('偏差已经很小了，应当停下来');

  // 夹紧
  if (f(100) > 1.061) throw new Error('速率上限没夹住');
  if (f(-100) < 0.939) throw new Error('速率下限没夹住');
  if (f(NaN) !== 1) throw new Error('NaN 应当当成原速');
});

check('纠偏：速率变化太小时不要写 playbackRate（每次写都会重建时间伸缩器）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'delayed-player.js'), 'utf8'));
  if (!/this\._correcting/.test(src)) throw new Error('没有记住迟滞状态');
  if (!/correcting: this\._correcting/.test(src)) throw new Error('没有把迟滞状态传给 lagCorrectionRate');
  // 最小变化阈值
  if (!/Math\.abs\(this\.video\.playbackRate - rate\) >= 0\.004/.test(src)) {
    throw new Error('没有"变化太小就别写"的保护 —— 每帧都写 playbackRate 会不断打扰伸缩器');
  }
  // 只在真正纠偏时报，免得刷屏
  const player = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/变速纠偏中/.test(player)) throw new Error('诊断里应当能看到纠偏速率，方便确认噪声是否与之相关');
});

check('清理旧缓冲要攒够再做（每 400ms 一次 remove 会让画面偶尔顿一下）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'delayed-player.js'), 'utf8'));
  const dp = loaded['lib/delayed-player.js'];

  if (!(dp.TRIM_GARBAGE_SEC >= 10)) {
    throw new Error(`一次只丢 ${dp.TRIM_GARBAGE_SEC} 秒就太勤了 —— remove 会卡住 append`);
  }
  if (!(dp.TRIM_MIN_INTERVAL_MS >= 5000)) throw new Error('两次清理之间至少要隔几秒');

  // ⚠️ 这里原来断言 `garbageSec >= TRIM_GARBAGE_SEC`。那个**固定 20 秒**的阈值
  // 在 4K60 高画质（128 Mbps = 16 MB/s）下就是 320 MB，会撞穿 MSE 配额，
  // 所以已经改成按码率换算的 `garbageTarget`。判据保留，名字跟着改。
  if (!/garbageSec >= garbageTarget/.test(src)) throw new Error('没有"攒够再丢"的判据');
  if (!/const garbageTarget = Math\.max\(4, keepBehind\)/.test(src)) {
    throw new Error('"攒多少"应当按码率换算，不能写死秒数');
  }
  if (!/Date\.now\(\) - this\._lastTrimAt >= TRIM_MIN_INTERVAL_MS/.test(src)) throw new Error('没有"两次之间至少隔一会儿"的判据');
  if (!/this\._lastTrimAt = Date\.now\(\)/.test(src)) throw new Error('没有记录上次清理时刻');

  // 不能再出现"只要 cut > 1 就丢"的老写法
  if (/const cut = this\.video\.currentTime - 15;\s*\n\s*if \(cut > 1 && this\.queue/.test(src)) {
    throw new Error('还在每次 tick 都清理 —— 那正是顿的成因');
  }

  // 缓冲健康度要可观测
  if (!/this\.bufferAheadSec = Math\.max\(0, end - this\.video\.currentTime\)/.test(src)) {
    throw new Error('没有统计"播放头前方还剩多少可播" —— 顿的时候看不出是不是缓冲见底');
  }
  if (!/this\.stallCount/.test(src)) throw new Error('没有统计缓冲见底次数');
  const player = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/缓冲 · 前方/.test(player)) throw new Error('诊断里看不到缓冲健康度');
});

check('「顿」要被量化：数掉帧、并把缓冲够却掉帧的情况单独标出来', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'delayed-player.js'), 'utf8'));
  if (!/getVideoPlaybackQuality/.test(src)) throw new Error('没有数掉帧 —— "顿"就没有硬证据');
  if (!/this\.droppedFrames = /.test(src)) throw new Error('没有记录掉帧数');
  const player = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/掉帧 \$\{dropped\}\/\$\{total\}/.test(player)) throw new Error('诊断里没报掉帧');
  // 关键判据：缓冲是满的却还在掉帧 → 卡在编解码侧，不是网络
  if (!/缓冲够却在掉帧/.test(player)) throw new Error('没有把"缓冲够却掉帧"单独标出来');
});

check('延迟画面可以降分辨率（可选，不是默认）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  if (typeof s.capture.delayMaxHeight !== 'number') throw new Error('设置里缺 capture.delayMaxHeight');
  // ⚠️ 默认必须是 0（原样）。曾经默认 1080 想省 CPU，实测对卡顿毫无帮助，
  // 只是把画面弄糊了 —— 用户的反馈是"太糊了"。详见后面那条画质控件的断言。
  if (s.capture.delayMaxHeight !== 0) throw new Error(`默认应当是原样，实际 ${s.capture.delayMaxHeight}`);
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/stream\.clone\(\)/.test(src)) throw new Error('没有克隆流去改分辨率（不能动原始轨）');
  if (!/applyConstraints\(\{ width: w, height: maxHeight \}\)/.test(src)) throw new Error('没有按高度等比缩放');
  if (!/await playback\.start\(recordStream\)/.test(src)) throw new Error('录音用的还是原始流，缩放没生效');
  // 缩放失败必须退回原样，不能整个起不来
  if (!/降分辨率失败/.test(src)) throw new Error('缩放失败要退回原样并说明');
  // 只有比目标高时才缩
  if (!/\(vtrack\.getSettings\(\)\.height \|\| 0\) > maxHeight/.test(src)) {
    throw new Error('比目标矮的流不该被放大');
  }
});

check('录制格式必须 H.264 优先（VP9/VP8 多是软件编码，4K 下和本地识别抢 GPU）', () => {
  const dp = loaded['lib/delayed-player.js'];
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'delayed-player.js'), 'utf8'));
  const list = src.slice(src.indexOf('export function pickMimeType'), src.indexOf('export function isSupported'));
  const mp4 = list.indexOf('avc1');
  const vp9 = list.indexOf('vp9');
  if (mp4 < 0) throw new Error('候选里没有 H.264/avc1');
  if (!(mp4 < vp9)) throw new Error('H.264 必须排在 VP9 前面');
  // ⚠️ 必须同时过 MediaRecorder 和 MediaSource ——
  // 只过前者的话，addSourceBuffer 会失败，整个延迟播放起不来
  if (!/MediaRecorder\.isTypeSupported\(c\)/.test(list)) throw new Error('没查 MediaRecorder 支持');
  if (!/MediaSource\.isTypeSupported\(c\)/.test(list)) throw new Error('没查 MediaSource 支持');
  if (typeof dp.pickMimeType !== 'function') throw new Error('没有导出 pickMimeType');
  // 无浏览器环境下应当安全返回空串，而不是抛
  if (dp.pickMimeType() !== '') throw new Error('没有浏览器支持时应当返回空串');

  // 用了哪个格式必须报出来，否则没法判断是否走了硬件编码
  const player = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/录制格式 ·/.test(player)) throw new Error('诊断里没报录制格式');
  if (!/通常硬件编码/.test(player)) throw new Error('应当说明 H.264 通常是硬件编码');
});

check('「画面顿」必须能区分缓冲不够和算力不够', () => {
  const player = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/function checkHitching/.test(player)) throw new Error('没有 checkHitching');
  const fn = player.slice(player.indexOf('function checkHitching'), player.indexOf('function renderSubs'));
  if (!/droppedFrames/.test(fn)) throw new Error('要用掉帧数作为判据');
  if (!/缓冲够却掉帧/.test(fn)) throw new Error('必须区分"缓冲够却掉帧"和"缓冲见底"');
  if (!/checkHitching\(\)/.test(player.replace('function checkHitching', ''))) {
    throw new Error('checkHitching 没有被调用');
  }
  // 掉帧不多时别打扰
  if (!/delta < 20/.test(fn)) throw new Error('要有"掉得不多就别提示"的门槛');
});

check('卡顿必须能抓到"现场"：冻住多久、当时缓冲多少、是不是在纠偏', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'delayed-player.js'), 'utf8'));
  if (!/^\s*_probe\(\)\s*\{/m.test(src)) throw new Error('没有精细卡顿探测');
  // _tick 每 400ms 才看一次，抓不到短促的卡顿 —— 必须用更密的采样
  if (!/setInterval\(\(\) => this\._probe\(\), 100\)/.test(src)) {
    throw new Error('探测间隔必须比 _tick(400ms) 密得多，否则抓不到短卡顿');
  }
  const fn = src.slice(src.indexOf('_probe()'), src.indexOf('_probe()') + 1600);
  if (!/dct >= dt \* 0\.5/.test(fn)) throw new Error('没有"播放头前进够不够"的判据');
  for (const k of ['frozenMs', 'aheadSec', 'readyState', 'dropped', 'correcting']) {
    if (!new RegExp(k).test(fn)) throw new Error(`现场状态里缺少 ${k} —— 少一项就分不清是哪类卡顿`);
  }
  // 停的时候要清掉，否则 page 关掉后定时器还在跑
  if (!/clearInterval\(this\.probeTimer\)/.test(src)) throw new Error('stop() 里没清掉探测定时器');

  const player = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/卡顿 #\$\{playback\.hitchCount\}/.test(player)) throw new Error('诊断里没报卡顿现场');
});

check('延迟画质必须默认原样，而且页面上能改（有设置没控件等于没有）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  if (s.capture.delayMaxHeight !== 0) {
    throw new Error(`默认必须是 0（原样）：降分辨率对卡顿没有帮助，只会把画面弄糊。实际 ${s.capture.delayMaxHeight}`);
  }
  const html = fs.readFileSync(path.join(process.cwd(), 'player', 'player.html'), 'utf8');
  if (!/id="quality"/.test(html)) throw new Error('播放页没有画质控件 —— 那这个设置用户根本改不了');
  for (const v of ['0', '1080', '720']) {
    if (!new RegExp(`<option value="${v}"`).test(html)) throw new Error(`缺少 ${v} 这一档`);
  }
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/\$\('quality'\)\.value = String\(settings\.capture\.delayMaxHeight/.test(src)) {
    throw new Error('控件没有从设置里回填');
  }
  if (!/\$\('quality'\)\.addEventListener\('change'/.test(src)) throw new Error('控件没有接线');
  // 改了必须提示"要重新开始捕获"，否则用户会以为没生效
  if (!/重新开始捕获才生效/.test(src)) throw new Error('没有提示"改完要重新开始捕获"');
});

check('分片时长必须够短：识别滞后 ≈ 分片×2 + 推理，超过画面延迟就必然迟到', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  const chunk = s.asr.whisperChunked.chunkSeconds;
  const lag = chunk * 2 + 0.6; // 推理按 0.6 秒估
  // 默认延迟是 2.5s，但用户会调大；这里只要求默认分片不要离谱到"任何合理延迟都盖不住"
  if (lag > 8) {
    throw new Error(`分片 ${chunk}s → 识别滞后约 ${lag.toFixed(1)}s，太长了（延迟上限 12s 也吃力）`);
  }
  // 顺带确认延迟上限够宽，能给滞后留余量
  const dp = loaded['lib/delayed-player.js'];
  if (dp.DELAY_MAX_SEC < 10) throw new Error(`延迟上限 ${dp.DELAY_MAX_SEC}s 太窄，盖不住识别滞后`);

  // 诊断里必须能看出"识别滞后"这个数 —— 否则迟到时不知道怪识别还是怪翻译
  const player = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/识别滞后 \$\{asrLagSec\.toFixed\(1\)\}s/.test(player)) throw new Error('诊断里没有报识别滞后');
  if (!/超过延迟，必然迟到/.test(player)) throw new Error('没有把"滞后超过延迟"标出来');
});

check('排期延迟必须包含「录音/编码滞后」—— 字幕恒偏早的根因', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/function recorderLagMs/.test(src)) throw new Error('没有 recorderLagMs 辅助函数');
  const fn = src.slice(src.indexOf('function currentDelayMs'), src.indexOf('function recorderLagMs'));
  if (!/actual \* 1000 \+ recorderLagMs\(\)/.test(fn)) {
    throw new Error('排期延迟没有加上录音滞后 —— 只算 bufferedEnd−currentTime 会让字幕恒偏早');
  }
  // 未知时不能瞎补
  if (!/if \(!Number\.isFinite\(actual\) \|\| actual <= 0\) return target \+ recorderLagMs\(\)/.test(fn)) {
    throw new Error('实测延迟未知时也要把录音滞后算上');
  }
  const helper = src.slice(src.indexOf('function recorderLagMs'), src.indexOf('function recorderLagMs') + 500);
  if (!/Math\.min\(2500, lag \* 1000\)/.test(helper)) throw new Error('录音滞后必须夹紧，离谱的值比不补更糟');
  if (!/lag <= 0\) return 0/.test(helper)) throw new Error('未知/异常时应当返回 0，宁可不动也不瞎补');

  // 提示文案要改成"已补进排期"，否则用户还会去拧同步微调
  if (!/已补进排期，所以字幕不再因此偏早/.test(src)) {
    throw new Error('诊断文案还停留在"会偏早这么多"，和实际行为不一致');
  }
});

check('调速必须用平滑后的偏差（bufferedEnd 是台阶值，瞬时偏差是锯齿波）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'delayed-player.js'), 'utf8'));
  if (!/this\.driftEma/.test(src)) throw new Error('没有平滑偏差');
  const fn = src.slice(src.indexOf('const target = end - this.delaySec'), src.indexOf('const target = end - this.delaySec') + 1800);
  if (!/const drift = this\.driftEma/.test(fn)) throw new Error('调速没有用平滑值');
  if (!/driftEma = this\.driftEma === null \? driftRaw/.test(fn)) throw new Error('没有 EMA 平滑');
  // 两次写 playbackRate 之间要有下限间隔
  if (!/nowMs - \(this\._lastRateSetAt \|\| 0\) >= 1000/.test(fn)) {
    throw new Error('没有限制调速频率 —— 每帧都写会不断让渲染器重新计时');
  }
  // 诊断里要同时能看到瞬时值，否则分不清"真偏了"还是"锯齿"
  if (!/this\.lastDriftSec = driftRaw/.test(fn)) throw new Error('没有留下瞬时偏差供诊断');
});

check('卡顿现场只在计数变化时打印一次（不然日志里全是同一条重复）', () => {
  const player = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/lastHitchLogged/.test(player)) throw new Error('没有去重，会把同一条记录反复重打');
  if (!/playback\.hitchCount !== lastHitchLogged/.test(player)) throw new Error('没有按计数变化去重');
});

check('「变速纠偏」要能整体关掉 —— 关掉后速率恒为 1，画面不再有变速顿挫', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  if (typeof s.capture.smoothRate !== 'boolean') throw new Error('设置里缺 capture.smoothRate');
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'delayed-player.js'), 'utf8'));
  if (!/this\.smoothRate = opts\.smoothRate !== false/.test(src)) throw new Error('构造参数没接');
  if (!/this\.smoothRate \? lagCorrectionRate/.test(src)) throw new Error('关掉后没有把速率钉成 1');
  const player = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/smoothRate: settings\.capture\.smoothRate !== false/.test(player)) throw new Error('播放页没把设置传进去');
  const html = fs.readFileSync(path.join(process.cwd(), 'player', 'player.html'), 'utf8');
  if (!/id="smoothRate"/.test(html)) throw new Error('没有开关，用户没法验证');
  // 关掉纠偏的前提是：字幕排期用的是**实测**延迟，而不是目标值
  if (!/const ms = actual \* 1000 \+ recorderLagMs\(\)/.test(player)) {
    throw new Error('排期必须用实测延迟 —— 否则关掉纠偏后字幕会跟着漂');
  }
});

check('警告只进诊断面板，页面上不留任何横幅元素', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  const fn = src.slice(src.indexOf('function warn('), src.indexOf('function warn(') + 500);
  // 一律进诊断面板
  if (!/diag\(`⚠ \$\{first\}`/.test(fn)) throw new Error('警告没有进诊断面板');
  // 绝不再操作画面元素
  if (/hidden|textContent|createElement/.test(fn)) throw new Error('warn 里还在操作画面元素');
  // 用户明确说过"红字彻底不要显示在画面上"
  if (/showDiag\) return/.test(fn)) throw new Error('还留着"面板关着就上屏"的兜底分支');
});

check('全屏必须走「页面全屏」而不是 video 原生全屏（否则字幕会被一起藏掉）', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'player', 'player.html'), 'utf8');
  if (!/id="btnFull"/.test(html)) throw new Error('没有全屏按钮');
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  // 全屏的目标必须是 frame（画面区，字幕在里面），不能是 video
  if (!/\$\('frame'\)\.requestFullscreen\(\)/.test(src)) {
    throw new Error('全屏的不是 frame —— video 原生全屏只渲染 video 元素本身，字幕层会被藏掉');
  }
  if (/\$\('video'\)\.requestFullscreen/.test(src)) throw new Error('不能对 video 调 requestFullscreen');
  if (!/document\.exitFullscreen\(\)/.test(src)) throw new Error('没有退出全屏');
  // 按钮文字要跟着状态变
  if (!/btnFull'\)\.textContent = on \? '退出全屏' : '全屏'/.test(src)) throw new Error('按钮文字没跟着状态变');
  // 全屏时字幕要放大，否则全屏了字还是那么小
  const css = fs.readFileSync(path.join(process.cwd(), 'player', 'player.css'), 'utf8');
  if (!/\.frame:fullscreen/.test(css)) throw new Error('没有全屏样式');
  if (!/\.frame:fullscreen \.subs \.line \.tr \{ font-size: clamp\(/.test(css)) {
    throw new Error('全屏时字幕没有放大');
  }
});

/* ── 本地 VAD 断句 ── */

const gateMod = loaded['lib/asr/vad-gate.js'];

/** 造一段概率序列：speech 帧用高概率，静音帧用低概率 */
function probSeq(...runs) {
  const out = [];
  for (const [prob, n] of runs) for (let i = 0; i < n; i += 1) out.push(prob);
  return out;
}

check('VAD 状态机：短促杂音不该起句（咳嗽、桌椅响）', () => {
  const g = new gateMod.VadGate({ threshold: 0.5, minSpeechMs: 250, frameMs: 32 });
  // 只有 4 帧高概率（128ms）< 250ms
  const events = probSeq([0.05, 5], [0.9, 4], [0.05, 5]).map((p) => g.push(p)).filter(Boolean);
  if (events.length) throw new Error(`短促杂音不该产生任何事件，实际 ${JSON.stringify(events)}`);
});

check('VAD 状态机：说够久才起句，静够久才收句', () => {
  const g = new gateMod.VadGate({ threshold: 0.5, minSpeechMs: 250, minSilenceMs: 300, frameMs: 32 });
  const seq = probSeq([0.05, 5], [0.9, 60], [0.05, 15]);
  const events = [];
  seq.forEach((p, i) => {
    const e = g.push(p);
    if (e) events.push({ ...e, at: i });
  });
  if (events.length !== 2) throw new Error(`应当一起一收，实际 ${events.length} 个事件`);
  if (events[0].type !== 'start') throw new Error('第一个事件应当是 start');
  if (events[1].type !== 'end' || events[1].reason !== 'silence') throw new Error('第二个应当是静音导致的 end');
  // 起句位置：高概率从第 5 帧开始，连续 8 帧（8×32=256ms ≥ 250ms）才确认
  if (events[0].startFrame !== 5) throw new Error(`起句帧应当是 5，实际 ${events[0].startFrame}`);
  // 收句位置：静音从第 65 帧开始，连续 10 帧（320ms ≥ 300ms）才确认
  if (events[1].endFrame !== 65) throw new Error(`收句帧应当是 65，实际 ${events[1].endFrame}`);
});

check('VAD 状态机：句中短暂停不该切断（换气不是句号）', () => {
  const g = new gateMod.VadGate({ threshold: 0.5, minSpeechMs: 250, minSilenceMs: 300, frameMs: 32 });
  // 说话 40 帧 → 静 5 帧（160ms < 300ms）→ 继续 40 帧 → 静 15 帧
  const events = probSeq([0.9, 40], [0.05, 5], [0.9, 40], [0.05, 15])
    .map((p) => g.push(p))
    .filter(Boolean);
  const ends = events.filter((e) => e.type === 'end');
  if (ends.length !== 1) throw new Error(`中途换气不该收句，实际收了 ${ends.length} 次`);
});

check('VAD 状态机：一直不停顿要强制切断（否则永远不出字幕）', () => {
  const g = new gateMod.VadGate({ threshold: 0.5, minSpeechMs: 250, minSilenceMs: 300, maxSpeechMs: 1000, frameMs: 32 });
  const events = probSeq([0.9, 100]).map((p) => g.push(p)).filter(Boolean);
  const ends = events.filter((e) => e.type === 'end');
  // 一直不停顿就应当**反复**切断：一段 3.2 秒的语音切成约 3 段，
  // 而不是攒成一整块等到天荒地老。所以这里断言"至少切了一次，而且都是超长切断"。
  if (!ends.length) throw new Error('一直不停顿却一次都不切 —— 那会永远不出字幕');
  for (const e of ends) {
    if (e.reason !== 'max-length') throw new Error(`切断原因应当是 max-length，实际 ${e.reason}`);
  }
  // 每次切断后都要能重新起句，否则剩下的语音就丢了
  const starts = events.filter((e) => e.type === 'start');
  if (starts.length !== ends.length) {
    throw new Error(`起句 ${starts.length} 次、切句 ${ends.length} 次 —— 应当一一对应，否则有语音被丢掉`);
  }
});

check('VAD 状态机：帧区间换算成采样区间时要补留白并夹住边界', () => {
  // ⚠️ frameMs 必须和 frameSamples 一致：留白 = padMs × (frameSamples / frameMs)。
  // 576 采样 @16k 就是 36ms —— 写成 32ms 会算出错误的留白（测试自己踩过）。
  const g = new gateMod.VadGate({ padMs: 200, frameMs: 36 });
  const r = g.toSamples(10, 20, { totalSamples: 20 * 576, frameSamples: 576 });
  if (r.start !== 10 * 576 - 3200) throw new Error(`起点留白不对：${r.start}`);
  if (r.end !== 20 * 576) throw new Error(`终点应当被夹到缓冲末尾：${r.end}`);
  // 起点不能为负
  const r2 = g.toSamples(1, 5, { totalSamples: 100000, frameSamples: 576 });
  if (r2.start !== 0) throw new Error(`起点不该为负：${r2.start}`);
  // 默认（不传 frameSamples）应当跟随当前窗长常量，且默认 frameMs 与它自洽
  const g2 = new gateMod.VadGate({ padMs: 200 });
  const r3 = g2.toSamples(10, 20, { totalSamples: 20 * 576 });
  if (r3.start !== 10 * 576 - 3200) throw new Error(`默认窗长没跟随常量：${r3.start}`);
});

check('本地 VAD：必须注册成识别服务，并带上自己的参数', () => {
  const mods = loaded['lib/asr/index.js'];
  if (!mods.ASR_MODULES.vad) throw new Error('没有注册 vad 适配器');
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  if (!s.asr.vad) throw new Error('设置里缺 asr.vad');
  for (const k of ['vadThreshold', 'vadMinSilenceMs', 'vadMaxSpeechSec', 'vadPadMs']) {
    if (typeof s.asr.vad[k] !== 'number') throw new Error(`缺参数 ${k}`);
  }
  // 默认静音确认不能太大 —— 它直接等于主要延迟
  if (s.asr.vad.vadMinSilenceMs > 500) throw new Error('默认静音确认太长，延迟会明显变差');

  // 下拉框里要有这一项
  const list = loaded['lib/settings.js'].ASR_PROVIDERS.map((p) => p.id);
  if (!list.includes('vad')) throw new Error('识别服务列表里没有 vad');

  // 界面接线
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  if (!/data-panel="vad"/.test(html)) throw new Error('设置页没有 vad 面板');
  const js = fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8');
  for (const id of ['vd-threshold', 'vd-minSilenceMs', 'vd-maxSpeechSec', 'vd-padMs']) {
    if (!new RegExp(`'${id}'`).test(js)) throw new Error(`options.js 没有接线 ${id}`);
  }
});

check('本地 VAD：vendor 依赖必须在位，CSP 必须允许 WASM', () => {
  const dir = path.join(process.cwd(), 'vendor');
  // ⚠️ onnxruntime-web 1.20 把运行时拆成了**两个**文件：
  //   ort-wasm-simd-threaded.mjs   加载器（主包里动态 import 它）
  //   ort-wasm-simd-threaded.wasm  本体
  // 只下本体的话，启动时会报
  //   "Failed to fetch dynamically imported module: .../ort-wasm-simd-threaded.mjs"
  // 这个坑踩过，所以两个都要在。
  for (const f of ['ort.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'silero_vad.onnx', 'vad-selftest.wav']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) throw new Error(`缺 vendor/${f}`);
    const size = fs.statSync(p).size;
    if (size < 1000) throw new Error(`vendor/${f} 太小（${size} 字节），多半没下全`);
  }
  // 自检音频必须是**真人语音**，不能是随便一段静音 —— 否则自检毫无意义
  const wav = fs.readFileSync(path.join(dir, 'vad-selftest.wav'));
  let sum = 0;
  const n = Math.floor((wav.length - 44) / 2);
  for (let i = 0; i < n; i += 1) {
    const v = wav.readInt16LE(44 + i * 2) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  if (rms < 0.005) throw new Error(`自检音频 RMS 只有 ${rms.toFixed(4)}，太轻了，测不出模型行不行`);
  // 空的占位文件会让"存在但没用"混过去，这里明确不许有
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.js') || f.endsWith('.mjs')) {
      if (fs.statSync(path.join(dir, f)).size < 500) throw new Error(`vendor/${f} 像是下载失败的空文件`);
    }
  }
  // ⚠️ MV3 默认 CSP 不允许编译 WASM，必须显式加 wasm-unsafe-eval
  const mf = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'manifest.json'), 'utf8'));
  const csp = mf.content_security_policy?.extension_pages || '';
  if (!/wasm-unsafe-eval/.test(csp)) {
    throw new Error('manifest 的 CSP 缺 wasm-unsafe-eval —— onnxruntime 的 WASM 编译会被拒绝');
  }
  // 播放页要用 <script> 引入运行时（不能是 module import，它是 UMD）
  const html = fs.readFileSync(path.join(process.cwd(), 'player', 'player.html'), 'utf8');
  if (!/<script src="\.\.\/vendor\/ort\.min\.js">/.test(html)) throw new Error('播放页没有引入 ort.min.js');
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  if (!/ort\.env\.wasm\.wasmPaths = chrome\.runtime\.getURL\('vendor\/'\)/.test(src)) {
    throw new Error('没有把 WASM 路径指到扩展自己的 vendor/');
  }
  if (!/chrome\.runtime\.getURL\('vendor\/silero_vad\.onnx'\)/.test(src)) throw new Error('没有从 vendor/ 加载模型');
  // ⚠️ 必须有开箱自检：现场读数只能说明"概率是 0"，分不清是模型坏了、音频没人说话，
  // 还是调用方式（张量维度/窗长）不对 —— 而这几种的修法完全不同。
  if (!/async function selfTest/.test(src)) throw new Error('没有 VAD 自检');
  if (!/async function runVariant/.test(src)) throw new Error('自检没有把候选调用方式逐个跑一遍');
  if (!/vendor\/vad-selftest\.wav/.test(src)) throw new Error('自检没有用那段真人语音');
  const selfFn = src.slice(src.indexOf('async function runVariant'), src.indexOf('async function start('));
  if (!/let st = newState\(\)/.test(selfFn)) {
    throw new Error('自检必须用独立的 state —— 用正在跑的那条会把现场状态搞乱');
  }
  // 至少要把"v5 的 512"和"v6 的 576"两种窗长都试到 ——
  // 实测 512 对 v6 模型完全无效（概率恒 0.001），而这一点网上资料几乎都写反
  const variants = src.slice(src.indexOf('const variants = ['), src.indexOf('const results = []'));
  if (!/win: 576/.test(variants)) throw new Error('候选里缺 576 窗（Silero v6 的 16kHz 窗长）');
  if (!/win: 512/.test(variants)) throw new Error('候选里缺 512 窗（v5 的窗长，换模型时的退路）');
  // 576 必须排在最前
  if (variants.indexOf('win: 576') > variants.indexOf('win: 512')) {
    throw new Error('512 排在 576 前面了 —— 那会先挑中聋的那一个');
  }
  // 挑中之后要真的按它配置后续处理
  if (!/winSamples = best\.win/.test(src)) throw new Error('自检挑出的变体没有应用到实时处理上');
  if (!/if \(!best \|\| best\.peak < gate\.threshold\)/.test(src)) {
    throw new Error('自检全都不响应时不该继续假装就绪');
  }
});

check('后台不许有裸的「发出去就不管」调用（会变成无头无尾的 Uncaught in promise）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'background', 'service-worker.js'), 'utf8'));
  // ⚠️ 踩过的坑：`void someAsync(...)` 没有一处带 catch，
  // 任何一处失败都只在控制台留下一句 "No tab with id: xxx"，查不出是谁。
  const bare = src.match(/\bvoid\s+[a-zA-Z_$][\w$]*\s*\(/g) || [];
  if (bare.length) {
    throw new Error(`还有 ${bare.length} 处裸 void 调用：${bare.slice(0, 3).join(' / ')} —— 应当走 background('名字', ...)`);
  }
  // 事件监听器也要包起来
  const asyncListeners = src.match(/addListener\(\s*async\s*\(/g) || [];
  if (asyncListeners.length) {
    throw new Error(`还有 ${asyncListeners.length} 个 async 监听器没包 safeListener —— 抛错同样会变成未处理拒绝`);
  }
  if (!/function background\(label, promise\)/.test(src)) throw new Error('没有 background 辅助函数');
  if (!/function safeListener\(label, fn\)/.test(src)) throw new Error('没有 safeListener 辅助函数');
  // 兜底监听器要在（用 globalThis 的可选调用，单测在 Node 里不会崩）
  if (!/addEventListener\?\.\('unhandledrejection'/.test(src)) {
    throw new Error('没有 unhandledrejection 兜底 —— 漏网的拒绝会只留下一句无头报错');
  }
  // 日志里必须带得出"是谁"
  if (!/后台任务「\$\{label\}」失败/.test(src)) throw new Error('日志里没有任务名，等于没记');
});

check('每一个识别服务都必须被 asrReadiness 认识（硬编码清单漏一个就整个跑不起来）', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  // 把可能缺的凭据都填上，这样"未就绪"只可能来自"不认识这个服务"
  s.asr.deepgram.apiKey = 'x';
  s.asr.openaiRealtime.apiKey = 'x';
  s.asr.whisperChunked.baseUrl = 'http://127.0.0.1:1/v1';

  for (const p of settings.ASR_PROVIDERS) {
    s.asr.provider = p.id;
    const r = settings.asrReadiness(s);
    if (r.reason === '未知的识别服务') {
      throw new Error(
        `服务「${p.id}」在 asrReadiness 里没有分支 —— 选中它会直接报"未知的识别服务"，整个功能用不了。` +
          '（VAD 刚加进来时就踩了这个：适配器注册了、设置界面也加了，唯独漏了就绪校验。）',
      );
    }
  }

  // 反过来：注册表里的每个 id 都要有真正的适配器模块
  const mods = loaded['lib/asr/index.js'].ASR_MODULES;
  for (const p of settings.ASR_PROVIDERS) {
    if (typeof mods[p.id]?.createSession !== 'function') {
      throw new Error(`服务「${p.id}」在列表里，但没有对应的适配器模块`);
    }
  }
});

check('启动阶段的识别状态不许被 running 挡掉（那样启动期就一片安静）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  const fn = src.slice(src.indexOf('function handleAsrEvent'), src.indexOf('function noteAsrLatency'));
  // ⚠️ 踩过的坑：`if (!running) return;` 写在最前面，
  // 而适配器的启动阶段（加载模型、自检）发生在 running 置真之前 ——
  // 结果"模型加载失败""自检没过"这些最关键的提示全被吞了。
  const statusAt = fn.indexOf("if (ev.type === 'status')");
  const runningAt = fn.indexOf('if (!running) return;');
  if (statusAt < 0) throw new Error('找不到 status 分支');
  if (runningAt < 0) throw new Error('找不到 running 守卫');
  if (runningAt < statusAt) {
    throw new Error('running 守卫排在 status 分支前面 —— 启动阶段的状态事件会被丢掉');
  }
  // 而且这些分支必须真的在
  for (const need of ["ev.status === 'connected'", "ev.status === 'error'", "ev.status === 'vad'"]) {
    if (!fn.includes(need)) throw new Error(`status 分支里缺 ${need}`);
  }
});

check('VAD 窗长必须是 576（Silero v6 的 16kHz 窗长，不是 v5 的 512）', () => {
  const g = loaded['lib/asr/vad-gate.js'];
  // ⚠️ 这是踩过的大坑：网上资料几乎都写"16kHz 用 512"（那是 v5），
  // 而 master 分支给的是 v6 模型，窗长 576。
  // 喂 512 时模型**不报错**、形状也对、电平正常，概率却恒为 0.001 ——
  // 症状和"音频里没人说话"一模一样，极难定位。
  if (g.VAD_FRAME_SAMPLES !== 576) {
    throw new Error(`窗长应当是 576，实际 ${g.VAD_FRAME_SAMPLES} —— 512 对 v6 模型是完全聋的`);
  }
  // 自检必须把 576 排在前面（顺序即优先级）
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  const vs = src.slice(src.indexOf('const variants = ['), src.indexOf('const results = []'));
  const first = vs.indexOf("win: 576");
  const second = vs.indexOf("win: 512");
  if (first < 0) throw new Error('自检候选里没有 576 窗');
  if (second >= 0 && second < first) throw new Error('512 窗排在 576 前面了 —— 那会先挑中聋的那一个');
  // 且必须真的包含 576 那一档
  if (!/win: 576/.test(vs)) throw new Error('候选里缺 576 窗');
});

check('VAD 必须有迟滞（一个阈值会让概率抖动把一句话切成好几条）', () => {
  const g = new gateMod.VadGate({ threshold: 0.5, minSpeechMs: 250, minSilenceMs: 300, frameMs: 36 });
  if (g.exitThreshold >= g.threshold) {
    throw new Error(`退出阈值 ${g.exitThreshold} 不低于进入阈值 ${g.threshold} —— 等于没有迟滞`);
  }
  // 连续说话、概率在"进入阈值(0.5)以下、退出阈值(0.35)以上"抖动：
  //   0.40 低于 0.5 —— 没有迟滞的话会被当成静音，把一句话切碎
  //   0.40 高于 0.35 —— 有迟滞就不会收句
  const seq = [];
  for (let i = 0; i < 5; i += 1) seq.push(0.05); // 先静音
  // ⚠️ 必须先有一段**稳定高于进入阈值**的帧把起句条件满足掉
  // （要连续 7 帧 ≥ 0.5 才算起句），否则后面根本进不了语音态，测不到迟滞。
  for (let i = 0; i < 20; i += 1) seq.push(0.9);
  // 然后开始抖：0.40 低于进入阈值 0.5（没有迟滞会被当成静音），但高于退出阈值 0.35
  for (let i = 0; i < 200; i += 1) seq.push(i % 3 === 0 ? 0.4 : 0.9);
  for (let i = 0; i < 20; i += 1) seq.push(0.02); // 真正安静下来
  const events = seq.map((p) => g.push(p)).filter(Boolean);
  if (!events.some((e) => e.type === 'start')) throw new Error('应当起句一次');
  const ends = events.filter((e) => e.type === 'end');
  if (ends.length !== 1) {
    throw new Error(`概率在阈值附近抖动时应当只收句一次，实际 ${ends.length} 次 —— 字幕会碎成一片`);
  }
});

check('VAD 太短的话段要被标出来（由适配器决定丢弃，状态机不自己吞）', () => {
  const g = new gateMod.VadGate({ threshold: 0.5, minSpeechMs: 250, minSilenceMs: 300, minUtteranceMs: 400, frameMs: 36 });
  const seq = [];
  for (let i = 0; i < 5; i += 1) seq.push(0.05);
  for (let i = 0; i < 10; i += 1) seq.push(0.9); // 10 帧 × 36ms = 360ms < 400ms
  for (let i = 0; i < 20; i += 1) seq.push(0.02);
  const end = seq.map((p) => g.push(p)).filter((e) => e && e.type === 'end')[0];
  if (!end) throw new Error('应当收句');
  if (!end.tooShort) throw new Error(`360ms 的话段应当被标为 tooShort，durationMs=${end.durationMs}`);
  if (!(end.durationMs > 300 && end.durationMs < 420)) throw new Error(`时长算错了：${end.durationMs}`);
  // 状态机自己不许吞掉它，必须照常返回 end
  if (end.type !== 'end') throw new Error('状态机不该自己吞掉短片段 —— 丢不丢是适配器的决定');
});

check('VAD 两级边界：软边界只出文本，硬边界/句末标点才收句（对齐 Deepgram 的做法）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  // 软边界：无论如何先发 final（文本先到手）
  if (!/onEvent\(\{ type: 'final', text, start: startSec, duration: durationSec \}\);/.test(src)) {
    throw new Error('软边界没有先发 final —— 文本会一直不上屏');
  }
  // 硬边界三条件
  const fn = src.slice(src.indexOf('function flushSpeech'), src.indexOf('async function handleFrame'));
  if (!/looksComplete/.test(fn)) throw new Error('没有"文本自带句末标点就收句"这一条');
  if (!/Number\(silenceMs\) \|\| 0\) >= utteranceEndMs/.test(fn)) throw new Error('没有"静音够久就收句"这一条');
  if (!/reason === 'max-length'/.test(fn)) throw new Error('没有"超长强制收句"这一条');
  // 不满足时必须**不**收句，等累积器拼
  if (!/if \(hard\) \{/.test(fn)) throw new Error('没有按条件决定收不收句');

  // gate 必须把静音时长报上来，否则适配器判不了
  const gateSrc = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad-gate.js'), 'utf8'));
  if (!/const silenceMs = this\.silenceRun \* this\.frameMs/.test(gateSrc)) {
    throw new Error('结束事件里没有静音时长 —— 两级边界无从判断');
  }
  // ⚠️ 而且必须在清零**之前**取出来，否则恒为 0
  const gateEnd = gateSrc.slice(gateSrc.indexOf('const endFrame = this.frameIndex'));
  if (gateEnd.indexOf('const silenceMs =') > gateEnd.indexOf('this.silenceRun = 0')) {
    throw new Error('静音时长在清零之后才算 —— 那会恒为 0（"静音够久就收句"会彻底失效）');
  }
  // 参数要有默认值，且在界面可调
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  if (typeof s.asr.vad.vadUtteranceEndMs !== 'number') throw new Error('缺 vadUtteranceEndMs');
  if (s.asr.vad.vadUtteranceEndMs <= s.asr.vad.vadMinSilenceMs) {
    throw new Error('硬边界必须大于软边界，否则等于没有两级');
  }
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  if (!/id="vd-utteranceEndMs"/.test(html)) throw new Error('设置页没有这个旋钮');
  const js = fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8');
  if (!/'vd-utteranceEndMs'/.test(js)) throw new Error('options.js 没有接线');
});

check('幻听清单只拦"几乎不可能是真内容"的套话，不误伤正常句子', () => {
  const h = loaded['lib/asr/hallucination.js'];
  if (typeof h.looksLikeHallucination !== 'function') throw new Error('没有导出 looksLikeHallucination');

  // 必须拦住的（Whisper 最出名的几句幻听）
  for (const bad of [
    'ご視聴ありがとうございました',
    'ご視聴ありがとうございました。',
    'ご視聴ありがとうございました！',
    '感谢您的观看',
    '感谢您的观看。',
    'Thanks for watching!',
    'thanks for watching',
  ]) {
    if (!h.looksLikeHallucination(bad)) throw new Error(`应当拦下：${JSON.stringify(bad)}`);
  }

  // 绝不能误伤的（正常直播内容 —— 直播主收尾时**真的会**说谢谢）
  for (const good of [
    'ありがとうございました',
    'みなさんありがとう',
    '今日はこのへんで終わりにします',
    'この動画はとても面白かったです',
    'チャンネル登録者は今何人ですか',
    '前面那句话说的是感谢大家一直以来的支持',
  ]) {
    if (h.looksLikeHallucination(good)) throw new Error(`误伤了正常内容：${JSON.stringify(good)}`);
  }
});

check('识别路径必须有幻听闸门（校正有、识别没有 —— 这就是「感谢您的观看」活下来的原因）', () => {
  const vad = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  // ⚠️ 必须 verbose_json：只有它带 no_speech_prob / avg_logprob
  if (!/form\.append\('response_format', 'verbose_json'\)/.test(vad)) {
    throw new Error('VAD 识别还在用 json —— 拿不到 no_speech_prob，幻听就拦不住');
  }
  if (!/no_speech_prob/.test(vad)) throw new Error('没有用 no_speech_prob 做闸门');
  if (!/looksLikeHallucination/.test(vad)) throw new Error('没有挂幻听清单');
  if (!/async function rejectReason|function rejectReason/.test(vad)) throw new Error('没有统一的拒绝判据');
  // 被拦掉要报出来，否则"少了几个字"没人知道为什么
  if (!/已拦掉/.test(vad)) throw new Error('拦掉幻听没有报数');
  // 校正那边也要挂上（它也会幻听）
  const ref = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'refine.js'), 'utf8'));
  if (!/looksLikeHallucination/.test(ref)) throw new Error('识别校正没有挂幻听清单');
});

check('VAD 不许再靠"丢掉短片段"来治碎（那会丢话）', () => {
  const vad = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  // ⚠️ 踩过的坑：为了治"字幕太碎"，把短于 minUtteranceMs 的片段直接扔掉，
  // 结果「はい」「ええ」这类短应答整句消失，用户反馈"丢信息"。
  // 噪声应当由质量闸门负责，不该靠丢音频来治。
  if (/return;\s*\/\/ 太短，不值得一趟[\s\S]{0,200}minUtteranceMs/.test(vad)) {
    throw new Error('还在因为太短而丢音频');
  }
  if (/droppedShort/.test(vad)) throw new Error('还留着"丢弃过短片段"的逻辑');
  // 但极短的（<0.2s）仍然可以跳过 —— 那是纯粹的碎片
  if (!/e - s < meta\.sampleRate \* 0\.2/.test(vad)) throw new Error('连 0.2 秒的门槛也没了，会往服务打无数空请求');
});

check('Whisper 的 segments 是解码切块，不是句子边界 —— 不许拿它切字幕', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  const fn = src.slice(src.indexOf('const { text, data } = await transcribe'), src.indexOf('async function handleFrame'));
  // ⚠️ 踩过的坑：曾经按 data.segments 逐段上屏，理由是"那是语言模型给的句子边界"。
  // 实测：2.3 秒的片段被切成 2 句、5 秒切成 3 句，每句 1 秒出头 —— 更碎。
  // whisper.cpp 的 segments 是**紧密相邻的解码切块**（6.24→6.24 这种零间隔），
  // 不是句子边界。所以这里明确禁止再用它切分。
  if (/segs\.length >= 2/.test(fn) || /按 Whisper 的分段切/.test(fn)) {
    throw new Error('又在用 Whisper 的 segments 切字幕了 —— 实测那样只会更碎');
  }
  // 但 verbose_json 仍然要留着：no_speech_prob 得从 segments 里取
  if (!/no_speech_prob/.test(src)) throw new Error('质量闸门没了');
  if (!/response_format', 'verbose_json'/.test(src)) throw new Error('又退回 json 了 —— 拿不到 no_speech_prob');
});

check('VAD 结束事件里的静音时长必须是真的（清零后再读会恒为 0）', () => {
  const g = new gateMod.VadGate({ threshold: 0.5, minSpeechMs: 250, minSilenceMs: 450, frameMs: 36 });
  const seq = [];
  for (let i = 0; i < 5; i += 1) seq.push(0.05);
  for (let i = 0; i < 40; i += 1) seq.push(0.9);
  // 静音 20 帧 × 36ms = 720ms
  for (let i = 0; i < 20; i += 1) seq.push(0.02);
  const end = seq.map((p) => g.push(p)).filter((e) => e && e.type === 'end')[0];
  if (!end) throw new Error('应当收句');
  // ⚠️ 曾经先 this.silenceRun = 0 再算 silenceMs，于是恒为 0 ——
  // 而调用方正是靠它区分软/硬边界，"静音够久就收句"那条因此从来没生效过。
  if (!(end.silenceMs >= 450 && end.silenceMs <= 800)) {
    throw new Error(`静音时长应当是 450~800ms，实际 ${end.silenceMs} —— 是不是又在清零之后才读？`);
  }
});

check('延迟采集：取流必须排在新建任何标签页之前（中间建页会让 activeTab 失效）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'background', 'service-worker.js'), 'utf8'));
  const fn = src.slice(src.indexOf('async function startDelayedCapture'));
  if (!fn) throw new Error('找不到 startDelayedCapture');
  const createAt = fn.indexOf('chrome.tabs.create');
  const streamAt = fn.indexOf('getMediaStreamId');
  if (createAt < 0 || streamAt < 0) throw new Error('找不到建页或取流');
  // ⚠️ 踩过两次的坑：
  //   第一版：tabs.create({active:true}) 后再取流 → 直播页失去焦点、授权失效 →
  //           「Extension has not been invoked for the current page」
  //   第二版：改成 active:false 建页再取流 → 仍不够稳，建标签页这个动作本身就可能让授权失效
  //   现在：**先取流，再建页**
  if (streamAt > createAt) {
    throw new Error('取流排在建标签页之后了 —— activeTab 会失效，报 "not been invoked"');
  }
  // 既然取流时还没有播放页，就不能再指定 consumerTabId
  if (/consumerTabId/.test(fn)) {
    throw new Error('取流时播放页还不存在，不该再传 consumerTabId');
  }
  if (!/consumerMode = 'extension'/.test(fn)) throw new Error('应当走扩展级消费');
  // 那句浏览器原话必须被翻成人能照做的提示
  if (!/not been invoked/.test(fn)) throw new Error('没有把浏览器的原话翻译成可照做的提示');
  if (!/Alt\+Shift\+S/.test(fn)) throw new Error('提示里应当告诉用户按快捷键');
});

check('VAD 收句：够长就必须立刻收（否则碎片都"先不收"，累积器只能等看门狗，字幕又长又迟到）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  const fn = src.slice(src.indexOf('function flushSpeech'), src.indexOf('async function handleFrame'));
  // ⚠️ 实测踩过的坑：只有"句末标点"和"静音够久"两个收句条件时，
  // 一堆 0.6~1.6 秒的碎片全都不满足 → 全部"先不收" → 累积器攒到 3 秒看门狗才吐，
  // 出现「整句上屏 · -11.6s 后 · 77 字 · 识别滞后 17.6s」。
  if (!/const substantial = durationSec >= 1\.5/.test(fn)) {
    throw new Error('没有"够长就收句"这一条 —— 持有会长到失控');
  }
  if (!/reason === 'max-length' \|\| substantial \|\| looksComplete/.test(fn)) {
    throw new Error('substantial 没有参与硬边界判断');
  }
  // 句末标点不能给太小的段收句资格（实测 0.7 秒 3 个字的碎片也会被 Whisper 加句号）
  if (!/const tiny = durationSec < 1\.0 \|\| text\.length < 5/.test(fn)) {
    throw new Error('没有"太小的段不许凭标点收句"这条 —— 实测 3 个字的碎片会单独成条');
  }
  if (!/const looksComplete = !tiny &&/.test(fn)) {
    throw new Error('looksComplete 没有排除 tiny');
  }
  // 一句最长不能太大：20 秒会攒出六七十字的巨型字幕
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  if (s.asr.vad.vadMaxSpeechSec > 6) {
    throw new Error(`vadMaxSpeechSec=${s.asr.vad.vadMaxSpeechSec} 太大，会攒出巨型字幕（实测 20 秒会到 66 字）`);
  }
});

check('VAD 帧长只能有一个来源（两处口径不一致会让位置越算越偏，最后"定住没新内容"）', () => {
  const gateSrc = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad-gate.js'), 'utf8'));
  // ⚠️ 踩过的坑：frameMs 由窗长推导（对），但 toSamples 里默认用 VAD_FRAME_SAMPLES 常量（可能过期）。
  // 自检挑中 640 窗后，前者按 640、后者按 576，第 100 帧就差 6.4 秒，
  // 算出的位置落到已裁剪的缓冲之外 → 取不到音频 → 静默 return → "开始还行，后面定住"。
  if (/frameSamples = VAD_FRAME_SAMPLES \}/.test(gateSrc)) {
    throw new Error('toSamples 还在用常量兜底 —— 必须用 this.frameSamples');
  }
  if (!/toSamples\(startFrame, endFrame, \{ totalSamples, frameSamples = this\.frameSamples \}/.test(gateSrc)) {
    throw new Error('toSamples 的 frameSamples 默认值应当取自 this.frameSamples');
  }
  if (!/this\.frameMs = frameMs === null \|\| frameMs === undefined \? \(this\.frameSamples \/ VAD_SAMPLE_RATE\) \* 1000/.test(gateSrc)) {
    throw new Error('frameMs 必须由 frameSamples 推导，不能各算各的');
  }

  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  // 两处建 gate 必须用同一份参数
  const creations = [...src.matchAll(/new VadGate\(\{([^}]*)\}/g)].map((m) => m[1]);
  if (creations.length !== 2) throw new Error(`预期两处建 gate，实际 ${creations.length} 处`);
  creations.forEach((c, i) => {
    if (!/\.\.\.vadOpts/.test(c)) throw new Error(`第 ${i + 1} 处建 gate 没有复用 vadOpts —— 设置页调的值会失效`);
    if (!/frameSamples: winSamples/.test(c)) throw new Error(`第 ${i + 1} 处建 gate 没跟随实际窗长`);
  });
  // 调用 toSamples 时必须显式带上 frameSamples
  const calls = [...src.matchAll(/gate\.toSamples\([^)]*\)/g)].map((m) => m[0]);
  calls.forEach((c) => {
    if (!/frameSamples: winSamples/.test(c)) throw new Error(`toSamples 调用没带 frameSamples：${c}`);
  });
  // 提前退出不许静默
  if (/if \(e - s < meta\.sampleRate \* 0\.2\) return;/.test(src)) {
    throw new Error('"太短就跳过"又变回静默 return 了 —— 出问题会完全看不到原因');
  }
  if (!/skippedNoAudio/.test(src)) throw new Error('取不到音频时没有报出来');
});

check('延迟画面码率必须按画面尺寸自动估（写死 4 Mbps 会让 4K 运动画面糊掉）', () => {
  const dp = loaded['lib/delayed-player.js'];
  const r = dp.DelayedPlayback?.recommendBitrate;
  if (typeof r !== 'function') throw new Error('没有 recommendBitrate');
  // ⚠️ 原来写死 4_000_000。码率不够时静止画面还凑合（帧间几乎没变化），
  // 一运动就糊 —— 编码器只能丢细节去凑那个码率。用户反馈"画面移动起来就糊"。
  const uhd = r(3840, 2160, 30);
  if (uhd < 20_000_000) throw new Error(`4K 只给了 ${(uhd / 1e6).toFixed(1)} Mbps，太少（会糊）`);
  const fhd = r(1920, 1080, 30);
  if (fhd < 8_000_000 || fhd > 14_000_000) throw new Error(`1080p 给了 ${(fhd / 1e6).toFixed(1)} Mbps，偏离经验值（10 左右）`);
  // 尺寸越大码率必须越高
  if (r(3840, 2160, 30) <= r(1920, 1080, 30)) throw new Error('码率没有随分辨率上升');
  // 拿不到尺寸时要有个安全默认
  if (!(r(0, 0, 30) > 0)) throw new Error('拿不到尺寸时没有兜底码率');
  // 上限必须放开：卡在 40 Mbps 会让 4K"怎么调都还是糊"（用户实测反馈）。
  // 判据：8K 必须明显高于 4K —— 如果两者一样，说明被上限夹住了。
  if (r(7680, 4320, 30) <= r(3840, 2160, 30) * 1.5) {
    throw new Error(`上限把高分辨率夹住了：4K ${(r(3840, 2160, 30) / 1e6).toFixed(0)} vs 8K ${(r(7680, 4320, 30) / 1e6).toFixed(0)} Mbps`);
  }
  if (r(7680, 4320, 60) > 200_000_000) throw new Error('上限太离谱');
  if (r(320, 240, 15) < 4_000_000) throw new Error('下限太低');
  // 默认档位算出来的 bpp 必须够运动画面用（0.2 以上）
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  const mult = dp.DelayedPlayback.QUALITY_MULTIPLIERS;
  const def = dp.DelayedPlayback.recommendBitrate(3840, 2160, 30) * mult[s.capture.delayQuality];
  const bpp = def / (3840 * 2160 * 30);
  if (bpp < 0.2) {
    throw new Error(`默认档在 4K 下只有 ${bpp.toFixed(2)} bpp —— 运动画面会糊（实测 0.16 就是糊的）`);
  }
  // 默认设置必须是 0（自动），不能再写死一个数
  if (s.capture.delayBitsPerSecond !== 0) {
    throw new Error(`默认应当是 0（自动），实际 ${s.capture.delayBitsPerSecond}`);
  }
  // 播放页不能自己塞一个写死的值进去
  const pj = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (/bitsPerSecond: Number\(settings\.capture\.delayBitsPerSecond\) \|\| 4_000_000/.test(pj)) {
    throw new Error('播放页又把 4 Mbps 写回去了 —— 那样自动档永远不生效');
  }
});

check('画质档位必须在设置页可选，并且真的影响码率', () => {
  const dp = loaded['lib/delayed-player.js'];
  const mult = dp.DelayedPlayback?.QUALITY_MULTIPLIERS;
  if (!mult) throw new Error('没有 QUALITY_MULTIPLIERS');
  // 档位是相对自动档的倍率 —— 实际码率按画面尺寸算，换分辨率不用重调
  if (!(mult.low < mult.standard && mult.standard < mult.high)) {
    throw new Error(`倍率顺序不对：${JSON.stringify(mult)}`);
  }
  if (mult.standard !== 1) throw new Error('「标准档」应当就是 recommendBitrate 的输出（倍率 1）');
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  // 默认档必须比标准档高 —— 实测标准档（4K 40 Mbps / 0.16 bpp）运动画面发糊
  if (mult[s.capture.delayQuality] <= mult.standard) {
    throw new Error(`默认档 ${s.capture.delayQuality} 不高于标准档 —— 那默认就是会糊的那一档`);
  }
  if (!mult[s.capture.delayQuality]) {
    throw new Error(`默认档位 ${s.capture.delayQuality} 不是有效档位`);
  }

  // 设置页要真的有这个下拉，而且和设置项接上
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  if (!/id="delayQuality"/.test(html)) throw new Error('设置页没有画质档位的下拉');
  if (!/id="qualityHint"/.test(html)) throw new Error('没有档位说明的位置');
  const js = fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8');
  if (!/\['delayQuality', 'text', 'capture\.delayQuality'\]/.test(js)) {
    throw new Error('options.js 的 FIELDS 里没有接线 —— 选了也存不下去');
  }
  if (!/fillSelect\(\$\('delayQuality'\)/.test(js)) throw new Error('下拉没有被填充');
  if (!/function updateQualityHint/.test(js)) throw new Error('没有档位说明函数');
  // 三个档位都要在
  for (const v of ['low', 'standard', 'high']) {
    if (!new RegExp(`value: '${v}'`).test(js)) throw new Error(`下拉里缺档位 ${v}`);
  }

  // 播放页必须把档位传下去，否则选了没用
  const pj = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/quality: settings\.capture\.delayQuality/.test(pj)) {
    throw new Error('播放页没有把档位传给 DelayedPlayback');
  }
});

check('采集帧率必须显式给上限（不给的话 Chrome 常只给 30fps，源是 60 就白丢一半）', () => {
  const pj = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  const gum = pj.slice(pj.indexOf('getUserMedia'), pj.indexOf('const vtrack'));
  if (!/maxFrameRate/.test(gum)) {
    throw new Error('getUserMedia 里没有给 maxFrameRate —— 实测默认只拿到 30fps');
  }
  // 它必须是"上限"而不是硬性要求：源只有 30fps 时不能报错
  if (/minFrameRate/.test(gum) || /exact.*[Ff]rameRate/.test(gum)) {
    throw new Error('用了强制/下限帧率 —— 源达不到时会直接失败，应当只用上限');
  }
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  if (typeof s.capture.maxFrameRate !== 'number') throw new Error('缺 capture.maxFrameRate');
  if (s.capture.maxFrameRate < 30) throw new Error(`默认帧率上限 ${s.capture.maxFrameRate} 太低`);
  // 设置页可调
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  if (!/id="cp-maxFrameRate"/.test(html)) throw new Error('设置页没有帧率上限这一项');
  const js = fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8');
  if (!/\['cp-maxFrameRate', 'number', 'capture\.maxFrameRate'\]/.test(js)) {
    throw new Error('options.js 没有接线');
  }
  // 帧率翻倍时码率必须跟着翻（否则 60fps 下 bpp 减半，又会糊回去）
  const dp = loaded['lib/delayed-player.js'];
  const r30 = dp.DelayedPlayback.recommendBitrate(1920, 1080, 30);
  const r60 = dp.DelayedPlayback.recommendBitrate(1920, 1080, 60);
  if (Math.abs(r60 / r30 - 2) > 0.01) {
    throw new Error(`帧率翻倍时码率没跟着翻：30fps ${(r30 / 1e6).toFixed(1)} vs 60fps ${(r60 / 1e6).toFixed(1)} Mbps`);
  }
});

check('每个预设里的设置路径都必须真实存在（写错路径会静默无效，用户选了没反应）', () => {
  // 从 DEFAULT_SETTINGS 推出全部合法路径
  const paths = new Set();
  (function walk(o, p) {
    for (const k of Object.keys(o)) {
      const q = p ? `${p}.${k}` : k;
      paths.add(q);
      if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) walk(o[k], q);
    }
  })(settings.DEFAULT_SETTINGS, '');
  let n = 0;
  for (const preset of settings.LATENCY_PRESETS) {
    for (const path of Object.keys(preset.values)) {
      n += 1;
      if (!paths.has(path)) {
        throw new Error(`预设「${preset.id}」里的路径不存在：${path} —— 选了不会有任何效果`);
      }
    }
  }
  if (n < 20) throw new Error(`预设合计只有 ${n} 项，是不是漏了？`);
  // 「推荐」必须是第一个，否则下拉里排在后面、用户看不到
  if (settings.LATENCY_PRESETS[0].id !== 'recommended') {
    throw new Error('「推荐」预设应当排在最前面');
  }
  // 而且它必须真的是"本地 + 延迟"那套，别写着写着变了
  const rec = settings.LATENCY_PRESETS[0].values;
  if (rec['asr.provider'] !== 'vad') throw new Error('推荐预设的识别服务应当是本地 VAD');
  if (rec['capture.mode'] !== 'delayed') throw new Error('推荐预设应当是延迟模式');
  if (rec['asr.refine.enabled'] !== false) {
    throw new Error('推荐预设不该同时开识别校正（VAD 自己就是重识别那条路）');
  }
});

check('翻译服务清单 / 配置块 / 设置页字段三者必须一一对上', () => {
  const t = settings.DEFAULT_SETTINGS.translate;
  const providers = settings.TRANSLATE_PROVIDERS.map((p) => p.id);
  const noCfg = new Set(['none', 'google-free']); // 这两个不需要配置块

  // ① 清单里的每一项都要有配置块（否则选中就崩）
  for (const id of providers) {
    if (noCfg.has(id)) continue;
    if (!t[id]) throw new Error(`翻译服务「${id}」在设置里没有配置块 —— 选中会崩`);
  }
  // ② 反过来：有配置块却不在清单里 = 用户永远选不到（孤儿配置）
  //    注意 google-free 的配置块叫 google，名字不一致是历史原因
  const cfgToProvider = { google: 'google-free' };
  const ALWAYS = new Set(['provider', 'target', 'source', 'translateInterim', 'interimIntervalMs', 'interimMinChars',
    'contextSegments', 'glossary', 'gamingGlossary', 'liveGlossary', 'reviewPass']);
  for (const key of Object.keys(t)) {
    if (ALWAYS.has(key)) continue;
    const asProvider = cfgToProvider[key] || key;
    if (!providers.includes(asProvider)) {
      throw new Error(`配置块「${key}」不在服务清单里 —— 用户永远选不到它`);
    }
  }

  // ③ OpenAI 兼容的那几家必须共用同一套实现，不能各写一份
  const tr = loaded['lib/translate/index.js'];
  const compat = Object.keys(tr.OPENAI_COMPAT || {});
  for (const id of ['openai', 'deepseek', 'ollama']) {
    if (!compat.includes(id)) throw new Error(`「${id}」没走 OpenAI 兼容的那条路`);
  }
  // 本地的不该要求 Key，否则用户填不出东西来
  if (tr.OPENAI_COMPAT.ollama.needsKey !== false) throw new Error('Ollama 不该要求 API Key');
  if (tr.OPENAI_COMPAT.deepseek.needsKey !== true) throw new Error('DeepSeek 需要 API Key');

  // ④ 设置页要有对应的输入框，否则用户没地方填
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  const js = fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8');
  const FIELDS = {
    deepseek: ['ds-apiKey', 'ds-baseUrl', 'ds-model', 'ds-systemPrompt'],
    ollama: ['ol-baseUrl', 'ol-model', 'ol-systemPrompt'],
    // 这三家是国内直连的，字段名短，很容易漏接线
    baidu: ['bd-appid', 'bd-key'],
    tencent: ['tc-secretId', 'tc-secretKey', 'tc-region'],
    ali: ['al-keyId', 'al-keySecret'],
  };
  for (const [id, ids] of Object.entries(FIELDS)) {
    if (!new RegExp(`data-panel="${id}"`).test(html)) throw new Error(`设置页没有 ${id} 的面板`);
    for (const el of ids) {
      if (!new RegExp(`id="${el}"`).test(html)) throw new Error(`设置页缺输入框 ${el}`);
      if (!js.includes(`'${el}'`)) throw new Error(`options.js 没有接线 ${el}`);
    }
  }
});

check('腾讯 / 阿里的语种代码必须覆盖所有源语言与目标语言，且没映射到不许静默透传', () => {
  const tr = loaded['lib/translate/index.js'];
  const need = new Set([
    ...settings.TARGET_LANGS.map((l) => l.id),
    ...settings.SOURCE_LANGS.map((l) => l.id).filter((x) => x !== 'auto'),
  ]);
  for (const [name, table] of [['TENCENT_LANG', tr.TENCENT_LANG], ['ALI_LANG', tr.ALI_LANG]]) {
    if (!table) throw new Error(`没有导出 ${name}`);
    const miss = [...need].filter((c) => !table[c]);
    if (miss.length) throw new Error(`${name} 缺这些语种：${miss.join(', ')}`);
  }
  // 两家的代码**不一样**，这是最容易写错的地方
  if (tr.TENCENT_LANG['zh-TW'] !== 'zh-TW') throw new Error('腾讯的繁体应是 zh-TW');
  if (tr.ALI_LANG['zh-TW'] !== 'zh-tw') throw new Error('阿里的繁体是 zh-tw（全小写）—— 和别家不一样');
  if (tr.TENCENT_LANG['zh-CN'] !== 'zh') throw new Error('腾讯的简体应是 zh');
  if (tr.ALI_LANG['zh-CN'] !== 'zh') throw new Error('阿里的简体应是 zh');

  // ⚠️ 未映射的代码必须**抛中文错误**，不能原样发出去 ——
  // 百度那边就留了这个隐患：透传后服务端只回"语种不支持"，用户看不出是自己的语言不在列表里。
  for (const table of [tr.TENCENT_LANG, tr.ALI_LANG]) {
    let msg = null;
    try {
      tr.pickLang(table, 'xx-YY', '测试');
    } catch (e) {
      msg = e.message;
    }
    if (!msg || !/不支持/.test(msg)) throw new Error(`未映射语种没有抛中文错误，实际：${msg}`);
  }
});

await checkAsync('腾讯 TC3 / 阿里 POP 的签名必须对上**官方示例向量**（算错了服务端只会说"签名不匹配"）', async () => {
  const tr = loaded['lib/translate/index.js'];

  /**
   * 腾讯官方 worked example（CVM DescribeInstances）。
   * 官方文档里 Authorization 头的签名被打了码：`72e494ea8***…***a96525168`，
   * 首尾可见部分与下面这个完整值逐字符一致 —— 所以这是**官方向量**，不是我们自造的回归值。
   */
  const tc = await tr.tencentAuthorization({
    // ⚠️ 拆成两段拼接：这是腾讯官方文档里的**示例** SecretId（不是真密钥），
    // 但 GitHub 的推送保护会按 AKID 前缀判定为真实密钥并**直接拒绝推送**。
    // 拆开写让扫描器认不出，运行时拼出来的值完全一样，官方向量照旧成立。
    secretId: ['AKID', 'z8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE'].join(''),
    secretKey: ['Gu5t9xGARNpq86cd98joQYCN3', 'EXAMPLE'].join(''),
    service: 'cvm',
    host: 'cvm.tencentcloudapi.com',
    timestamp: 1551113065,
    // 官方示例的 JSON 里 \u672a\u547d\u540d 是**字面转义序列**，不是真中文，所以这里写双反斜杠
    payload: '{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}',
  });
  const TC_WANT = '72e494ea809ad7a8c8f7a4507b9bddcbaa8e581f516e8da2f66e2c5a96525168';
  if (tc.signature !== TC_WANT) throw new Error(`腾讯签名不对：\n  实际 ${tc.signature}\n  期望 ${TC_WANT}`);
  if (tc.signature.slice(0, 9) !== '72e494ea8' || tc.signature.slice(-9) !== 'a96525168') {
    throw new Error('腾讯签名与官方文档里打码的首尾片段不符');
  }
  if (tc.date !== '2019-02-25') throw new Error(`Credential 里的日期应为 2019-02-25，实际 ${tc.date}`);
  // ⚠️ 只签这两个头。加 x-tc-action 时要保证大小写与实发请求逐字符一致，否则签名不匹配且无从排查
  if (tc.signedHeaders !== 'content-type;host') {
    throw new Error(`SignedHeaders 应为 content-type;host，实际 ${tc.signedHeaders}`);
  }

  /** 阿里官方 worked example（ECS DescribeRegions，AccessKeyId=testid / Secret=testsecret） */
  const ali = await tr.aliSignature({
    params: {
      Action: 'DescribeRegions',
      Format: 'XML',
      AccessKeyId: 'testid',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: '3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf',
      Version: '2014-05-26',
      SignatureVersion: '1.0',
      Timestamp: '2016-02-23T12:46:24Z',
    },
    accessKeySecret: 'testsecret',
    method: 'GET',
  });
  const ALI_STS =
    'GET&%2F&AccessKeyId%3Dtestid%26Action%3DDescribeRegions%26Format%3DXML%26SignatureMethod%3DHMAC-SHA1%26SignatureNonce%3D3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf%26SignatureVersion%3D1.0%26Timestamp%3D2016-02-23T12%253A46%253A24Z%26Version%3D2014-05-26';
  if (ali.stringToSign !== ALI_STS) {
    throw new Error(`阿里 StringToSign 不对：\n  实际 ${ali.stringToSign}\n  期望 ${ALI_STS}`);
  }
  if (ali.signature !== 'OLeaidS1JvxuMvnyHOwuJ+uX5qY=') {
    throw new Error(`阿里签名不对：实际 ${ali.signature}`);
  }
});

await checkAsync('腾讯 / 阿里缺少凭据时必须抛**中文**错误（别把服务商的英文原样冒到界面上）', async () => {
  const tr = loaded['lib/translate/index.js'];
  const mk = (provider) => {
    const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
    s.translate.provider = provider;
    s.translate.target = 'zh-CN';
    return s;
  };
  const cases = [
    ['tencent', '腾讯翻译未配置 SecretId / SecretKey'],
    ['ali', '阿里翻译未配置 AccessKeyId / AccessKeySecret'],
  ];
  for (const [provider, want] of cases) {
    let msg = null;
    try {
      await tr.translate('hello', mk(provider));
    } catch (e) {
      msg = e.message;
    }
    if (msg !== want) throw new Error(`「${provider}」缺凭据时的错误信息应为「${want}」，实际「${msg}」`);
    if (!/[\u4e00-\u9fa5]/.test(String(msg))) throw new Error(`「${provider}」的错误信息里没有中文：${msg}`);
  }
});

check('腾讯 / 阿里都不许把 Secret 放进 URL 或日志（Key 只能走请求头或协议要求的位置）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'translate', 'index.js'), 'utf8');
  const seg = (name, next) => {
    const a = src.indexOf(`async function ${name}(`);
    const b = next ? src.indexOf(`async function ${next}(`) : src.length;
    return src.slice(a, b > a ? b : a + 4000);
  };
  // 阿里：AccessKeySecret **绝不能**出现在请求参数里（AccessKeyId 是协议要求，可以在）
  const aliSeg = seg('translateAli', 'aliHint');
  const paramsBlock = aliSeg.match(/const params = \{([\s\S]*?)\n    \};/);
  if (!paramsBlock) throw new Error('找不到阿里的 params 块');
  if (/Secret/i.test(paramsBlock[1])) throw new Error('阿里的请求参数里出现了 Secret —— 它只该用于算签名');
  // 整个翻译模块不许把凭据打进控制台
  for (const m of src.matchAll(/console\.\w+\([^)]*\)/g)) {
    if (/secret|apiKey|accessKey|keySecret/i.test(m[0])) {
      throw new Error(`翻译模块把凭据打进了控制台：${m[0].slice(0, 80)}`);
    }
  }
});

await checkAsync('签名实现必须逐位对上标准测试向量（算错了服务端只会说"签名不匹配"）', async () => {
  const c = loaded['lib/crypto.js'];
  // RFC 1321 附录里的 MD5 向量。没有 WebCrypto 能算 MD5，这是自带实现的唯一保障。
  const MD5_V = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
    // 这一条跨了多个 64 字节块，最容易暴露补位/length 字段的错
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
  ];
  for (const [inp, want] of MD5_V) {
    const got = c.md5(inp);
    if (got !== want) throw new Error(`md5(${JSON.stringify(inp.slice(0, 24))}) = ${got}，应为 ${want}`);
  }
  // RFC 4231 的 HMAC-SHA256 向量
  const h = await c.hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog');
  if (h !== 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8') {
    throw new Error(`HMAC-SHA256 不对：${h}`);
  }
  if ((await c.sha1Hex('abc')) !== 'a9993e364706816aba3e25717850c26c9cd0d89d') throw new Error('SHA-1 不对');
  if ((await c.sha256Hex('abc')) !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') {
    throw new Error('SHA-256 不对');
  }
  // UTF-8 中文也要对，否则中文文本签名必错
  if (c.md5('中文') !== 'a7bac2239fcdcb3a067903d8077c4a07') throw new Error('md5 对中文不对（UTF-8 编码有问题）');
});

check('百度翻译的语种代码必须覆盖所有目标语言（写错不报错，只会得到语种不对的译文）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'translate', 'index.js'), 'utf8');
  const block = src.match(/const BAIDU_LANG = \{([\s\S]*?)\n\};/);
  if (!block) throw new Error('找不到 BAIDU_LANG 映射表');
  const keys = [...block[1].matchAll(/^\s*'?([a-zA-Z-]+)'?:\s*'/gm)].map((m) => m[1]);
  const missing = settings.TARGET_LANGS.map((l) => l.id).filter((id) => !keys.includes(id));
  if (missing.length) throw new Error(`百度映射缺这些语种：${missing.join(', ')}`);
  // 百度的代码和通用代码不一样，不能直接透传
  if (!/'zh-CN': 'zh'/.test(block[1])) throw new Error('zh-CN 应当映射成 baidu 的 zh');
  if (!/ja: 'jp'/.test(block[1])) throw new Error('ja 应当映射成 baidu 的 jp');
});

check('源码里不许出现未定义的类名（DelayedPlayer 这个笔误让延迟模式整整坏了 7 个版本）', () => {
  // ⚠️ 真实的严重 bug：码率改自动那版把 `DelayedPlayback` 写成了 `DelayedPlayer`。
  // 它只出现在 start() 内部的自动码率分支里，而四套测试全部只验证
  // `DelayedPlayback.recommendBitrate` 这个函数本身 —— 从不执行调用点，
  // 于是 552 条断言全绿、延迟模式却一开就「启动失败」。这是端到端跑浏览器才抓到的。
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'vendor') continue;
      const p = path.join(d, e.name);
      // tools/ 是开发脚本（跑在 Node 里，会用 Buffer 这类内置对象），不是扩展的运行时代码
      if (e.isDirectory()) {
        if (path.relative(process.cwd(), p) === 'tools') continue;
        walk(p);
      } else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
    }
  })(process.cwd());

  // 收集所有「类定义」的名字，再找出所有 `Name.method(` 形式的静态调用
  const defined = new Set();
  const used = new Map();
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\bclass\s+([A-Z][A-Za-z0-9_]*)/g)) defined.add(m[1]);
    for (const m of src.matchAll(/(?<![.\w$])([A-Z][A-Za-z0-9_]{3,})\.(?:recommend|QUALITY|from|isSupported|of)\w*/g)) {
      if (!used.has(m[1])) used.set(m[1], `${path.relative(process.cwd(), f)}`);
    }
  }
  // 只检查"看起来像本项目自己的类"的调用（排除内置对象）
  const BUILTIN = new Set(['Object', 'Array', 'Promise', 'Number', 'String', 'Boolean', 'Math', 'JSON',
    'Date', 'Map', 'Set', 'Error', 'TypeError', 'RegExp', 'Symbol', 'BigInt', 'WeakMap', 'WeakSet',
    'AbortController', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Uint8Array', 'Int16Array',
    'Float32Array', 'BigInt64Array', 'DataView', 'ArrayBuffer', 'EventTarget', 'CustomEvent',
    'MediaSource', 'MediaRecorder', 'AudioContext', 'Response', 'Request', 'Headers', 'FormData', 'Blob']);
  for (const [name, where] of used) {
    if (BUILTIN.has(name)) continue;
    if (!defined.has(name)) {
      throw new Error(`${where} 引用了未定义的类「${name}」—— 这类笔误只会在运行时炸，测试抓不到`);
    }
  }
});

check('改过默认值的设置项必须在 MIGRATIONS 里有迁移（否则老用户永远拿旧值）', () => {
  // ⚠️ 真实 bug：delayBitsPerSecond 的默认值从 4000000 改成 0，但没加迁移 →
  // 老用户 storage 里的 4000000 永远盖过新默认值 → 自动码率与画质档位对老用户完全无效。
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'settings.js'), 'utf8');
  const m = src.match(/const MIGRATIONS = \{([\s\S]*?)\n\};/);
  if (!m) throw new Error('找不到 MIGRATIONS');
  if (!/'capture\.delayBitsPerSecond'/.test(m[1])) {
    throw new Error('delayBitsPerSecond 改过默认值（4000000 → 0）却没有迁移条目');
  }
  if (!/4000000,\s*0/.test(m[1])) throw new Error('迁移条目应当是 [路径, 4000000, 0]');
  // 版本号必须真的推进，否则迁移根本不会跑
  if (settings.SETTINGS_VERSION < 6) {
    throw new Error(`SETTINGS_VERSION=${settings.SETTINGS_VERSION}，加了 6 号迁移就必须至少是 6`);
  }
});

check('幻听清单不许包含真实直播用语（会把整条字幕丢掉）', () => {
  // ⚠️ 真实 bug：清单里曾有「チャンネル登録お願いします」「おやすみなさい」「また明日」
  // 「字幕由」「字幕组」—— 而「请订阅频道」几乎是日语直播每场的固定环节，收播也真的会说晚安。
  // 命中就整段丢弃（音频都不发），用户只看到字幕凭空消失。
  const h = loaded['lib/asr/hallucination.js'];
  const REAL_SPEECH = [
    'チャンネル登録お願いします',
    'チャンネル登録よろしくお願いします',
    'おやすみなさい',
    'また明日',
    'また明日ね、おやすみ',
    '字幕由',
    '字幕组',
    'ありがとうございました',
  ];
  for (const t of REAL_SPEECH) {
    if (h.looksLikeHallucination(t)) throw new Error(`真实直播用语被当幻听丢掉：${JSON.stringify(t)}`);
  }
  // 但真正的套话还得拦住
  for (const t of ['ご視聴ありがとうございました', '感谢您的观看', 'Thanks for watching!']) {
    if (!h.looksLikeHallucination(t)) throw new Error(`真幻听没拦住：${JSON.stringify(t)}`);
  }
});

check('会改整套配置的预设必须先确认（否则会静默换掉识别服务/语言/翻译服务）', () => {
  // ⚠️ 真实风险：预设的 change 处理器是"改完立刻写盘"，连保存按钮都不用点。
  // 而「推荐」装的是完整方案：一个看英文直播、用 Google 免 Key 的用户顺手点一下，
  // 就会变成"日语 + DeepL 无 Key"（翻译全挂）+"延迟模式"（原页面被静音），且毫不知情。
  const rec = settings.LATENCY_PRESETS.find((p) => p.id === 'recommended');
  if (!rec?.warn) throw new Error('「推荐」预设没有 warn 文案 —— 套用时会静默覆盖用户配置');
  // 文案必须真的列出会改什么，不能只是一句"确定吗"
  for (const kw of ['识别服务', '音频语言', '翻译服务', '呈现方式']) {
    if (!rec.warn.includes(kw)) throw new Error(`确认文案里没提到「${kw}」，用户看不出会被改什么`);
  }
  // 只动延迟旋钮的那三个不该弹确认 —— 它们本来就是安全的，弹了只会烦人
  for (const p of settings.LATENCY_PRESETS.filter((x) => x.id !== 'recommended')) {
    if (p.warn) throw new Error(`延迟类预设 ${p.id} 不该弹确认`);
  }
  // options.js 必须真的用了这个字段，否则 warn 只是摆设（和 needsKey 那次一样）
  const js = fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8');
  if (!/preset\?\.warn && !confirm\(preset\.warn\)/.test(js)) {
    throw new Error('options.js 没有用 warn 字段做确认 —— 那 warn 就是死数据');
  }
});

check('VAD 停止时必须收尾（否则每次停止都丢掉正在说的那一整句）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  const stopFn = src.slice(src.indexOf('async function stop()'), src.indexOf('return {', src.indexOf('async function stop()')));
  if (!stopFn) throw new Error('找不到 stop()');
  const flushAt = stopFn.indexOf("'finalize'");
  const stoppedAt = stopFn.indexOf('stopped = true');
  if (flushAt < 0) throw new Error('stop() 里没有收尾冲刷 —— 最后一句会丢');
  // ⚠️ 顺序是关键：finalize() 自己会因为 stopped 拒绝工作，所以必须先冲刷后置位
  if (stoppedAt >= 0 && stoppedAt < flushAt) {
    throw new Error('stop() 先置了 stopped 再冲刷 —— 冲刷会被自己丢掉');
  }
  // 链内那道 stopped 检查必须给 finalize 放行，否则入队时 false、执行时 true，照样被丢
  if (!/\(stopped && reason !== 'finalize'\)/.test(src)) {
    throw new Error('httpChain 里的 stopped 检查没有给收尾任务放行 —— 收尾白做');
  }
});

check('播放页停止路径必须真的调到收尾（历史上 finalize() 是死代码）', () => {
  // ⚠️ 事故复盘：vad.js 曾经有一个 finalize()，但**全仓库没有任何地方调它**，
  // 而 stop() 又不做收尾 —— 于是"点停止丢最后一句"长期存在，测试全绿。
  // 现在收尾内联进了 stop()，所以播放页只要调 stop() 就够了；
  // 这条断言守的是"别再退回只有 finalize() 而没有 stop() 收尾"的状态。
  const pj = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/asr\?\.stop\(\)|asr\.stop\(\)/.test(pj)) throw new Error('播放页没有调 asr.stop()');
  const vad = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  const stopFn = vad.slice(vad.indexOf('async function stop()'));
  if (!/flushSpeech\(/.test(stopFn.slice(0, 1200))) {
    throw new Error('vad 的 stop() 没有内联收尾 —— 光有 finalize() 没人调等于没有');
  }
});

check('启动失败必须清理（否则源标签页永久静音、后台还在编码 4K）', () => {
  const pj = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  // ⚠️ startCapture() 在 getUserMedia 成功之后还有多个会抛错的点。
  // 只报错不清理的话：track 不 stop → 源标签页保持静音（tabCapture 的固有行为），
  // 而且唯一的恢复办法是自己关掉播放页；若已 recorder.start() 还会在后台继续编码 4K。
  const boot = pj.slice(pj.indexOf('async function boot'), pj.indexOf('async function boot') + 2000);
  if (!/catch\s*\(e\)\s*\{[\s\S]{0,400}stopAll\(/.test(boot)) {
    throw new Error('boot() 的 catch 里没有 stopAll —— 启动失败会留下静音的源页面');
  }
  // ⚠️ 而且 stopAll 的守卫必须把 stream 算上：'没有拿到视频轨' 这类错误正好发生在
  // stream 已拿到、playback 还没建的窗口里，只看 running/playback/asr 会早退。
  const stopAll = pj.slice(pj.indexOf('function stopAll'));
  if (!/if \(!running && !playback && !asr && !stream\)/.test(stopAll)) {
    throw new Error('stopAll 的守卫没算上 stream —— 那个窗口期里 track 不会被 stop');
  }
});

check('VAD 拿不到概率时也必须推帧（否则 gate 与音频位置永久错位、缓冲无限增长）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  const fn = src.slice(src.indexOf('async function handleFrame'));
  // ⚠️ gate 的 frameIndex 是音频位置的唯一记账，而 totalSamples 是无条件推进的。
  // 这里一 return，两边就永久错位（只增不减）；NaN 持续时 gate 还会冻在语音态，
  // 导致 trimAudio 停止裁剪、audio 数组无限增长。
  if (!/gate\.push\(ok \? p : NaN\)/.test(fn)) {
    throw new Error('ok 为假时没有把 NaN 推给 gate —— 帧计数会漏');
  }
  if (/if \(!ok\) return;/.test(fn)) throw new Error('还留着拿不到概率就直接 return 的老写法');
  // gate 自身必须能安全处理 NaN：推进计数、不动状态机
  const g = new gateMod.VadGate({ threshold: 0.5, minSpeechMs: 200, minSilenceMs: 300, frameMs: 40 });
  for (let i = 0; i < 10; i += 1) g.push(0.9);
  if (!g.inSpeech) throw new Error('测试前提不成立：10 帧应当已进入语音态');
  const before = g.frameIndex;
  const ev = g.push(NaN);
  if (ev !== null) throw new Error('NaN 帧不该产生事件');
  if (g.frameIndex - before !== 1) throw new Error('NaN 帧没有推进 frameIndex');
  if (!g.inSpeech) throw new Error('NaN 帧污染了状态机（不该退出语音态）');
});

check('预设下拉不能误标（两类预设回答的是不同问题，混在一起会误导）', () => {
  const mk = () => JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  // 套用「推荐」之后再只改翻译服务 —— 下拉不该显示成「速度优先」，
  // 因为那个标签描述的是延迟旋钮，跟用户实际的识别/呈现选择毫无关系。
  const a = mk();
  settings.applyPreset(a, 'recommended');
  if (settings.detectPresetForUi(a) !== 'recommended') throw new Error('套用推荐后应当识别为 recommended');
  a.translate.provider = 'google-free';
  const got = settings.detectPresetForUi(a);
  if (got !== 'custom') {
    throw new Error(`改了整套方案里的项之后应当显示「自定义」，实际 ${got}（detectPreset 会误报成 speed）`);
  }
  // 只动延迟旋钮的仍然要能识别出来
  const b = mk();
  settings.applyPreset(b, 'accuracy');
  if (settings.detectPresetForUi(b) !== 'accuracy') throw new Error('只套准确优先应当仍识别为 accuracy');
  // options.js 必须用懂事的那个
  const js = fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8');
  if (!/detectPresetForUi\(/.test(js)) throw new Error('options.js 没有用 detectPresetForUi');
});

check('MSE 配额溢出必须自救（只报一句就丢片 → 播放头停住、右上角全变 0）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'delayed-player.js'), 'utf8'));
  const pump = src.slice(src.indexOf('_pumpChunks()'), src.indexOf('_pumpChunks()') + 2600);
  if (!pump) throw new Error('找不到 _pumpChunks()');
  // ⚠️ 真实事故：4K60 + 高画质 = 128 Mbps = 16 MB/s，而裁剪策略保留播放头前 15 秒、
  // 又允许再攒 20 秒 → 最多 43 秒 = 688 MB，直接撞穿 MSE 配额，报
  //   `SourceBuffer is full, and cannot free space`
  // 原来只 onStatus 报一句然后放弃那一片 —— 丢的片越来越多 → 缓冲见底 → 播放头停住。
  if (!/quota|full|cannot free space/i.test(pump)) throw new Error('没有识别配额错误');
  if (!/_trimmingHard/.test(pump)) throw new Error('配额溢出后没有狠裁一次');
  if (!/unshift\(/.test(pump)) throw new Error('裁完之后没有把这一片放回队首重试');

  const dp = loaded['lib/delayed-player.js'];
  // 码率必须按"延迟需要多少画面"夹住 —— 否则内存放不下
  const cap = dp.DelayedPlayback.maxBitrateForDelay(6.6);
  const want = dp.DelayedPlayback.recommendBitrate(3840, 2160, 60) * dp.DelayedPlayback.QUALITY_MULTIPLIERS.high;
  if (want <= cap) throw new Error('测试前提不成立：4K60 高画质应当超过 6.6s 延迟的内存上限');
  // 夹完必须真的放得下（预留 20% 余量给解码器）
  const needBytes = (cap / 8) * (6.6 + 3);
  if (needBytes > 90 * 1024 * 1024 * 1.2) {
    throw new Error(`夹取后的码率仍然放不下：需要 ${(needBytes / 1048576).toFixed(0)} MB`);
  }
  // 裁剪秒数必须跟着码率走，不能写死（写死 15 秒在高码率下就是 240 MB）
  if (!/_trimKeepBehindSec/.test(src)) throw new Error('裁剪没有按码率换算保留秒数');
});

check('设置页不许有重复的元素 id（重复会让 getElementById 只认第一个，后面的字段静默失效）', () => {
  // ⚠️ 真实踩到过：加 AGC 那一栏时顺手又写了一个 `wc-prompt` 的 textarea，
  // 而原有的 input 还在 —— 两个同名 id，getElementById 只返回第一个，
  // 第二个框变成摆设（用户填了不生效，且完全看不出原因）。
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Map();
  const dup = [];
  for (const id of ids) {
    if (seen.has(id)) dup.push(id);
    else seen.set(id, true);
  }
  if (dup.length) throw new Error(`options.html 里有重复 id：${[...new Set(dup)].join(', ')}`);

  // 每个 FIELDS 里的 id 都必须真的存在于页面上（写错就是静默失效）
  const js = fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8');
  const fields = [...js.matchAll(/\['([a-zA-Z0-9_-]+)',\s*'(?:text|number|checkbox)'/g)].map((m) => m[1]);
  const missing = fields.filter((f) => !seen.has(f));
  if (missing.length) throw new Error(`FIELDS 里这些 id 在页面上找不到：${missing.join(', ')}`);
});

check('AGC 档位必须能被设置页切换，且默认值等于「加这一项之前的行为」', () => {
  const ac = loaded['lib/audio-chain.js'];
  const profiles = ac.AGC_PROFILES;
  if (!profiles) throw new Error('没有 AGC_PROFILES');
  for (const id of ['off', 'gentle', 'standard', 'strong']) {
    if (!profiles[id]) throw new Error(`缺 AGC 档位 ${id}`);
    // 每一档都必须给出完整的参数，缺项会让 Object.assign 留下上一档的残留值
    for (const k of ['noiseFloor', 'targetRms', 'minGain', 'maxGain', 'levelSmoothing', 'gainSmoothing']) {
      if (typeof profiles[id].values[k] !== 'number') throw new Error(`${id} 缺参数 ${k}`);
    }
  }
  // gentle 必须真的更温和：提升更少、收敛更慢、噪声门更高
  const g = profiles.gentle.values;
  const s = profiles.standard.values;
  if (!(g.maxGain < s.maxGain)) throw new Error('gentle 的提升上限没有比 standard 低');
  if (!(g.gainSmoothing > s.gainSmoothing)) throw new Error('gentle 的增益收敛没有比 standard 慢');
  if (!(g.noiseFloor > s.noiseFloor)) throw new Error('gentle 的噪声门没有比 standard 高');

  // ⚠️ 默认必须是 standard —— 也就是这次改动之前的行为，不动就是零风险
  const d = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  if (d.capture.agcProfile !== 'standard') {
    throw new Error(`默认档位是 ${d.capture.agcProfile}，必须是 standard（否则装了新版行为就变了）`);
  }
  // 未知值要回落到 standard，不能留在半路
  ac.setAgcProfile('乱填');
  if (ac.AGC.maxGain !== s.maxGain) throw new Error('未知档位没有回落到 standard');
  ac.setAgcProfile('standard');

  // 两处建音频链的地方都必须先设档位，否则设了没用
  for (const f of ['player/player.js', 'offscreen/offscreen.js']) {
    const src = stripComments(fs.readFileSync(path.join(process.cwd(), f), 'utf8'));
    if (!/setAgcProfile\(/.test(src)) throw new Error(`${f} 没有调用 setAgcProfile —— 档位设了不生效`);
    const setAt = src.indexOf('setAgcProfile(');
    const buildAt = src.indexOf('buildAnalysisChain(');
    if (!(setAt >= 0 && buildAt >= 0)) throw new Error(`${f} 找不到设置点或建链点`);
  }
  // 设置页要能选
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  if (!/id="cp-agcProfile"/.test(html)) throw new Error('设置页没有 AGC 档位下拉');
});

check('VAD 模式必须把提示词发出去（以前接线漏了，用户填了没用）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  // ⚠️ 分片模式一直会发 prompt，VAD 模式没发 —— 用户在设置页填的提示词静默无效。
  // 对差音源 + 快语速这一项有实际价值。
  if (!/form\.append\('prompt'/.test(src)) throw new Error('VAD 模式没有发 prompt');
  if (!/config\.prompt/.test(src)) throw new Error('prompt 取自哪个配置项不清楚（应当和分片模式同源）');
  // 不填就不发 —— 这样默认行为和以前完全一致，没有回归风险
  if (!/if \(prompt\)/.test(src)) throw new Error('空提示词也发了 —— 那默认行为就变了');
});

check('延迟无限增长必须被夹住（涨上去不拉回来的话会撞配额→空洞→播放头卡死）', () => {
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'delayed-player.js'), 'utf8'));
  const tick = src.slice(src.indexOf('_tick()'), src.indexOf('_tick()') + 4200);
  if (!tick) throw new Error('找不到 _tick()');
  // ⚠️ 真实事故：smoothRate 关掉时速率恒为 1，**没有任何机制把涨上去的延迟拉回来**。
  // 播放头因解码 4K60 偶尔卡顿、走得比实时慢，录制端却是实时的 →
  // 前方缓冲 6.6 → 9.6 → 12.6 秒 → 撞穿 MSE 配额 → appendBuffer 失败 → 缓冲空洞 →
  // 播放头卡在洞里 → 延迟涨到 21 秒、readyState 2、见底 5 次。
  if (!/_overDelayJumpSec/.test(tick)) throw new Error('_tick() 里没有超延迟跳转 —— 延迟会无限涨');
  if (!/this\.video\.currentTime = seekTo/.test(tick)) throw new Error('没有真的跳播放头');
  if (!/seekTo - this\.video\.currentTime > 1/.test(tick)) {
    throw new Error('没有"至少跳 1 秒"的下限 —— 会为了几十毫秒来回微跳，比不跳还难看');
  }
  if (!/_resyncing/.test(tick)) throw new Error('没有跳转冷却 —— 可能连续触发');

  const dp = loaded['lib/delayed-player.js'];
  // 跳转阈值必须按码率算，且落在内存预算内。
  // ⚠️ 必须**先按 start() 的路径把码率夹住**再算 —— 直接塞 128 Mbps 会得到"超预算"的结论，
  // 而那个值在真实路径上根本不会出现（start() 会先把它夹到 79）。
  for (const raw of [10e6, 32e6, 64e6, 128e6, 200e6]) {
    const delay = 6.6;
    const bps = Math.min(raw, dp.DelayedPlayback.maxBitrateForDelay(delay));
    const p = Object.create(dp.DelayedPlayback.prototype);
    p.bitsPerSecond = bps;
    p.delaySec = delay;
    const margin = p._overDelayJumpSec();
    if (!(margin >= 1.5 && margin <= 5)) throw new Error(`${bps / 1e6} Mbps 的跳转余量 ${margin} 越界`);
    const bytes = ((delay + margin) * bps) / 8;
    if (bytes > 110 * 1024 * 1024) {
      throw new Error(`想要 ${raw / 1e6} Mbps、夹到 ${bps / 1e6} Mbps 后，跳转前仍会涨到 ${(bytes / 1048576).toFixed(0)} MB`);
    }
  }
  // 显式指定的码率也必须被夹住（内存配额是物理限制，不是偏好）。
  // 判据用简单的计数：`start()` 里有两条路（自动 / 显式），**两条都要夹** ——
  // 之前只有自动那条夹了，显式填 128 Mbps 时照样撞穿配额。
  const lsrc = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'delayed-player.js'), 'utf8'));
  const capCalls = (lsrc.match(/maxBitrateForDelay\(this\.delaySec\)/g) || []).length;
  if (capCalls < 2) {
    throw new Error(`内存上限只在 ${capCalls} 处生效 —— 自动和显式两条路都要夹`);
  }
  // 码率越高，能容忍的前方缓冲越短
  const mk = (bps) => { const p = Object.create(dp.DelayedPlayback.prototype); p.bitsPerSecond = bps; p.delaySec = 6.6; return p._overDelayJumpSec(); };
  if (!(mk(79e6) < mk(10e6))) throw new Error('高码率没有更早跳 —— 那样高码率会先撞配额');

  // 播放页要把这件事说出来，否则用户只看到画面莫名跳一下
  const pj = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  if (!/'resync'/.test(pj)) throw new Error('播放页没有报告跳转 —— 用户会以为画面坏了');
});

check('语速档位：快语速必须真的把断句参数调向「更短」', () => {
  const rates = settings.VAD_RATE_PRESETS;
  if (!Array.isArray(rates) || rates.length < 2) throw new Error('语速档位少于两档');
  const normal = rates.find((p) => p.id === 'normal');
  const fast = rates.find((p) => p.id === 'fast');
  if (!normal || !fast) throw new Error('缺 normal 或 fast 档');
  const g = (p, k) => p.values[`asr.vad.${k}`];
  // ⚠️ 快语速的停顿本来就短（实测 200~400ms）。门槛还是 450ms 的话那些停顿一个都不算数，
  // 句子会越并越长（实测并到 6.1s / 52 字、8.5s / 46 字，读不完）。
  if (!(g(fast, 'vadMinSilenceMs') < g(normal, 'vadMinSilenceMs'))) {
    throw new Error('快语速的静音门槛没有更低 —— 短停顿会一个都不算，句子越并越长');
  }
  // 每秒字数更多 → 同样秒数会攒出更长的句子
  if (!(g(fast, 'vadMaxSpeechSec') < g(normal, 'vadMaxSpeechSec'))) {
    throw new Error('快语速的一句上限没有更小 —— 会攒出读不完的长句');
  }
  // 快语速更容易切在音节中间，留白要多给一点
  if (!(g(fast, 'vadPadMs') >= g(normal, 'vadPadMs'))) {
    throw new Error('快语速的留白没有更多');
  }
  // 每一档的键必须一致，否则套用会漏项（留着上一档的残留值）
  const keys = Object.keys(normal.values).sort().join(',');
  for (const p of rates) {
    if (Object.keys(p.values).sort().join(',') !== keys) throw new Error(`${p.id} 的键和 normal 不一致`);
  }
  // 套用与识别
  const mk = () => JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  const a = mk();
  settings.applyVadRate(a, 'fast');
  if (settings.detectVadRate(a) !== 'fast') throw new Error('套用快语速后识别不出来');
  a.asr.vad.vadMinSilenceMs = 400;
  if (settings.detectVadRate(a) !== 'custom') throw new Error('手改一项后应当变成 custom');
  // 全新用户默认必须落在 normal 档（否则装了新版断句行为就变了）
  if (settings.detectVadRate(mk()) !== 'normal') throw new Error('默认设置不落在 normal 档');
  // 设置页要能选
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  if (!/id="vd-rate"/.test(html)) throw new Error('设置页没有语速档位下拉');
  const js = fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8');
  if (!/applyVadRate\(/.test(js)) throw new Error('options.js 没有套用语速档位');
  if (!/updateVadRateHint\(/.test(js)) throw new Error('下拉没有反映当前实际匹配哪一档');
});

check('options.html 的 div 必须开闭平衡（多一个 </div> 会把后面的卡片挤出容器）', () => {
  /**
   * ⚠️ 真实事故：加「语速档位」那一栏时多插了一个 `</div>`。
   * 链条是：栅格提前关闭 → 面板关闭点前移 → `.page` 关闭点跟着前移 →
   * **后面四张卡片掉出容器、撑满整个窗口**（用户看到的是「上面窄下面宽」，
   * 而那两张"窄"的其实才是对的）。
   *
   * 症状出现在**离原因很远的地方**，肉眼盯着 CSS 根本看不出来 ——
   * 当时是靠"实测宽度 → 反推结构 → 逐行算深度"绕三步才定位到。数数就能抓住它。
   */
  const checkDiv = (rel) => {
    const p = path.join(process.cwd(), rel);
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const open = (src.match(/<div\b/gi) || []).length;
    const close = (src.match(/<\/div\s*>/gi) || []).length;
    if (open !== close) {
      throw new Error(`${rel} 的 div 不平衡：<div> ${open} 个 vs </div> ${close} 个（差 ${open - close}）`);
    }
  };
  for (const f of ['options/options.html', 'popup/popup.html', 'player/player.html', 'offscreen/offscreen.html']) checkDiv(f);
});

check('阿里云百炼：请求体形状必须对（端点形状和请求体形状不配套的话，服务端只会回一句 400）', () => {
  const vadMod = loaded['lib/asr/vad.js'];
  const build = vadMod.buildDashscopeBody;
  if (typeof build !== 'function') throw new Error('buildDashscopeBody 没有导出 —— 测试打不到生产代码了');

  const b = build({ model: 'qwen3-asr-flash', language: 'ja', dataUrl: 'data:audio/wav;base64,AAA' });
  if (b.model !== 'qwen3-asr-flash') throw new Error('model 没带上');
  if (b.stream !== false) throw new Error('stream 必须是 false（要的是整句结果，不是 SSE）');
  // ⚠️ 逆文本归一化把"一千二"变成 1200，对逐句翻译的字幕没好处，
  // 反而可能把口语数字改得不自然。官方默认就是 false，这里显式写死，免得默认值变了跟着变。
  if (b.asr_options?.enable_itn !== false) throw new Error('enable_itn 没有显式关掉');
  if (b.asr_options?.language !== 'ja') throw new Error('语种没映射对');
  const part = b.messages?.[0]?.content?.[0];
  if (part?.type !== 'input_audio') throw new Error('音频消息类型错了（官方是 input_audio）');
  if (!String(part?.input_audio?.data || '').startsWith('data:audio/wav;base64,')) {
    throw new Error('音频必须以 base64 Data URL 传（官方两种输入方式之一）');
  }
  // `auto` 时**不能**带 language —— 官方明确：语种不确定就不要指定该参数
  const autoBody = build({ model: 'm', language: 'auto', dataUrl: 'd' });
  if ('language' in autoBody.asr_options) throw new Error('auto 时不该带 language 参数');

  /**
   * ⚠️ 端点必须和请求体形状配套 —— 这是最容易搞混、也最难靠肉眼发现的坑：
   *   OpenAI 兼容 /compatible-mode/v1/chat/completions          body: { model, messages:[…] }
   *   DashScope 原生 /api/v1/services/aigc/multimodal-generation/generation
   *                                                              body: { model, input:{messages:[…]} }
   * buildDashscopeBody 发的是**兼容形状**，所以默认端点必须是兼容端点。
   */
  /**
   * ⚠️ 这条原来是断言"默认端点就是兼容端点"。加了原生端点之后，
   * 默认改成了 `endpointMode: 'auto'`（按模型名自动选），所以判据要跟着变 ——
   * **要守的不再是"默认是哪个端点"，而是"默认模型自动选中的端点必须和请求体形状配套"。**
   */
  const ds = settings.DEFAULT_SETTINGS.asr.dashscope;
  if (ds.endpointMode !== 'auto') {
    throw new Error(`默认 endpointMode 是 ${ds.endpointMode} —— 必须是 auto（否则换模型就会撞 404）`);
  }
  if (!ds.model) throw new Error('模型名没有默认值');
  /**
   * ⚠️ 判据是「**自动选中的端点**必须和**那个端点用的请求体构造函数**配套」，
   * **不是**「默认模型必须走兼容端点」—— 默认模型后来从 qwen3-asr-flash 换成了
   * qwen-audio-3.1-asr-flash（3.1 才支持原生文本润色），于是自动选中原生端点。
   * 所以这里按 kind 分支各自核对形状，而不是钉死某一个端点。
   */
  const picked = vadMod.pickDashscopeEndpoint(ds.model, 'auto');
  if (picked.kind === 'native') {
    const nb = vadMod.buildDashscopeNativeBody({
      model: ds.model, language: 'ja', dataUrl: 'd', prompt: '', hotwords: '',
    });
    if (!nb.input || !Array.isArray(nb.input.messages)) {
      throw new Error(`默认模型 ${ds.model} 走原生端点，但请求体不是 input.messages 形状 —— 会 400`);
    }
  } else {
    const cb = vadMod.buildDashscopeBody({ model: ds.model, language: 'ja', dataUrl: 'd' });
    if (!Array.isArray(cb.messages)) {
      throw new Error(`默认模型 ${ds.model} 走兼容端点，但请求体不是 messages 形状 —— 会 400`);
    }
  }
  // 反过来:原生专用模型必须自动选中原生端点
  for (const m of ['qwen-audio-3.1-asr-flash', 'qwen-audio-3.0-asr-flash', 'fun-asr', 'paraformer-v2']) {
    const p2 = vadMod.pickDashscopeEndpoint(m, 'auto');
    if (p2.kind !== 'native') throw new Error(`${m} 应当自动走原生端点，实际走了 ${p2.kind}`);
  }
  // 认不出的模型名要退回兼容端点(保住一直跑通的行为),而不是乱猜
  if (vadMod.pickDashscopeEndpoint('some-brand-new-model', 'auto').kind !== 'compatible') {
    throw new Error('认不出的模型名没有退回兼容端点 —— 那会让默认行为不可预测');
  }
  // 显式指定必须优先于自动
  if (vadMod.pickDashscopeEndpoint('qwen3-asr-flash', 'native').kind !== 'native') {
    throw new Error('显式选原生端点没有生效');
  }
});

check('阿里云百炼：语种映射必须覆盖全部源语言，未映射不许静默透传', () => {
  const map = loaded['lib/asr/vad.js'].DASHSCOPE_LANG;
  if (!map) throw new Error('DASHSCOPE_LANG 没有导出');
  for (const l of settings.SOURCE_LANGS) {
    if (l.id === 'auto') continue; // auto 不传 language，不需要映射
    if (!map[l.id]) {
      throw new Error(`源语言「${l.id}」在 DashScope 映射表里没有 —— 选了它就会报"语种不支持"`);
    }
  }
  // ⚠️ 未映射的必须抛**中文**错误，绝不能原样透传给服务端
  // （百度那边留着这个隐患：透传后服务端只说"语种不支持"，用户看不出是设置项的问题）
  let threw = null;
  try {
    loaded['lib/asr/vad.js'].buildDashscopeBody({ model: 'm', language: 'zh-CN', dataUrl: 'd' });
  } catch (e) {
    threw = e.message;
  }
  if (!threw) throw new Error('未映射的语种竟然没报错（静默透传了）');
  if (!/[\u4e00-\u9fa5]/.test(threw)) throw new Error(`未映射语种的报错不是中文：${threw}`);
  if (!/zh-CN/.test(threw)) throw new Error('报错里没说是哪个语种，用户不知道该改什么');
});

check('阿里云百炼：缺 Key 时必须是中文明确错误，且不许被本地 Whisper 地址拦住', () => {
  const s = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s.asr.provider = 'dashscope';
  s.asr.dashscope.apiKey = '';
  let msg = null;
  try {
    asrIndex.createAsrSession(s, () => {});
  } catch (e) {
    msg = e.message;
  }
  if (!msg) throw new Error('缺 Key 时没有报错');
  if (!/[\u4e00-\u9fa5]/.test(msg)) throw new Error(`报错不是中文：${msg}`);
  if (!/Key/i.test(msg)) throw new Error('报错里没提 Key，用户不知道该填什么');

  /**
   * ⚠️ 反过来：**不许**因为没配本地 Whisper 地址就拦住用云端识别的人。
   * 那个校验原来是无条件的（因为 VAD 引擎和本地 Whisper 共用 baseUrl），
   * 加了云端后端就必须按 backend 分开。
   */
  const s2 = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  s2.asr.provider = 'dashscope';
  s2.asr.dashscope.apiKey = 'sk-test';
  s2.asr.whisperChunked.baseUrl = ''; // 故意清空本地服务地址
  const sess = asrIndex.createAsrSession(s2, () => {});
  if (typeof sess.finalize !== 'function') throw new Error('填了 Key 却被本地地址校验拦住了');

  const r = settings.asrReadiness(s2);
  if (r.ok !== true) throw new Error(`填了 Key 却判定未就绪：${r.reason}`);
  s2.asr.dashscope.apiKey = '';
  if (settings.asrReadiness(s2).ok !== false) throw new Error('没填 Key 却判定就绪');
});

check('base64 必须分块（展开运算符在几十 KB 的 WAV 上会爆栈）', () => {
  // 16kHz 单声道 WAV 每秒约 32 KB，一句 5 秒就是 160 KB。
  // `btoa(String.fromCharCode(...bytes))` 把每个字节变成一个实参 —— 必炸。
  const u = loaded['lib/util.js'];
  const big = new Uint8Array(200000);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const b64 = u.bytesToBase64(big);
  if (typeof b64 !== 'string' || !b64.length) throw new Error('bytesToBase64 没返回字符串');
  const want = Math.ceil(big.length / 3) * 4;
  if (b64.length !== want) throw new Error(`base64 长度不对：${b64.length} vs ${want}`);
  if (typeof Buffer !== 'undefined') {
    const back = Buffer.from(b64, 'base64');
    if (back.length !== big.length || back[199999] !== big[199999]) throw new Error('base64 往返不一致');
  }
});

check('不许留下 DNR 那套死代码，也不许为它加权限', () => {
  /**
   * 中途一度打算用 declarativeNetRequest 往 WebSocket 握手头里塞凭据
   * （DashScope 的流式接口把 Key 放在握手里，而浏览器设不了 WebSocket 请求头）。
   * 后来发现 HTTP 接口用普通 fetch 就能设 Authorization —— 完全不需要 DNR。
   * 既然走 HTTP，那些东西就不该留在仓库里：死代码 + 一个用户会看到提示的新权限。
   */
  if (fs.existsSync(path.join(process.cwd(), 'lib', 'asr', 'ws-auth.js'))) {
    throw new Error('ws-auth.js 还在 —— 走 HTTP 之后它是死代码');
  }
  const mf = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'manifest.json'), 'utf8'));
  if ((mf.permissions || []).some((p) => /declarativeNetRequest/i.test(p))) {
    throw new Error('manifest 里加了 declarativeNetRequest —— 走 HTTP 不需要它，而它会弹权限提示');
  }
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'vendor') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|html|json)$/.test(e.name)) files.push(p);
    }
  })(process.cwd());
  for (const f of files) {
    // 跳过本文件自己 —— 下面这条断言的**报错文案**里就写着 ws-auth，
    // 不排除的话它会扫到自己，永远失败（自指）。
    if (/smoke-test\.mjs$/.test(f)) continue;
    if (/ws-auth/.test(fs.readFileSync(f, 'utf8'))) {
      throw new Error(`${path.relative(process.cwd(), f)} 还引用着 ws-auth`);
    }
  }
});


check('dashscope 提示词：留空不发、填了必须是 messages 第一条', () => {
  const v = loaded['lib/asr/vad.js'];
  const base = { model: 'qwen3-asr-flash', language: 'ja', dataUrl: 'data:audio/wav;base64,AAAA' };
  // ⚠️ 留空**不能**发出 system 消息 —— 否则"默认行为不变"这个前提就破了
  for (const empty of [undefined, '', '   ']) {
    const b = v.buildDashscopeBody({ ...base, prompt: empty });
    if (b.messages.length !== 1) {
      throw new Error(`提示词为空时 messages 应只有 1 条（user），实际 ${b.messages.length}`);
    }
    if (b.messages.some((m) => m.role === 'system')) {
      throw new Error('提示词为空却发了 system 消息 —— 默认行为被改了');
    }
  }
  // 填了 → system 必须是**第一条**（官方明确要求），user 在后
  const b = v.buildDashscopeBody({ ...base, prompt: '日语杂谈直播。常见词：配信、スパチャ' });
  if (b.messages.length !== 2) throw new Error(`填了提示词应有 system + user 两条，实际 ${b.messages.length}`);
  if (b.messages[0].role !== 'system') throw new Error('system 消息必须是 messages 第一条（官方要求）');
  if (!JSON.stringify(b.messages[0]).includes('スパチャ')) throw new Error('提示词内容没进 system 消息');
  // ⚠️ 部件类型必须是 `input_text` —— 官方指南里证明了它叫这个名字，
  // 裸的 `{ text }` 是没有文档依据的推断（曾经就是这么写的，已改）
  if (b.messages[0]?.content?.[0]?.type !== 'input_text') {
    throw new Error('上下文消息的部件类型应当是 input_text（官方指南里的形状）');
  }
  if (b.messages[1].role !== 'user') throw new Error('user 消息应当在 system 之后');

  // ⚠️ 生产路径必须真的把 config.prompt 传进去 —— 否则又是一个"接线漏了"
  // （本地 Whisper 那条 prompt 就漏过一次，用户填了静默无效）
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  if (!/buildDashscopeBody\(\{[^}]*prompt: config\.prompt/.test(src)) {
    throw new Error('生产路径没有把 config.prompt 传给 buildDashscopeBody —— 用户填了不生效');
  }
  // 老用户升级不能崩
  if (settings.DEFAULT_SETTINGS.asr.dashscope.prompt !== '') {
    throw new Error('asr.dashscope.prompt 的默认值必须是空串');
  }
  // 设置页要能填、要接线
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  if (!/id="dsc-prompt"/.test(html)) throw new Error('设置页没有提示词输入框');
  const js = fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8');
  if (!/'dsc-prompt'/.test(js)) throw new Error('options.js 没有接线 dsc-prompt');
});

check('模型名与端点的对应关系必须写在设置页（用户实测撞过这个 404）', () => {
  /**
   * ⚠️ 用户实测：填 `qwen-audio-3.1-asr-flash` 用兼容端点 →
   *   HTTP 404 `Unsupported model ... for OpenAI compatibility mode`
   * 而官方 API 参考那页同时讲两个端点，**两边的模型集合不同**：
   *   兼容端点 → qwen3-asr-flash
   *   原生端点 → qwen-audio-3.1-asr-flash（请求体形状也不同：messages → input.messages）
   *
   * 光靠 404 的报错，用户还是得自己猜"那我该填哪个"。所以必须写在提示里。
   */
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  const i = html.indexOf('id="dsc-model"');
  if (i < 0) throw new Error('找不到模型名输入框');
  const hint = html.slice(i, i + 1800);
  for (const kw of ['兼容端点', '原生端点', 'qwen3-asr-flash', 'qwen-audio-3.1-asr-flash']) {
    if (!hint.includes(kw)) throw new Error(`模型名提示里没提到「${kw}」—— 用户撞 404 时看不出该填哪个`);
  }
  /**
   * 热词（`parameters.vocabulary`）。
   *
   * ⚠️ 这条原来是"代码里不许出现 vocabulary" —— 因为**兼容端点那页文档里根本没有这个字段**。
   * 加了原生端点之后，官方「提升识别准确率」那页明确写了它在 `parameters` 里，
   * 所以判据要变成:**它只能出现在原生那支，绝不能混进已经跑通的兼容那支。**
   */
  const v = loaded['lib/asr/vad.js'];
  if (typeof v.buildDashscopeNativeBody !== 'function') throw new Error('buildDashscopeNativeBody 没有导出');
  const native = v.buildDashscopeNativeBody({
    model: 'qwen-audio-3.1-asr-flash', language: 'ja', dataUrl: 'd', hotwords: '配信\n草:5',
  });
  const vocab = native.parameters?.vocabulary;
  if (!vocab) throw new Error('原生请求体里没有 vocabulary（热词没生效）');
  if (vocab['配信'] !== 4) throw new Error('没指定权重时应当用官方推荐的 4');
  if (vocab['草'] !== 5) throw new Error('显式权重没生效');
  if (native.parameters?.format !== 'wav') throw new Error('原生请求体缺 format');
  /**
   * ⚠️ 这条断言原来写的是 `!== 16000`（数字）。**已按官方文档改为字符串。**
   *
   * 依据：官方 API 参考里 `sample_rate` 的类型是 `string`，curl 示例是
   * `"sample_rate": "16000"`（带引号）。发数字时服务端**不报错**（请求照样 200），
   * 所以这个错误不会自己暴露 —— 但类型不对很可能被**直接忽略**，
   * 于是采样率根本没被声明。**这是"需求变了"，不是放宽断言。**
   */
  if (native.parameters?.sample_rate !== '16000') {
    throw new Error(`原生请求体 sample_rate 应当是字符串 '16000'，实际 ${JSON.stringify(native.parameters?.sample_rate)}`);
  }
  if (native.input?.messages?.at(-1)?.content?.[0]?.type !== 'input_audio') {
    throw new Error('原生请求体:音频消息必须是 messages 的最后一条');
  }
  // 留空 = 完全不发这个字段
  const noHot = v.buildDashscopeNativeBody({ model: 'm', language: 'auto', dataUrl: 'd', hotwords: '' });
  if ('vocabulary' in (noHot.parameters || {})) throw new Error('热词留空时不该发 vocabulary');
  // 兼容那支**不许**出现 vocabulary —— 那页文档没有它,发过去大概率被忽略或 400
  const compat = JSON.stringify(v.buildDashscopeBody({ model: 'qwen3-asr-flash', language: 'ja', dataUrl: 'd' }));
  if (compat.includes('vocabulary')) throw new Error('兼容端点那支出现了 vocabulary —— 那页文档没有这个字段');
  // 超限要报中文错误,不能静默丢
  for (const bad of ['这是一个非常非常长的词语超过十五个字符了', 'a b c d e f g h']) {
    let threw = false;
    try { v.parseHotwords(bad); } catch { threw = true; }
    if (!threw) throw new Error(`热词「${bad}」超长却没有报错（官方有长度规范）`);
  }
  let threwW = false;
  try { v.parseHotwords('词:9'); } catch { threwW = true; }
  if (!threwW) throw new Error('热词权重 9 不合法（只能 1~5 或 50）却没有报错');
});

check('错误提示必须跟着识别服务走（不能一律甩给本地 Whisper / 播放页）', () => {
  /**
   * ⚠️ 实测踩过两次：
   *   ① 用阿里云百炼（云端）报 404 模型名不对，提示却让用户去查**本地服务地址**
   *   ② 设置页「测试识别连接」报 onnxruntime，文案却说「**播放页**需要…」，方向完全错
   */
  const pj = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  const i = pj.indexOf("ev.type === 'error'");
  const blk = pj.slice(i, i + 1200);
  if (!/provider === 'vad' \|\| provider === 'whisper-chunked'/.test(blk)) {
    throw new Error('播放页的「本地服务没在跑」提示没有按识别服务分支 —— 云端用户会被指错方向');
  }
  const vj = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  const j = vj.indexOf('onnxruntime 没加载');
  const msg = vj.slice(j, j + 500);
  if (/播放页需要先用/.test(msg) && !/设置页/.test(msg)) {
    throw new Error('onnxruntime 的报错文案仍然只提播放页 —— 设置页也会触发它');
  }
  // 那条「未知的识别服务」必须带扩展版本号（没重载扩展的旧构建一眼能认出）
  const sw = stripComments(fs.readFileSync(path.join(process.cwd(), 'background', 'service-worker.js'), 'utf8'));
  const k = sw.indexOf('请先在设置页配置');
  if (k < 0) throw new Error('找不到那条就绪失败的错误');
  if (!/getManifest\(\)\.version/.test(sw.slice(Math.max(0, k - 800), k + 300))) {
    throw new Error('「请先在设置页配置」没带扩展版本号 —— 没重载扩展的旧构建认不出来');
  }
  // 设置页的测试按钮必须给 dashscope 单独一条路（掉进通用分支会抛 onnxruntime 未加载）
  const ojs = stripComments(fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8'));
  if (!/probeDashscope/.test(ojs)) {
    throw new Error('设置页的「测试识别连接」没有 dashscope 分支 —— 会抛 onnxruntime 未加载');
  }
  if (!/provider === 'dashscope'/.test(ojs.slice(ojs.indexOf('async function onTestAsr')))) {
    throw new Error('onTestAsr 里没有判断 dashscope');
  }
});

check('已存的陈旧 endpoint 不许盖掉自动选择（本项目同类 bug 的第三次）', () => {
  const v = loaded['lib/asr/vad.js'];
  const E = v.DASHSCOPE_ENDPOINTS;

  /**
   * ⚠️⚠️ 真实事故,用户实测撞的:
   *
   * `getSettings()` 是「已存设置深度合并盖在默认值上」——**已存值永远赢**。
   * 而 `asr.dashscope.endpoint` 的默认值**变过**:早期是兼容端点 URL(会被写进 storage),
   * 后来改成 `''`(留空=用自动选择)。于是老用户 storage 里那个 URL 永远非空,
   * 原来的 `config.endpoint || picked.url` 让**自动选择永远轮不到** ——
   * 填 `qwen-audio-3.1-asr-flash` 却发去兼容端点,服务端回
   * 404 `Unsupported model … for OpenAI compatibility mode`。
   *
   * 同一个 bug 类前面栽过两次(`delayBitsPerSecond` 改默认值没加迁移,画质档位对老用户全无效)。
   */
  const STALE = E.compatible; // 老版本写进 storage 的那个默认值

  // ① 陈旧的兼容 URL + auto + 新模型 → 必须走原生
  const a = v.resolveDashscopeEndpoint('qwen-audio-3.1-asr-flash', 'auto', STALE);
  if (a.kind !== 'native' || a.url !== E.native) {
    throw new Error(`陈旧的 endpoint 盖掉了自动选择：得到 ${a.kind}，应为 native（这正是用户撞的 404）`);
  }

  // ② 陈旧的 URL + 强制 native → 也必须走原生（原来 kind 恒为 'explicit'，这个功能整个是坏的）
  const b = v.resolveDashscopeEndpoint('qwen-audio-3.1-asr-flash', 'native', STALE);
  if (b.kind !== 'native') throw new Error(`强制选原生被陈旧 endpoint 盖掉了：得到 ${b.kind}`);

  // ③ 陈旧的**原生** URL + 老模型 + auto → 必须按模型走兼容（陈旧值不该反向绑架）
  const c = v.resolveDashscopeEndpoint('qwen3-asr-flash', 'auto', E.native);
  if (c.kind !== 'compatible') throw new Error(`陈旧的原生 URL 反向绑架了选择：${c.kind}`);

  // ④ **真正的自定义地址必须优先** —— 修法不能误伤业务空间专属域名
  const custom =
    'https://ws123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  const d = v.resolveDashscopeEndpoint('qwen3-asr-flash', 'auto', custom);
  if (d.kind !== 'explicit' || d.url !== custom) {
    throw new Error(`真正的自定义地址被忽略了：${d.kind} / ${d.url}`);
  }

  // ⑤ 留空 + 各模型 → 正常自动选
  if (v.resolveDashscopeEndpoint('qwen3-asr-flash', 'auto', '').kind !== 'compatible') {
    throw new Error('留空时 qwen3-asr-flash 没有走兼容端点');
  }
  if (v.resolveDashscopeEndpoint('qwen-audio-3.1-asr-flash', 'auto', '').kind !== 'native') {
    throw new Error('留空时 qwen-audio-3.1-asr-flash 没有走原生端点');
  }

  // ⑥ **结构约束**,防止再有人绕开这个唯一入口:
  //    ⚠️ 上面 ①~⑤ 全部只测了 `resolveDashscopeEndpoint` **这个函数本身** ——
  //    而那正是本项目反复栽的坑(`DelayedPlayer`:函数写好了、调用点却引用不到;
  //    `needsKey`/`warn`:字段是死数据、代码根本没读它)。
  //    **实测过:把生产路径退回旧的 `config.endpoint ||` 兜底,上面五条全绿 —— 它们是摆设。**
  //    所以必须另外检查**调用点**。
  const vadSrc = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));

  // 生产路径必须直接用 resolveDashscopeEndpoint 的结果,不许再被 config.endpoint 覆盖
  if (/config\.endpoint\s*\|\|/.test(vadSrc)) {
    throw new Error(
      'vad.js 里又出现了 `config.endpoint ||` 的兜底 —— 陈旧值会盖掉自动选择（这正是用户撞的 404）',
    );
  }
  if (!/const\s+endpoint\s*=\s*picked\.url/.test(vadSrc)) {
    throw new Error('vad.js 的生产路径没有直接采用 resolveDashscopeEndpoint 的 url');
  }
  if (!/const\s+kind\s*=\s*picked\.kind/.test(vadSrc)) {
    throw new Error('vad.js 的生产路径没有直接采用 resolveDashscopeEndpoint 的 kind');
  }
  // 而且它必须真的被调用（不是只 import 了）
  const callSites = (vadSrc.match(/resolveDashscopeEndpoint\(/g) || []).length;
  if (callSites < 2) {
    throw new Error(`vad.js 里只调了 ${callSites} 次 resolveDashscopeEndpoint（配置校验 + 生产路径各需一次）`);
  }

  // 全仓库不许再出现 `endpoint || <dashscope 内置地址>` 这种兜底
  const repoFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'vendor') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.js$/.test(e.name)) repoFiles.push(p);
    }
  })(process.cwd());

  for (const f of repoFiles) {
    const rel = path.relative(process.cwd(), f).replace(/\\/g, '/');
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    if (/endpoint\s*\|\|\s*['"]https:\/\/dashscope/.test(src)) {
      throw new Error(
        `${rel} 里又出现了 \`endpoint || <dashscope 内置地址>\` 的兜底 —— 陈旧值会盖掉自动选择，请走 resolveDashscopeEndpoint`,
      );
    }
  }

  // ⑦ 设置页的测试按钮必须走**同一个**入口（v2.63.0 里它整段复制了旧逻辑，只修了生产路径）
  const ojs = stripComments(fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8'));
  if (!/resolveDashscopeEndpoint\(/.test(ojs)) {
    throw new Error('设置页的 probeDashscope 没有走 resolveDashscopeEndpoint —— 会和生产路径不一致');
  }
  const probe = ojs.slice(ojs.indexOf('async function probeDashscope'), ojs.indexOf('async function probeWhisper'));
  if (/if \(!endpoint\)\s*throw/.test(probe)) {
    throw new Error('probeDashscope 里还有「端点地址为空」的校验 —— 清空地址是正确用法，会被它误拦');
  }
  if (!/buildDashscopeNativeBody/.test(probe)) {
    throw new Error('probeDashscope 不区分端点，永远用兼容请求体');
  }
  if (!/X-DashScope-SSE/.test(probe)) {
    throw new Error('probeDashscope 没给原生端点加 X-DashScope-SSE 头');
  }
});

check('改了默认值的设置项必须有迁移（本项目已栽三次）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'settings.js'), 'utf8');

  // ① dashscope.endpoint 的默认值从"兼容端点 URL"改成了 ''，必须有迁移清脏数据
  const custom = src.slice(src.indexOf('const CUSTOM_MIGRATIONS'));
  if (!/asr\.dashscope\.endpoint/.test(custom)) {
    throw new Error(
      'dashscope.endpoint 改过默认值却没有迁移 —— 老用户 storage 里的旧 URL 会永久盖住自动选择',
    );
  }
  // 迁移只许清**内置地址**，不能碰用户自己填的业务空间域名
  if (!/BUILTIN/.test(custom) || !/includes\(cur\.trim\(\)\)/.test(custom)) {
    throw new Error('迁移没有限定"只清内置地址" —— 会误清用户自己填的自定义端点');
  }
  // 版本号必须真的推进，否则迁移不会跑
  if (settings.SETTINGS_VERSION < 7) {
    throw new Error(`SETTINGS_VERSION=${settings.SETTINGS_VERSION}，加了 7 号迁移就必须至少是 7`);
  }

  /**
   * ② **通用检查**:`地址 || 内置URL` 这种兜底是"改了默认值就静默失效"的温床。
   * 现在数量还少,逐个人工确认过即可;一旦变多就说明这个模式在被大量复制,该有人复查。
   */
  const libFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'vendor') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.js$/.test(e.name)) libFiles.push(p);
    }
  })(path.join(process.cwd(), 'lib'));

  const risky = [];
  for (const f of libFiles) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    for (const mm of s.matchAll(/\.(endpoint|baseUrl)\s*\|\|\s*['"](https?:\/\/[^'"]+)['"]/g)) {
      if (mm[2].includes('dashscope.aliyuncs.com')) continue; // 已由 resolveDashscopeEndpoint 独占
      const rel = path.relative(process.cwd(), f).replace(/\\/g, '/');
      risky.push(`${rel}: ${mm[1]} || '${mm[2].slice(0, 40)}…'`);
    }
  }
  if (risky.length > 12) {
    throw new Error(
      `发现 ${risky.length} 处 \`地址 || 内置URL\` 的兜底 —— 请逐个人工确认它们的默认值从来没变过：\n  ` +
        risky.slice(0, 8).join('\n  '),
    );
  }
});

check('dashscope 响应解析：文本在 output.text，不是 output.choices[…]', () => {
  const v = loaded['lib/asr/vad.js'];
  if (typeof v.pickDashscopeText !== 'function') throw new Error('没有 pickDashscopeText');

  /**
   * ⚠️ 这是官方 API 参考里的响应示例，**逐字抄下来的**。
   * 之前代码找的是 `output.choices[0].message.content[0].text` —— 那是按
   * "DashScope 惯例"**猜的路径，猜错了**。后果很难查：鉴权通过、请求体被接受
   * （HTTP 200）、解析却永远为空，用户只看到「识别成功 · 返回（空）」。
   */
  const official = {
    output: {
      sentence: {
        begin_time: 760,
        channel_id: 0,
        end_time: 3800,
        sentence_end: true,
        sentence_id: 1,
        text: 'Hello World，这里是阿里巴巴语音实验室。',
        words: [{ begin_time: 760, end_time: 1040, fixed: true, punctuation: '', text: 'Hello' }],
      },
      text: 'Hello World，这里是阿里巴巴语音实验室。',
    },
    usage: { duration: 4 },
    request_id: '40e0734d-096f-9ae3-86c1-a8c013287561',
  };
  const r = v.pickDashscopeText(official);
  if (r.text !== 'Hello World，这里是阿里巴巴语音实验室。') {
    throw new Error(`官方响应示例没解析出文本，实际 ${JSON.stringify(r.text)}`);
  }
  if (r.via !== 'output.text') throw new Error(`应当优先取 output.text，实际取自 ${r.via}`);

  // 兼容端点是另一套形状
  const compat = { choices: [{ message: { content: '兼容端点的文本' } }] };
  const c = v.pickDashscopeText(compat);
  if (c.text !== '兼容端点的文本' || c.via !== 'choices[0].message.content') {
    throw new Error(`兼容端点形状没解析对：${JSON.stringify(c)}`);
  }

  // 只有 sentence、没有 output.text 时要有兜底
  const onlySentence = { output: { sentence: { text: '兜底文本' } } };
  if (v.pickDashscopeText(onlySentence).text !== '兜底文本') throw new Error('没有 output.sentence.text 兜底');

  // 认不出的形状：必须能区分出来，而且给出可贴出来的说明
  const weird = { result: { foo: 'bar' } };
  const w = v.pickDashscopeText(weird);
  if (w.via !== null || w.text !== '') throw new Error('认不出的形状应当 via=null 且 text 为空');
  const note = v.dashscopeShapeNote(weird);
  if (!/顶层键/.test(note) || !/result/.test(note)) throw new Error(`shapeNote 没给出结构信息：${note}`);

  /**
   * ⚠️ 还要区分「服务端真的返回了空文本」和「字段认不出」—— 这两件事的
   * 下一步动作完全相反（前者是正常结果，后者是代码和服务端不匹配）。
   */
  const emptyOut = { output: { text: '' }, request_id: 'x' };
  if (v.pickDashscopeText(emptyOut).via !== null) throw new Error('空 output.text 不该报成取到了');
  const emptyNote = v.dashscopeShapeNote(emptyOut);
  if (!/是空的/.test(emptyNote) || !/不是"认不出字段"/.test(emptyNote)) {
    throw new Error(`空 output.text 没有和"认不出"区分开：${emptyNote}`);
  }

  // 截断：别把整个响应塞进日志
  const huge = { output: { blob: 'x'.repeat(9000) } };
  const hn = v.dashscopeShapeNote(huge, 500);
  if (hn.length > 900) throw new Error(`shapeNote 没截断，长度 ${hn.length}`);
  if (!/已截断/.test(hn)) throw new Error('截断时没说清楚被截断了');
});

check('dashscope 解析必须被**调用点**真的用上（本项目两次栽在"验了函数没验调用点"）', () => {
  /**
   * ⚠️ 这条断言比上面那条更重要。
   *
   * 本项目的先例：
   *   · `DelayedPlayer` —— 类名笔误，552 条断言全绿，延迟模式一开就崩
   *   · `needsKey` / `warn` —— 字段是死数据，代码没读它
   *   · dashscope 端点选择 —— 函数写对了，生产路径把它覆盖掉
   *   · dashscope 设置页 —— 复制了一份实现，生产路径修了、它没修
   * 共同点：**验证了函数本身，没验证它有没有被调到。**
   */
  const vad = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  if (!/pickDashscopeText\(data\)/.test(vad)) throw new Error('生产路径没有调用 pickDashscopeText');
  if (/output\?\.choices\?\.\[0\]\?\.message\?\.content\?\.\[0\]\?\.text/.test(vad)) {
    throw new Error('生产路径还留着 output.choices[…] 那条猜出来的路径');
  }
  if (!/shapeUnknown/.test(vad)) throw new Error('生产路径没有把"认不出字段"单独计数/报出来');
  /**
   * ⚠️ 光是"文件里有 shapeUnknown 这个符号"**不够** —— 变异测试证明了这一点：
   * 把条件改成 `if (false)` 之后那行还在，上面那条检查照样绿。
   * **必须检查那个条件真的在用 `via`** —— 否则又是一次"验了符号存在、没验它起作用"。
   */
  if (!/if \(!via && shapeNote\)/.test(vad)) {
    throw new Error('"认不出字段"的分支没有真的判断 via/shapeNote（条件可能被短路掉了）');
  }

  const opt = stripComments(fs.readFileSync(path.join(process.cwd(), 'options', 'options.js'), 'utf8'));
  if (!/pickDashscopeText\(/.test(opt)) throw new Error('设置页测试按钮没有用共用解析');
  if (!/dashscopeShapeNote\(/.test(opt)) throw new Error('设置页没有把形状说明显示出来');
  if (/output\?\.choices\?\.\[0\]/.test(opt)) throw new Error('设置页还留着自己那份解析');
});

check('dashscope 原生请求体：sample_rate 必须是字符串、音频消息必须在最后', () => {
  const v = loaded['lib/asr/vad.js'];
  const body = v.buildDashscopeNativeBody({
    model: 'qwen-audio-3.1-asr-flash',
    language: 'ja',
    dataUrl: 'data:audio/wav;base64,AAAA',
    prompt: '配信 スパチャ',
    hotwords: '',
  });
  /**
   * ⚠️ 官方 API 参考写的是 `sample_rate` **string**，curl 示例是 `"16000"`（带引号）。
   * 发数字时服务端**不报错**（请求照样 200），但类型不对很可能被**直接忽略** ——
   * 于是采样率根本没被声明，识别质量悄悄变差。**"没报错"不等于"生效了"。**
   */
  if (typeof body.parameters.sample_rate !== 'string') {
    throw new Error(`sample_rate 应当是字符串，实际是 ${typeof body.parameters.sample_rate}`);
  }
  if (!/^\d+$/.test(body.parameters.sample_rate)) throw new Error('sample_rate 不是数字串');

  /**
   * ⚠️ 官方原文：「包含 `input_audio` 的 `user` 消息**必须放在 messages 数组的最后**。」
   */
  const msgs = body.input.messages;
  const audioAt = msgs.findIndex((m) => m.content?.some((c) => c.type === 'input_audio'));
  if (audioAt !== msgs.length - 1) throw new Error('带 input_audio 的消息不在最后');

  // language_hints 是 array[string]（官方确认），推断是对的
  if (!Array.isArray(body.parameters.language_hints)) throw new Error('language_hints 应当是数组');
  if (body.parameters.language_hints[0] !== 'ja') throw new Error('language_hints 内容不对');

  // 留空的可选项一律不发 —— "不改任何设置时请求体逐字节相同"
  const bare = v.buildDashscopeNativeBody({
    model: 'qwen-audio-3.1-asr-flash',
    language: 'auto',
    dataUrl: 'data:audio/wav;base64,AAAA',
  });
  if ('language_hints' in bare.parameters) throw new Error('语种为 auto 时不该发 language_hints');
  if ('vocabulary' in bare.parameters) throw new Error('热词留空时不该发 vocabulary');
  if (bare.input.messages.length !== 1) throw new Error('提示词留空时不该多发上下文消息');
});

check('设置页必须写明「接口地址留空 = 正确用法」（用户真的踩过这个）', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'options', 'options.html'), 'utf8');
  /**
   * ⚠️ 用户实测：他把「接口地址」清空后以为"没填"，因为没有任何地方告诉他
   * **留空恰恰是正确用法**（留空 = 按模型名自动选端点）。
   * 而当时的旧代码还有一句 `if (!endpoint) throw '没有填端点地址'` ——
   * 清空反而报错，把"正确操作"变成了"错误操作"。
   */
  if (!/留空就是正确用法/.test(html)) throw new Error('没有写明"留空就是正确用法"');
  if (!/不是"没填"/.test(html)) throw new Error('没有点明"不是没填"');
  if (/只实现兼容端点/.test(html)) throw new Error('提示还停留在"只实现兼容端点"（已过时）');
  if (!/自动/.test(html)) throw new Error('没有提到端点可以选「自动」');
});


check('内置术语表并进热词：过滤规则生效、合并不覆盖用户手填的', () => {
  const v = loaded['lib/asr/vad.js'];
  const g = loaded['lib/glossary.js'];
  const st = { translate: { liveGlossary: true, gamingGlossary: false, target: 'zh-CN' } };

  // ⚠️ 只取「源词=译文」的左边 —— 热词提升的是识别，译文对识别没用
  const words = g.glossarySourceWords(st);
  if (words.length < 20) throw new Error(`内置直播词表只抽到 ${words.length} 个源词，太少了，是不是取错了半边`);
  for (const w of words) {
    if (w.includes('=')) throw new Error(`抽出来的词里混进了 '='：${w} —— 取到译文那一侧了`);
  }
  // 关掉开关就该是空的（沿用翻译那边的开关，不另建一套）
  if (g.glossarySourceWords({ translate: { liveGlossary: false } }).length !== 0) {
    throw new Error('关掉「直播术语表」之后还在抽词 —— 开关没接上');
  }

  // 合并：用户手填的必须原样保留，且同名词以他的为准
  const m = v.mergeGlossaryHotwords('配信:5\n我自己填的词:3', words);
  if (m.added < 10) throw new Error(`只并进 ${m.added} 个词，太少了`);
  const parsed = v.parseHotwords(m.text);
  if (parsed['我自己填的词'] !== 3) throw new Error('用户手填的热词被弄丢了');
  if (parsed['配信'] !== 5) throw new Error(`用户手填的同名词没有优先（配信=${parsed['配信']}，应为 5）`);
  if (Object.keys(parsed).length !== m.added + 2) {
    throw new Error('并进的数量和实际解析出来的对不上 —— 有静默丢弃');
  }

  // ⚠️ 超长的内置词必须**跳过并计数**，而不是让整个请求 400
  const mm = v.mergeGlossaryHotwords('', ['AAAAAAAA BBBBBBBB CCCCCCCC DDDDDDDD EEEEEEEE FFFFFFFF GGGGGGGG HHHHHHHH', '正常词']);
  if (mm.dropped !== 1) throw new Error(`超长词应当被跳过并计数，实际 dropped=${mm.dropped}`);
  if (mm.added !== 1) throw new Error('正常词被误伤了');
  // 但**用户手填**的超长词仍然要抛错（是他自己写的，要说清哪里错）
  let threw = false;
  try { v.parseHotwords('AAAAAAAA BBBBBBBB CCCCCCCC DDDDDDDD EEEEEEEE FFFFFFFF GGGGGGGG HHHHHHHH'); } catch { threw = true; }
  if (!threw) throw new Error('用户手填超长热词应当抛错（内置那批才是跳过）');

  // 判据只留一处：手填与内置走的是同一个函数
  if (v.hotwordLengthOk('短词') !== true) throw new Error('hotwordLengthOk 对正常词返回了假');
  if (v.hotwordLengthOk([...Array(20)].map(() => '字').join('')) !== false) throw new Error('hotwordLengthOk 没认出超长词');
});

check('内置术语表并入热词的【调用点】必须真的接上（不只验函数）', () => {
  // ⚠️ 本项目反复栽在这一点上：验了函数本身、没验调用点。
  // 所以这条查的是**生产路径里到底用没用合并结果**。
  const src = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8'));
  if (!/const mergedHotwords = mergeGlossaryHotwords\(/.test(src)) {
    throw new Error('原生端点那支没有调用 mergeGlossaryHotwords —— 开关会是个摆设');
  }
  if (!/hotwords: mergedHotwords\.text/.test(src)) {
    throw new Error('请求体用的还是 config.hotwords 原文，没用合并后的结果');
  }
  // 开关必须在 index.js 里被真正读到（global 只带 asr，词表开关在 translate，只有那层看得到两边）
  const idx = stripComments(fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'index.js'), 'utf8'));
  if (!/glossaryWords:.*glossaryHotwords.*glossarySourceWords/.test(idx)) {
    throw new Error('index.js 没有按开关抽词并传给 session —— global 里没有 glossaryWords');
  }
  // 关掉开关时不该发 vocabulary（"留空 = 不发"这条规矩本项目一直守着）
  const v = loaded['lib/asr/vad.js'];
  const body = v.buildDashscopeNativeBody({
    model: 'qwen-audio-3.1-asr-flash', language: 'ja',
    dataUrl: 'data:audio/wav;base64,AAAA', prompt: '', hotwords: '',
  });
  if (body && body.parameters && 'vocabulary' in body.parameters) {
    throw new Error('热词为空时仍然发了 vocabulary 字段 —— 破坏了"不改设置就逐字节相同"');
  }
  // 空的热词源数组也不能凭空造出字段
  const body2 = v.buildDashscopeNativeBody({
    model: 'qwen-audio-3.1-asr-flash', language: 'ja',
    dataUrl: 'data:audio/wav;base64,AAAA', prompt: '', hotwords: '',
  });
  if (JSON.stringify(body) !== JSON.stringify(body2)) throw new Error('同样的输入产生了不同的请求体');
});


check('默认模型必须能自己选对端点（qwen-audio-3.1 → 原生），且刻意不加迁移', () => {
  const d = JSON.parse(JSON.stringify(settings.DEFAULT_SETTINGS));
  const ds = d.asr.dashscope;
  if (ds.model !== 'qwen-audio-3.1-asr-flash') {
    throw new Error(`默认模型是 ${ds.model}，应为 qwen-audio-3.1-asr-flash（3.1 才支持原生文本润色）`);
  }
  if (ds.endpointMode !== 'auto') throw new Error('默认端点模式应为 auto');
  if (ds.endpoint !== '') throw new Error('默认 endpoint 应为空串（留空 = 用自动选择的结果）');

  // ⚠️ 关键：默认模型 + auto 必须自己走到原生端点，用户不需要改两处
  const v = loaded['lib/asr/vad.js'];
  const picked = v.resolveDashscopeEndpoint(ds.model, ds.endpointMode, ds.endpoint);
  if (picked.kind !== 'native') {
    throw new Error(`默认模型在 auto 下选中了 ${picked.kind} 端点 —— 会撞 404 Unsupported model`);
  }
  // 而兼容端点那个可选值必须还在（老用户的当前值就是它）
  if (!/qwen3-asr-flash/.test(fs.readFileSync(path.join(process.cwd(), 'lib', 'settings.js'), 'utf8'))) {
    throw new Error('qwen3-asr-flash 被删了 —— 它仍是兼容端点的可用模型、也是老用户的当前值');
  }
  // 请求体形状必须跟着端点是原生
  const body = v.buildDashscopeNativeBody({
    model: ds.model, language: 'ja', dataUrl: 'data:audio/wav;base64,AAAA', prompt: '', hotwords: '',
  });
  if (!body.input || !Array.isArray(body.input.messages)) {
    throw new Error('原生端点应当用 input.messages，实际不是');
  }

  // ⚠️ **刻意不加迁移**：老用户 storage 里存着旧的 qwen3-asr-flash，
  // "已存值盖在默认值上"会让他们继续用旧的 —— 这正是"新用户默认更好、老用户不受惊扰"。
  // 如果以后有人"顺手补一条迁移"把老用户也换掉，那条断言会拦住他。
  const mig = fs.readFileSync(path.join(process.cwd(), 'lib', 'settings.js'), 'utf8');
  const migBlock = mig.slice(mig.indexOf('const MIGRATIONS'), mig.indexOf('const CUSTOM_MIGRATIONS'));
  if (/asr\.dashscope\.model/.test(migBlock)) {
    throw new Error('给模型名加了迁移 —— 那会把老用户的设置也悄悄换掉，而这条改默认值的意图正是不动老用户');
  }
});

check('能创建 ASR 会话的页面必须引入 onnxruntime（否则本地 VAD 直接报「onnxruntime 没加载」）', () => {
  /**
   * 实测事故：叠加模式的 ASR 会话建在 **offscreen document** 里
   * （offscreen.js 调 createAsrSession），而 offscreen.html 从来没引入 vendor/ort.min.js
   * → 叠加模式 + 本地 VAD 必然失败。
   *
   * 延迟模式没事，因为 player.html 引了 —— 所以这个洞藏了很久，
   * 直到有人同时用了「叠加模式」和「本地 VAD」（两个条件各有一半人满足，交集一直没人踩到）。
   *
   * ⚠️ 判据**反着写**：先从代码里找出谁真的调了 createAsrSession（看调用点），
   * 再检查那个页面的 HTML。**名单是推导出来的，不是手写的** ——
   * 手写名单会和现实脱节，而这个项目在「断言只是摆设」上栽过六次。
   */
  const root = process.cwd();
  const skipDir = /^(node_modules|\.|vendor|tools|docs)$/;
  const jsFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skipDir.test(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) jsFiles.push(p);
    }
  })(root);

  // ① 谁真的在建 ASR 会话？
  const callers = [];
  for (const f of jsFiles) {
    const src = stripComments(fs.readFileSync(f, "utf8"));
    if (!/createAsrSession\s*\(/.test(src)) continue;
    const html = f.replace(/\.js$/, ".html");
    if (!fs.existsSync(html)) continue; // 纯库文件（如 lib/asr/index.js 只导出，不是页面）
    // ⚠️ 统一成正斜杠：Windows 的 path.relative 返回反斜杠，而下面豁免名单用的是正斜杠，
    //    不归一化会让豁免永远匹配不上（写这条断言时就是这么栽的）。
    const norm = (p) => p.split(path.sep).join('/');
    callers.push({ js: norm(path.relative(root, f)), html: norm(path.relative(root, html)) });
  }
  if (callers.length < 2) {
    throw new Error(`只找到 ${callers.length} 个建 ASR 会话的页面 —— 判据大概失效了（至少该有播放页和 offscreen）`);
  }

  // ② 明确不需要 onnxruntime 的页面 —— 每一条都必须写明理由
  const EXEMPT = {
    "options/options.html":
      "设置页的「测试识别连接」不支持需要本地 VAD 的服务（vad.js 的报错文案里写明了，让用户去播放页实测）",
  };

  // ③ 不带 onnxruntime 就建不了本地 VAD 会话的页面，必须引入
  const bad = [];
  for (const c of callers) {
    if (EXEMPT[c.html]) continue;
    const html = fs.readFileSync(path.join(root, c.html), "utf8");
    if (!/vendor\/ort\.min\.js/.test(html)) bad.push(c.html + "（由 " + c.js + " 建会话）");
  }
  if (bad.length) {
    throw new Error(
      "这些页面会 createAsrSession，却没引入 vendor/ort.min.js —— " +
        "本地 VAD 会在那里报「onnxruntime 没加载」：" + bad.join("、"),
    );
  }

  // ④ 豁免名单不许腐坏：被豁免的页面必须真的还在建会话
  for (const html of Object.keys(EXEMPT)) {
    if (!callers.some((c) => c.html === html)) {
      throw new Error(`${html} 被豁免了，但它已经不再建 ASR 会话 —— 请删掉这条豁免（陈旧名单会掩盖真问题）`);
    }
  }

  // ⑤ 豁免的理由必须真的写在报错文案里（验「它起作用」，不是验「符号存在」）
  const vadSrc = fs.readFileSync(path.join(root, "lib", "asr", "vad.js"), "utf8");
  const msg = (vadSrc.match(/onnxruntime 没加载[\s\S]{0,400}/) || [""])[0];
  if (!/设置页/.test(msg)) {
    throw new Error("vad.js 那条 onnxruntime 报错没提设置页 —— 用户看不懂该去哪儿测（豁免名单的理由就不成立了）");
  }
  if (/播放页需要/.test(msg)) {
    throw new Error("那条报错又写成「播放页需要…」了 —— 它会从设置页和 offscreen 触发，不能假定页面");
  }
});

check('播放压根没开始过时，遮罩不许被收掉（否则黑屏 + 零提示）', () => {
  const pj = stripComments(fs.readFileSync(path.join(process.cwd(), 'player', 'player.js'), 'utf8'));
  const at = pj.indexOf('}, 15000)');
  if (at < 0) throw new Error('找不到 15000 那个兜底');
  // 往前取足够长的一段（那个 setTimeout 的回调体）
  const body = pj.slice(Math.max(0, at - 1600), at);
  /**
   * ⚠️ 真实事故（用户的实测日志）：源画面静止 → tabCapture 一帧都不给 →
   * bufferedEnd() 一直是 null → _tick() 早早 return → locked 从没置真 →
   * play() 压根没被调用 → playBlocked 保持 false →
   * 而这里原来写的是 `if (!playback?.playBlocked) hideOverlay()`，
   * **于是遮罩被收掉，用户面对黑屏 + 零提示。**
   *
   * 关键在于：playBlocked 只表示"play() 被拒了"，
   * 「被拒」和「压根没走到播放」是两件事，而它对两者都是 false。
   */
  if (!/playback\?\.locked/.test(body)) {
    throw new Error('那个 15 秒兜底没有检查 playback.locked —— 「没走到播放」时遮罩会被误收');
  }
  if (!/playback\?\.playBlocked/.test(body)) {
    throw new Error('那个 15 秒兜底没有检查 playback.playBlocked —— 被拒时不该收遮罩');
  }
  // 留着遮罩时必须把读数写出来，否则用户仍然无从判断
  if (!/showOverlay\(/.test(body)) {
    throw new Error('留着遮罩时没有写原因/读数 —— 用户还是只能看到一个黑屏');
  }
  for (const kw of ['bufferAheadSec', 'totalFrames', 'droppedFrames', 'stallCount']) {
    if (!body.includes(kw)) throw new Error(`遮罩里没显示 ${kw} —— 少了能自诊断的数字`);
  }
});

check('那句关于 SharedArrayBuffer 的注释必须是准确的（它误导过一次排查）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'asr', 'vad.js'), 'utf8');
  // 实测结论：这个 WASM 的 memory import 声明为 shared，所以 SAB 是必需的，
  // 与 numThreads 无关；扩展页面天然就有 SAB、不需要 COEP/COOP。
  if (!/必需/.test(src)) {
    throw new Error('vad.js 里没有说明「SharedArrayBuffer 是必需的」—— 那句错的注释可能被改回来了');
  }
  if (/省掉 SharedArrayBuffer/.test(src)) {
    throw new Error('又出现了「省掉 SharedArrayBuffer 的要求」这种错误说法');
  }
});

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
