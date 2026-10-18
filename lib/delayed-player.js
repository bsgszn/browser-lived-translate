// 延迟播放引擎。
//
// 目标：把标签页画面推迟 D 秒再显示，让"识别 + 翻译"有足够时间在对应画面出现之前完成。
//
// 做法：tabCapture 拿到的是实时流 → MediaRecorder 切成 webm 分片 → 喂给 MSE 的 SourceBuffer
// → <video> 从这个不断增长的缓冲里播放 → 把播放头锁在「缓冲末尾 − D」。
//
// 关键点：不能直接 seek 到目标位置就完事。缓冲末尾和播放头都在实时推进，任何一点速率差
// 都会让 D 慢慢漂走；而频繁 seek 会肉眼可见地跳帧。
//
// 所以延迟的维持靠两件事：
//   ① **起播时一步到位** —— 攒够 D 秒再起播，把播放头直接放到「缓冲末尾 − D」。
//   ② **涨太多就跳一次** —— 前方缓冲超过「D + 按码率算的余量」时跳一下拉回目标
//      （见 _overDelayJumpSec）。不做这一步的话，延迟会一路涨到撞穿 MSE 配额、播放头卡死。
//
// ⚠️ 还有一条**默认关闭**的第三条路：`smoothRate`（变速纠偏，用 ±6% 的 playbackRate
// 把延迟慢慢拉回来，preservesPitch 保持音调）。默认关是因为 ±6% 变速 + 反复改速率
// 在 4K 画面上是看得见的顿挫。**关着的时候速率恒为 1，没有任何机制把涨上去的延迟
// 慢慢拉回来** —— 只剩 ② 那个跳。
// `lagCorrectionRate` 这个纯函数仍然导出并单测，但只有开启 smoothRate 时才被调用。
//
// 这里刻意只依赖 MediaRecorder / MediaSource / HTMLVideoElement 三样东西。

export const DELAY_MIN_SEC = 3;
/**
 * 延迟上限（秒）。
 *
 * ⚠️ 这个上限直接决定"识别滞后"能不能被延迟覆盖住。
 * 分片识别的总滞后 ≈ 分片时长 × 2 + 推理时间（第一个分片要攒满，
 * 末句还要等下一个分片才能判断跨片），所以分片 3 秒时约 6.6 秒。
 * 原来卡在 8 秒，用户一遇到 10 秒级的滞后就完全没辙 —— 放宽到 12 秒留余量。
 */
export const DELAY_MAX_SEC = 12;

/**
 * 旧缓冲攒够这么多秒才丢一次。
 *
 * 为什么要攒：`SourceBuffer.remove()` 和 `appendBuffer()` 共用同一个队列串行执行，
 * 每次 remove 都要让解码器重新评估缓冲区间、并卡住后面的 append。
 * 以前每 400ms 丢一次，缓冲一薄画面就顿 —— 这是"画面偶尔顿一下"的成因。
 * 攒到 20 秒才丢，代价只是多占十几 MB（4 Mbps × 20s ≈ 10 MB）。
 */
export const TRIM_GARBAGE_SEC = 20;
/** 两次清理之间至少隔这么久（毫秒），免得连着触发 */
export const TRIM_MIN_INTERVAL_MS = 10_000;

export function clampDelay(sec) {
  const v = Number(sec);
  if (!Number.isFinite(v)) return DELAY_MIN_SEC;
  return Math.min(DELAY_MAX_SEC, Math.max(DELAY_MIN_SEC, v));
}

/**
 * 录制器启动后的宽限期（毫秒）。这期间「已输出 0 字节」是**正常暂态**。
 *
 * ⚠️ 实测依据：真实标签页采集跑两次，开头都报 0 字节，随后几秒内涨到 13~27 MB、
 * 缓冲填到 5~6.7s、画面完全正常 —— **MediaRecorder 要几秒才吐出第一片。**
 * 对照：反馈者那次是 **63 秒仍然 0**，那才是真故障，不能被宽限期一起漏掉。
 */
export const REC_GRACE_MS = 10000;

/**
 * 录制器是不是「该报警的没输出」状态。
 *
 * ⚠️ **纯函数** —— 不读 `Date.now()`、不读全局状态，`Date.now()` 的调用留在调用方。
 * 这样断言只要喂数字，不需要在假 video 上推进时间。
 *
 * ⚠️ 基准是**从录制开始**算起的毫秒数，**不是「遮罩显示的时刻」**：遮罩要 15 秒
 * 兜底才出现，拿它当基准等于把宽限期白送掉。（判据基准选错这个项目栽过两次。）
 *
 * ⚠️ 脏值（NaN / 非有限）一律返回 false —— 也就是「还没到宽限期，不报警」。
 * 拿不到开始时间时**宁可不说，也别误报**：健康启动初期本来就是 0 字节。
 *
 * @param {number} elapsedMs 从录制开始到现在的毫秒数
 * @param {number} bytes     录制器累计输出的字节数
 * @returns {boolean} true 表示「过了宽限期却仍然一个字节都没有」，该报警
 */
export function isRecorderStale(elapsedMs, bytes) {
  // ⚠️ 只接受**真正的数值**。`Number(null)` 是 0、`Number('')` 也是 0 ——
  // 用 Number() 强转的话，`null` 会被当成"0 字节"从而误报（断言抓到的第二个坑）。
  if (typeof elapsedMs !== 'number' || typeof bytes !== 'number') return false;
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(bytes)) return false;
  // ⚠️ 负数是不可能值（时间倒流 / 字节数为负）—— 同样按「宁可不说，也别误报」处理。
  if (elapsedMs < 0 || bytes < 0) return false;
  if (bytes > 0) return false;
  return elapsedMs >= REC_GRACE_MS;
}

/**
 * 「缓冲还没攒够」之后，还要再等多久才算「一直没能起播」。
 *
 * 起播需要缓冲满 `delaySec + 0.3`，而录制端是**实时**的 —— 所以正常情况下
 * `delaySec` 出头就该起播了。这里额外留一段时间给编码/封装滞后
 * （实测"缓冲末尾落后实况"是 0.4~1.8 秒），留 4 秒足够宽松。
 */
export const NO_START_GRACE_MS = 4000;

/**
 * 「只有初始化段」的字节上限。
 *
 * 实测（v2.66.57，静止标签页，4K45，79 Mbps）：30 秒里记录器只输出 **36 字节 / 1 片**。
 * 那不是画面，是 fMP4 的文件头（`ftyp`）。一帧 4K 的 250ms 分片即使按最低码率也是几 KB 起，
 * 所以"几十字节"这个量级只可能是初始化段 —— 阈值取 1 KB 足够把它和真正的小分片分开，
 * 而且判据里还叠加了 `ranges === 0`（压进去之后一个可播区间都没有），两条同时成立才下结论。
 */
export const INIT_SEGMENT_MAX_BYTES = 1024;

/**
 * 「前方缓冲一直很薄」到底是哪一种 —— **纯函数**，喂数字即可断言。
 *
 * ⚠️ 为什么必须分类，不能只看 `ahead < 1.5`：
 *
 * `_tick()` 在 `!locked` 时会**提前 return**（要等缓冲攒够），所以
 * `bufferAheadSec` 在起播之前**一直接近 0**（而且它压根没被更新过）。
 * 于是「前方 0.0s」在启动阶段是**预期状态，不是故障** ——
 * 早先的判据只看 `ahead < 1.5 && bytes > 0`，结果在**完全健康**的启动里报了
 * 「录制器在输出但缓冲填不上：数据进不了 SourceBuffer」，而下一行就是
 * 「延迟播放已就绪」。（用户 v2.66.25 的实测日志里，报警和起播只差一行。）
 *
 * ⚠️ 这条误报的危害不只是噪音：它把用户**直接引向错的那一层** ——
 * 而"录制/采集层 vs 缓冲层"正是排查这个故障最贵的一次分辨。
 *
 * 返回值：
 *   `'warming'`          正常攒缓冲 / 正常启动初期 —— **不报警**
 *   `'recorder-stopped'` 录制器**自己停了**（不是我们停的）→ 这是**原因**，别的都是症状
 *   `'no-output'`        过了宽限期仍然 0 字节 → 录制/编码层没产出
 *   `'no-frames'`        只有**初始化段**（几十字节、0 个可播区间）→ 编码器没拿到画面帧
 *                        （静止标签页就是这个形态：tabCapture 只在页面有变化时给帧）
 *   `'never-started'`    有数据、但过了起播时限仍未起播 → 卡在前端（含"解不出帧"）
 *   `'cannot-append'`    已起播、前方却一直很薄 → 数据进不了 SourceBuffer
 *
 * ⚠️ 脏值一律回 `'warming'`（宁可不说，也别误报）—— 和 `isRecorderStale` 同一条原则。
 *
 * @param {{elapsedMs?: number, bytes?: number, ranges?: number, locked?: boolean, delayMs?: number, recorderInactive?: boolean}} s
 * @returns {'warming'|'recorder-stopped'|'no-output'|'no-frames'|'never-started'|'cannot-append'}
 */
export function classifyThinBuffer(s) {
  const st = s && typeof s === 'object' ? s : {};
  const elapsedMs = st.elapsedMs;
  const bytes = st.bytes;
  // 只有**真正的数值**才算数（`null`/`''` 经 Number() 会变 0，那是误报的源头）。
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return 'warming';
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'warming';
  /**
   * ⚠️ 录制器**自己停了** —— 必须排在最前面，因为它是**原因**，其余都是症状。
   *
   * 不判这一条的话：起播之后录制器一停，`_tick()` 就不再推进缓冲，
   * 前方缓冲很快被播放头吃光 → `ahead` 掉到 0 → 落到下面的 `'cannot-append'`，
   * 于是日志说「数据进不了 SourceBuffer」✗ —— 而真正发生的是**采集断了**。
   * 那又是一次"把用户引向错的那一层"。
   *
   * （调用方用 `state === 'inactive' && !stopped` 算这个值：我们主动 stop() 时
   *  `stopped` 已置真，所以不会被算成"自己停的"。）
   */
  if (st.recorderInactive === true) return 'recorder-stopped';
  // 一个字节都没有：交给 isRecorderStale（它自己管宽限期与脏值）。
  if (bytes === 0) return isRecorderStale(elapsedMs, bytes) ? 'no-output' : 'warming';
  // 已经起播：这时 `ahead` 才是可信的（`_tick` 会持续更新它）。
  if (st.locked === true) return 'cannot-append';
  /**
   * 还没起播：在起播时限内属正常，超过才算异常。
   *
   * ⚠️ `delayMs` 不合法时**直接回 warming**（也就是不报警），不回退到 0 ——
   * 因为不知道"该多久起播"就断言"一直没能起播"是**没有依据的指控**。
   * 这正是上面那条误报的同一个教训:宁可不说，也别把用户引向错的方向。
   * （实践中 `currentDelayMs()` 一定给得出数字，所以这里不会掩盖真问题。）
   */
  const delayMs = st.delayMs;
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) return 'warming';
  if (elapsedMs < delayMs + NO_START_GRACE_MS) return 'warming';
  /**
   * ⚠️ 过了起播时限还没起播 —— 这时才分得清"卡在前端"的两种形态：
   *
   *   · 只有**初始化段**（几十字节）→ `no-frames`：编码器连一帧都没拿到。
   *     实测（v2.66.57，静止标签页）: 30 秒只有 **36 字节 / 1 片 / 0 个可播区间**，
   *     而日志原本报的是「缓冲里有数据但画面起不来，卡在采集/编码侧」✗ ——
   *     "有数据"是假的：那一小段是 fMP4 的文件头，没有任何画面帧。
   *     真实原因在**源**：标签页静止时 tabCapture 一帧都不给（这条在 player.js 里早有记录）。
   *     把"卡在采集/编码侧"改成"源没有产生新画面"，用户才知道该去动哪个东西 ✓
   *
   *   · 数据量正常但没有可播区间 / 起不来 → `never-started`（解不出帧、关键帧缺失等）
   *
   * ⚠️ 只按 `bytes` 小就判 `no-frames`，必须同时要求 `ranges === 0`：
   * 低码率小分片也可能几百字节，但那种压进去是有可播区间的。
   */
  if (st.ranges === 0 && bytes > 0 && bytes <= INIT_SEGMENT_MAX_BYTES) return 'no-frames';
  return 'never-started';
}

