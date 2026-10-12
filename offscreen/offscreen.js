// livedtranslate 音频引擎（offscreen document）
//
// 职责：
//   1. 接收 service worker 下发的 tabCapture streamId，取出标签页音频
//   2. 把音频回放到扬声器（否则捕获后用户就听不见了）+ 可选的"静音原声"
//   3. 通过 AudioWorklet 取 PCM，重采样到 ASR 需要的采样率，喂给 ASR 会话
//   4. 把 ASR 的 partial / final 结果做翻译编排，再推给页面里的字幕层
//
// 之所以把 WebSocket 和翻译都放在这里而不是 service worker：MV3 的 SW 会被回收，
// offscreen 文档只要还开着就持续存活，长连接与定时任务放这里才稳。

import { createAsrSession } from '../lib/asr/index.js';
import { translate, isTranslateEnabled } from '../lib/translate/index.js';
import { Resampler, float32ToInt16, rms } from '../lib/util.js';
import { buildAnalysisChain, AgcController, setAgcProfile } from '../lib/audio-chain.js';

const ENGINE_RATE = 48000; // 固定采集率，与 16k / 24k 都成整数比
/**
 * 每个 PCM 块攒多少帧再交给主线程。2048 帧 @48k = 43ms 的固有延迟；
 * 降到 1024 只剩 21ms，代价只是每秒多一倍的消息量（约 47 条/秒），很划算。
 */
const WORKLET_BLOCK = 1024;
const LEVEL_INTERVAL_MS = 250;
const CACHE_LIMIT = 400;
/** 用于给翻译提供上下文的最近定稿句数上限 */
const CONTEXT_MAX_CHARS = 600;

let rt = null; // 当前运行态

// —— 字幕片段状态 ——
let liveSeg = null;
let segSeq = 0;
const translationCache = new Map();
let interimTimer = null;
let interimPending = null;
let interimLastAt = 0;
let lastLevelPost = 0;
let lastHistoryPush = { text: '', at: 0 };
let firstAudioAt = 0;
/** 最近的定稿原文，按时间顺序，用于给翻译提供上下文 */
let recentFinals = [];
const agc = new AgcController();
let lagEma = null;
let translateEma = null;
/** 强制断句定时器：说话人长时间不停顿时的兜底 */
let forceFinalTimer = null;
/** 发了 Finalize 之后等服务端回执的宽限期 */
let forceFinalGrace = null;
/** 在飞的中间结果翻译 / 定稿翻译，用于背压与取消 */
let interimController = null;
let finalController = null;
/** 服务端 Finalize 的回执宽限期（ms） */
const FINALIZE_GRACE_MS = 700;

