// 统一的配置读写模块。service worker / offscreen / popup / options 共用。

export const ASR_PROVIDERS = [
  {
    id: 'vad',
    label: '本地 VAD 断句 + 本地 Whisper（全本地，延迟最低）',
    hint: '浏览器内跑 Silero VAD 判断"这句说完了"，再把完整的一句交给本地 Whisper。不分片、不联网、免费。',
  },
  {
    /**
     * ⭐ 「本地 Whisper 自断句」—— 和上面同一套引擎、同一批旋钮，**只差断句策略**。
     *
     * 为什么做成独立的一项而不是「vad + 一个勾选框」：
     *   · 那是两条**断句策略**，而下拉本来就是选策略的地方 —— 勾选框叠在下拉上，
     *     会造出"选了 A 而实际跑 B"的可疑状态（本项目为"两份清单不一致"栽过多次）；
     *   · 面板可见性 / 就绪校验 / popup 上的服务名 / `ASR_MODULES` 的推导**全都按 id 走**，
     *     一个 id 只对应一条策略时，这些地方一行都不用改。
     *   · 做成一项之后，**延迟预算也跟着这一项走**（见 `player.js` 的 `effectiveDelaySec`），
     *     不必再靠"勾选框时在运行时抬延迟"那种绕法。
     */
    id: 'vad-segments',
    label: '本地 Whisper 自断句（实验性，更准，延迟约 10 秒）',
    hint:
      '和「本地 VAD 断句」同一套引擎，区别是**断句交给 Whisper 自己**：从上一句的结尾连续取一段音频整段送识别，' +
      '只有离批尾还有余量的段才算说完了、才上屏。好处是不再把词切两半（VAD 切出来的每片都可能是半句开头）；' +
      '⚠️ 代价是字幕晚约 3 秒，**需要把「画面延迟」提到 10 秒左右**（会随这一项自动抬，不会压你设得更大的值）。',
  },
  {
    id: 'deepgram',
    label: 'Deepgram 实时流式',
    hint: '低延迟、浏览器可直连、支持多语种。⚠️ 国内需要代理才能注册和使用。',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 Qwen-ASR（国内直连）',
    hint:
      '国内直连，不需要代理。断句仍在浏览器里做（和「本地 VAD」同一套引擎），' +
      '识别走阿里云的 HTTP 接口 —— 所以**不是流式**，会比流式多一句的延迟，延迟画面模式能盖住。' +
      '需要 DashScope API Key，有免费额度。',
  },
  { id: 'openai-realtime', label: 'OpenAI Realtime 转写', hint: 'gpt-4o-transcribe 流式转写，需 OpenAI API Key。' },
  { id: 'whisper-chunked', label: 'OpenAI Whisper 分片（含本地）', hint: '每 N 秒切一段 POST 到 /audio/transcriptions。可指向本地 faster-whisper / whisper.cpp。' },
];

export const TRANSLATE_PROVIDERS = [
  { id: 'google-free', label: 'Google 翻译（免 Key 通道）', hint: '零配置，质量够用；稳定性依赖 Google 公开端点。' },
  { id: 'openai', label: 'OpenAI Chat Completions', hint: '可自定义提示词，译文更自然，成本略高。' },
  { id: 'deepseek', label: 'DeepSeek', hint: 'OpenAI 兼容接口，价格低很多，中文语感好 —— 长时间挂直播同传比较划算。' },
  { id: 'ollama', label: 'Ollama（本地模型，不需要 Key）', hint: '本机跑，不联网、零成本。需要先在本机跑着 Ollama 并拉过模型。7B 级别的质量不如云端。' },
  {
    id: 'baidu',
    label: '百度翻译（国内直连）',
    hint: '国内直连不需要代理。⚠️ 免费版每秒只能请求一次，同传的中间结果刷新容易撞限流 —— 频繁报错就把「中间结果翻译」关掉。',
  },
  {
    id: 'tencent',
    label: '腾讯云机器翻译（国内直连）',
    hint: '国内直连。每月有免费额度，超出后按字符计费。需要 SecretId / SecretKey，并且**必须填地域**（如 ap-guangzhou）。',
  },
  {
    id: 'ali',
    label: '阿里云机器翻译（国内直连）',
    hint: '国内直连，QPS 50、单次上限 5000 字符，比百度的免费版宽松得多。需要 AccessKeyId / AccessKeySecret。',
  },
  { id: 'deepl', label: 'DeepL', hint: '欧洲语系质量最好，需要 DeepL API Key。' },
  { id: 'none', label: '不翻译（仅显示原文）', hint: '只做语音识别。' },
];

export const TARGET_LANGS = [
  { id: 'zh-CN', label: '简体中文', deepl: 'ZH-HANS' },
  { id: 'zh-TW', label: '繁體中文', deepl: 'ZH-HANT' },
  { id: 'en', label: 'English', deepl: 'EN-US' },
  { id: 'ja', label: '日本語', deepl: 'JA' },
  { id: 'ko', label: '한국어', deepl: 'KO' },
  { id: 'es', label: 'Español', deepl: 'ES' },
  { id: 'fr', label: 'Français', deepl: 'FR' },
  { id: 'de', label: 'Deutsch', deepl: 'DE' },
  { id: 'ru', label: 'Русский', deepl: 'RU' },
  { id: 'pt', label: 'Português', deepl: 'PT-BR' },
  { id: 'it', label: 'Italiano', deepl: 'IT' },
  { id: 'ar', label: 'العربية', deepl: 'AR' },
  { id: 'hi', label: 'हिन्दी', deepl: 'HI' },
  { id: 'th', label: 'ไทย', deepl: 'TH' },
  { id: 'vi', label: 'Tiếng Việt', deepl: 'VI' },
];

export const SOURCE_LANGS = [
  { id: 'auto', label: '自动检测' },
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'ru', label: 'Русский' },
  { id: 'pt', label: 'Português' },
  { id: 'it', label: 'Italiano' },
];

/**
 * ⚠️⚠️ 这两个键名里的 `livedub` **不是品牌名，千万不要"顺手改正"成 `livedtranslate`。**
 *
 * 它们是 `chrome.storage.local` 里的键。键名一改，**所有已安装用户的设置会全部丢失** ——
 * 包括用户自己调了很久的语速档位、AGC 档位、画面延迟、翻译服务与 API Key。
 * 而这些键用户永远看不到，纯属实现细节，所以"统一品牌"在这里没有任何收益，
 * 只有一次静默的数据清空。**项目从 LiveDub 改名为 livedtranslate 时，这两个键刻意保持原样。**
 *
 * 同理不要改的还有 `livedub.runtime` / `livedub.history` / `livedub.playerJob` /
 * `livedub.deeplGlossary`，以及那些不可见的内部标识符（`livedub-pcm` worklet 名、
 * `livedub-overlay-root` DOM id、`--livedub-bg` 等）。
 */
export const STORAGE_KEY = 'livedub.settings';
const VERSION_KEY = 'livedub.settingsVersion';

/**
 * 设置结构版本。
 *
 * 为什么必须有这个东西：getSettings() 是「已保存的设置」盖在默认值上，而弹窗/设置页
 * 只要用户动过任何一个开关，就会把**当时那份完整设置**整体写回 storage。
 * 于是"改默认值"对老用户完全无效——他们本地冻结着旧默认值。
 *
 * 加版本号之后，默认值变更可以通过下面的 MIGRATIONS 安全地推给老用户：
 * 只在该项**仍然等于旧默认值**（说明用户从没主动改过它）时才覆盖。
 */
export const SETTINGS_VERSION = 12;

/**
 * 版本迁移表。键是"要迁移到的版本"。
 * 每条规则是 [设置路径, 旧默认值, 新默认值]。
 */
