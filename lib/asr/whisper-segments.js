/**
 * Whisper 先断句 · 静音只做确认 —— 决策层（纯函数,不碰 chrome、不碰全局状态）
 *
 * 实施规格见 `docs/whisper-segments-design.md`。这里只负责**一件事**：
 * 拿到 Whisper 的 `segments`（每段有 start / end / text），
 * 配合一个「该时刻之后有没有静音」的回调，决定
 *
 *   ① 哪几段可以**上屏**（accepted）
 *   ② 下一批该从**哪个时刻**开始取音频（nextStart）
 *   ③ 没被采纳的那段是什么（pending）
 *   ④ 为什么（reason）
 *
 * ⚠️ 它**不切音频**、**不发请求**、**不排期** —— 那些都由调用方做。
 *    它之所以是纯函数，是为了能被断言（这一族在项目里栽过：`tooShort` 算了没人用、
 *    `Math.min` 上限永不生效、`framesFedToGate` 同 tick 递增 —— 都是"判据存在但到不了"）。
 *
 * ## 为什么判据长这样（实测依据,别改 ✗）
 *
 * ```
 * relay-0-8  (0~8 秒) → 2 段:[0.00-4.00] そうなんだよね · [4.00-8.00] ティールで…
 * relay-0-14 (0~14秒) → 5 段:边界 4.00 / 8.00 / 11.00 / 12.00,每段都是完整句子
 * relay-65-8 (6.5 秒起) → 第一段「一瞬で今流れたりするからね」
 *   → 完整句是「ティールで一瞬で流れたりするからね」⇒ **从非句子边界起,第一句就缺字** ✗
 * ```
 * ⇒ 所以：**推进点必须是 Whisper 给的边界**，而不是"随便往前推 N 秒"。
 *    而"那句到底说完了没"由**静音**确认（Whisper 的 end 只说明它断在那儿）。
 *
 * ## 时间单位
 *
 * 本模块对单位**不敏感** —— 但 `segments.start/end`、`opts.hasSilenceAfter(t)`、
 * 返回值里的 `nextStart` **必须是同一个单位**。
 * 约定用法：**秒（相对这一批的起点）**；调用方自己加 `batchStartSec` 换算成绝对位置。
 */

/** `decideAdvance` 的 reason 取值。⚠️ 以后 `delayed-player.js` 会 switch 它 —— 不许改名 ✗ */
export const DECIDE_REASONS = Object.freeze({
  /** 每一段都拿到了"说完了"的确认 → 全部采纳 */
  ALL_ACCEPTED: 'all-accepted',
  /** 停在某一段:它 end 之后没有静音 ⇒ 那句还在说,从它的 start 重来 */
  TAIL_UNCONFIRMED: 'tail-unconfirmed',
  /** 兜底:一段都没确认,而调用方说等不及了（积压/排期）⇒ 采纳到最后一个段的 end */
  FORCE_ACCEPTED: 'force-accepted',
  /** 这一批没有任何可用的段（空 / 全是脏数据） */
  NO_SEGMENTS: 'no-segments',
  /**
   * 这一批的段**全是"没有语音"的**（`text` 是空的 / 段太短）⇒ 文本丢掉,
   * 但 **`nextStart` 要前进到最后一个空段的 `end`** ✓
   *
   * ⚠️ 和 `NO_SEGMENTS` 的区别很要紧 ✗：
   *   · `NO_SEGMENTS`  = **别推进**（`nextStart` 原样返回）—— 那是"这一批没拿到可用数据",原地重试
   *   · `EMPTY_ONLY`   = **要推进**（`nextStart` = 最后一个空段的 end）—— 那是"这段音频确实没人说话",跳过
   *   搞混的话:静音段会让 `nextStart` 卡住不动 ⇒ 整条链停在那儿 ✗
   */
  EMPTY_ONLY: 'empty-only',
});

/**
 * 洗掉不可信的段 —— 纯函数,只做形状校验,**不判语义**。
 *
 * 丢弃条件（任一）：
 *   · 不是对象
 *   · `start` / `end` **不是 number 类型**，或不是有限数
 *   · `start < 0`
 *   · `end <= start`（零长度也丢 —— 它不可能含语音）
 *
 * ⚠️ **必须要求 `typeof === 'number'`，不能只判 `Number.isFinite(Number(x))`** ✗
 *    因为 `Number(null) === 0`、`Number('') === 0`、`Number(false) === 0` ——
 *    于是 `{start: null, end: 3}` 会被当成 `0~3` 悄悄收下 ✗。
 *    这个坑在这一族里踩过两次（`exitThreshold` 的 `Number(null)`、`speechMs` 的守卫），
 *    所以这里显式挡掉 ✓。Whisper 的 `verbose_json` 给的本来就是数字，严格判不会误伤 ✓
 *
 * ⚠️ **不丢重叠**：Whisper 偶尔给相邻段重叠的边界，那是它的正常输出。
 *    重叠由调用方用「nextStart 取已采纳段的**最大** end」兜住（见 `decideAdvance`）。
 * ⚠️ **不丢超长**：`end` 超出音频总长是调用方的事，这里只做形状校验。
 *
 * @param {unknown} segments
 * @returns {Array<{start:number,end:number,text:string}>} 按 start 升序（原对象浅拷贝 + 规整后的 start/end/text）
 */