const HANDLED = new Set([
  'LIVEDUB_OFFSCREEN_START',
  'LIVEDUB_OFFSCREEN_STOP',
  'LIVEDUB_SET_MUTE',
  'LIVEDUB_APPLY_SETTINGS',
]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg?.type;
  if (!HANDLED.has(type)) return false;
  (async () => {
    try {
      if (type === 'LIVEDUB_OFFSCREEN_START') {
        await startEngine(msg);
        sendResponse({ ok: true, sampleRate: rt?.asr?.sampleRate ?? null });
      } else if (type === 'LIVEDUB_OFFSCREEN_STOP') {
        await stopEngine();
        sendResponse({ ok: true });
      } else if (type === 'LIVEDUB_SET_MUTE') {
        setMute(!!msg.muted);
        sendResponse({ ok: true });
      } else if (type === 'LIVEDUB_APPLY_SETTINGS') {
        applySettings(msg.settings);
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true;
});

// ═══════════════════════════ 引擎生命周期 ═══════════════════════════

async function startEngine({ streamId, tabId, settings }) {
  await stopEngine();
  if (!streamId) throw new Error('缺少标签页音频流 ID');
  if (!settings) throw new Error('缺少配置');

  rt = {
    tabId,
    settings,
    stream: null,
    ctx: null,
    source: null,
    playbackGain: null,
    worklet: null,
    silentSink: null,
    analysis: null,
    asr: null,
    resampler: null,
    stats: { segments: 0, startedAt: Date.now(), level: 0 },
  };
  firstAudioAt = 0;
  recentFinals = [];
  agc.reset();
  lagEma = null;
  translateEma = null;
  clearForceFinal();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (e) {
    rt = null;
    throw new Error(
      `无法获取标签页音频：${e?.message || e}。若标签页正在播放受保护内容（DRM）或页面已被关闭，则无法捕获。`,
    );
  }
  if (!rt) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('启动已取消');
  }
  rt.stream = stream;

  const track = stream.getAudioTracks()[0];
  if (!track) {
    await stopEngine();
    throw new Error('该标签页没有可捕获的音轨（可能当前没有声音输出）。');
  }
  track.onended = () => postSw({ type: 'LIVEDUB_STREAM_ENDED' });

  // —— 音频图 ——
  const ctx = new AudioContext({ sampleRate: ENGINE_RATE, latencyHint: 'interactive' });
  rt.ctx = ctx;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
  }

  const source = ctx.createMediaStreamSource(stream);
  rt.source = source;

  // 回放链路：捕获标签页后浏览器不再直接外放，必须自己接回去
  const playbackGain = ctx.createGain();
  playbackGain.gain.value = settings.audio?.muteOriginal ? 0 : 1;
  rt.playbackGain = playbackGain;
  source.connect(playbackGain);
  playbackGain.connect(ctx.destination);

  await ctx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/pcm-worklet.js'));
  const worklet = new AudioWorkletNode(ctx, 'livedub-pcm', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    // 标签页音频通常是立体声；显式下混成单声道再送去识别，避免只取到左声道
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { blockSize: WORKLET_BLOCK },
  });
  rt.worklet = worklet;

  // —— ASR ——（先建会话，才知道要用哪个采样率去做抗混叠）
  const asr = createAsrSession(settings, handleAsrEvent);
  rt.asr = asr;
  rt.resampler = new Resampler(ctx.sampleRate, asr.sampleRate);

  // worklet 的输出是静音，接一个 0 增益到 destination，保证它被音频线程持续拉动
  const silentSink = ctx.createGain();
  silentSink.gain.value = 0;
  rt.silentSink = silentSink;

  // 分析支路前端（高通 + 8 阶抗混叠 + AGC + 限幅）。
  // 只挂在 source → worklet 上；回放支路 source → playbackGain → destination 完全不经过它，
  // 用户听到的原声不受任何影响。
  setAgcProfile(settings.capture?.agcProfile);
  const analysis = buildAnalysisChain(ctx, source, asr.sampleRate);
  rt.analysis = analysis;
  analysis.output.connect(worklet);
  worklet.connect(silentSink);
  silentSink.connect(ctx.destination);

  worklet.port.onmessage = (ev) => {
    if (!rt || rt.asr !== asr) return;
    const frame = new Float32Array(ev.data);
    const frameRms = rms(float32ToInt16(frame));
    maybeReportLevel(frameRms);
    maybeAdjustAgc(frameRms);
    const resampled = rt.resampler.process(frame);
    if (resampled.length) {
      if (!firstAudioAt) firstAudioAt = Date.now();
      asr.push(float32ToInt16(resampled));
    }
  };

  await asr.start();

  postSw({
    type: 'LIVEDUB_ASR_STATUS',
    status: 'engine-ready',
    detail: `${asr.sampleRate / 1000}kHz · ${asr.streaming ? '流式' : '分片'}`,
  });
}

