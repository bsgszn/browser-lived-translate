// 本地 VAD 断句 + 本地 Whisper 定文本（全本地、免费）。
//
// 和「Whisper 分片」的根本区别：
//
//   分片模式：按固定时长切音频 → 攒满一片才送去识别 → 还要等下一片才能判断跨片
//             延迟 ≈ 分片时长 × 2 + 推理
//   这个模式：VAD 当场判断"这句话说完了" → 把**完整的一句**送去识别
//             延迟 ≈ 静音确认时长 + 推理（约 0.3 + 0.5 秒）
//
// 它同时省掉了三样东西：分片量化、跨片等待、分片时长调参 ——
// 因为句子边界来自真正的语音检测，而不是"每 N 秒切一刀"。
//
// 依赖（必须放在扩展的 vendor/ 目录，不能从网上加载 —— MV3 的 CSP 不允许）：
//   ort.min.js                     onnxruntime-web 运行时（UMD，由 player.html 用 <script> 引入）
//   ort-wasm-simd-threaded.wasm     CPU SIMD 后端
//   silero_vad.onnx                 Silero VAD v5 模型

import { buildWav } from '../util.js';
import { VadGate, VAD_FRAME_SAMPLES } from './vad-gate.js';
import { looksLikeHallucination } from './hallucination.js';

export const meta = {
  id: 'vad',
  label: '本地 VAD 断句（全本地，延迟最低）',
  sampleRate: 16000,
  // 收句信号来自真正的语音检测，来得很及时 —— 按"流式"对待，
  // 播放页就不会给累积器套上"分片模式"那个很长的看门狗。
  streaming: true,
  docs: 'https://github.com/snakers4/silero-vad',
};

/** 识别请求超时：服务卡住时要报错，不能永远沉默 */
export const TRANSCRIBE_TIMEOUT_MS = 20000;

