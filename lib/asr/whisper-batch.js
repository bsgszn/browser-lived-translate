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
 * **一批里第 2 段及之后**：`seg.start` 的信任窗口 —— **无上限（每一段都问 VAD）** ✓
 *
 * 原来这里是 0.02 秒的严格窗口 ⇒ 非首段的 `seg.start` 只要 >0.02 就**完全不问 VAD** ✗
 * ⇒ 一批 3 段时，第 2、3 段的 `at` 全靠 Whisper 的段边界 ✓
 *
 * 而那个边界在 **Whisper 合并段**时是错的 ✗：
 * 它会「前导短音（♪ / 换气 / 「あ」）+ 后面的句子」合成一段，
 * 段起点落在**前导短音**上 ⇒ 那几句照样提前 ✓
 *
 * ⇒ 改成 `Infinity`：**每一段都在自己的区间里找自己的开口** ✓
 * ⚠️ 而**不会**把本来正确的段挪歪：`found - base >= MIN_ANCHOR_SHIFT_SEC`（0.1 秒）那道闸 ✗
 *    —— 段起点就是开口时，VAD 在 `base` 处就找到 ⇒ 位移 0 ⇒ 拒绝 ⇒ 保持 `seg.start` ✓
 * ⚠️ 多问几次 VAD 的代价 = 每次扫最多 8 秒 × 25fps = 200 帧，纯数值比较 ✓（不是模型推理 ✓）
 *
 * 原来的 `SEG_START_ANCHOR_TRUST_SEC = 0.02` 已随这次改动删除 ✓（它唯一的用途就是这个窗口 ✗）
 */
const NON_FIRST_SEG_ANCHOR_TRUST_SEC = Infinity;

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
 * **一批里的第一段**：`seg.start` 只要小于这个值，就同样当作"被夹在批首" ✗
 *
 * ## 为什么第一段要放宽到 1 秒（而其余段只有 0.02）
 *
 * Whisper 对一批里的**第一段**，起点是"从批首开始听"的产物，**不是**它听到的真实开口 ✗。
 * 实测（同一份素材、两轮闭环、都延迟 10、按内容配对 37 对）：
 * ```
 * 提前 >0.5s 的 12 条里，9 条满足「新路跨度比旧路长 >1s」
 *   −5.89s 旧跨 6.4s → 新跨 8.0s   ← 把 1.6 秒的前缀吃进了段里
 *   −2.78s 旧跨 2.0s → 新跨 4.0s
 *   −1.63s 旧跨 2.1s → 新跨 4.0s   ← 同一句「そうなんだよね」，sim 1.00
 * ```
 * ⇒ 那 8 条的 `seg.start` 落在 **0.02 秒以上**，于是旧的 0.02 门槛**根本不去问 VAD** ✗
 * ⇒ 而"批首段 + 段变长"这两件事一起出现，正是"起点被夹在批首"的指纹 ✓
 *
 * 而**第一段之后**的段不同：它们的 `seg.start` 是 Whisper 听完整个批之后给出的
 * **段间边界**，那个携带真实位置信息 ⇒ 保持 0.02 的严格门槛 ✓（不许覆盖 ✗）
 *
 * ⚠️ 1 秒这个上限不是随便取的：批最长 8 秒，而"音乐床/换气"的病是 0.8~3.7 秒量级；
 *    若 `seg.start >= 1` 秒，Whisper 已经在说"这一批开头有 1 秒以上没有语音" ——
 *    那种情形 VAD 会给出同样的答案，覆盖它没有收益，反而多一次调用 ✓
 */
const FIRST_SEG_ANCHOR_TRUST_SEC = 1;

/**
 * ## 词级时间戳（`segments[].words`）—— 实测之后才知道它能干什么
 *
 * `response_format=verbose_json` 的**每个 `segments[i]` 里都有 `words[]`**（每个词带
 * `word` / `start` / `end`），而**顶层没有 `words`** ✗ —— 只读顶层会以为"服务端不支持"
 * （`whisper-chunked.js:collectWords` 那条老坑的注释就写着这句 ✗）。
 *
 * ## 它在 `at` 上**没有**帮助（别指望 ✗）
 *
 * 把用户那份 wav 的可疑 5 段逐段切出来送 8080，比对「`words[0].start`」与「`seg.start`」：
 * ```
 * A-①  18 词 · 语音占 [0.00, 3.05] · 段声明 [0.00, 3.06] · 差 0.00
 * A-②  12 词 · 语音占 [3.06, 7.62] · 段声明 [3.06, 7.62] · 差 0.00
 * B     15 词 · 语音占 [0.00, 5.69] · 段声明 [0.00, 5.70] · 差 0.00
 * C     12 词 · 语音占 [0.00, 6.04] · 段声明 [0.00, 6.06] · 差 0.00
 * D-①   5 词 · 语音占 [0.07, 2.35] · 段声明 [0.00, 2.40] · 差 0.07
 * D-②  11 词 · 语音占 [2.40, 4.40] · 段声明 [2.40, 4.40] · 差 0.00
 * E     **1 词** · 语音占 [0.00, 2.00] · 段声明 [0.00, 2.00]
 * ```
 * ⇒ ⭐ **`seg.start` 已经贴着第一个词**（最大差 0.07 秒）✗
 *    ⇒ **"用 `words[0].start` 重做 `at`"不会有任何改变** ✗
 *    ⇒ 同时也**推翻了"音乐在前/在后"那个假设** ✗（语音真的贴着段的两端 ✓）
 *
 * ## 它真正能治的是「垃圾段」✗
 *
 * `E` 那段 `1 个词占 2.00 秒` —— 那 2 秒里**没有语音** ✗
 * 而 `looksTooSlowForAudio` 要求 `跨度 ≥ 6 秒` ⇒ **2 秒的段它拦不住** ✗
 *
 * ## 为什么"词均时长"比"字/秒"准
 *
 * 「字/秒」把**词与词之间的停顿**也算成"说话"✗ —— 而那个人说话本来就带停顿
 * （实测 `可能@5.60 → 性@6.94 → が@7.62`：1.3 秒一个字，可那**不是**音乐 ✗）。
 * 「词均时长」看的是**每个词占多久**：正常段 0.17~0.50 秒/词 ✓，而 `E` 是 **2.00 秒/词** ✗
 */
