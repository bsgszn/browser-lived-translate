/**
 * 「连续 N 帧都达标才算开口」的纯函数 —— 新路「开口锚」的判据核心 ✗
 *
 * 为什么需要它：音乐床 / 呼吸在批起点就已经 ≥ 阈值 0.5 ✗
 * ⇒ 单帧判据会在批起点立刻返回 ⇒ `shift = 0` ⇒ 锚点形同不存在 ✗
 * 实测 7 次锚点里 2 次 `shift = 0.00`，而那两条正是跨度过长最严重的（1.2 / 0.3 字/秒）✗
 *
 * ⭐ 而**旧路（用户认可的时机）要求「开口需 7 帧」** —— 连续 7 帧 ≈ 280ms ✓
 * ⇒ 这里用同一个判据：连续 `minRunFrames` 帧都 ≥ 阈值才算开口 ✓
 * （两个判据 = 两份真相 ✗；这一族今天栽过多次）
 *
 * ⚠️ 保守方向：找不到就返回 `null` ⇒ 调用方"不挪" ✓
 *    —— 那可能真是一段持续的底噪，而"不挪"最多维持现状，不会把对的挪歪 ✓
 *
 * 为什么提成纯函数：它原本在 `vad.js` 的 `createSession` 闭包里 ✗
 * ⇒ 断言只能在源码上做正则检查，测不到行为 ✓（"断言看着有、实际抓不到"今天栽了四次）
 */

/**
 * 在 `[fromIdx, toIdx]`（**闭区间**，帧索引）里找第一段「连续 `minRunFrames` 帧都 ≥ `threshold`」，
 * 返回**那一段的首帧索引** ✓ · 找不到返回 `null` ✓
 *
 * ⚠️ **必须是首帧，不是末帧** ✗ —— 开口是从"开始说话"那一刻算的，
 *    返回末帧会把起点推迟 `minRunFrames - 1` 帧（= 240ms）⇒ 字幕又变晚 ✗
 *
 * ⚠️ **必须容纳整段连续帧**：若 `fromIdx + need - 1 > toIdx`，窗口末尾那几帧凑不满，
 *    而"凑不满"就是"这段里没有可靠的开口" ⇒ 返回 `null` ✓（保守）
 *
 * @param {(i:number)=>number} get  帧索引 → 概率（0~1）。纯函数，不读全局 ✓
 * @param {object} opts
 * @param {number} opts.fromIdx     起始帧（含）
 * @param {number} opts.toIdx       结束帧（含）
 * @param {number} opts.threshold   概率阈值（**和 VAD 同一个数**）
 * @param {number} [opts.minRunFrames=1] 要求连续多少帧达标（1 = 旧版单帧行为 ✓）
 * @returns {number|null}           首帧索引；找不到 / 窗口凑不满 / 参数非法 ⇒ `null`
 */