const MIGRATIONS = {
  2: [
    // v1 的这几个默认值本身有问题：关掉中间结果翻译会让译文等到说话人停顿才出现；
    // smart_format 有官方文档记载的 3 秒定稿挂起。
    ['translate.translateInterim', false, true],
    ['translate.interimMinChars', 10, 4],
    ['translate.interimIntervalMs', 900, 400],
    ['asr.deepgram.endpointing', 300, 120],
    ['asr.deepgram.smartFormat', true, false],
  ],
  4: [
    // 断句的两个阈值原来一个太灵敏、一个太迟钝：
    //   endpointing      120ms  → speech_final 在换气时就触发，把长句切成碎片
    //   utterance_end_ms 1000ms → 句间停顿常常只有 300~700ms，两句不相干的话被并成一条
    //
    // 而 utterance_end_ms 的 **Deepgram 最小值就是 1000**，调不下去。
    // 所以真正能用的旋钮是 endpointing：把它抬到"句间停顿"的量级，
    // 让 speech_final 落在句子边界上，utterance_end_ms 退居兜底。
    //
    // 这一条只会在用户从没主动改过它（仍等于 120）时才生效。
    ['asr.deepgram.endpointing', 120, 500],
  ],
  6: [
    /**
     * ⚠️ 这一条是补的，而且是**严重漏项**。
     *
     * v2.45.0 把 `capture.delayBitsPerSecond` 的默认值从 4000000 改成了 0
     * （0 = 按画面尺寸自动估），但当时没有加迁移、也没升 SETTINGS_VERSION。
     * 而 getSettings() 是"已存设置盖在默认值上" —— 于是**老用户 storage 里那个
     * 4000000 永远赢**：自动码率分支永不执行，画质档位（省资源/标准/高画质/极致）
     * 对老用户**完全无效，码率恒为 4 Mbps**。
     *
     * 这就是"码率明明调高了、运动画面还是糊"的真相 —— 那次修复从没到达过老用户。
     *
     * 沿用既有机制：只有当用户从没主动改过这一项（仍等于旧默认值 4000000）时才覆盖。
     * 手动填过具体码率的人不会被碰。
     */
    ['capture.delayBitsPerSecond', 4000000, 0],
  ],
  8: [
  /**
   * v2.66.74：本地 Whisper 的默认地址从 **8000** 改到 **8080**。
   *
   * 为什么改：项目主推的那条路是 whisper.cpp，而 `启动本地字幕服务.bat` 里
   * `set PORT=8080` —— 用主推路线的人**每一次新装都要手动把 8000 改成 8080**。
   * 8000 是 README 里那条**备选**路线（faster-whisper-server）的默认端口，
   * 也就是说原来的默认值站在备选那边。
   *
   * 沿用既有机制：只在该项**仍等于旧默认值**时才覆盖。手动填过 8000（或别的地址）的人
   * 如果填的就是这个字符串，会被一起改掉 —— 这是既有机制的固有代价，
   * 而"手动填了 8000 且真的在跑 faster-whisper-server"属于少数，改完在设置页能看到地址。
   */
  ['asr.whisperChunked.baseUrl', 'http://127.0.0.1:8000/v1', 'http://127.0.0.1:8080/v1'],
  ],
  9: [
  /**
   * v2.66.78：本地 VAD 的三个断句参数一起改默认值 —— 让**新装的人**一上来就是
   * 「句子完整」那一档，而不是先看到碎字幕再自己去调。
   *
   * | 参数 | 旧默认 | 新默认 | 为什么 |
   * |---|---|---|---|
   * | 静音确认 | 450ms | **600ms** | 见下面 A/B/C 实测 |
   * | 单句上限 | 5s | **6s** | 上限那一刀是按时间切的，5 秒太密 → 切点更少 |
   * | 前后留白 | 200ms | **400ms** | 切在音节中间会吃掉开头的字，而 200ms 只够一个音节 |
   *
   * ⭐ 600 这个数是**测出来的拐点**，不是拍的（闭环 A/B/C，同一素材，每组 ≥40 片）：
   *   · 450 → 600：整句中位字数 **18 → 27（+50%）**、min 4 → 7、p25 13 → 16、
   *     ≥8 字整句占比 93% → 97% ✓
   *     代价：识别滞后中位 3.5 → 4.4s（+0.9s），而 **max 反而 9.6 → 8.6**（更稳）
   *   · 600 → 750：**没有进一步改善**（中位 27 → 27、min 7 → 5）⇒ **600 是拐点**
   *
   * ⭐ 而「留白 200 → 400」来自真机现场：
   *   `分片 · 5.2s（超长被切断）· 静音 0ms` —— 切在语音中间；
   *   于是「ネコの真似」被切成两半、线上认成「この場」；
   *   「徴用の節句」被切成三片、线上认成「蝶用」/「石窟」/「セックス」。
   *   设置页那一项原本就写着「切在音节中间会让识别丢掉开头的字」—— 只是 200ms 不够。
   *
   * ⚠️ 三个数**分不出**「用户没动过」和「用户正好选了旧默认值」——
   *    沿用既有机制（等于旧默认才改），代价是"恰好选了 450/5/200 的人会被一起改"。
   *    这里接受这个代价：收益（句子完整度 +50%）明确大于"少数人需要重新调一次"。
   *    对照 `language: 'en'` 那次的**不做**迁移 —— 那次是"分不出默认值和真实选择"且收益不明，
   *    两者判据不同，别照抄。
   */
  ['asr.vad.vadMinSilenceMs', 450, 600],
  ['asr.vad.vadMaxSpeechSec', 5, 6],
  ['asr.vad.vadPadMs', 200, 400],
  ],
  10: [
  /**
   * v2.66.79：「合理断句」的默认值从**开**改成**关**。
   *
   * 为什么：闭环 A/B 实测证明它得不偿失 —— 它确实在挪切点（`已挪到换气处` 0 → 10 次），
   * 但整句中位字数 **22 → 18**（更碎）、`≤4 字整句` **0 → 2**、整句最短 **6 → 4**；
   * 而它想治的 0.2 秒短尾巴**一条都没减少（2 → 2）**。
   * 用户反复抱怨的正是「句子很碎」，所以默认值不该站在更碎那边。
   *
   * ⚠️ 判据仍是「等于旧默认值才改」（`true → false`），而它**分不出**
   *    「用户没动过」和「用户自己打开过」—— 后者会被一起改成关。
   *    接受这个代价：A/B 数据说明开着更差，而设置页那一项用户随时能再打开。
   *    对照 `language: 'en'` 那次的**不做**迁移 —— 那次分不出「默认值和真实选择」
   *    且收益不明；这次收益明确（少一些碎句），所以做。两者判据不同，别照抄。
   */
  ['asr.vad.vadSmartCut', true, false],
  ],
  11: [
  /**
   * v2.66.81：内置「直播热词」的默认值从**开**改回**关**。
   *
   * 为什么：v2.66.80 加它时以为"它只占原本空着的 prompt 额度，不动用户的东西"——
   * **那个理由是错的**。同一段音频、只改 prompt 一个变量的四组对照：
   *
   *    窗口 5.6s → 无 prompt **22 字** / 带热词 prompt **7 字**
   *    窗口 3.6s → 13 字 / 7 字
   *    窗口 6.6s → **27 字** / 7 字
   *    窗口 5.6s（后移 0.8s）→ 19 字 / **5 字**
   *
   * 机制：带 prompt 之后 `no_speech_prob` 从 **0.93 → 0.01**（模型过度自信），
   * 识别段数 **3 → 1**（认一小段就停），而停的位置恰好落在热词附近。
   * ⇒ **每段少认一半以上的字**，用户看到的就是"丢句 / 句子碎 / 认错"。
   *
   * ⚠️ 判据是「等于旧默认值才改」（`true → false`）。而这次比 `vadSmartCut` 那次更安全：
   *    那个开关上线了近一天，而**这个字段上线不到一天** ⇒ 「用户主动打开过」几乎不可能。
   *    对照 `language: 'en'` 那次的**不做**迁移 —— 那次分不出默认值和真实选择；
   *    这次上线时间极短、收益明确（认得更全），所以做。两者判据不同，别照抄。
   */
  ['asr.whisperChunked.liveHotwords', true, false],
  ],
};

/**
 * 需要搬动位置 / 删除键的迁移用函数写。
 * 三元的 [路径, 旧值, 新值] 表达不了这两件事。
 */
const CUSTOM_MIGRATIONS = {
  /**
   * v2.66.82：「让 Whisper 自己断句」从**一个勾选框**搬成**识别服务下拉里的一整项**。
   *
   * 为什么搬：勾选框叠在下拉上会造出"选了 A 而实际跑 B"的可疑状态 ——
   * 而断句策略本来就该由下拉决定（面板可见性 / 就绪校验 / popup 服务名全都按 id 走）。
   *
   * ⚠️ 判据是"**provider 还是 vad** 且 `whisperSegments === true`"：
   *    只改真正勾过它的人。没勾过的人（绝大多数）一个字节都不动 ✓
   * ⚠️ 搬完把旧开关**清回 false** —— 否则用户切回「本地 VAD 断句」时
   *    那个残留的 true 会让新路重新生效，而界面上已经没有任何东西显示它是开的。
   *    这正是本项目反复吃的那个"有设置没控件"的坑。
   */
  12: (s) => {
    const provider = getByPath(s, 'asr.provider');
    const flagOn = getByPath(s, 'asr.whisperChunked.whisperSegments') === true;
    if (provider === 'vad' && flagOn) {
      setByPath(s, 'asr.provider', 'vad-segments');
    }
    setByPath(s, 'asr.whisperChunked.whisperSegments', false);
    return s;
  },
  3: (s) => {
    // 术语表原来只对 OpenAI 生效（translate.openai.glossary），现在提升为全局 translate.glossary
    const legacy = getByPath(s, 'translate.openai.glossary');
    if (legacy && !getByPath(s, 'translate.glossary')) {
      setByPath(s, 'translate.glossary', legacy);
    }
    if (getByPath(s, 'translate.openai.glossary') !== undefined) {
      delete s.translate.openai.glossary;
    }
    return s;
  },
  5: (s) => {
    // 「翻译预留」旋钮已删除 —— 改成固定规则（上屏前 TRANSLATE_WINDOW_MS 开始翻译，
    // 实测翻译更慢时自动往前让路）。老用户存的那个键留着没用，清掉。
    if (s.capture && 'translateLeadMs' in s.capture) delete s.capture.translateLeadMs;
    return s;
  },
  8: (s) => {
    /**
     * v2.66.74：默认识别服务从 **deepgram** 改成 **vad**（本地 VAD，不需要任何 Key）。
     *
     * 为什么：新装的人一启动就是「启动失败 · Deepgram API Key 未配置」——
     * 整条音频管线根本起不来（连 VAD 都不跑）。而 Deepgram 在国内要代理才能注册，
     * 也就是说**默认值把大部分人挡在门外**，而本地 VAD 那条路零成本、零 Key。
     *
     * ⚠️ 这里**不能用 MIGRATIONS 的"等于旧默认值就改"**：
     *    真正在用 Deepgram 的人，其 `asr.provider` 恰好也等于 `deepgram` ——
     *    那样会把他们**从能用的服务上踢下来**。
     * 所以判据是"provider 是 deepgram **且** 没有配 apiKey"：
     *    · 配了 Key 的人 → 一个字节都不动 ✓
     *    · 没配 Key 的人（本来就跑不起来）→ 换成本地 VAD ✓
     */
    if (getByPath(s, 'asr.provider') !== 'deepgram') return s;
    const dgKey = String(getByPath(s, 'asr.deepgram.apiKey') || '').trim();
    if (dgKey) return s;
    setByPath(s, 'asr.provider', 'vad');
    return s;
  },
  7: (s) => {
    /**
     * 清掉 `asr.dashscope.endpoint` 里的**陈旧默认值**。
     *
     * ⚠️⚠️ 这是本项目**同一个 bug 类的第三次**(前两次:delayBitsPerSecond 改了默认值没加迁移;
     * 那次是"画质档位对老用户完全无效、码率恒为 4 Mbps")。
     *
     * 经过:`endpoint` 的默认值一度是**兼容端点 URL**,那时它会被写进 storage;
     * 后来改成 `''`(留空 = 用自动选择),但 `getSettings()` 是"已存值盖在默认值上" ——
     * **老用户 storage 里那个 URL 永远赢**,于是自动选择永远轮不到,
     * 用户填 `qwen-audio-3.1-asr-flash` 却被发去兼容端点,服务端回
     * 404 `Unsupported model … for OpenAI compatibility mode`。
     *
     * 代码侧已经改成「等于内置地址的 endpoint 一律当作没填」(见 vad.js 的
     * `resolveDashscopeEndpoint`),**所以这条迁移只是为了把脏数据扫干净**,
     * 不是正确性的唯一依赖 —— 这是刻意的:迁移只对"从没跑过新版代码"的那份 storage 生效。
     *
     * 安全性:`endpoint` **只**在两个内置地址被清掉。用户自己填的**业务空间专属域名**
     * (形如 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/…`)**不会**被碰。
     */
    const BUILTIN = [
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    ];
    const cur = getByPath(s, 'asr.dashscope.endpoint');
    if (typeof cur === 'string' && BUILTIN.includes(cur.trim())) {
      setByPath(s, 'asr.dashscope.endpoint', '');
    }
    return s;
  },
};

