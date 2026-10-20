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
 *   上限 = MAX_BATCH_SEC（8 秒）—— 超了就交给兜底强制采纳
 *          （**12 → 8**：批长越短，字幕越不落后。见 `MAX_BATCH_SEC` 的说明）
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
import { hasSilenceIn, leadingSilenceMs } from './silence-span.js';

/** 首批音频长度（秒）。太短 Whisper 断不出东西（实测 5 秒只给 1 段），太长延迟涨。 */
export const FIRST_BATCH_SEC = 6;

/** 之后每批的「新音频」长度（秒）。见文件头「批次长度」。 */
export const CONTINUE_BATCH_SEC = 5;

/**
 * 批次长度上限（秒）。超了就走兜底，免得延迟无界。
 *
 * ⚠️ **12 → 8（2026-10-20，用户定的取舍）**：
 *
 *   批长每多 1 秒，字幕就多晚 1 秒（批要攒够才送得出去），而**画面那边不会等你**。
 *   缓冲填不满时（实测只填到 7.1 秒），12 秒的批结果要到 ≈16 秒才回来 ⇒
 *   字幕**必然**比画面晚好几秒 —— 而**晚是没有上界的**（画面已经过去了，只能补在后面）。
 *   用户的原话：「**批长适当短点也行**」⇒ 宁可少认对一个生僻词，也不要字幕落后。
 *
 *   代价（实测过，写清楚免得以后当成 bug）：
 *     · 生僻专有名词（「コックスプレッシャー」）要 **≈14 秒**批长才认对 ⇒ 8 秒这档**会错** ✗
 *     · 日常句子不受影响 ✓（「だから」「めっちゃ悩むの」在 6~12 秒都对）
 *   ⇒ 6 秒的批**本来就够断出完整句**（实测 `relay-0-8` → 2 段，每段都是完整句），
 *     所以压上限砍掉的是"特别长的批"，不是"能认对的批"。
 */
export const MAX_BATCH_SEC = 8;

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
 * 一批**最少**要有这么长的音频，否则干脆不开批（秒）。
 *
 * ⚠️ 为什么需要它（离线仿真实测，2026-10-20）:
 *   音频放完之后 `next()` 还会被反复调用，而当时只剩 `0.1s` 的碎渣 ⇒
 *   `takeN` 取到 0.1s ⇒ Whisper 对 0.1s **给 0 段** ⇒ 推进点不动 ⇒
 *   下一轮又取同一段 0.1s ⇒ **死循环** ✗
 *   实测（素材 `xhsp_1_16k.wav`，101.4 秒）:批 22~400 全是
 *   `0.1s @101.32 → 0 段 · no-segments · 推进到 101.32` —— **377 批空转** ✗
 *
 * ⚠️ 而"暂时没音频"和"音频到底了"**必须都能停**，不能用同一个判据区分它们 ✗ ——
 *   所以这里只回答"**这批够不够长到值得送一次**"，不回答"是不是没了"：
 *     · 够长 → 开批 ✓（不管后面还有没有）⇒ 暂时没音频时自然地等下一帧 ✓
 *     · 不够长 → 不开批 ✓（到底了也满足这一条）⇒ 死循环消失 ✓
 *   "到底了"另有 `state().drained`（见下），给上层停止调用用 ✓
 *
 * ⚠️ 0.25 的依据:实测 0.1s 的批**一个段都出不来**，而 `SILENCE_CHECK_SEC` 本身就是 0.25 ✓
 *   （比它更短的音频连"确认有没有静音"都做不到）
 */