export function findSpeechRun(get, opts) {
  if (typeof get !== 'function') return null;
  const o = opts || {};
  /**
   * ⭐ 可选**只读探针** —— 回答「为什么没找到」✗
   *
   * ## 为什么必须有它
   *
   * `null` 在调用方眼里只有一种意思：**不挪** ✓ —— 而它有**五种**原因 ✗：
   *   ① `no-frame-over`  一帧都没过基础阈值（纯静音 / 纯音乐）
   *   ② `run-too-short`  过了阈值，但连续帧数不够（断续）
   *   ③ `peak-low`       连续够了，但**峰值不够**（音乐床贴着阈值浮动）
   *   ④ `window-too-short` 窗口凑不满 `need` 帧（批太短）
   *   ⑤ `invalid-args`   参数非法
   * ⇒ 而这几种要**改的方向完全不同** ✗（不动 / 放宽下限 / 加回落 / 不动 / 不动）
   *
   * 实测（`xhsp-ab6-B`）：19 条段诊断里 4 条「锚没动」，而它们在日志里
   * **和"正常"长得一模一样** ✗ ⇒ 只能靠猜 ⇒ 今天已经猜错两次 ✓
   * （"看不见"这一族已栽过六次 ✗）
   *
   * ⚠️ **纯只读**：不传 `probe` 时行为**逐字不变** ✓（断言钉住）
   */
  const probe = o.probe && typeof o.probe === 'object' ? o.probe : null;
  /** 记"哪一步放弃的" —— 每个 `return null` 之前都要标 ✓ */
  const miss = (reason) => {
    if (probe) probe.reason = reason;
    return null;
  };

  /**
   * ⚠️ `Number(null) === 0` 那个坑今天栽了两次 ✗
   * ⇒ 索引必须 `typeof === 'number'` 且有限，不能用 `Number(...)`
   */
  const fromIdx = o.fromIdx;
  const toIdx = o.toIdx;
  if (typeof fromIdx !== 'number' || !Number.isFinite(fromIdx)) return miss('invalid-args');
  if (typeof toIdx !== 'number' || !Number.isFinite(toIdx)) return miss('invalid-args');

  const thr = o.threshold;
  if (typeof thr !== 'number' || !Number.isFinite(thr)) return miss('invalid-args');

  /**
   * ⚠️ `need` 的归一化**必须和原来那行逐字等价**：`Math.max(1, Math.floor(Number(x)) || 1)`
   *    —— `|| 1` 让 `0 / NaN` 都退化成 1 ✓；而 `Number('7')` 仍是 7 ✓（`typeof` 守卫会把它变成 1 ✗）
   */
  const rawNeed = Number(o.minRunFrames);
  const need = Number.isFinite(rawNeed) && rawNeed ? Math.max(1, Math.floor(rawNeed)) : 1;

  /**
   * ⭐ 「**真的起来了**」的峰值门槛（默认 = `threshold` ⇒ 与旧行为逐字相同 ✓）
   *
   * 为什么还需要它：**音乐床能在阈值上下连续 7 帧达标** ✗
   * 实测（`xhsp.mp4` 闭环、`xhsp-anchor1`）那 2 条「锚 +0.00」的，
   * 正是跨度过长最严重的（`1.2 字/秒` / `0.1 字/秒`）——
   * 而它们的窗口里音乐床一直贴着 0.5 ✗ ⇒ **只靠「连续 N 帧」还是被骗过** ✗
   *
   * ⚠️ 试过并**否掉**的写法：「连续 7 帧之后 3 帧里至少 1 帧 < 0.5」✗
   *    —— 真实语音是**持续** ≥0.5 的（不是起落一下就掉），
   *       那条会把真话一起杀掉 ✗
   *
   * ✅ 采用「这一段里至少有一帧**真的高**」（默认 0.75）：
   *    · 音乐床贴着 0.5 浮动 ⇒ 峰值上不去 ⇒ 过不了 ✓
   *    · 轻声说话只要**有一帧**冲上去就算 ⇒ **不抬基础阈值** ⇒ 不误杀 ✓
   *    · 实测依据：真语音 `33.35s 概率 0.978` ✓；音乐床 `27.32s 概率 0.199` ✓
   *
   * ⚠️ `Number(null) === 0` 那个坑（今天栽过三次）⇒ 必须 `typeof === 'number'`
   */
  const rawPeak = o.peakThreshold;
  const peakThr = typeof rawPeak === 'number' && Number.isFinite(rawPeak) ? rawPeak : thr;

  const start = Math.floor(fromIdx);
  const end = Math.floor(toIdx);
  if (!(end >= start)) return miss('invalid-args');

  const last = end - (need - 1);
  if (last < start) return miss('window-too-short');

  let run = 0;
  /** ⭐ 当前这段连续帧里的**峰值** —— 用来判"真的起来了"（见上方 `peakThr`）✓ */
  let runPeak = 0;
  /** ⭐ 当前这段连续帧的**首帧** —— 返回值必须是它，不是 `f - need + 1` ✓ */
  let runStart = 0;
  /**
   * ⭐ 探针用的"曾经最好的一段" —— 只在最坏情况下回填，**不参与判定** ✓
   * （`bestRun` / `bestPeak` 是"如果没有峰值门槛、能命中什么"的证据）
   */
  let bestRun = 0;
  let bestPeak = 0;
  let bestStart = 0;
  let overThr = 0;
  for (let f = start; f <= end; f += 1) {
    const v = get(f);
    /**
     * ⚠️ 非有限值（`NaN` / `undefined`）**打断连续**，不是"当作达标" ✗
     *    —— 环里没写过的槽是 `undefined`，把它当达标会让窗口头部立刻成立 ✓
     */
    if (typeof v === 'number' && Number.isFinite(v) && v >= thr) {
      if (run === 0) {
        runStart = f;
        runPeak = 0;
      }
      run += 1;
      overThr += 1;
      if (v > runPeak) runPeak = v;
      if (run > bestRun || (run === bestRun && runPeak > bestPeak)) {
        bestRun = run;
        bestPeak = runPeak;
        bestStart = runStart;
      }
      /**
       * ⭐ **两个条件都满足才返回**：够长 ✓ **且** 峰值够高 ✓
       * ⚠️ 峰值不够时**不能 `return null`** ✗ —— 后面的帧可能把峰值顶上去，
       *    而那段连续还没断 ⇒ 必须继续扫 ✓（`runStart` 保持不变 ⇒ 起点仍是对的 ✓）
       */
      if (run >= need && runPeak >= peakThr) {
        if (probe) {
          probe.reason = 'found';
          probe.run = run;
          probe.peak = runPeak;
          probe.startFrame = runStart;
          probe.overThr = overThr;
          probe.frames = end - start + 1;
          probe.need = need;
          probe.peakThr = peakThr;
        }
        return runStart;
      }
    } else {
      run = 0;
      runPeak = 0;
    }
  }
  if (probe) {
    probe.run = bestRun;
    probe.peak = bestPeak;
    probe.startFrame = bestStart;
    probe.overThr = overThr;
    probe.frames = end - start + 1;
    probe.need = need;
    probe.peakThr = peakThr;
    /**
     * ⭐ 三种失败要分开 ✗ —— 它们对应的修法完全不同 ✓
     *   · 一帧都没过阈值 ⇒ **纯静音/纯音乐**，动不了了 ✓
     *   · 连续够了而峰值不够 ⇒ **音乐床贴阈值**，该加回落或抬峰值 ✓
     *   · 连续不够 ⇒ **断续**，该放宽帧数或降门槛 ✓
     */
    if (overThr === 0) probe.reason = 'no-frame-over';
    else if (bestRun >= need) probe.reason = 'peak-low';
    else probe.reason = 'run-too-short';
  }
  return null;
}