/**
 * 「词均时长」的上限（秒/词）。超过它 ⇒ 这一段基本没人说话 ✗
 *
 * ## ⚠️ 原来是 0.8，而它**误杀真话** ✗ —— 闭环实录
 *
 * ```
 * そうなんだよね   3 词 / 3.02s = 1.01 秒/词   ← **正常的一句话** ✗ 被 0.8 拦掉
 * ですね           1 词 / 4.99s = 4.99 秒/词   ← 那才是垃圾 ✓
 * ん               1 词 / 2.00s = 2.00 秒/词   ← E 段，那 2 秒里没有语音 ✓
 * ```
 *
 * 用户的原话:「**语气词或者短一点的被丢了**」✗ —— 而 0.8 正是那个凶手 ✓
 *
 * ## 取值区间的两端都是实测数据，不能随便挑
 *
 * · **下界 1.10**（必须放过）:「そうなんだよね」实测 1.01~1.10 秒/词 ⇒ 阈值必须 **> 1.10**
 * · **上界 2.00**（必须拦住）:`E` 段 1 词占 2.00 秒 ⇒ 阈值必须 **< 2.00**（`>` 是严格比较 ✗）
 *
 * ⇒ 所以**不能取整到 2.0** ✗：`2.00 > 2.0` 是 **false** ⇒ `E` 段会**漏过去**，
 *   而 `E` 正是这个判据被加进来的**理由**（`looksTooSlowForAudio` 要跨度 ≥6 秒，拦不住 2 秒的段）✗
 *
 * ⇒ 在 `(1.10, 2.00)` 里**贴着上界取 1.9** ✓ ——
 *   离"放过真话"那一侧留 1.73 倍余量（用户的抱怨是**丢内容**，所以偏保守 ✓），
 *   而离 `E` 只有 1.05 倍 ⇒ 这是刻意压着上界，为的是**不放过垃圾** ✓
 */
export const WORDS_MAX_AVG_WORD_SEC = 1.9;
export const WORDS_MIN_SPAN_SEC = 1.0;

/** 只认 `typeof === 'number'` —— `Number(null) === 0` 那族（今天栽过三次 ✗） */
function finiteNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 这一段的**第一个词从哪一刻开始**（和 `seg.start` 同一坐标系：相对本次请求）。
 *
 * @returns {number|null} 拿不到 / 不可信 ⇒ `null`（调用方退回 `seg.start` ✓）
 *
 * ⚠️ **两种形态都要兜**（`whisper-chunked.js:collectWords` 的老经验 ✓）：
 *    · 词时间**相对本次请求**（faster-whisper 的 `verbose_json` 就是这种 ✓）⇒ 直接用
 *    · 词时间**相对本段**（少见，但要兜 ✗）⇒ 补上 `seg.start`
 */
export function wordsStartOf(seg) {
  const segStart = finiteNum(seg?.start);
  const segEnd = finiteNum(seg?.end);
  if (segStart === null || segEnd === null || !(segEnd > segStart)) return null;
  const ws = Array.isArray(seg?.words) ? seg.words : [];
  if (!ws.length) return null;
  const first = finiteNum(ws[0]?.start);
  if (first === null || first < 0) return null;
  /**
   * 是"相对本段"吗：第一个词的起点**明显小于**本段起点 ⇒ 只能是相对时间 ✓
   * （请求级时间下 `first` 应 ≈ `segStart`，不会小 0.5 秒 ✓）
   */
  if (first + 0.5 < segStart) {
    const abs = segStart + first;
    return abs <= segEnd ? abs : null;
  }
  return first <= segEnd ? first : null;
}

/**
 * 这一段**是不是"词少而时长长"** —— 即那几秒里几乎没有语音 ✗
 *
 * 判据：`(末词.end − 首词.start) / 词数 > WORDS_MAX_AVG_WORD_SEC`
 *     且 `跨度 ≥ WORDS_MIN_SPAN_SEC`（太短的段不下结论 ✓）
 *
 * 实测余量（阈值 `WORDS_MAX_AVG_WORD_SEC = 1.9`，见常量处的完整依据）:
 *   · 正常段 **0.17~0.50 秒/词**（A 18 词 3.05 秒 / C 12 词 6.04 秒）✓
 *   · 而**慢一点的真话**能到 **1.01~1.10 秒/词**（「そうなんだよね」3 词 3.02 秒）✓ 必须放过
 *   · 垃圾段 **2.00**（`E`）／ **4.99**（「ですね」）✗ 必须拦住
 *
 * ⚠️ 没有 `words` ⇒ 返回 `false`（**不判** ✓ —— 宁可放过，交给旧的 `looksTooSlowForAudio` ✓）
 */
export function looksTooSlowByWords(seg, opts = {}) {
  const { maxAvgWordSec = WORDS_MAX_AVG_WORD_SEC, minSpanSec = WORDS_MIN_SPAN_SEC } = opts;
  const ws = Array.isArray(seg?.words) ? seg.words : [];
  if (!ws.length) return false;
  /** 首末词都要有合法时间，否则算出来的均值是假的 ✗ */
  const firstStart = finiteNum(ws[0]?.start);
  const lastEnd = finiteNum(ws[ws.length - 1]?.end);
  if (firstStart === null || lastEnd === null) return false;
  const span = lastEnd - firstStart;
  if (!(span >= minSpanSec)) return false;
  return span / ws.length > maxAvgWordSec;
}

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
/**
 * 🔴 **总开关：VAD 开口锚参不参与 `at`** —— 用户 2026-10-23 说「先关掉试试」✗
 *
 * ## 为什么关（依据是量出来的，不是猜的 ✓）
 *
 * 词级时间戳实测：把 5 段可疑段逐段切出来单独送 8080，比对 `words[0].start` 与 `seg.start`：
 *
 * ```
 * A-① 18 词 [0.00,3.05] vs 段 [0.00,3.06] 差 0.00   A-② 12 词 [3.06,7.62] vs [3.06,7.62] 差 0.00
 * B   15 词 [0.00,5.69] vs [0.00,5.70] 差 0.00      C   12 词 [0.00,6.04] vs [0.00,6.06] 差 0.00
 * D-①  5 词 [0.07,2.35] vs [0.00,2.40] 差 **0.07**  D-② 11 词 [2.40,4.40] vs [2.40,4.40] 差 0.00
 * ```
 *
 * ⇒ ⭐ **`seg.start` 已经贴着"第一个词"**（最大差 0.07 秒）✗
 * ⇒ 所以 VAD 锚**是在改一个本来就对的数** ✗ —— 而它把 `at` 挪**分散**
 *    （闭环实测单次最多挪 **2.6 秒**）⇒ 副作用：同一拍（≤50ms）到期的条目变少
 *    ⇒ 用户明确要过的「同批一起出现」失效 ✗（「屏上批量」**8~13 次 → 0 次** ✗）
 *
 * ## 关掉之后**保留**什么（都是和锚无关的东西 ✓）
 *
 * · **段内切分**（`planPauseSplit`）✓ · **词均时长判据**（`looksTooSlowByWords`）✓
 * · **词级时间戳当起点**（`wordsStartOf`）✓ —— 它和 `seg.start` 等价，取哪个都一样 ✓
 * · **全部锚代码** ✓ —— 一行改回 `true` 就恢复（可回退 ✓）
 *
 * ⚠️ 这是**实验**，不是定论 ✗：「早」会不会回来、值不值得，要用闭环 + 真机日志判 ✓
 */
