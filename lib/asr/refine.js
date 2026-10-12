// 用延迟换识别准确率：把已经溜过去的那一小段音频**重新用非流式接口识别一遍**。
//
// 为什么这样更准：流式识别为了压低延迟，必须不停地下判断、随时准备断句、还要吐中间结果，
// 代价就是准确率。非流式接口拿到的是**完整的一段话**，可以前后通看，还能开标点与大小写规整。
//
// 分工很重要：
//   流式识别决定「什么时候上屏」——它的时间戳驱动字幕排期，这条不能动
//   非流式识别决定「到底是什么词」——只替换文本，时间轴仍用流式的
// 所以重识别失败、超时、或者根本没配，都不会影响字幕的时序，只是没拿到那份加成。
//
// ⚠️ 这个功能在 v1.9.1 被整体回退过一次，原因不是设计，是三个具体问题，这里逐个堵住：
//   1. **默认开着**。而 whisperChunked.baseUrl 默认指向 127.0.0.1:8000 —— 没跑服务的人
//      每句都会往那儿打一次空请求。现在默认关，要显式打开。
//   2. **提示词不封顶**。几十条术语拼成 prompt 塞给 Whisper，超过 224 token 之后它不再
//      参考、而是开始复读或胡编。现在按**字符数**封顶。
//   3. **失败不设防**。服务没起来时每句都全量等一次超时。现在连续失败会退避一段时间。

import { encodeWav } from '../pcm-ring.js';
import { looksLikeHallucination } from './hallucination.js';

/** 本地 GPU 跑一段话约 0.5 秒；2.5 秒已经很宽裕，同时把"服务没起"的代价关在笼子里 */
const REFINE_TIMEOUT_MS = 2500;

/** 连续失败这么多次就先别试了 */
const FAIL_THRESHOLD = 2;
/** 退避时长：这段时间内直接跳过，不再发请求 */
const BACKOFF_MS = 30000;

/**
 * Deepgram keyterm 的条数上限。
 *
 * ⚠️ 这个值曾经开到 100 —— 整张术语表灌进去会**过度偏置**，
 * 把本来识别对的内容硬掰成术语表里的词。30 条已经足够提示。
 */
export const REFINE_KEYTERM_LIMIT = 30;

/**
 * Whisper 的 prompt 上限是 224 个 token。**超了不但没用，还会让它开始复读或胡编。**
 * 中文/日文差不多 1 字 1 token，英文约 4 字符 1 token —— 按字符数封顶最稳妥。
 */
export const REFINE_PROMPT_MAX_CHARS = 180;

/**
 * 识别提示词 —— **只来自用户为识别显式填的字段**。
 *
 * ⚠️ 这里踩过一个很贵的坑：原来会把 `translate.glossary`（翻译术语表）也拼进来，
 * 结果是一堵**英文**直播术语（charity stream / members-only / super chat …）被拿去
 * 识别**日语**音频。实测对照（同一段真实日语，whisper.cpp + large-v3）：
 *
 *   不加 prompt  → 「そうなんだよね / ティールで一瞬で流れたりするからね / あれピンクと黒の髪の毛の色はあれひなのじゃん」 全对
 *   加那堵英文 → 丢了开头、多出「目立ち」，avg_logprob 也变差
 *   换成日文相关词 → 仍然丢掉第一句，还把「ひなの」听成「ひなうの」
 *
 * 结论：**两边的字段必须分开**。
 *   translate.glossary            → 给翻译用的，管术语一致
 *   asr.deepgram.keyterms         → 给识别用的（用户显式填）
 *   asr.refine.prompt             → 给重识别用的（用户显式填）
 * 混用没有任何好处，只会把识别带偏。
 *
 * @param {object} settings 完整设置
 * @param {number} limit 最多取几个词
 */
export function refineKeyterms(settings, limit = 60) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    for (const piece of String(raw || '').split(/[,，\n]/)) {
      const t = piece.trim();
      if (!t) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  };
  // 只认用户为识别填的两处；术语表一概不碰
  push(settings?.asr?.refine?.prompt);
  push(settings?.asr?.deepgram?.keyterms);
  return out.slice(0, limit);
}

/**
 * 给 Whisper 的 prompt 文本：在**字符数**上封顶。
 *
 * 默认是空的 —— 实测显示 prompt 更容易把 Whisper 带偏，而不是帮它听准。
 * 只有用户明确填了才发。
 */
export function refinePromptText(settings, maxChars = REFINE_PROMPT_MAX_CHARS) {
  const cap = Math.max(0, Number(maxChars) || 0);
  if (!cap) return '';
  const parts = [];
  let used = 0;
  for (const term of refineKeyterms(settings, 60)) {
    const cost = term.length + (parts.length ? 1 : 0);
    if (used + cost > cap) break;
    parts.push(term);
    used += cost;
  }
  return parts.join(' ');
}