/**
 * 把 `Float32Array` / 普通数组包成 `findSpeechRun` 要的 `get` 访问器 ✓
 * ⚠️ 越界返回 `undefined`（而不是 `0`）—— 让"环里没这一帧"能被 `findSpeechRun` 判成打断 ✓
 * ⚠️ **字符串必须拒绝**：`'abc'.length === 3` ⇒ 不拦的话 `get(0)` 会返回 `'a'` ✗
 */
export function arrayGetter(probs) {
  if (!probs || typeof probs === 'string' || typeof probs.length !== 'number') return () => undefined;
  return (i) => (i >= 0 && i < probs.length ? probs[i] : undefined);
}

/** 环形缓冲的访问器：`get(i)` = `ring[i % ringLen]`，但**只认已写过的帧** ✓ */
export function ringGetter(ring, ringLen, lastFrame) {
  if (!ring || typeof ring === 'string' || typeof ring.length !== 'number') return () => undefined;
  const n = ringLen;
  if (typeof n !== 'number' || !Number.isFinite(n) || !(n > 0)) return () => undefined;
  if (typeof lastFrame !== 'number' || !Number.isFinite(lastFrame)) return () => undefined;
  return (i) => {
    if (typeof i !== 'number' || !Number.isFinite(i)) return undefined;
    if (i < 0 || i > lastFrame) return undefined;
    return ring[i % n];
  };
}

