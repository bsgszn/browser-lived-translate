/**
 * 「这一小段 PCM 里有没有一段够长的静音」—— **纯函数**。
 *
 * 为什么单独一个文件：新断句架构（Whisper 先断）要判断「某段的 `end` 之后
 * 是不是真的静了」，而这件事**必须**能单测。放进 `vad.js` 会把它和主链绑死。
 *
 * ## 为什么用相对判据，而不是绝对电平
 *
 * ⚠️ 这一天已经证明：**绝对阈值对低电平的流够不着** ✗
 *   · `HUMAN_LEVEL_RMS = 0.03` —— 实测真实流只有 0.012，**永远达不到** ✗
 *   · `SILENT_LEVEL_RMS = 0.003` —— 那条流"说话"时是 0.0128，**会被当成静音** ✗
 * 所以这里的判据是「**比这段自己最响的地方低多少**」✓ —— 随流走，不受整体增益影响。
 *
 * ## 判据（照着 `vad.js` 那套 `lullRatio` + `silentRms` 的口径，不另造）
 *
 * ```
 * ceil      = 这段 PCM 自己电高分位            （默认 p90）
 * lullLine  = ceil × lullRatio                （默认 0.15 —— 见下面的标定）
 * 一段窗     = 低于 lullLine                    ⇒ 这一窗"安静"
 * 返回       最长连续安静跨度 >= minSilenceMs  ⇒ true
 * ```
 *
 * ### `lullRatio = 0.1` 是怎么来的（真机四档电平 + 一次参数扫描）
 *
 * ```
 * 静音   0.0000 / 0.0007        ← 真机日志的「输入电平」
 * 说话   0.0128 / 0.0416 / 0.1727
 * ```
 *
 * ⚠️ **直觉上"0.5 会把小声说话当静音"是错的** ✗ —— 因为 `ceil` 就是那段自己的高分位，
 * `0.0128 > 0.0128 × 0.5` 恒成立，所以只要整段电平均匀，比例取多大都一样。
 * 比例真正起作用是在「**先短促的大声、后面才是持续的小声**」这种形态上：
 * ```
 * 用例：100ms 爆音 0.1727 → 600ms 小声 0.0128 → 240ms 静音 0.0007
 * 期望：最长静音 = 240ms（只量静音那段）
 *
 *   lullRatio 0.05 → **0ms**    ✗ 太小，连真静音都没判出来
 *   lullRatio 0.10 → **240ms**  ✓
 *   lullRatio 0.15 → **800ms**  ✗ 太大，把 600ms 的小声说话也吞了（800 = 600 + 240 − 40）
 *   lullRatio 0.20+ → 800ms    ✗
 * ```
 * ⇒ **0.1 是这个形态上唯一两边都对的值** ✓
 *   （0.05 会把 0.0128 的整段也判成静音 ⇒ 最长静音 0 ⇒ 「小声 + 静音」那组全错）
 *
 * ### 它什么时候会失效
 *
 * ```
 * · **语音全程很小声**（说话 0.004、静音 0.003）⇒ 只差 1.3 倍，分不开 ✗
 *   → 那时 `ceil` 和 `lullLine` 挤在一起，任何比例都不行 ✓
 * · **持续的音乐 / 底噪很大** ⇒ 没有明显低谷，判成"不静音"✓（保守方向，可接受 ✓）
 * · **一段里只有咳嗽/敲击** ⇒ 峰值很高而 `ceil` 被它抬高，其余全算静音 ✓（保守方向 ✓）
 * ```
 *
 * ## 为什么不用 Silero VAD
 *
 * VAD 是**异步**的（要 `await speechProb()`），而这里必须是纯函数才能单测。
 * 调用方如果想用 VAD 的概率，把它当参数传进来即可（见 `opts.isQuiet`）。
 */

/** 一窗的默认长度（毫秒）—— 和 VAD 的 640 采样窗对齐（16000 Hz ⇒ 40 ms） */
export const SILENCE_WIN_MS = 40;

/**
 * 默认"多长算静音"（毫秒）—— 比一个音节长，比一次换气短。
 *
 * ⚠️ **取 200 而不是 250，是因为窗粒度是 40ms** ✗
 * 判定的最小单位是**一个整窗**（40 ms），所以门槛会被"向上取整到窗"：
 * ```
 * 门槛 250 → 需要 ⌈250/40⌉ = 7 窗 = 280ms 才判 true   ⇒ 250~279ms 的静音被判 false ✗
 * 门槛 200 → 需要 ⌈200/40⌉ = 5 窗 = 200ms 就判 true   ⇒ 200~239ms 判 true ✓
 * ```
 * 而"判 false"是**保守方向**（不采纳 → 等下一批），代价是每句多等一个窗；
 * 所以宁可把门槛设在窗的整数倍上，让它可预期 ✓
 */