async function stopEngine() {
  const cur = rt;
  rt = null;
  if (interimTimer) clearTimeout(interimTimer);
  interimTimer = null;
  interimPending = null;
  interimLastAt = 0;
  liveSeg = null;
  translationCache.clear();
  recentFinals = [];
  firstAudioAt = 0;
  lagEma = null;
  translateEma = null;
  clearForceFinal();
  // 停掉在飞的翻译请求，别让它们拖住 offscreen 关闭
  abortInterimTranslation();
  if (finalController) {
    try {
      finalController.abort();
    } catch {
      /* ignore */
    }
    finalController = null;
  }
  agc.reset();
  if (!cur) return;
  try {
    await cur.asr?.stop();
  } catch {
    /* ignore */
  }
  try {
    cur.worklet?.port.close();
  } catch {
    /* ignore */
  }
  const nodes = [
    cur.worklet,
    cur.silentSink,
    cur.playbackGain,
    cur.source,
    ...(cur.analysis?.stages || []),
  ];
  for (const node of nodes) {
    try {
      node?.disconnect();
    } catch {
      /* ignore */
    }
  }
  try {
    cur.stream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  try {
    await cur.ctx?.close();
  } catch {
    /* ignore */
  }
}

function setMute(muted) {
  if (!rt?.playbackGain) return;
  rt.settings.audio.muteOriginal = muted;
  const now = rt.ctx?.currentTime ?? 0;
  try {
    rt.playbackGain.gain.cancelScheduledValues(now);
    rt.playbackGain.gain.setTargetAtTime(muted ? 0 : 1, now, 0.02);
  } catch {
    rt.playbackGain.gain.value = muted ? 0 : 1;
  }
}

function applySettings(settings) {
  if (!rt) return;
  const prevMax = Number(rt.settings?.asr?.maxSegmentMs) || 0;
  rt.settings = settings;
  setMute(!!settings.audio?.muteOriginal);
  pushUi(settings.ui);

  const nextMax = Number(settings.asr?.maxSegmentMs) || 0;
  if (nextMax <= 0) {
    // 用户把上限关掉时，已经排上的那一次也要取消，否则"关了还会断一次"
    clearForceFinal();
  } else if (nextMax !== prevMax && !forceFinalTimer && !forceFinalGrace && liveSeg?.state === 'partial' && liveSeg.original) {
    // 用户把上限打开/改小，当前这段也该受约束。
    // 只在数值真的变了的时候才重排，否则调个字号都会把截止时间往后推。
    armForceFinal();
  }
}

// ═══════════════════════════ ASR 事件 → 字幕 ═══════════════════════════

function handleAsrEvent(ev) {
  if (!rt) return;
  switch (ev.type) {
    case 'partial':
      // 官方建议：算转写延迟只用中间结果。定稿额外包含"说话结束检测"的等待，
      // 混进来会把这个数字算大，也就失去了定位价值。
      noteAsrLatency(ev);
      onPartial(ev.text);
      break;
    case 'final':
      // 分片模式没有中间结果，只能用定稿来估
      if (rt?.asr?.streaming === false) noteAsrLatency(ev);
      onFinal(ev.text);
      break;
    case 'utteranceEnd':
      onUtteranceEnd(ev.text);
      break;
    case 'speechStart':
      break;
    case 'silence':
      break;
    case 'status':
      if (ev.status === 'connected') {
        postSw({ type: 'LIVEDUB_ASR_STATUS', status: 'connected', detail: ev.detail });
      } else if (ev.status === 'closed') {
        postSw({ type: 'LIVEDUB_ASR_STATUS', status: 'closed', detail: ev.detail });
      }
      break;
    case 'error':
      postSw({ type: 'LIVEDUB_CAPTURE_ERROR', message: ev.message || '语音识别出错' });
      break;
    default:
      break;
  }
}

function onPartial(text) {
  const t = String(text || '').trim();
  if (!t || !rt) return;
  if (liveSeg && liveSeg.state === 'partial' && liveSeg.original === t) return;

  if (!liveSeg || liveSeg.state === 'final') {
    liveSeg = { id: `s${++segSeq}`, original: t, translation: '', translationSource: '', state: 'partial', done: false };
    armForceFinal();
  } else {
    dropStaleTranslation(liveSeg, t);
    liveSeg.original = t;
  }
  emitSegment(liveSeg);
  scheduleInterimTranslation(liveSeg);
}

/**
 * 说话人长时间不停顿时，识别服务可能迟迟不给 is_final：
 * 字幕会无限长，而且"只翻译定稿"的模式下会一直等不到译文。
 * 这里给每段中间结果加一个存活上限，到点就催服务端立刻出一份定稿。
 */
function armForceFinal() {
  clearForceFinal();
  const ms = Number(rt?.settings?.asr?.maxSegmentMs) || 0;
  if (ms <= 0) return;
  forceFinalTimer = setTimeout(() => {
    forceFinalTimer = null;
    if (!rt) return;
    if (!(liveSeg && liveSeg.state === 'partial' && liveSeg.original)) return;
    // 优先请服务端冲刷缓冲区，拿一份"真"的定稿——比拿中间结果凑一句准确得多，
    // 而且官方明确 Finalize 是纯加速手段。服务端不保证一定回执，所以留一个短兜底。
    let asked = false;
    try {
      asked = rt.asr?.finalize?.() === true;
    } catch {
      asked = false;
    }
    if (asked) {
      forceFinalGrace = setTimeout(() => {
        forceFinalGrace = null;
        localForceFinal();
      }, FINALIZE_GRACE_MS);
    } else {
      localForceFinal();
    }
  }, ms);
}

/** 服务端没能在宽限期内给出定稿时，就用当前中间结果本地定稿 */
function localForceFinal() {
  if (!rt) return;
  if (liveSeg && liveSeg.state === 'partial' && liveSeg.original) onFinal(liveSeg.original);
}

function clearForceFinal() {
  if (forceFinalTimer) clearTimeout(forceFinalTimer);
  forceFinalTimer = null;
  if (forceFinalGrace) clearTimeout(forceFinalGrace);
  forceFinalGrace = null;
}

/**
 * 识别服务会不断修正中间结果。旧译文只有在"新原文仍然以旧译文对应的原文开头"时才有参考价值
 * （说明只是往后补词）；否则原文已经变了，继续挂着旧译文会让用户看到对不上的字幕。
 */
function dropStaleTranslation(seg, nextOriginal) {
  if (!seg.translation) return;
  if (seg.translationSource && nextOriginal.startsWith(seg.translationSource)) return;
  seg.translation = '';
  seg.translationSource = '';
}

function onFinal(text) {
  const t = String(text || '').trim();
  if (!t || !rt) return;
  if (liveSeg && liveSeg.state === 'final' && liveSeg.original === t) return; // 去重

  if (interimTimer) {
    clearTimeout(interimTimer);
    interimTimer = null;
  }
  interimPending = null;
  clearForceFinal();

  let seg;
  if (liveSeg && liveSeg.state === 'partial') {
    seg = liveSeg;
    dropStaleTranslation(seg, t);
    seg.original = t;
  } else {
    seg = { id: `s${++segSeq}`, original: t, translation: '', translationSource: '', state: 'partial', done: false };
  }
  seg.state = 'final';
  liveSeg = seg;
  rt.stats.segments += 1;
  rememberContext(t);

  emitSegment(seg);
  pushHistory(seg);

  void finishTranslation(seg, t);
}

/**
 * 把定稿原文攒成翻译上下文。
 * 逐句独立翻译时，代词指代、省略主语、术语一致性都会丢；把前几句一起给翻译服务，
 * 就能显著改善连贯性——这是同传质量和普通逐句翻译最大的差别之一。
 */
function rememberContext(text) {
  const t = String(text || '').trim();
  if (!t) return;
  recentFinals.push(t);
  let total = recentFinals.join(' ').length;
  while (recentFinals.length > 0 && total > CONTEXT_MAX_CHARS) {
    total -= recentFinals.shift().length + 1;
  }
}

/** 当前片段之前的那几句（不含自己） */
function contextFor(text) {
  const n = Math.max(0, Math.min(5, Number(rt?.settings?.translate?.contextSegments ?? 2)));
  if (!n) return '';
  const pool = recentFinals.filter((s) => s !== text);
  return pool.slice(-n).join(' ');
}

function onUtteranceEnd(text) {
  if (!rt) return;
  if (liveSeg && liveSeg.state === 'partial' && liveSeg.original) {
    onFinal(text && String(text).trim() ? String(text).trim() : liveSeg.original);
  }
}

// ═══════════════════════════ 翻译编排 ═══════════════════════════

function scheduleInterimTranslation(seg) {
  const settings = rt?.settings;
  if (!settings || !isTranslateEnabled(settings) || !settings.translate.translateInterim) return;
  // 太短的中间结果（"Hello"、"the"）翻译出来没有意义，纯属浪费请求；等它长起来再说。
  // 定稿路径不受这个限制，所以短句最后一定会被翻译。
  const minChars = Math.max(0, Number(settings.translate.interimMinChars) || 0);
  if (seg.original.length < minChars) return;

  // 只保留最新待办：更早的中间文本已经被识别结果推翻了，没必要发
  interimPending = { id: seg.id, text: seg.original };
  pumpInterim();
}

/**
 * 中间结果翻译的背压阀。
 *
 * 之前是「到点就发一条」，请求一慢就不停堆积。每条请求都要占一条到同一域名的连接，
 * 浏览器对单域名只有 6 条并发（HTTP/1.1），很快堆满——**结果就是用户最在意的
 * "整句识别完之后的那次翻译"被排在一堆已经过时的中间结果请求后面**，
 * 表现出来就是"识别很快，但整句的翻译迟迟不来"。
 *
 * 现在同一时刻只允许一个中间结果翻译在飞；期间新来的文本只覆盖待办，
 * 等前一个结束再用最新文本发。定稿翻译会直接掐掉在飞的中间结果，优先拿连接。
 */
function pumpInterim() {
  if (!rt || interimController || interimTimer || !interimPending) return;
  const interval = Math.max(200, Number(rt.settings.translate.interimIntervalMs) || 400);
  const wait = interval - (Date.now() - interimLastAt);
  if (wait <= 0) {
    void runInterimTranslation();
  } else {
    interimTimer = setTimeout(() => {
      interimTimer = null;
      pumpInterim();
    }, wait);
  }
}

/** 定稿优先：掐掉还在飞的中间结果翻译，把连接让给定稿 */
function abortInterimTranslation() {
  const controller = interimController;
  interimController = null;
  interimPending = null;
  if (interimTimer) {
    clearTimeout(interimTimer);
    interimTimer = null;
  }
  if (controller) {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  }
}

async function runInterimTranslation() {
  const job = interimPending;
  interimPending = null;
  interimLastAt = Date.now();
  if (!job || !rt) return;

  const settings = rt.settings;
  const key = cacheKey(job.text);
  let out = translationCache.get(key);

  if (out === undefined) {
    const controller = new AbortController();
    interimController = controller;
    try {
      out = await translateTimed(job.text, settings, { signal: controller.signal });
    } catch (e) {
      // 被定稿顶掉属于正常流程，不报错
      if (!isAbortError(e)) postSw({ type: 'LIVEDUB_TRANSLATE_ERROR', message: e?.message || String(e) });
      return;
    } finally {
      // 身份比对：被顶掉时不能把新请求的 controller 清掉
      if (interimController === controller) interimController = null;
      pumpInterim();
    }
    remember(key, out);
  }

  if (!rt) return;
  if (!liveSeg || liveSeg.id !== job.id || liveSeg.state !== 'partial' || liveSeg.original !== job.text) return;
  if (!out) return;
  liveSeg.translation = out;
  liveSeg.translationSource = job.text;
  emitSegment(liveSeg);
}

async function finishTranslation(seg, text) {
  const settings = rt?.settings;
  if (!settings || !isTranslateEnabled(settings)) {
    if (liveSeg === seg) {
      seg.done = true;
      emitSegment(seg);
    }
    return;
  }

  // 定稿是这个扩展最重要的输出：立刻掐掉还在飞的中间结果翻译，
  // 把到翻译服务的连接让给定稿，别让它排队。
  abortInterimTranslation();

  const key = cacheKey(text);
  let out = translationCache.get(key);
  if (out === undefined) {
    const controller = new AbortController();
    finalController = controller;
    try {
      // 定稿才带上下文：中间结果只是临时预览，为它多花 token 不划算
      out = await translateTimed(text, settings, { context: contextFor(text), signal: controller.signal });
    } catch (e) {
      if (!isAbortError(e)) postSw({ type: 'LIVEDUB_TRANSLATE_ERROR', message: e?.message || String(e) });
      out = '';
    } finally {
      if (finalController === controller) finalController = null;
    }
    remember(key, out);
  }
  if (!rt || liveSeg !== seg) return;
  seg.translation = out || seg.translation || '';
  if (out) seg.translationSource = text;
  seg.done = true;
  emitSegment(seg);
  if (seg.translation) postSw({ type: 'LIVEDUB_HISTORY_UPDATE', id: seg.id, translation: seg.translation });
}

function cacheKey(text) {
  return `${rt?.settings?.translate?.target || ''}|${text}`;
}

function remember(key, value) {
  if (value === undefined) return;
  translationCache.set(key, value);
  if (translationCache.size > CACHE_LIMIT) {
    const first = translationCache.keys().next().value;
    translationCache.delete(first);
  }
}

// ═══════════════════════════ 与 SW / 页面通信 ═══════════════════════════

function emitSegment(seg) {
  if (!rt) return;
  postSw({
    type: 'LIVEDUB_EMIT',
    // 带上 tabId，SW 就不用为了转发再去读一次 storage——字幕是每秒好几次的热路径
    tabId: rt.tabId,
    payload: {
      type: 'LIVEDUB_SUBTITLE',
      segment: {
        id: seg.id,
        original: seg.original,
        translation: seg.translation,
        state: seg.state,
        done: !!seg.done,
      },
      ui: rt.settings.ui,
    },
  });
}

function pushUi(ui) {
  if (!rt) return;
  postSw({ type: 'LIVEDUB_EMIT', tabId: rt.tabId, payload: { type: 'LIVEDUB_STYLE', ui } });
}

function pushHistory(seg) {
  const now = Date.now();
  if (lastHistoryPush.text === seg.original && now - lastHistoryPush.at < 1500) return;
  lastHistoryPush = { text: seg.original, at: now };
  postSw({
    type: 'LIVEDUB_HISTORY_PUSH',
    entry: { id: seg.id, original: seg.original, at: now },
  });
}

function maybeReportLevel(level) {
  const now = Date.now();
  if (now - lastLevelPost < LEVEL_INTERVAL_MS) return;
  lastLevelPost = now;
  if (rt) rt.stats.level = level;
  postSw({ type: 'LIVEDUB_LEVEL', level });
}

/**
 * 直播/会议里说话人偏轻、或者页面音量本身很小的情况很常见，识别率会明显掉。
 * 这里按实测电平给分析支路做自动增益：只提升、不衰减，静音时冻结，
 * 所以最坏情况也不会比不开启更差。
 */
function maybeAdjustAgc(level) {
  if (!rt?.analysis) return;
  if (rt.settings.audio?.autoGain === false) return;
  const next = agc.update(level, performance.now());
  if (next === null) return;
  try {
    rt.analysis.agc.gain.setTargetAtTime(next, rt.ctx?.currentTime ?? 0, 0.25);
  } catch {
    rt.analysis.agc.gain.value = next;
  }
}

/**
 * 估算"识别结果落后于真实声音"多少毫秒：把结果覆盖到的音频时间点，
 * 和从送出第一帧音频到现在的墙钟时间做差。流式服务会给 start/duration，
 * 分片服务由会话自己算。用于在弹窗里给用户一个诚实的延迟读数。
 */
function noteAsrLatency(ev) {
  if (!firstAudioAt) return;
  const start = Number(ev?.start);
  const duration = Number(ev?.duration);
  if (!Number.isFinite(start) || !Number.isFinite(duration)) return;
  const behindSec = (Date.now() - firstAudioAt) / 1000 - (start + duration);
  if (!Number.isFinite(behindSec)) return;
  const lagMs = Math.max(0, Math.min(20000, behindSec * 1000));
  lagEma = lagEma === null ? lagMs : lagEma + (lagMs - lagEma) * 0.3;
  reportLatency();
}

/** 翻译接口的往返耗时。用户抱怨"慢"时，这个数字能直接指出瓶颈在识别还是在翻译。 */
function noteTranslateMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  translateEma = translateEma === null ? ms : translateEma + (ms - translateEma) * 0.3;
  reportLatency();
}