/**
 * 段内切分：在 `[fromIdx, toIdx]` 里找**一处真实的停顿**，它前面有内容、后面还有足够内容
 * ⇒ 这一句其实说了两句，应该被切开 ✗
 *
 * ## 为什么需要它
 *
 * 「提前」实测还剩 9 条（`xhsp-ab6`，两轮都延迟 10、同素材、按内容配对），
 * 其中 4 条有同一个指纹：**新路的跨度比旧路长 1.5~4 秒** ✗
 * ```
 * −5.03s 旧跨 1.8 → 新跨 3.9（1.5 字/秒）
 * −3.41s 旧跨 3.3 → 新跨 5.7（1.2 字/秒）
 * −3.38s 旧跨 4.0 → 新跨 8.0（3.4 字/秒）
 * −2.92s 旧跨 3.0 → 新跨 4.5
 * ```
 * ⇒ ⭐ Whisper 把**两句话合成了一段** ✗ ⇒ 整段的 `at` 落在第一句的开头，
 *    而拿它去和旧路配「第二句」时，就成了提前一整个第一句的时长 ✗✓✓
 *
 * ## 判据（三条都得满足，**保守方向**）
 *
 * ```
 * ① 停顿够长：连续 ≥ `minGapFrames` 帧都 < 阈值
 * ② 停顿**前面**有内容：≥ `minLeadFrames` 帧语音（否则那是段首静音，归「开口锚」管 ✗）
 * ③ 停顿**后面**还有内容：≥ `minTailFrames` 帧语音（否则会切出一个极短的第二句 ✗）
 * ```
 *
 * ⚠️ **判不准就返回 `null` ⇒ 不切** ✓ —— 宁可维持"合成一句"的现状，
 *    也不要因为一次误切而把一句话从中间断开（那比"提前"更难解释 ✗）
 *
 * ⚠️ **非有限值（`NaN` / 未写过的环槽）同时打断"语音"和"停顿"** ✗
 *    —— 把它算成静音会**凭一个坏帧造出一个停顿**，那就直接切错了 ✓
 *    （`findSpeechRun` 对它的处理是"打断连续"，这里保持同一套规矩 ✓）
 *
 * @param {(i:number)=>number} get  帧索引 → 概率（0~1）
 * @param {object} opts
 * @param {number} opts.fromIdx      起始帧（含）
 * @param {number} opts.toIdx        结束帧（含）
 * @param {number} opts.threshold    与 VAD 同一个阈值
 * @param {number} [opts.minGapFrames=12]   停顿最短帧数（40ms 窗 ⇒ 12 = 480ms）
 * @param {number} [opts.minLeadFrames=10]  停顿前至少要有的语音帧数（400ms）
 * @param {number} [opts.minTailFrames=25]  停顿后至少要有的语音帧数（1.0s）
 * @param {object} [opts.probe]      只读探针（**不传 ⇒ 行为逐字不变** ✓）
 * @returns {{splitIdx:number, gapStart:number, gapFrames:number, leadFrames:number, tailFrames:number}|null}
 */
export function planPauseSplit(get, opts) {
  if (typeof get !== 'function') return null;
  const o = opts || {};
  const probe = o.probe && typeof o.probe === 'object' ? o.probe : null;
  const miss = (reason) => {
    if (probe) probe.reason = reason;
    return null;
  };

  const fromIdx = o.fromIdx;
  const toIdx = o.toIdx;
  if (typeof fromIdx !== 'number' || !Number.isFinite(fromIdx)) return miss('invalid-args');
  if (typeof toIdx !== 'number' || !Number.isFinite(toIdx)) return miss('invalid-args');
  const thr = o.threshold;
  if (typeof thr !== 'number' || !Number.isFinite(thr)) return miss('invalid-args');

  /** ⚠️ 只认 `typeof === 'number'`（`Number(null) === 0` 那个坑今天栽过三次 ✗） */
  const frameCount = (v, dflt) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
    const f = Math.floor(v);
    return f >= 1 ? f : dflt;
  };
  const minGap = frameCount(o.minGapFrames, 12);
  const minLead = frameCount(o.minLeadFrames, 10);
  const minTail = frameCount(o.minTailFrames, 25);

  const start = Math.floor(fromIdx);
  const end = Math.floor(toIdx);
  if (!(end > start)) return miss('invalid-args');

  /** 第一遍：把窗口切成「语音 / 停顿 / 不明」三种连续段 ✓ */
  const runs = [];
  let kind = null;
  let runStart = start;
  let runLen = 0;
  const flush = () => {
    if (kind) runs.push({ kind, start: runStart, len: runLen });
  };
  for (let f = start; f <= end; f += 1) {
    const v = get(f);
    let k = 'unknown';
    if (typeof v === 'number' && Number.isFinite(v)) k = v >= thr ? 'speech' : 'silence';
    if (k !== kind) {
      flush();
      kind = k;
      runStart = f;
      runLen = 0;
    }
    runLen += 1;
  }
  flush();

  if (probe) {
    probe.runs = runs.length;
    probe.speechRuns = runs.filter((r) => r.kind === 'speech').length;
  }

  /** 第二遍：找第一个三条都满足的停顿 ✓ */
  for (let i = 0; i < runs.length; i += 1) {
    const g = runs[i];
    if (g.kind !== 'silence') continue;
    if (g.len < minGap) continue;
    let lead = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (runs[j].kind !== 'speech') break;
      lead += runs[j].len;
    }
    if (lead < minLead) continue;
    let tail = 0;
    for (let j = i + 1; j < runs.length; j += 1) {
      if (runs[j].kind !== 'speech') break;
      tail += runs[j].len;
    }
    if (tail < minTail) continue;
    /**
     * 后半句的开头 = 停顿结束后的第一帧 ✓
     * （`g.start` 是停顿首帧，`g.len` 帧之后就是语音）
     */
    const splitIdx = g.start + g.len;
    if (splitIdx >= end) continue;
    if (probe) {
      probe.reason = 'found';
      probe.splitIdx = splitIdx;
      probe.gapStart = g.start;
      probe.gapFrames = g.len;
      probe.leadFrames = lead;
      probe.tailFrames = tail;
    }
    return { splitIdx, gapStart: g.start, gapFrames: g.len, leadFrames: lead, tailFrames: tail };
  }
  return miss('no-gap');
}