/**
 * 建一个重识别器。
 *
 * `refine()` 永远不会抛。返回 `{text, ok, reason?, logprob?}`：
 *   ok=false 表示"这次结果不可信"（服务出错、超时、退避中、或者置信度太低），
 *   调用方应当**沿用流式文本**，而不是拿它去覆盖。
 *
 * @param {object} settings
 * @param {{onNote?:(msg:string)=>void}} [hooks]
 * @returns {{available:boolean, provider:string, model:string, reason?:string,
 *            refine:(pcm:Int16Array, sampleRate:number, signal?:AbortSignal)=>Promise<{text:string,ok:boolean,reason?:string,logprob?:number}>,
 *            stats:()=>({calls:number, failures:number, backoff:boolean})}}
 */
export function createRefiner(settings, { onNote } = {}) {
  const note = (m) => {
    try {
      onNote?.(m);
    } catch {
      /* 诊断回调不该影响主流程 */
    }
  };

  const cfg = settings?.asr?.refine || {};
  const want = cfg.provider || 'auto';
  const streaming = settings?.asr?.provider || 'deepgram';

  const useDeepgram = want === 'deepgram' || (want === 'auto' && streaming === 'deepgram');
  const useWhisper = want === 'whisper' || (want === 'auto' && !useDeepgram);

  let calls = 0;
  let failures = 0;
  let backoffUntil = 0;

  // ⚠️ 这里**不能**写成 `async (fn) => ...`：async 函数返回的永远是 Promise，
  // 那样 refine 拿到的会是个 Promise 而不是函数，整个重识别静默失效。
  const empty = (reason) => ({ text: '', ok: false, reason });
  const guard = (fn) => async (pcm, sampleRate, signal) => {
    if (Date.now() < backoffUntil) return empty('退避中，先不试了');
    if (!pcm || pcm.length < Math.max(1, Number(sampleRate) || 16000) * 0.3) return empty('片段太短');
    calls += 1;
    try {
      const out = await fn(pcm, sampleRate, signal);
      failures = 0;
      return out;
    } catch (e) {
      failures += 1;
      if (failures >= FAIL_THRESHOLD) {
        backoffUntil = Date.now() + BACKOFF_MS;
        note(`重识别连续失败 ${failures} 次，暂停 ${BACKOFF_MS / 1000} 秒 · ${e?.message || e}`);
      } else {
        note(`重识别失败 · ${e?.message || e}`);
      }
      return empty(String(e?.message || e));
    }
  };

  const base = {
    refine: async () => empty('重识别不可用'),
    stats: () => ({ calls, failures, backoff: Date.now() < backoffUntil }),
  };

  if (useDeepgram) {
    const dg = settings.asr.deepgram || {};
    const apiKey = String(dg.apiKey || '').trim();
    if (!apiKey) return { ...base, available: false, provider: 'deepgram', model: '', reason: '没有 Deepgram API Key' };
    const model = String(cfg.model || dg.model || 'nova-3').trim();
    return {
      ...base,
      available: true,
      provider: 'deepgram',
      model,
      refine: guard((pcm, rate, signal) =>
        refineDeepgram(pcm, rate, { ...dg, apiKey, refineModel: model }, settings, signal),
      ),
    };
  }

  if (useWhisper) {
    const wc = settings.asr.whisperChunked || {};
    const baseUrl = String(wc.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return { ...base, available: false, provider: 'whisper', model: '', reason: '没有配置 Whisper 兼容端点' };
    const model = String(cfg.model || wc.model || 'whisper-1').trim();
    return {
      ...base,
      available: true,
      provider: 'whisper',
      model,
      refine: guard((pcm, rate, signal) => refineWhisper(pcm, rate, { ...wc, baseUrl, refineModel: model }, settings, signal)),
    };
  }

  return { ...base, available: false, provider: String(want), model: '', reason: `未知的重识别方式：${want}` };
}

async function withTimeout(signal, ms = REFINE_TIMEOUT_MS) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
    get timedOut() {
      return timedOut;
    },
  };
}

/** 统一的响应解析：Deepgram 是 results.channels[0].alternatives[0].transcript，OpenAI 风格是 text */
function pickText(data) {
  const dg = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (dg) return String(dg).trim();
  return String(data?.text || '').trim();
}

/**
 * 这次重识别可不可信。
 *
 * whisper.cpp 的 `verbose_json` 会给每个片段的置信度，正好覆盖三类
 * **"读起来像话、其实是模型在编"** 的情况，而且判据就是 Whisper 自己用的那两个：
 *
 *   temperature > 0    —— 解码被判失败后回退到更高温度重试。**幻觉最典型的来源**：
 *                         模型在低温下出不来，就"顺着上下文编一个像样的"。
 *   no_speech_prob 高  —— 这段本来就没人在说话（音乐、音效、静音）。
 *   avg_logprob 低     —— 模型自己都没把握（默认阈值 -1.0）。
 *
 * 没有这道闸门的话，重识别结果会**无条件覆盖**流式文本 —— 本地听错时，
 * 连流式本来听对的也一起被盖掉，结果比不做校正还差。
 */
