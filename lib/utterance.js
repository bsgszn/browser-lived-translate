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
// 四个兜底（少了任何一个都会出现"永远不上屏"或"一条字幕长到没法读"）：
//   · 说话人一直不停顿     → 累积跨度超过 maxSpanSec 就先上屏一次
//   · 服务不给时间戳       → 上面那条算不出来（spanSec 恒为 0）→ 字数超过 maxChars 就上屏
//                            ⚠️ 实测没有它时 60 秒能攒成一条 359 字 ✗
//   · ASR 没发收句信号     → 最后一个分片之后静默超过 watchdogMs 就上屏
//   · 停止采集             → 调用方显式 flush()

export class UtteranceAccumulator {
  /**
   * @param {{maxSpanSec?:number, maxChars?:number, watchdogMs?:number}} opts
   */
  constructor({ maxSpanSec = 15, maxChars = 60, watchdogMs = 3000, watchdogMinChars = 6, watchdogHardMs = 0 } = {}) {
    this.maxSpanSec = Math.max(2, Number(maxSpanSec) || 15);
    /**
     * 累积文本的字数上限 —— **和上面那条秒数上限是一对，缺了它就有个洞**。
     *
     * ⚠️ 为什么必须有：`spanSec` 要求 `start` 与 `end` 都非 null（见 getter），
     *    而**有服务不给时间戳** —— 那时 `spanSec` 恒为 0，`maxSpanSec` 这条兜底**永远不命中** ✗。
     *    实测（探针驱动真源码）：60 秒音频、分片每 1.5 秒一个、都没有时间戳 →
     *    **全部攒成一条 = 359 字**，只有"停止采集"那个手动 flush 才吐得出来 ✗。
     *    也就是说：秒数上限在没时间戳时等于没有，而这条字数上限不看时间戳 ✓。
     *
     * 取值 60 的依据：实测口语速率约 5.4~8.5 字/秒，而 `maxSpanSec` 10 秒 →
     * 有上限时一条最多约 54~85 字；取 60 落在同一量级，两条上限谁先命中都合理 ✓。
     * 下限保护 20：低于这个数会把正常的一句话切断。
     *
     * ⚠️ 这是"**到就吐**"的语义，不是硬顶：判据在分片加进来**之后**看，
     *    而分片不能被切开 → 实际吐出来的一条最长约 = 上限 + **最后一个分片的长度** ✓
     *    （实测：上限 60、每片 7 字 → 最长 63 字 ✓。`maxSpanSec` 也是这个语义。）
     *    重点是它**有界**（对照：没有它时是 359 字、无界 ✗）。
     */
    this.maxChars = Math.max(20, Number(maxChars) || 60);
    this.watchdogMs = Math.max(500, Number(watchdogMs) || 3000);
    /**
     * 看门狗吐字的最短长度 + 硬上限。
     *
     * 为什么不只看时间：实测日志里出现过这个模式 ——
     *   分片 · 1.0s 一句 · 2 字 · 静音 480ms · **先不收，和后面拼**
     *   整句上屏 · 2.9s 后 · 2 字 · **watchdog**          ← 看门狗把它单独吐出来了
     * 断句逻辑刚判断"太小，和后面拼"，看门狗就替它做了相反的决定 ——
     * 而「字幕太碎」是这个项目最早的抱怨。2 字一条字幕基本没法读，还白占一次翻译请求。
     *
     * 为什么"再等等"是安全的：看门狗本来是防"ASR 一直不发收句信号、无限累积"，
     * 而那种情况下**文本一定会变长** —— 说话继续就变长，说话停了自己的静音判据会收句。
     * 只有"很短 + 看门狗到点"这个组合不该吐。
     *
     * ⚠️ 但**必须**有硬上限：不能因为"太短"就永远不吐 ——
     * 那会把真实内容吞掉（「はい」这种 2 字真实回答就是反例）。
     * 过了硬上限一律无条件上屏。
     * 默认 3 倍看门狗；观测量级：看门狗 3s → 硬上限 9s，而画面延迟本来就是 6.6s，
     * 所以这点顺延在延迟画面里吸收得掉。
     */
    this.watchdogMinChars = Math.max(0, Number(watchdogMinChars) || 0);
    this.watchdogHardMs = Math.max(this.watchdogMs, Number(watchdogHardMs) || this.watchdogMs * 3);
    /** 因为"太短"顺延过几次（诊断用；顺延到硬上限就会真的吐） */
    this.deferredCount = 0;
    this.parts = [];
    /** 累积区间，单位秒（相对本次识别的第一帧）。可能为 null = 该服务没给时间戳 */
    this.start = null;
    this.end = null;
    this.lastFinalAt = 0;
    /**
     * 最近一个分片**音频是怎么被切出来的**（`lib/asr/vad.js` 的 `reason`）。
     *
     * 只有 `'max-length'`（到上限硬切）有下游含义：那说明**这句话本来没说完**，
     * 于是排期层可以把紧跟着的那条**很短的尾巴**合并回来。
     *
     * ⚠️ 它和 `_flush(reason)` 那个 reason 是**两层不同的东西**：
     * 那个说的是"谁宣布这句话结束"（utterance-end / speech-final / watchdog / max-span），
     * 这个说的是"音频怎么切的"。所以字段名分开（`cut` vs `reason`）。
     */
    this.lastCut = '';
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
    if (ev?.cut) this.lastCut = String(ev.cut);

    const s = Number(ev?.start);
    const d = Number(ev?.duration);
    if (Number.isFinite(s)) {
      if (this.start === null) this.start = s;
      this.end = Number.isFinite(d) ? s + d : s;
    }
    this.lastFinalAt = now;

    if (this.spanSec >= this.maxSpanSec) return this._flush('max-span');
    /**
     * ⚠️ 字数上限放在**秒数上限之后**判：两条同时命中时报"到时间上限"更贴事实
     *    （秒数上限是主边界，`max-span` 这条语义别动）。
     * ⚠️ 而它**必须存在**，否则没有时间戳时 `spanSec` 恒为 0、上面那条永远不命中 ✗
     *    （见构造器里 `maxChars` 的注释与那条 359 字的实测）。
     */
    if (this.text.length >= this.maxChars) return this._flush('max-chars');
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
    if (ev?.cut) this.lastCut = String(ev.cut);
    if (!this.pending) return null;
    void now;
    /**
     * ⚠️ `soft` 那个来源（`lib/asr/vad.js` 的静默计时器）**不许把短碎片收成一句** ✗
     *
     * 它的判据只看「静音够久」，不看累积器里有多少字 ✗ —— 于是实测出现过:
     *   `分片 · 1.2s 一句 · 1 字 · 静音 480ms · 先不收，和后面拼`   ← 决定是"等后面"
     *   `整句上屏 · 2.2s 后 · 1 字 · utterance-end · 累积 1 片`      ← 而 900ms 后它被单独收了 ✗
     * ⭐ 也就是说:**那个计时器撤销了"先不收"这个决定** ✗
     *    这和 v2.66.29 修掉的「看门狗撤销断句决定」是**同一个形态** ✗
     *
     * 所以这里按长度推迟 ✓ —— 而**推迟有上限**（`deferredCount < 3`）✗:
     *   没有任何上限的话，说话人真停了就永远收不了（那正是 v2.66.29 之前的老问题 ✗）
     * → 3 次之后一定收 ✓，最坏多等 ≈3 个收句静音，仍然有界 ✓
     *
     * ⚠️ 而**硬边界那条路不受影响** ✓ —— 它不带 `soft`，照旧无条件收 ✓
     *    （硬边界 = `flushSpeech` 里 `silenceMs >= utteranceEndMs` 那一处 ✓）
     */
    if (ev?.soft && this.watchdogMinChars > 0
        && this.text.length < this.watchdogMinChars
        && this.deferredCount < 3) {
      this.deferredCount += 1;
      return null;
    }
    // 让诊断面板能看出这一句是被哪个信号收掉的（speech-final 是主边界，utterance-end 是兜底）
    const reason = String(ev?.reason || '') === 'speech_final' ? 'speech-final' : 'utterance-end';
    return this._flush(reason);
  }