export const SEG_START_ANCHOR_ENABLED = false;

/** 打开锚（给断言/变异用）—— 只影响本模块的判定，不改调用方 ✓ */
export const SEG_START_ANCHOR_VALUE_ENABLED = true;

export function shownStartOf({
  offsetSec,
  seg,
  pcm,
  sampleRate = 16000,
  firstSpeechAt = null,
  speechThreshold = null,
  isFirst = false,
  /**
   * ⭐ 可选**只读探针** —— 回答「锚为什么没动」✗
   *
   * 实测（`xhsp-ab6-B`，19 条段诊断）：4 条「锚没动」，而它们分三类 ✗
   *   · `start 0.00` 首段 ⇒ 问了 VAD 但没采信（原因不明 ✗）
   *   · `start 1.74 / 2.00 / 3.74` 首段 ⇒ **超过 1 秒信任窗口 ⇒ 根本没问 VAD** ✗
   * 而日志里这三种**长得一模一样**（都是 `+0.00`）✗ ⇒ 只能猜 ⇒ 今天猜错两次 ✓
   *
   * 所以探针要记两件：
   *   ① `decision` —— 走了哪条路（`vad` / `vad-rejected` / `skipped-start-real` / `pcm` / `base`）
   *   ② `shadow*` —— 对「首段 start 超窗」那些，**照样问一次 VAD** 但**不吃结果** ✓
   *      目的：回答"放宽信任窗口有没有用"，而不是拍脑袋放宽 ✗
   *
   * ⚠️ **纯只读**：不传 `probe` 时行为**逐字不变** ✓（断言钉住）
   */
  probe = null,
} = {}) {
  /** 探针容器 —— 传了就直接往里写；没传就是 `null`（每个写入点都判空）✓ */
  const p = probe && typeof probe === 'object' ? probe : null;
  /**
   * ⭐ **起点优先用词级时间戳的 `words[0].start`** ✓
   *
   * 实测（5 段真机素材）：`words[0].start` 与 `seg.start` 差 **0.00~0.07 秒** ✗
   * ⇒ **它在这里不改变结果**，但它是**语义上正确的那个数**（"第一个词从哪儿开始"），
   *    `seg.start` 只是 Whisper 的段边界 ✓ —— 所以有就用，没有就退回 ✓
   *
   * ⚠️ **不知道就别引入新行为** ✗：`words` 缺失 / 脏 / 越界 ⇒ 一律退回 `seg.start` ✓
   */
  const ws0 = wordsStartOf(seg);
  if (p) p.wordsStart = ws0;
  const base = Number(offsetSec) + (ws0 !== null ? ws0 : Number(seg?.start));
  if (!Number.isFinite(base)) return Number(seg?.start) || 0;
  const endAbs = base + Math.max(0, Number(seg?.end) - Number(seg?.start));
  if (p) {
    p.base = base;
    p.endAbs = endAbs;
    p.start = Number(seg?.start);
    p.isFirst = isFirst === true;
  }

  if (SEG_START_ANCHOR_ENABLED && typeof firstSpeechAt === 'function' && endAbs > base) {
    const startNum = Number(seg?.start);
    /**
     * `seg.start` 小于一帧的一半就没携带位置信息（Whisper 把它夹在批首了）✗
     * 用 `<=` 而不是 `=== 0`：`0.01` / `0.02` 这种是同一件事 ✓
     *
     * ⚠️ **一批里的第一段**要放宽到 `FIRST_SEG_ANCHOR_TRUST_SEC`（1 秒）——
     *    它的 `seg.start` 是"从批首开始听"的产物，0.04 / 0.3 / 0.9 都不携带位置信息 ✗
     *    （实测 12 条提前里 9 条满足"新跨度比旧路长 >1s"，而它们的 `seg.start` 都 > 0.02）
     *    而**第一段之后**的段是 Whisper 听完整个批给出的段间边界 ⇒ 保持严格 0.02 ✓
     */
    /**
     * ⭐ **多段锚**（用户定的"该上的时刻要算准"）✗
     *
     * 原来这里的信任窗口是：
     *   · 第一段 1 秒（`FIRST_SEG_ANCHOR_TRUST_SEC`）
     *   · **其余段 0.02 秒** ⇒ `seg.start` 只要 >0.02 就**根本不问 VAD** ✗
     *
     * 后果：一批里 Whisper 给 3 段时，**只有第一段**用过 VAD 开口锚，
     * 第 2、3 段的 `at` 全靠 `seg.start` —— 而 Whisper 把「前导短音 + 后面的句子」
     * 合成一段时，那个 `start` 落在**前导短音**上 ✗ ⇒ 那几句照样提前 ✓
     *
     * ⇒ 现在**每一段都问 VAD**，在自己的区间 `[base, endAbs]` 里找它自己的开口 ✓
     * ⚠️ 而"真实边界"不会被挪歪：采信条件里有 `found - base >= MIN_ANCHOR_SHIFT_SEC`（0.1 秒）✗
     *    —— 若这段起点**就是**开口，VAD 在 `base` 处就找到语音 ⇒ 位移 0 ⇒ 拒绝 ⇒ 保留 `seg.start` ✓
     *    所以放宽信任窗口**不会**引入"把对的段挪歪"这种回归 ✓
     *
     * ⚠️ 找不到语音 ⇒ 保持原样往下走 ✓（保守：那可能真是一段静音 ✓）
     */
    const trustSec = isFirst === true ? FIRST_SEG_ANCHOR_TRUST_SEC : NON_FIRST_SEG_ANCHOR_TRUST_SEC;
    const clamped = !Number.isFinite(startNum) || Math.abs(startNum) <= trustSec;
    if (p) p.trustSec = trustSec;
    /** 三个条件都要满足才采信（见下方注释）—— 抽成函数，影子测量要复用同一套判据 ✓ */
    const accept = (found) =>
      Number.isFinite(found) && found - base >= MIN_ANCHOR_SHIFT_SEC && found < endAbs;
    if (clamped) {
      try {
        const found = firstSpeechAt(base, endAbs, speechThreshold, p);
        if (p) {
          p.consulted = true;
          p.found = found;
        }
        if (accept(found)) {
          if (p) p.decision = 'vad';
          return found;
        }
        if (p) p.decision = 'vad-rejected';
      } catch {
        // 一个锚点判断不该把整条识别链带下水 ✗
        if (p) p.decision = 'vad-threw';
      }
    } else if (isFirst === true && p && p.shadowRequested === true) {
      /**
       * ⭐ **影子测量**：首段 `start` 超过 1 秒信任窗口 ⇒ 按设计不采信 ✗
       * 但**照样问一次**，把"如果放宽会挪多少"记下来 ✓ —— **不吃结果** ✓
       * ⚠️ 用**独立的容器**，绝不让影子结果污染 `p` 的 `reason` / `found` ✓
       *
       * 🔴 **必须由调用方显式要求**（`probe.shadowRequested === true`）✗
       *    —— 不要求时**一次都不许多问** ✓（见 smoke 里那条"start=1.5 已携带位置信息，不许问"）
       *    理由：那是**纯诊断**的额外扫描，不该悄悄改变"谁被调用了几次"这件事 ✓
       */
      const shadow = {};
      try {
        const found = firstSpeechAt(base, endAbs, speechThreshold, shadow);
        if (p) {
          p.decision = 'skipped-start-real';
          p.shadow = true;
          p.shadowFound = found;
          p.shadowWould = accept(found);
          p.shadowShift = Number.isFinite(found) ? found - base : null;
          p.shadowReason = shadow.reason || null;
          p.shadowRun = shadow.run ?? null;
          p.shadowPeak = shadow.peak ?? null;
        }
      } catch {
        if (p) p.decision = 'shadow-threw';
      }
    } else if (isFirst === true) {
      if (p) p.decision = 'skipped-start-real';
    } else if (p) {
      p.decision = 'skipped-not-first';
    }
  } else if (p) {
    p.decision = typeof firstSpeechAt === 'function' ? 'empty-seg' : 'no-callback';
  }

  if (!pcm || typeof pcm.subarray !== 'function') return base;
  if (!(sampleRate > 0)) return base;

  const from = Math.max(0, Math.round(Number(seg.start) * sampleRate));
  const to = Math.min(pcm.length, Math.round(Number(seg.end) * sampleRate));
  if (!(to > from)) return base;

  const leadMs = leadingSilenceMs(pcm.subarray(from, to), { sampleRate });
  if (p) {
    p.leadMs = leadMs;
    if (leadMs > 0) p.decision = p.decision === 'vad-rejected' ? 'vad-rejected+pcm' : 'pcm';
    else if (!p.decision) p.decision = 'base';
  }
  return leadMs > 0 ? base + leadMs / 1000 : base;
}