function reportLatency() {
  postSw({
    type: 'LIVEDUB_LATENCY',
    lagMs: lagEma === null ? null : Math.round(lagEma),
    translateMs: translateEma === null ? null : Math.round(translateEma),
  });
  postDiag(
    `识别 ${lagEma === null ? '—' : (lagEma / 1000).toFixed(1) + 's'} · ` +
      `翻译 ${translateEma === null ? '—' : (translateEma / 1000).toFixed(2) + 's'}`,
  );
}

/**
 * 诊断信息走和字幕**完全相同**的通道（offscreen → SW → tabs.sendMessage → 页面），
 * 不碰 chrome.storage、不碰状态广播。这样页面上的数字和弹窗里的数字可以互相印证：
 * 页面有而弹窗没有 ⇒ 状态通道坏了；两边都没有 ⇒ 翻译根本没跑完。
 */
function postDiag(line) {
  if (!rt || !rt.settings?.ui?.showDiag) return;
  postSw({ type: 'LIVEDUB_DIAG', tabId: rt.tabId, line: String(line) });
}

function postDiagEvent(line) {
  if (!rt || !rt.settings?.ui?.showDiag) return;
  postSw({ type: 'LIVEDUB_DIAG', tabId: rt.tabId, line: String(line), log: true });
}