/**
 * 闭环纠偏：根据"当前播放头"与"应该在的位置"的偏差，算出这一拍该用的 playbackRate。
 *
 * drift > 0 表示播放头超前了（延迟不够），要放慢；drift < 0 表示落后太多，要加速。
 *
 * ⚠️ **必须有迟滞**，这是踩过的坑：
 * 原来只有死区（|drift| < 0.25 就返回 1），于是一旦偏差在 0.25 附近抖动，
 * playbackRate 就会 1.00 ↔ 0.94 反复横跳。而 `preservesPitch = true` 时
 * **每次改速率都要重建时间伸缩器（WSOLA）**，反复重建的听感就是"噗噗"的扑动 ——
 * 而且时间伸缩的失真对**人声**最明显（音乐糊得过去），
 * 所以现象是"只有人物说话才有噗噗声"。
 *
 * 现在：进入纠偏要 0.25 秒偏差，但**一旦开始就一路纠到 0.06 秒以内才停**。
 *
 * @param {number} driftSec 播放头 − 目标位置（秒）
 * @param {{deadband?:number, settleBand?:number, gain?:number, maxRateDelta?:number, correcting?:boolean}} opts
 *        correcting = 上一拍是否正在纠偏（迟滞状态）
 */
export function lagCorrectionRate(
  driftSec,
  { deadband = 0.25, settleBand = 0.06, gain = 0.4, maxRateDelta = 0.06, correcting = false } = {},
) {
  if (!Number.isFinite(driftSec)) return 1;
  const d = Math.abs(driftSec);
  if (!correcting && d < deadband) return 1;
  if (correcting && d < settleBand) return 1;
  const rate = 1 - driftSec * gain;
  return Math.min(1 + maxRateDelta, Math.max(1 - maxRateDelta, rate));
}

/**
 * 观察窗：试一个候选之后，最多等这么久来**提前判失败**。
 *
 * ⚠️ 它只用来判失败，**不用来判成功** —— 这正是 v2.66.57 修的那个洞。
 * 原来窗口一到就 `settle({ok:true, assumed:true})`，于是 `settled` 变真，
 * 之后编码器再报错就只剩 `recorder-error`、不再换候选。
 * 而"标签页开头静止 → 一帧都不给 → 一个分片都没有"是**常态**
 * （见 `player.js` 里那条「源画面静止 → tabCapture 一帧都不给」），
 * 于是健康会话也会被判 assumed，真正需要回落的那条路反倒被关掉 ✗
 *
 * 现在的口径（三选一，谁先到算谁）：
 *   · 拿到第一个分片          → 成功（proven）
 *   · 窗口内收到报错          → 失败，立刻换下一个
 *   · 窗口到点仍什么都没有    → 先放它过（`assumed`），但**保留回落能力**：
 *     只要还没出过**成片**（`_hasMediaOutput`），迟到的那条报错照样换下一个
 *     （见 `_lateRetry`）
 *
 * ⚠️ 长度取 3s，是因为 **MP4 的首片不是 250ms 来的**。
 * 真机日志（v2.66.59，4K45，MP4+AAC）: 8 秒里只有 **3 片**，平均 2.7 秒一片 ——
 * Chrome 的 MP4 muxer 按 **fragment 边界**切，`timeslice` 只当参考。
 * 补测（720p，同一台机器）: 间隔降到 **~555ms** —— 说明它是**随分辨率/码率放大**的量，
 * 不是固定 2.7s。所以窗口给 3s：4K 那种慢节奏也能拿到首片，低分辨率也浪费不了多少。
 * 而窗口变长**不增加用户感知的启动时间**：播放本来就要等缓冲攒满 `delaySec`（≥3s）。
 */
export const MIME_PROBE_MS = 3000;

/**
 * 按**宏块数**挑 H.264 level —— 别写死。
 *
 * ⚠️ 原来两档候选是 `avc1.42E01E` / `avc1.4D401E`，都是 **Level 3.0**
 * （规格上限 720×480@30 / 10 Mbps），而延迟播放的源动辄 1440p/4K。
 * 按规格这正是"声明"和"实际"对不上，所以改成按分辨率算。
 *
 * ⚠️⚠️ **但别把它当成那个 `EncodingError` 的病因 —— 真机实测已经推翻了。**
 * Edge 155 / Windows / 无头（软件编码）上跑过一轮（`probe/live-probe.html`）：
 *
 *     3840×2160 @30，avc1.42E01E（L3.0）→ 2,000,000 字节，无报错
 *     2561×1441 @30，avc1.42E01E（奇数 + L3.0）→ 877,000 字节，无报错
 *     3840×2160 @45 + 78.6 Mbps，avc1.640033 → 2,080,000 字节，无报错
 *
 * 也就是说 **Chrome 并不拿 codec 串里的 level 去约束编码器**，奇数尺寸和高码率
 * 也都能录。所以"改 level 就能修好那位用户"是错的 —— 他的 `EncodingError`
 * 更像是**那台机器没有可用的平台编码器**（Windows N 版缺 Media Feature Pack 之类），
 * 而 `isTypeSupported` 只到 muxer 层、不检查平台编码器。
 * 真正的解药是 `mimeFallbacks` 那条**回落链**，不是这串 level。
 *
 * 这个函数仍然保留：声明和实际一致是对的（硬件编码器在别的驱动/平台上确实可能挑 level），
 * 而且代价为零 —— 只是别在注释里把它写成"已确诊的病因"。
 *
 * level_idc = level × 10；MaxFS 是每一级能编的宏块数上限：
 *   3.0 → 1620 · 3.1 → 3600 · 4.0 → 8192 · 5.0 → 22080 · 5.1 → 36864
 *
 * 尺寸未知时按 1080p 档（High 4.0）：它是覆盖面最广的一档，
 * 而真到 4K 时 `start()` 会带着实际尺寸重新算一遍（见 `mimeCandidates`）。
 */
export function avcCodecFor(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!(w > 0 && h > 0)) return 'avc1.640028';
  const mb = Math.ceil(w / 16) * Math.ceil(h / 16);
  if (mb <= 1620) return 'avc1.64001E'; // High 3.0  ≤ 720×480
  if (mb <= 3600) return 'avc1.64001F'; // High 3.1  ≤ 720p
  if (mb <= 8192) return 'avc1.640028'; // High 4.0  ≤ 1080p
  if (mb <= 22080) return 'avc1.640032'; // High 5.0  ≤ 1440p
  return 'avc1.640033'; // High 5.1  4K
}

/**
 * 候选格式，**按优先级从高到低**。尺寸要传进来，因为 H.264 的 level 由它决定。
 *
 * ⚠️ 顺序的用意：**H.264 优先**（现代 GPU 上基本都是硬件编码，4K 下比
 * VP9/VP8 的软件编码省得多）；同一档里先 AAC 后 Opus ——
 * AAC 在 Windows/macOS 上有平台编码器、兼容性最常规，而 Opus 是 Chrome **内置**的，
 * AAC 缺失的机器（Linux、Windows N 版）靠它兜住。
 *
 * ⚠️ 已经删掉的两条**死候选**（旧版里留着）：
 *   · `video/x-matroska;codecs="avc1,opus"` —— MediaRecorder 不支持 MKV 容器
 *   · `video/webm;codecs="h264,opus"`        —— WebM 不装 H.264
 * 它们在 Chrome 上恒为 false，留着只会让"试了 N 个"这个数字虚高。
 *
 * 每一种都必须 **同时** 被 MediaRecorder 和 MediaSource 接受 ——
 * 只过 MediaRecorder 却在 addSourceBuffer 时失败的话，整个延迟播放会起不来。
 */
export function mimeCandidates({ width = 0, height = 0 } = {}) {
  const avc = avcCodecFor(width, height);
  return [
    // ① H.264 + AAC —— 有平台 AAC 的机器上最优（硬编 + 原生音频）
    `video/mp4;codecs="${avc},mp4a.40.2"`,
    // ② H.264 + Opus —— 视频仍走硬编，音频换成 Chrome 内置的那条（绕开 AAC）
    `video/mp4;codecs="${avc},opus"`,
    // ③ VP9 + Opus
    'video/webm;codecs="vp9,opus"',
    // ④ VP8 + Opus —— 最稳的兜底：libvpx + libopus，所有 Chrome 都有
    'video/webm;codecs="vp8,opus"',
    // ⑤ 连 codecs 都不写，交给浏览器自己定
    'video/webm',
  ];
}

/** 拿不到尺寸时的那份候选表 —— `isSupported()` 和单测用这一份 */
export const MIME_CANDIDATES = mimeCandidates();

function mimeOk(c) {
  try {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(c)) return false;
    if (typeof MediaSource === 'undefined' || typeof MediaSource.isTypeSupported !== 'function') return false;
    return MediaSource.isTypeSupported(c);
  } catch {
    return false;
  }
}

/** 从流里读画面尺寸；读不到就给 0（`avcCodecFor` 会退到 1080p 档） */
function readDimensions(stream) {
  try {
    const s = stream?.getVideoTracks?.()[0]?.getSettings?.() || {};
    return { width: Number(s.width) || 0, height: Number(s.height) || 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * 挑一个当前浏览器支持的录制格式；优先级从高到低。
 * @param {{width?:number, height?:number}} [dims] 画面尺寸（决定 H.264 level）
 */
export function pickMimeType(dims) {
  for (const c of mimeCandidates(dims)) if (mimeOk(c)) return c;
  return '';
}

/**
 * 回落链：**当前浏览器宣称支持的**全部候选，保持优先级顺序。
 *
 * ⚠️ 为什么"宣称支持"还不够 —— 这是这个函数存在的**唯一理由**：
 * `isTypeSupported` 只回答"这个字符串认不认得"，**不等于编码器真的能按它工作**。
 * 实测（v2.66.40，真实用户的导出日志）：
 *
 *     已取得流 · 视频 2561×1441@30
 *     录制格式 · video/mp4;codecs="avc1.42E01E,mp4a.40.2"（H.264，通常硬件编码）
 *     ⚠ 录制器报错 · EncodingError: The given encoder configuration is not supported by the encoder.
 *     ⚠ 录制器停了 · 已输出 0 字节／0 片、跑了 0 秒
 *
 * 也就是说 `isTypeSupported` 返回了 true、候选被选中了，然后**编码器拒绝它**。
 * 于是"靠预筛选定一个"这条路**根本拦不住** —— 只能**真的试**，不行就换下一个 ✓
 * （而那次换 VP8 就能录，所以回落链确实是解药。）
 *
 * @param {{width?:number, height?:number}} [dims] 画面尺寸（决定 H.264 level）
 */
export function mimeFallbacks(dims) {
  return mimeCandidates(dims).filter(mimeOk);
}

export function isSupported() {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaSource !== 'undefined' &&
    typeof MediaSource.isTypeSupported === 'function' &&
    !!pickMimeType()
  );
}

/** MSE 的 SourceBuffer 一次只能有一个 append/remove 在跑，用它把操作串起来 */
export class SourceBufferQueue {
  constructor(sourceBuffer) {
    this.sb = sourceBuffer;
    this.pending = [];
    this.running = false;
    this.failed = null;
  }

  push(fn) {
    this.pending.push(fn);
    void this._drain();
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const fn = this.pending.shift();
        await new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            this.sb.removeEventListener('updateend', done);
            this.sb.removeEventListener('error', done);
            resolve();
          };
          this.sb.addEventListener('updateend', done);
          this.sb.addEventListener('error', done);
          try {
            fn();
          } catch (e) {
            this.failed = e;
            done();
          }
        });
      }
    } finally {
      this.running = false;
    }
  }

  /** 测试用：等待队列排空 */
  async idle() {
    while (this.running || this.pending.length) await new Promise((r) => setTimeout(r, 5));
  }
}

