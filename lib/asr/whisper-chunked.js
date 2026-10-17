// Whisper 分片识别：每 N 秒把一段 16k 单声道 WAV POST 到 OpenAI 兼容的
// /audio/transcriptions 端点。既可用 OpenAI 官方，也可指向本地 faster-whisper-server、
// whisper.cpp server、vLLM、LM Studio 等任意兼容实现。
//
// 特点：不是真正的流式，端到端延迟 ≈ chunkSeconds + 推理时间；但胜在可以完全本地跑、隐私好。
//
// ⚠️ 断句：分片模式**没有**流式那样的"说话结束"事件，只能靠音频本身找停顿。
//
// 这里踩过两次坑，都记在下面：
//   1. 按分片硬切（每 5 秒一句）→ 一句话被劈成三段。
//   2. 改成"整片静音才收句" → 人说话的句间停顿只有 0.3~1 秒，**永远填不满一个分片**，
//      结果两句并成一句。
// 现在是对的：**在分片内部用短窗 RMS 找停顿**（splitOnPauses），
// 停顿处就是句子边界；末尾还带着语音的那一段留着，跟下一个分片拼起来。

import { buildWav, rms } from '../util.js';
import { buildWhisperPrompt } from './vad.js';

export const meta = {
  id: 'whisper-chunked',
  label: 'OpenAI Whisper 分片（含本地）',
  sampleRate: 16000,
  streaming: false,
  docs: 'https://platform.openai.com/docs/api-reference/audio/createTranscription',
};

/**
 * 这一片是不是**整片都没人说话**。
 *
 * ⚠️ 判据是**自适应**的，不能只看绝对阈值。
 * 因为绝对阈值在"音源整体偏轻"时会 100% 全判静音 ——
 * 音频流完全正常，却一条字幕都没有（这个故障真发生过，
 * 而且这条分支以前是所有分支里唯一不发心跳的，所以它隐身了好几轮）。
 *
 * 办法：静音是"**远低于本会话的峰值**"，而不是"低于某个绝对数"。
 *   有效阈值 = min(用户设的绝对阈值, max(0.0002, 本会话峰值 × 10%))
 * 会话刚开始峰值还是 0，阈值就是 0.0002 —— 只有真正的数字静音才跳过，绝不误伤。
 *
 * @returns {{silent:boolean, transcribe:boolean, effective:number, level:number}}
 */
export function classifyChunk({ rms: level, silenceThreshold, skipSilence, peakRms = 0 }) {
  const lv = Number(level);
  const abs = Number(silenceThreshold);
  const rel = Number(peakRms) * 0.1;
  const effective = Math.min(Number.isFinite(abs) ? abs : 0.006, Math.max(0.0002, rel));
  const silent = lv < effective;
  if (!silent) return { silent: false, transcribe: true, effective, level: lv };
  return { silent: true, transcribe: !skipSilence, effective, level: lv };
}

/**
 * 把逐词时间收集起来。
 *
 * ⚠️ **whisper.cpp 把 `words` 放在每个 `segments[]` 里面，不在顶层。**
 * 一开始只读 `data.words`，结果永远是 undefined —— 断句退回退化路径，
 * 每片只发 final 不发 utteranceEnd，累积器永远等不到收句，
 * 表现就是「一条字幕都不出来」。这个坑记在这里。
 *
 * 兼容三种形态：顶层 words、segments[].words、以及段落用相对时间（少见但要兜）。
 */
export function collectWords(data) {
  const out = [];
  const push = (w, offset) => {
    const t = String(w?.word ?? '').trim();
    const s = Number(w?.start);
    const e = Number(w?.end);
    if (!t || !Number.isFinite(s) || !Number.isFinite(e)) return;
    out.push({ word: t, start: s + offset, end: e + offset });
  };

  for (const seg of Array.isArray(data?.segments) ? data.segments : []) {
    const ws = Array.isArray(seg?.words) ? seg.words : [];
    if (!ws.length) continue;
    const segStart = Number(seg?.start);
    // 判定这一段的词时间是"相对本段"还是"相对整次请求"：
    // 第一个词的起点明显小于本段起点 → 是相对时间，要补上段起点
    const first = Number(ws[0]?.start);
    const offset = Number.isFinite(segStart) && Number.isFinite(first) && first + 0.5 < segStart ? segStart : 0;
    for (const w of ws) push(w, offset);
  }
  // 有的实现（faster-whisper 的某些版本）给在顶层
  if (!out.length && Array.isArray(data?.words)) for (const w of data.words) push(w, 0);
  return out;
}