export const MIN_BATCH_SEC = 0.25;

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
  /** 上一次 `next()` 看到的可用音频位置（绝对采样）。用来算 `drained`。 */
  let lastAvail = null;
  /** 连续多少批"既没采纳、也没有 pending"（= Whisper 一个段都没给）。只做诊断。 */
  let emptyBatches = 0;

  const sec2samp = (s) => Math.round(s * sampleRate);

  /**
   * 把 decideAdvance 返回的 nextStart 换算成**绝对采样**，并保证**单调不倒退**。
   *
   * 为什么需要换算（2026-10-20 实测坐标）:
   *   decideAdvance 的返回值里**混了两种单位**:
   *     · 采纳或停在某段上时 → 返的是段自己的 start/end，那是**相对这一批起点**的
   *       （Whisper 对送进去那段 PCM 从 0 起算）
   *     · NO_SEGMENTS（没拿到可用段）→ 原样返 from，而它是**绝对**的
   *   ⇒ 引擎原来直接把返回值当绝对用 ⇒ 批 2 的 3.9 被当成绝对 3.9s，
   *     于是取样起点**倒退**到批 1 的 4.4s 之前 ⇒ **同一段音频被反复重认**。
   *     实测:3 批共采纳 4 段，却上屏了 **22 句**（同一内容出现 4~7 次）。
   *
   * 为什么还要 Math.max:
   *   即使单位搞对了，任何一次误判都不该让推进点**倒退**——
   *   倒退 = 重认同一段 = 重复字幕，那是比"少认一句"严重得多的错。
   */
  function advanceTo(raw, reason) {
    if (!Number.isFinite(raw) || raw < 0) return nextStart;
    const curSec = nextStart / sampleRate;
    const rel = reason === DECIDE_REASONS.NO_SEGMENTS ? raw - curSec : raw;
    const abs = sec2samp(curSec + Math.max(0, rel));
    return Math.max(nextStart, abs);
  }

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
    lastAvail = avail;
    /**
     * ⭐ **碎渣不开批** —— 见 `MIN_BATCH_SEC` 的说明。
     *    这一条和下面 `allowShort` 是**不同的规矩**：
     *      · 这里问的是"够不够长到值得送一次"（不够就一律不开，收尾时也一样 ✓）
     *      · 下面问的是"要不要为了收尾提前开一批"（只放宽**长度目标**，不放宽**下限**）✓
     *    实测（仿真，101.4 秒素材）:没有这一条时批 22~400 全是 0.1s 的碎渣，
     *    每批一次 HTTP 请求、0 段、推进点不动 ⇒ **377 批空转** ✗
     */
    if (have < sec2samp(MIN_BATCH_SEC)) return null;
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
         *
         * ⚠️ **批太短时"贴批尾"没有意义** ✗
         *    批长 ≤ `tailMarginSec` 时，"离批尾有余量"这个条件**永远不成立** ⇒ 一个都不采纳 ✗
         *    实测（离线仿真，186 秒跑完）：从 185.03s 起批长只有 1.0s，然后是 0.2s，
         *    各**空转 50~60 次**才等到兜底 ✗ —— 在浏览器里那是上百次白跑的请求 ✗
         *    ⇒ 批长不足 `2 × tailMarginSec` 时视为"整批都能听见" ⇒ 直接算确认 ✓
         */
        if (batchLenSec <= 2 * tailMarginSec) return true;
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
      /**
       * ⚠️ 这里加的是「**这一批里没被采纳的音频长度**」，不是 `pending.start - 绝对起点` ✗
       *
       * 原来写的是:
       *   `waitedSec += (decided.pending.start - (nextStart / sampleRate))`
       * 而 `pending.start` 是**相对批起点**的（Whisper 对送进去那段 PCM 从 0 起算）✗，
       * `nextStart / sampleRate` 是**绝对**的 ✗ —— 两者相减没有意义。
       * 更糟：stall 时 `pending.start` 恰好是 0（那句话从批首一直说到批尾）✗，
       * 于是每次 `+= 0 - 0 = 0` ⇒ `waitedSec` **永远不涨** ⇒ **force 分支是死代码** ✗
       *
       * 实测（离线仿真，素材 `火圣害羞了yp.wav` 的 16k 版）:
       *   批 1 = 6.0s → 1 段 `[0-6]` ⇒ `tail-unconfirmed` · 推进到 0.00s
       *   之后每批都是 12.0s / 1 段 / 不采纳 / 推进到 0.00s —— **连续 400 批、采纳 0 段** ✗
       *
       * 为什么"整批一句"会必然 stall：说话人连说 12 秒不停 ⇒ Whisper 只给一个
       * `[0, batchLen]` 的段 ⇒ `end` 贴批尾 ⇒ 按 `boundary` 判据永远"不确认" ✗。
       * 这正是兜底该管的场景 —— 而它被上面那个单位错误关掉了 ✓。
       */
      waitedSec += Math.max(0, batchLenSec - Math.max(0, Number(decided.pending.start) || 0));
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
        nextStart = advanceTo(forced.nextStart, forced.reason);
        return { ...forced, offsetSec, forced: true };
      }
    } else if (decided.accepted.length > 0) {
      // 有进展 ⇒ 等待清零 ✓
      waitedSec = 0;
      emptyBatches = 0;
    } else {
      /**
       * ⚠️ **既没采纳、也没有 pending** —— Whisper 对这批**一个段都没给**。
       *
       * 处理方式:**只计数、不推进、不跳过** ✗✓✓
       *   · 不推进 —— 没有边界可依，硬推就是"按我们的意思切"（= 旧路 ✗）
       *   · ⭐ **也不跳过音频** ✗ —— 因为 `apply([])` 还可能是**识别失败**
       *     （`vad.js` 出错时正是用 `apply([])` 释放 `inflight` 的 ✓），
       *     而那种情况下跳过音频就是**真的丢内容** ✗
       *   · 而**也不清零 `waitedSec`** ✗ —— 那会掩盖"一直没进展"
       *   ⇒ 所以这里只让 `emptyBatches` 涨，由 `state()` 暴露出去，
       *     让"一批接一批 0 段"这件事在日志/断言里**看得见** ✓
       *
       * ⚠️ 已知残余风险（**没有测过，别当成已知** ✗）:
       *   若整段是纯音乐/静音，Whisper 可能对连续多批都给 0 段 ⇒
       *   推进点不动 ⇒ 会反复重取同一段（每次一次 HTTP 请求）✗
       *   —— 要不要"空满这么多秒就跳过去"是**产品决定**，
       *   而现在只有"0.1s 碎渣"那一组实测数据（已由 `MIN_BATCH_SEC` 挡掉 ✓），
       *   不足以支撑"跳过多少秒算安全" ✗
       */
      emptyBatches += 1;
    }

    pending = decided.pending || null;
    // ⚠️ nextStart 只能取 Whisper 给的边界（见文件头依据 ②③）
    nextStart = advanceTo(decided.nextStart, decided.reason);
    return { ...decided, offsetSec, forced: false };
  }

  /**
   * 只读状态，给断言和诊断用。
   *
   * ⚠️ 关于"音频是不是到底了"：**引擎不回答这个** ✗，只回答
   *   「按上一次看到的可用位置，**还剩够不够开一批**」（= `starved`）。
   *
   *   为什么不叫 `drained`：`next(availableSamples)` 拿到的只是"当前可用到哪"，
   *   而**直播中途卡顿**和**真的结束了**在那个数上**长得一模一样** ✗。
   *   把"暂时没音频"当成"到底了"会让字幕**永久停住**——那是比多跑几批严重得多的错 ✗。
   *   ⇒ 所以"到底了"只能由调用方用 `stop()` / `finalize()` 告诉引擎 ✓
   *     （那时它走 `allowShort` + `force` 的收尾路径 ✓）
   */
  function state() {
    const leftSec = lastAvail == null
      ? null
      : Math.max(0, (lastAvail - nextStart) / sampleRate);
    return {
      nextStartSec: nextStart / sampleRate,
      pending: pending ? { ...pending } : null,
      waitedSec,
      inflight: inflight ? { ...inflight } : null,
      batchSec: batchSec(),
      availSec: lastAvail == null ? null : lastAvail / sampleRate,
      leftSec,
      /** 上一次看到的可用音频不足一批 ⇒ 不会再开新批（但**不代表音频结束了** ✗） */
      starved: leftSec != null && leftSec < MIN_BATCH_SEC,
      /** 连续多少批一个段都没给（只做诊断，见 `apply()` 里那段说明） */
      emptyBatches,
    };
  }

  return { next, apply, state, batchSec };
}