export function sanitizeSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (const raw of segments) {
    if (!raw || typeof raw !== 'object') continue;
    // ⚠️ 只认 number 类型 —— 见函数头部的说明（`Number(null) === 0` 那个坑 ✗）
    if (typeof raw.start !== 'number' || typeof raw.end !== 'number') continue;
    const start = raw.start;
    const end = raw.end;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0) continue;
    if (!(end > start)) continue;
    out.push({ ...raw, start, end, text: typeof raw.text === 'string' ? raw.text : '' });
  }
  // 按 start 升序；相等时保持原顺序（Array#sort 在 Node 里是稳定的）
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 决定这一批怎么推进。
 *
 * @param {unknown} segments Whisper 返回的 `segments[]`
 * @param {{
 *   hasSilenceAfter?: (end: number, seg: object) => boolean,
 *   force?: boolean,
 *   from?: number|null,
 * }} [opts]
 *   · `hasSilenceAfter(end)` —— **静音判据的注入点**。返回 `true` 表示"这段之后确实静音了"
 *     （即"这句话说完了"）。
 *     ⚠️ **不传 → 视为"一律没有静音"**（保守：不确定就不上屏）。
 *        那样只有 `force` 能把东西推上屏 —— 所以生产代码必须传它。
 *   · `force` —— 调用方判断「积压 / 会超排期」时置 `true`。
 *     ⚠️ 它**只在"这一批一段都没被确认"时生效**（见规格 §三⑤）：
 *        只要确认了哪怕一段，就已经有进展，不该再硬推没确认的尾巴。
 *   · `from` —— 这一批的起点（同一单位）。**只用于"没有可用段"时把 nextStart 原样返给调用方**，
 *     表示"别推进"。
 *
 * @returns {{
 *   accepted: Array<{start:number,end:number,text:string}>,
 *   nextStart: number|null,
 *   pending: object|null,
 *   reason: string,
 *   dropped: number,
 * }}
 *   · `accepted` —— 可以上屏的段（按 start 升序）
 *   · `nextStart` —— 下一批的取样起点（`accepted` 里**最大**的 `end`；没采纳则为 `pending.start`；没段则为 `from`；
 *     全批都没语音则为**最后一个空段的 end** —— 那是"跳过",不是"别推进"）
 *   · `pending` —— 没被采纳的那段（没有则 `null`）
 *   · `reason` —— `DECIDE_REASONS` 里的一值
 *   · `dropped` —— 被 `sanitizeSegments` 丢掉的数量（形状/数值非法，诊断用）
 *   · `speechless` —— 被判成"没有语音"而**跳过**的数量（`text` 空 / 段太短，见 `isSpeechless`）
 */
/** 短于这个秒数就当"装不下一个完整音节"（见 `isSpeechless`） */
export const SPEECHLESS_MAX_SEC = 0.1;

/**
 * 这一段是不是"**没有语音**"?—— 纯函数。
 *
 * 判据（任一成立即为"没有语音"）：
 *   ① `text` 去空白后为空 ✓ —— 这是最干净的信号:Whisper 什么都没吐
 *   ② `end - start < SPEECHLESS_MAX_SEC`（0.1 秒）✓ —— 短到装不下一个完整音节
 *
 * ⚠️ **刻意不用 `no_speech_prob`** ✗ —— 实测它会误伤：
 *    真机日志里 `no_speech_prob = 0.73` 的那段是**真的有人在说话**（「このグッズでよ」）,
 *    而幻觉那两句反而有 0.79 / 0.86 —— **两个区间重叠**,拿它当"没有语音"会杀掉真句子 ✗。
 *    （同一天还有一次同族翻车：`isHardCutTail` 用 `prevCut` 当条件，只覆盖 2/14 ✓）
 *
 * @param {{start:number,end:number,text?:string}} seg 已过 `sanitizeSegments` 的段
 * @returns {boolean}
 */
