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
 * 段 `end` 距批尾小于这个值 ⇒ 视为"可能被批长截断的半个词" ⇒ 不确认（秒）。
 *
 * ⚠️ 0.35 不是拍脑袋：Whisper 的段边界实测**会落在整秒上**（4.00 / 8.00 / 11.00 / 12.00），
 *    所以"贴批尾"表现为 `end == batchLen`（差 0）或差几十毫秒 ✗。
 *    留 0.35 秒余量既容得下这一点，又不会把"倒数第二段"误判成批尾 ✓
 */
export const TAIL_MARGIN_SEC = 0.35;

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
 *   isTextTrustworthy?: (seg: object, ctx: object) => boolean,
 * }} opts
 *   · `isTextTrustworthy` —— **幻觉判据的注入点**（透传给 `decideAdvance`）。
 *     不传 → 完全跳过那道判据，行为与加它之前逐字一样 ✓
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
    isTextTrustworthy = null,
    /**
     * ⭐ 确认判据的模式 —— **默认 `'boundary'`** ✓
     *
     *   'boundary'：`end` 没贴在批尾 ⇒ 算确认（Whisper 在完整听到的情况下断的）
     *   'silence' ：`end` 之后 250ms 内要有 ≥200ms 静音（**已被实测否决** ✗）
     *
     * ⚠️ 为什么默认不是 'silence'：用户素材里句间停顿只有 **0~120ms**，
     *    而门槛是 200ms ⇒ 永远不成立 ⇒ 零句 ✗（见 `apply()` 里的实测数据）
     */
    confirmMode = 'boundary',
    /** 段 `end` 距批尾小于这个值 ⇒ 视为"可能被批长截断" ⇒ 不确认（秒） */
    tailMarginSec = TAIL_MARGIN_SEC,
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
  function next(availableSamples, opts = {}) {
    if (inflight) return null;
    const avail = Number(availableSamples);
    if (!Number.isFinite(avail)) return null;
    if (avail <= nextStart) return null;

    const want = sec2samp(batchSec());
    const have = avail - nextStart;
    /**
     * ⚠️ `allowShort` 只给**收尾**用（`stop()` / `finalize()`）✓
     *    平时音频不够长就等 ✓；而收尾时**不会再有新音频了**，再等就是丢掉最后一句 ✗
     */
    if (have < want && opts.allowShort !== true) {
      // 不够长：等。但已经等满 maxBatchSec 就放行（兜底靠 decideAdvance 的 force）。
      return null;
    }

    const takeN = Math.min(want, have);
    const pcm = takeRange(nextStart, nextStart + takeN);
    if (!pcm || !pcm.length) return null;

    inflight = {
      offsetSec: nextStart / sampleRate,
      samples: pcm.length,
      /** 这一批实际的音频长度（秒）—— 判「是不是批尾那段」要用 ✓ */
      batchSec: pcm.length / sampleRate,
    };
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
  function apply(segments, opts = {}) {
    if (!inflight) throw new Error('createSegmentLoop: apply() 之前要先 next()');
    const { offsetSec, batchSec: batchLenSec } = inflight;
    inflight = null;

    const decided = decideAdvance(segments, {
      from: offsetSec,
      // ⚠️ 幻觉判据（字数/时长 · 极短尾巴）由调用方注入 —— 它们是 `vad.js` 里
      //    **今天刚修好**的两条，别在引擎里另写一份（同一事实记两遍这一族栽过多次 ✗）
      ...(typeof isTextTrustworthy === 'function' ? { isTextTrustworthy } : {}),
      /**
       * ⭐ 「这个边界算不算确认」—— 这个名字在 `decideAdvance` 那边叫 `hasSilenceAfter`，
       *    而**默认模式已经不是"检测静音"了** ✗。原因见下面 `confirmMode` 的注释。
       */
      hasSilenceAfter: (endRel) => {
        if (confirmMode === 'silence') {
          // 旧判据（保留可切回，便于 A/B）：end 之后 silenceCheckSec 内有没有 200ms 静音
          const from = nextStart + sec2samp(endRel);
          const to = from + sec2samp(silenceCheckSec);
          const slice = takeRange(from, to);
          if (!slice || !slice.length) return false;
          return hasSilenceIn(slice);
        }
        /**
         * ⭐ **默认：批尾以外都算确认** ✓
         *
         * 实测（用户素材 `xhsp.mp4`，47 秒直播片段，5 份导出）：
         *   · 整段里**只有开头约 1 秒是真静音**，其余全是连续说话 ✗
         *   · Whisper 的句子边界（4.00 / 8.00 / 11.00 / 12.00，离线实测每段都是完整句）
         *     之后最长的安静只有 **0 / 40 / 0 / 0 ms** ✗
         *   · 窗口放宽到 1 秒也只有 0~160ms ✗
         *   ⇒ **这个素材的句间停顿本来就远小于 `SILENCE_MIN_MS`(200ms)** ✗
         *   ⇒ 「等静音确认」在这类连续直播上**永远不会成立** —— 实测三批全部
         *      `tail-unconfirmed`、`nextStart` 停在 0.0s ⇒ **零句** ✗✓✓
         *
         * ⭐ 而 Whisper 的边界是**语言学**断的，不是声学停顿 ✗ ——
         *    所以正确的"这句话说完了没"的信号是：
         *    **它没有贴在批尾**（贴在批尾的段可能是被批长截断的半句 ✗）
         *    ⇒ 只要 `end` 离批尾还有余量，这个边界就是 Whisper 在**完整听到**的情况下断的 ✓
         *    ⇒ 采纳它 ✓，而**最后那段留作 `pending`**，下一批从它的 `start` 连续重采 ✓
         *    —— 这正是用户原本的设计（"剩下的和后面一起，而不是合成"）✓✓✓
         */
        return endRel < batchLenSec - tailMarginSec;
      },
      /**
       * ⚠️ `force` 只由**收尾**（`stop()` / `finalize()`）传进来 ✓
       *    那时不会再有新音频了，尾巴再不采纳就永远不上屏 ✗
       *    平时一律 `false` —— 硬推没确认的尾巴是旧路的毛病，新路不学它 ✓
       */
      force: opts.force === true,
    });

    // 兜底：一个都没采纳，且已经等够 maxBatchSec ⇒ 强制采纳最后一段的 end
    if (!decided.accepted.length && decided.pending) {
      waitedSec += (decided.pending.start - (nextStart / sampleRate));
      if (waitedSec >= maxBatchSec) {
        // ⚠️ 兜底那一次**也要带 `isTextTrustworthy`** ✗ —— `decideAdvance` 的 force 分支
        //    会用它对 `usable` 再过滤一遍（force 的语义是"等不及了",不是"幻觉也可以上屏"✓）。
        //    漏传的话,兜底那一下会把刚刚判成"不可信"的段硬推上屏 ✗
        const forced = decideAdvance(segments, {
          from: offsetSec,
          ...(typeof isTextTrustworthy === 'function' ? { isTextTrustworthy } : {}),
          force: true,
        });
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
