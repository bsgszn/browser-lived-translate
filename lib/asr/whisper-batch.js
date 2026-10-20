/**
 * 按 Whisper 的句子边界推进的批次循环（新断句路径的「引擎」）。
 *
 * ⚠️ 这个模块**不碰主链**：它不 import `vad.js`，也不读写任何全局状态。
 *    `takeRange`（取连续原始 PCM）和 `transcribe`（送一次 Whisper）都由调用方注入，
 *    所以它可以在 Node 里用假实现完整测出来——这正是本项目的约定
 *    （「要断言的行为落在 lib/」）。
 *
 * ## 为什么要有它
 *
 * 旧路是 **VAD 先切、切完再送**：每一片都是「从某个电平突变点开始」的音频，
 * 于是**片头永远是半个词**。真机上抓到的三个标本：
 *
 *   · 「**ネコ**の真似してほしいって」被切成两半 → 认成「この場」✗
 *   · 「また**コックスプレッシャー**だと」被切成三片 → 认成「蝶用」「石窟」「セックス」✗
 *   · 「**だから**やっぱ」的「だから」两轮都缺 —— 它正好压在硬切边界上 ✗
 *
 * 新路的做法相反：**让 Whisper 自己断句，按它给的边界推进**，VAD 只回答
 * 「这一段结束之后有没有静音」（= 那句到底说完了没）。
 *
 * ## 三条实测依据（换掉任何一条这个设计都要重做）
 *
 * ① **从句子边界起送 8~14 秒，Whisper 会把音频断成完整句子**
 *    `relay-0-8`（0~8s）→ 2 段：`[0.00-4.00] そうなんだよね` · `[4.00-8.00] ティールで一瞬で…`
 *    `relay-0-14`（0~14s）→ 5 段：4.00 / 8.00 / 11.00 / 12.00 / 14.00，**每段都是完整句**
 *
 * ② 🔴 **从 6.5 秒（非句子边界）起送 → 第一段就缺字**
 *    `relay-65-8` 第一段 `[0.00-1.68]`「**一瞬で今流れたりするからね**」✗
 *    而完整句是「**ティールで**一瞬で流れたりするからね」→ **「ティールで」被切掉** ✗
 *
 * ③ ⚠️ **换起点还会改变段数和边界**
 *    `relay-0-14` 是 4/8/11/12 · `relay-65-14` 是 1.64/4.74/7.38/8.20/11.56
 *    ⇒ 起点一错，整段结果都不可靠。
 *
 * ⇒ 所以 `nextStart` **只能取 Whisper 给的 `start` / `end`**，不能自己拍一个时间点。
 *
 * ## 批次长度（用户定的规则，别改成固定值）
 *
 *   首批 = FIRST_BATCH_SEC（6 秒）
 *   之后 = **剩的尾巴 + CONTINUE_BATCH_SEC（5 秒）**
 *   上限 = MAX_BATCH_SEC（12 秒）—— 超了就交给兜底强制采纳
 *
 * ⚠️ 为什么不是「固定 6 秒」：尾巴剩 3 秒时固定 6 秒**只处理 3 秒新音频**，
 *    推进速度会减半，字幕跟不上。用「尾巴 + 5 秒」则每批**至少处理 5 秒新音频**，
 *    推进速度恒定。代价是批次长度浮动 ⇒ 延迟浮动 ⇒ 排期要按实测延迟算
 *    （项目已有「延迟测量」那一行，正是为此）。
 *
 * ## 兜底：不用 VAD 找切点
 *
 * 一直没采纳（有人一口气说不停）时，**强制采纳 Whisper 最后一个 segment 的 `end`**。
 * 不用 VAD 的原因：Whisper 给的边界至少是**词边界**（实测那条第三段是「あれピンクと黒」，
 * 半句但**不是半个词**），而 VAD 给的是**电平方差突变点**，可能落在词中间。
 */

import { decideAdvance, DECIDE_REASONS } from './whisper-segments.js';
import { hasSilenceIn } from './silence-span.js';

/** 首批音频长度（秒）。太短 Whisper 断不出东西（实测 5 秒只给 1 段），太长延迟涨。 */
export const FIRST_BATCH_SEC = 6;

/** 之后每批的「新音频」长度（秒）。见文件头「批次长度」。 */
export const CONTINUE_BATCH_SEC = 5;

/** 批次长度上限（秒）。超了就走兜底，免得延迟无界。 */
export const MAX_BATCH_SEC = 12;

/** 静音确认窗口（秒）。Whisper 说这段 `end` 了，我们只看它之后这么长的音频。 */
export const SILENCE_CHECK_SEC = 0.25;

/**
 * 一个批次循环。调用方每轮：
 *
 * ```js
 *   const loop = createSegmentLoop({ takeRange, transcribe, sampleRate });
 *   // 有新音频了（push 之后）
 *   const plan = loop.next();            // 返回该送什么，或 null（还不够长）
 *   if (plan) {
 *     const segs = await transcribe(plan.pcm, plan.offsetSec);   // 送 Whisper
 *     const out  = loop.apply(segs);                             // 决定采纳什么、推进到哪
 *     for (const s of out.accepted) enqueueSubtitle(s);
 *   }
 * ```
 *
 * `takeRange(absStart, absEnd)` —— **绝对采样位置**的连续 PCM（`Int16Array`）。
 *   调用方直接传 `vad.js` 里那个 `takeRange` 即可。
 * `transcribe(pcm, offsetSec)` —— 送一次 Whisper，返回 segments（`[{start,end,text}]`），
 *   其中 `start`/`end` 是**相对这批音频开头**的秒数（OpenAI 口径）。
 * `sampleRate` —— 采样率，用来把秒换成采样位置。
 *
 * @param {{
 *   takeRange: (absStart: number, absEnd: number) => Int16Array|null,
 *   transcribe: (pcm: Int16Array, offsetSec: number) => Promise<any[]>,
 *   sampleRate?: number,
 *   firstBatchSec?: number, continueBatchSec?: number, maxBatchSec?: number,
 *   silenceCheckSec?: number,
 * }} opts
 */