export const SILENCE_MIN_MS = 200;

/** 默认低谷比例 —— 见文件头的标定 */
export const SILENCE_LULL_RATIO = 0.1;

/**
 * 默认"整段都算静音"的绝对地板 —— 复用项目自己的 `SILENT_LEVEL_RMS`（0.003）。
 *
 * ⚠️ **没有这个地板，纯相对判据分不开「全程静音」和「全程说话」** ✗
 * 因为两者的窗电平都**均匀**（各自都 ≈ 自己的 `ceil`），最长低谷都是 0 ms：
 * ```
 * 全程静音 0.0007 → ceil 0.0007 → 没有一个窗低于 ceil×0.15 → best 0 → false ✗（该 true）
 * 全程说话 0.0416 → ceil 0.0416 → 同上                        → best 0 → false ✓（该 false）
 * ```
 * 而它们的绝对电平差 **59 倍** ⇒ 只有绝对地板能分开 ✓
 * 0.0007 < 0.003 ✓ ⇒ 整段静音 ⇒ 返回全长 ✓
 * 0.0128 > 0.003 ✓ ⇒ 走相对判据 ✓ ⇒ 全程说话判 false ✓
 */
export const SILENCE_FLOOR_RMS = 0.003;

/** 默认高分位 —— 用分位而不是最大值，避免被一次爆音抬高 */
export const SILENCE_CEIL_PCT = 0.9;

/** 一窗的 RMS（0~1 口径，和 `lastInputRms` 一致）。内部用，导出是为了断言 */
export function winRms(int16, from, to) {
  const a = Math.max(0, from | 0);
  const b = Math.min(int16?.length || 0, to | 0);
  if (!(b > a)) return 0;
  let sum = 0;
  for (let i = a; i < b; i += 1) {
    const v = (int16[i] || 0) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / (b - a));
}

/** 分位数（线性插值）。空数组 → `NaN` */
export function pickPct(values, pct) {
  const list = (values || []).filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!list.length) return NaN;
  const p = Math.min(1, Math.max(0, Number(pct)));
  const at = (list.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  if (lo === hi) return list[lo];
  return list[lo] + (list[hi] - list[lo]) * (at - lo);
}

/**
 * 这段 PCM 里，最长的一段"连续安静"有多长（毫秒）。
 *
 * ⚠️ 返回 `null` 表示**判不了**（数据不足 / 拿不到 `ceil`），调用方要自己决定怎么办。
 * 而 `hasSilenceIn` 把 `null` 当作 **false**（保守：不确定就当作"没静音"）。
 */
export function longestSilenceMs(pcm, opts = {}) {
  const {
    sampleRate = 16000,
    winMs = SILENCE_WIN_MS,
    lullRatio = SILENCE_LULL_RATIO,
    ceilPct = SILENCE_CEIL_PCT,
    minCeil = SILENCE_FLOOR_RMS,
  } = opts;

  if (!pcm || typeof pcm.length !== 'number' || !pcm.length) return null;
  if (!(sampleRate > 0) || !(winMs > 0)) return null;

  const perWin = Math.max(1, Math.round((sampleRate * winMs) / 1000));
  const wins = Math.floor(pcm.length / perWin);
  if (wins < 1) return null;

  const rmsList = [];
  for (let w = 0; w < wins; w += 1) {
    rmsList.push(winRms(pcm, w * perWin, (w + 1) * perWin));
  }

  const ceil = pickPct(rmsList, ceilPct);
  if (!Number.isFinite(ceil)) return null;

  /**
   * ⚠️ 整段几乎无声（`ceil` 低到地板以下）⇒ 那**整段都是静音** ✓
   * 这一条和 `vad.js` 的 `findLullCut` 不同：那边的语义是"找不到低谷就不断"，
   * 而这里问的是"有没有静音"，整段都静当然算有。
   */
  if (ceil < minCeil) return (wins * perWin * 1000) / sampleRate;

  const lullLine = ceil * lullRatio;
  let run = 0;
  let best = 0;
  for (let w = 0; w < wins; w += 1) {
    if (rmsList[w] < lullLine) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return (best * perWin * 1000) / sampleRate;
}

/**
 * 这段 PCM 里有没有 ≥ `minSilenceMs` 的连续静音。
 *
 * 返回 `true` / `false`（**不返回 `null`**：判不了就当 `false`，保守方向）。
 */
export function hasSilenceIn(pcm, opts = {}) {
  const { minSilenceMs = SILENCE_MIN_MS, ...rest } = opts;
  const longest = longestSilenceMs(pcm, rest);
  if (longest === null) return false;
  if (!Number.isFinite(minSilenceMs) || minSilenceMs <= 0) return false;
  return longest >= minSilenceMs;
}