export class DelayedPlayback {
  /**
   * 画质档位 → 相对"标准档"的倍率。标准档 = recommendBitrate 的输出。
   *
   * ⚠️ 数值是按"H.264 实际需要多少"定的，不是拍脑袋：
   * 4K30 = 3840×2160×30 ≈ 2.49 亿像素/秒。每秒位数 ÷ 像素数 = bpp（每像素每帧位数），
   * 这是衡量"够不够"的通用指标：
   *   0.16 bpp（标准档 4K = 40 Mbps）—— 静止够，**快速运动会糊**（实测用户反馈）
   *   0.26 bpp（高画质 4K ≈ 64 Mbps）—— 运动画面干净
   *   0.39 bpp（极致 4K ≈ 96 Mbps）—— 基本看不出二次压缩
   * H.264 比 VP9/AV1 效率低，所以同样的观感它需要更高码率。
   */
  static get QUALITY_MULTIPLIERS() {
    return { low: 0.5, standard: 1, high: 1.6, ultra: 2.4 };
  }

  /**
   * 前方缓冲允许超出目标延迟多少秒 —— 超了就跳。
   *
   * 按**码率**算：内存预算固定，码率越高，能容纳的前方缓冲就越短，
   * 于是越早该跳。写死一个秒数在高码率下等于没夹住（实测 12.6s × 78.6 Mbps ≈ 124 MB
   * 已经撞穿配额了）。
   */
  _overDelayJumpSec() {
    const bytesPerSec = (this.bitsPerSecond || 4_000_000) / 8;
    const maxAhead = (90 * 1024 * 1024) / bytesPerSec; // 前方缓冲的内存上限（秒）
    return Math.max(1.5, Math.min(5, maxAhead - this.delaySec));
  }

  /**
   * 播放头之前该留多少秒。
   *
   * 内存预算固定，所以**码率越高只能留越短** —— 否则 SourceBuffer 会被撑爆。
   * 原来写死 15 秒：4K60 高画质是 128 Mbps = 16 MB/s，光"播放头之前"就 240 MB，
   * 加上延迟需要的前方缓冲和垃圾，直接撞穿 MSE 配额。
   */
  _trimKeepBehindSec() {
    const bytesPerSec = (this.bitsPerSecond || 4_000_000) / 8;
    const budget = 60 * 1024 * 1024; // 给"播放头之前"的部分 60 MB
    return Math.min(15, Math.max(2, budget / bytesPerSec));
  }

  /**
   * 延迟模式的内存预算上限。
   *
   * 延迟 D 秒意味着**前方**必须攒住 D 秒的画面，而后方还要留一些 ——
   * 需要的秒数 = D + 3 左右。内存预算固定，于是码率有个硬上限：
   *   码率 ≤ 预算字节 × 8 ÷ 需要的秒数
   * 实测 4K60 + 高画质 = 128 Mbps，配 6.6 秒延迟需要 ~155 MB，
   * 超过 MSE 能给的范围 → `SourceBuffer is full`。
   * 所以这里**必须夹住**，不能只把档位往上放。
   */
  static maxBitrateForDelay(delaySec, budgetBytes = 90 * 1024 * 1024) {
    const needSec = Math.max(4, Number(delaySec) || 6) + 3;
    return Math.round((budgetBytes * 8) / needSec);
  }

  /**
   * 按画面尺寸估一个合理的视频码率。
   *
   * ⚠️ 原来是写死的 4 Mbps —— 对 3840×2160 来说太低了。
   * 码率不够时**静止画面还凑合（帧间几乎没变化），一运动就糊**：
   * 编码器只能丢掉细节去凑那个码率。用户反馈"画面移动起来就糊"就是这个。
   * 经验值：1920×1080@30 用 10 Mbps 就比较干净，按像素数线性外推。
   *
   * ⚠️ 这里只算"画质想要多少"，还要再过一遍 maxBitrateForDelay ——
   * 内存放不下的码率给上去只会撞穿 MSE 配额。
   */
  static recommendBitrate(width, height, fps = 30) {
    const px = Number(width) * Number(height);
    if (!Number.isFinite(px) || px <= 0) return 8_000_000;
    const scaled = (px / (1920 * 1080)) * 10_000_000 * ((Number(fps) || 30) / 30);
    // 上限放到 150 Mbps：4K 下 H.264 用 96 Mbps 也不稀奇，
    // 原来卡在 40 会让人"怎么调都还是糊"。下限 4 Mbps 防止极端尺寸给太小。
    return Math.round(Math.min(150_000_000, Math.max(4_000_000, scaled)));
  }

  /**
   * @param {HTMLVideoElement} videoElement 播放延迟画面的 <video>
   * @param {{delaySec?:number, bitsPerSecond?:number, mimeType?:string, onStatus?:Function}} [opts]
   */
  constructor(videoElement, opts = {}) {
    this.video = videoElement;
    this.delaySec = clampDelay(opts.delaySec ?? DELAY_MIN_SEC);
    /**
     * 视频码率。
     *
     * ⚠️ 原来写死 4 Mbps —— 对 3840×2160 来说太低。
     * 码率不够时**静止画面还凑合（帧间几乎没变化），一运动就糊**：
     * 编码器只能丢细节去凑那个码率。用户反馈"画面移动起来就糊"就是这个。
     * 现在由 setSource 按实际画面尺寸估（见 recommendBitrate），也可以显式指定。
     */
    this.bitsPerSecond = Number(opts.bitsPerSecond) || 0;
    /** 画质档位（low/standard/high），只在没显式指定码率时生效 */
    this.quality = String(opts.quality || 'high');
    /**
     * 是否用变速（playbackRate ±6%）去把延迟拉回目标值。
     *
     * 关掉之后速率恒为 1：画面完全没有变速顿挫，代价是延迟会随编码器滞后慢慢漂移。
     * **字幕依然对得上**，因为排期用的是实测延迟而不是目标值。
     */
    this.smoothRate = opts.smoothRate !== false;
    /**
     * 显式指定的录制格式。
     *
     * ⚠️ 有它时**只试这一个**，不走回落链 —— 调用方（和测试）要的是确定行为，
     * 悄悄换成别的会让"我明明指定了"变成谎话 ✗
     */
    this.forcedMimeType = String(opts.mimeType || '');
    this.mimeType = this.forcedMimeType || pickMimeType();
    /** 当前格式是否被**证实**能用（观察窗里真的吐出了分片）。见 `_tryMime` 的注释 */
    this.mimeProven = false;
    /**
     * 回落链的运行时状态 —— `start()` 里初始化，`_lateRetry()` 会接着用。
     *
     * ⚠️ 之所以挂在实例上而不是 `start()` 的局部变量：**启动阶段的失败可能是迟到的**。
     * `start()` 按 `assumed` 放行之后，编码器仍可能在第一个真实帧到达时才报错，
     * 那时 `start()` 早就返回了 —— 没有这些状态就没法接着换下一个候选 ✗
     */
    this._stream = null;
    this._dims = { width: 0, height: 0 };
    this._chain = [];
    this._chainIdx = 0;
    /** 已经试败的候选及原因，顺序即尝试顺序；`onStatus` 和 `recorder-failed` 都靠它 */
    this._tried = [];
    /** 正在做"迟到失败"的重建 —— 防止 `onerror` 和 `onstop` 同时触发两次回退 */
    this._retrying = false;
    this.onStatus = opts.onStatus || (() => {});

    this.recorder = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = null;
    this.objectUrl = '';
    this.chunkQueue = [];
    this.locked = false;
    /**
     * 起播时第一次 seek 的时刻 / 有没有报过"解不出帧"。
     * 见 `_tick()` 里那段：光"缓冲够久"不等于"能播",要等解码器真的拿到当前位置的数据。
     */
    this.startSeekAt = 0;
    this.reportedNoFrame = false;
    this.timer = null;
    this.stopped = false;
    this.actualLagSec = null;
    /**
     * 调 recorder.start() 那一刻的墙上时钟。
     *
     * 用来量一个**字幕排期没算进去的量**：缓冲末尾比实况落后多久。
     * 媒体时间 0 就是开始录音那一刻，所以
     *     落后 = (现在 − 开始录音) − 缓冲末尾
     * 这个数恒为正（分片 250ms + 编码延迟），而 actualLagSec 是拿缓冲末尾当基准算的，
     * 所以它**系统性少算了这一段** —— 字幕因此恒定偏早。
     *
     * ⚠️ 目前只用来**报告**，没有参与排期。先看清楚它有多大，再决定要不要补进去。
     */
    this.recStartedAt = 0;
    /** 上一拍是否正在变速纠偏 —— 迟滞状态，见 lagCorrectionRate */
    this._correcting = false;
    /** 最近一次的偏差（秒），诊断用 */
    this.lastDriftSec = 0;
    /** 平滑后的偏差 —— 调速只用它，见 _tick 里的说明 */
    this.driftEma = null;
    /** 上次写 playbackRate 的时刻 */
    this._lastRateSetAt = 0;
    /** 上次清理旧缓冲的时刻 —— 清理要攒够再做，见 TRIM_GARBAGE_SEC */
    this._lastTrimAt = 0;
    /**
     * 裁剪**成功发起过几次**、以及**最后一次裁到哪一秒**（只记最后一次，不记历史）。
     *
     * ⚠️ 为什么要记这两个:
     * 有个用户报「延迟模式跑一段时间后稳定崩溃，Chrome/Edge 都一样，
     * 关掉硬件加速就不崩，而调低码率没用」✗。查过之后，代码里的内存是**有界**的
     * （稳态 ~191 MB，降码率能到 ~92 MB），`chunkQueue` 每片都被 shift，`seekCount` 最多 1。
     * 所以"显存/内存是不是在涨"这个问题的关键，是**裁剪到底有没有真的发生** ✗ ——
     * 而原来的快照里只有 `末尾 {vEnd}`，**没有 `buffered.start(0)`**，
     * 于是「播到 60 秒了、而缓冲还从 0 开始」和「缓冲从 55 秒开始」在那行里**长得一模一样** ✗。
     *
     * ⚠️ 这两个字段**只被读**，不参与任何判断 —— 加它们不改变任何行为。
     *
     * ⚠️⚠️ 而它们在 `_resetAttempt()`（重建 MSE）里**故意不重置** ✗ ——
     * `_resetAttempt` 会把 `appendOk` / `bytes` / `chunks` 归零，但这两个**必须留着**:
     * 重建之后 `SourceBuffer` 是新的，所以 `起` 必然回到 0 ✓ ——
     * 那时只有"裁 N次"这个**跨重建的累计**才能告诉你
     * 「是重建让起点归零的」还是「裁剪从来就没生效过」✗。
     * 而 `_lastTrimAt` 同理 —— 它要回答"**多久没裁过了**"，归零会把答案抹掉 ✗。
     */
    this._trimCount = 0;
    this._lastTrimCut = null;
    /** 播放头前面还剩多少可播的（秒），诊断用 */
    this.bufferAheadSec = 0;
    /** 缓冲见底的次数，诊断用 */
    this.stallCount = 0;
    /** 播放器丢掉的视频帧数 / 总帧数 —— 直接反映"顿" */
    this.droppedFrames = 0;
    this.totalFrames = 0;
    /** 卡顿探测：次数与最近一次的现场状态（见 _probe） */
    this.hitchCount = 0;
    this.lastHitch = null;
    this._lastCt = null;
    this._lastCtAt = 0;
    this.bytes = 0;
    /** 收到的分片数 —— 和字节数一起看，能区分"一个大分片"和"很多小分片"。 */
    this.chunks = 0;
    /**
     * `appendBuffer` **成功**的次数。
     *
     * ⚠️ 为什么要和 `appendFails`（在播放页那边累加）配成一对：
     * 只看失败次数分不清这两种情况 ——
     *   「一次都没成功过」（写入这条路从头就没通）
     *   「成功过很多次、后来才开始失败」（跑着跑着坏了）
     * 而这两种的修法完全不同。
     */
    this.appendOk = 0;
    /**
     * 起播 seek 的**次数**与**最后一次的位置**。
     *
     * ⚠️ 只记次数 + 最后一次，**不记完整历史** —— 快照必须是一行，
     * 而"每次 seek 都列出来"会让它把缓冲区里该留的挤掉。
     * 次数能回答"起播到底试过几次"（正常只该有 1 次）。
     */
    this.seekCount = 0;
    this.lastSeekTarget = null;
    this.startedAt = 0;
    this.playBlocked = false;
  }