/**
 * 一条字幕**至少该在屏上停留多久**（秒）。
 *
 * ## 为什么是 0.5 秒
 *
 * 用户报的症状是「上一句只显示了一瞬间,下一句就把它顶掉了」—— 而他说的"一瞬间"在日志里
 * 就是「相邻两条的 `at` 相距只有几十毫秒」。0.5 秒是**人能看清一短句**的下限，
 * 也是旧路（时机被用户认可的那条）**健康输出里的最小间隔**（实测 `16.101 → 16.601`）✓
 *
 * ⚠️ 取更大（1 秒）会把本来正常的密集句子往后拖，而用户明确要求
 *    「短句必须准、长句才可以稍晚」⇒ 只修"看不清"那一段，不额外拖 ✗
 * ⚠️ 取更小（0.1~0.2 秒）仍然会"闪"，因为人眼需要 0.3 秒以上才认得出一个词 ✗
 */
export const MIN_SHOW_GAP_SEC = 0.5;

/**
 * 把一条字幕的上屏时刻**夹到不早于上一条 + 最小间隔**（排期单调 ✗）。
 *
 * ## 为什么需要它
 *
 * 播放器同一时刻只显示一条字幕 ⇒ 新的一条一到，上一条立刻被顶掉 ✓
 * 所以"上一条显示了多久"**完全等于**「两条 `at` 之间的距离」✗
 * 而只要新路的 `at` 有一处**倒退**（或前进得只差几十毫秒），那一条就会被"秒顶"✗
 *
 * 实测（同一份素材、两轮闭环、都延迟 10）：
 * ```
 * 旧路：`at` 倒退 **0 / 41** 处 ✓ · 停留 <0.5s **1 / 42**（2.4%）✓
 * 新路：`at` 倒退 **3 / 72** 处 ✗（−0.454 / −0.034 / −0.350）· 停留 <0.5s **7 / 73**（9.7%）✗
 * ```
 * ⇒ 那 3 处倒退 + 4 处"前进但相距 <0.5s" = **7 处会被秒顶** ✗✓✓
 *
 * ⚠️ **只往后推，绝不提前** ✓ —— 所以它不会让"字幕早"变得更早，
 *    也不会动到排期的绝对值（那条是"缓冲没填到目标延迟"的事，是另一个根 ✗）
 *
 * ⚠️ 链条累积是安全的：每一条只可能被推 `MIN_SHOW_GAP_SEC`，而正常的句子间隔
 *    2~5 秒 ⇒ 只有真的挤在一起的那几条会被动到 ✓
 *
 * @param {object} opts
 * @param {number} opts.raw      这一条原本的 `at`（绝对秒）
 * @param {number|null} opts.lastAt 上一条**已下发**的 `at`；`null` = 这是第一条
 * @param {number} [opts.minGap] 最小间隔（秒），默认 `MIN_SHOW_GAP_SEC`
 * @returns {number} 夹过之后的 `at`（脏输入原样返回 —— 不确定就不要发明数字 ✗）
 */