export function createSegmentLoop(opts = {}) {
  const {
    takeRange,
    transcribe,
    sampleRate = 16000,
    firstBatchSec = FIRST_BATCH_SEC,
    continueBatchSec = CONTINUE_BATCH_SEC,
    maxBatchSec = MAX_BATCH_SEC,
    silenceCheckSec = SILENCE_CHECK_SEC,
  } = opts;

  if (typeof takeRange !== 'function') throw new TypeError('createSegmentLoop: takeRange 必填');
  if (typeof transcribe !== 'function') throw new TypeError('createSegmentLoop: transcribe 必填');

  /** 绝对采样位置：上一句已采纳的 end（× sampleRate）。第一句从 0 开始。 */
  let nextStart = 0;
  /** 上一轮没采纳的段（`{start,end,text}`，相对那一批的秒数），用来算下一批的「尾巴」。 */
  let pending = null;
  /** 正在飞的那一批（防重入）。 */
  let inflight = null;
  /** 兜底用的累计等待（秒）：连续多少秒的音频都没被采纳。 */
  let waitedSec = 0;

  const sec2samp = (s) => Math.round(s * sampleRate);

  /**
   * 这一批该取多长（秒）。
   * 首批 = firstBatchSec · 之后 = 尾巴 + continueBatchSec，封顶 maxBatchSec。
   */
  function batchSec() {
    if (nextStart === 0 && pending == null) return Math.min(firstBatchSec, maxBatchSec);
    const tail = pending ? Math.max(0, pending.end - pending.start) : 0;
    return Math.min(maxBatchSec, tail + continueBatchSec);
  }

  /**
   * 该不该开下一批。`availableSamples` 是**当前可用到的绝对采样位置**
   * （调用方传 `totalSamples`）。不够长就等——**但超了 maxBatchSec 就放行**，
   * 否则音频一直不够长会永远不出字幕。
   */
  function next(availableSamples) {
    if (inflight) return null;
    const avail = Number(availableSamples);
    if (!Number.isFinite(avail)) return null;
    if (avail <= nextStart) return null;

    const want = sec2samp(batchSec());
    const have = avail - nextStart;
    if (have < want) {
      // 不够长：等。但已经等满 maxBatchSec 就放行（兜底靠 decideAdvance 的 force）。
      return null;
    }

    const pcm = takeRange(nextStart, nextStart + want);
    if (!pcm || !pcm.length) return null;

    inflight = { offsetSec: nextStart / sampleRate, samples: pcm.length };
    return { pcm, offsetSec: inflight.offsetSec, force: false };
  }

  /**
   * 把一批 Whisper 结果喂进来。返回 `decideAdvance` 的结果，外加 `offsetSec`，
   * 方便调用方把相对时间换算成绝对时间。
   *
   * ⚠️ 静音确认走 `hasSilenceIn`：取该段 `end` 之后 `silenceCheckSec` 的**原始 PCM**。
   *    注意 `SILENCE_MIN_MS` 是 200 而判定单位是 40ms 窗 ⇒ 210ms 之类的窗口会判 false，
   *    所以这里取 250ms（判"≥200ms 静音"这件事用它刚好够）。
   */
  function apply(segments) {
    if (!inflight) throw new Error('createSegmentLoop: apply() 之前要先 next()');
    const { offsetSec } = inflight;
    inflight = null;

    const decided = decideAdvance(segments, {
      from: offsetSec,
      hasSilenceAfter: (endRel) => {
        // endRel 是相对这批开头的秒数 → 换成绝对采样位置
        const from = nextStart + sec2samp(endRel);
        const to = from + sec2samp(silenceCheckSec);
        const slice = takeRange(from, to);
        // 判不了（拿不到音频）当「没静音」⇒ 不采纳 ⇒ 等下一批。保守方向。
        if (!slice || !slice.length) return false;
        return hasSilenceIn(slice);
      },
      force: false,
    });

    // 兜底：一个都没采纳，且已经等够 maxBatchSec ⇒ 强制采纳最后一段的 end
    if (!decided.accepted.length && decided.pending) {
      waitedSec += (decided.pending.start - (nextStart / sampleRate));
      if (waitedSec >= maxBatchSec) {
        const forced = decideAdvance(segments, { from: offsetSec, force: true });
        waitedSec = 0;
        pending = forced.pending || null;
        nextStart = forced.nextStart >= 0 ? sec2samp(forced.nextStart) : nextStart;
        return { ...forced, offsetSec, forced: true };
      }
    } else {
      waitedSec = 0;
    }

    pending = decided.pending || null;
    // ⚠️ nextStart 只能取 Whisper 给的边界（见文件头依据 ②③）
    if (Number.isFinite(decided.nextStart) && decided.nextStart >= 0) {
      nextStart = sec2samp(decided.nextStart);
    }
    return { ...decided, offsetSec, forced: false };
  }

  /** 只读状态，给断言和诊断用。 */
  function state() {
    return {
      nextStartSec: nextStart / sampleRate,
      pending: pending ? { ...pending } : null,
      waitedSec,
      inflight: inflight ? { ...inflight } : null,
      batchSec: batchSec(),
    };
  }

  return { next, apply, state, batchSec };
}

export { DECIDE_REASONS };