/**
 * 按时间比例把一句文本切成两段（段内切分用）✓
 *
 * ## 为什么要按比例
 *
 * Whisper 的 `verbose_json` 给的是**整段**文本 + 段级 `start/end`，
 * 而这个服务端**不支持词级时间戳**（`timestamp_granularities[]=word` 解析失败，实测过 ✗）
 * ⇒ 没有"词在哪个时刻"这个信息 ⇒ 只能按时间比例分配到字符上 ✓
 *
 * ⚠️ **这是近似**：真实语速不均匀 ⇒ 切点可能偏几个字 ✓
 *    而它比"整段提前 3~4 秒全部上屏"要好得多 ✓
 *
 * ⚠️ **绝不产生空的一半** ✓ —— 一边为空就返回 `null`（= 不切）✗
 *    （空文本上屏会变成一条看不见的字幕，而那会把前一句顶掉 ✗）
 *
 * ⚠️ **按码点切，不按 UTF-16 码元切** ✗ —— 否则会把代理对（emoji）劈成两半 ✓
 *
 * @param {string} text
 * @param {number} frac  切点位置（0~1，按时间算出来的）
 * @returns {[string, string]|null}  `null` = 不切
 */
export function splitTextByFraction(text, frac) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  /** 按码点切 ✓ */
  const chars = Array.from(t);
  const n = chars.length;
  if (n < 2) return null;
  const f = typeof frac === 'number' && Number.isFinite(frac) ? frac : 0.5;
  /**
   * ⚠️ 夹到 `[0.15, 0.85]`：保证两边都不是"几个字" ✗
   *    真正的短句本来就不该被切（调用方还有段长门槛 ✓）
   */
  const clamped = Math.max(0.15, Math.min(0.85, f));
  let cut = Math.round(n * clamped);
  if (cut < 1) cut = 1;
  if (cut > n - 1) cut = n - 1;
  const a = chars.slice(0, cut).join('').trim();
  const b = chars.slice(cut).join('').trim();
  /**
   * ⚠️ 这一句是**双保险，而在当前夹紧之下不可达** ✗ —— 诚实标注，别假装它是判据 ✓
   *
   * 「不产生空的一半」真正的保证是上面那两行 `cut` 夹紧
   * （`cut ∈ [1, n-1]`，且 `n >= 2`）✓；原文全空白那种在开头 `if (!t) return null` 就挡掉了 ✓
   *
   * ⇒ 变异测试里**打不中它**：把这一行删掉，全部断言照样绿 ✓
   *    （实测过：`mut-split.cjs` 的 M3 第一版正是删它，结果 `exit=0`、0 条失败 ✗）
   *    所以 M3 改成"少切一个字"，去验**真正的不变量**（不丢字）✓
   *
   * 那为什么还留着：将来若有人放宽 `cut` 的夹紧（比如允许 0.02 的比例），
   * 这一句仍然能兜住"空的一半" —— 而空文本上屏会变成一条看不见的字幕，
   * 那会把前一句顶掉，比"切成两句"糟得多 ✗
   *
   * ⚠️ 而"删掉它没有任何断言变红"本身**不算欠账**：不可达分支删留都不改变行为 ✓
   *    会变成欠账的是"**行为变了而没人拦**"，而那条由 `cut` 夹紧的行为断言看着 ✓
   */
  if (!a || !b) return null;
  return [a, b];
}
