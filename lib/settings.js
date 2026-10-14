// 统一的配置读写模块。service worker / offscreen / popup / options 共用。

export const ASR_PROVIDERS = [
  {
    id: 'vad',
    label: '本地 VAD 断句 + 本地 Whisper（全本地，延迟最低）',
    hint: '浏览器内跑 Silero VAD 判断"这句说完了"，再把完整的一句交给本地 Whisper。不分片、不联网、免费。',
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
export const SETTINGS_VERSION = 7;

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
};

/**
 * 需要搬动位置 / 删除键的迁移用函数写。
 * 三元的 [路径, 旧值, 新值] 表达不了这两件事。
 */
const CUSTOM_MIGRATIONS = {
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
 * 比让他去猜「静音确认该填 300 还是 450」直观得多。
 *
 * 两档的差别，以及为什么：
 *
 * | 参数 | 正常语速 | 快语速 | 为什么 |
 * |---|---|---|---|
 * | 静音确认（软边界） | 450ms | **300ms** | 快语速的停顿本来就短（200~400ms），门槛 450ms 时**这些停顿一个都不算数** → 句子越并越长 |
 * | 一句最长 | 5s | **3.5s** | 每秒字数更多，同样 5 秒会攒出 50 字上下（实测 6.1s/52字、8.5s/46字），**读不完** |
 * | 前后留白 | 200ms | **250ms** | 快语速下更容易切在音节中间，多留一点 |
 *
 * 选档位会把对应数值写进那几个旋钮（用和延迟预设同一套机制），
 * **之后仍然可以单独微调任何一个** —— 档位只是给一组合理的起点。
 */
export const VAD_RATE_PRESETS = [
  {
    id: 'normal',
    label: '正常语速',
    hint: '默认。停顿比较明显，静音 450ms 就算一句说完，一句最长 5 秒。',
    values: {
      'asr.vad.vadMinSilenceMs': 450,
      'asr.vad.vadMaxSpeechSec': 5,
      'asr.vad.vadPadMs': 200,
    },
  },
  {
    id: 'fast',
    label: '快语速（主播说话快 / 连珠炮）',
    hint:
      '停顿更短、每秒字数更多。静音门槛降到 300ms（不然那些短停顿一个都不算，句子会越并越长），' +
      '一句最长收到 3.5 秒（快语速下 5 秒能攒出 50 多字，读不完），留白多给 50ms。',
    values: {
      'asr.vad.vadMinSilenceMs': 300,
      'asr.vad.vadMaxSpeechSec': 3.5,
      'asr.vad.vadPadMs': 250,
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
    provider: 'deepgram',
    language: 'en',
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
     * 而它默认指向 127.0.0.1:8000 —— 没在本地跑那个服务的人，一旦默认打开，
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
      baseUrl: 'http://127.0.0.1:8000/v1',
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
       */
      vadMinSilenceMs: 450,
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
       */
      vadMaxSpeechSec: 5,
      /** 短于这个时长的话段当噪声丢掉，不单独出一条字幕 */
      vadMinUtteranceMs: 400,
      /** 句子前后各补多少毫秒（切在音节中间会让识别丢字） */
      vadPadMs: 200,
      /**
       * 「合理断句」：到「单句上限」时回看末尾有没有换气处，把切点挪过去。
       *
       * ⚠️ 为什么需要它：上限那一刀是**按时间**切的，切点落在"第 5 秒时正在说的那个音"上，
       * 可能切在词中间 —— 两边都会缺字。回看能把切点挪到换气处（实测：8 秒的一口气
       * 从 `5.0 + 3.0` 变成 `4.5 + 3.5`）。
       *
       * ⚠️ **默认开**，且代码侧判的是 `!== false` —— 老配置里没这个字段时必须仍然是开的，
       * 否则又会踩「改了默认值老用户拿不到」那个坑。
       * 找不到换气处时行为**逐字退回**原样，所以关掉它只是"回到从前"，不是"修正什么"。
       */
      vadSmartCut: true,
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
    merged = runMigrations(merged, storedVersion);
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
  // 本地 VAD 和 Whisper 分片共用同一个「本地 Whisper 服务」地址
  if (p === 'whisper-chunked' || p === 'vad') {
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