export function isSpeechless(seg) {
  if (!seg || typeof seg !== 'object') return true;
  const text = typeof seg.text === 'string' ? seg.text : '';
  if (text.trim() === '') return true;
  const dur = Number(seg.end) - Number(seg.start);
  if (Number.isFinite(dur) && dur < SPEECHLESS_MAX_SEC) return true;
  return false;
}

export function decideAdvance(segments, opts = {}) {
  const list = sanitizeSegments(segments);
  const total = Array.isArray(segments) ? segments.length : 0;
  const dropped = total - list.length;

  const from = Number.isFinite(Number(opts.from)) ? Number(opts.from) : null;

  if (list.length === 0) {
    return { accepted: [], nextStart: from, pending: null, reason: DECIDE_REASONS.NO_SEGMENTS, dropped, speechless: 0 };
  }

  const hasSilence = typeof opts.hasSilenceAfter === 'function' ? opts.hasSilenceAfter : null;
  const force = opts.force === true;

  // ⭐ 先把「没有语音」的段挑出来 —— 它们**不是可采纳的段**,但**必须推进** ✗
  //    ⚠️ 关键:若把静音段当成"没确认"（stall），`nextStart` 会卡在它前面不动 ⇒ 整条链停在那儿 ✗
  //    所以静音段要**跳过**（`nextStart` 越过它），而不是"等它确认" ✓
  const usable = [];
  let speechless = 0;
  let speechlessLastEnd = null;
  for (const seg of list) {
    if (isSpeechless(seg)) {
      speechless++;
      speechlessLastEnd = seg.end;
      continue;
    }
    usable.push(seg);
  }

  if (usable.length === 0) {
    // 整批都是"没有语音" ⇒ 文本丢掉,但要**跳过这段音频** ✓（不是"别推进"✗）
    return {
      accepted: [],
      nextStart: speechlessLastEnd,
      pending: null,
      reason: DECIDE_REASONS.EMPTY_ONLY,
      dropped,
      speechless,
    };
  }

  const accepted = [];
  let stalled = null;

  for (const seg of usable) {
    let confirmed = false;
    if (hasSilence) {
      try {
        confirmed = hasSilence(seg.end, seg) === true;
      } catch {
        // ⚠️ 回看静音出错 → **当作"没有静音"**（保守）。
        //    理由:不确定就别上屏。反过来会把半句推上去 —— 而"半句上屏"比"晚一句"难查得多。
        //    而真卡住了还有 `force` 兜底,不会永久不出字幕 ✓
        confirmed = false;
      }
    }
    if (!confirmed) {
      stalled = seg;
      break;
    }
    accepted.push(seg);
  }

  if (stalled) {
    // 兜底:这一批**一段都没确认**,而调用方说等不及了 → 采纳到最后一个段的 end
    // ⚠️ 用 Whisper 的边界（segment 的 end），**不用 VAD 找切点** ——
    //    因为 Whisper 断的地方至少是词边界，而 VAD 给的是电平方差突变点，可能落在词中间 ✗
    // ⚠️ 用 `usable` 而不是 `list` ✗ —— 空段（没语音）的文本绝不能上屏 ✓
    if (accepted.length === 0 && force) {
      const last = usable[usable.length - 1];
      return {
        accepted: usable.slice(),
        nextStart: last.end,
        pending: null,
        reason: DECIDE_REASONS.FORCE_ACCEPTED,
        dropped,
        speechless,
      };
    }
    return {
      accepted,
      // ⭐ 这里就是「**前空后有声**」的处理 ✓：
      //    若 `stalled.start > 0`，说明这一批开头有一段 Whisper 没识别的（静音/无效）✗，
      //    `nextStart` 会直接跳到 `stalled.start` ⇒ **前面的空被切掉** ✓，
      //    而 `[stalled.start, stalled.end]` 就是那段"小尾巴"（`pending`）✓
      //    —— 它不单独上屏,下一批从它开头**连续重采** ✓（不是拼接 ✗）
      nextStart: stalled.start,
      pending: stalled,
      reason: DECIDE_REASONS.TAIL_UNCONFIRMED,
      dropped,
      speechless,
    };
  }

  // 每一段都确认了
  // ⚠️ 取**最大**的 end（而不是最后一段的 end）—— Whisper 偶尔给重叠边界，
  //    取最后一个会让推进点倒退 ✗
  let nextStart = accepted[0].end;
  for (const seg of accepted) if (seg.end > nextStart) nextStart = seg.end;
  return { accepted, nextStart, pending: null, reason: DECIDE_REASONS.ALL_ACCEPTED, dropped, speechless };
}