  /**
   * 统一的起播入口。
   * 播放页是扩展程序打开的，那个标签页本身没有用户手势，浏览器可能以自动播放策略拒绝
   * 带声音的 play()。这时不能只是默默重试——必须让用户知道，并给一个点击按钮来解锁。
   */
  _play() {
    let p;
    try {
      p = this.video.play();
    } catch (e) {
      this._notePlayBlocked(e);
      return;
    }
    if (p && typeof p.catch === 'function') {
      p.catch((e) => this._notePlayBlocked(e));
    }
  }

  _notePlayBlocked(e) {
    if (this.playBlocked) return;
    this.playBlocked = true;
    this.onStatus({ phase: 'play-blocked', message: e?.message || String(e) });
  }

  /** 用户在页面上点一下之后调用：有手势了，play() 就能过 */
  async resume() {
    this.playBlocked = false;
    try {
      await this.video.play();
      this.onStatus({ phase: 'playing', delaySec: this.delaySec });
      return true;
    } catch {
      return false;
    }
  }

  /** 目标延迟（秒） */
  setDelay(sec) {
    this.delaySec = clampDelay(sec);
  }

  /**
   * @param {MediaStream} stream 含视频与音频的标签页流
   * @returns {Promise<boolean>} `true` = 画面这条路起来了；`false` = **所有录制格式都被
   *   编码器拒绝**，退化成"只报错、不出画面"（⚠️ 此时**不抛异常** ——
   *   抛了会让调用方中断，识别/字幕一起没 ✗）
   */
  async start(stream) {
    if (!isSupported()) throw new Error('当前浏览器不支持 MediaRecorder / MediaSource，无法做延迟播放。');
    if (!stream.getVideoTracks().length) throw new Error('没有拿到视频轨，无法延迟画面。');

    this.stopped = false;
    this.startedAt = Date.now();

    // 按实际画面尺寸定码率（构造时没显式指定的话）
    if (!this.bitsPerSecond) {
      let w = 0;
      let h = 0;
      let fps = 30;
      try {
        const s = stream.getVideoTracks()[0]?.getSettings?.() || {};
        w = Number(s.width) || 0;
        h = Number(s.height) || 0;
        fps = Number(s.frameRate) || 30;
      } catch {
        /* 拿不到就用默认 */
      }
      const base = DelayedPlayback.recommendBitrate(w, h, fps);
      const mult = DelayedPlayback.QUALITY_MULTIPLIERS[this.quality] ?? 1;
      const wanted = Math.round(base * mult);
      /**
       * ⚠️ 必须按"延迟需要多少画面"把码率夹住。
       *
       * 延迟 D 秒意味着前方要攒住 D 秒的画面，码率越高这份缓冲越大，
       * 而 MSE 的内存配额不是无限的。实测 4K60 + 高画质 = 128 Mbps，
       * 配 6.6 秒延迟要 ~155 MB → `SourceBuffer is full` → 播放头停住、右上角归零。
       * 所以档位只能往上到"放得下"为止，不能无限放。
       */
      const cap = DelayedPlayback.maxBitrateForDelay(this.delaySec);
      this.bitsPerSecond = Math.min(wanted, cap);
      this.bitrateCapped = this.bitsPerSecond < wanted;
      const label = { low: '省资源', standard: '标准', high: '高画质', ultra: '极致' }[this.quality] || this.quality;
      const capNote = this.bitrateCapped
        ? `，已按 ${this.delaySec}s 延迟的内存上限收到 ${(cap / 1e6).toFixed(0)} Mbps（原 ${(wanted / 1e6).toFixed(0)}）`
        : '';
      this.bitrateNote = w
        ? `${w}×${h}@${Math.round(fps)} → ${(this.bitsPerSecond / 1e6).toFixed(1)} Mbps（${label}）${capNote}`
        : `默认 ${(this.bitsPerSecond / 1e6).toFixed(1)} Mbps（${label}）${capNote}`;
    } else {
      /**
       * ⚠️ 显式指定的码率**也要过一遍内存上限**。
       *
       * 这不是"覆盖用户的选择"——内存配额是**物理限制**：延迟 D 秒就必须攒住 D 秒的画面，
       * 码率超过预算时不管谁指定的都会撞穿 SourceBuffer、然后卡死。
       * 只是要**说清楚**夹过，别让用户以为设置没生效。
       * （加这条是因为断言抓到一个漏网场景：显式填 128 Mbps 时，跳转余量已经压到 1.5 秒下限，
       *   跳之前就涨到 124 MB 了 —— 光靠"跳得早"救不了超预算的码率。）
       */
      const cap = DelayedPlayback.maxBitrateForDelay(this.delaySec);
      if (this.bitsPerSecond > cap) {
        this.bitrateNote = `指定 ${(this.bitsPerSecond / 1e6).toFixed(1)} Mbps，已按 ${this.delaySec}s 延迟的内存上限收到 ${(cap / 1e6).toFixed(0)} Mbps`;
        this.bitsPerSecond = cap;
        this.bitrateCapped = true;
      } else {
        this.bitrateNote = `指定 ${(this.bitsPerSecond / 1e6).toFixed(1)} Mbps`;
      }
    }

    // 微调速率时保持音调不变，否则人声会明显变调
    try {
      this.video.preservesPitch = true;
    } catch {
      /* ignore */
    }
    this.video.muted = false;

    /**
     * ⚠️ 逐个候选**真的试**，而不是"预筛一个就直接用"。
     *
     * 理由见 `mimeFallbacks`：`isTypeSupported` 说支持、`start()` 之后编码器拒绝，
     * 正是实测到的那条 `EncodingError`。预筛拦不住它 ✗
     *
     * 一个候选失败有三种形态，三种都要接：
     *   · `addSourceBuffer` / `start()` **同步抛**（或 MediaSource 没打开）
     *   · `onerror` **异步报**（`EncodingError`）—— 实测那条是这种
     *   · **迟到的**报错 —— 观察窗过了、`start()` 已经返回，编码器才在第一个真实帧上失败
     *     （静止标签页必然走到这一条，见 `_lateRetry`）
     *
     * ⚠️ 全部候选都失败时**不抛**（见下面那段）—— 抛了会让调用方中断，
     * 于是识别/字幕也不会启动，而用户看到的现象恰恰是「只有字幕」✗
     */
    this._stream = stream;
    this._dims = readDimensions(stream);
    this._chain = this._candidateChain();
    this._chainIdx = 0;
    this._tried = [];

    const won = await this._startNextCandidate();
    if (!won) {
      /**
       * ⚠️ **一个都不能用时不抛异常** —— 改成"只报错、不出画面"的退化模式。
       *
       * 抛出去会让 `startCapture` 中断，`startAudioEngine` 也不会跑，
       * **字幕就一起没了** ✗ —— 而用户看到的现象是「只有字幕没有画面」，
       * 也就是说这里的前提就是**字幕必须照常** ✓
       */
      this.mimeType = '';
      this.onStatus({ phase: 'recorder-failed', tried: this._tried });
      return false;
    }

    this._beginClocks();
    this.onStatus({
      phase: 'recording',
      mimeType: this.mimeType,
      bitrateNote: this.bitrateNote,
      fallbacks: this._tried,
      proven: this.mimeProven,
    });
    return true;
  }

  /** 这次按什么顺序试 —— 显式指定了就只试那一个 */
  _candidateChain() {
    if (this.forcedMimeType) return [this.forcedMimeType];
    const chain = mimeFallbacks(this._dims || {});
    if (chain.length) return chain;
    return this.mimeType ? [this.mimeType] : [];
  }

  /**
   * 从 `_chainIdx` 开始试，直到某个候选**产出第一个分片**（或整条链试完）。
   *
   * ⚠️ 成功也分两种：`proven`（真的拿到了分片）和 `assumed`（观察窗里什么都没发生）。
   * `assumed` 不算失败 —— 静止标签页在启动时本来就一个分片都没有，
   * 判失败会把所有候选都试一遍、最后误报"一个都不能用" ✗
   * 它只是**还没被证实**，之后一旦出问题由 `_lateRetry` 接着兜。
   *
   * @returns {Promise<boolean>} 是否有一个候选被选中
   */
  async _startNextCandidate() {
    while (this._chainIdx < this._chain.length) {
      if (this.stopped) return false;
      const mime = this._chain[this._chainIdx];
      let verdict;
      try {
        verdict = await this._tryMime(this._stream, mime);
      } catch (e) {
        verdict = { ok: false, why: `建立失败：${(e && e.message) || e}` };
      }
      if (verdict.ok) {
        this.mimeType = mime;
        this.mimeProven = !verdict.assumed;
        return true;
      }
      this._tried.push(`${mime} → ${verdict.why}`);
      this._chainIdx += 1;
      this._resetAttempt();
    }
    return false;
  }

  /**
   * 起（或重起）闭环纠偏与卡顿探测的计时器。
   *
   * ⚠️ 重起时必须把 `_lastCt` / `driftEma` 这些**跟播放头有关**的量归零 ——
   * 否则新的一段会拿上一段的播放头去算"前进够不够"，`_probe` 的第一拍必然误判成卡顿。
   */
  _beginClocks() {
    this._stopClocks();
    this._lastCt = null;
    this._lastCtAt = 0;
    this.driftEma = null;
    this._correcting = false;
    this.timer = setInterval(() => this._tick(), 400);
    // 精细卡顿探测：_tick 每 400ms 才看一次，短促的卡顿抓不到。
    // 这个每 100ms 看一次"播放头有没有正常前进"，卡住就把当时的状态全记下来。
    this.probeTimer = setInterval(() => this._probe(), 100);
  }