/**
 * `seg.start` 小于这个值就当作「被 Whisper 夹到批首」—— 此时它**不携带位置信息** ✗
 *
 * 为什么不是严格的 `=== 0`：Whisper 偶尔给 `0.01` / `0.02` 这种，语义上同样是"批首"；
 * 而 0.02 秒 = 半个 VAD 窗（40ms 窗的一半），比一帧还短，不可能是有意义的语音边界 ✓
 */
const SEG_START_ANCHOR_TRUST_SEC = 0.02;

/**
 * 锚点至少要往后挪这么多才算"真的让掉了一段静音" ✓
 *
 * 为什么不是"挪一点就动"：帧粒度是 40ms，而"第一帧概率过线"可能只是因为
 * 跨在段起点上的那一帧刚好差一点 ⇒ 会平白挪 40ms。而 40ms **没有任何意义** ✗
 * —— 用户要的是"短句必须准"，40ms 的抖动只会让本来正确的段变得不一致 ✓
 *
 * 而真正的病是音乐床 3.66 秒、换气 0.8 秒这种量级 ⇒ 100ms 的门槛一个都不会漏 ✓
 */
const MIN_ANCHOR_SHIFT_SEC = 0.1;

/**
 * 一个被采纳的段，**该在什么时刻上屏**（绝对秒）—— 把开头那段静音让掉。
 *
 * ## 为什么需要它
 *
 * 批起点 = **上一句已采纳的 `end`**，而 Whisper 给的 `segments[0].start` **几乎总是 0**
 * ⇒ `offsetSec + seg.start` 就落在**批起点**上 —— 而那里**可能正是一段换气/静音的开头** ✗
 * 于是字幕在**人还没开口**时就上屏了，提前的时长正好等于开头那段静音（换气 0.5~1.5 秒）✗
 *
 * ⚠️ **旧路没有这个问题**：VAD 切出来的片起点就在语音里 ✓ —— 所以这个函数只给新路用 ✗
 *
 * ## 为什么提成函数而不是写在 `vad.js` 里
 *
 * 因为**离线仿真也要用它**（`browser-test/newpath-sim.cjs` 直接调引擎、不走 `vad.js`）。
 * 写在 `vad.js` 里的话，仿真量出来的就不是真机那条路上算的值了 ✗
 * —— 而"仿真的数和真机不一致"这一整天栽过多次 ✓
 *
 * ## ⭐ 锚点用 VAD 概率，不用音频电平 ✗
 *
 * 原来只用 `leadingSilenceMs`（相对 RMS）去找"开头那段静音有多长"。实测在真实直播上
 * **不可行** ✗：音乐床 RMS 0.008~0.019、语音 0.064，只差 3~6 倍；而真正轻柔的语音
 * 比音乐床还低。`lullRatio` 扫过 0.20/0.25/0.30/0.40/0.50 —— 0.20~0.40 挪不够
 * （需要 3160ms，最多只挪 1120ms），0.50 能挪对那一条却把另外两条本来正确的段
 * 带偏 600/800ms ✗。同一个方向还试过「语音电平 0.5×p90 + 持续 200ms」，净负收益 ✗。
 *
 * 而 **VAD 概率分得开**：同一份真机日志里音乐床 0.199 / 0.007，开口后 0.978 ✓。
 * 而旧路（VAD 切句）的时机是用户认可的 ⇒ **同一个信号、同一个判据** ✓
 *
 * ⇒ `firstSpeechAt(fromSec, toSec)` 由 `vad.js` 注入（它持有逐帧概率历史）。
 *
 * ⚠️ 只在 `seg.start ≈ 0` 时用它：`seg.start > 0` 时 Whisper 给了真实边界，
 *    覆盖它反而会把本来对的段挪歪 ✗
 * ⚠️ 找不到语音（VAD 全低 / 没历史 / 回调抛错）⇒ **保持原样往下走** ✓
 *    （别乱挪：那可能真是一段静音 ✓）
 *
 * ## 行为
 *
 * · `seg.start ≈ 0` 且 VAD 指出开口在本段内 ⇒ 返回**那个开口时刻** ✓
 * · 段内没有停顿 / 判不了 / 脏输入 ⇒ 返回 `offsetSec + seg.start`，
 *   **和改之前逐字一样** ✓（不确定就不要引入新行为 ✓）
 */