/**
 * 延迟 / 准确度预设。
 * 同传里"快"和"稳"基本是同一个按钮的两面，散在六个设置项里用户很难自己权衡，
 * 所以给三个预设一键切换；任何一项被手动改过就显示为"自定义"。
 */
/**
 * **语速档位**：断句参数跟语速强相关，而"这人说话快不快"用户一眼就知道，
 * 比让他去猜「静音确认该填 300 还是 600」直观得多。
 *
 * 两档的差别，以及为什么：
 *
 * | 参数 | 正常语速 | 快语速 | 为什么 |
 * |---|---|---|---|
 * | 静音确认（软边界） | 600ms | **300ms** | 快语速的停顿本来就短（200~400ms），门槛 600ms 时**这些停顿一个都不算数** → 句子越并越长 |
 * | 一句最长 | 6s | **3.5s** | 每秒字数更多，同样 6 秒会攒出 50 字上下（实测 6.1s/52字、8.5s/46字），**读不完** |
 * | 前后留白 | 400ms | **500ms** | 快语速下更容易切在音节中间，多留一点 |
 *
 * ⚠️ 「正常语速」这一档的数值**必须和 `DEFAULT_SETTINGS.asr.vad` 逐字一致** ——
 *    否则全新用户不落在 `normal` 档（smoke-test 有一条断言钉着这个）。
 *
 * 选档位会把对应数值写进那几个旋钮（用和延迟预设同一套机制），
 * **之后仍然可以单独微调任何一个** —— 档位只是给一组合理的起点。
 */
export const VAD_RATE_PRESETS = [
  {
    id: 'normal',
    label: '正常语速',
    hint: '默认。停顿比较明显，静音 600ms 就算一句说完，一句最长 6 秒。',
    values: {
      'asr.vad.vadMinSilenceMs': 600,
      'asr.vad.vadMaxSpeechSec': 6,
      'asr.vad.vadPadMs': 400,
    },
  },
  {
    id: 'fast',
    label: '快语速（主播说话快 / 连珠炮）',
    hint:
      '停顿更短、每秒字数更多。静音门槛降到 300ms（不然那些短停顿一个都不算，句子会越并越长），' +
      '一句最长收到 3.5 秒（快语速下 6 秒能攒出 50 多字，读不完），留白多给 100ms。',
    values: {
      'asr.vad.vadMinSilenceMs': 300,
      'asr.vad.vadMaxSpeechSec': 3.5,
      'asr.vad.vadPadMs': 500,
    },
  },
];

/** 把语速档位写进设置。用和延迟预设一样的 setByPath 机制。 */
export function applyVadRate(settings, rateId) {
  const preset = VAD_RATE_PRESETS.find((p) => p.id === rateId);
  if (!preset) return settings;
  for (const [path, value] of Object.entries(preset.values)) setByPath(settings, path, value);
  return settings;
}

/** 当前设置匹配哪个语速档位；都不匹配返回 'custom'（用户自己微调过） */
export function detectVadRate(settings) {
  for (const preset of VAD_RATE_PRESETS) {
    const match = Object.entries(preset.values).every(([path, value]) => getByPath(settings, path) === value);
    if (match) return preset.id;
  }
  return 'custom';
}

export const LATENCY_PRESETS = [
  {
    /**
     * 「推荐」= 作者本人在用的那套：**全本地 + 延迟模式**。
     *
     * 为什么它值得单独一个预设：这套组合是踩了几十轮坑才定下来的 ——
     * 本地 VAD 定轴（比固定分片的分句准得多）、本地 Whisper 定文本、
     * 延迟画面把"等识别"的时间藏起来、关闭变速纠偏（那会让画面抖）。
     * 全本地还意味着**零 API 成本、音频不出本机**。
     *
     * ⚠️ 用这个预设前需要本机有个 Whisper 服务（默认地址见下），
     * 以及一个 DeepL API Key；两者缺一个都会启动失败。
     */
    id: 'recommended',
    label: '推荐（本地模型 + 延迟画面）',
    hint:
      '本地 VAD 定轴 + 本地 Whisper 识别 + DeepL 翻译 + 延迟画面。断句最准、音频不出本机、识别零成本。' +
      '前提：本机要跑一个 Whisper 服务（默认 http://127.0.0.1:8080/v1），并且配好 DeepL API Key。',
    /**
     * ⚠️ 有 `warn` 的预设，套用前必须先弹确认。
     *
     * 为什么：这个预设装的是**整套方案**（识别服务、音频语言、翻译服务、目标语言、
     * 呈现方式、画面延迟），而不是像 speed/balanced/accuracy 那样只动延迟旋钮。
     * 一个看英文直播、用 Google 免 Key 翻译、叠加模式的用户，如果顺手点了下拉里
     * 排在第一位、又写着「推荐」的这一项，会在毫不知情的情况下：
     *   音频语言变成日语 → 英文被当日语识别
     *   翻译服务变成 DeepL → 他没配 Key → 所有翻译静默失败
     *   呈现方式变成延迟模式 → 新开标签页、原页面被静音
     * 而 change 处理器是"改完立刻写盘"，连保存按钮都不用点。所以必须有确认。
     */
    warn:
      '「推荐」装的是完整方案，会改掉这些设置：\n\n' +
      '· 识别服务 → 本地 VAD 断句 + Whisper\n' +
      '· 音频语言 → 日语\n' +
      '· 服务地址 → http://127.0.0.1:8080/v1\n' +
      '· 翻译服务 → DeepL（需要 API Key）\n' +
      '· 目标语言 → 简体中文\n' +
      '· 呈现方式 → 延迟画面，推迟 6.6 秒\n' +
      '· 画质 → 高画质、60fps\n' +
      '\n套用后会立即保存。确定要改吗？',
    values: {
      // 识别：本地 VAD 定轴 + 本地 Whisper 出文本
      'asr.provider': 'vad',
      'asr.language': 'ja',
      'asr.whisperChunked.baseUrl': 'http://127.0.0.1:8080/v1',
      // VAD 自己就是"重新识别一遍"的那条路，再叠加校正等于白跑一趟
      'asr.refine.enabled': false,
      // 呈现：延迟模式，把等识别的时间藏进画面延迟里
      'capture.mode': 'delayed',
      'capture.delaySec': 6.6,
      // 变速纠偏会周期性重建时间伸缩器，画面会抖 —— 关掉，延迟漂移由排期补偿
      'capture.smoothRate': false,
      // 画质：4K 下 0.26 bpp，运动画面才不糊
      'capture.delayQuality': 'high',
      'capture.maxFrameRate': 60,
      // 翻译
      'translate.provider': 'deepl',
      'translate.target': 'zh-CN',
    },
  },
  {
    id: 'speed',
    label: '速度优先（默认，适合直播）',
    hint: '中间结果一出现就翻译。字幕几乎立刻可见，代价是译文会随识别修正而刷新。',
    values: {
      'translate.translateInterim': true,
      'translate.interimMinChars': 4,
      'translate.interimIntervalMs': 400,
      'translate.contextSegments': 2,
      'asr.deepgram.endpointing': 500,
      'asr.deepgram.smartFormat': false,
    },
  },
  {
    id: 'balanced',
    label: '均衡',
    hint: '稍微等文本长一点再翻译，译文跳动更少，延迟比"速度优先"多约 0.3–0.5 秒。',
    values: {
      'translate.translateInterim': true,
      'translate.interimMinChars': 6,
      'translate.interimIntervalMs': 600,
      'translate.contextSegments': 2,
      'asr.deepgram.endpointing': 650,
      'asr.deepgram.smartFormat': false,
    },
  },
  {
    id: 'accuracy',
    label: '准确优先（字幕会明显滞后）',
    hint: '只在句子定稿后翻译一次，译文最稳不跳动；并且开启 smart_format 做数字/日期格式化（官方说明它可能让定稿多等最多 3 秒）。',
    values: {
      'translate.translateInterim': false,
      'translate.interimMinChars': 10,
      'translate.interimIntervalMs': 900,
      'translate.contextSegments': 3,
      'asr.deepgram.endpointing': 800,
      'asr.deepgram.smartFormat': true,
    },
  },
];

export const DEFAULT_PRESET = 'speed';

