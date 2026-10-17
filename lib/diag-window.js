// 诊断日志的窗口切片 —— 纯函数，好在测试里直接喂数字断言。
//
// ⚠️ 为什么单独一个文件：播放页（`player/player.js`）是页面脚本，
//    smoke-test 加载不了它。凡是需要被断言的行为，都得落在 `lib/` 里。
//    （同理见 `lib/delayed-player.js` 的 `isRecorderStale`。）

/**
 * 往「诊断日志 + 时间戳」这对数组里追加一行，并成对裁剪。
 *
 * ⚠️ **两个数组必须始终等长** —— 这是本模块存在的另一半理由：
 *    它们是"同一件事记两遍"，只改一处就会错位，而错位的表现是
 *    「日志和音频对不上」，极难查。所以读写都收在这里，调用方不许自己 push/splice。
 *
 * @param {string[]} lines 日志文本
 * @param {number[]} times 与 lines 一一对应的单调时间戳（performance.now()）
 * @param {string} text    这一行的文本
 * @param {number} t       这一行的时间戳
 * @param {number} keep    最多保留多少行（超出从头丢）
 * @returns {boolean} 真的写进去了返回 true；因为是连续重复行而跳过 → false
 */
export function pushDiagPair(lines, times, text, t, keep) {
  if (!Array.isArray(lines) || !Array.isArray(times)) return false;
  const line = String(text);
  // 连续重复的行不再刷屏（保持原行为：计数器那类行不该把真实日志挤掉）
  if (lines.length > 0 && lines[lines.length - 1] === line) return false;
  lines.push(line);
  times.push(typeof t === 'number' && Number.isFinite(t) ? t : 0);
  const cap = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 0;
  if (cap > 0 && lines.length > cap) {
    const drop = lines.length - cap;
    lines.splice(0, drop);
    times.splice(0, drop);
  }
  return true;
}

/**
 * 把「最近 N 秒」换算成日志数组上的起点下标。
 *
 * 纯函数 —— **当前时刻由调用方算好传进来**，这里不读 `performance.now()`
 * （那样就不可测了，而这正是本模块存在的理由）。
 *
 * 边界取 `>=`：时间戳**正好等于** `cutMs` 的那一行**算进来**。
 *
 * ⚠️ 脏值一律当「空窗口」，**绝不抛**。这个功能是在**出问题时**用的，
 *    它自己不能成为新的出错点 —— 遵循项目已定的原则：
 *    「拿不到可信输入时，宁可不说，也别误报。」
 *
 * @param {number[]} times 与日志行一一对应的单调时间戳
 * @param {number} cutMs   窗口起点（调用方用 now - windowSec*1000 算好）
 * @returns {{from:number, empty:boolean, oldestMs:number|null}}
 *   from     —— 起点下标，给调用方自己 `slice(from)`；等于 times.length 表示窗口内没有行
 *   empty    —— 窗口内一行都没有（开始时为真）
 *   oldestMs —— 缓冲区里**最早的那个有效**时间戳；一个有效值都没有时为 null
 *               （导出时用它算「缓冲区最早只有 Ns 前的记录」）
 */
export function diagWindow(times, cutMs) {
  if (!Array.isArray(times) || times.length === 0) {
    return { from: 0, empty: true, oldestMs: null };
  }

  let oldestMs = null;
  for (let i = 0; i < times.length; i++) {
    if (typeof times[i] === 'number' && Number.isFinite(times[i])) {
      oldestMs = times[i];
      break;
    }
  }

  // 起点算不出来（NaN / 无穷 / 非数字）→ 空窗口。
  // 注意这和原来的 `findIndex(t => t >= NaN)` 行为一致：返回 -1 → 空切片。
  if (typeof cutMs !== 'number' || !Number.isFinite(cutMs)) {
    return { from: times.length, empty: true, oldestMs };
  }

  // `findIndex` 的 `t >= cutMs` 对脏值天然为假，所以这里不用额外过滤
  let from = -1;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (typeof t === 'number' && Number.isFinite(t) && t >= cutMs) {
      from = i;
      break;
    }
  }
  if (from < 0) from = times.length;

  return { from, empty: from >= times.length, oldestMs };
}

/**
 * ⭐ 导出头里那段「音频与日志的时间对齐」。
 *
 * ⚠️ 为什么单独抽出来：**导出头是我们读日志的第一个依据**，
 * 而它原来只能让人**假设**「音频起点 = 日志第一行」✗ ——
 * 实际上两者来自不同的缓冲：音频从 `pcmRing` 切最后 N 秒 ✓，
 * 日志从环形缓冲按时间戳切、**会被行密度截短** ✗。
 * 不把两边的实际起止写出来，"这 12 秒没分片"就没法精确对上音频的哪一段。
 *
 * ⚠️ 也别按「日志里没有」推出「没发生」✗ —— 日志起点可能比音频晚好几秒，
 * 那几秒的事它根本没见过。所以差得明显时要**明说**。
 *
 * 纯函数：时刻由调用方传入，这里不读 `performance.now()`。
 *
 * @param {{audioTakeSec?:number, nowMs?:number, logFromMs?:number, logToMs?:number,
 *          lineCount?:number, t0?:number, lagWarnMs?:number}} [opts]
 * @returns {string} 以换行结尾的几行文本（空串表示什么都不印）
 */
export function formatAlignNote(opts = {}) {
  const { audioTakeSec = 0, nowMs, logFromMs, logToMs, lineCount = 0, t0 = 0, lagWarnMs = 500 } = opts;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const rel = (ms) => {
    const v = num(ms);
    return Number.isFinite(v) ? `+${((v - num(t0) || 0) / 1000).toFixed(3)}s` : '?';
  };
  const take = num(audioTakeSec);
  const now = num(nowMs);
  if (!Number.isFinite(now)) return '';
  const audioFrom = now - (Number.isFinite(take) && take > 0 ? take * 1000 : 0);

  let out =
    `时间对齐(同一基准 performance.now();下面各项都已减去导出时的 DIAG_T0):\n` +
    `  音频窗口  ${rel(audioFrom)} ~ ${rel(now)}` +
    `${Number.isFinite(take) && take > 0 ? `(实际 ${take.toFixed(1)}s)` : '(无音频)'}\n`;

  const lf = num(logFromMs);
  const lt = num(logToMs);
  if (!Number.isFinite(lf) || !Number.isFinite(lt)) {
    out += `  日志首末  (这一窗口内没有日志行)\n`;
    return out;
  }
  out +=
    `  日志首末  ${rel(lf)} ~ ${rel(lt)}` +
    `(共 ${Number.isFinite(num(lineCount)) ? num(lineCount) : '?'} 行,覆盖 ${((lt - lf) / 1000).toFixed(1)}s)\n`;
  const lag = lf - audioFrom;
  if (lag > (Number.isFinite(num(lagWarnMs)) ? num(lagWarnMs) : 500)) {
    out +=
      `  ⚠ 日志起点比音频起点晚 ${(lag / 1000).toFixed(1)}s —— ` +
      `那段音频**没有对应日志**,别按"日志里没有"推出"没发生" ✗\n`;
  }
  return out;
}