export function clampShownAt({ raw, lastAt = null, minGap = MIN_SHOW_GAP_SEC } = {}) {
  /**
   * ⚠️ **必须用 `typeof === 'number'`，不能用 `Number(raw)`** ✗
   *
   * `Number(null) === 0` / `Number('') === 0` / `Number(false) === 0`
   * ⇒ 会把"没有值"当成"在 0.0 秒上屏"，于是它被夹到 `lastAt + 0.5`，
   *    也就是**凭空造出一条时刻** ✗✓✓
   *
   * 这个坑今天在 `sanitizeSegments` 上踩过一次（`{start: null}` 被当成 `0`），
   * 而这条断言正是被它抓出来的 —— 第一版就是这么写的 ✓
   */
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return raw;

  /**
   * `lastAt` 同理：`null` 表示"还没有上一条"，**不能**被当成 `0.0` ✗
   * （`Number(null) === 0` 会把开头第一条无端推到 0.5 秒 ✓）
   */
  if (typeof lastAt !== 'number' || !Number.isFinite(lastAt)) return raw;

  const gap = Number(minGap);
  if (!Number.isFinite(gap) || gap <= 0) return raw;

  return Math.max(raw, lastAt + gap);
}

/** 屏上最小停留（毫秒）—— 和 `MIN_SHOW_GAP_SEC` 同一个依据（人能看清一短句的下限 ✓） */
export const MIN_SHOW_HOLD_MS = 500;

/**
 * 屏上让位：新的一条字幕想上屏时，**上一条在屏上待够最小间隔了没有**。
 *
 * ## 为什么夹在"排期时刻"上还不够（实测踩到的） ✗
 *
 * `clampShownAt` 夹的是**音频时间**（`startAbs`），而真正决定"什么时候上屏"的是
 * `at = firstAudioAt + start*1000 + delayMs` —— 里面还有 `delayMs`，而它会被
 * `resync()` 改 ✗。于是两条在音频时间上相隔 0.5 秒的段，可能因为 `delayMs` 掉了 1 秒
 * 而在排期上**倒过来** ✗。
 *
 * 实测（`xhsp-ab3-B`，新路、延迟 10）：心跳里的「夹紧推后」**一次都没触发**（0 次），
 * 而导出日志里仍有 `73.512 → 72.992（−0.52）`、`91.146 → 91.046（−0.10）`、
 * `145.982 → 145.541（−0.44）` 这种倒退 ✗
 * ⇒ 因为那几条的 `usedDelayMs` 不同（一条推入时缓冲更薄）✓
 *
 * ⇒ **真正的闸必须在显示层**：不管排期怎么算，**已经上屏的那一条至少待够 0.5 秒**，
 *    新的这一拍先不上、下一拍再来 ✓（`pumpSubtitles` 每 100ms 一拍）
 *
 * ⚠️ 它**不改任何排期值** ⇒「比排期晚」那个读数依然诚实；
 *    让位让出去的时间单独印成「屏上让位 +X.XXs」✗
 *
 * ⚠️ 只在**新路**（`provider === 'vad-segments'`）生效 ✓ —— 旧路的时机用户认可，
 *    动它就是回归 ✗
 *
 * @param {object} opts
 * @param {number} opts.now          现在（与 `lastSwitchAt` 同基准，毫秒）
 * @param {number} opts.lastSwitchAt 上一次**换屏**的时刻（毫秒）；0/非有限 = 还没换过
 * @param {number} opts.minHoldMs    ⚠️ **必传**（毫秒）—— 没有默认值，见下
 * @param {boolean} [opts.enabled]   是否启用（新路才启用）
 * @returns {boolean} `true` = **这一拍先别换屏**
 */
export function holdSwitchForGap({ now, lastSwitchAt, minHoldMs, enabled = true } = {}) {
  if (!enabled) return false;
  if (typeof now !== 'number' || !Number.isFinite(now)) return false;
  // ⚠️ `lastSwitchAt = 0` 表示"还没换过" —— **不许**当成"刚换过"（`Number(null)` 那个坑 ✗）
  if (typeof lastSwitchAt !== 'number' || !Number.isFinite(lastSwitchAt) || lastSwitchAt <= 0) return false;
  /**
   * 🔴 `minHoldMs` **没有默认值，也不许静默退化** ✗
   *
   * 原来写的是 `minHoldMs = MIN_SHOW_HOLD_MS`：于是调用方漏传时**悄悄退回固定 500ms** ✗
   * ⇒ 每条「待够再换」（`minShowHoldMs` 按它自己的字数/跨度算）**根本没接线**，
   *    而所有断言照样全绿 ✗
   * —— 变异 `minHoldMs = MIN_SHOW_HOLD_MS || minShowHoldMs({…})` 跑完全绿就是证据 ✓
   *    （`||` 短路掉真值，和"漏传"**是同一个后果**：静默用 500ms）
   *
   * ⇒ 拿不到**正数**就当场抛错，让漏传立刻暴露，而不是让字幕悄悄退回固定停留 ✓
   * ⚠️ 顺序很重要：`now` / `lastSwitchAt` 先判完 ⇒ 脏输入用例仍然**返回 false 而不是抛** ✓
   * ⚠️ 只对**漏传**（`undefined`）抛 —— 显式传了 `0`/`-1`/`NaN` 的仍是"关闸"（老行为 ✓），
   *    那和"忘记接线"是两件事，别混 ✗
   */
  if (minHoldMs === undefined) {
    throw new TypeError(
      'holdSwitchForGap: 必须显式传入 minHoldMs' +
        ' —— 有默认值会让漏传静默退化成固定停留 ✗',
    );
  }
  const hold = Number(minHoldMs);
  if (!Number.isFinite(hold) || hold <= 0) return false;
  return now - lastSwitchAt < hold;
}