export function shownStartOf({
  offsetSec,
  seg,
  pcm,
  sampleRate = 16000,
  firstSpeechAt = null,
  speechThreshold = null,
} = {}) {
  const base = Number(offsetSec) + Number(seg?.start);
  if (!Number.isFinite(base)) return Number(seg?.start) || 0;
  const endAbs = base + Math.max(0, Number(seg?.end) - Number(seg?.start));

  if (typeof firstSpeechAt === 'function' && endAbs > base) {
    const startNum = Number(seg?.start);
    /**
     * `seg.start` 小于一帧的一半就没携带位置信息（Whisper 把它夹在批首了）✗
     * 用 `<=` 而不是 `=== 0`：`0.01` / `0.02` 这种是同一件事 ✓
     */
    const clamped = !Number.isFinite(startNum) || Math.abs(startNum) <= SEG_START_ANCHOR_TRUST_SEC;
    if (clamped) {
      try {
        const found = firstSpeechAt(base, endAbs, speechThreshold);
        /**
         * 三个条件都要满足才采信：
         * ① `Number.isFinite` —— 回调可能返回 `null` / `NaN` ✓
         * ② `found - base >= MIN_ANCHOR_SHIFT_SEC` —— 真的让掉了一段静音；
         *    只差一帧（40ms）就动它，只会把本来正确的段挪歪 ✗
         * ③ `found < endAbs` —— 找到的开口还在本段内，否则那是下一句的事 ✗
         */
        if (
          Number.isFinite(found) &&
          found - base >= MIN_ANCHOR_SHIFT_SEC &&
          found < endAbs
        ) {
          return found;
        }
      } catch {
        // 一个锚点判断不该把整条识别链带下水 ✗
      }
    }
  }

  if (!pcm || typeof pcm.subarray !== 'function') return base;
  if (!(sampleRate > 0)) return base;

  const from = Math.max(0, Math.round(Number(seg.start) * sampleRate));
  const to = Math.min(pcm.length, Math.round(Number(seg.end) * sampleRate));
  if (!(to > from)) return base;

  const leadMs = leadingSilenceMs(pcm.subarray(from, to), { sampleRate });
  return leadMs > 0 ? base + leadMs / 1000 : base;
}

export { DECIDE_REASONS };
