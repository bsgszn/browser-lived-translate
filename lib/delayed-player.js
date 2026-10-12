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

export const DELAY_MIN_SEC = 0.5;
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
  if (!Number.isFinite(v)) return 2.5;
  return Math.min(DELAY_MAX_SEC, Math.max(DELAY_MIN_SEC, v));
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
 * 挑一个当前浏览器支持的录制格式；优先级从高到低。
 *
 * ⚠️ 顺序很重要：**H.264 优先**。
 * VP9/VP8 在 Chrome 里通常是**软件编码**，4K 下极重；而 H.264（avc1）
 * 在现代 GPU 上基本都是硬件编码，CPU 和 GPU 压力都小得多。
 * 这台机器上画面每几秒顿一下，瓶颈就是它和本地 Whisper 抢同一块 GPU。
 *
 * 每一种都必须 **同时** 被 MediaRecorder 和 MediaSource 接受 ——
 * 只过 MediaRecorder 却在 addSourceBuffer 时失败的话，整个延迟播放会起不来。
 */
export function pickMimeType() {
  const candidates = [
    // 硬件编码优先
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs="avc1.4D401E,mp4a.40.2"',
    'video/x-matroska;codecs="avc1,opus"',
    'video/webm;codecs="h264,opus"',
    // 退而求其次：VP9 / VP8（可能是软件编码，但至少能跑）
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs="vp8,opus"',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const ok = (c) => {
    try {
      if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(c)) return false;
      if (typeof MediaSource === 'undefined' || typeof MediaSource.isTypeSupported !== 'function') return false;
      return MediaSource.isTypeSupported(c);
    } catch {
      return false;
    }
  };
  for (const c of candidates) if (ok(c)) return c;
  return '';
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
    this.delaySec = clampDelay(opts.delaySec ?? 2.5);
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
    this.mimeType = opts.mimeType || pickMimeType();
    this.onStatus = opts.onStatus || (() => {});

    this.recorder = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.queue = null;
    this.objectUrl = '';
    this.chunkQueue = [];
    this.locked = false;
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
   * @returns {Promise<void>} 首个分片可用、可以开始播放时 resolve
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

    this.mediaSource = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;
    // 微调速率时保持音调不变，否则人声会明显变调
    try {
      this.video.preservesPitch = true;
    } catch {
      /* ignore */
    }
    this.video.muted = false;

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        this.mediaSource.removeEventListener('sourceopen', onOpen);
        try {
          const sb = this.mediaSource.addSourceBuffer(this.mimeType);
          sb.mode = 'segments';
          this.sourceBuffer = sb;
          this.queue = new SourceBufferQueue(sb);
          resolve();
        } catch (e) {
          reject(new Error(`无法建立缓冲：${e.message}`));
        }
      };
      this.mediaSource.addEventListener('sourceopen', onOpen);
      setTimeout(() => reject(new Error('MediaSource 打开超时')), 8000);
    });

    this.recorder = new MediaRecorder(stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: this.bitsPerSecond,
      audioBitsPerSecond: 128_000,
    });
    this.recorder.ondataavailable = (e) => {
      if (this.stopped || !e.data || !e.data.size) return;
      this.bytes += e.data.size;
      e.data
        .arrayBuffer()
        .then((buf) => {
          if (this.stopped) return;
          this.chunkQueue.push(buf);
          this._pumpChunks();
        })
        .catch(() => {});
    };
    // 分片越短，缓冲末尾越贴近"现在"，延迟估值越准；但开销也越大。250ms 是折中。
    this.recStartedAt = Date.now(); // 媒体时间 0 就是这一刻，量"缓冲落后实况多久"要用它
    this.recorder.start(250);

    // 闭环纠偏
    this.timer = setInterval(() => this._tick(), 400);
    // 精细卡顿探测：_tick 每 400ms 才看一次，短促的卡顿抓不到。
    // 这个每 100ms 看一次"播放头有没有正常前进"，卡住就把当时的状态全记下来。
    this.probeTimer = setInterval(() => this._probe(), 100);
    this.onStatus({ phase: 'recording', mimeType: this.mimeType, bitrateNote: this.bitrateNote });
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
        try {
          this.video.currentTime = end - this.delaySec;
        } catch {
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
    if (this.timer) clearInterval(this.timer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
    this.timer = null;
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