export function judgeRefinement(data, { minLogprob = -1.0, maxNoSpeech = 0.6 } = {}) {
  const segs = Array.isArray(data?.segments) ? data.segments : [];
  if (!segs.length) return { ok: false, reason: '服务没有返回片段信息（可能不支持 verbose_json）' };
  // ⚠️ 幻听清单是**第二道网**。第一道是下面的 no_speech_prob / avg_logprob，
  // 那个是内容无关、不会误伤的；清单只兜最典型的几句套话。
  // 文本要从 data.text 取，取不到就用各段文本拼 —— 有的服务只填 segments。
  // 而且**只在文本非空时才判**：空文本交给下面那些判据去处理，
  // 否则"没给 text"会被当成"命中幻听"，把正常结果一起误杀（测试抓到过）。
  const fullText = String(data?.text || segs.map((s) => s?.text || '').join(' ')).trim();
  if (fullText && looksLikeHallucination(fullText)) {
    return { ok: false, reason: '命中幻听套话（Whisper 的经典毛病）' };
  }
  let worst = null;
  for (const s of segs) {
    const t = Number(s?.temperature);
    if (Number.isFinite(t) && t > 0) return { ok: false, reason: `解码回退到 temperature=${t}` };
    const ns = Number(s?.no_speech_prob);
    if (Number.isFinite(ns) && ns > maxNoSpeech) {
      return { ok: false, reason: `判定为无人说话（no_speech_prob=${ns.toFixed(2)}）` };
    }
    const lp = Number(s?.avg_logprob);
    if (Number.isFinite(lp)) {
      if (lp < minLogprob) return { ok: false, reason: `置信度低（avg_logprob=${lp.toFixed(2)}）` };
      worst = worst === null ? lp : Math.min(worst, lp);
    }
  }
  return { ok: true, logprob: worst === null ? undefined : worst, segments: segs.length };
}

async function refineDeepgram(pcm, sampleRate, cfg, settings, signal) {
  const endpoint = String(cfg.endpoint || 'wss://api.deepgram.com/v1/listen')
    .replace(/^wss:/, 'https:')
    .replace(/^ws:/, 'http:')
    .replace(/\?.*$/, '');
  const model = String(cfg.refineModel || cfg.model || 'nova-3').trim();
  const language = String(settings?.asr?.language || 'auto').trim();

  const params = new URLSearchParams();
  params.set('model', model);
  params.set('smart_format', 'true'); // 非流式没有定稿挂起的顾虑，标点和大小写直接开
  params.set('punctuate', 'true');
  params.set('encoding', 'linear16');
  params.set('sample_rate', String(sampleRate));
  params.set('channels', '1');

  if (language && language !== 'auto') params.set('language', language);
  else if (/^nova-3/.test(model)) params.set('language', 'multi');
  else params.set('detect_language', 'true');

  // ⚠️ keyterm 上限见 REFINE_KEYTERM_LIMIT 的注释
  if (/^nova-3/.test(model)) {
    for (const k of refineKeyterms(settings, REFINE_KEYTERM_LIMIT)) params.append('keyterm', k);
  }

  const g = await withTimeout(signal);
  try {
    const res = await fetch(`${endpoint}?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Token ${cfg.apiKey}`, 'Content-Type': 'audio/raw' },
      body: pcm,
      signal: g.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? '：' + body.slice(0, 160) : ''}`);
    }
    // Deepgram 非流式没有 Whisper 那套逐段置信度，不做闸门，直接采用
    return { text: pickText(await res.json()), ok: true };
  } finally {
    g.done();
  }
}

async function refineWhisper(pcm, sampleRate, cfg, settings, signal) {
  const wav = encodeWav(pcm, sampleRate);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
  form.append('model', String(cfg.refineModel || cfg.model || 'whisper-1'));
  // ⚠️ 必须是 verbose_json：`json` 只回一个 text，把 temperature / avg_logprob /
  // no_speech_prob 全丢了，也就没东西可以判断"这次是不是在编"。
  // whisper.cpp / faster-whisper 都支持 verbose_json（已实测）。
  form.append('response_format', 'verbose_json');

  // Whisper 的自动语言检测在**短片段**上很不可靠——常常整段转成英文，或者干脆转错语言。
  // 所以语言必须显式传：优先 refine 自己的设置，其次用流式识别那边的语言。
  const lang = String(cfg.language || settings?.asr?.language || '').trim();
  if (lang && lang !== 'auto') form.append('language', lang);

  // 提示词要用**完整设置**去取：术语表和 keyterm 都在那里。
  // 按字符数封顶，超了 Whisper 会开始复读而不是参考。
  const prompt = refinePromptText(settings);
  if (prompt) form.append('prompt', prompt);

  const headers = {};
  const apiKey = String(cfg.apiKey || '').trim();
  // 本地服务通常不要 Key，但 OpenAI SDK 风格的中间层会拒空——留空就不带这个头
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const g = await withTimeout(signal);
  try {
    const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: form,
      signal: g.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? '：' + body.slice(0, 160) : ''}`);
    }
    const data = await res.json();
    return { text: pickText(data), ...judgeRefinement(data) };
  } finally {
    g.done();
  }
}