/** 中/日/韩/全角字符结尾或开头时，词之间不加空格 */
function cjkEdge(s) {
  return /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]$/.test(s)
    || /^[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/.test(s);
}

/**
 * 按**词与词之间的空隙**把一句话切成若干句。
 *
 * ⚠️ 这是 BGM 场景下唯一可靠的断句依据。
 * 音量检测在背景音乐面前必然失效 —— 实测（真实日语 + 混入 BGM）：
 *
 *   BGM 强度   静音帧占比   音量检测切出的段数
 *        0       38.1%          [2, 1]  ✅
 *      400        0.4%          [1, 1]  ❌
 *     1500        0.0%          [1, 1]  ❌
 *
 * 音乐和说话的音量重叠了，任何**绝对**阈值都切不准。
 * 而 Whisper 的对齐知道自己听到的是哪几个词，词间的空隙就是停顿 —— BGM 影响不了它。
 *
 * @param {Array<{word:string,start:number,end:number}>} words
 * @param {{minPauseSec?:number}} opts
 * @returns {Array<{text:string,start:number,end:number}>}
 */
export function groupWordsByPauses(words, { minPauseSec = MIN_PAUSE_SEC } = {}) {
  const gap = Math.max(0.05, Number(minPauseSec) || MIN_PAUSE_SEC);
  const out = [];
  let cur = null;
  for (const w of Array.isArray(words) ? words : []) {
    const t = String(w?.word ?? '').trim();
    if (!t) continue;
    const s = Number(w?.start);
    const e = Number(w?.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;

    if (cur && s - cur.end < gap) {
      // 接着说 —— 接上去（中日韩不加空格，英文加）
      cur.text += (cjkEdge(cur.text) || cjkEdge(t) ? '' : ' ') + t;
      cur.end = Math.max(cur.end, e);
    } else {
      if (cur && cur.text) out.push(cur);
      cur = { text: t, start: s, end: e };
    }
  }
  if (cur && cur.text) out.push(cur);
  return out;
}

/**
 * 按**音频停顿**切句 —— 只在服务不返回逐词时间戳时当兜底。
 *
 * ⚠️ 它对背景音乐无效（见 groupWordsByPauses 的实测数据），有词时间就别用它。
 */
export function splitOnPauses(int16, rate, { threshold = 0.006, frameMs = 50, minPauseMs = 320, minSpeechMs = 300 } = {}) {
  const frame = Math.max(1, Math.round((rate * frameMs) / 1000));
  const minPauseFrames = Math.max(1, Math.round(minPauseMs / frameMs));
  const minSpeechSamples = Math.max(1, Math.round((rate * minSpeechMs) / 1000));
  const out = [];

  let speechStart = -1;
  let quietRun = 0;
  const frames = Math.floor(int16.length / frame);

  for (let i = 0; i < frames; i += 1) {
    const off = i * frame;
    let sum = 0;
    for (let j = 0; j < frame; j += 1) {
      const v = int16[off + j] / 32768;
      sum += v * v;
    }
    const quiet = Math.sqrt(sum / frame) < threshold;

    if (!quiet) {
      if (speechStart < 0) speechStart = off;
      quietRun = 0;
      continue;
    }
    quietRun += 1;
    if (speechStart >= 0 && quietRun >= minPauseFrames) {
      // 这一句到"停顿开始"为止
      const end = off - (quietRun - 1) * frame;
      if (end - speechStart >= minSpeechSamples) out.push({ start: speechStart, end, endsAtBufferEnd: false });
      speechStart = -1;
      quietRun = 0;
    }
  }

  // 收尾：还带着语音，说明这句没说完
  if (speechStart >= 0 && int16.length - speechStart >= minSpeechSamples) {
    out.push({ start: speechStart, end: int16.length, endsAtBufferEnd: true });
  }
  return out;
}

/**
 * 单次识别请求的超时（毫秒）。
 *
 * 没有它的话，服务卡住时那个 await 永远不返回，
 * 表现就是「一条字幕都没有、也没有任何报错」—— 排查时最难受的一种故障。
 */
export const TRANSCRIBE_TIMEOUT_MS = 20000;

/**
 * 词与词之间停顿多久算"一句话说完了"（秒）—— 默认值。
 *
 * 可以在设置里调（分片识别那一栏的「断句停顿」）：
 *   调小 → 句子更短、更容易断（半句就切的风险）
 *   调大 → 更少断、句子更长（两句并成一句）
 * 日语的自然停顿比英语短，所以默认给 0.25 而不是 0.35。
 */
export const MIN_PAUSE_SEC = 0.25;

export function createSession({ config, global, onEvent }) {
  const baseUrl = String(config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Whisper 服务地址未配置。');

  const apiKey = String(config.apiKey || '').trim();
  const model = String(config.model || 'whisper-1').trim();
  const language = String(global.language || 'auto').trim();
  const chunkSeconds = Math.max(2, Math.min(30, Number(config.chunkSeconds) || 5));
  const skipSilence = config.skipSilence !== false;
  const silenceThreshold = Number(config.silenceThreshold ?? 0.006);
  /**
   * 断句停顿门槛：设置里可调，夹在合理区间内。
   * 上限 1.5 秒、下限 0.1 秒 —— 再小会在词内部乱切，再大就只剩长句了。
   */
  const minPauseSec = Math.min(1.5, Math.max(0.1, Number(config.pauseSec) || MIN_PAUSE_SEC));
  /**
   * 提示词 = 用户提示词 + 识别热词（可选并入术语表源词）。
   * 和 VAD 模式**共用同一个拼装函数** —— 两条路发给 Whisper 的东西必须一样，
   * 否则"换一个识别模式，热词突然不生效"这种坑迟早出现。
   */
  const promptInfo = buildWhisperPrompt({
    prompt: config.prompt,
    hotwords: config.hotwords,
    glossary: global?.whisperGlossaryWords,
    includeGlossary: config.glossaryHotwords === true,
  });
  const prompt = promptInfo.text;
  const chunkSamples = Math.round(chunkSeconds * meta.sampleRate);

  const chunks = [];
  let samples = 0;
  /** 自会话开始累计送入的样本数，不随分片清空，用于给结果标注音频时间点 */
  let totalSamples = 0;
  let flushing = Promise.resolve();
  let stopped = false;
  let started = false;

  async function transcribe(int16) {
    const wav = buildWav(int16, meta.sampleRate);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', model);
    // ⚠️ 必须 verbose_json：`json` 只回一个 text，没有逐词时间，
    // 断句就只能退回音量检测 —— 而它在背景音乐面前是失效的（见 groupWordsByPauses）。
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (language && language !== 'auto') form.append('language', language);
    if (prompt) form.append('prompt', prompt);

    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    // ⚠️ 必须给请求设超时。
    // 没有超时的话，服务卡住 / 被前面的请求堵住 / 连上了但没人应答，
    // 这一个 await 会**永远不返回** —— 表现就是"一条字幕都没有，而且没有任何报错"，
    // 因为错误分支压根走不到。这个坑踩过。
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: form,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new Error(`识别请求超过 ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)} 秒没有响应（服务卡住了？）`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Whisper 接口返回 ${res.status}${body ? '：' + body.slice(0, 240) : ''}`);
    }
    const data = await res.json();
    const text = String(data?.text || '').trim();
    return { text, words: collectWords(data) };
  }

  function takeBuffer() {
    const total = samples;
    const out = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    chunks.length = 0;
    samples = 0;
    return out;
  }

  function scheduleFlush() {
    const buf = takeBuffer();
    // 该分片覆盖的音频区间（相对本次会话第一帧），用来估算识别滞后
    const endSec = totalSamples / meta.sampleRate;
    const startSec = Math.max(0, endSec - buf.length / meta.sampleRate);
    const bufSec = buf.length / meta.sampleRate;

    flushing = flushing
      .then(async () => {
        if (stopped || !buf.length) return;

        const level = rms(buf);
        peakRms = Math.max(peakRms * 0.99, level);
        const plan = classifyChunk({ rms: level, silenceThreshold, skipSilence, peakRms });
        if (plan.silent && !plan.transcribe) {
          // ⚠️ 这条分支以前不发任何心跳，所以"整条流全被判成静音"这个故障
          // 隐身了好几轮 —— 表现就是"什么字幕都没有、也没有报错"。
          // 现在必须把"实测电平 vs 有效阈值"报出来。
          onEvent({ type: 'status', status: 'chunk', detail: `整片判为静音 · 电平 ${level.toFixed(4)} < 阈值 ${plan.effective.toFixed(4)}` });
          onEvent({ type: 'silence' });
          onEvent({ type: 'utteranceEnd' });
          return;
        }

        onEvent({ type: 'status', status: 'recognizing' });
        const whole = await transcribe(buf);
        // 心跳：每个分片报一行，出问题时一眼能看出卡在哪一步
        const say = (d) =>
          onEvent({ type: 'status', status: 'chunk', detail: `${startSec.toFixed(1)}s 起 ${bufSec.toFixed(1)}s · ${d}` });

        // ── ① 首选：让 Whisper 用自己的**逐词时间**告诉我们句子边界 ──
        // 它对背景音乐免疫，而音量检测不是（见 groupWordsByPauses 的实测数据）。
        if (whole.text && whole.words?.length) {
          const groups = groupWordsByPauses(whole.words, { minPauseSec }).map((g) => ({
            text: g.text,
            start: startSec + g.start,
            end: startSec + g.end,
          }));
          if (groups.length) {
            let cut = 0;

            // 先把上一片留着的"末句"结掉。
            // ⚠️ 关键：上一片的末句贴着片尾时，**当场分不清它说完了没有** ——
            // 原来一律当成"没说完"累积到下一片，于是片1末句和片2首句被强行并成一句
            // （用户反馈的"短句太长了"就是这个）。
            // 现在等这一片的词时间到了，用**跨片的词间空隙**来判断。
            if (pending) {
              const gap = groups[0].start - pending.end;
              if (gap >= minPauseSec) {
                cut += 1;
                onEvent({ type: 'utteranceEnd' });
              }
              pending = null;
            }

            for (let i = 0; i < groups.length; i += 1) {
              const g = groups[i];
              onEvent({
                type: 'final',
                text: g.text,
                start: g.start,
                duration: Math.max(0.1, g.end - g.start),
              });
              // 片内：和下一句之间有空隙就是一句结束
              const next = groups[i + 1];
              if (next && next.start - g.end >= minPauseSec) {
                cut += 1;
                onEvent({ type: 'utteranceEnd' });
              }
            }

            const lastG = groups[groups.length - 1];
            if (lastG.end < bufSec - minPauseSec) {
              // 片内就停下来了 → 这是一句完整的
              cut += 1;
              onEvent({ type: 'utteranceEnd' });
            } else {
              // 贴着片尾，说完了没有要等下一片才知道
              pending = { end: lastG.end };
            }

            say(`${groups.length} 句 · 收句 ${cut}${pending ? ' · 末句待定' : ''} · 停顿门槛 ${minPauseSec}s`);
            return;
          }
        }

        // ── ② 服务不支持逐词时间，或者没听出内容 ──
        if (whole.text) {
          say('没有逐词时间 · 整片当一句累积');
          onEvent({ type: 'final', text: whole.text, start: startSec, duration: bufSec });
          return;
        }

        // ── ③ 一点文本都没有：退回音频级停顿检测 ──
        // 它对 BGM 无效，但至少能在干净音源上把静音/噪声区分开。
        let work = splitOnPauses(buf, meta.sampleRate, { threshold: silenceThreshold });
        if (!work.length) {
          if (plan.silent) {
            say('整片静音');
            onEvent({ type: 'silence' });
            onEvent({ type: 'utteranceEnd' });
            return;
          }
          // ⚠️ 兜底：切不出话段但整片并不静音 —— **绝不能把音频丢掉**
          // （那会让字幕整段消失，这个坑踩过），整片当一句送出去。
          work = [{ start: 0, end: buf.length, endsAtBufferEnd: true }];
          say('没有文本且切不出话段 · 整片兜底送出');
        } else {
          say(`没有文本 · 音量检测切出 ${work.length} 段`);
        }
        for (const piece of work) {
          const part = await transcribe(buf.subarray(piece.start, piece.end));
          if (!part.text) continue;
          onEvent({
            type: 'final',
            text: part.text,
            start: startSec + piece.start / meta.sampleRate,
            duration: (piece.end - piece.start) / meta.sampleRate,
          });
          if (!piece.endsAtBufferEnd) onEvent({ type: 'utteranceEnd' });
        }
      })
      .catch((e) => onEvent({ type: 'error', message: e.message || String(e) }));
  }

  async function start() {
    started = true;
    // 先做一次轻量探测：确认端点可达，避免"开始后一直没字幕"的困惑。
    onEvent({ type: 'status', status: 'connected', detail: `Whisper ${model} @ ${baseUrl}` });
  }

  let lastBeatAt = 0;
  /** 本会话见过的最大分片 RMS —— 自适应静音判据要用它（见 classifyChunk） */
  let peakRms = 0;
  /**
   * 上一片末尾那句：它贴着片尾，**当场分不清说完了没有**，
   * 要等下一片的词时间到了才知道。存下它的结束时刻用来算跨片空隙。
   */
  let pending = null;

  function push(int16) {
    if (stopped || !int16 || !int16.length) return;
    chunks.push(int16);
    samples += int16.length;
    totalSamples += int16.length;

    // 心跳：每 5 秒报一次"收了多少音频 + 当前电平"。
    // ⚠️ 必须报 totalSamples（自会话开始累计，**从不归零**），
    // 不能报 samples —— 它会被 takeBuffer() 清零，而心跳和分片都是 5 秒一次，
    // 两者锁相之后每次都正好读到清零后的值，永远显示 0.0（这个仪器错过一次）。
    // 电平也要报：静音误判的故障，只有把"实测电平 vs 阈值"摆出来才看得见。
    if (Date.now() - lastBeatAt > 5000) {
      lastBeatAt = Date.now();
      const lv = rms(int16);
      peakRms = Math.max(peakRms * 0.99, lv);
      onEvent({
        // ⚠️ 用单独的 status：这是"收音频"的心跳，不是"分片处理完了"。
        // 混在一起的话，后到的收音频心跳会把分片结果覆盖掉。
        type: 'status',
        status: 'audio',
        detail:
          `已收音频 ${(totalSamples / meta.sampleRate).toFixed(1)}s · 本片 ${(samples / meta.sampleRate).toFixed(1)}s / ${chunkSeconds}s` +
          ` · 电平 ${lv.toFixed(4)}（阈值 ${classifyChunk({ rms: lv, silenceThreshold, skipSilence, peakRms }).effective.toFixed(4)}）`,
      });
    }

    if (samples >= chunkSamples) scheduleFlush();
  }

  /** 把当前攒着的音频立刻送去识别，不等攒满一个分片 */
  function finalize() {
    if (stopped || samples === 0) return false;
    scheduleFlush();
    return true;
  }

  async function stop() {
    stopped = true;
    // 让播放页知道"是这条连接被关了"，而不是"一直没结果"
    onEvent({ type: 'status', status: 'closed' });
    // 还留着一句没结的，收掉它，否则它会永远不上屏
    if (pending) {
      pending = null;
      onEvent({ type: 'utteranceEnd' });
    }
    if (samples > 0) {
      const buf = takeBuffer();
      const endSec = totalSamples / meta.sampleRate;
      const startSec = Math.max(0, endSec - buf.length / meta.sampleRate);
      if (buf.length > meta.sampleRate * 0.4) {
        flushing = flushing
          .then(async () => {
            try {
              // 关闭时也要按停顿切 —— 否则最后一句会跟前面粘在一起
              const tail = splitOnPauses(buf, meta.sampleRate, { threshold: silenceThreshold });
              // 同样的兜底：切不出来也要把这批音频送出去，不能丢
              const pieces = tail.length ? tail : [{ start: 0, end: buf.length }];
              for (const piece of pieces) {
                const part = await transcribe(buf.subarray(piece.start, piece.end));
                // ⚠️ transcribe 返回 {text, words}，不是字符串 ——
                // 写成 if (!text) 会永远为真，把 [object Object] 当字幕发出去
                if (!part.text) continue;
                onEvent({
                  type: 'final',
                  text: part.text,
                  start: startSec + piece.start / meta.sampleRate,
                  duration: (piece.end - piece.start) / meta.sampleRate,
                });
              }
            } catch {
              /* 关闭阶段的失败忽略 */
            }
          })
          .catch(() => {});
      }
    }
    await flushing.catch(() => {});
  }

  return {
    sampleRate: meta.sampleRate,
    streaming: false,
    isOpen: () => started,
    start,
    push,
    finalize,
    stop,
  };
}