/**
 * 屏上一行字的**阅读速度下限**（字/秒）。
 *
 * 依据：中文正常阅读 5~8 字/秒；字幕要留余量（错过就没了），取偏慢的 **6** ✓
 * ⚠️ 它算的是"读完这条至少需要多久" —— 20 字 ⇒ 3.3 秒 ✗
 *    而实测里出现过 **20~210 字/秒**（= 一条 21 字的字幕 0.1 秒就被换掉 ✗）
 */
export const MIN_READ_CHARS_PER_SEC = 6;

/** 屏上任何一条字幕的**绝对下限**（秒）—— 再短人也认不出来 ✓ */
export const MIN_SHOW_SEC = 0.6;

/**
 * 🔴 **连续翻译失败多少次之后就不再等译文** ✗
 *
 * 3 次：单次失败可能是抖动（超时 / 限流），连续 3 次基本就是"服务不可达"或"被拦" ✓
 *
 * ## 为什么必须有它（真机实测 `xhsp-nofix-B`，2026-10-23，出网被拦）
 *
 * `translate.googleapis.com` 全程 `Failed to fetch` / 12 秒超时 ⇒ 52 条字幕**全部**
 * 撞上「等译文」的 4 秒兜底、全部退回日文原文 ✗ ⇒ 显示吞吐被钉死 **4 秒/条**，
 * 而识别约 **2.5 秒/条** ⇒ 队列无界积压 ⇒「比排期晚」60 秒内从 **6 秒涨到 19 秒** ✗
 * ⇒ 观众体感就是「**普遍都晚那么多**」✓
 *
 * ⇒ 连续失败够多就不再等：原文立刻上屏，译文真到了由 `renderSubs()` 补上 ✓
 *    （那条路径本来就有：`if (rendered.has(seg.id)) renderSubs();`）
 * ⚠️ 成功一次就复位 —— 服务恢复后立刻回到"等译文"的正常行为 ✓
 */
export const TRANSLATE_FAIL_STREAK = 3;

/**
 * 一条「还没译文」的字幕要再扣多久才退回显示原文（毫秒）。
 *
 * @param {number} failStreak 当前**连续**翻译失败次数
 * @param {number} [lateMs]  无失败时的兜底时长（默认 4000ms）
 * @returns {number} 0 = 不再等（立刻显示原文）· 否则 = 还要扣多少毫秒
 */
export function translationHoldMs(failStreak, lateMs = 4000) {
  const n = Number(failStreak);
  const late = Number(lateMs);
  const lateOk = Number.isFinite(late) && late >= 0 ? late : 4000;
  // ⚠️ 脏输入（`null` / `'abc'` / `NaN` / 负）一律当作"没在失败"⇒ 用正常兜底 ✓
  if (!Number.isFinite(n) || n < TRANSLATE_FAIL_STREAK) return lateOk;
  return 0;
}

/**
 * 显示层**实际**要等译文多久 —— 翻译**关掉**时是 **0**（等也等不到）✗
 *
 * ## 为什么必须单独一条规则
 *
 * 「**不翻译（仅显示原文）**」是产品自带的选项（`TRANSLATE_PROVIDERS` 里 `id: 'none'`）。
 * 而显示层原来只问「`item.translation` 在不在」✗ ⇒ 翻译关掉时**每一条**都走"等译文"那条路
 * ⇒ 每条白扣 `lateMs`（4000ms）⇒ 显示吞吐被钉死 **4 秒/条** ⇒ 队列无界积压 ⇒ 字幕一路变晚。
 *
 * 实测（闭环 · `translate.provider='none'` · 160 秒 · 同一装置只差这一刀）：
 *   · 修前 `xhsp-notr-B`：在屏时长恒定 **4.02s**（32/35 条）、「比排期晚」中位 **15.30s** / 最大 **37.13s** ✗
 *   · 修后 `xhsp-notr2-B`：恒定 4s **0/41**、「比排期晚」中位 **1.32s** / 最大 **2.37s** ✓
 *
 * ⚠️ 只有**明确** `translateOn === false` 才算关；`undefined`（不知道）沿用老行为 ✓
 *
 * @param {{translateOn?: boolean, failStreak?: number, lateMs?: number}} [o]
 * @returns {number} 0 = 立刻可上屏
 */
export function displayHoldMs(o) {
  const opt = o && typeof o === 'object' ? o : {};
  if (opt.translateOn === false) return 0;
  return translationHoldMs(opt.failStreak, opt.lateMs);
}

/**
 * 一条字幕**至少要在屏上待多久**（毫秒）—— **只剩一个绝对下限** ✓
 *
 * ## 🔴 另外两项被撤掉了（用户定的）
 *
 * 用户原话：
 * > 「你对闪的优化有问题。**不要有什么上屏时间限制**。只有下一句该上了就上。
 * >   问题是**什么时候该上**,而不是让他**前面的延长**」
 *
 * 原来这里取三者的最大值：
 *   ① `spanRemaining`（还没说完的部分）✗
 *   ② `chars / MIN_READ_CHARS_PER_SEC`（读完要多久）✗
 *   ③ `MIN_SHOW_SEC`（0.6 秒下限）✓
 *
 * ①②**都是"延长前面那条"** ✗ ⇒ 它们**不解决"闪"**，只是把"后面那句上得太早"
 * 掩盖成"前面那句待得久" ✗。而掩盖是有账的：真机闭环实测「比排期晚」中位
 * **1.20 → 1.29 → 1.69 秒**（越加越长，一路累积 ✗）。
 *
 * ⇒ **"闪"和"提前"是同一个病**：下一句的 `at`（该上的时刻）算早了 ✗
 *    解法只能是**把 `at` 算准**（见 `shownStartOf` 的多段锚），
 *    而不是让前面那条多待 —— 那只会让整条时间轴往后塌 ✓
 *
 * ⚠️ 保留 `MIN_SHOW_SEC`（0.6 秒）：再短**人眼认不出那是一行字** ✗
 *    它是"看得见"的物理下限,不是"读得完"的要求 ✓
 * ⚠️ 它**不改任何排期值**（`at` 不动）⇒「比排期晚」依然诚实 ✓
 * ⚠️ 只在**新路**生效 ✓ —— 旧路时机用户认可，动它就是回归 ✗
 *
 * @param {object} opts  —— 参数**保留**（调用方仍在传）：将来要算别的口径时不用改签名 ✓
 * @returns {number} 最小在屏时长（毫秒）= `MIN_SHOW_SEC * 1000`
 */