export function createSession({ config, global, onEvent }) {
  const baseUrl = String(config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Whisper 服务地址未配置（本地 VAD 与识别校正共用同一个地址）。');

  const apiKey = String(config.apiKey || '').trim();
  const model = String(config.model || 'whisper-1').trim();
  const language = String(global.language || 'auto').trim();
  /**
   * 重识别提示词 —— 和分片模式取的是同一个字段（`asr.whisperChunked.prompt`）。
   * 以前 VAD 模式完全不读它，等于用户填了没用。
   */
  const prompt = String(config.prompt || '').trim();

  const vadOpts = {
    threshold: Number(config.vadThreshold ?? 0.5),
    minSpeechMs: 250,
    minSilenceMs: Number(config.vadMinSilenceMs ?? 450),
    maxSpeechMs: Number(config.vadMaxSpeechSec ?? 20) * 1000,
    minUtteranceMs: Number(config.vadMinUtteranceMs ?? 400),
    padMs: Number(config.vadPadMs ?? 200),
  };

  /**
   * ⚠️ 这几个都是**自检之后才能定下来**的：
   * 不同版本的 Silero 对张量维度、窗长的要求不一样，喂错了模型就是"聋的"
   * （实测：真人语音峰值只有 0.001）。自检把候选都跑一遍，挑出能用的那一种。
   */
  let winSamples = VAD_FRAME_SAMPLES;
  let inDims = (n) => [1, n];
  let srDims = [];
  let gate = new VadGate({ ...vadOpts, frameSamples: winSamples });

  /**
   * 硬边界门槛（毫秒）：静音超过它才算"这句真的说完了"。
   *
   * 这是 Deepgram 那套两级边界的本地等价物：
   *   VAD 静音（vadMinSilenceMs）  → 软边界：先发 final，文本到手但**先不收句**
   *   静音超过这个值              → 硬边界：收句
   * 中间那些被切出来的碎片会和后面拼成一句 —— 靠播放页本来就有的累积器，
   * 当初接 Deepgram 时它的多段 is_final 就是这么拼起来的。
   */
  const utteranceEndMs = Number(config.vadUtteranceEndMs ?? 900);

  let stopped = false;
  let started = false;
  let ort = null;
  let vadSession = null;
  let vadState = null;

  /**
   * ⚠️ 两条**分开**的串行链，不能共用：
   *   vadChain   —— VAD 推理必须按帧顺序（state 有状态）
   *   httpChain  —— 识别请求很慢（几百毫秒）
   * 共用一条的话，一次识别会把后面所有 VAD 帧堵住，VAD 就"听不见"了。
   */
  let vadChain = Promise.resolve();
  let httpChain = Promise.resolve();

  /** 凑够 512 采样才是一帧 */
  let pending = new Int16Array(0);
  /** 自会话开始累计送入的采样数（绝对位置，不随裁剪变化） */
  let totalSamples = 0;
  /** 音频缓冲里第一个采样对应的绝对位置 */
  let baseOffset = 0;
  /** 音频缓冲（绝对位置 baseOffset ~ totalSamples） */
  let audio = [];

  /** 诊断用：喂进去多少帧、概率峰值、最近一次概率 */
  let framesFed = 0;
  /** 被质量闸门拦掉的段数（幻听 / 无人说话 / 置信度低） */
  let rejected = 0;
  /** 因为太短被跳过的段数 */
  let skippedShort = 0;
  /** 因为缓冲里取不到那段音频而跳过的段数 */
  let skippedNoAudio = 0;
  /** 滚动窗口：最近约 3.2 秒的 {电平够不够高, 概率}，用来区分"没人说话"和"VAD 聋了" */
  const win = [];
  let maxProb = 0;
  let lastProb = 0;
  let lastInputRms = 0;
  let lastBeatAt = 0;
  /** 输出张量的实际键名与形状 —— 只在第一帧记一次 */
  let outKeys = '';
  let outShape = '';

  function newState() {
    return new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
  }

  async function loadOrt() {
    ort = globalThis.ort;
    if (!ort) throw new Error('onnxruntime 没加载 —— 播放页需要先用 <script> 引入 vendor/ort.min.js');
    try {
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
      // 单线程足够，而且省掉 SharedArrayBuffer 的跨源隔离要求
      ort.env.wasm.numThreads = 1;
    } catch {
      /* ignore */
    }
    return ort.InferenceSession.create(chrome.runtime.getURL('vendor/silero_vad.onnx'), {
      executionProviders: ['wasm'],
    });
  }

  /** 一帧 512 采样 → 语音概率 */
  async function speechProb(frame) {
    const input = new Float32Array(winSamples);
    let sum = 0;
    for (let i = 0; i < winSamples; i += 1) {
      const v = (frame[i] || 0) / 32768;
      input[i] = v;
      sum += v * v;
    }
    lastInputRms = Math.sqrt(sum / winSamples);

    const out = await vadSession.run({
      input: new ort.Tensor('float32', input, inDims(winSamples)),
      state: vadState,
      sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(meta.sampleRate)]), srDims),
    });

    // 第一次跑就把输出的**实际键名**记下来。
    // ⚠️ 曾经因为取错键（out.output 是 undefined）而让概率恒为 0，
    // 而兜底返回 0 又把这件事掩盖成了"VAD 听不见" —— 两种原因的修法完全不同。
    if (!outKeys) {
      outKeys = Object.keys(out).join(',');
      const first = out.output ?? out[Object.keys(out)[0]];
      outShape = first?.dims ? `[${first.dims.join(',')}]` : '?';
    }

    vadState = out.stateN || out.state || vadState;
    const t = out.output ?? out[Object.keys(out)[0]];
    const p = t?.data?.[0];
    return Number.isFinite(p) ? p : NaN;
  }

  async function transcribe(int16) {
    const wav = buildWav(int16, meta.sampleRate);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', model);
    // ⚠️ 必须 verbose_json：只有它带 no_speech_prob / avg_logprob，
    // 而那正是**唯一不会误伤的幻听闸门**。
    // 用 json 的话，Whisper 在音乐/掌声上凭空吐出的"ご視聴ありがとうございました"
    // 会一路畅通地上屏（这个毛病存在了很久，根因就是这里没有闸门）。
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (language && language !== 'auto') form.append('language', language);
    /**
     * ⚠️ 提示词必须发出去。
     *
     * 这是**接线漏了**，不是新功能：分片模式（whisper-chunked）一直会发 `prompt`，
     * 而 VAD 模式没有 —— 于是用户在设置页填的提示词**静默无效**。
     * 对差音源 + 快语速尤其有用：可以把"说话快、有底噪、常见词是这些"塞进去引导。
     * 不填就不发，行为和以前完全一样（所以没有回归风险）。
     */
    if (prompt) form.append('prompt', prompt);

    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

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
    return { text: String(data?.text || '').trim(), data };
  }

  /**
   * 质量闸门 —— 和识别校正用的是同一套判据。
   *
   * 这是**内容无关**的那一道：Whisper 自己说"这段没人说话"或者"置信度很低"，
   * 就别把它的输出当回事。下面还有一道幻听清单兜底。
   *
   * @returns {null|string} null = 通过；否则是拒绝原因
   */
  function rejectReason(text, data) {
    if (!text) return '空文本';
    if (looksLikeHallucination(text)) return '命中幻听套话';
    const segs = Array.isArray(data?.segments) ? data.segments : [];
    for (const s of segs) {
      const t = Number(s?.temperature);
      if (Number.isFinite(t) && t > 0) return `解码回退到 temperature=${t}`;
      const ns = Number(s?.no_speech_prob);
      if (Number.isFinite(ns) && ns > 0.6) return `判定为无人说话（no_speech_prob=${ns.toFixed(2)}）`;
      const lp = Number(s?.avg_logprob);
      if (Number.isFinite(lp) && lp < -1.0) return `置信度低（avg_logprob=${lp.toFixed(2)}）`;
    }
    return null;
  }

  /** 取绝对采样区间 [absStart, absEnd) 的拷贝 */
  function takeRange(absStart, absEnd) {
    const s = Math.max(baseOffset, absStart);
    const e = Math.min(totalSamples, absEnd);
    if (e <= s) return new Int16Array(0);
    const out = new Int16Array(e - s);
    let pos = baseOffset;
    for (const chunk of audio) {
      const cStart = pos;
      const cEnd = pos + chunk.length;
      pos = cEnd;
      if (cEnd <= s) continue;
      if (cStart >= e) break;
      const from = Math.max(0, s - cStart);
      const to = Math.min(chunk.length, e - cStart);
      out.set(chunk.subarray(from, to), cStart + from - s);
    }
    return out;
  }

  /** 送一句去识别，然后**按两级边界**决定要不要收句 */
  function flushSpeech(absStart, absEnd, reason, durationMs, silenceMs) {
    const s = Math.max(baseOffset, absStart);
    const e = Math.min(totalSamples, absEnd);
    // ⚠️ 不许静默 return：这一路曾经因为帧长口径不一致而"取不到音频"，
    // 结果只是"后面定住没新内容"，看不出任何原因。所有提前退出都要有痕迹。
    if (e - s < meta.sampleRate * 0.2) {
      skippedShort += 1;
      if (skippedShort <= 3 || skippedShort % 20 === 0) {
        onEvent({
          type: 'status',
          status: 'vad',
          detail: `跳过一段：太短（${((e - s) / meta.sampleRate).toFixed(2)}s）· 累计 ${skippedShort} 段`,
        });
      }
      return;
    }

    // ⚠️ 这里**不再丢弃过短片段**。
    // 曾经把短于 minUtteranceMs 的直接扔掉，代价是「はい」「ええ」这类短应答整句消失 ——
    // 用户反馈"丢信息"就是这个。噪声由下面的质量闸门负责，不该靠丢音频来治。

    const pcm = takeRange(s, e);
    const startSec = s / meta.sampleRate;
    const durationSec = pcm.length / meta.sampleRate;
    if (!pcm.length) {
      skippedNoAudio += 1;
      onEvent({
        type: 'status',
        status: 'vad',
        detail:
          `取不到音频（要 ${(s / meta.sampleRate).toFixed(1)}~${(e / meta.sampleRate).toFixed(1)}s，` +
          `缓冲只剩 ${(baseOffset / meta.sampleRate).toFixed(1)}~${(totalSamples / meta.sampleRate).toFixed(1)}s）` +
          ` · 累计 ${skippedNoAudio} 段`,
      });
      return;
    }

    httpChain = httpChain
      .then(async () => {
        /**
         * ⚠️ `reason === 'finalize'` 排进来的收尾任务，**即便 stopped 已置真也必须跑完**。
         *
         * stop() 是先 flush、后置 stopped 的，所以这个任务入队时 stopped 还是 false，
         * 但轮到它执行时 stopped 已经是 true 了 —— 用原来的 `if (stopped) return`
         * 会把它自己丢掉，收尾白做（这正是"停止丢最后一句"的第二半）。
         */
        if ((stopped && reason !== 'finalize') || !pcm.length) return;
        const { text, data } = await transcribe(pcm);
        // 质量闸门：Whisper 自己说没人说话 / 置信度低 / 命中套话，就整段丢掉
        const why = rejectReason(text, data);
        if (why) {
          rejected += 1;
          onEvent({
            type: 'status',
            status: 'vad',
            detail: `丢弃一段识别结果 · ${why} · 原文「${text.slice(0, 24)}」`,
          });
          return;
        }
        /**
         * ⚠️ 这里曾经尝试过"按 Whisper 返回的 segments 逐段上屏"，**已经撤掉**。
         *
         * 当时的推断是"segments 是语言模型给的句子边界，比静音门槛准" —— 推断错了。
         * 实测（真实直播）：一个 2.3 秒的片段被切成 2 句、5 秒被切成 3 句，
         * 每句 1 秒出头，日语一句话不可能这么短。
         * whisper.cpp 的 segments 是**紧密相邻的解码切块**（更早的实验里就量到过
         * 6.24→6.24、8.84→8.84 这种零间隔），不是句子边界。
         * 按它切只会更碎，所以回到"静音两级边界"这一套。
         *
         * ⚠️ 下面这行 final **必须**发：它是"文本先到手"的那一步。
         * 删掉软边界就永远不上屏 —— 我在改写这段时删过两次，都被测试抓到。
         */
        onEvent({ type: 'final', text, start: startSec, duration: durationSec });

        /**
         * 「有句末标点」不能无条件收句。
         *
         * ⚠️ 实测：Whisper 会给一个 0.7 秒、3 个字的碎片也加上句号，
         * 于是 `0.7s 一句 · 3 字 · 收句（句末标点）` 单独成条 —— 碎片的第二大来源。
         * 太小的段不给它收句资格，让它并进下一句。
         */
        const tiny = durationSec < 1.0 || text.length < 5;
        const looksComplete = !tiny && /[.。!?！？…]["'）)」』]?$/.test(text.trim());
        /**
         * 硬边界条件（满足任一就立刻收句）：
         *   ① 这段**够长** —— 关键的一条
         *   ② 文本自带句末标点
         *   ③ 超长强制切断
         *
         * ⚠️ ① 是实测补上的。原来只有 ②③，于是一堆 0.6~1.6 秒的碎片全都"先不收"，
         * 累积器只能等 3 秒看门狗才吐 —— 实测出现「整句上屏 · -11.6s 后 · 77 字 ·
         * 识别滞后 17.6s」，字幕又长又迟到。
         * 加了"够长就收句"之后，持有最多跨一段，不会无限攒。
         */
        /**
         * 实测校准：Deepgram 那次**没有一条低于 12 字**，而这里 1.2 秒/6 字
         * 这种碎片仍然会单独成条。把门槛抬到 1.5 秒 / 10 字，让它和后面拼起来。
         * 门槛不能太高：抬过头就变成"什么都要拼"，持有变长、字幕又迟到。
         */
        const substantial = durationSec >= 1.5 || text.length >= 10;
        const hard =
          reason === 'max-length' || substantial || looksComplete || (Number(silenceMs) || 0) >= utteranceEndMs;
        let note = '';
        if (hard) {
          onEvent({ type: 'utteranceEnd' });
          note = looksComplete
            ? '（句末标点）'
            : substantial
              ? '（够长）'
              : `（静音 ${Math.round(Number(silenceMs) || 0)}ms）`;
        }
        onEvent({
          type: 'status',
          status: 'chunk',
          detail:
            `${durationSec.toFixed(1)}s 一句${reason === 'max-length' ? '（超长被切断）' : ''} · ${text.length} 字` +
            ` · 静音 ${Math.round(Number(silenceMs) || 0)}ms · ${hard ? `收句${note}` : '先不收，和后面拼'}` +
            `${rejected ? ` · 已拦掉 ${rejected} 段幻听` : ''}`,
        });
      })
      .catch((err) => onEvent({ type: 'error', message: err.message || String(err) }));
  }

  async function handleFrame(frame) {
    if (!vadSession) return; // 模型还没加载好，先丢掉这几帧（启动阶段很短）
    const p = await speechProb(frame);
    framesFed += 1;
    const ok = Number.isFinite(p);
    if (ok && p > maxProb) maxProb = p;
    lastProb = ok ? p : NaN;

    /**
     * 区分"没人说话"和"VAD 聋了"。
     *
     * 这两种在单次读数上长得一样（概率都是 0），但修法完全相反：
     *   没人说话 → 不是 bug，等就行
     *   VAD 聋了  → 是真 bug，得查状态/输入
     * 判据是**输入电平是否仍然是人声量级**：滚动统计最近一段窗口里
     * "电平超过 0.03 的帧占比"以及这些帧里的最高概率。
     * 电平一直够高而概率一直上不去 → 聋了；电平本来就低 → 没人说话。
     */
    if (Number.isFinite(lastInputRms)) {
      win.push({ loud: lastInputRms > 0.03, p: ok ? p : 0 });
      if (win.length > 80) win.shift(); // 80 帧 ≈ 3.2 秒
    }

    // 心跳：没有它就只能看到"一直没有结果"，看不出是帧没进来、概率上不去、
    // 还是状态机不收句 —— 这三种原因的修法完全不同。
    const now = Date.now();
    if (now - lastBeatAt > 3000) {
      lastBeatAt = now;
      const loud = win.filter((x) => x.loud);
      const loudRatio = win.length ? Math.round((loud.length / win.length) * 100) : 0;
      const loudPeak = loud.length ? Math.max(...loud.map((x) => x.p)) : 0;
      const deaf = win.length >= 40 && loud.length >= win.length * 0.3 && loudPeak < 0.2;
      onEvent({
        // ⚠️ 用单独的 status：它只是读数，不是"识别请求回来了"。
        // 用 'chunk' 会污染播放页那个「已发出/回来」计数器，还会给出错误的建议。
        type: 'status',
        status: 'vad',
        detail:
          `帧 ${framesFed} · 概率 ${ok ? lastProb.toFixed(4) : 'NaN'}（峰值 ${maxProb.toFixed(4)}，阈值 ${gate.threshold}）` +
          ` · 输入电平 ${lastInputRms.toFixed(4)} · ${gate.inSpeech ? '说话中' : '静默'}` +
          ` · 近 ${(win.length / 25).toFixed(0)}s 有声 ${loudRatio}%（其中峰值 ${loudPeak.toFixed(2)}）` +
          `${outKeys ? ` · 输出键 [${outKeys}]${outShape}` : ''}` +
          (deaf ? ' ⚠ 电平够高却一直不认，疑似 VAD 失效' : ''),
      });
    }

    /**
     * ⚠️ 拿不到概率时**也要 push**，不能直接 return。
     *
     * gate 的 `frameIndex` 是"音频位置"的唯一记账（`toSamples` 靠它算切片，
     * `trimAudio` 也靠它算保留范围），而 `totalSamples` 是无条件推进的。
     * 这里一 return，gate 就少算一帧 —— 两边**永久错位，而且只增不减**：
     * 实测 10 帧里 4 帧 NaN 就偏了 0.144s。次生后果更难看：NaN 持续时 gate 冻在语音态 →
     * `trimAudio` 的保留起点固定不变 → **`audio` 数组无限增长**。
     * gate 内部本来就正确处理 NaN（推进计数、不动状态机），所以直接喂给它就行。
     */
    const ev = gate.push(ok ? p : NaN);
    if (!ev) return;
    if (ev.type === 'start') {
      // 新的一句：清掉上一句的循环状态
      vadState = newState();
      return;
    }
    // ⚠️ 必须显式传 frameSamples=winSamples。
    // 不传的话 toSamples 会用默认常量（576），而自检挑中的窗长可能是 640 ——
    // 帧号乘错之后位置会越算越偏（第 100 帧就差 6.4 秒），最后落到已裁剪的缓冲之外，
    // 取不到音频就静默 return。症状是"开始还行，后面定住没新内容"。
    const { start, end } = gate.toSamples(ev.startFrame, ev.endFrame, {
      totalSamples,
      frameSamples: winSamples,
    });
    flushSpeech(start, end, ev.reason, ev.durationMs, ev.silenceMs);
  }

  /**
   * 丢掉很旧的音频。
   * ⚠️ 只能丢"当前这句起点之前"的：正在说的那句必须完整留着，否则切片会缺头。
   * 绝对位置用 baseOffset 记账，所以裁剪不会打乱帧下标和绝对时间的对应关系。
   */
  function trimAudio() {
    const inSpeechFrom = gate.inSpeech ? gate.startFrame * winSamples : totalSamples;
    // 保留起点前 2 秒的余量（兜住 padMs 和还在排队的请求）
    const keepFrom = Math.max(0, inSpeechFrom - meta.sampleRate * 2);
    if (keepFrom <= baseOffset) return;
    const dropped = keepFrom - baseOffset;
    let pos = baseOffset;
    const kept = [];
    for (const chunk of audio) {
      const cStart = pos;
      const cEnd = pos + chunk.length;
      pos = cEnd;
      if (cEnd <= keepFrom) continue;
      kept.push(cStart >= keepFrom ? chunk : chunk.subarray(keepFrom - cStart));
    }
    audio = kept;
    baseOffset = keepFrom;
  }

  function push(int16) {
    if (stopped || !int16 || !int16.length) return;

    audio.push(int16);
    const merged = new Int16Array(pending.length + int16.length);
    merged.set(pending, 0);
    merged.set(int16, pending.length);

    let off = 0;
    const frames = [];
    while (off + winSamples <= merged.length) {
      frames.push(merged.slice(off, off + winSamples));
      off += winSamples;
    }
    pending = merged.slice(off);
    // ⚠️ 先记账再排队：识别是异步的，而绝对位置必须在这一刻就是对的
    totalSamples += int16.length;

    // 帧序号本身就是绝对位置（每帧固定 512 采样、从不丢帧），
    // 所以 gate 给出的 frame × 512 直接就是音频时间，不需要另外记账。
    for (const frame of frames) {
      vadChain = vadChain.then(async () => {
        if (stopped) return;
        try {
          await handleFrame(frame);
        } catch (e) {
          onEvent({ type: 'error', message: e.message || String(e) });
        }
      });
    }

    if (frames.length) trimAudio();
  }

  /**
   * 开箱自检：拿一段**确定含人声**的音频，把几种可能的调用方式**都跑一遍**，
   * 报出各自的峰值概率，并挑出能用的那一种。
   *
   * 为什么是"都跑一遍"而不是修一处再让用户重测：
   * 现场读数只能说明"概率一直是 0"，却分不清是模型坏了、音频没人说话，
   * 还是调用方式（张量维度、窗长）不对。而这几种的修法完全不同。
   * 一次把候选跑完，一轮就能定死，不用来回重载扩展。
   *
   * ⚠️ 每种变体都用**独立的 state**，绝不污染正在跑的那条流。
   */
  async function runVariant(i16, v) {
    let st = newState();
    let peak = 0;
    let frames = 0;
    const step = v.win;
    for (let off = 0; off + step <= i16.length; off += step) {
      const input = new Float32Array(step);
      for (let i = 0; i < step; i += 1) input[i] = i16[off + i] / 32768;
      const out = await vadSession.run({
        input: new ort.Tensor('float32', input, v.inDims(step)),
        state: st,
        sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(meta.sampleRate)]), v.srDims),
      });
      st = out.stateN || st;
      const p = out.output?.data?.[0];
      if (Number.isFinite(p) && p > peak) peak = p;
      frames += 1;
    }
    return { peak, frames };
  }

  async function selfTest() {
    const res = await fetch(chrome.runtime.getURL('vendor/vad-selftest.wav'));
    if (!res.ok) throw new Error(`自检音频读取失败 HTTP ${res.status}`);
    const i16 = new Int16Array(await res.arrayBuffer(), 44); // 跳过 44 字节 WAV 头

    const variants = [
      // ⚠️ 顺序就是优先级。576 是 Silero **v6**（master 分支）在 16kHz 下的窗长；
      // 512 是 v5 的，对 v6 模型完全无效 —— 概率恒为 0.001，而且**不报错**，
      // 看起来就像"音频里没人说话"。实测见 vad-gate.js 里那张表。
      { name: '576 窗（v6）', srDims: [], win: 576, inDims: (n) => [1, n] },
      { name: '640 窗', srDims: [], win: 640, inDims: (n) => [1, n] },
      { name: '608 窗', srDims: [], win: 608, inDims: (n) => [1, n] },
      { name: '512 窗（v5）', srDims: [], win: 512, inDims: (n) => [1, n] },
      { name: '576 窗 + sr[1]', srDims: [1], win: 576, inDims: (n) => [1, n] },
    ];

    const results = [];
    for (const v of variants) {
      try {
        const r = await runVariant(i16, v);
        results.push({ ...v, ...r });
      } catch (e) {
        results.push({ ...v, peak: NaN, frames: 0, err: e.message || String(e) });
      }
    }
    return results;
  }

  async function start() {
    started = true;
    onEvent({ type: 'status', status: 'connecting', detail: '正在加载本地 VAD 模型…' });
    vadSession = await loadOrt();
    vadState = newState();

    // 先自检，再报就绪 —— 这样"模型到底行不行"永远有一个已知答案作对照
    let results;
    try {
      results = await selfTest();
    } catch (e) {
      onEvent({ type: 'status', status: 'error', detail: `本地 VAD 自检没能跑起来 · ${e.message || e}` });
      return;
    }

    // 按峰值从高到低报一遍，谁能用一目了然
    const line = results
      .map((r) => `${r.name}=${Number.isFinite(r.peak) ? r.peak.toFixed(3) : '报错'}`)
      .join(' · ');
    const best = results.filter((r) => Number.isFinite(r.peak)).sort((a, b) => b.peak - a.peak)[0];

    if (!best || best.peak < gate.threshold) {
      onEvent({
        type: 'status',
        status: 'error',
        detail:
          `本地 VAD 所有调用方式都不响应（真人语音峰值最高只有 ${best ? best.peak.toFixed(3) : 'N/A'}，阈值 ${gate.threshold}）` +
          ` · ${line}`,
      });
      return;
    }

    // ✅ 挑中了：按这个变体配置后续的实时处理
    winSamples = best.win;
    inDims = best.inDims;
    srDims = best.srDims;
    /**
     * ⚠️ 必须复用 vadOpts（也就是用户设置页里那些值）。
     *
     * 这里曾经写死 `minSilenceMs: 300, maxSpeechMs: 20000` ——
     * 于是自检挑完窗长之后，**设置页里调的「静音确认」「一句最长」全部失效**，
     * 用户怎么调都没反应（我还让他去调过，是我不对）。
     * 两处创建 gate 必须用同一份参数，唯一不同的是它的 frameSamples。
     */
    gate = new VadGate({ ...vadOpts, frameSamples: winSamples });
    pending = new Int16Array(0);

    onEvent({
      type: 'status',
      status: 'connected',
      detail: `本地 VAD 自检通过 · 采用「${best.name}」真人语音峰值 ${best.peak.toFixed(3)}（阈值 ${gate.threshold}）· Whisper @ ${baseUrl}`,
    });
    onEvent({ type: 'status', status: 'vad', detail: `其余变体：${line}` });
  }

  function finalize() {
    if (stopped || !gate.inSpeech) return false;
    const { start, end } = gate.toSamples(gate.startFrame, gate.frameIndex, {
      totalSamples,
      frameSamples: winSamples,
    });
    const durationMs = (gate.frameIndex - gate.startFrame) * gate.frameMs;
    // finalize 是"要停了"，静音时长按门槛算 —— 必须收句，否则这段永远不上屏
    flushSpeech(start, end, 'finalize', durationMs, utteranceEndMs);
    gate.reset();
    return true;
  }

  async function stop() {
    /**
     * ⚠️ 收尾必须在**置 stopped 之前**做完。
     *
     * 踩过的坑：`stop()` 原来是直接 `stopped = true` 然后等两条链结束 ——
     * 于是**每次停止都会丢掉正在说的那一整句**（最多 vadMaxSpeechSec 秒，那时是 5 秒）。
     * 为它准备的 `finalize()` 因为开头有 `if (stopped ...) return false`，
     * 从任何路径调都拒不动，成了死代码；而且全仓库也确实没有任何地方调它。
     * 两个问题叠在一起，症状就是"点停止，最后一句永远不上屏"。
     */
    try {
      if (gate.inSpeech) {
        const { start, end } = gate.toSamples(gate.startFrame, gate.frameIndex, {
          totalSamples,
          frameSamples: winSamples,
        });
        const durationMs = (gate.frameIndex - gate.startFrame) * gate.frameMs;
        flushSpeech(start, end, 'finalize', durationMs, utteranceEndMs);
        gate.reset();
      }
    } catch {
      /* 收尾失败不该阻止停止本身 */
    }
    stopped = true;
    onEvent({ type: 'status', status: 'closed' });
    await vadChain.catch(() => {});
    await httpChain.catch(() => {});
  }

  return {
    sampleRate: meta.sampleRate,
    streaming: true,
    isOpen: () => started,
    start,
    push,
    finalize,
    stop,
  };
}
