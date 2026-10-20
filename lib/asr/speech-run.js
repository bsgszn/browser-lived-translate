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
   * ⚠️ `Number(null) === 0` 那个坑今天栽了两次 ✗
   * ⇒ 索引必须 `typeof === 'number'` 且有限，不能用 `Number(...)`
   */
  const fromIdx = o.fromIdx;
  const toIdx = o.toIdx;
  if (typeof fromIdx !== 'number' || !Number.isFinite(fromIdx)) return null;
  if (typeof toIdx !== 'number' || !Number.isFinite(toIdx)) return null;

  const thr = o.threshold;
  if (typeof thr !== 'number' || !Number.isFinite(thr)) return null;

  /**
   * ⚠️ `need` 的归一化**必须和原来那行逐字等价**：`Math.max(1, Math.floor(Number(x)) || 1)`
   *    —— `|| 1` 让 `0 / NaN` 都退化成 1 ✓；而 `Number('7')` 仍是 7 ✓（`typeof` 守卫会把它变成 1 ✗）
   */
  const rawNeed = Number(o.minRunFrames);
  const need = Number.isFinite(rawNeed) && rawNeed ? Math.max(1, Math.floor(rawNeed)) : 1;

  const start = Math.floor(fromIdx);
  const end = Math.floor(toIdx);
  if (!(end >= start)) return null;

  const last = end - (need - 1);
  if (last < start) return null;

  let run = 0;
  for (let f = start; f <= end; f += 1) {
    const v = get(f);
    /**
     * ⚠️ 非有限值（`NaN` / `undefined`）**打断连续**，不是"当作达标" ✗
     *    —— 环里没写过的槽是 `undefined`，把它当达标会让窗口头部立刻成立 ✓
     */
    if (typeof v === 'number' && Number.isFinite(v) && v >= thr) {
      run += 1;
      if (run >= need) return f - need + 1;
    } else {
      run = 0;
    }
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