/** 带时限与计时的翻译调用。没有时限的话，一次卡住的请求会永远挂着。 */
const TRANSLATE_TIMEOUT_MS = 12000;

async function translateTimed(text, settings, opts = {}) {
  const timeout = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      timeout.abort();
    } catch {
      /* ignore */
    }
  }, TRANSLATE_TIMEOUT_MS);

  let signal = timeout.signal;
  if (opts.signal) {
    // 外部取消（被定稿顶掉）与超时，谁先到算谁
    signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([opts.signal, timeout.signal])
        : opts.signal;
  }

  const t0 = Date.now();
  let finished = false;
  postDiagEvent(`翻译开始 · ${settings.translate.provider} · ${text.length} 字`);
  try {
    const out = await translate(text, settings, {
      ...opts,
      signal,
      // 术语表有没有真正落地（尤其是 Google 的占位符有没有被吞）必须让用户看得见
      onNote: (note) => postDiagEvent(`术语表 · ${note}`),
    });
    finished = true;
    postDiagEvent(`翻译完成 · ${Date.now() - t0}ms · ${settings.translate.provider}`);
    return out;
  } catch (e) {
    // 三种失败性质完全不同，诊断里必须分清楚，否则"被定稿顶掉"会被误读成服务故障
    if (timedOut) {
      const err = new Error(`翻译服务 ${TRANSLATE_TIMEOUT_MS / 1000} 秒内没有响应（已放弃这一次）`);
      err.name = 'TranslateTimeout';
      postDiagEvent(`翻译超时 · ${Date.now() - t0}ms · ${settings.translate.provider}`);
      throw err;
    }
    if (opts.signal?.aborted) {
      // 定稿抢占：正常流程，不是错误
      postDiagEvent(`中间结果翻译被定稿抢占 · ${Date.now() - t0}ms`);
      throw e;
    }
    postDiagEvent(`翻译失败 · ${Date.now() - t0}ms · ${settings.translate.provider} · ${e?.message || e}`);
    throw e;
  } finally {
    clearTimeout(timer);
    // 被取消/超时的请求不该污染耗时读数
    if (finished) noteTranslateMs(Date.now() - t0);
  }
}

function isAbortError(e) {
  if (!e) return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  return /abort/i.test(String(e.message || ''));
}

function postSw(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {
    /* service worker 唤醒失败时忽略 */
  });
}