  _stopClocks() {
    if (this.timer) clearInterval(this.timer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.timer = null;
    this.probeTimer = null;
  }

  /**
   * 启动阶段的**迟到失败**：`start()` 已经按 `assumed` 放行，但**还没有可播数据**，
   * 编码器这时才报错 / 自己停 —— 说明这个候选其实不成立，换下一个重来。
   *
   * 为什么必须有这一条（v2.66.57 的核心理由）：
   * 标签页开头静止时 tabCapture **一帧都不给**，MediaRecorder 于是一片都不吐。
   * 观察窗到点只能判 `assumed`。等用户点播放、第一个真实帧到达，编码器才拒绝配置 ——
   * 这时如果只报 `recorder-error`，回落链就白写了，用户看到的还是黑屏 ✗
   *
   * ⚠️ 判据是"**有没有可播数据**"，不是 `bytes > 0`。
   * 实测（v2.66.57，静止标签页）: 记录器吐了 **36 字节**的 fMP4 文件头就停住了 ——
   * `bytes > 0` 会让"迟到的失败"永远走不到，可那 36 字节根本放不出任何东西。
   * 所以改成问 SourceBuffer：压进去之后**有没有可播区间**（`_hasPlayableData`）。
   *
   * ⚠️ 这个重建发生在**起播之前**：起播要等缓冲攒满 `delaySec`（≥3s），
   * 而编码器拒绝配置都发生在头几秒 —— 所以 `video.load()` / 换 MediaSource
   * 不会打断正在播的画面（这条是"晚回落"能成立的前提）。
   */
  _lateRetry(why) {
    if (this.stopped || this._retrying) return;
    if (this._hasMediaOutput()) return;
    this._tried.push(`${this.mimeType} → ${why}`);
    this._chainIdx += 1;
    this._stopClocks();
    this._resetAttempt();
    if (this._chainIdx >= this._chain.length) {
      this._exhausted();
      return;
    }
    this._retrying = true;
    void this._startNextCandidate().then((ok) => {
      this._retrying = false;
      if (this.stopped) return;
      if (!ok) {
        this._exhausted();
        return;
      }
      this._beginClocks();
      this.onStatus({
        phase: 'recording',
        mimeType: this.mimeType,
        bitrateNote: this.bitrateNote,
        fallbacks: this._tried,
        proven: this.mimeProven,
        retried: true,
      });
    });
  }

  /**
   * 编码器真的出过**成片**了吗 —— 判据有两个，满足任一条就算：
   *
   *   ① `bytes` 明显超过一个初始化段（fMP4 的 `ftyp`/`moov` 只有几十字节）
   *   ② SourceBuffer 里已经有可播区间
   *
   * ⚠️ 只按 `bytes > 0` 判是**错的**，这是真机日志打出来的：
   * 静止标签页 30 秒只有 **36 字节 / 1 片 / 0 个可播区间** —— 那不是画面，是文件头。
   * 按 `bytes > 0` 判，这种"只吐文件头就停住"的候选会被当成"已经起来"，
   * 迟到的失败再也走不到回落链 ✗
   *
   * ⚠️ 也不能只看 SourceBuffer 的可播区间：分片刚收到、append 还在队列里时区间还是 0，
   * 那种时候按"没出过片"重试等于把一次健康的启动白扔了。所以两条并列。
   */
  _hasMediaOutput() {
    if (this.bytes > INIT_SEGMENT_MAX_BYTES) return true;
    return this._hasPlayableData();
  }

  /**
   * SourceBuffer 里**已经有可播区间**了吗。
   *
   * ⚠️ 不能只看 `bytes > 0`：初始化段（fMP4 的 `ftyp`/`moov`，几十字节）也会让 `bytes` 变真，
   * 但一个可播区间都没有 —— 那时"编码器接受了配置"这个结论是**没被证实**的。
   */
  _hasPlayableData() {
    try {
      const b = this.sourceBuffer && this.sourceBuffer.buffered;
      return !!(b && b.length > 0);
    } catch {
      return false;
    }
  }

  /** 回落链彻底走完 —— 退化成"只报错、不出画面"，字幕照常 */
  _exhausted() {
    this.mimeType = '';
    this._stopClocks();
    this.onStatus({ phase: 'recorder-failed', tried: this._tried });
  }

  /**
   * 换候选之前把上一次尝试留下的东西**全部**清掉。
   *
   * ⚠️ 不清会出两种坏情况:
   *   · MP4 和 WebM 的 `addSourceBuffer` mime 不同 —— **容器混在一起**直接报错
   *   · 上一轮 append 进去的字节还在 SourceBuffer 里，新容器接在它后面根本对不上
   * 所以缓冲、分片队列、计数器、objectURL 一律清零 ✓
   *
   * ⚠️ `MediaRecorder.stop()` **不会**停掉 MediaStream 的轨道 ——
   * 所以同一条 `stream` 可以拿去做下一次尝试 ✓（这条要是错了，回落链整条都不成立）
   */
  _resetAttempt() {
    const rec = this.recorder;
    this.recorder = null;
    if (rec) {
      try {
        rec.ondataavailable = null;
      } catch {
        /* ignore */
      }
      try {
        rec.onerror = null;
      } catch {
        /* ignore */
      }
      try {
        rec.onstop = null;
      } catch {
        /* ignore */
      }
      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch {
        /* ignore */
      }
    }
    const ms = this.mediaSource;
    this.mediaSource = null;
    if (ms) {
      try {
        if (ms.readyState === 'open') ms.endOfStream();
      } catch {
        /* ignore */
      }
    }
    this.sourceBuffer = null;
    this.queue = null;
    this.chunkQueue = [];
    this.bytes = 0;
    this.chunks = 0;
    this.appendOk = 0;
    this.recStartedAt = 0;
    if (this.objectUrl) {
      try {
        URL.revokeObjectURL(this.objectUrl);
      } catch {
        /* ignore */
      }
      this.objectUrl = '';
    }
    try {
      this.video.removeAttribute('src');
      this.video.load();
    } catch {
      /* ignore */
    }
  }

  /**
   * 试一个候选。成功 `{ok:true}`（`assumed:true` 表示观察窗里没证实），失败 `{ok:false, why}`。
   *
   * ⚠️ 判成功的依据是**真的吐出了分片**（`bytes > 0`）—— 这是唯一能证明
   * "编码器接受了这个配置"的信号。`isTypeSupported` 说过是可以错的（见 `mimeFallbacks`）✗
   * 观察窗里既没分片也没报错的候选只能算 `assumed`：它可能只是源画面静止，
   * 也可能是个迟到的失败 —— 后者由 `_lateRetry` 在报错到来时接着处理。
   */
  async _tryMime(stream, mime) {
    // 页面在回落链途中被关掉时，别继续建 MediaRecorder / MediaSource 了
    if (this.stopped) return { ok: false, why: '已停止' };
    this.mimeType = mime || '';
    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;
    this.video.muted = false;
    const ms = this.mediaSource;
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        ms.removeEventListener('sourceopen', onOpen);
        try {
          const sb = ms.addSourceBuffer(mime);
          sb.mode = 'segments';
          this.sourceBuffer = sb;
          this.queue = new SourceBufferQueue(sb);
          resolve();
        } catch (e) {
          reject(new Error(`无法建立缓冲：${e.message}`));
        }
      };
      ms.addEventListener('sourceopen', onOpen);
      setTimeout(() => reject(new Error('MediaSource 打开超时')), 8000);
    });

    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: this.bitsPerSecond,
      audioBitsPerSecond: 128_000,
    });
    this.recorder = rec;

    /**
     * 观察窗的出口 —— 第一个分片 / 第一条报错 / 超时，谁先到算谁。
     *
     * ⚠️ `settle()` 自己把 `settled` 置真 —— **成功那条路也必须置真** ✗
     * 早先只有失败那两条路置它，于是"拿到分片之后"再来一条 `EncodingError`
     * 会被**当成窗口内的事件**吞掉：`settle` 落在一个已经 resolve 的 Promise 上，
     * **一个字都不会显示** ✗✗✗ —— 而那条报错正是能解释整个故障的东西。
     * （这条是 smoke-test 里那个"它自己停了"的用例抓出来的，不是看代码看出来的。）
     */
    let settled = false;
    let resolveProbe = () => {};
    let probeTimerId = 0;
    const probe = new Promise((r) => {
      resolveProbe = r;
    });
    const settle = (v) => {
      if (settled) return;
      settled = true;
      // 提前出结果（第一个分片/第一条报错）时把观察窗的定时器撤掉，别让它在后台空跑
      if (probeTimerId) clearTimeout(probeTimerId);
      resolveProbe(v);
    };

    rec.ondataavailable = (e) => {
      if (this.stopped || !e.data || !e.data.size) return;
      this.bytes += e.data.size;
      this.chunks += 1;
      settle({ ok: true });
      e.data
        .arrayBuffer()
        .then((buf) => {
          if (this.stopped) return;
          this.chunkQueue.push(buf);
          this._pumpChunks();
        })
        .catch(() => {});
    };
    /**
     * ⚠️ 录制器**自己**报错或**自己**停下来时，必须说出来。
     *
     * 这两个事件原来**完全没有 handler** —— 于是故障的表现是
     * 「字节一直是 0」或「缓冲突然填不上了」，而日志里**一个字都没有**：
     * 只看得到结果，看不到原因。用户那边的观感就是"画面/声音突然没了，什么提示都没有"。
     * 而排查"黑屏无声有字幕"最贵的一步，恰恰是分辨**哪一层**断的。
     *
     * ⚠️ 现在它有三个职责，按优先级：
     *   ① **观察窗内**收到报错 → 这个候选不成立，交给回落链换下一个
     *   ② **窗口外但一个字节都没出** → 迟到的启动失败（静止标签页必然走到这里），
     *      照样换下一个 —— 见 `_lateRetry`
     *   ③ 已经出过分片 → 运行中崩了，只能报、不能悄悄换
     *      （缓冲里已经有数据，换了容器也接不上）✗
     *
     * ⚠️ `onstop` 我们自己也调（`stop()` 里），所以要用 `this.stopped` 区分：
     * 我们停的时候它已置真 → 不算"自己停的"；否则就是它自己停了（来源流断了、
     * 标签页关了、编码器崩了……）。
     */
    rec.onerror = (e) => {
      const err = (e && e.error) || {};
      const name = err.name || '错误';
      const msg = err.message || '';
      const text = msg ? `${name}: ${msg}` : name;
      if (!settled) {
        settle({ ok: false, why: text });
        return;
      }
      if (this.recorder === rec && !this._hasMediaOutput()) {
        this._lateRetry(`迟到的 ${text}`);
        return;
      }
      this.onStatus({ phase: 'recorder-error', message: text, proven: this.mimeProven });
    };
    rec.onstop = () => {
      if (this.stopped) return;
      if (!settled) {
        settle({ ok: false, why: '录制器自己停了（0 分片）' });
        return;
      }
      if (this.recorder === rec && !this._hasMediaOutput()) {
        this._lateRetry('录制器自己停了（0 分片）');
        return;
      }
      this.onStatus({
        phase: 'recorder-stopped',
        bytes: this.bytes,
        chunks: this.chunks,
        elapsedMs: this.recStartedAt ? Date.now() - this.recStartedAt : 0,
      });
    };

    // 分片越短，缓冲末尾越贴近"现在"，延迟估值越准；但开销也越大。250ms 是折中。
    this.recStartedAt = Date.now(); // 媒体时间 0 就是这一刻，量"缓冲落后实况多久"要用它
    try {
      rec.start(250);
    } catch (e) {
      return { ok: false, why: `start() 抛错：${(e && (e.message || e.name)) || e}` };
    }

    const timedOut = new Promise((resolve) => {
      probeTimerId = setTimeout(() => {
        /**
         * 既没分片也没报错 —— 先放它过，但记下"没证实"（`assumed`）。
         *
         * ⚠️ 这**不是**"判成功"：之后只要还一个字节都没出，迟到的报错照样能换候选
         * （`_lateRetry` 就是为这条留的口子）。反过来，如果把这里当成失败，
         * 静止的标签页会把每个候选都试一遍，最后误报"一个都不能用" ✗
         */
        settle({ ok: true, assumed: true });
        resolve({ ok: true, assumed: true });
      }, MIME_PROBE_MS);
    });
    return await Promise.race([probe, timedOut]);
  }

  /**
   * 卡顿探测：播放头前进得明显少于经过的时间，就是卡了一下。
   *
   * 为什么需要它：只说"顿了一下"没法定位 —— 是掉帧？是缓冲见底？
   * 还是播放头被什么推了一下？这里把**卡住那一刻的全部状态**记下来，
   * 事后看一眼就知道是哪一类。
   */
  _probe() {
    if (this.stopped || !this.video) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const ct = this.video.currentTime;

    if (this._lastCt === null || this.video.paused) {
      this._lastCt = ct;
      this._lastCtAt = now;
      return;
    }
    const dt = (now - this._lastCtAt) / 1000;
    const dct = ct - this._lastCt;
    this._lastCt = ct;
    this._lastCtAt = now;
    if (dt < 0.08) return;

    // 正常情况 dct ≈ dt。明显落后就是卡了。
    if (dct >= dt * 0.5) return;

    const end = this.bufferedEnd();
    let dropped = 0;
    try {
      dropped = this.video.getVideoPlaybackQuality?.()?.droppedVideoFrames || 0;
    } catch {
      /* ignore */
    }
    this.hitchCount = (this.hitchCount || 0) + 1;
    this.lastHitch = {
      frozenMs: Math.round((dt - dct) * 1000),
      rate: Number(this.video.playbackRate.toFixed(3)),
      aheadSec: end === null ? -1 : Number((end - ct).toFixed(2)),
      readyState: this.video.readyState,
      dropped,
      correcting: this._correcting ? 1 : 0,
    };
  }

  _pumpChunks() {
    if (!this.queue || this.stopped) return;
    while (this.chunkQueue.length) {
      const buf = this.chunkQueue.shift();
      this.queue.push(() => {
        if (this.stopped) return;
        try {
          this.sourceBuffer.appendBuffer(new Uint8Array(buf));
          this.appendOk++;
        } catch (e) {
          /**
           * ⚠️ 配额溢出**不能只是报一句就丢掉这一片**。
           *
           * `SourceBuffer is full, and cannot free space` 是 MSE 的内存配额被撞穿了。
           * 原来这里只 `onStatus({phase:'append-error'})` 然后放弃 —— 于是：
           *   丢的片越来越多 → 缓冲见底 → 播放头停住 → 右上角的数全变 0，
           *   用户看到的就是"跑着跑着停下来了"。
           * 实测触发条件：4K60 + 高画质 = 128 Mbps = 16 MB/s，而裁剪策略保留
           * 播放头前 15 秒、又允许再攒 20 秒垃圾 → 最多 43 秒 = 688 MB。
           *
           * 正确做法是**立刻狠命裁一次，再把这一片重新排进队列**。
           */
          const quota = /quota|full|cannot free space/i.test(e?.name + ' ' + e?.message);
          this.onStatus({ phase: 'append-error', message: e.message });
          if (quota && !this._trimmingHard) {
            this._trimmingHard = true;
            // 砍到播放头之前 1 秒 —— 把配额立刻让出来
            const target = Math.max(0, (this.video.currentTime || 0) - 1);
            this.queue.push(() => {
              try {
                if (this.sourceBuffer.buffered.length && target > this.sourceBuffer.buffered.start(0)) {
                  this.sourceBuffer.remove(0, target);
                }
              } catch {
                /* ignore */
              }
              // 裁完之后把刚才那一片放回队首重试（重试只给一次，避免死循环）
              this.queue.unshift(() => {
                if (this.stopped) return;
                try {
                  this.sourceBuffer.appendBuffer(new Uint8Array(buf));
                  this.appendOk++;
                  this.onStatus({ phase: 'quota-recovered' });
                } catch (e2) {
                  this.onStatus({ phase: 'append-error', message: `${e2.message}（狠裁后仍失败）` });
                }
                this._trimmingHard = false;
              });
            });
          }
        }
      });
    }
  }

  /** 缓冲末尾对应的位置（秒） */
  bufferedEnd() {
    const b = this.video.buffered;
    if (!b.length) return null;
    return b.end(b.length - 1);
  }

  _tick() {
    if (this.stopped) return;
    const end = this.bufferedEnd();
    if (end === null) return;

    if (!this.locked) {
      // 攒够 D 秒再起播，这一步天然就把延迟建立起来了
      const start = this.video.buffered.start(0);
      if (end - start >= this.delaySec + 0.3) {
        /**
         * ⚠️ 光"缓冲够久"不等于"能播" —— 必须再问一句「解得出帧吗」。
         *
         * 踩过的坑（**一个缺陷解释了全部现象**）:
         *   帧率上限压到很低（用户实测 5fps）→ 录制分片 250ms 一片、
         *   里面只有约 1.25 帧 → 编码器 GOP 被拉长 → **第一个分片里没有关键帧**。
         *   于是 SourceBuffer 有数据、`buffered` 也在涨，**但解不出任何一帧**:
         *   起播 seek 到 `end − delaySec` 落在非关键帧上 → 解码器出不了画面 →
         *   `<video>` 卡住不推进 → **画面黑 + 声音也没有**（声音来自这个元素的音轨）,
         *   而字幕走独立分析支路、照常工作 —— 正是那条反馈「只有字幕没画面没声音」。
         *
         * **同一个根因也解释「源画面静止时黑屏」**:静止 → 合成器不产新帧 →
         * 同样是"`buffered` 在涨、但没有可解码的帧"。`maxFrameRate: 5` 只是把它放大成必现。
         *
         * `readyState >= 2`（HAVE_CURRENT_DATA）表示**当前位置的数据已经拿到**,
         * 比只量时间强:解码器解不出帧时它上不去。
         * ⚠️ 它不保证"一定出过画",所以下面配了超时诊断 —— 一直解不出来要能自报,不能干等。
         */
        if (!this.startSeekAt) {
          try {
            /**
             * ⚠️ 局部量叫 `seekTo`，**不要**写成 `const target = end - this.delaySec` ——
             * 下面调速那段（driftEma）有一行一模一样的 `const target = …`，
             * 而 smoke-test 里那条断言是用 `indexOf` 定位它的：
             * 多一处同名表达式会让它**定位到错的地方**，于是断言变红而代码其实没错。
             * （实测踩过:加完这个 seek 计数器，那条"调速必须用平滑偏差"当场变红。）
             */
            const seekTo = end - this.delaySec;
            this.video.currentTime = seekTo;
            this.startSeekAt = Date.now();
            // 计数 + 记下目标位置 —— 快照里只留这两个，不留完整历史（见字段的注释）
            this.seekCount++;
            this.lastSeekTarget = seekTo;
          } catch {
            return;
          }
        }
        if (this.video.readyState < 2) {
          // 缓冲在涨、却解不出帧:报一次诊断,**不锁定**,继续等
          const waited = Date.now() - this.startSeekAt;
          if (!this.reportedNoFrame && waited > 3000) {
            this.reportedNoFrame = true;
            this.onStatus({
              phase: 'no-decodable-frame',
              bufferedSec: end - start,
              readyState: this.video.readyState,
              waitedMs: waited,
            });
          }
          return;
        }
        this._play();
        this.locked = true;
        this.onStatus({ phase: 'playing', delaySec: this.delaySec });
      }
      return;
    }

    const target = end - this.delaySec;

    /**
     * ⚠️ 延迟涨太多就**跳一次**，把它硬拉回目标。
     *
     * 为什么必须有这一步：`smoothRate` 关掉时速率恒为 1，**没有任何机制把涨上去的延迟拉回来**。
     * 而播放头会因为解码 4K60 偶尔卡顿、走得比实时慢，录制端却是实时的 ——
     * 于是前方缓冲一路涨：6.6 → 9.6 → 12.6 秒，最后
     *   ① 撞穿 MSE 配额（12.6s × 78.6 Mbps ≈ 124 MB）→ appendBuffer 失败 → 缓冲出现空洞
     *   ② 播放头卡在空洞里 → readyState 2、见底、延迟涨到 21 秒
     * 实测就是这么"越来越卡、最后停住"的。**延迟无限增长在任何方案下都是 bug。**
     *
     * 阈值按**码率**算：内存允许的前方缓冲就那么长，码率越高越早该跳。
     */
    const ahead = end - this.video.currentTime;
    const jumpAt = this.delaySec + this._overDelayJumpSec();
    if (Number.isFinite(ahead) && ahead > jumpAt && !this._resyncing) {
      const seekTo = end - this.delaySec;
      // 至少跳 1 秒，避免为了几十毫秒来回微跳（那比不跳还难看）
      if (seekTo - this.video.currentTime > 1) {
        this._resyncing = true;
        const skipped = seekTo - this.video.currentTime;
        try {
          this.video.currentTime = seekTo;
          this.onStatus({ phase: 'resync', skippedSec: skipped, aheadSec: ahead });
        } catch {
          /* 跳失败就算了，下一 tick 再试 */
        }
        setTimeout(() => {
          this._resyncing = false;
        }, 1000);
        return; // 这一 tick 不再做别的，等跳完
      }
    }
    /**
     * ⚠️ 必须平滑，不能拿瞬时值调速。
     *
     * `bufferedEnd` 是**台阶式**的：每 250ms（MediaRecorder 的分片间隔）跳 0.25 秒，
     * 而 `currentTime` 是连续走的。所以瞬时 drift 是个锯齿波，幅度就有 0.25 秒 ——
     * 恰好和死区一样大。拿它去调 playbackRate 的结果是速率一直在抖，
     * 而**每次改速率都会让渲染器重新计时**，看起来就是画面每隔几秒顿一下。
     * （实测日志：速率长期在 0.940 和 1.060 两个夹紧值之间反复横跳，从不停在 1.000。）
     */
    const driftRaw = this.video.currentTime - target;
    this.lastDriftSec = driftRaw;
    this.driftEma = this.driftEma === null ? driftRaw : this.driftEma + (driftRaw - this.driftEma) * 0.25;
    const drift = this.driftEma;
    this.actualLagSec = Math.max(0, end - this.video.currentTime);

    // 迟滞状态要记住：纠偏一旦开始，就要一路纠到偏差很小才停。
    //
    // ⚠️ 可以整体关掉（设置里的「变速纠偏」）。
    // 关掉之后播放速率恒为 1，画面不再有变速顿挫；代价是延迟会慢慢漂离目标值。
    // **但字幕排期用的是实测延迟**（见 player 的 currentDelayMs），所以字幕依然对得上 ——
    // 这正是"关掉纠偏"可行的原因。
    const rate = this.smoothRate ? lagCorrectionRate(drift, { correcting: this._correcting }) : 1;
    this._correcting = rate !== 1;
    // 双保险：变化小于 0.4% 不写；两次写入至少隔 1 秒。
    // 每帧都写 playbackRate 会不断打扰时间伸缩器和渲染器。
    const nowMs = Date.now();
    if (
      Math.abs(this.video.playbackRate - rate) >= 0.004 &&
      nowMs - (this._lastRateSetAt || 0) >= 1000
    ) {
      this._lastRateSetAt = nowMs;
      try {
        this.video.playbackRate = rate;
      } catch {
        /* ignore */
      }
    }
    if (this.video.paused && !this.playBlocked) this._play();

    /**
     * 丢掉旧缓冲，否则内存会一直涨到 QuotaExceeded。
     *
     * ⚠️ 以前每 400ms（每次 _tick）就来一次 remove()，这是"画面偶尔顿一下"的成因：
     * remove() 和 appendBuffer() 必须共用同一个队列串行执行，而每次 remove()
     * 都要让解码器重新评估缓冲区间、并卡住后面的 append —— 缓冲一被抽薄，画面就顿。
     * 所以改成"攒够一大段再丢一次"，两次之间至少隔 10 秒。
     *
     * ⚠️⚠️ 但"攒够多少"不能拍脑袋写死。原来是"保留播放头前 15 秒 + 允许再攒 20 秒垃圾"
     * = 最多 43 秒缓冲。码率低的时候没事，可 4K60 + 高画质是 **128 Mbps = 16 MB/s**，
     * 43 秒就是 **688 MB** —— 直接撞穿 MSE 配额，报
     *   `SourceBuffer is full, and cannot free space`
     * 然后播放头停住、右上角的数全变 0。
     *
     * 现在按**码率**换算该留多少秒：内存预算固定，码率越高就只能留越短。
     */
    const keepBehind = Math.max(3, this._trimKeepBehindSec());
    const cut = this.video.currentTime - keepBehind;
    const bufferedStart = this.video.buffered.length ? this.video.buffered.start(0) : 0;
    const garbageSec = cut - bufferedStart;
    // 攒够"同样长的一段"就丢，别等到固定 20 秒（高码率下 20 秒已经是 320 MB）
    const garbageTarget = Math.max(4, keepBehind);
    if (
      cut > 1 &&
      garbageSec >= garbageTarget &&
      Date.now() - this._lastTrimAt >= TRIM_MIN_INTERVAL_MS &&
      this.queue &&
      !this.queue.running
    ) {
      this._lastTrimAt = Date.now();
      /**
       * ⚠️ 只记"裁剪发起过"这件事 —— 而 `remove()` 是**排进队列异步执行**的，
       * 所以这里记的是**发起**，不是"已经成功裁完"。这个区别要在读数里说清:
       * 计数在涨而 `起` 不动，说明 remove 排进去了却**没生效** ✗，那是另一条病因。
       */
      this._trimCount += 1;
      this._lastTrimCut = cut;
      this.queue.push(() => {
        if (this.stopped) return;
        try {
          this.sourceBuffer.remove(0, cut);
        } catch {
          /* ignore */
        }
      });
    }

    // 缓冲健康度：播放头前面还剩多少可播的。
    // 掉到很低就说明 append 跟不上（4K 重编码很吃资源），那才是顿的真正原因。
    this.bufferAheadSec = Math.max(0, end - this.video.currentTime);
    if (this.bufferAheadSec < 0.5) {
      this.stallCount = (this.stallCount || 0) + 1;
    }

    // 直接数掉帧 —— 这是"顿"最硬的证据。
    // 缓冲是满的却还在掉帧，就说明卡在解码/编码侧（CPU 或 GPU 被抢），而不是网络。
    try {
      const q = this.video.getVideoPlaybackQuality?.();
      if (q) {
        this.droppedFrames = q.droppedVideoFrames || 0;
        this.totalFrames = q.totalVideoFrames || 0;
      }
    } catch {
      /* ignore */
    }
  }

  /** 实际达成的延迟（秒），未知则 null */
  get actualDelaySec() {
    return this.actualLagSec;
  }

  /**
   * 只读诊断：缓冲占用的**估算**字节数 + 裁剪统计。**不参与任何判断。**
   *
   * ⚠️ 为什么要有:用户报「延迟模式跑一段时间稳定崩溃，关硬件加速就不崩、调低码率没用」✗。
   * 要判这是不是"缩略缓冲在涨"，光看 `末尾 {vEnd}` 不够 ——
   * 必须同时知道**起点**（`buffered.start(0)`）和**裁剪有没有发生** ✗。
   *
   * ⚠️ `estBytes` 是**估算**，不是真实占用:
   * 它用 `bitsPerSecond`（编码目标码率）× 缓冲时长算出来 ✗ ——
   * 而 MSE 实际吃多少还受容器开销、关键帧密度、解码器内部缓冲影响。
   * 所以它只能回答"**量级**在不在涨"，**不能**当成显存读数 ✗。
   *
   * ⚠️ 刻意**不印** `performance.memory` ✗ ——
   * 它只是 **JS 堆**，看不见 GPU / 解码缓冲，而那恰恰是这个 bug 的嫌疑所在。
   * 印一个"看着像内存、其实不看那块"的数，只会让人得出错的结论 ✗。
   *
   * 取不到就返回 `null`（快照那边按"不印"处理，不许抛）✓
   */
  get sbDiagnostics() {
    try {
      const b = this.video?.buffered;
      const trimCount = Number(this._trimCount) || 0;
      const sinceTrimSec = this._lastTrimAt ? (Date.now() - this._lastTrimAt) / 1000 : null;
      const lastCut = this._lastTrimCut === null || this._lastTrimCut === undefined
        ? null
        : Number(this._lastTrimCut);
      if (!b || !b.length) {
        return { startSec: null, spanSec: null, estBytes: null, trimCount, sinceTrimSec, lastCut };
      }
      const startSec = b.start(0);
      const endSec = b.end(b.length - 1);
      const spanSec = Math.max(0, endSec - startSec);
      const bytesPerSec = (this.bitsPerSecond || 4_000_000) / 8;
      return {
        startSec,
        spanSec,
        estBytes: spanSec * bytesPerSec,
        trimCount,
        sinceTrimSec,
        lastCut,
      };
    } catch {
      return null;
    }
  }

  /**
   * 缓冲末尾比实况落后多少秒 —— **这笔没算进 actualDelaySec，字幕因此偏早这么多**。
   *
   * 由来：媒体时间 0 = 开始录音那一刻，所以
   *     (现在 − 开始录音) = 实况已经录了多久
   *     减去 bufferedEnd  = 还没进缓冲的那一段 = 录音/编码的固有滞后
   * 分片是 250ms，所以它至少是这个量级，再叠加编码器延迟。
   *
   * @returns {number|null}
   */
  get recorderLagSec() {
    const end = this.bufferedEnd();
    if (!this.recStartedAt || end === null) return null;
    const lag = (Date.now() - this.recStartedAt) / 1000 - end;
    if (!Number.isFinite(lag)) return null;
    // ⚠️ 不夹到很小的上限：这里只负责**量**，夹紧是排期那边的事。
    // 夹在这里会把"编码器跟不上"这个线索藏掉（日志里出现过夹在 2.00s 的值）。
    return Math.max(0, lag);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this._stopClocks();
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch {
      /* ignore */
    }
    this.recorder = null;
    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch {
      /* ignore */
    }
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = null;
    this.chunkQueue = [];
    try {
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    } catch {
      /* ignore */
    }
    this.objectUrl = '';
    try {
      this.video.removeAttribute('src');
      this.video.load();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 构造「前文 + 后文」的上下文块。
 *
 * 「后文」是延迟模式独有的东西：立刻翻译的话，这些内容此刻还没被识别出来。
 * 这是"延迟换准确率"具体换到的部分——延迟调大，能拿到的后文就更多。
 *
 * @param {Array<{original:string}>} segs 按上屏顺序排列的片段
 * @param {number} index 目标片段的下标
 * @returns {{text:string, back:number, forward:number}}
 */
export function buildContextWindow(segs, index, { back = 2, forward = 2 } = {}) {
  if (!Array.isArray(segs) || index < 0 || index >= segs.length) return { text: '', back: 0, forward: 0 };
  const pick = (from, to) =>
    segs
      .slice(Math.max(0, from), Math.max(0, to))
      .map((s) => String(s?.original ?? '').trim())
      .filter(Boolean);
  const before = pick(index - back, index);
  const after = pick(index + 1, index + 1 + forward);

  const parts = [];
  if (before.length) parts.push(`【之前】\n${before.join('\n')}`);
  if (after.length) parts.push(`【之后】\n${after.join('\n')}`);
  return { text: parts.join('\n\n'), back: before.length, forward: after.length };
}

/**
 * 翻译窗口：字幕该上屏的时刻往前推这么久，就开始翻译。
 *
 * 规则只有这一条，没有旋钮：
 *   上屏时刻 at = 这句「开口」的音频位置 + 画面延迟
 *   开始翻译   = at − TRANSLATE_WINDOW_MS
 *   翻译完了先等着，到 at 再上屏
 *
 * 为什么还要 effectiveLeadMs：这个窗口是**下限**。
 * 如果实测翻译比它慢，还死守 700ms 的话字幕必然迟到 —— 那就成了"设得越准越容易翻车"。
 * 所以翻译慢的时候自动往前让路。
 */
export const TRANSLATE_WINDOW_MS = 700;

/**
 * 这一轮实际该提前多久开始翻译。
 *
 * @param {number} observedMs 实测翻译耗时（EMA）；拿不到就按下限走
 * @param {{floorMs?:number, safety?:number, extraMs?:number, capMs?:number}} opts
 * @returns {number}
 */
export function effectiveLeadMs(observedMs, { floorMs = TRANSLATE_WINDOW_MS, safety = 1.6, extraMs = 300, capMs = 4000 } = {}) {
  const obs = Number(observedMs);
  if (!Number.isFinite(obs) || obs <= 0) return floorMs;
  return Math.min(capMs, Math.max(floorMs, obs * safety + extraMs));
}

/**
 * 翻译泵的调度决策（纯函数，专门为了能单测）。
 *
 * 这里承载了一个真实踩过的坑：只要有请求挂住不返回，"在飞数量"就只增不减，
 * 攒够上限之后整个翻译泵会**永久停摆**——现象就是"前几句有翻译，后面全没了"。
 * 所以它必须可测。
 *
 * @returns {number} 下一个该翻的片段下标；没有则 -1
 */
export function pickNextToTranslate(segs, { now, leadMs, inflight, maxInflight, maxWaitMs = 4000 } = {}) {
  if (!Array.isArray(segs) || inflight >= maxInflight) return -1;
  const immediate = !(leadMs > 0); // 0 / 负数 = 定稿就翻
  const lead = Math.max(300, leadMs || 0);

  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (!seg || seg.translated || seg.inFlight) continue;
    const waited = now - (Number(seg.arrivedAt) || now);
    // 排期时刻可能是错的（时间戳跳变），所以给一个"等太久就无条件翻"的兜底
    const overdue = waited > maxWaitMs;
    if (!immediate && !overdue && seg.at - now > lead) return -1; // 后面的更晚，不用看了
    return i;
  }
  return -1;
}

/**
 * 看门狗：找出"在飞太久"的片段。
 * 只增不减的在飞计数会让翻译泵永久停摆，所以必须能强制回收。
 *
 * 没有 startedAt 的不算卡住——正常路径一定会写上它，缺了就属于代码 bug，
 * 保守起见交给"在飞计数自愈"去纠正，而不是在这里误杀一个真的在飞的请求。
 */
export function findStuckFlights(segs, now, stuckMs = 25000) {
  if (!Array.isArray(segs)) return [];
  return segs.filter((seg) => {
    if (!seg?.inFlight) return false;
    const startedAt = Number(seg.startedAt);
    return Number.isFinite(startedAt) && startedAt > 0 && now - startedAt > stuckMs;
  });
}

/** 以实际在飞的条目为准重算在飞数量（自愈用） */
export function countInflight(segs) {
  if (!Array.isArray(segs)) return 0;
  return segs.reduce((n, seg) => n + (seg?.inFlight ? 1 : 0), 0);
}

// ───────────────────────── 合并短段（合理断句的配套）─────────────────────────
//
// 问题：一句话被切成"长的 + 很短的"两段时，那条短尾巴单独成一条字幕很难读。
//   6 秒的话被回看切在 4.2 秒 → 4.2 + 1.8，而 1.8 秒那半句自己不成句。
//   看门狗硬吐出来的碎片是同一类：实测日志里出现过 `1 字 / 6 字 / 7 字 · watchdog`。
//
// 做法：**不改时间轴**。第一段照常按排期上屏，等后面那条短段的文本到了，
//   把文本并回第一段、原地替换那一条（复用"译文晚到时替换已上屏条目"那套机制）。
//   ⚠️ 刻意**不**取消第一段的排期去等后面那条 —— 那会让它晚 2~5 秒才出现，
//      而实测的识别滞后本来就贴着延迟预算（6.6s），再等就必然迟到 ✗

/**
 * 「短段」的门槛 —— **复用断句层同一个量**。
 *
 * 断句层用 `substantial = durationSec >= 1.5 || text.length >= 10` 判断
 * "这一段够不够长到能独立成句"；这里反过来用：**不够长**就是"该并进上一句"的候选。
 * ⚠️ 刻意不另造一套阈值 —— 两处对"多短算碎片"必须一致，否则会出现
 *    "断句说这是碎片、排期说它能独立成句"这种自相矛盾（这个项目为"同一事实记两遍、
 *    只改一处"栽过多次）。
 */
export const TAIL_MERGE_MAX_SEC = 1.5;
export const TAIL_MERGE_MAX_CHARS = 10;

/** 两段音频之间最多隔多久还算"同一句话的后半截"（秒） */
export const TAIL_MERGE_MAX_GAP_SEC = 1.5;

/**
 * 合并的**次数与字数**上界 —— 没有时间戳时，它们是**唯一**挡得住无界合并的东西。
 *
 * ⚠️ 为什么必须有：上面那道 `maxGapSec` 守卫是 `Number.isFinite(gap) && gap > maxGapSec`，
 *    而 `prev.end` 缺失时 `gap = Number(undefined) - … = NaN` → `Number.isFinite(NaN) === false`
 *    → **整道守卫被静默跳过** ✗（不是"放行一个略超的间隔"，是"完全不再检查"）。
 *    实测（探针驱动真源码，`prev.end === undefined`）：**并 500 次都没停 —— 3030 字** ✗✗✗
 *    （对照组：`prev.end` 有值时并 3 次就自然停住，48 字 ✓）
 *
 * ⚠️ 而这正好是项目自己那条教训的**反面**：
 *    「传 null 会被 `Number(null)=0` 当成合法时间戳」——那里是"缺值被当成 0"；
 *    这里是"缺值让守卫**根本不执行**"。同一个 `Number.isFinite` 守卫，两种坏法都会失效 ✗
 *
 * ⚠️ 修法**不是**"没有 end 就不并"：`isShortTail` 的注释写明了没有时间戳时也要能并
 *    （否则那种服务上"功能等于没做"✗）。所以缺时间戳时**换一把尺子**：按次数与字数封顶 ✓
 *
 * 取值：次数 3（正常一句话最多被切成几段尾巴）+ 总字数 60 —— 与累积器的 `maxChars`
 * 取同一个数，于是"一条字幕最长多少字"全项目只有一个答案 ✓
 */
export const TAIL_MERGE_MAX_MERGES = 3;
export const TAIL_MERGE_MAX_TOTAL_CHARS = 60;

/**
 * 这条够不够短，短到不该单独成一条字幕。
 *
 * ⚠️ 没有时间戳（有些服务不给 start/duration）时只看字数：
 *    那时**不能**当成"够长"—— 否则短段永远并不上，功能等于没做。
 */
export function isShortTail(u, { maxSec = TAIL_MERGE_MAX_SEC, maxChars = TAIL_MERGE_MAX_CHARS } = {}) {
  const text = String(u?.text || '').trim();
  if (!text) return false;
  const dur = Number(u?.duration);
  const longByTime = Number.isFinite(dur) && dur >= maxSec;
  return !longByTime && text.length < maxChars;
}

/** 这句话的文本看起来**说完了**没（末尾是句末标点） */
export function endsCompleteSentence(text) {
  // ⚠️ 和断句层那条 `looksComplete` 用同一个字符集，但**不要求**非 tiny ——
  //    那里是"够格收句"，这里是"看起来说完了"，判的东西不同。
  return /[.。!?！?…]["'）)」』]?$/.test(String(text || '').trim());
}

/**
 * 这一条该不该并进上一句？返回触发源（`''` = 不并）。
 *
 * 两个触发源的**开关条件不同**，这是用户实测定下来的边界：
 *
 *   ① `max-length`：音频到上限被硬切 → 后面那点是它的尾巴
 *      → **只在「合理断句」开着时**才并（那个尾巴本来就是合理断句造成的）
 *
 *   ② `watchdog`：看门狗硬吐出来的碎片
 *      → **和「合理断句」开关无关**。实测那些 `1 字 / 6 字 / 7 字 · watchdog`
 *        正是在合理断句**关着**的时候出现的 —— 挂在那个开关下面就等于关掉后碎片照旧。
 *
 * @param {object} prev 上一段（排期条目，带 `cut` / `original` / `end` / `tailMerged`）
 * @param {object} u 刚到的这一段（带 `reason` / `text` / `start` / `duration`）
 * @param {{smartCut?:boolean, maxGapSec?:number, maxMerges?:number, maxTotalChars?:number}} opts
 */
export function tailMergeTrigger(
  prev,
  u,
  {
    smartCut = false,
    maxGapSec = TAIL_MERGE_MAX_GAP_SEC,
    maxMerges = TAIL_MERGE_MAX_MERGES,
    maxTotalChars = TAIL_MERGE_MAX_TOTAL_CHARS,
  } = {},
) {
  if (!prev || !u) return '';
  if (!isShortTail(u)) return '';
  // 两段之间隔太久 → 那句话已经结束了，后面这条是新的（哪怕它很短）
  const gap = Number(u.start) - Number(prev.end);
  if (Number.isFinite(gap) && gap > maxGapSec) return '';

  /**
   * ⚠️ 上面那道守卫**在两端没有时间戳时根本算不出来**（`Number(undefined)` → NaN →
   *    `Number.isFinite(NaN)` 为假 → 整道被跳过 ✗，实测能并 500 次、3030 字）。
   *    所以再加两道不看时间戳的：次数 + 并后总字数。**少了这两条就是无界** ✗
   *    取值依据见 `TAIL_MERGE_MAX_MERGES` 处的注释。
   */
  if ((Number(prev.tailMerged) || 0) >= maxMerges) return '';
  // ⚠️ 长度用 `mergeTailText` 算，别在这儿另写一遍拼接规则
  //    （"同一事实记两遍、只改一处"是这个项目的惯犯）
  if (mergeTailText(prev.original, u.text).length > maxTotalChars) return '';

  // ① 回看切出来的短尾巴：音频被硬切**本身就是证据**，所以不看标点。
  //    （⚠️ 实测：`超长被切断` 那些段经常同时命中"句末标点"—— Whisper 会给自己
  //      拿到的半句补一个句号，所以标点在这里说明不了"说完了"。）
  if (String(prev.cut || '') === 'max-length' && smartCut) return 'max-length';

  // ② 看门狗碎片：音频**没被切**（是 ASR 一直不发收句信号），所以手上没有音频证据，
  //    只能看文本 —— 上一句自己结束在句号上，说明它是完整的，
  //    后面那条短句就是独立的（`はい` 那种真实短回答），不能并。
  if (String(u.reason || '') === 'watchdog') {
    if (endsCompleteSentence(prev.original)) return '';
    return 'watchdog';
  }
  return '';
}

/** 合并之后的文本（和累积器拼分片用同一条规则：空格分隔） */
export function mergeTailText(prevText, tailText) {
  const a = String(prevText || '').trim();
  const b = String(tailText || '').trim();
  if (!a) return b;
  if (!b) return a;
  return `${a} ${b}`;
}

// ─────────────────────────── 字幕时间轴 ───────────────────────────

/**
 * 字幕排期队列。
 *
 * 画面被推迟了 D 秒，所以"某段音频该在什么时候上屏"就是一件可以算出来的事：
 *   音频在流里的位置 s（秒）→ 它在墙上时钟 firstAudioAt + s 被采到
 *   → 它会在 firstAudioAt + s + D 出现在延迟画面上
 * 把译文按这个时刻排队，译文只要在那之前准备好，字幕就和画面对齐了。
 *
 * 入队时若已经错过时刻，标记为 late 并立刻上屏（优雅降级）。
 */
export class SubtitleSchedule {
  constructor() {
    this.items = [];
    this.maxItems = 200;
  }

  /**
   * ⚠️ 锚点是这句**开口**的时刻（start），不是说完的时刻（start + duration）。
   *
   * 锚在「说完」的后果：字幕要等画面播到这句结束、**再等一整个 D** 才出来 ——
   * 现象就是"人都快说完了字幕才上"。锚在「开口」，字幕就在画面上人张嘴的那一帧出现。
   *
   * 长句会超出延迟预算：那时文本还没到手，算出来的 at 已经落在过去 →
   * `late` 标记 → 排期层立刻上屏，也就是"能多早就多早"，而不是再补等一个 D。
   *
   * @param {{id:string, original:string, translation:string}} seg
   * @param {{start:number, duration:number}} timing 音频区间（秒，相对流起点）
   * @param {number} firstAudioAt 第一帧音频送出的墙上时钟（ms）
   * @param {number} delayMs 画面延迟（ms）
   * @param {number} syncOffsetMs 用户微调（ms）
   * @returns {number} 排定的上屏时刻（epoch ms）
   */
  push(seg, timing, firstAudioAt, delayMs, syncOffsetMs = 0) {
    const start = Number(timing?.start);
    // duration 刻意不参与计算：它只影响字幕在屏幕上停留多久，不该影响什么时候出现
    const at = Number.isFinite(start) ? firstAudioAt + start * 1000 + delayMs + syncOffsetMs : Date.now();
    // 存下 start/end：延迟变了要靠 start 重算 at（见 resync），
    // end 只用于诊断——判断字幕是"还在句内"还是"已经说过头了"。
    const dur = Number(timing?.duration);
    const item = {
      ...seg,
      at,
      late: at <= Date.now(),
      start: Number.isFinite(start) ? start : undefined,
      end: Number.isFinite(start) && Number.isFinite(dur) ? start + dur : undefined,
    };
    this.items.push(item);
    if (this.items.length > this.maxItems) this.items.splice(0, this.items.length - this.maxItems);
    return at;
  }

  /**
   * 延迟变了就重算排队中条目的上屏时刻。
   *
   * ⚠️ 不重算会出大问题。at = 音频位置 + **当前**延迟，而延迟不是瞬间到位的：
   * 把延迟调大之后播放头**不会**慢慢漂到新位置 —— `smoothRate` 默认关着，速率恒为 1，
   * 没有任何机制把延迟"攒"出来（那是变速纠偏开启时才有的行为，而且它很慢：
   * lagCorrectionRate 上限 0.06，攒 2 秒要三十多秒）。
   * 实际生效的只有两条路：起播时一步到位、以及前方缓冲涨太多时跳一次。
   * 这期间排下的字幕如果沿用旧延迟算出的 at，就会**集体提前或落后**。
   *
   * 所有条目平移的是同一个量，所以排队顺序不变 —— due() 从队首扫的逻辑依然成立。
   *
   * @returns {number} 实际被改动的条目数
   */
  resync({ firstAudioAt, delayMs, syncOffsetMs = 0, now = Date.now() } = {}) {
    let moved = 0;
    for (const item of this.items) {
      if (!Number.isFinite(item.start)) continue; // 没有时间戳的条目本来就退回"立刻上屏"，无从重算
      const at = firstAudioAt + item.start * 1000 + delayMs + syncOffsetMs;
      if (at === item.at) continue;
      item.at = at;
      item.late = at <= now;
      moved += 1;
    }
    return moved;
  }

  /**
   * 取出所有到点、**并且调用方认为可以上屏**的条目（按排期顺序），并从队列移除。
   *
   * `ready(item)` 返回 false 的条目会**留在队首**等 —— 后面的不能越过它，
   * 否则晚到的译文会插到已经上屏的字幕前面，顺序就乱了。
   *
   * 这个参数是为「原文到手 ≠ 译文到手」准备的：识别一到就有原文，翻译还要再花时间。
   * 没有它的话，译文没回来时字幕会先显示原文（看起来就是"上屏了但没翻译"）。
   *
   * @param {number} now
   * @param {((item:object)=>boolean)|null} ready
   */
  due(now = Date.now(), ready = null) {
    const out = [];
    while (this.items.length && this.items[0].at <= now && (!ready || ready(this.items[0]))) {
      out.push(this.items.shift());
    }
    return out;
  }

  clear() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }
}