function setByPath(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

function getByPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** 把某个预设套用到设置对象上（原地修改并返回） */
export function applyPreset(settings, presetId) {
  const preset = LATENCY_PRESETS.find((p) => p.id === presetId);
  if (!preset) return settings;
  for (const [path, value] of Object.entries(preset.values)) setByPath(settings, path, value);
  return settings;
}

/** 当前设置匹配哪个预设，都不匹配则返回 'custom' */
export function detectPreset(settings) {
  for (const preset of LATENCY_PRESETS) {
    const match = Object.entries(preset.values).every(([path, value]) => getByPath(settings, path) === value);
    if (match) return preset.id;
  }
  return 'custom';
}

/**
 * 当前设置更像哪个预设 —— 给下拉框显示用，比 detectPreset 更"懂事"。
 *
 * ⚠️ 为什么需要单独一个：预设现在分两类，回答的是**不同的问题**。
 *   `speed` / `balanced` / `accuracy` 只管延迟旋钮（翻译时机、Deepgram 断句门槛）
 *   `recommended` 装的是整套方案（识别服务、语言、呈现方式、画质、翻译服务）
 * `detectPreset` 按顺序取第一个完全匹配，于是实测出现：
 *   用户套用了「推荐」之后只把翻译服务改回 Google 免 Key →
 *   下拉显示成「**速度优先**」，而那个标签描述的是延迟旋钮，跟他实际的选择毫无关系。
 * 这里补一条：要落到延迟类预设，得先确认"整套方案"那些键还在**默认值**上；
 * 否则老实显示「自定义」。
 */
export function detectPresetForUi(settings) {
  const rec = LATENCY_PRESETS.find((p) => p.id === 'recommended');
  const latency = LATENCY_PRESETS.filter((p) => p.id !== 'recommended');
  // 延迟类预设共有的那些键，不算在"整套方案"里
  const latencyKeys = new Set(latency.flatMap((p) => Object.keys(p.values)));
  const setupKeys = rec ? Object.keys(rec.values).filter((k) => !latencyKeys.has(k)) : [];
  const setupIsDefault = setupKeys.every((k) => getByPath(settings, k) === getByPath(DEFAULT_SETTINGS, k));

  if (rec && Object.entries(rec.values).every(([k, v]) => getByPath(settings, k) === v)) return 'recommended';
  if (!setupIsDefault) return 'custom';
  for (const preset of latency) {
    if (Object.entries(preset.values).every(([path, value]) => getByPath(settings, path) === value)) return preset.id;
  }
  return 'custom';
}

export const DEFAULT_SETTINGS = {
  asr: {
    provider: 'vad',
    /**
     * ⚠️ 默认 `ja`，和 `LATENCY_PRESETS` 里的那一份**必须一致**。
     *
     * 这里曾经是 `'en'`，而预设里是 `'ja'` —— 于是**新 profile 一启动就用英语识别**，
     * 日语视频全部认错：实测「お札とかもあるよ」被认成「マリオ」、
     * 「ご利益」被认成「ゴリ役」。而这两处错**看起来像模型问题**，不像配置问题 ——
     * 所以它错了很久没人发现。
     *
     * ⚠️ **不做迁移**：已装用户存着的 `'en'` 保持不动。
     * 因为这里**分不出**「是默认值」还是「非日语用户真的选过 en」✗ ——
     * 而 `provider` / `baseUrl` 那两个能证明是旧默认值（旧值本身就是错的组合），
     * 所以那两个做了迁移，这个不做。
     */
    language: 'ja',
    /**
     * 强制断句上限：一段中间结果活过这么久还没定稿，就按当前文本定稿。
     * 说话人长时间不停顿时，识别服务可能一直不给 is_final，字幕就会无限长、
     * 而且拿不到干净译文。这个上限保证最坏情况下的延迟和行长可控。
     */
    maxSegmentMs: 10000,
    /**
     * 识别校正（流式定时间轴 + 本地模型定文本）。
     *
     * 延迟模式手里还留着音频，可以拿它**重新用非流式接口识别一遍**：
     * 流式识别的时间戳决定字幕什么时候上屏，重识别的文本决定字幕写什么。
     * 分工固定，所以重识别失败 / 超时 / 没配都不会动到字幕的时序。
     *
     * ⚠️ **默认关**，要显式打开。原因：重识别走 asr.whisperChunked.baseUrl，
     * 而它默认指向 127.0.0.1:8080（v2.66.74 起；之前是 8000）—— 没在本地跑那个服务的人，一旦默认打开，
     * 每一句都会往那儿打一次空请求。这个坑在 v1.9.1 真的踩过，整个功能因此被回退。
     */
    refine: {
      enabled: false,
      /** auto = 跟着流式识别的服务商走（deepgram 流式就配 deepgram，其余配 whisper） */
      provider: 'auto',
      /** 留空则沿用流式那边的模型 */
      model: '',
      /** 留空则沿用 asr.language */
      language: '',
      /**
       * 重识别的提示词（可选，**默认空**）。
       *
       * ⚠️ 实测：prompt 更容易把 Whisper 带偏，而不是帮它听准。同一段真实日语：
       *   不加           → 「そうなんだよね / ティールで一瞬で流れたりするからね / あれピンクと黒の髪の毛の色はあれひなのじゃん」全对
       *   加日文相关词   → 丢掉第一句，还把「ひなの」听成「ひなうの」
       *   加一堵英文术语 → 严重损坏（那正是旧版把 translate.glossary 拼进来的后果）
       * 所以默认不发。只有真有一批专有名词反复听错时才填，而且**只填那一批**。
       */
      prompt: '',
    },
    deepgram: {
      apiKey: '',
      endpoint: 'wss://api.deepgram.com/v1/listen',
      model: 'nova-3',
      interim: true,
      /**
       * 默认关闭。Deepgram 官方文档说明：流式场景下 smart_format 遇到"疑似不完整的实体"
       * （数字、日期、货币等）会等说话人继续说，否则**静默 3 秒后才强制定稿**。
       * 对我们这种逐句翻译的管线来说，3 秒的定稿延迟是致命的。
       * 关掉它只损失数字/日期格式化，标点仍然由 punctuate=true 提供。
       */
      smartFormat: false,
      /**
       * 断句静音阈值：说话人安静超过这么久，Deepgram 才发出 UtteranceEnd 事件。
       *
       * ⚠️ **这个值是 Deepgram 的硬下限（最小 1000ms）**，调不下去。
       * 想控制"一句有多长"要调下面的 endpointing，不是这个。
       * 它在这里的作用退居**兜底**：万一 speech_final 没发，还有它。
       */
      utteranceEndMs: 1000,
      /**
       * 「说完了」的静音阈值 —— **延迟模式的句子边界就是它**。
       *
       * Deepgram 安静超过这么久就置 speech_final，我们据此收句整句上屏。
       *   调大 → 句子更长更完整，但**可能把两句不相干的话并成一条**
       *   调小 → 更容易断开，但可能在换气处切成碎片
       * 句间停顿通常 300~700ms，句中换气通常 100~250ms，所以 500ms 是折中。
       * 叠加模式也用它（那里没有延迟预算，想更快可以调小）。
       */
      endpointing: 500,
      keyterms: '',
    },
    openaiRealtime: {
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-transcribe',
      turnDetection: 'server_vad',
      silenceDurationMs: 500,
      prompt: '',
      useAsrKeyFromChunked: false,
    },
    whisperChunked: {
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '',
      model: 'whisper-1',
      /**
       * ⚠️ 这个值直接决定「识别滞后」，而识别滞后超过「画面延迟」时字幕必然迟到。
       *
       *   识别滞后 ≈ 分片时长 × 2 + 推理时间
       *
       * 为什么要乘 2：
       *   ① 第一个分片要攒满才送出去（这段音频已经过去一整个分片）
       *   ② 片尾那句要等**下一个分片**才能判断它是说完了还是跨片
       *     （这个判断是治「两句并成一句」的，不能去掉，但代价是一个分片）
       *
       *   分片 5s → 滞后 ≈ 10.6s   （原来就是这个值，延迟 6.6s 完全盖不住）
       *   分片 2s → 滞后 ≈  4.6s   ✓ 留出余量
       *
       * 分片变短**不会让字幕变碎**：跨片判断会把它们拼起来，
       * 而且识别校正本来就会把整句的音频重新听一遍。
       */
      chunkSeconds: 2,
      prompt: '',
      /**
       * 识别热词（本地 Whisper 专用，**默认空**）。
       *
       * 为什么和「提示词」分成两个框：
       *   · 提示词是**散文**（"日语直播、说话快、有底噪"），写长会把识别带偏
       *   · 热词是**词表**（配信 / スパチャ / 切り抜き），只放反复听错的那些
       * 两者拼在一起发给 Whisper（拼装逻辑见 `lib/asr/vad.js` 的 `buildWhisperPrompt`），
       * 总长有上限（140 字符）—— Whisper 只用 prompt 的末尾 224 token，写长了前面会被截掉。
       *
       * ⚠️ 别往这里贴整段术语表：项目实测过，一堵英文术语会把识别**严重带偏**。
       */
      hotwords: '',
      /**
       * 内置「直播热词」并入识别热词（**默认关** —— v2.66.81 从"开"改回"关"）。
       *
       * 词表在 `lib/hotwords/ja-live.js`（146 个日语直播/VTuber 行话，一行一个）。
       *
       * 🔴 v2.66.80 曾经默认打开，理由是"它只占原本空着的 prompt 额度、不动用户的东西"。
       *    **那个理由是错的** —— 实测（同一段音频、只改 prompt 一个变量、四段不同窗口）：
       *
       *      | 窗口 | 无 prompt | 带 20 词热词 prompt |
       *      | 5.6s | **22 字** | **7 字** |
       *      | 3.6s | 13 字      | 7 字      |
       *      | 6.6s | **27 字** | 7 字      |
       *      | 5.6s（后移 0.8s） | 19 字 | **5 字** |
       *
       *    机制：带 prompt 之后 `no_speech_prob` 从 **0.93 → 0.01**（模型变得过度自信），
       *    识别段数 **3 → 1**（认一小段就停），而**停的位置恰好落在热词附近** ——
       *    「リスナーを守る / 守るっていうのもあるし」只剩「リスナーを守る」7 个字。
       *    ⇒ **每段少认一半以上的字**，而用户看到的正是"丢句 / 句子碎 / 认错"。
       *
       * ⚠️ 所以热词 prompt 不是"免费的额度占用"，它会**改变解码行为**。
       *    默认值必须站在"认得全"这一边；想用的人可以自己打开（设置页那一项保留）。
       *
       * ⚠️ 与「术语表源词」不是同一件事（那个 v2.66.80 已按用户要求删掉）：
       *    术语表是**翻译**用的词表，词多且杂（`support=辅助` 也在里面），整表塞进 prompt
       *    会把识别严重带偏（项目实测过：一堵英文术语）。内置直播词是人工挑的短日文词 ——
       *    但即便如此，它对解码的影响依然是负面的。
       */
      liveHotwords: false,
      /**
       * 新的断句架构：**Whisper 先断句，VAD 只做静音确认**（实验性）。
       *
       * 现在的路是「VAD 先切，再逐片送 Whisper」——
       * 而 VAD 切出来的每片都可能是**半句开头**，于是 Whisper 每片各认一遍：
       *   · 「**ネコ**の真似」被切成两半 → 认成「この場」
       *   · 「また**コックスプレッシャー**だと」被切成三片 → 认成「蝶用」「石窟」「セックス」
       *   · 「だから」两轮都缺 —— 它正好落在硬切边界上
       *
       * 新路反过来：
       *   ① 从「上一个已采纳句子的 end」起，**连续**取一段原始 PCM（不拼碎片）
       *   ② 整段送 Whisper，拿它自己的 `segments` 边界
       *   ③ 每段离批尾还有余量 ⇒ 这句真说完了 ⇒ 采纳上屏
       *      贴在批尾的 ⇒ 可能是被批长截断的半句 ⇒ 不采纳，下一批从它的 `start` **连续重采**
       *   ④ 一直没采纳（会超排期）⇒ 兜底：强制采纳 Whisper 最后一个 segment 的 end
       *
       * ⚠️ **代价：字幕会晚约 3 秒**（约 7 秒 → 约 10 秒）—— 首批音频更长。
       *    所以「画面延迟」要能设到 10 秒以上（滑块与 `DELAY_MAX_SEC` 都已放开到 20）。
       * ⚠️ **已知限制：生僻专有名词仍认不准** —— 实测「コックスプレッシャー」这类
       *    需要约 14 秒的批长才认对，而那时延迟得 ≈18 秒。日常句子不受影响
       *    （「だから」「めっちゃ悩むの」在 6~12 秒批长下就对了）。
       *
       * ⭐ **这个开关现在只是"兼容旧数据"的第二个入口**：正常路径是选
       *    「识别服务 → 本地 Whisper 自断句」，那由 `lib/asr/vad-segments.js` 强制打开。
       *    v2.66.82 的迁移会把"勾过这个框"的老用户搬到那个下拉项上并把它清回 false ——
       *    所以它默认 false 且**界面上没有控件**（有设置没控件 = 用户看不见自己在跑什么）。
       */
      whisperSegments: false,
      silenceThreshold: 0.006,
      skipSilence: true,
      /**
       * 词与词之间静多久算"一句话说完了"（秒）。
       *
       * 这是断句灵敏度的总开关：
       *   调小 → 句子更短、更容易断（半句就切的风险）
       *   调大 → 更少断、句子更长（两句并成一句）
       * 默认 0.25 —— 日语的自然停顿比英语短，0.35 实测偏长，短句会被并起来。
       */
      pauseSec: 0.25,
    },
    /**
     * ⭐⭐ **「本地 Whisper 自断句」自己的四个旋钮**（v2.66.84）
     *
     * 🔴 为什么要有这一组：在这之前，那一栏里的 **9 个 VAD 旋钮对新路一个都不生效** ——
     *    `lib/asr/vad.js` 的 `if (segmentLoop) return;` 之后读的设置全被跳过，
     *    而 9 项里 5 项完全无效、3 项只影响音频裁剪、**0 项能调新路的实际行为**。
     *    同时新路的 14 个常量在 `settings.js` 里**出现 0 次** ⇒
     *    用户选中新路后看到 9 个控件、一个都调不动它（**UI 谎言** ✗）。
     *
     * ⚠️ **为什么单独一组、而不是塞进 `whisperChunked`**：
     *    那些键属于「本地 Whisper 分片」那个面板，而这一组属于「本地 Whisper 自断句」。
     *    塞错组的话 `smoke-test` 那条「面板里的设置项，键必须属于那个面板的 provider」会红 ✓
     *    —— 而它红得对：键在 A 组、控件在 B 面板 = 选别的服务就看不见它，而它照样生效 ✗
     *
     * ⭐ 而下面这五个**正好对应使用者抱怨的五件事**：
     *    | 抱怨 | 旋钮 |
     *    | 延迟太大 | `maxBatchSec`（上限）/ `continueBatchSec`（续批） |
     *    | 短句/语气词被丢 | `maxAvgWordSec` |
     *    | 句子碎 | `pauseSplitMinSegSec` |
     *    | 字幕提前 | `segStartAnchor` |
     *
     * ⭐ **v2.67.0：默认值逐字等于原来硬编码的值**（8 / 5 / 1.9 / 2.5 / false）——
     *    那时"加旋钮不许顺手改默认行为" ★
     *
     * 🔴 **v2.67.1 起，这一组是"产品默认"，可以有意识地改**（见下面两处）：
     *    · `continueBatchSec` 5 → **4**（批更短 ⇒ 字幕更跟手）
     *    · `pauseSplitMinSegSec` 2.5 → **4**（少切 ⇒ 句子更整）
     *
     * ⚠️ 而"改默认"必须**成对**成立，否则又回到"两份真相" ✗（`smoke-test.mjs` 钉住）：
     *    ① 这里的默认值 === `vad.js` 里 `?? N` 的兜底
     *       —— 否则用户配置坏掉时会**退回旧值**，而设置页显示的是新值 ✗
     *    ② 模块常量仍是**历史值**（`CONTINUE_BATCH_SEC 5` / `PAUSE_SPLIT_MIN_SEG_SEC 2.5`）
     *       —— 它们是"引擎的兜底默认"，不再和设置默认值相等；
     *       动它们必须是有意的，且要同步这条注释 ✓
     *
     * 🔴 **`maxAvgWordSec` 仍是 1.9，没有跟着调** —— 理由是硬的 ✗：
     *    判据是**严格** `> maxAvgWordSec`，而 E 段（「ん」）正好 `1 词 / 2.00 秒`
     *    ⇒ 取 2.0 时 `2.00 > 2.0` 为 **false** ⇒ **那个段会漏过去**，而它正是这条判据
     *    被加进来的唯一理由。而 1.9 本来就能放过「うんそうだね」1.78 /「すごいなんか」1.79
     *    ⇒ **调到 2.0 不会多放过任何一句真话，只会丢掉 E 段那道保护** ✗
     *    （真要放宽，得把比较改成 `>=` —— 那是另一件事，别混进来 ✓）
     */
    vadSegments: {
      /**
       * 一批最多取多长的音频（秒）。**上限 = 字幕滞后的直接来源**，也是"生僻专有名词认不准"的那一端。
       *
       * 实测：日常句子 6~12 秒批长都正确；而「コックスプレッシャー」这类需要约 14 秒才认对
       * （那时延迟得 ≈18 秒）。所以 8 是"认得够全"和"别太晚"之间的折中。
       * 调小 → 字幕更跟手，但 Whisper 断得更碎、生僻词更容易错。
       */
      maxBatchSec: 8,
      /**
       * 续批秒数：**每批从上一段的结尾之后再抓多少秒**。
       *
       * ⚠️ 它**不是**批长本身 —— 实际批长 = `min(maxBatchSec, 尾巴 + continueBatchSec)`
       *    （`尾巴` = 上一批里那段没确认的音频长度，通常是 0~3 秒）。
       *    所以把它调大**未必**会让批变长：批长上限会先夹住它 ✓
       *
       * 调大 → 每批听得更完整（生僻词更容易认对），但字幕更晚。
       * 调小 → 批更短、字幕更跟手，但 Whisper 断得更碎、更容易认错。
       * 实测：`maxBatchSec = 8` 时批长落在 5~8 秒；把它设成 3 ⇒ 批长落到 3~5 秒。
       *
       * ⭐ **v2.67.1：5 → 4**（引擎兜底常量 `CONTINUE_BATCH_SEC` 仍是 5 ✓）
       *    理由：批短的收益（字幕跟手）比"多认一个生僻词"更常被感知到；
       *    而端到端的 10 秒延迟主要由 `maxBatchSec` + 翻译窗口构成，这一项只占 1 秒。
       */
      continueBatchSec: 4,
      /**
       * 「这段是不是几乎没人说话」的词级判据：**秒/词**。
       *
       * `(末词.end − 首词.start) / 词数 > maxAvgWordSec` ⇒ 判为垃圾段（不采纳）。
       * 正常段实测 **0.17~0.50 秒/词**；而「ん」那种"1 个词占 2 秒"是 **2.00 秒/词** ✓
       *
       * 🔴 **别往下调**：0.8 曾经把「そうなんだよね」**1.01~1.08**、「うんそうだね」**1.78**
       *    「すごいなんか」**1.79** 全部误杀 —— 而那几个正是**语气词和短句**，
       *    也就是使用者报的"语气词或者短一点的被丢了" ✓
       * ⚠️ 也**别取 2.0**：判据是严格 `>`，而 E 段正好 `1 词 / 2.00 秒` ⇒
       *    `2.00 > 2.0` 为假 ⇒ **那个段会漏过去**，而它正是这条判据被加进来的唯一理由 ✗
       */
      maxAvgWordSec: 1.9,
      /**
       * 多长的段才考虑「段内切分」（秒）。
       *
       * Whisper 会把「前导短音（♪ / 换气）+ 后面的句子」合成一段，段起点落在前导短音上 ✗。
       * 段内切分在段内部找一处真实停顿，把这种情况切开。
       * 调大 → 只切更长的合并（少切，句子更整）；调小 → 多切（更容易切碎）。
       *
       * ⭐ **v2.67.1：2.5 → 4**（引擎兜底常量 `PAUSE_SPLIT_MIN_SEG_SEC` 仍是 2.5 ✓）
       *    理由：切得太勤会切出**没法单独翻译**的碎片 ✗ ——
       *    实测日志里出现过「意識を」（3 个字）和「引き締めていないですけど」被分开送翻译，
       *    于是 DeepL 拿到两个半句、译文残缺；而显示层"合并"只能把两个**已经分开翻的**
       *    译文拼在一起，救不了翻译质量 ✗
       *    ⇒ 门槛抬到 4 秒：只切那种"前导短音明显、后面一长段"的合并 ✓
       */
      pauseSplitMinSegSec: 4,
      /**
       * VAD 开口锚：把上屏时刻从「批起点 / 段起点」挪到「人真正开口」。
       *
       * 🔴 **默认关**，而理由是实测的：词级时间戳证明 `words[0].start` 与 `seg.start`
       *    只差 **0.00~0.07 秒** ⇒ `seg.start` 本来就贴着"人真正开口" ⇒
       *    开口锚是在改一个本来就对的数，而它把 `at` 挪得**分散**（最多 2.6 秒）✗
       *    ⇒ 「同批一起上屏」失效，而"提前"并没有因此改善 ✓
       * 想回到旧行为就打开（代价值得自己看）。
       */
      segStartAnchor: false,
      /**
       * 新路的**延迟下限**（秒）—— 选「本地 Whisper 自断句」时，实际延迟不会低于它。
       *
       * ⚠️ 这是**硬下限**，不是目标：`effectiveDelaySec()` 取 `max(用户滑块, 这一项)`。
       *    ⇒ 滑块调到 4.7 而这一项是 10，实际还是 **10**（滑块看起来"降不下去"）✗
       *
       * 为什么需要它：新路要等「批采集完 + HTTP 往返 + 确认」，比旧路 VAD 长得多；
       * 滑块停在 4.7 时排期预算不够，字幕会一路迟到。
       *
       * ⭐ **默认 10**（= 原来写死在 `player.js` 的 `WHISPER_SEGMENTS_MIN_DELAY_SEC` ✓）
       *
       * 🔴 **调小之前先看日志里的 `缓冲 · 前方 X.Xs`** —— 那才是"这台机器实际能撑多少"。
       *    实测这台机器只有 **7.9~8.4 秒**，而目标 10 ⇒ 日志天天报
       *    「⚠ 画面实际比目标靠前 2.0s ⇒ 这句会晚 2.0s（缓冲没填到目标）」✗
       *    ⇒ 降到 8 附近，"填不到目标"消失，字幕反而更准 ✓
       *    ⚠️ 而降过头会让排期预算不够（`at` 变早）⇒ 字幕**提前** ✗
       *    两者之间就是这台机器的"缓冲能撑多少"。
       */
      minDelaySec: 10,
    },
    /**
     * 本地 VAD 断句（全本地，延迟最低）。
     *
     * 地址沿用上面的 whisperChunked（本地 Whisper 服务），这里只放 VAD 自己的参数。
     * 原理见 lib/asr/vad.js：VAD 当场判断"这句说完了"，把**完整的一句**送去识别，
     * 所以不需要分片、也没有跨片等待。
     */
    vad: {
      /** 语音概率高于它算"有人在说话"（Silero 输出 0~1） */
      vadThreshold: 0.5,
      /**
       * 连续静这么久才算说完了 —— 这一项直接等于主要延迟，别调太大。
       *
       * ⚠️ 但它也是"字幕碎不碎"的主要旋钮：
       * 太小 → 说话人换气就被切断，字幕碎成一片（踩过）
       * 太大 → 延迟变长
       * 另外代码里还有**迟滞**（退出阈值 = 进入阈值 × 0.7），
       * 专门治"概率在阈值附近抖动导致反复切断"，所以不用靠把这个值调很大来防碎。
       *
       * ⭐ 默认 **600**（v2.66.78 从 450 改上来）。这个数是闭环 A/B/C 测出来的拐点：
       *   450 → 600：整句中位字数 **18 → 27（+50%）**、min 4 → 7、≥8 字整句 93% → 97%
       *     代价：识别滞后中位 3.5 → 4.4s（+0.9s），而 max 反而 9.6 → 8.6（更稳）
       *   600 → 750：**没有进一步改善**（中位 27 → 27、min 7 → 5）
       * 所以超过 600 只是白等延迟。
       */
      vadMinSilenceMs: 600,
      /**
       * 硬边界门槛（毫秒）：静音超过它才算"这句真的说完了"。
       *
       * 这就是 Deepgram 那套两级边界的本地等价物：
       *   vadMinSilenceMs → 软边界（先出文本，但先不收句，和后面拼）
       *   这一项          → 硬边界（收句）
       * 另外文本自带句末标点时也会立刻收句 —— 那是 Whisper 在告诉我们"这句是完整的"，
       * 相当于 Deepgram 靠词判断 speech_final 的做法。
       */
      vadUtteranceEndMs: 900,
      /**
       * 一句最长多久，超了强制切断。
       *
       * ⚠️ 实测把它从 20s 收到 8s，又收到 5s：说话人一口气讲很久时，
       * 8 秒才切会攒出 47~58 字的字幕，而 Deepgram 那次最长只有 32 字。
       * 5 秒更接近它的粒度。
       *
       * ⭐ v2.66.78 从 5 改到 **6**：上限那一刀是**按时间**切的，切点落在
       * "第 N 秒时正在说的那个音"上，会切在词中间。5 秒太密 ⇒ 切点更多 ⇒
       * 半个词被分到两侧的次数更多（真机现场：「徴用の節句」被切成三片，
       * 线上认成「蝶用」/「石窟」/「セックス」）。
       * 6 秒是"少切一刀"和"不攒出读不完的长句"之间的取舍点，别往上再加。
       */
      vadMaxSpeechSec: 6,
      /** 短于这个时长的话段当噪声丢掉，不单独出一条字幕 */
      vadMinUtteranceMs: 400,
      /**
       * 句子前后各补多少毫秒（切在音节中间会让识别丢字）。
       *
       * ⭐ 默认 **400**（v2.66.78 从 200 改上来）。200ms 只够一个音节，
       * 而日语「ちょっと」「ネコ」这种（促音/长音/两拍以上）要 300~400ms。
       * 真机现场：`分片 · 5.2s · 静音 0ms`（切在语音中间）之后，
       * 「ネコの真似」被切成两半、线上认成「この場」；
       * 「徴用の節句」被切成三片、线上认成「蝶用」/「石窟」/「セックス」。
       * 留白**不加延迟**（只是前后各多取一点音频，排期仍按实测延迟），
       * 代价只是分片略长一点。
       */
      vadPadMs: 400,
      /**
       * 「合理断句」：到「单句上限」时回看末尾有没有换气处，把切点挪过去。
       *
       * ⚠️ 为什么需要它：上限那一刀是**按时间**切的，切点落在"第 5 秒时正在说的那个音"上，
       * 可能切在词中间 —— 两边都会缺字。回看能把切点挪到换气处（实测：8 秒的一口气
       * 从 `5.0 + 3.0` 变成 `4.5 + 3.5`）。
       *
       * 找不到换气处时行为**逐字退回**原样，所以关掉它只是"回到从前"，不是"修正什么"。
       *
       * ⚠️ **默认关**（v2.66.79 起；原来是开）。
       *
       * 为什么改：闭环 A/B 实测（同一素材、各 120 秒、各 4 份导出）证明它**得不偿失**：
       *   · 它确实在工作 —— `已挪到换气处` 从 **0 次变 10 次** ✓
       *   · 而整句中位字数 **22 → 18**（更碎）、`≤4 字整句` **0 → 2**、
       *     整句最短字数 **6 → 4** —— 挪到换气处换来的是**句子更短更碎**
       *   · 而它想治的那种 0.2 秒短尾巴**一条都没减少（2 → 2）**
       * 而"句子很碎"正是用户反复抱怨的那件事，所以默认值不该站在更碎那一边。
       *
       * ⚠️ 代码侧读它的方式仍是 `!== false`（`vad.js` / `player.js` 两处必须一致）。
       *    合并后的设置**一定**带这个字段（这里就是 false），所以 `!== false` 读到的
       *    就是本默认值；改成 `=== true` 收益为零，而两处必须同时改，
       *    漏一处就成了"断句按开做、合并按关做"的半开半关。
       */
      vadSmartCut: false,
      /**
       * 「丢弃过短片段」—— **默认关** ✓
       *
       * ⚠️ 为什么默认关：曾经真的按最短话段丢过，代价是「はい」「ええ」这类短应答
       *    整句消失 —— 用户反馈「丢信息」就是这个。所以现在**必须显式打开**才丢 ✓
       * ⚠️ 而关着时，行为和以前**逐字一致**（那 400ms 只是个不参与判定的读数）✓
       */
      vadDropShort: false,
    },
    /**
     * 阿里云百炼 Qwen-ASR —— **国内直连，不需要代理**。
     *
     * 加它的原因很具体：有人反馈 Deepgram 在国内要代理才能注册/使用，直接卡死了大部分用户。
     *
     * ⚠️ 断句仍然在浏览器里做（Silero VAD，参数共用上面 `vad` 那一块），
     * 这里只放「文本从哪来」需要的三样。**它不是流式**：一句话说完才发请求，
     * 比流式多一句的延迟 —— 和当初选「本地 VAD + HTTP 发给 Whisper」是同一个取舍。
     */
    dashscope: {
      apiKey: '',
      /**
       * ⚠️ **两个端点支持的模型不一样**,这是实测撞过的:
       *   兼容端点  ✓ qwen3-asr-flash        ✗ qwen-audio-3.1-asr-flash
       *             → 404 `Unsupported model … for OpenAI compatibility mode`
       *   原生端点  ✓ qwen-audio-3.1-asr-flash / qwen-audio-3.0-asr-flash / fun-asr* / paraformer*
       *
       * **换模型名不等于只改名字,端点和请求体形状都得跟着换。**
       * `auto` 按模型名前缀自动选(认不出的一律走兼容 —— 保住一直跑通的行为);
       * 也可强制。`endpoint` **留空表示用自动选择的结果**,填了才覆盖。
       */
      endpointMode: 'auto',
      endpoint: '',
      /**
       * 即时热词。**每行一个**，`词` 或 `词:权重`（权重 1~5 推荐 4；50 = 超级热词，最多 50 个）。
       * ⚠️ **只在原生端点下有效** —— 兼容端点没有这个字段的位置。
       * 留空 = 不发这个字段 = 请求体和没有这一项时完全一致。
       */
      hotwords: '',
      /**
       * 把内置术语表的**源词**也当作识别热词（**合并**进上面那栏，不是替换）。
       *
       * 为什么默认**关**：热词会改变识别行为，默认悄悄开着会让人困惑；
       * 而且它**只在原生端点下有效**（官方：`vocabulary` 仅 qwen-audio-3.* 支持），
       * 在兼容端点下开了也没用 —— 不能给一个"看起来开了其实没用"的开关。
       *
       * 词表沿用翻译那边的开关（liveGlossary 默认开 / gamingGlossary 默认关），
       * 不另建一套 —— 否则用户要维护两份"我关心哪些词"。
       */
      glossaryHotwords: false,
      /**
       * 模型名可改 —— 这类模型更新很快，写死在代码里过几个月就会过时。
       *
       * 默认选 **3.1** 而不是 3.0：官方 API 参考里，`qwen-audio-3.1-asr-flash` 支持
       * **原生文本润色**（3.0 与 Fun-ASR-Flash 都标注"暂未开放"）。
       * 润色清洗的是**翻译的输入** —— 喂进去的是理顺过的句子而不是
       * 「えーと、あの、その…」这类语气词和口吃重复，**翻译质量会跟着上一档**。
       *
       * ⚠️ **改默认值对老用户无效** —— `getSettings()` 是"已存值盖在默认值上"，
       * 老用户 storage 里存着旧的 `qwen3-asr-flash`，会**继续用旧的、不会被突然换掉**。
       * **这是我们要的行为，所以刻意不加迁移** —— 新用户拿到更好的默认，老用户不被打扰。
       * 想升级的老用户在设置页手动填一下即可。
       * （本项目前面因为"改了默认值老用户拿不到"查过一整轮，所以写清意图，
       *   免得以后有人"顺手补一条迁移"。）
       */
      model: 'qwen-audio-3.1-asr-flash',
      /**
       * 上下文 / 提示词（官方两个页面分别叫「System Message」和「上下文增强」）。
       *
       * ⚠️ **默认留空** —— 留空就不发这个字段，行为和这一项加进来之前完全一致。
       *
       * ⚠️ 写**词**，不写**描述**（官方原文）：上下文主要通过**词表匹配**生效，
       * `text` 里必须包含音频里待识别的**原词**；只写语义相关的描述（如"日语直播"）
       * **纠正效果有限**。正确写法是把可能出现的人名、专有名词、频道用语直接列出来。
       *
       * 官方限制：最多 5 轮、每轮 ≤ 400 字符，超出静默截断。
       * 请求里的角色/部件类型取自官方两个页面（角色来自 API 参考、部件类型来自准确率指南），
       * **组合未经真实调用验证**。
       */
      prompt: '',
    },
  },
  translate: {
    provider: 'google-free',
    target: 'zh-CN',
    source: 'auto',
    /**
     * 默认开启。这是同传体感最大的一个开关：
     * 关闭时译文只在句子"定稿"后才出现，而 Deepgram 的 is_final 是在说话人**停顿**时才出的，
     * 于是不停顿讲 10 秒就要等 10 秒才看到中文。
     * 开启后中间结果一出现就翻译，字幕几乎立刻就有译文，代价是译文会随识别修正而刷新。
     */
    translateInterim: true,
    interimIntervalMs: 400,
    interimMinChars: 4,
    /** 给翻译服务带上前几句原文做上下文，改善指代与术语一致性 */
    contextSegments: 2,
    /**
     * 术语表：每行 `原文=译文`。三家服务商的落地方式不同——
     * DeepL 走官方 glossary API（最可靠）、OpenAI 写进提示词、Google 免 Key 通道只能做占位符替换。
     */
    glossary: '',
    /**
     * 是否并入内置游戏词表。
     * **默认关闭**：术语表是整词匹配、全局生效的，开着它看非游戏内容会污染译文。
     */
    gamingGlossary: false,
    /**
     * 内置**直播**术语表（英文 + 日文 → 中文）：superchat / 配信 / スパチャ / 切り抜き 这类。
     * **默认开启**——这个扩展本来就是给直播用的，这些词在直播里几乎必然出现。
     */
    liveGlossary: true,
    /**
     * 复核校正：初译出来后再让模型对照原文校一遍，只改错不润色。
     * 只有 OpenAI 有"再想一遍"的接口，其它服务商会忽略。
     * 多一次调用，所以只在延迟模式（有预算）里建议开。
     */
    reviewPass: false,
    openai: {
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      systemPrompt:
        '你是专业的同声传译引擎，正在实时翻译一段连续的讲话。把用户给出的文本翻译成目标语言，只输出译文本身：不要解释、不要引号、不要重复原文、不要添加任何前后缀。保持口语化与自然的语序；遇到没说完的半句话，按最合理的理解译出，不要补全不存在的内容。',
    },
    deepl: {
      apiKey: '',
      pro: false,
    },
    google: {
      endpoint: 'https://translate.googleapis.com/translate_a/single',
    },
    /**
     * DeepSeek：走 OpenAI 兼容协议，请求体与响应结构和 openai 完全一样。
     * 价格比 OpenAI 低不少，中文语感也好，适合长时间挂着的直播同传。
     */
    deepseek: {
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      systemPrompt:
        '你是专业的同声传译引擎，正在实时翻译一段连续的讲话。把用户给出的文本翻译成目标语言，只输出译文本身：不要解释、不要引号、不要重复原文、不要添加任何前后缀。保持口语化与自然的语序；遇到没说完的半句话，按最合理的理解译出，不要补全不存在的内容。',
    },
    /**
     * Ollama：本机跑的大模型，**不需要 API Key、不联网、零成本**。
     *
     * ⚠️ 需要你先在本机跑着 Ollama 并拉过模型（`ollama pull qwen2.5:7b`）。
     * 7B 级别在同传这种短句、口语、无上下文的场景下质量不如云端，
     * 但它完全离线；机器够好可以换更大的模型。
     */
    ollama: {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      systemPrompt:
        '你是专业的同声传译引擎，正在实时翻译一段连续的讲话。把用户给出的文本翻译成目标语言，只输出译文本身：不要解释、不要引号、不要重复原文、不要添加任何前后缀。保持口语化与自然的语序；遇到没说完的半句话，按最合理的理解译出，不要补全不存在的内容。',
    },
    /**
     * 百度翻译。签名是 `MD5(appid + q + salt + key)`。
     *
     * ⚠️ 免费版 **QPS = 1**（每秒一次），同传中间结果刷新快时容易触发 54003 限流。
     */
    baidu: {
      appid: '',
      key: '',
      endpoint: 'https://fanyi-api.baidu.com/api/trans/vip/translate',
    },
    /**
     * 腾讯云机器翻译（TextTranslate，TC3-HMAC-SHA256 签名）。
     *
     * ⚠️ `region` 是**必填**的 —— 腾讯云 API 要求声明地域，不填会被拒。
     * 签名算法已对官方示例向量验证过，见 lib/translate/index.js 与 smoke-test 的断言。
     */
    tencent: {
      secretId: '',
      secretKey: '',
      region: 'ap-guangzhou',
      endpoint: 'https://tmt.tencentcloudapi.com',
    },
    /**
     * 阿里云机器翻译（TranslateGeneral，POP RPC 签名 HMAC-SHA1 + Base64）。
     *
     * ⚠️ 语种代码里繁体是 `zh-tw`（全小写），和别家的 `zh-TW` 不一样 ——
     * 映射表在 lib/translate/index.js 的 ALI_LANG，是从官方语言代码表核对来的。
     */
    ali: {
      accessKeyId: '',
      accessKeySecret: '',
      regionId: 'cn-hangzhou',
      endpoint: 'https://mt.aliyuncs.com/',
    },
  },
  ui: {
    position: 'bottom',
    fontSize: 24,
    opacity: 0.86,
    showOriginal: true,
    historyLines: 2,
    hideAfterMs: 7000,
    bilingualOrder: 'translation-first',
    /**
     * 把诊断信息画在字幕上方，并把翻译生命周期打到页面控制台。
     * 走的是和字幕完全相同的通道（offscreen → SW → tabs.sendMessage），
     * 不经过 chrome.storage 与状态广播——所以它和弹窗里的读数可以互相印证：
     * 页面有、弹窗没有，就说明问题出在状态通道；两边都没有，就说明翻译根本没跑完。
     * 默认开着：数字看不见的时候，用户没有任何别的办法判断卡在哪一段。
     */
    showDiag: true,
  },
  audio: {
    muteOriginal: false,
    /** 安静音源自动增益（只提升不衰减，静音冻结） */
    autoGain: true,
  },
  /**
   * 画面呈现方式。
   *   overlay = 直接在原页面上叠字幕（零延迟，但字幕必然晚于画面）
   *   delayed = 另开一个播放页，把画面推迟 D 秒再放，让字幕追平画面
   */
  capture: {
    mode: 'overlay',
    /** 延迟秒数。要 ≥ 识别出定稿 + 翻译往返的总时间 */
    delaySec: 3,
    /**
     * 延迟画面的视频码率（bps）。**0 = 按实际画面尺寸自动估。**
     *
     * ⚠️ 原来是写死的 4 Mbps —— 对 3840×2160 太低。
     * 码率不够时**静止画面还凑合，一运动就糊**：编码器只能丢细节去凑码率。
     * 自动档的算法见 DelayedPlayback.recommendBitrate：
     * 1920×1080@30 → 10 Mbps，3840×2160@30 → 40 Mbps。
     * 万一机器扛不住（掉帧变多、卡顿），把这里填小一点即可。
     */
    delayBitsPerSecond: 0,
    /**
     * 画质档位：**相对"标准档"的倍率**。实际码率按画面尺寸算，所以换分辨率不用重调。
     *
     * 基准（标准档）：1080p ≈ 10 Mbps · 2K ≈ 17 · 4K ≈ 40。
     *
     *   low      省资源  0.5×   4K ≈ 20 Mbps
     *   standard 标准    1.0×   4K ≈ 40 Mbps
     *   high     高画质  1.6×   4K ≈ 64 Mbps  ← 默认
     *   ultra    极致    2.4×   4K ≈ 96 Mbps
     *
     * ⚠️ 默认给到"高画质"而不是"标准"：40 Mbps 对 4K 只有 0.16 bpp，
     * 静止够用但**快速运动会糊**（用户实测反馈"不卡但还是有点糊"）。
     * 会糊的根因是码率不够，不是分辨率不够 —— 所以档位只调码率。
     */
    delayQuality: 'high',
    /**
     * 采集帧率上限。0 = 不限制。
     *
     * ⚠️ 不显式给的话 Chrome 默认常常只给 30fps —— 源是 60fps 时白丢一半的帧，
     * 运动画面看着发顿。这是**上限**不是强制值，源只有 30fps 时没有副作用。
     * 注意帧率翻倍会让自动码率也跟着翻倍（保持同样的 bpp），编码压力也翻倍。
     */
    maxFrameRate: 60,
    /**
     * AGC（自动增益）档位。
     *
     * ⚠️ AGC 是双刃剑：它的本意是把忽大忽小的音量拉平（对识别有利），
     * 但追得太快就会在音量起伏时来回"泵"，而 VAD 和 Whisper 都讨厌电平忽大忽小。
     * 差麦克风场景下 `standard` 的 +12dB 上限还会把底噪一起放大。
     *
     * 默认 `standard` = 这一项加进来**之前的行为**，不动就是零风险。
     * 差麦克风/快语速值得试 `gentle`（提升减半、收敛慢 4 倍、噪声门抬高）。
     * 可选：off / gentle / standard / strong（见 lib/audio-chain.js 的 AGC_PROFILES）
     */
    agcProfile: 'standard',
    /**
     * 延迟画面裁到多高（像素），0 = 原样。
     *
     * ⚠️ 默认 0（原样）。曾经想默认 1080 来省 CPU，但实测**对卡顿没有帮助**
     * （瓶颈不在 CPU），反而把画面弄糊了 —— 用户的反馈很直接。
     * 现在它是播放页上的一个下拉框，需要时自己降。
     */
    delayMaxHeight: 0,
    /** 字幕同步微调：正数把字幕往后推 */
    syncOffsetMs: 0,
    /**
     * 是否用变速（playbackRate ±6%）把延迟拉回目标值。
     *
     * ⚠️ **默认关**。实测开着的时候播放速率会长期钉在 0.94 或 1.06，
     * 而 ±6% 变速 + 反复改速率在 4K 画面上是看得见的顿挫 ——
     * 用户关掉之后反馈"好多了"，所以默认关。
     *
     * 关掉的代价只是延迟会随编码器滞后慢慢漂移，
     * 而**字幕依然对得上**：排期用的是实测延迟，不是目标值。
     * 开着的好处是延迟稳定在目标值附近，代价是画面有变速顿挫。
     */
    smoothRate: false,
    volume: 1,
    // 注意：这里原来有 translateLeadMs（「翻译预留」旋钮），已删除。
    // 现在是固定规则，见 lib/delayed-player.js 的 TRANSLATE_WINDOW_MS。
  },
  history: {
    keep: 300,
  },
};

export async function getSettings() {
  const raw = await chrome.storage.local.get([STORAGE_KEY, VERSION_KEY]);
  const stored = raw?.[STORAGE_KEY] || {};
  const storedVersion = Number(raw?.[VERSION_KEY]) || 1;
  let merged = mergeSettings(DEFAULT_SETTINGS, stored);

  if (storedVersion < SETTINGS_VERSION) {
    /**
     * ⚠️ 这里**必须先深拷贝再迁移**，不能直接 `runMigrations(merged, …)`。
     *
     * 为什么：`mergeSettings` 在 patch 里**没有**某个键时会 `out[k] = base[k]`
     * —— 也就是把 `DEFAULT_SETTINGS` 的嵌套对象**按引用**挂进返回值。
     * 于是老 profile（缺 `asr.vad` 这类整块）拿到的 `merged.asr.vad`
     * 和 `DEFAULT_SETTINGS.asr.vad` **是同一个对象**，
     * 而 `runMigrations` 是 `setByPath` **就地改** —— 一跑迁移就把默认值改了 ✗。
     *
     * 后果不是"数据错"（迁移写进去的通常正好等于新默认值），而是
     * **`DEFAULT_SETTINGS` 被永久污染**：此后同一 JS 上下文里任何
     * "默认值是多少"的判断都读到迁移后的值 —— 测试里表现为
     * 「改默认值断言永远红不了」（这条就是被它坑出来的）。
     *
     * 用 JSON 往返而不是 structuredClone：设置里全是纯 JSON（字符串/数字/布尔/对象/数组），
     * 而 JSON 往返在所有目标浏览器里都有，不必赌 structuredClone 的可用性。
     */
    merged = runMigrations(JSON.parse(JSON.stringify(merged)), storedVersion);
    // 迁移结果立刻落盘，避免每个上下文各跑一遍
    await chrome.storage.local.set({ [STORAGE_KEY]: merged, [VERSION_KEY]: SETTINGS_VERSION });
  }
  return merged;
}

/** 依次套用从 fromVersion+1 到当前的迁移规则 */
function runMigrations(settings, fromVersion) {
  let out = settings;
  for (let v = fromVersion + 1; v <= SETTINGS_VERSION; v++) {
    const rules = MIGRATIONS[v];
    if (rules) {
      for (const [path, oldDefault, newDefault] of rules) {
        // 关键：只在该项**还等于旧默认值**时才动它——那说明用户从没主动改过。
        // 用户明确设过的值一律保留。
        if (getByPath(out, path) === oldDefault) setByPath(out, path, newDefault);
      }
    }
    const custom = CUSTOM_MIGRATIONS[v];
    if (custom) out = custom(out);
  }
  return out;
}

export async function saveSettings(settings) {
  const merged = mergeSettings(DEFAULT_SETTINGS, settings || {});
  await chrome.storage.local.set({ [STORAGE_KEY]: merged, [VERSION_KEY]: SETTINGS_VERSION });
  return merged;
}

export async function patchSettings(path, value) {
  const cur = await getSettings();
  const parts = String(path).split('.');
  let node = cur;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
  return saveSettings(cur);
}

/** 只做一层深合并的简易版，避免循环依赖 util。 */
function mergeSettings(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeSettings(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function targetLangLabel(id) {
  return TARGET_LANGS.find((l) => l.id === id)?.label || id;
}

export function deeplTarget(id) {
  return TARGET_LANGS.find((l) => l.id === id)?.deepl || String(id).toUpperCase();
}

/** 供 UI 展示：当前 ASR 是否已具备启动条件 */
export function asrReadiness(settings) {
  const p = settings.asr.provider;
  if (p === 'deepgram') {
    return settings.asr.deepgram.apiKey?.trim()
      ? { ok: true }
      : { ok: false, reason: '缺少 Deepgram API Key' };
  }
  if (p === 'openai-realtime') {
    const key = settings.asr.openaiRealtime.apiKey?.trim() || effectiveOpenAiKey(settings);
    return key ? { ok: true } : { ok: false, reason: '缺少 OpenAI API Key' };
  }
  // 本地 VAD、本地 Whisper 自断句、Whisper 分片共用同一个「本地 Whisper 服务」地址
  if (p === 'whisper-chunked' || p === 'vad' || p === 'vad-segments') {
    return settings.asr.whisperChunked?.baseUrl?.trim()
      ? { ok: true }
      : { ok: false, reason: '缺少 Whisper 服务地址' };
  }
  /**
   * 阿里云百炼：**只看它自己的 Key**，不要去要本地 Whisper 地址 ——
   * 没人会在用云端识别的时候还跑一个本地服务。
   */
  if (p === 'dashscope') {
    return settings.asr.dashscope?.apiKey?.trim()
      ? { ok: true }
      : { ok: false, reason: '缺少阿里云百炼（DashScope）API Key' };
  }
  return { ok: false, reason: '未知的识别服务' };
}

/** openai-realtime 允许复用 whisper-chunked 的 Key（常见于同一家 OpenAI 兼容服务） */
export function effectiveOpenAiKey(settings) {
  const rt = settings.asr.openaiRealtime;
  if (rt.apiKey?.trim()) return rt.apiKey.trim();
  if (rt.useAsrKeyFromChunked) return settings.asr.whisperChunked.apiKey?.trim() || '';
  return '';
}

export function maskKey(k) {
  const s = String(k || '');
  if (!s) return '（未设置）';
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '••••••' + s.slice(-4);
}
