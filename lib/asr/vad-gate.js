// VAD 断句状态机。
//
// ⚠️ 为什么把它单独抽出来：**ONNX 推理在 Node 里跑不了**（没有 onnxruntime），
// 但"什么算一句"这套判断才是真正容易出错的地方。拆开之后这部分能完整单测，
// 而推理那层只剩下"把概率喂进来"这一件事。
//
// 输入：每 512 个采样点（16kHz 下 32ms）算出的一次"有人在说话"的概率。
// 输出：这一帧是否构成「一句开始」或「一句结束」。
//
// 相比按固定时长切分片，这里的价值在于：
//   分片模式必须攒满一整片、还要等下一片才能判断跨片 → 延迟 = 分片 × 2
//   VAD 当场就能判断"说完了" → 延迟 = 静音确认时长（默认 300ms）

/**
 * 16kHz 下的窗长。
 *
 * ⚠️ **576，不是 512。** 这踩过一次大坑：
 * 网上关于 Silero 的资料绝大多数写的是「16kHz 用 512」，那是 **v5** 的参数。
 * 而 `snakers4/silero-vad` 的 master 分支现在给的是 **v6** 模型，窗长是 576。
 *
 * 喂错窗长的症状极具迷惑性：模型**不报错**、输出形状也对（[1,1]）、
 * 输入电平完全正常，但概率恒为 0.001 —— 看起来就像"音频里没人说话"。
 * 实测（本地跑真模型，4 秒真人语音）：
 *
 *   窗长   帧数  概率中位  最高   高于 0.9 的帧
 *    512   125    0.001   0.001     0.0%     ← 完全聋
 *    544   117    0.001   0.001     0.0%
 *    576   111    0.069   1.000    25.2%     ← 真的在工作
 *    640   100    0.090   1.000    28.0%
 *    768 以上     报错（模型会拒绝过大的窗）
 *
 * 所以窗长**不能小于 576**。线上还有开箱自检兜底（见 vad.js），
 * 换模型版本时它会自动挑出能用的那一种。
 */
export const VAD_FRAME_SAMPLES = 576;

/** 模型固定跑在 16kHz —— 留白和帧长的换算都基于它 */
export const VAD_SAMPLE_RATE = 16000;

/** 一帧多少毫秒。**必须从窗长推导**，不能写死。 */
export const VAD_FRAME_MS = (VAD_FRAME_SAMPLES / VAD_SAMPLE_RATE) * 1000;

/**
 * @param {object} opts
 * @param {number} [opts.threshold]    概率高于它算"有人在说话"
 * @param {number} [opts.minSpeechMs]  连续说这么久才算一句真的开始（滤掉咳嗽、桌椅响）
 * @param {number} [opts.minSilenceMs] 连续静这么久才算"说完了"（这就是主要的延迟来源）
 * @param {number} [opts.maxSpeechMs]  一句最长多久，超了强制切断（防止没人停顿导致永远不出字幕）
 * @param {number} [opts.padMs]        句子前后各补多少毫秒（切在音节中间会让识别丢字）
 * @param {number} [opts.frameMs]      一帧多少毫秒
 *   ⚠️ 必须和实际的窗长自洽：`frameMs = winSamples / 采样率 × 1000`。
 *   576 采样 @16k 就是 36ms。写成别的值会让留白换算错掉。
 */
export class VadGate {
  constructor({
    threshold = 0.5,
    /**
     * ⚠️ 迟滞：进入"说话中"用 threshold，**退出**要用更低的 exitThreshold。
     *
     * 只有一个阈值的话，连续说话时概率在 0.5 附近小幅摆动就会不断触发"说完了"，
     * 字幕会碎成一片 —— 这是踩过的坑（用户反馈"太碎了"）。
     * 和当初治播放变速抖动用的是同一个办法。
     */
    exitThreshold = null,
    minSpeechMs = 250,
    minSilenceMs = 450,
    /** 短于这个时长的话段当噪声丢掉，不要单独出一条字幕 */
    minUtteranceMs = 400,
    maxSpeechMs = 20000,
    padMs = 200,
    /**
     * 一帧多少采样。
     *
     * ⚠️ **这是"帧长"唯一的来源。** 曾经同时存在两个：`frameMs`（由窗长推导，对）
     * 和 `toSamples` 里默认的 `VAD_FRAME_SAMPLES` 常量（可能过期，错）。
     * 自检挑中 640 窗之后，前者按 640 算、后者还按 576 算，
     * 帧号乘错导致位置越算越偏（第 100 帧就差 6.4 秒），最后落到已裁剪的缓冲之外 ——
     * 取不到音频就静默 return，症状是"开始还行，后面定住没新内容"。
     * 现在 frameMs 由它推导，不可能再不一致。
     */
    frameSamples = VAD_FRAME_SAMPLES,
    /** 只在需要覆盖时传；正常情况由 frameSamples 推导 */
    frameMs = null,
  } = {}) {
    this.threshold = Number(threshold);
    // ⚠️ 必须用 == null 判断，不能写 Number.isFinite(Number(exitThreshold))：
    // Number(null) 是 0，而 0 是有限数 —— 于是"没传"会被当成"退出阈值 = 0"，
    // 静音再也算不上静音，一句话永远收不了尾（测试当场抓到了四条失败）。
    this.exitThreshold =
      exitThreshold === null || exitThreshold === undefined ? this.threshold * 0.7 : Number(exitThreshold);
    this.minSpeechMs = Number(minSpeechMs);
    this.minSilenceMs = Number(minSilenceMs);
    this.minUtteranceMs = Number(minUtteranceMs);
    this.maxSpeechMs = Number(maxSpeechMs);
    this.padMs = Number(padMs);
    this.frameSamples = Number(frameSamples);
    this.frameMs = frameMs === null || frameMs === undefined ? (this.frameSamples / VAD_SAMPLE_RATE) * 1000 : Number(frameMs);

    this.frameIndex = 0; // 已经喂进来的帧数
    this.inSpeech = false;
    this.speechRun = 0; // 还没进入语音态时，连续多少帧高于阈值
    this.silenceRun = 0; // 语音态下，连续多少帧低于阈值
    this.speechFrames = 0; // 当前这句已经持续多少帧
    this.startFrame = 0; // 当前这句的第一帧
  }

