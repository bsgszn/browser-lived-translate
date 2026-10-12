// 把 ASR 的 is_final 分片累积成「一次完整的说话」。
//
// 为什么需要它：
// Deepgram 在一次说话**中间**也会不断吐 is_final（它在保守地"锁定"已经确定的部分）。
// 如果每个分片都当成一条字幕，一句 15 秒的长句会变成七八条碎片一句句往外蹦——
// 读者看到的是半截话，这就是"不完整、不流畅"的来源。
//
// 规则：只认「说话人停下来了」，把中间累积的分片合成**一条**字幕整句上屏。
//
// 边界由 Deepgram 的**静音判定**给出，一共两个来源：
//   speech_final  —— 安静超过 endpointing（**默认 500ms**）时置位，延迟模式的**主边界**
//   UtteranceEnd  —— 安静超过 utterance_end_ms 时单独发的事件。⚠️ 这个值 Deepgram 硬下限
//                    就是 1000ms，调不下去，所以它在这里只当**兜底**（speech_final 没发时）
//
// 历史坑：endpointing 原来是 120ms，换气（100~250ms）都会触发 speech_final，
// 于是长句被切成碎片。当时以为"只能用 utterance_end_ms"，但那个下限是 1000ms，
// 又太迟钝、会把两句不相干的话并成一条。真正的解法是把 endpointing 抬到句间停顿的量级。
//
// 三个兜底（少了任何一个都会出现"永远不上屏"）：
//   · 说话人一直不停顿     → 累积跨度超过 maxSpanSec 就先上屏一次
//   · ASR 没发收句信号     → 最后一个分片之后静默超过 watchdogMs 就上屏
//   · 停止采集             → 调用方显式 flush()

export class UtteranceAccumulator {
  /**
   * @param {{maxSpanSec?:number, watchdogMs?:number}} opts
   */
  constructor({ maxSpanSec = 15, watchdogMs = 3000 } = {}) {
    this.maxSpanSec = Math.max(2, Number(maxSpanSec) || 15);
    this.watchdogMs = Math.max(500, Number(watchdogMs) || 3000);
    this.parts = [];
    /** 累积区间，单位秒（相对本次识别的第一帧）。可能为 null = 该服务没给时间戳 */
    this.start = null;
    this.end = null;
    this.lastFinalAt = 0;
  }

  get pending() {
    return this.parts.length > 0;
  }

  get text() {
    return this.parts.join(' ').trim();
  }

  get spanSec() {
    if (this.start === null || this.end === null) return 0;
    return Math.max(0, this.end - this.start);
  }

  /**
   * 喂一个 is_final 分片。
   * @returns {{text:string,start:(number|undefined),duration:(number|undefined),reason:string}|null}
   *          需要**立刻**上屏的那一条（说话人一直不停顿时的兜底），否则 null
   */
  addFinal(ev, now = Date.now()) {
    const text = String(ev?.text || '').trim();
    if (!text) return null;

    // 同一个分片可能既走 is_final 又走 speech_final，别重复累积
    if (this.parts[this.parts.length - 1] !== text) this.parts.push(text);

    const s = Number(ev?.start);
    const d = Number(ev?.duration);
    if (Number.isFinite(s)) {
      if (this.start === null) this.start = s;
      this.end = Number.isFinite(d) ? s + d : s;
    }
    this.lastFinalAt = now;

    if (this.spanSec >= this.maxSpanSec) return this._flush('max-span');
    return null;
  }

  /**
   * ASR 报「说话人停下来了」。
   *
   * speech_final 和 UtteranceEnd **都认**：前者的阈值是 endpointing（可调，是主边界），
   * 后者的阈值被 Deepgram 锁在 ≥1000ms（只能当兜底）。两个都认不会重复上屏 ——
   * 先到的那个收完句，后到的进来时累积已经空了，直接返回 null。
   *
   * @returns 整句，或者 null
   */
  endUtterance(ev, now = Date.now()) {
    const text = String(ev?.text || '').trim();
    if (text && this.parts[this.parts.length - 1] !== text) this.parts.push(text);
    if (!this.pending) return null;
    void now;
    // 让诊断面板能看出这一句是被哪个信号收掉的（speech-final 是主边界，utterance-end 是兜底）
    const reason = String(ev?.reason || '') === 'speech_final' ? 'speech-final' : 'utterance-end';
    return this._flush(reason);
  }

  /** 定时调用：ASR 迟迟不发 utteranceEnd 时的兜底 */
  tick(now = Date.now()) {
    if (!this.pending || !this.lastFinalAt) return null;
    if (now - this.lastFinalAt < this.watchdogMs) return null;
    return this._flush('watchdog');
  }

  /** 停止采集 / 语音结束时调用 */
  flush(reason = 'manual') {
    if (!this.pending) return null;
    return this._flush(reason);
  }

  /**
   * 换一个看门狗时长。
   *
   * ⚠️ 分片模式必须调大：它的收句信号是"下一个分片是静音"，要等一整个分片才来。
   * 3 秒的看门狗会把每一片都强行收句 —— 那正好抵消掉"按静音断句"的改动。
   */
  setWatchdogMs(ms) {
    this.watchdogMs = Math.max(500, Number(ms) || 3000);
  }

  reset() {
    this.parts = [];
    this.start = null;
    this.end = null;
    this.lastFinalAt = 0;
  }

  _flush(reason) {
    const text = this.text;
    if (!text) {
      this.reset();
      return null;
    }
    const out = {
      text,
      // 没有时间戳时必须是 undefined：排期那一层用 Number.isFinite 判断，
      // 传 null 会被 Number(null)=0 当成"合法时间戳"，字幕就会排在过去、立刻弹出。
      start: this.start === null ? undefined : this.start,
      duration: this.start === null ? undefined : this.spanSec,
      reason,
    };
    this.reset();
    return out;
  }
}