  /** 定时调用：ASR 迟迟不发 utteranceEnd 时的兜底 */
  tick(now = Date.now()) {
    if (!this.pending || !this.lastFinalAt) return null;
    const waited = now - this.lastFinalAt;
    if (waited < this.watchdogMs) return null;
    // 太短就先不吐 —— 别撤销断句逻辑"和后面拼"的决定。
    // ⚠️ 但过了硬上限无条件吐：宁可早一点，也不能把真实内容吞掉。
    if (this.watchdogMinChars > 0 && this.text.length < this.watchdogMinChars && waited < this.watchdogHardMs) {
      this.deferredCount += 1;
      return null;
    }
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
    // 硬上限必须跟着走，否则调大看门狗之后硬上限还停在旧值 → 顺延逻辑失效（甚至倒挂）
    if (this.watchdogHardMs < this.watchdogMs) this.watchdogHardMs = this.watchdogMs * 3;
  }

  reset() {
    this.parts = [];
    this.start = null;
    this.end = null;
    this.lastFinalAt = 0;
    this.deferredCount = 0;
    this.lastCut = '';
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
      /** 音频怎么切的（`'max-length'` = 到上限硬切）—— 排期层靠它决定要不要合并短尾巴 */
      cut: this.lastCut || '',
      /**
       * 这一条是**几个分片攒出来的**（1 = 那一段音频本身就有这么长）。
       *
       * ⚠️ 为什么要有它：用户报「有时候句子会很长，好像过度合并了」，而当时的日志
       *    答不出这个问题 —— 因为这两种情况**长得一模一样**：
       *      `44 字 · utterance-end`  那一段音频本身就说得多（**单**个分片）
       *      `99 字 · max-span`        攒到了上限（**好几个**分片）
       *    光看字数和 `reason` 分不清 ✗。补上片数（再配 `duration` 那个实际跨度）才分得清 ✓
       *
       * ⚠️ 必须在 `reset()` **之前**读：那个会把 `parts` 清空。对象字面量是立即求值的，
       *    所以下面那句 `this.reset()` 不会影响这里 ✓
       */
      parts: this.parts.length,
    };
    this.reset();
    return out;
  }
}