  /**
   * 喂一帧的概率。
   * @param {number} prob 0~1
   * @returns {null | {type:'start', startFrame:number} | {type:'end', startFrame:number, endFrame:number, reason:string}}
   */
  push(prob) {
    const p = Number(prob);
    this.frameIndex += 1;
    if (!Number.isFinite(p)) return null;

    if (!this.inSpeech) {
      if (p >= this.threshold) {
        this.speechRun += 1;
        // 连续说够久才算一句真的开始
        if (this.speechRun * this.frameMs >= this.minSpeechMs) {
          this.inSpeech = true;
          // frameIndex 已经加过 1，所以第一帧是 frameIndex - speechRun
          this.startFrame = this.frameIndex - this.speechRun;
          this.speechFrames = this.speechRun;
          this.silenceRun = 0;
          return { type: 'start', startFrame: this.startFrame };
        }
      } else {
        this.speechRun = 0;
      }
      return null;
    }

    // 语音态：⚠️ 用**更低的** exitThreshold 判断静音（迟滞），
    // 否则概率在阈值附近的抖动会把一句话切成好几条字幕。
    this.speechFrames += 1;
    if (p < this.exitThreshold) this.silenceRun += 1;
    else this.silenceRun = 0;

    const silentEnough = this.silenceRun * this.frameMs >= this.minSilenceMs;
    const tooLong = this.speechFrames * this.frameMs >= this.maxSpeechMs;
    if (!silentEnough && !tooLong) return null;

    const startFrame = this.startFrame;
    // 结束位置：语音的最后一帧之后。静音确认了多少帧，就回退多少。
    const endFrame = this.frameIndex - this.silenceRun;
    const durationMs = (endFrame - startFrame) * this.frameMs;
    /**
     * ⚠️ 必须在**清零之前**把这个值取出来。
     * 踩过的坑：先写 `this.silenceRun = 0` 再算 `silenceMs`，于是它恒为 0 ——
     * 而调用方正是靠它区分软/硬边界，结果"静音够久就收句"那条从来没生效过，
     * 字幕该断的不断、不该拼的乱拼。
     */
    const silenceMs = this.silenceRun * this.frameMs;
    this.inSpeech = false;
    this.speechRun = 0;
    this.silenceRun = 0;
    this.speechFrames = 0;
    return {
      type: 'end',
      startFrame,
      endFrame,
      durationMs,
      /** 这次切分依据的静音时长（毫秒）—— 调用方靠它区分软/硬边界 */
      silenceMs,
      // 太短的多半是噪声或 VAD 抖动，由调用方决定丢不丢（状态机保持诚实，不自己吞掉）
      tooShort: durationMs < this.minUtteranceMs,
      reason: silentEnough ? 'silence' : 'max-length',
    };
  }

  /**
   * 把帧区间换算成采样区间，并补上前后留白。
   * @returns {{start:number, end:number}} 采样下标，左闭右开
   */
  toSamples(startFrame, endFrame, { totalSamples, frameSamples = this.frameSamples } = {}) {
    const pad = Math.round((this.padMs / 1000) * (frameSamples / (this.frameMs / 1000)));
    let s = startFrame * frameSamples - pad;
    let e = endFrame * frameSamples + pad;
    if (s < 0) s = 0;
    if (Number.isFinite(totalSamples) && e > totalSamples) e = totalSamples;
    return { start: s, end: e };
  }

  /** 换一段音频时要清状态（Silero 的 state 也要一起清） */
  reset() {
    this.frameIndex = 0;
    this.inSpeech = false;
    this.speechRun = 0;
    this.silenceRun = 0;
    this.speechFrames = 0;
    this.startFrame = 0;
  }
}