export function minShowHoldMs(opts) {
  // ⚠️ **不能写 `= {}` 默认值** ✗ —— 默认值只在 `undefined` 时生效,而 `null` 一样会解构崩溃
  //    （`Cannot destructure property 'chars' of null` ✗）；这是 `Number(null) === 0` 那一族 ✓
  //    本函数自己的一条断言就把它抓出来了 ✓
  //
  // ⚠️ 参数现在**不参与计算**，但**不许删**：
  //    · 调用方按 `{chars, spanSec, elapsedMs}` 传 ✓
  //    · 断言里有"脏输入不许崩"那一组（`null` / `'abc'` / `NaN`）✓
  //    保留签名 = 将来换口径只改函数体,不用改全部调用点 ✓
  void opts;
  return MIN_SHOW_SEC * 1000;
}

/**
 * 屏上合并：两句合计的**字数上限**。
 *
 * 依据：字幕区大约两行（`.line` 是 `pre-wrap`），30 个日文字符 ≈ 两行；再长就挡住画面 ✗
 * ⚠️ 数的是**原文**（日文）—— 译文长度不可控，按译文判上限会在某些语言上莫名不合并 ✗
 */
export const MERGE_SHOWN_MAX_CHARS = 30;

/**
 * 屏上合并：前一条**已经在屏上待了多久**之后就不要再往里塞（毫秒）。
 *
 * 这是把用户那句「**第一句不超排期**」落成一个可断言的数：
 *   · 前一条上屏还没多久（≤1.5 秒）⇒ 它本来就占着这段时间，再并一句进去**不推迟任何东西** ✓
 *   · 前一条已经待了很久 ⇒ 它是一句**正常停留够久**的字幕、用户已经读完了；
 *     这时再往里塞会让"屏幕上突然多出半句" ✗（而那正是新的"闪"）
 *
 * ⚠️ 它和 `MIN_SHOW_HOLD_MS`（0.5 秒）**不是一回事** ✗：
 *    后者是"人眼能看清的最短时间"，这里是"还愿意往同一行里追加内容的上限"✓
 */
export const MERGE_SHOWN_MAX_PREV_AGE_MS = 1500;

/** 把两句文本接成一行 —— 空值安全（缺一边就原样返回另一边 ✓） */
export function joinShownText(a, b) {
  const x = typeof a === 'string' ? a.trim() : '';
  const y = typeof b === 'string' ? b.trim() : '';
  if (!x) return y;
  if (!y) return x;
  return `${x} ${y}`;
}

/**
 * 屏上合并：新到的一条要不要**并进上一条**、合成一行一起显示。
 *
 * ## 为什么需要它（实测） ✗
 *
 * `段内切分` 会**一批出两条** `final`（治"前导短音 + 后句被 Whisper 合成一段"）✓
 * 而那两条的 `at` 常常只差几十毫秒：
 * ```
 * xhsp-seg25-B：91.092 → 91.013（**−0.079s**，倒退）✗
 * xhsp-rep1  ：48.063 → 47.664（−0.399s）✗ · 56.648 → 56.984（+0.336s）✗
 * ```
 *
 * ⇒ 播放器同一刻只显示一条 ⇒ 后一条一到就把前一条**顶掉**（前一条只闪一下 ✗）
 * ⇒ 而 `holdSwitchForGap` 只能把它**推迟** 0.5 秒（于是又变成"晚"✗）
 * ⇒ **正确做法（用户定的）**：两句都短、且前一条没超排期 ⇒ **合成一条一起送出** ✓
 *
 * ## 判据（全部满足才并）
 *
 * ① 两条都得有**译文** ✓ —— 否则并进去的那半句会永远显示原文
 *    （`due()` 用 `renderable` 卡译文，超时才放行原文 ⇒ 那时 `translation` 是空串）
 * ② 排期**撞在一起**：`next.at − prev.at < minGap`（**负的也算** —— 倒退正是"闪"的来源 ✗）
 * ③ 两句**合计字数** ≤ `maxChars`（屏幕上两行以内 ✓）
 * ④ 前一条**在屏上还没待超过** `maxPrevAgeMs`（"第一句不超排期"✓）
 *
 * ⚠️ **不改识别结果、不改排期值** ✓ —— 只决定"这一条是单独一行还是并进上一行"
 *
 * @param {object} opts
 * @param {object|null} opts.prev  上一条**已经上屏**的条目（`at`/`original`/`translation`）
 * @param {object} opts.next       这一拍到点的新条目
 * @param {number} opts.now        现在（`Date.now()` 口径，和 `lastShowSwitchAt` 同基准）
 * @param {number} [opts.prevShownAt] 上一条**换屏**的时刻（毫秒）；0/非有限 = 不知道
 * @param {number} [opts.minGap]   排期"撞在一起"的阈值（秒）
 * @param {number} [opts.maxChars] 合计字数上限
 * @param {number} [opts.maxPrevAgeMs] 前一条在屏上待多久之后就不许再并
 * @returns {boolean} `true` = 并进上一条
 */
export function shouldMergeShown({
  prev,
  next,
  now,
  prevShownAt,
  minGap = MIN_SHOW_GAP_SEC,
  maxChars = MERGE_SHOWN_MAX_CHARS,
  maxPrevAgeMs = MERGE_SHOWN_MAX_PREV_AGE_MS,
} = {}) {
  if (!prev || typeof prev !== 'object') return false;
  if (!next || typeof next !== 'object') return false;
  // ① 两条都要有译文（否则并进去的半句永远显示原文 ✗）
  if (typeof prev.translation !== 'string' || !prev.translation.trim()) return false;
  if (typeof next.translation !== 'string' || !next.translation.trim()) return false;
  // ② 排期撞在一起（倒退也算）
  const atPrev = typeof prev.at === 'number' && Number.isFinite(prev.at) ? prev.at : null;
  const atNext = typeof next.at === 'number' && Number.isFinite(next.at) ? next.at : null;
  if (atPrev === null || atNext === null) return false;
  const gapSec = Number(minGap);
  if (!Number.isFinite(gapSec) || gapSec <= 0) return false;
  if (atNext - atPrev >= gapSec * 1000) return false;
  // ③ 合计字数（按**原文**数）
  const cap = Number(maxChars);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const prevChars = typeof prev.original === 'string' ? prev.original.trim().length : 0;
  const nextChars = typeof next.original === 'string' ? next.original.trim().length : 0;
  if (nextChars <= 0) return false;
  if (prevChars + nextChars > cap) return false;
  // ④ 前一条在屏上还没待太久（"第一句不超排期"✓）
  const shownAt = Number(prevShownAt);
  if (!Number.isFinite(shownAt) || shownAt <= 0) return false;
  const ageCap = Number(maxPrevAgeMs);
  if (!Number.isFinite(ageCap) || ageCap <= 0) return false;
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) return false;
  if (nowMs - shownAt > ageCap) return false;
  return true;
}

