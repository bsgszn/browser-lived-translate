/**
 * 批内相邻段合并 —— 「一句话被 Whisper 断成两段」时，**在送翻译之前**把它们接回去。
 *
 * ## 为什么必须有这一层
 *
 * 用户的现场（`livedtranslate-20261023-040537`）：
 * ```
 * [+38.899s] 识别  意識を          ← 3 字
 * [+38.900s] 识别  引き締めていないですけど
 * ```
 * 那是**一句话**（「意識を引き締めていないですけど」），而 Whisper 在「を」后面
 * 断成了两段 ✗ ⇒ **我们分开送翻译** ✗ ⇒ DeepL 拿到两个半句、译文残缺 ✓
 *
 * ⚠️ **显示层的"合并"救不了这个** ✗ —— 它只能把两个**已经分开翻的**译文拼在一起，
 *    而翻译质量在更早一步就已经掉了 ✓
 * ⇒ 所以必须在 `transcribe → 翻译` 之间接回去 ✓
 *
 * ## 判据（保守：判不准就不合）
 *
 * ① **前一段以助词结尾** —— 助词不可能结束一句话 ✓ 这是最强的信号：
 *    `を / は / が / に / で / と / も / へ / や / の / から / まで / より / って`
 * ② **两段之间的空隙 < `maxGapMs`**（默认 300ms）—— 同一批产出时通常就是 0 ✓
 * ③ **合并后不超过 `maxMergedChars`**（默认 60 字）—— 防止把一整段全吞成一条 ✗
 *
 * ⚠️ 三条缺一就不合 ✓ —— 单靠"空隙小"会误合「〜です。」+「〜ます。」（两句）✗
 *
 * ## 合并的语义
 *
 * · 文本：**日语不加空格**直接拼（`意識を` + `引き締め…` = `意識を引き締め…`）✓
 * · 起点：取**前一条**的 `startAbs` ✓ —— 那才是这句话真正开始的地方 ✓
 * · 终点：取**后一条**的 `endSec` ✓
 * · `wordStart`：取前一条的 ✓（"第一个词从哪儿开始"不变 ✓）
 */

/** 以这些结尾的段，几乎一定不是完整句（日语助词 / 助动词连用形残尾）✓ */
export const PARTICLE_TAILS = [
  'を', 'は', 'が', 'に', 'で', 'と', 'も', 'へ', 'や', 'の',
  'から', 'まで', 'より', 'って', 'けど', 'ので', 'のに', 'ば',
];

/** 两段之间的空隙上限（毫秒）。同一批产出时通常就是 0 ✓ 放宽只为容错。 */
export const MERGE_ADJACENT_MAX_GAP_MS = 300;

/** 合并后的字数上限 —— 防止把一整段全吞成一条 ✗ */
export const MERGE_ADJACENT_MAX_CHARS = 60;

/**
 * 前一段是不是"没说完"（以助词结尾）。
 *
 * ⚠️ 只看**最后一个非空白字符**所在的后缀 ✓ —— 不做分词（没有可靠的分词器，
 *    而猜测性分词会把「です」也当助词 ✗）。
 */
export function endsWithParticle(text, tails = PARTICLE_TAILS) {
  const t = String(text ?? '').trim().replace(/[\s。．.!?！？、,，]+$/u, '');
  if (!t) return false;
  // 后缀匹配要**长的优先**，否则「から」会被「ら」之类先截断（这里只按长度降序试）
  const sorted = [...tails].sort((a, b) => b.length - a.length);
  for (const tail of sorted) {
    if (tail && t.endsWith(tail)) return true;
  }
  return false;
}

const charCount = (s) => String(s ?? '').replace(/\s/g, '').length;

/**
 * 把一批里的相邻条目按上面的判据合并。
 *
 * @param {Array<{text:string,startSec:number,endSec:number,startAbs:number,wordStart:?number}>} pieces
 * @param {{tails?:string[], maxGapMs?:number, maxMergedChars?:number}} [opts]
 * @returns {{ pieces: Array, merged: number }}  `merged` = 合成了几次（诊断用）
 *
 * ⚠️ **纯函数**：不改入参、不读时间、不碰全局 ✓ —— 所以断言能直接喂数据验证 ✓
 * ⚠️ 输入脏（非数组 / 元素缺字段）⇒ 原样返回，**绝不丢条目** ✓
 */
export function mergeAdjacentPieces(pieces, opts = {}) {
  const maxGapMs = Number.isFinite(Number(opts.maxGapMs)) ? Number(opts.maxGapMs) : MERGE_ADJACENT_MAX_GAP_MS;
  const maxChars = Number.isFinite(Number(opts.maxMergedChars)) ? Number(opts.maxMergedChars) : MERGE_ADJACENT_MAX_CHARS;
  const tails = Array.isArray(opts.tails) && opts.tails.length ? opts.tails : PARTICLE_TAILS;
  if (!Array.isArray(pieces) || pieces.length < 2) return { pieces: Array.isArray(pieces) ? pieces.slice() : [], merged: 0 };

  const out = [];
  let merged = 0;
  for (const p of pieces) {
    // 脏条目：原样透传（**不许丢** ✗ —— 丢一条就是丢一句话）
    if (!p || typeof p.text !== 'string') {
      out.push(p);
      continue;
    }
    const prev = out[out.length - 1];
    if (!prev || typeof prev.text !== 'string') {
      out.push({ ...p });
      continue;
    }
    const gapMs = (Number(p.startSec) - Number(prev.endSec)) * 1000;
    const gapOk = Number.isFinite(gapMs) && gapMs <= maxGapMs;
    const particleOk = endsWithParticle(prev.text, tails);
    const sizeOk = charCount(prev.text) + charCount(p.text) <= maxChars;
    if (gapOk && particleOk && sizeOk) {
      out[out.length - 1] = {
        ...prev,
        // ⚠️ 日语拼句**不加空格** ✓（中文/日文都不加；加空格会在字幕里显出一个空位 ✗）
        text: `${prev.text}${p.text}`,
        endSec: Number.isFinite(Number(p.endSec)) ? Number(p.endSec) : prev.endSec,
        // startAbs / startSec / wordStart **保持前一条** ✓ —— 那句话是从那儿开始的
      };
      merged += 1;
      continue;
    }
    out.push({ ...p });
  }
  return { pieces: out, merged };
}