export { DECIDE_REASONS };

// ═══════════════════ 按批刷新（同时出现）═══════════════════

/**
 * ⭐ **一批最多带几条一起上屏**。
 *
 * 为什么要有上限（实测）：7 秒延迟内平均能完成 **2 句**（在屏中位 3.5s/句），
 * 最坏（句子密，每 2.9 秒一句）能到 **3 句**。再多就是"字幕墙"了。
 */
export const SHOW_BATCH_MAX_ITEMS = 3;

/**
 * ⭐ **同批的判定容差**（秒）—— 队首 `at` 之后这么久的，都算同一批。
 *
 * 用户定的规矩（原话）：
 * > 「同时出现 都放一行就行 不行再折叠换行,我不信几秒延迟能说太多话导致挡画面」
 *
 * ⚠️ **不再用于「宽限等待」** ✗ —— 那一段已按用户要求撤掉（见 `player.js` 的批分支说明）：
 *    现在它只在本拍 `due()` **已经弹出**的条目里做分组，**不推迟任何东西** ✓
 * ⚠️ **不能取成"整个延迟窗口"（7 秒）** ✗ —— 那会让后来才该出现的一句**提前 7 秒**，
 *    而那正是这一整天在治的病 ✗。
 * ⚠️ 也不该取 0（= 一条一条换）—— 那就回到"闪"了 ✗。
 * ⇒ 取 **1.5 秒**：能带上"只差一口气"的那 1~2 句，而最坏提前量 < 1.5 秒，
 *    和"识别延迟差"同量级（那本来就不可免）✓
 */
export const SHOW_BATCH_TOLERANCE_SEC = 1.5;

/** 同批几句之间的连接符（原文/译文都用它 —— 一个空格，视觉上是一行连续字幕） */
export const SHOW_BATCH_SEP = ' ';

/**
 * 从「到点的条目」里挑出**这一批**：队首 + `at` 落在容差内的后续条目。
 *
 * 入参 `items` 必须是**按 `at` 升序**的（`schedule.due()` 保证）✓
 *
 * @returns {{batch: object[], rest: object[]}} `rest` = 没进这一批的（要放回队首 ✗）
 */
export function pickShownBatch(items, opts = {}) {
  /**
   * 🔴 **已经上过屏的条目一律不许再进批** —— 这是**幂等保护**,真机实测必须要有 ✗
   *
   * 实测（`xhsp-batch-B` 第一版）：同一批的条目被**反复 flush**，而 `batch[0]` 的原文
   * 已被上一次合并写长 ⇒ 每次再合并 3 条就 ×3 ⇒
   * `21 → 65 → 197 → 593 → 1781 → 5345 → … → 390 万字` ✗
   * 后果不只是日志难看：`lastShownChars` 被污染 ⇒ 阅读速度算成 **541237 字/秒** ✗；
   * 而 `minShowHoldMs` 拿屏上那条的 `original.length` 算 ⇒ **越合并越久不让位** ✗
   *
   * ⇒ 用 `shownAt` 当**消费标记**：flush 时给这一批每一条都打上，这里先滤掉 ✓
   */
  const list = Array.isArray(items)
    ? items.filter((x) => x && typeof x === 'object' && !x.shownAt)
    : [];
  if (!list.length) return { batch: [], rest: [] };
  const tolRaw = Number(opts.toleranceSec);
  const tol = Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : SHOW_BATCH_TOLERANCE_SEC;
  const capRaw = Number(opts.maxItems);
  const cap = Number.isFinite(capRaw) && capRaw >= 1 ? Math.floor(capRaw) : SHOW_BATCH_MAX_ITEMS;
  const headAt = typeof list[0].at === 'number' && Number.isFinite(list[0].at) ? list[0].at : null;
  // 队首的 `at` 不可用 ⇒ 只带它自己（不改语义，最保守 ✓）
  if (headAt === null) return { batch: [list[0]], rest: list.slice(1) };
  const limit = headAt + tol * 1000;
  let n = 1;
  while (n < list.length && n < cap) {
    const at = typeof list[n].at === 'number' && Number.isFinite(list[n].at) ? list[n].at : null;
    // ⚠️ `at` 不可用 / 超出容差 ⇒ 停在这里（后面的都不带 ✓）
    if (at === null || at > limit) break;
    n += 1;
  }
  return { batch: list.slice(0, n), rest: list.slice(n) };
}

/**
 * 把一批条目**合成一条要显示的记录**（纯函数，不改入参 ✓）。
 *
 * ⚠️ 译文缺失的条目退化为原文 —— 和单条上屏时"翻译没赶上先显示原文"一致 ✓
 */
export function mergeShownBatch(batch) {
  const list = Array.isArray(batch) ? batch.filter((x) => x && typeof x === 'object') : [];
  if (!list.length) return null;
  const originals = [];
  const translations = [];
  let end = -Infinity;
  let start = Infinity;
  for (const it of list) {
    const o = typeof it.original === 'string' ? it.original.trim() : '';
    const t = typeof it.translation === 'string' ? it.translation.trim() : '';
    if (o) originals.push(o);
    if (t || o) translations.push(t || o);
    const e = Number(it.end);
    if (Number.isFinite(e)) end = Math.max(end, e);
    const s = Number(it.start);
    if (Number.isFinite(s)) start = Math.min(start, s);
  }
  return {
    original: originals.join(SHOW_BATCH_SEP),
    translation: translations.join(SHOW_BATCH_SEP),
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
    chars: originals.join('').length,
    count: list.length,
  };
}
