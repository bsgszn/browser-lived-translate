// 本地 VAD 断句 + 本地 Whisper 定文本（全本地、免费）。
//
// 和「Whisper 分片」的根本区别：
//
//   分片模式：按固定时长切音频 → 攒满一片才送去识别 → 还要等下一片才能判断跨片
//             延迟 ≈ 分片时长 × 2 + 推理
//   这个模式：VAD 当场判断"这句话说完了" → 把**完整的一句**送去识别
//             延迟 ≈ 静音确认时长 + 推理（约 0.3 + 0.5 秒）
//
// 它同时省掉了三样东西：分片量化、跨片等待、分片时长调参 ——
// 因为句子边界来自真正的语音检测，而不是"每 N 秒切一刀"。
//
// 依赖（必须放在扩展的 vendor/ 目录，不能从网上加载 —— MV3 的 CSP 不允许）：
//   ort.min.js                     onnxruntime-web 运行时（UMD，由 player.html 用 <script> 引入）
//   ort-wasm-simd-threaded.wasm     CPU SIMD 后端
//   silero_vad.onnx                 Silero VAD v5 模型

import { buildWav, bytesToBase64 } from '../util.js';
import { VadGate, VAD_FRAME_SAMPLES, longestSpeechRun } from './vad-gate.js';
import { looksLikeHallucination } from './hallucination.js';
import { glossarySourceWords } from '../glossary.js';
import { JA_LIVE_HOTWORD_LIST } from '../hotwords/ja-live.js';
/**
 * ⭐ 新断句路径的批次引擎（Whisper 先断 · 静音只做确认）—— 见 `whisper-batch.js` 的文件头。
 *
 * ⚠️ 它**只在 `asr.whisperChunked.whisperSegments === true` 时被实例化** ✓
 *    （默认关 ⇒ 这里连对象都不会建 ⇒ 旧路行为逐字不变 ✓）
 *
 * `shownStartOf` 是"采纳段该在什么时刻上屏"（把开头那段换气让掉）——
 * 仿真也用同一个函数，否则量出来的数不是真机那条路上的 ✓
 *
 * `clampShownAt` 是"排期单调夹紧"（不许比上一条早，也不许挤得太近）——
 * 播放器同一刻只显示一条 ⇒ 两条 `at` 挨得太近就等于**前一条被秒顶** ✗
 */
import { createSegmentLoop, shownStartOf, clampShownAt, looksTooSlowByWords } from './whisper-batch.js';
/**
 * ⭐ 「连续 N 帧都达标才算开口」的判据本体 —— 提成纯函数是为了能断言 ✓
 *
 * ⚠️ 它原来是这个文件里的一个内联 `for` 循环 ✗ ⇒ 断言只能在源码上做正则检查，
 *    测不到行为（"断言看着有、实际抓不到"今天栽了四次）。
 */
import { findSpeechRun, ringGetter, planPauseSplit, splitTextByFraction } from './speech-run.js';

/**
 * ⭐ **段内切分**的四个门槛（模块级导出 —— **为了能被断言直接读** ✗）
 *
 * 为什么必须导出：开口锚那批常量的断言只能靠**源码正则**（它们在 `createSession` 闭包里 ✗），
 * 而正则只能证明"写了什么"，证明不了"算出来的数" ✓
 * —— 今天已经因此栽过（`due()` 弹出被 break 会永久丢字幕，而断言只查了字面量 ✓）
 *
 * ## 为什么需要段内切分
 *
 * 「提前」实测还剩 9 条（`xhsp-ab6`，两轮都延迟 10、同素材、按内容配对），
 * 其中 **4 条有同一个指纹：新路跨度比旧路长 1.5~4 秒** ✗
 * ```
 * −5.03s 旧跨 1.8 → 新跨 3.9（1.5 字/秒）
 * −3.41s 旧跨 3.3 → 新跨 5.7（1.2 字/秒）
 * −3.38s 旧跨 4.0 → 新跨 8.0（3.4 字/秒）
 * −2.92s 旧跨 3.0 → 新跨 4.5
 * ```
 * ⇒ Whisper 把**两句话合成了一段** ✗ ⇒ 整段的 `at` 落在第一句开头，
 *    而拿它去和旧路配「第二句」时，就成了提前一整个第一句的时长 ✗✓✓
 *
 * ## 四个数怎么定的
 *
 * · `MIN_SEG_SEC = 2.5`：**两句话加中间停顿不可能短于 2.5 秒** ✓
 *   （实测那 4 条跨度 3.9~8.0 秒；而旧路的单句中位跨度是 3.4 秒 ⇒ 2.5 秒是安全下限 ✓）
 *
 *   ⚠️ **这个数扫过四个值（2.5 / 3 / 3.5 / 4，每值一轮闭环，同素材同延迟 10）**：
 *   ```
 *   MIN_SEG  提前>0.5s  配对中位   p10    范围上界   字数合计
 *   2.5         6        +0.419   −1.66    +4.66     621
 *   3（旧值）     6        +1.196   −1.62    +7.44     615
 *   3.5         7        +0.511   −2.78   +10.75     614
 *   4           6        +0.884   −1.84   +10.80     609
 *   ```
 *   ⇒ ⭐ **它不是"免费参数"** ✗：提前条数**平在 6/6/7/6**（7 只差一对，n=25 ⇒ 噪声量级），
 *      而中位是**折线**（0.42 → 1.20 → 0.51 → 0.88）—— 单调参数给出折线 ⇒ **单轮噪声主导** ✗。
 *   ⇒ 取 **2.5** 的依据不是"它显著更好"，而是：**四个指标上都是最优或并列最优**
 *      （中位、p10、范围上界、字数合计），且**字数最多（621 ≈ 旧路 623）⇒ 没有多切掉内容** ✓。
 *   ⇒ ⚠️ **剩下的 6 条提前是 (b) 类**（批起点本身比"那句话真正开始"更早）✗ ——
 *      那要靠"批起点加守卫"，而**那条会丢字**，所以没动 ✓。
 *   ⚠️ **判据是两轮闭环（A 旧路 / B 新路，都延迟 10）按内容配对后的 `at` 差** ✓，
 *      不是单看某一轮的绝对值 ✗。
 * · `MIN_GAP_MS = 480`：**一个换气停顿 ≈ 0.3~1 秒** ✓
 *   （40ms 窗 ⇒ 12 帧；而 480ms 也远大于 VAD 的 7 帧开口门槛 280ms，
 *     否则会把"开口前那点静音"误当成句间停顿 ✗）
 * · `MIN_LEAD_MS = 400`：**停顿前至少 0.4 秒语音** ✓
 *   —— 否则那是**段首静音**，该归「开口锚」管，不是句间停顿 ✓
 * · `MIN_TAIL_MS = 1000`：**停顿后至少 1 秒语音** ✓
 *   —— 否则会切出一个"半秒的第二句"，那比合成一句更难解释 ✗
 */
export const PAUSE_SPLIT_MIN_SEG_SEC = 2.5;
export const PAUSE_SPLIT_MIN_GAP_MS = 480;
export const PAUSE_SPLIT_MIN_LEAD_MS = 400;
export const PAUSE_SPLIT_MIN_TAIL_MS = 1000;

/**
 * 阿里云百炼（DashScope）支持的语种短码。
 *
 * ⚠️ 和项目里 `SOURCE_LANGS` 的 id **恰好全部同名** —— 但仍然写成显式映射表，
 * 而不是"直接透传"。理由：透传的话，以后前端加一个 DashScope 不认识的 id（比如 `zh-CN`），
 * 请求会带着非法代码发出去，服务端只回一句"语种不支持"，用户根本看不出是设置项的问题。
 * （百度那边就留着这个隐患。）未映射时这里直接抛中文错误。
 *
 * 官方支持的完整列表有 27 个（含 yue/ar/hi/id/th/tr/uk/vi/cs/da/fil/fi/is/ms/no/pl/sv），
 * 这里只列项目 SOURCE_LANGS 用得到的；要加新语种，两边一起加。
 * `auto` 不在这张表里 —— 官方说明：语种不确定时**不要**指定 language 参数。
 */
const DASHSCOPE_LANG = {
  en: 'en',
  zh: 'zh',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  de: 'de',
  ru: 'ru',
  pt: 'pt',
  it: 'it',
};

/**
 * ─────────────────── DashScope 响应解析 ───────────────────
 *
 * ⚠️ **这两个函数必须被生产路径和设置页测试按钮共用。**
 *
 * 上一轮出过一个真事故:设置页的测试按钮**复制**了一份端点/请求体的逻辑,
 * 结果生产路径修好了、测试按钮没修 —— 用户按提示清空端点地址,测试按钮反而报
 * 「没有填端点地址」。**"两份实现只修了一份"是这里最容易犯的错,所以解析也只留一份。**
 */

/**
 * 从响应里取识别文本。**两种端点的响应形状完全不同,这里统一处理。**
 *
 * 官方响应示例(原生端点,`非实时语音识别 HTTP API` 那一页):
 * ```json
 * {
 *   "output": {
 *     "sentence": { "begin_time": 760, "sentence_end": true,
 *                   "text": "Hello World，这里是阿里巴巴语音实验室。", "words": [...] },
 *     "text":     "Hello World，这里是阿里巴巴语音实验室。"
 *   },
 *   "usage": { "duration": 4 },
 *   "request_id": "40e0734d-…"
 * }
 * ```
 *
 * ⚠️ **注意 `text` 在 `output` 下,不在 `output.choices[0].message.content[0].text`。**
 * 那个路径是**之前凭"DashScope 惯例"猜的,猜错了** —— 后果是原生端点鉴权通过、
 * 请求体也被接受(HTTP 200),但**解析永远拿到空字符串**,用户看到的是
 * 「识别成功 · 返回（空）」,一路查不出为什么。
 *
 * 兼容端点(OpenAI 兼容模式)才是 `choices[0].message.content`。
 *
 * @returns {{text: string, via: string|null}} `via` 是取到的字段路径,取不到时为 null
 *          —— 调用方靠它区分"真的没人说话"和"形状不认识"。
 */
export function pickDashscopeText(data) {
  const take = (v, via) => (typeof v === 'string' && v.trim() ? { text: v.trim(), via } : null);
  return (
    // ① 原生端点:完整识别文本
    take(data?.output?.text, 'output.text') ||
    // ② 原生端点:当前句子的文本(官方示例里两者同时存在,这里当兜底)
    take(data?.output?.sentence?.text, 'output.sentence.text') ||
    // ③ 原生端点开启说话人分离时,结果在 output.sentences 里
    take(data?.output?.sentences?.[0]?.text, 'output.sentences[0].text') ||
    // ④ 兼容端点(OpenAI 兼容模式)
    take(data?.choices?.[0]?.message?.content, 'choices[0].message.content') ||
    { text: '', via: null }
  );
}

/**
 * 解析拿不到文本时,给出一句**能直接贴出来排查**的说明。
 *
 * ⚠️ 这是常驻诊断,不是一次性临时代码 —— 换模型、换端点、服务端改版时响应形状
 * 都可能变,而"结果是空的"这件事本身**完全指不出原因**。
 *
 * 安全:响应体里不应有凭据,这里也**只取结构性的键名和截断后的原文**,
 * 不碰请求头、不碰 Key。
 */
export function dashscopeShapeNote(data, limit = 2000) {
  if (data == null) return '响应不是 JSON 对象(或为空)';
  if (typeof data !== 'object') return `响应不是对象:${typeof data}`;
  /**
   * ⚠️ 先分清"服务端真的返回了空文本"和"文本字段根本不在我们认识的路径上"。
   *
   * 前者是**正常结果**(这段音频里确实没人说话),后者是**代码和服务端不匹配**。
   * 不说清楚的话,用户看到的都是"结果为空",而这两件事的下一步动作完全相反。
   */
  if (data.output && typeof data.output === 'object' && 'text' in data.output) {
    return (
      `服务端返回的 output.text 是空的（不是"认不出字段"）—— ` +
      `这段音频里可能确实没有人说话。\n` +
      `顶层键 [${Object.keys(data).join(', ')}] · output 键 [${Object.keys(data.output).join(', ')}]`
    );
  }
  const top = Object.keys(data);
  const outKeys = data.output && typeof data.output === 'object' ? Object.keys(data.output) : null;
  const sentenceKeys =
    data.output?.sentence && typeof data.output.sentence === 'object' ? Object.keys(data.output.sentence) : null;
  let raw;
  try {
    raw = JSON.stringify(data);
  } catch {
    raw = '(无法序列化)';
  }
  const clipped = raw.length > limit ? `${raw.slice(0, limit)}…（共 ${raw.length} 字符，已截断）` : raw;
  return (
    `顶层键 [${top.join(', ')}]` +
    (outKeys ? ` · output 键 [${outKeys.join(', ')}]` : ' · 没有 output') +
    (sentenceKeys ? ` · sentence 键 [${sentenceKeys.join(', ')}]` : '') +
    `\n原始响应：${clipped}`
  );
}

/**
 * 拼 DashScope 的请求体。**导出是为了让测试直接打这个函数** ——
 * 请求体形状是最容易写错、也最难靠肉眼发现的地方（端点形状和请求体形状必须配套），
 * 复制一份到测试里就失去意义了：那只能证明"测试里那份是对的"。
 *
 * @throws 语种没映射时抛**中文**错误（绝不静默透传 —— 透传的后果是服务端只说
 *         "语种不支持"，用户看不出是设置项的问题）
 */
export function buildDashscopeBody({ model, language, dataUrl, prompt }) {
  const asrOptions = {
    /**
     * 逆文本归一化（"一千二" → 1200）显式关掉。
     * 对逐句翻译的字幕没有好处，反而可能把口语数字改得不自然。
     * 官方默认即为 false，这里显式写出来，免得以后默认值变了行为跟着变。
     */
    enable_itn: false,
  };
  if (language && language !== 'auto') {
    const code = DASHSCOPE_LANG[language];
    if (!code) {
      throw new Error(
        `阿里云百炼不支持语种「${language}」—— 到设置页换一个（它支持 zh / en / ja / ko / es / fr / de / ru / pt / it 等，选「自动检测」则不指定语种）。`,
      );
    }
    asrOptions.language = code;
  }
  const messages = [];
  /**
   * 上下文 / 提示词。
   *
   * ⚠️ **官方两个页面把这件事故意描述得不一样，这里按「兼容端点」那一页实现，并把歧义记下来。**
   *
   *   ① 非实时语音识别 **API 参考**（讲的就是我们用的这个兼容端点）：
   *      「System Message（可选）—— 用于提供上下文，例如背景文本和实体词表。
   *        **不支持设定模型角色或其它传统 system prompt。** 用了必须是 messages 第一条。」
   *      属性只规定了 `role: 'system'`，**没给 `content` 的形状**。
   *   ② 「提升识别准确率」指南（例子用的是**原生端点**）：
   *      `role: 'user'` + `content: [{ type: 'input_text', text: '…' }]`，后面还能跟 `assistant`。
   *
   * 这里用的是：`role:'system'` + **`content:[{ type:'input_text', text }]`** ——
   * 角色取自 ①（那是兼容端点的文档），**部件类型取自 ②**（① 没写，而 ② 证明了它叫
   * `input_text`，不是裸的 `{ text }`）。
   *
   * ⚠️ **这个组合没有被真实调用验证过**（没有 API Key）。服务端若拒了它，
   * 可退的两个方向：改成 `role:'user'`，或换原生端点 + `input.messages`。
   *
   * ⚠️ 另一条官方原文（已写进设置页提示，很反直觉）：
   *    「上下文主要通过**词表匹配**方式生效，`text` 里需包含音频里待识别的**原词**
   *     （如 Kubernetes、Bulge Bracket）。仅传入语义相关但不包含原词的描述，纠正效果有限。」
   *   写「这是一段日语直播」基本没用；要写「配信 スパチャ 切り抜き 草 それな」。
   *
   * 官方限制：最多保留最近 5 轮；每轮文本总长 ≤ 400 字符；**超出静默截断，不报错**。
   *
   * 默认留空 = 不发这个字段 = 行为和加这一项之前完全一致，没有回归风险。
   */
  const contextText = String(prompt || '').trim();
  if (contextText) {
    messages.push({ role: 'system', content: [{ type: 'input_text', text: contextText }] });
  }
  messages.push({ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUrl } }] });
  return {
    model,
    messages,
    stream: false,
    asr_options: asrOptions,
  };
}

/** 供测试用：这张映射表覆盖了哪些语种 */
export { DASHSCOPE_LANG };

/**
 * DashScope 的两个端点。**它们支持的模型不一样**,这点实测踩过:
 *
 *   兼容端点  /compatible-mode/v1/chat/completions
 *             ✓ qwen3-asr-flash
 *             ✗ qwen-audio-3.1-asr-flash
 *               → 404 `Unsupported model … for OpenAI compatibility mode`
 *   原生端点  /api/v1/services/aigc/multimodal-generation/generation
 *             ✓ qwen-audio-3.1-asr-flash / qwen-audio-3.0-asr-flash / fun-asr* / paraformer*
 *
 * **换模型名不等于只改名字** —— 端点和请求体形状都得跟着换。这是用户实测撞过的坑。
 */
export const DASHSCOPE_ENDPOINTS = {
  compatible: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  native: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
};

/**
 * 只认**原生端点**的模型名(前缀匹配)。
 * 其余一律按兼容端点处理 —— 那是本项目一直跑通的形状,不能因为加了新东西就改默认行为。
 */
const NATIVE_ONLY_MODELS = [
  'qwen-audio-3.1-asr-flash',
  'qwen-audio-3.0-asr-flash',
  'qwen-audio-3.1-asr-flash-filetrans',
  'qwen-audio-3.0-asr-flash-filetrans',
  'fun-asr',
  'paraformer',
];

/**
 * 决定用哪个端点。
 *
 * @param model    用户填的模型名(可随意改,所以不能只靠它)
 * @param mode     设置页里的选择:`auto` | `compatible` | `native`
 * @returns `{ url, kind }`
 *
 * ⚠️ **默认(`auto`)对认不出的模型名走兼容端点** —— 保住已经跑通的行为。
 * 认错的后果是 404,所以 `transcribeDashscope` 的 404 提示里会点明"可能要换端点"。
 */
export function pickDashscopeEndpoint(model, mode) {
  const m = String(model || '').trim().toLowerCase();
  const byModel = NATIVE_ONLY_MODELS.some((p) => m.startsWith(p)) ? 'native' : 'compatible';
  const kind = mode === 'native' || mode === 'compatible' ? mode : byModel;
  return { url: DASHSCOPE_ENDPOINTS[kind], kind };
}

/** 两个内置端点 —— 用来判断存下来的 `endpoint` 到底是"自定义地址"还是"陈旧的默认值" */
const BUILTIN_ENDPOINTS = new Set([DASHSCOPE_ENDPOINTS.compatible, DASHSCOPE_ENDPOINTS.native]);

/**
 * **唯一**的端点决定入口。生产路径和设置页的「测试识别连接」都必须走这里。
 *
 * ⚠️⚠️ 这个函数存在的理由,是一个踩过两次的 bug 类:
 *
 * `getSettings()` 是「已存设置深度合并盖在默认值上」——**已存值永远赢**。
 * 而 `endpoint` 这一项的默认值**变过**:
 *   · 早期版本默认写成兼容端点 URL  →  那时它会被存进 storage
 *   · 后来改成 `''`(留空=用自动选择) →  但**老用户 storage 里那个 URL 还在**
 * 于是 `config.endpoint || picked.url` 里那个已存值永远非空,
 * **自动选择永远轮不到** —— 用户填了 `qwen-audio-3.1-asr-flash`,
 * 请求却发去兼容端点,服务端回 404
 * `Unsupported model … for OpenAI compatibility mode`。
 * 更糟的是「强制选原生」也是坏的:原来的 `kind` 是 `config.endpoint ? 'explicit' : picked.kind`,
 * **只要 endpoint 非空就永远拿不到 `picked.kind`**。
 *
 * 同一个 bug 类上一次是 `delayBitsPerSecond`(改了默认值但没加迁移,老用户码率恒为 4 Mbps)。
 *
 * 修法两条一起:
 *   ① **判断值是不是内置地址**:等于内置地址的 `endpoint` 一律当作"没填" ——
 *      它不可能携带任何信息(`endpointMode` 才是表达"要哪个内置端点"的地方)。
 *      **真正的自定义地址(比如业务空间专属域名)仍然优先**,所以不会误伤。
 *   ② 另加一条 migration 清理掉 storage 里那个陈旧值(见 lib/settings.js)。
 *
 * @param model        用户填的模型名(可随意改,所以不能只靠它)
 * @param mode         设置页的选择:`auto` | `compatible` | `native`
 * @param rawEndpoint  设置页的「端点地址」——**只在它是真正的自定义地址时才生效**
 * @returns `{ url, kind }`,`kind` 可能是 `'explicit'`
 */
export function resolveDashscopeEndpoint(model, mode, rawEndpoint) {
  const custom = String(rawEndpoint || '').trim();
  // 只有"非空 且 不是内置地址"才算用户真的指定了自定义端点
  if (custom && !BUILTIN_ENDPOINTS.has(custom)) {
    return { url: custom, kind: 'explicit' };
  }
  return pickDashscopeEndpoint(model, mode);
}

/** 供测试用:两个内置端点 */
export { BUILTIN_ENDPOINTS };

/**
 * 拼**原生端点**的请求体。
 *
 * 与 `buildDashscopeBody`(兼容端点)分开写是刻意的 —— 两套形状完全不同,
 * 混成一个大函数最容易让已经跑通的兼容那支被改坏。
 *
 * 官方 curl 示例(纯音频):
 *   { model, input:{messages:[{role:'user',content:[{type:'input_audio',input_audio:{data}}]}]},
 *     parameters:{format:'wav',sample_rate:16000} }
 *
 * 带上下文(「提升识别准确率」指南):在音频消息**之前**插
 *   `{role:'user',content:[{type:'input_text',text}]}`,后面可再跟一条 assistant。
 *
 * 带即时热词:原生端点下 `parameters.vocabulary` 才有效
 *   `{"张三":5}` —— 权重 [1,5] 推荐 4;`50` = 超级热词(最多 50 个)。
 *   兼容端点下这个字段无效,所以只在原生这支里发。
 */
export function buildDashscopeNativeBody({ model, language, dataUrl, prompt, hotwords }) {
  const parameters = {
    format: 'wav',
    /**
     * ⚠️ **必须是字符串**,不是数字。
     *
     * 官方 API 参考里 `sample_rate` 的类型写的是 `string`,curl 示例也是
     * `"sample_rate": "16000"`(带引号)。这里原来发的是数字 `16000` ——
     * 实测服务端**没有报错**(请求拿到了 HTTP 200),所以问题不会自己暴露;
     * 但"没报错"和"生效了"是两回事:**类型不对时服务端很可能直接忽略它**,
     * 于是采样率根本没被声明,识别质量悄悄变差。
     * 这类"静默不生效"比报错难查得多,所以按文档的类型发。
     */
    sample_rate: '16000',
  };

  /**
   * 语种。原生端点用 `language_hints`(官方在「提升识别准确率」里点名:
   * 「`language_hints` 是语音识别接口的参数,用于声明音频语种」)。
   * ⚠️ 形状按 DashScope 惯例写成数组 ——**这一点没有官方示例可对照,未经验证**;
   * 若服务端因此报 400,把设置页的语种改成「自动检测」即可绕开。
   */
  if (language && language !== 'auto') {
    const code = DASHSCOPE_LANG[language];
    if (!code) {
      throw new Error(
        `阿里云百炼不支持语种「${language}」—— 到设置页换一个（它支持 zh / en / ja / ko / es / fr / de / ru / pt / it 等，选「自动检测」则不指定语种）。`,
      );
    }
    parameters.language_hints = [code];
  }

  const messages = [];
  const contextText = String(prompt || '').trim();
  if (contextText) {
    messages.push({ role: 'user', content: [{ type: 'input_text', text: contextText }] });
  }
  messages.push({ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUrl } }] });

  /**
   * 即时热词。**留空就不发这个字段** —— 保证"用户不填时请求体和没这一项时一致"。
   * 格式:设置页里每行 `词` 或 `词:权重`;权重缺省用 4(官方推荐起始值)。
   */
  const vocab = parseHotwords(hotwords);
  if (Object.keys(vocab).length) parameters.vocabulary = vocab;

  return { model, input: { messages }, parameters };
}

/**
 * 热词的长度是否合规范（官方：含非 ASCII 按总字符数 ≤ 15；纯 ASCII 按空格切分 ≤ 7 段）。
 *
 * ⚠️ **判据只留这一处。** 用户手填的热词（`parseHotwords`，超了抛错）
 * 和内置术语表（`mergeGlossaryHotwords`，超了跳过）都调它 ——
 * 这个项目被"两份实现只修一份"坑过好几次，所以规则不复制。
 */
/** 内置术语表并入热词时，「被跳过」的说明只报一次（词表不变的话每句都一样） */
let hotwordNoteSent = false;

export function hotwordLengthOk(word) {
  const w = String(word || '').trim();
  if (!w) return false;
  const isAscii = /^[\x20-\x7E]+$/.test(w);
  return isAscii ? w.split(/\s+/).filter(Boolean).length <= 7 : [...w].length <= 15;
}

/**
 * 把内置术语表的源词并进用户手填的热词。
 *
 * ⚠️ 两批词的**错误处理是不同的**，这是刻意的:
 *   · 用户手填的 → 交给 `parseHotwords`，**不合法就抛错** —— 是他自己写的，要说清哪里错
 *   · 内置词表的 → **跳过不合规范的**，只统计条数 —— **内置词表不该让整个请求 400**
 *     而且用户没改过它，报错他也无从下手
 *
 * 去重时**用户手填的优先**（同名词以他的为准）。
 * 返回 `text` 供 `parseHotwords` 继续解析；`added`/`dropped` 用来在设置页和诊断里**说明发生了什么**
 * —— 静默丢弃是另一条老教训。
 */
export function mergeGlossaryHotwords(userText, glossaryWords, { maxWords = 2000 } = {}) {
  const lines = String(userText || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const have = new Set(lines.map((l) => (l.split(':')[0] || '').trim().toLowerCase()).filter(Boolean));
  let added = 0;
  let dropped = 0;
  let overflow = 0;
  for (const w of glossaryWords || []) {
    const word = String(w || '').trim();
    if (!word) continue;
    // 官方长度规范 —— 内置词表里超长的直接跳过（不让整个请求挂掉）
    if (!hotwordLengthOk(word)) {
      dropped += 1;
      continue;
    }
    const key = word.toLowerCase();
    if (have.has(key)) continue;
    if (have.size >= maxWords) {
      overflow += 1;
      continue;
    }
    have.add(key);
    lines.push(word);
    added += 1;
  }
  return { text: lines.join('\n'), added, dropped, overflow };
}

/**
 * 给**本地 Whisper** 拼提示词：用户写的「提示词」+「识别热词」（+ 可选的术语表源词）。
 *
 * ⚠️ 为什么单独做一层，而不是让用户把词全写进「提示词」框：
 *
 *   ① **术语表是翻译用的词表**，整表塞进 prompt 会严重带偏识别（项目实测过，
 *      见 options.html 那段"加一堵英文术语 → 严重损坏"）。所以这里只按**热词**收：
 *      短、去重、限量、超长直接跳过 —— 不做"整表拼接"。
 *   ② 提示词是**散文**（"日语直播、说话快"），热词是**词表**。混在一个框里，
 *      用户想只改一个都做不到。
 *   ③ Whisper 只用 prompt 的**末尾 224 token** —— 写长了**前面会被截掉**。
 *      所以顺序必须是「先用户提示词，后热词」，而且总长有硬上限（`maxChars`）。
 *
 * 超出上限时**从尾部丢词**，绝不动用户写的提示词（那是他主动要的上下文）。
 *
 * @param {{prompt?:string, hotwords?:string, glossary?:string[], includeGlossary?:boolean,
 *          language?:string, maxWords?:number, maxChars?:number, maxGlossary?:number,
 *          liveHotwords?:string[], includeLiveHotwords?:boolean, maxLive?:number}} [o]
 * @returns {{text:string, hotwords:number, truncated:boolean, live:number, liveTotal:number}}
 */
export function buildWhisperPrompt({
  prompt = '',
  hotwords = '',
  glossary = [],
  includeGlossary = false,
  language = '',
  maxWords = 20,
  maxChars = 140,
  maxGlossary = 8,
  /**
   * 内置「直播热词」（有序数组）。开关打开时并进来 ——
   * 而它**和用户手填的共用** `maxWords` / `maxChars` 两个上限，
   * 也就是说：开这个开关**不会让 prompt 变长**，只会占用原本空着的额度。
   */
  liveHotwords = [],
  includeLiveHotwords = false,
  /** 内置直播词最多贡献几个（用户手填的永远不受这个上限影响） */
  maxLive = 20,
} = {}) {
  const base = String(prompt || '').trim();
  const words = [];
  const seen = new Set();
  /** 因为**数量或长度**没带上的词（超长词不算在内 —— 那是"这个词本身不合格"） */
  let overflow = 0;
  const push = (raw) => {
    const w = String(raw || '')
      .trim()
      .replace(/[,\u3001]+$/g, '');
    if (!w) return;
    // 超长词跳过 —— 宁可少带一个，也别让 prompt 被一段长文本带偏
    if (!hotwordLengthOk(w)) return;
    const key = w.toLowerCase();
    if (seen.has(key)) return;
    if (words.length >= maxWords) {
      overflow += 1;
      return;
    }
    seen.add(key);
    words.push(w);
  };
  // 用户手填的优先。容忍逗号/顿号 —— 用户不会去读"每行一个"那句话
  for (const part of String(hotwords || '').split(/[\n,\u3001]+/)) push(part);

  /**
   * 内置「直播热词」排在**用户手填之后、术语表之前**：
   *   ① 用户手填的是被特定内容坑出来的，必须优先（同名词以他的为准，`push` 里去重）
   *   ② 术语表（翻译用）最杂，放最后 —— 它被挤掉时损失最小
   *
   * ⚠️ 它受**同一套** `maxWords` / `maxChars` 管，所以"打开开关"不会让 prompt 变长 ——
   * 只会占用原本空着的额度。这条用"关掉时逐字节相同"来保证（smoke-test 里钉着）。
   * 也正因为如此：词表有 146 个词，而 140 字符只带得进最前面的十几个到二十个 ——
   * **顺序就是优先级**，别随便重排。
   */
  let liveUsed = 0;
  if (includeLiveHotwords) {
    for (const raw of liveHotwords || []) {
      if (liveUsed >= maxLive) break;
      const before = words.length;
      push(raw);
      if (words.length > before) liveUsed += 1;
    }
  }
  /**
   * ⚠️ 被 `maxLive` / 长度上限挡掉的内置词**不计入 `overflow`** ——
   * 否则 `truncated` 会因为"内置词表本来就有 146 个"而**永远为真**，
   * 那条读数就彻底失去意义了（它原本是给"用户自己填超了"报警的）。
   * 内置词表带了多少，由返回值里的 `live` / `liveTotal` 单独报，调用点打到状态行。
   */
  /**
   * ⚠️ 术语表并进来时必须**筛语言**，否则会重演那个"一堵英文术语"的事故：
   * 内置直播术语表是 102 个词、786 字符，而且**英文排在前面**
   * （`superchat` / `super chat` / `membership`…），一合并就把 140 字符的额度全吃掉，
   * 日语音频收到的全是英文偏置 ✗
   *
   * 规则：语言明确是 C/日/韩时**只收非 ASCII 词**；`auto` 时也优先非 ASCII，
   * 且术语表最多贡献 `maxGlossary` 个词（用户手填的永远优先，不受这个上限影响）。
   */
  if (includeGlossary) {
    const lang = String(language || '').trim();
    const cjk = /^(ja|jp|zh|ko)/i.test(lang);
    const preferAscii = /^en/i.test(lang);
    let fromGlossary = 0;
    const ascii = (w) => /^[\x20-\x7E]+$/.test(w);
    const list = (glossary || []).map((w) => String(w || '').trim()).filter(Boolean);
    const nonAscii = list.filter((w) => !ascii(w));
    const asciiOnly = list.filter(ascii);
    // 英文流先放英文；其它（日/中/韩/auto）先放非 ASCII —— 顺序本身就是"哪个更可能用得上"
    const ordered = preferAscii ? [...asciiOnly, ...nonAscii] : [...nonAscii, ...asciiOnly];
    for (const w of ordered) {
      if (fromGlossary >= maxGlossary) break;
      if (cjk && ascii(w)) continue;
      const before = words.length;
      push(w);
      if (words.length > before) fromGlossary += 1;
    }
  }

  const sep = ', ';
  let text = base;
  let used = 0;
  for (const w of words) {
    const next = text ? text + sep + w : w;
    if (next.length > maxChars) {
      overflow += words.length - used; // 剩下的都塞不下了，一次记清
      break;
    }
    text = next;
    used += 1;
  }
  return {
    text,
    hotwords: used,
    truncated: overflow > 0,
    /** 内置直播词实际带上了几个（0 = 开关关着，或全被挤掉了） */
    live: liveUsed,
    /** 内置词表一共几个 —— 用它报"只带了前 N 个"。 */
    liveTotal: (liveHotwords || []).length,
  };
}

/**
 * 解析热词输入。**每行一个**,支持 `词` 或 `词:权重`。
 *
 * 官方规范(照抄,超了要报错而不是静默丢):
 *   · 含非 ASCII 字符时,总字符数 ≤ 15
 *   · 纯 ASCII 时,按空格切分后片段数 ≤ 7
 *   · 权重 [1,5] 推荐 4;`50` = 超级热词(最容易召回,但全部超级热词加起来最多 50 个)
 */
export function parseHotwords(text, { maxSuper = 50 } = {}) {
  const out = {};
  let superCount = 0;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)(?::(\d+))?$/);
    const word = (m?.[1] || '').trim();
    if (!word) continue;
    const weight = m?.[2] ? Number(m[2]) : 4;
    if (!Number.isInteger(weight) || (weight < 1 || weight > 5) && weight !== 50) {
      throw new Error(`热词「${word}」的权重 ${m?.[2]} 不合法 —— 取 1~5（推荐 4），或 50（超级热词）。`);
    }
    // 官方长度规范:含非 ASCII 按总字符数;纯 ASCII 按空格切分的片段数
    if (!hotwordLengthOk(word)) {
      const isAscii = /^[\x20-\x7E]+$/.test(word);
      throw new Error(
        `热词「${word}」太长 —— ${
          isAscii ? '纯英文按空格切分不能超过 7 段' : '含中文/日文等字符时总长度不能超过 15 个字符'
        }。`,
      );
    }
    if (weight === 50) {
      superCount += 1;
      if (superCount > maxSuper) {
        throw new Error(`超级热词（权重 50）最多 ${maxSuper} 个。`);
      }
    }
    out[word] = weight;
  }
  return out;
}

export const meta = {
  id: 'vad',
  label: '本地 VAD 断句（全本地，延迟最低）',
  sampleRate: 16000,
  // 收句信号来自真正的语音检测，来得很及时 —— 按"流式"对待，
  // 播放页就不会给累积器套上"分片模式"那个很长的看门狗。
  streaming: true,
  docs: 'https://github.com/snakers4/silero-vad',
};

/** 识别请求超时：服务卡住时要报错，不能永远沉默 */
/**
 * ⚠️ 「人声量级」的门槛。
 *
 * ⚠️⚠️ **它现在不参与任何判定** —— 两处曾经用它当"响不响"的尺子，
 * 而**两处都因为它在低电平的流上够不着而失效了** ✗（实测那条流的 RMS 只有 0.012 ✗）：
 *   · 「疑似 VAD 失效」那句警告 → 改用**相对该流自己底噪**的口径（见 `vadLevelStats`）
 *   · 「合理断句」的回看低谷 → 改用**相对这一段自己常态电平**的口径（见 `findLullCut`）
 *
 * ⚠️ 保留它是因为**它仍是一个有意义的刻度**（"这个电平在正常语料里算人声"），
 * 而删掉会让"低电平的流"这件事在代码里**无处可查** ✗。
 * **但谁都不该再拿它当判据** —— 那正是这两处失效的原因 ✓
 */
export const HUMAN_LEVEL_RMS = 0.03;

/**
 * 分位数 —— ⚠️ **全项目只有这一份**。
 *
 * 「这一段流自己的电平长什么样」在**两处**都要用：断句的回看（`findLullCut`）
 * 和 VAD 心跳那几栏（`vadLevelStats`）。而它俩原来各自写了一遍同样的排序取位 ✗ ——
 * 那种"同一事实记两遍"正是这一轮反复踩的坑，所以提到这里。
 *
 * ⚠️ 取的是**排序后按 `round((n-1)*pct)` 落位**，样本少时也不会越界 ✓
 * ⚠️ 输入里的非有限值要**先滤掉**（`NaN` 参与排序会让结果不可预测 ✗）
 */
export function quantile(values, pct) {
  const a = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((x, y) => x - y);
  if (!a.length) return NaN;
  const p = Number.isFinite(Number(pct)) ? Number(pct) : 0;
  const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)));
  return a[i];
}

/**
 * 「合理断句」的回看窗口：`min(1.5s, 上限 × 40%)`。
 *
 * ⚠️ **为什么不能随上限一起放大**（想清楚才写的，不是随手取的数）：
 *
 * 回看找的是**换气**，而换气是个**物理事件** —— 100~300ms 的低谷，
 * 它的间隔**和"这一段有多长"无关**。所以上限调大时，窗口不该跟着变大。
 *
 * 而更要紧的是：**窗口一放大，"你设的数"就不再是你得到的数** ✗
 *   上限 8 秒、窗口也放大到 4 秒 → 回看 4 秒内**几乎总能找到**某个低谷
 *   → 实际切点常年落在 4 秒附近 → **用户设的 8 秒被偷偷改成了 4 秒**
 * 这正是这一轮反复出现的形态（`必须带 /v1`、`偶数才安全`、
 * "0 字节"被读成另一层的意思），所以这里显式钉住：**上限大时窗口不变**。
 *
 * ⚠️ **但上限很小时必须有比例保底**，否则反而制造碎片：
 *   上限 2 秒、窗口还是 1.5 秒 → 实际段长掉到 0.5~2.0 秒，太激进 ✗
 *   → `min(1.5, 2 × 0.4) = 0.8s` → 实际 1.2~2.0 ✓
 *
 * 效果：上限 8s → 1.5s · 5s → 1.5s · 3.5s → 1.4s · 2s → 0.8s（保底生效）
 */
export function lullLookbackMs(maxSpeechMs, { capMs = 1500, ratio = 0.4 } = {}) {
  const max = Number(maxSpeechMs);
  if (!Number.isFinite(max) || max <= 0) return capMs;
  return Math.min(capMs, max * ratio);
}

/**
 * 「合理断句」的回看：到「单句上限」时，把切点从"时间到的那一刻"挪到最近的换气处。
 *
 * 问题在于 `VadGate` 到上限时是按**时间**硬切的（`reason === 'max-length'`），
 * 切点落在"第 5 秒时正在说的那个音"上 —— 实测日志里就是 `5.2s 一句（超长被切断）`。
 * 那句话本身可能是完整的，但切在词中间就会让两边的识别都缺字。
 *
 * 做法：在末尾往回 `lookbackMs` 的范围内算**逐采样**的能量包络（窗长 `windowMs`），
 * 找**最靠后的、持续够久**的一段"明显低于**这一段自己的**常态电平"的区间 ——
 * **那多半是一次换气**；把切点挪到那段的中心。找不到就返回 0，行为**逐字退回原样**，
 * 所以只可能变好。
 *
 * ⚠️ 四条边界（都是踩过或想过才会写的）：
 *   ① 回看窗口**必须有界**（默认 1.5s）—— 不设界的话极端情况会一路退回 3 秒，
 *      变成 3+5，**反而更碎** ✗
 *   ② ⚠️ **门槛是相对的**（`lullRatio` + `silentRms`），**不是** `HUMAN_LEVEL_RMS` ✗
 *      —— 绝对门槛在低电平的流上会失效，见 `opts` 里那段（实测 RMS 0.012 的流 ✗）
 *   ③ 末尾 `keepMs` 之内**不看** —— 否则"最低点"可能只是最后一个采样，
 *      等于把切点挪了 0 个采样，白算
 *   ④ ⭐ **低谷必须"持续"够久才算换气**（`minLullMs`，见下）—— 这是最关键的一条
 *
 * ⚠️⚠️ 为什么必须有第 ④ 条（**实测踩出来的**，改之前的行为是错的）：
 *
 *   改之前只看**单个 30ms 窗的最低 RMS**，于是：
 *     · 40ms 的短弱音（词中间的 っ / ん / 摩擦音 s）**就会被选中** ✗
 *     · 而"换气"和"词中弱音"混在一起时，因为旧循环是**从末尾往回**扫、
 *       判据又是 `rms < bestRms`（**严格小于**），两个同样安静的窗谁也**不小于**谁，
 *       **先遇到的赢** —— 而先遇到的是**更靠后**的那个 ✗
 *     · 实测（E 组对照）：
 *       200ms 真换气 @3.7s ＋ 30ms 弱音 @4.4s → **切点落在那个 30ms 弱音上** ✗
 *       —— 那就在**词中间**，正是"偶尔切得不合理"的来源
 *     · 而且整段都安静时（背景音乐小声）它照样挪，实测挪走 1.34s ✗
 *
 *   所以现在要求：**连续 `minLullMs` 毫秒都低于阈值**才算一次换气 ✓
 *     · 40 / 80ms 的弱音**不会被认** ✓
 *     · 100ms 以上的真换气**会** ✓
 *
 *   ⚠️ 包络减掉了 `windowMs`（两端各半窗），所以**实际能认出的低谷 ≈ `minLullMs` + `windowMs`**：
 *      `minLullMs = 80` + `windowMs = 10` ⇒ 实际下限约 **90ms**。
 *      （取 80 而不是 100~150，是因为两边的实测用例卡在 80ms 必拒 / 100ms 必收，
 *        80 让两侧各留约 10ms 余量 ✓）
 *
 *   还有一条对照（否则会误判）：**整个回看范围内必须至少有一个窗高于阈值**。
 *     整段都安静时那个"最低点"只是噪声，不是换气 ✗ → 直接不挪 ✓
 *
 *   ⚠️ 关于"同等低时选哪个"：旧写法在**打平**时选最靠后的，而上面第 ④ 条一上，
 *     打平就不再是问题（短弱音根本进不了候选）✓；而"最靠后的合格低谷"其实**更好** ——
 *     它离上限最近，挪走的音频最少 ✓（选最靠前的会让段短得多，反而更糟 ✗）
 *
 * @param {Int16Array} pcm 这一句的音频（和 `speechProb` 同一口径：int16）
 * @param {number} sampleRate 采样率（16000）
 * @returns {number} 要从末尾**往回挪多少采样**；**0 = 没找到换气处，别动**
 */
export function findLullCut(pcm, sampleRate, opts = {}) {
  const {
    lookbackMs = 1500,
    // ⚠️ 10ms 而不是 30ms：要能把 80ms 与 100ms 的低谷分开，30ms 的栅格分不开 ✗
    windowMs = 10,
    minLullMs = 80,
    keepMs = 300,
    /**
     * ⚠️⚠️ **门槛是相对的** —— 「低谷」= 明显低于**这一段自己的常态电平**，
     * 而不是低于某个绝对数 ✗（实测踩出来的，见下）
     *
     * 旧写法是 `loudRms = HUMAN_LEVEL_RMS`（**0.03**），而实测那份真素材
     * （`livedtranslate-20261016-032318.wav`）**整条流的 RMS 只有 0.01200** ✗ ——
     * 比门槛还低 ⇒ 逐帧只有 **4.0%** 的帧够得着 0.03。
     *
     * 于是那两条建立在它上面的规则在**低电平的流上同时失效** ✗：
     *   · 「必须确实低于门槛才算安静」→ 这类流上**几乎处处都低于** ⇒ 到处都被当成换气 ✗
     *     ⇒ 切点会在**没换气的地方也挪** —— 正是「偶尔开了反而切得不合理」的第二个来源
     *   · 「回看范围内必须有响的地方」（`maxRms >= loudRms`）→ 而这只是"1.5 秒里
     *     至少有一个窗够得着"，4% 的流上时有时无 ⇒ 判据本身在飘 ✗
     *
     * 新口径（两把尺子，都不是新造的常数）:
     *   · `lullRatio`  低谷线 = **这一段回看范围内的高分位** × 它 ⇒ 相对，随流走 ✓
     *   · `silentRms`  绝对地板（复用 `SILENT_LEVEL_RMS`）—— 只用来挡"整段本来就接近无声"，
     *                  那种流里任何微小起伏都会被当成低谷 ✗
     */
    lullRatio = 0.5,
    silentRms = SILENT_LEVEL_RMS,
    /** 高分位（"这一段的常态电平"）—— 中位会被低谷本身拉低 ✗ */
    ceilPct = 0.9,
  } = opts;
  const rate = Number(sampleRate);
  if (!pcm || !pcm.length || !Number.isFinite(rate) || rate <= 0) return 0;

  const win = Math.max(1, Math.round((windowMs / 1000) * rate));
  const lookback = Math.round((lookbackMs / 1000) * rate);
  const keep = Math.round((keepMs / 1000) * rate);
  const end = pcm.length;
  const lowLimit = Math.max(0, end - lookback);
  const highLimit = end - keep;
  // 可看的范围太窄就不看 —— 免得把"最后一个窗"当成换气处
  if (highLimit - lowLimit < win) return 0;

  // ---- 1) 前缀和 → 逐采样 RMS（覆盖到 i 为止的 win 个采样）----
  //   O(n)，只在每次收句时算一次，代价可忽略
  const prefix = new Float64Array(end + 1);
  for (let i = 0; i < end; i += 1) {
    const v = (pcm[i] || 0) / 32768;
    prefix[i + 1] = prefix[i] + v * v;
  }
  const firstIdx = lowLimit + win - 1; // 包络能取到的最早位置
  const rmsAt = (i) => {
    const from = Math.max(0, i - win + 1);
    const cnt = i - from + 1;
    if (cnt <= 0) return 1;
    return Math.sqrt((prefix[i + 1] - prefix[from]) / cnt);
  };

  // ---- 2) 参照物：**这一段自己的常态电平**（高分位）----
  //   ⚠️ 不拿绝对门槛当"响不响"的尺子：实测那条 RMS 0.012 的流比 0.03 还低 ✗
  //   ⚠️ 用高分位而不是中位：中位会被低谷本身拉低（一次换气能占掉回看窗口的一大截 ✗）
  const env = [];
  for (let i = firstIdx; i < highLimit; i += 1) env.push(rmsAt(i));
  const ceil = quantile(env, ceilPct);
  //   整段本来就接近无声 → 那里任何微小起伏都会被当成低谷 ✗ → 不挪
  if (!(ceil >= silentRms)) return 0;
  const lullLine = ceil * lullRatio;

  // ---- 3) 找**最靠后的、持续够久**的低谷 ----
  //   从 highLimit-1 往回扫，累计"连续低于**这一段自己的低谷线**"的长度；
  //   第一次攒够 needSamples 的那一段，就是**最靠后的合格低谷** ✓
  const needSamples = Math.max(1, Math.round((minLullMs / 1000) * rate));
  let run = 0;
  for (let i = highLimit - 1; i >= firstIdx; i -= 1) {
    if (env[i - firstIdx] < lullLine) {
      run += 1;
      if (run >= needSamples) {
        // 该段的中心（往下扫时 i 是这段**最早**的那个采样）
        const center = i + Math.floor(run / 2);
        const back = end - center;
        return back > 0 && back <= lookback ? back : 0;
      }
    } else {
      run = 0;
    }
  }
  // 一个够长的低谷都没有（比如整段都很响，或者低谷都太短）→ 退回原样 ✓
  return 0;
}

export const TRANSCRIBE_TIMEOUT_MS = 20000;

/**
 * 那一行末尾的**读数后缀**（只印，不参与判定）。
 *
 * ⚠️ 加它的理由：用户实测里被丢的那两句**只超 `no_speech_prob` 阈值 0.01~0.02**，
 * 而 `avg_logprob` 有没有一起变差 —— **日志里从来没印过，所以没人知道** ✗
 * 于是"要不要改成两项同时变差才丢"这件事**没有依据可判**。
 * 把两项一起印出来，下次复现时那一行就能直接判定，不用猜。
 *
 * ⚠️ 值缺失时印 `?`（某些后端不给这两个字段）—— **别印 `undefined`/`NaN`** ✗
 * ⚠️ 数值收成两位小数 —— 本项目刚为 `**迟到 98.37255859375ms**` 那种精度改过一次 ✗
 */
function readingNote(q) {
  const lp = q.lpSeen > 0 ? q.minLogprob.toFixed(2) : '?';
  const tp = q.tempSeen > 0 ? q.maxTemperature.toFixed(2) : '?';
  return ` · 读数 avg_logprob ${lp} · temperature ${tp}`;
}

/**
 * 质量闸门的**读数**（给诊断用，**不参与判定**）。
 *
 * ⚠️ 它只服务上面那个读数后缀：把这一段里最差的两个值取出来，
 * 让「丢弃一段识别结果」那行能一并印出 `avg_logprob` 与 `temperature` ——
 * 否则下次再遇到"看着正常却被丢"的句子，仍然没有依据判断该往哪边调 ✗
 *
 * @returns {{segs:number, fallback:number, noSpeech:number, lowConf:number,
 *            maxNoSpeech:number, minLogprob:number, maxTemperature:number,
 *            tempSeen:number, lpSeen:number}}
 *
 * ⚠️ `tempSeen` / `lpSeen` 是"**有几个 segment 真的带了这个字段**"——
 * 用来把"值就是 0"和"后端没给这个字段"分开（前者印 0.00，后者印 `?`）✓
 * ⚠️ **判定不看这里** —— 闸门本身是 `createSession` 里那个 `rejectReason`，
 *    它按 v2.66.31 的写法逐段检查、**任一段触发即丢** ✗（这里只是印）
 */
export function qualityStats(data) {
  const segs = (Array.isArray(data?.segments) ? data.segments : []).filter(
    (s) => s && typeof s === 'object',
  );
  let fallback = 0;
  let noSpeech = 0;
  let lowConf = 0;
  let maxNoSpeech = 0;
  let minLogprob = 0;
  let maxTemperature = 0;
  let tempSeen = 0;
  let lpSeen = 0;
  for (const s of segs) {
    const t = Number(s?.temperature);
    if (Number.isFinite(t)) {
      tempSeen += 1;
      if (t > maxTemperature) maxTemperature = t;
      if (t > 0) fallback += 1;
    }
    const ns = Number(s?.no_speech_prob);
    if (Number.isFinite(ns)) {
      if (ns > maxNoSpeech) maxNoSpeech = ns;
      if (ns > 0.6) noSpeech += 1;
    }
    const lp = Number(s?.avg_logprob);
    if (Number.isFinite(lp)) {
      lpSeen += 1;
      if (lp < minLogprob) minLogprob = lp;
      if (lp < -1.0) lowConf += 1;
    }
  }
  return {
    segs: segs.length,
    fallback,
    noSpeech,
    lowConf,
    maxNoSpeech,
    minLogprob,
    maxTemperature,
    tempSeen,
    lpSeen,
  };
}

/**
 * 把"被拒的段数"按**原因**凑成可读的一段（只列非零的）。
 *
 * ⚠️ 为什么必须分开：原先只有一个计数器，而它被印成「已拦掉 N 段**幻听**」✗ ——
 * 于是看到那行的人会以为"幻听清单拦了 N 段"，而它其实**主要**数的是数值闸门。
 *
 * 两者的处置方向**完全相反**：
 *   · `幻听套话` 命中 → **黑名单在干活** ✓（好事，说明兜底有效）
 *   · `闸门` 触发     → "这段被判没人说话 / 置信度低" —— **而那可能正是误杀** ✗
 *     （实测：一句 30 字通顺日语因 `no_speech_prob=0.66` 被丢，而它的
 *      `avg_logprob` 是 -0.14 —— 好得很）
 *
 * 混成一个数字就没法判断该往哪个方向查。
 *
 * ⚠️ 提到**模块级**是为了可测：计数器在 `createSession` 的闭包里，函数在里面就测不到。
 */
export function rejectedSummary(hallu, gate, empty, carried, fast) {
  const out = [];
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (n(hallu) > 0) out.push(`幻听套话 ${n(hallu)}`);
  if (n(gate) > 0) out.push(`闸门 ${n(gate)}`);
  if (n(empty) > 0) out.push(`空文本 ${n(empty)}`);
  /**
   * ⭐ 「字数/时长不合理」（v2.66.76 起真的丢）—— 它和「幻听套话」是**两种不同的幻觉**：
   *   · 套话命中 → 那句话**内容**是固定模板（`ご視聴ありがとうございました`）
   *   · 这条     → 内容不定，但**字数超过这段音频物理上能说出的量**
   * 两者要分开列，否则"黑名单拦了几个"和"算术判据拦了几个"混在一起，
   * 下次看到「已拦掉 幻听套话 3」就判断不出是哪一层在干活 ✗
   */
  if (n(fast) > 0) out.push(`字数时长 ${n(fast)}`);
  /**
   * ⚠️ 接力（保留了音频、拼到下一句重识）**不是"拦掉"**，所以它不能并进上面那个列表 ——
   * 否则那行会读成「已拦掉 空文本接力 3」，而它们恰恰是被**救回来**的。
   */
  const tail = n(carried) > 0 ? ` · 空文本接力 ${n(carried)}` : '';
  return (out.length ? ` · 已拦掉 ${out.join(' / ')}` : '') + tail;
}

/**
 * ⚠️ 「这一段流本身就接近无声」的电平地板（RMS）—— **只给诊断用，不参与断句**。
 *
 * 为什么不拿 `HUMAN_LEVEL_RMS`（0.03）当这个门：**它对低电平的流够不着** ✗
 *
 * 实测（用户给的那份真素材，20 秒 16kHz 单声道）:
 *   · 有内容的流整体 RMS **0.01200**，而逐帧**只有 4.0%** 超过 0.03
 *   · 同一段流里那些**真的安静**的片段是 **0.0009 ~ 0.0012**
 * → 0.03 落在"有内容"之上 ⇒「电平够高」这个条件**永远不成立** ✗
 *   ⇒ `deaf` 恒为 false ⇒ **设计来抓"VAD 不认"的那句警告，在它该响的场景下永远不响** ✗
 *
 * 所以诊断这一路换两把尺子:
 *   ① **相对该流自己的安静底噪**（`quietFloor`）—— "现在有没有声音"本来就是相对的事
 *   ② 再加这条**绝对地板**，只用来排除"这条流本来就接近无声"
 *      （实测"真安静"0.0009~0.0012，0.003 比它高 2.5 倍以上；而"有内容"0.012 比它低 4 倍）
 *
 * ⚠️ 断句那一路（`findLullCut` 的 `loudRms`）**原来也踩了同一个坑** ——
 * 它拿 `HUMAN_LEVEL_RMS`（0.03）当"这里是不是安静"的尺子 ✗，
 * 而实测那条流整条 RMS 只有 0.012 ⇒ **几乎处处都"低于门槛"** ⇒ 到处都被当成换气 ✗
 * ⇒ 切点会在**没换气的地方也挪**（「偶尔开了反而切得不合理」的第二个来源）。
 * 现已改成**相对这一段自己的常态电平**（`lullRatio` + `silentRms`）✓
 */
export const SILENT_LEVEL_RMS = 0.003;

/**
 * ## VAD 支路的归一化
 *
 * **为什么需要它（实测）**：Silero 对**小声的语音**给不出概率。
 * 用户导出日志里那 12 秒，VAD 全判"静默"，而 `输入电平` 只有 **0.0016 ~ 0.0029** ✗ ——
 * 而那条流的常态是 0.0034 ~ 0.0045 ⇒ **那 12 秒比平时小了 1.5~2 倍** ✗。
 * 而**同一段音频离线整段喂 Whisper，它把那 12 秒的话全认出来了** ✓
 * ⇒ **音频里有语音，只是 VAD 认不出** ✓
 *
 * 真机衰减实验（真模型、真音频）给出拐点：
 * ```
 *   ×0.116（peak 0.013）→ >0.5 占 19% ✓ 仍然正常
 *   ×0.01 （peak 0.0011）→ >0.5 占  0% ✗ 聋
 * ```
 * 而那 12 秒 RMS 0.0016~0.0029 ≈ peak 0.006~0.01 ⇒ **正好卡在拐点上** ✗
 * ⇒ 放大 **4~8 倍**就够把它拉回能用的一侧 ✓（AGC 的 `maxGain = 4` 差一点 ✗）
 *
 * ⚠️ **只归一化 VAD 这一支**：送 Whisper 的音频一个字不动 ✓
 * （Whisper 对电平很鲁棒，而它现在工作得好 —— 改它只会引入新变量 ✗）
 *
 * ⚠️⚠️ **绝不能把静音放大**：否则 VAD 会把噪声认成语音 ⇒ 幻觉字幕 ✗
 * 所以增益是**相对这条流自己的底噪**判的 —— 明显高于底噪才放大，
 * 且**封顶**（`vadGainFor` 的 `maxGain`）。纯底噪块拿到的是 **1×**（不动）✓
 */
export const VAD_NORM = {
  /**
   * 目标 RMS —— **取在"本来就正常"那一档的下沿**，不是取高的 ✗
   *
   * 实测那条流：常态 0.0034~0.0045，说话时 0.0096~0.0416；
   * 衰减实验里 ×0.116 那一档（peak 0.013 ⇒ RMS ≈ 0.009）**>0.5 仍占 19%** ✓
   * ⇒ 把目标定在 **0.010**：小声的语音被拉到这儿（正好落在"能认"的一侧），
   * 而**本来就正常的块不会被继续推高** ✓（那一栏的增益恒为 1）
   *
   * ⚠️ 别把目标定高（比如 0.035）：那会把 0.012 这种**健康的电平**也放大 3 倍 ✗，
   * 等于给所有本来工作正常的流都换了输入电平 —— 那是在引入新变量，不是在修 bug ✗
   *
   * ⚠️⚠️ **别再想"再抬一点就能救剩下那几句"** ✗ —— 实测数据已经把这条路堵死了：
   *
   *   v2.66.71 的导出日志里，归一化把 14 个心跳点的电平都打平到 ≈0.010，
   *   而同一批点的 VAD 概率是 **0.0084 ~ 0.9991（跨 119 倍）** ✗：
   *
   *     归一化 0.0100 → 概率 0.0281 / 0.0423 / 0.1306 / 0.4307 / 0.6202 / 0.8059 /
   *                            0.9225 / 0.9384 / 0.9393 / 0.9942 / 0.9991
   *     归一化 0.0096 → 概率 0.0084    ← 电平几乎一样，概率差两个数量级
   *
   *   ⇒ **电平已经不是变量了，概率仍然天差地别** —— 所以`maxGain` 抬到 8 或 10
   *     不会改变那个 0.0084 ✗（`targetRms` 同理）✗
   *   ⇒ 真正的差别在**那 640 个采样（40ms）里有什么**：局部信噪比 / 频谱形态，
   *     不是 RMS ✗ —— 那是模型的分辨能力，不是增益能修的 ✓
   *
   * ⚠️ 而**地板也挡不住什么**（这一点和直觉相反，实测过）：
   *   低于地板 0.0015 而**没被放大**的那几帧，VAD 照样说"说话中" ——
   *
   *     帧607  电平 0.0013 → 1×  · 概率 0.9879 · 连续 44 ✓
   *     帧910  电平 0.0000 → 1×  · 概率 0.7457 · 连续 26 ✓
   *     帧986  电平 0.0007 → 1×  · 概率 0.3489 · 连续 49 ✓
   *
   *   ⇒ 因为 Silero 有**状态**：已经在说话时，电平掉下去它仍然延续 ✓
   *   ⇒ 所以"把地板降低一点让更多块被放大"也没有收益 ✗
   *
   * ⭐ 那几句真的消失时，**瓶颈在别处**：那些分片里真正的语音只有 **0.2 秒**
   *   （日志原文：`识别结果和音频时长对不上（5 字 / 0.20s 说话，分片 0.7s 含静音 480ms）`）——
   *   而 Whisper 从那 0.2 秒里也只认出 5 字（实际约 10 字）✗
   *   ⇒ 这是**输入本身的信息量**问题，不是这条支路能修的 ✓
   */
  targetRms: 0.01,
  /**
   * 增益上限 —— **必须比"地板处的需求"低一点，否则它永远不会生效** ✗
   *
   * 地板处的需求 = `targetRms / 地板` = 0.010 / 0.0015 ≈ **6.67**
   * ⇒ 上限若取 8，那它在任何情况下都够不着 ⇒ **等于没有上限** ✗
   *   （实测：变异"去掉 Math.min"跑完 smoke **照样全绿** —— 那就是这个原因 ✓）
   * ⇒ 取 **6**：地板上的块被压到 6×（0.0016 → 0.0096，正好落在能认的一侧 ✓），
   *    而**它真的会拦住**更大的需求 ✓
   */
  maxGain: 6,
  /**
   * "这一块有内容"的**绝对**地板 = `SILENT_LEVEL_RMS × floorRatio`。
   *
   * ⚠️ 为什么用绝对地板、而不是"相对底噪的倍数"：
   * 实测那种流的**常态底噪**就是 0.0008~0.0012，而**小声的语音**是 0.0016~0.0029 ✗ ——
   * 两者只差 1.5~2 倍，任何"比底噪高 N 倍"的判据都会同时放过/同时挡掉 ✗
   * 而项目自己的 `SILENT_LEVEL_RMS = 0.003` 就是这么标定的：
   * 「真安静 0.0009~0.0012，有内容 0.012」⇒ 取它的一半（**0.0015**）正好落在两档之间 ✓
   */
  floorRatio: 0.5,
  /** 底噪估计的跟随速度：往下跟得快（怕被语音污染），往上跟得慢 */
  floorFall: 0.2,
  floorRise: 0.002,
};

/** 一块 int16 的 RMS（0~1 口径，和 `lastInputRms` 一致） */
export function blockRms(int16) {
  const n = int16?.length || 0;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = (int16[i] || 0) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/**
 * 底噪的慢速跟随 —— **纯函数**，便于单测。
 * 往下跟得快（一旦变安静就立刻认），往上跟得慢（免得把一段语音当成新底噪）。
 */
export function trackNoiseFloor(prev, rms, opts = {}) {
  const { floorFall, floorRise } = { ...VAD_NORM, ...opts };
  if (!Number.isFinite(rms) || rms < 0) return prev;
  if (!Number.isFinite(prev) || prev <= 0) return rms;
  const k = rms < prev ? floorFall : floorRise;
  return prev + (rms - prev) * k;
}

/**
 * 这一块该乘多少 —— **纯函数**。
 *
 * 三条规则，缺一不可：
 * ① **只放大、不衰减**（`Math.max(1, …)`）—— 这条支路的目的只是救小声的语音
 * ② **底噪附近不放大**（`rms < floor × speechAboveFloor` ⇒ 返回 1）
 *    ⚠️ 这一条是「不许把静音放大」的**唯一闸门**，别删
 * ③ **封顶** `maxGain`
 */
export function vadGainFor(rms, noiseFloor, opts = {}) {
  const { targetRms, maxGain, floorRatio } = { ...VAD_NORM, ...opts };
  if (!(rms > 0) || !Number.isFinite(rms)) return 1;
  /**
   * ⚠️ 这是「**不许把静音放大**」的唯一闸门，别删：
   * 低于 `SILENT_LEVEL_RMS × floorRatio` 的块**原样返回**（1×）。
   * 实测"真安静"0.0009~0.0012 卡在它下面 ✓，而"小声的语音"0.0016~0.0029 在上面 ✓
   */
  const floor = SILENT_LEVEL_RMS * floorRatio;
  if (rms < floor) return 1;
  const want = targetRms / rms;
  return Math.min(maxGain, Math.max(1, want));
}

/** 按增益缩放一块 int16（**不改变长度** —— 帧位置和绝对时间都不受影响 ✓） */
export function scaleInt16(int16, gain) {
  const g = Number(gain);
  if (!(g > 1) || !int16?.length) return int16;
  const out = new Int16Array(int16.length);
  for (let i = 0; i < int16.length; i += 1) {
    const v = Math.round((int16[i] || 0) * g);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/**
 * VAD 心跳那几栏的**纯计算** —— 把「有没有声音」和「VAD 认不认」两个判断集中到一处。
 *
 * ⚠️ 提到**模块级**是为了可测：这几行原本在 `createSession` 闭包里，
 * 而那条路要 ONNX 模型才跑得起来（Node 里跑不了）⇒ 判据改对了也没法验 ✗
 *
 * **旧判据为什么是坏的（实测）**:
 * ```
 *   const deaf = win.length >= 40 && loud.length >= win.length * 0.3 && loudPeak < 0.2;
 * ```
 * 而 `loud` 用**绝对**门槛 `HUMAN_LEVEL_RMS` 判定 ⇒ 实测那种流只有 4% 的帧够得着
 * ⇒ 30% 永远到不了 ⇒ **它在最该响的场景下恒为 false** ✗
 *
 * **新口径（全部相对该流自己的电平）**:
 *   · `quietFloor` 长窗的低分位 —— 这条流"没人说话时"的电平
 *   · `levelCeil`  长窗的高分位 —— "这条流能不能到有声的幅度"（**看它，不看底噪** ✗）
 *   · `levelUp`    最近一段的电平**明显高于自己的底噪** ⇒ 现在大概真的有人在说
 *   · `deaf`       满足上面两条，而 VAD 在这一段里**一次都没给过高概率** ⇒ 疑似失效
 *   · `sparse`     满足上面两条，VAD 也认了一些，但**最长连续达标帧 < 开口需要的帧数**
 *                  ⇒ 认得太稀，凑不满一次「开口」—— 这正是"有声音却一个字都出不来"的形态
 */
export function vadLevelStats({ recent = [], baseline = [] } = {}, opts = {}) {
  const {
    threshold = 0.5,
    exitThreshold = null,
    minSpeechMs = 250,
    frameMs = 40,
    deafPeak = 0.2,
    minFrames = 40,
    silentFloor = SILENT_LEVEL_RMS,
    levelUpRatio = 2,
    quietPct = 0.2,
    ceilPct = 0.9,
  } = opts;

  const list = (Array.isArray(recent) ? recent : []).filter(Boolean);
  const base = (Array.isArray(baseline) ? baseline : []).filter(Boolean);
  const rmsOf = (x) => (Number.isFinite(Number(x && x.rms)) ? Number(x.rms) : NaN);
  const pOf = (x) => (Number.isFinite(Number(x && x.p)) ? Number(x.p) : NaN);

  /** 低分位：用它当"这条流安静时"的电平（中位会被说话本身抬高 ✗） */
  const pick = (arr, pct) => quantile(arr, pct);

  const n = list.length;
  const quietFloor = pick(base.map(rmsOf), quietPct);
  const levelCeil = pick(base.map(rmsOf), ceilPct);
  const levelNow = pick(list.map(rmsOf), 0.5);
  /**
   * ⭐ 电平的**分布**，而不只是一个单点。
   *
   * ⚠️ 为什么要它:心跳那行的 `输入电平` 是**一帧**的值 ✗ ——
   * 而判断"这几秒是不是比平时小"需要的是分布。实测一次「12 秒没出分片」里,
   * 靠单点只能猜（0.0016 到底算小还是算静音？），靠分布能算出
   * 「那几秒比这条流的常态小 1.5~2 倍」✓。
   * ⚠️ 用**同一个 `quantile`**（不另造分位实现 ✗ —— 那是"同一事实记两遍"）。
   */
  const lvl = list.map(rmsOf);
  const levelP10 = pick(lvl, 0.1);
  const levelP50 = pick(lvl, 0.5);
  const levelP90 = pick(lvl, 0.9);
  /**
   * ⚠️ 「这条流有内容」要看**它能不能到有声的幅度**（高分为），**不能看底噪** ✗
   * 正常流的停顿段也接近数字静音（实测 0.0009~0.0012）——
   * 拿底噪当这条门，会把**每一条正常的流**都判成"接近无声" ✗（我第一版就是这么错的）
   */
  const hasSignal = Number.isFinite(levelCeil) && levelCeil >= silentFloor;
  const levelUp = hasSignal && Number.isFinite(levelNow) && levelNow >= quietFloor * levelUpRatio;

  /** 比底噪高出一截的帧 = "这一段里有声音的帧"（相对口径，不是绝对门槛 ✗） */
  const activeLine = Number.isFinite(quietFloor) ? quietFloor * levelUpRatio : Infinity;
  const activeCount = list.filter((x) => Number.isFinite(rmsOf(x)) && rmsOf(x) >= activeLine).length;
  const activeRatio = n ? activeCount / n : NaN;

  const probs = list.map(pOf).map((v) => (Number.isFinite(v) ? v : 0));
  const windowPeak = n ? Math.max(...probs) : NaN;

  /**
   * 最长连续达标帧 —— 直接和"开口要连续多少帧"比，不用另造一个比例 ✗
   *
   * ⚠️ **判据与状态机同源**（`vad-gate.js` 的 `longestSpeechRun` / `runContinues`）✓ ——
   * 这里原来另写了一遍 `p >= threshold`，而状态机那边同时改了两处就得记得改三处 ✗
   * （这个项目为"同一事实记两遍、只改一处"栽过很多次）。
   *
   * 同时报**两个口径**：
   *   · `maxRun`     **迟滞**（= 状态机现在真正用的）✓
   *   · `maxRunStrict` **严格**（= 改之前那个口径）
   * 两个数摆在一起，下一次日志就能**直接看出迟滞有没有救回那几句** ✓ ——
   * 而不是靠"改了之后应该会好"这种推断 ✗。
   */
  const maxRun = longestSpeechRun(probs, { threshold, exitThreshold, hysteresis: true });
  const maxRunStrict = longestSpeechRun(probs, { threshold, hysteresis: false });
  const need = Math.max(1, Math.ceil(Number(minSpeechMs) / Number(frameMs)));

  const observed = n >= minFrames;
  const deaf = observed && levelUp && Number.isFinite(windowPeak) && windowPeak < deafPeak;
  /** ⚠️ 用迟滞那个口径 —— 否则会出现"状态机已经开口了、而这里说它凑不满"的自相矛盾 ✗ */
  const sparse = observed && levelUp && !deaf && maxRun < need;

  return {
    n, quietFloor, levelCeil, levelNow, activeRatio,
    levelP10, levelP50, levelP90,
    windowPeak, maxRun, maxRunStrict, need, observed,
    hasSignal, levelUp, deaf, sparse,
  };
}

/**
 * ⭐ 电平**分布**那一行 —— 单独一行、低频（约每 30 秒一次），不挤进心跳 ✗
 *
 * ⚠️ 为什么不并进心跳那行:心跳那行已经 200 字符左右,
 * 再塞三个分位会让它读不动 ✗ —— 而这一项需要的是"偶尔看一眼趋势",不是逐帧 ✓
 *
 * @param {object} stats   `vadLevelStats` 的结果
 * @param {{seconds?:number, unopened?:number, beats?:number}} [opts]
 *   `unopened` = 自上次报以来「语音脉冲起头了、但没凑够开口线」的次数
 */
export function vadLevelDistLine(stats = {}, { seconds = 30, unopened = 0, beats = 0 } = {}) {
  const s = stats || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '?');
  const sec = Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Math.round(Number(seconds)) : '?';
  const un = Number.isFinite(Number(unopened)) ? Number(unopened) : '?';
  /**
   * ⚠️ 这里**不印"未开口"之外的判断** ✗ ——
   * `sparse` 那个状态已经说了"认得太稀、凑不满一次开口" ✓,
   * 而它是个**开关量**,回答不了"发生了多少次" ✗。
   * 所以这一行只补那个**计数**,不重复 sparse 的语义 ✓（同一事实不记两遍 ✗）。
   */
  return (
    `电平分布 · 近 ${sec}s · p10 ${num(s.levelP10, 4)} · p50 ${num(s.levelP50, 4)} · p90 ${num(s.levelP90, 4)}` +
    ` · 常态 ${num(s.quietFloor, 4)}` +
    ` · 未开口 ${un} 次${beats ? `（${beats} 次心跳内）` : ''}`
  );
}

/**
 * 把上面那份算出来的东西**印成一行**。
 *
 * ⚠️ 为什么单独一个函数：那一栏原来写「近 3s 有声 N%」，而 N 用的是**绝对**门槛
 * ⇒ 实测那种流恒在 0~11%，**读起来就是"没人说话"，而实际是"那栏的门槛够不着"** ✗
 * 于是读日志的人（包括写这段的人）会照它推出完全相反的结论。
 * 所以现在**把参照物一起印出来**（`常态`），让那个百分比有东西可比 ✓
 */
export function vadLevelLine(stats = {}, { seconds = 3 } = {}) {
  const s = stats || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '?');
  const pct = Number.isFinite(Number(s.activeRatio)) ? Math.round(Number(s.activeRatio) * 100) : NaN;
  const sec = Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Math.round(Number(seconds)) : '?';
  const runTxt = Number.isFinite(Number(s.maxRun)) ? Number(s.maxRun) : '?';
  /**
   * ⚠️ 把**严格**那个口径也印出来（括号里）。
   *
   * 理由：`连续` 那一栏现在是状态机真正用的（迟滞）✓，而它和旧口径会有差 ——
   * 差值正好回答"迟滞救回了多少"。只印一个数的话，读日志的人**没法判断**
   * 那几句是靠迟滞救回来的，还是本来就够 ✓。
   */
  const strictTxt = Number.isFinite(Number(s.maxRunStrict)) ? `（严格 ${Number(s.maxRunStrict)}）` : '';
  const parts = [
    `常态 ${num(s.quietFloor, 4)}`,
    `概率峰值 ${num(s.windowPeak, 2)}`,
    `连续 ${runTxt} 帧${strictTxt} · 开口需 ${Number.isFinite(Number(s.need)) ? Number(s.need) : '?'} 帧`,
  ];
  let warn = '';
  if (s.deaf) {
    warn = ' ⚠ 有声音却一直不认，疑似 VAD 失效';
  } else if (s.sparse) {
    warn = ' ⚠ VAD 认得太稀，凑不满一次开口';
  }
  return ` · 近 ${sec}s 有声 ${Number.isFinite(pct) ? pct : '?'}%（${parts.join(' · ')}）${warn}`;
}

/**
 * VAD 有没有**确实**认了这一段语音？
 *
 * @param {number} opts.vadSpeechMs     这一段里 VAD 处于语音态多少毫秒（来自 `gate` 的 `speechFrames`）
 * @param {number} opts.vadMinSpeechMs  门槛 —— **复用 gate 自己的开口线**（`minSpeechMs`），不另造
 *
 * ⚠️ 为什么用 gate 的开口线当门槛，而不是另编一个数：
 *   `minSpeechMs` 就是"连续说这么久才算一句真的开始"那条线（滤咳嗽、桌椅响）。
 *   既然这句话**已经被 gate 当成一句真的说了**，那"VAD 认了语音"这件事就已经成立 ——
 *   用它当门槛是**同一个事实只记一处**。
 *
 * ⚠️ 注意 `speechFrames` 含的是**语音态内的全部帧**，不是"最长连续" ——
 *   而"最长连续"是另一件事（`vadLevelStats` 的 `maxRun`，那是诊断口径）。
 *   这里问的是"这一段整体是不是语音"，所以用整体帧数才对。
 */
export function noSpeechVetoed({ vadSpeechMs, vadMinSpeechMs } = {}) {
  const ms = Number(vadSpeechMs);
  const bar = Number(vadMinSpeechMs);
  if (!Number.isFinite(ms) || !Number.isFinite(bar) || bar <= 0) return false;
  return ms >= bar;
}

/**
 * 质量闸门的**最后一步**：VAD 说「这一段是语音」时，`no_speech_prob` 不许单独把文本丢掉。
 *
 * 实测证据（用户 v2.66.61 导出，三方读数同时摆在面前）:
 * ```
 * VAD          说:说话中 · 连续 77 帧 · 概率 0.9989
 * avg_logprob  说:文本可靠（-0.23 / -0.10）
 * no_speech_prob 说:0.79 / 0.86 → 判定为无人说话
 * → 而我们信了那个和另外两个矛盾的读数，把「めっちゃ悩むの」整句扔了
 * ```
 *
 * ⚠️ 为什么这样不会把幻觉放回来：
 *   幻觉的典型场景是**静音 / 音乐**。那时 gate **进不了语音态**（连续帧凑不够开口线），
 *   所以 `vadSpeechMs` 很小 → 否决**不生效** → 幻觉仍然走原路被拦 ✓
 *   而"音乐盖着人声"那种（gate 可能判成语音）由**幻听套话清单**兜底 ✓
 *
 * ⚠️ 为什么做成**独立的一层**，而不是改 `rejectReason` 内部：
 *   `rejectReason` 要一字不改 —— 它的判据和"识别校正"那份是**同一个道理但两份实现**
 *   （`refine.js` 的 `judgeRefinement` 故意不共用，见那边的反向断言）。
 *   改 `rejectReason` 内部容易顺手把两边带偏；把否决放在外面，
 *   **原判据的输出逐字不变**，只是最后由这一层决定要不要执行。
 *
 * @param {string|null} reason  `rejectReason` 的返回值（null = 已通过）
 * @returns {{reason: string|null, released: string|null}} `released` 非空 = 本次否决生效过
 */
export function applyNoSpeechVeto(reason, opts) {
  if (!reason) return { reason, released: null };
  // 只否决**这一种**理由。空文本 / 幻听套话 / 置信度低 / 解码回退 一律照旧 ✓
  if (!reason.startsWith('判定为无人说话')) return { reason, released: null };
  if (!noSpeechVetoed(opts)) return { reason, released: null };
  return { reason: null, released: reason };
}

/**
 * 「空文本接力」最多往前带多久的音频。
 *
 * 太短：接不住一段整句（实测丢的那句约 1.3s 语音，但连前后停顿算 2.5s）
 * 太长：一句没识出就把 8 秒前的音频也带上，请求变大、还容易把上一句的尾巴重识一遍。
 */
export const CARRY_MAX_MS = 8000;

/**
 * 「空文本接力」：一段音频识别出**空文本**时，别把这段音频扔了 ——
 * 下一句要把它**一起带上**重识一遍。这个函数只算"该从哪个绝对样本开始取"。
 *
 * ⭐ 实测（v2.66.61，用户导出的真日志 + 同一份 WAV）:
 *
 *     [+81.796s] 闸门丢弃 · 丢弃一段识别结果 · 空文本 · 原文「」
 *
 *   而那 2.5 秒音频在 WAV 里的 RMS 是 **0.027~0.040**（和正常语音一模一样的量级），
 *   当时 VAD 也判「说话中」—— 也就是 **Whisper 把一段有语音的音频返回成了空**。
 *   我们的处理却是整段丢掉，于是「して定期的にすることっていうのはやっぱ大事なことだと思うし」
 *   整句消失，而下一句接着从「ための話だと思ってるのね」开始 ✗
 *
 *   → 病根不在闸门判错，而在**"空"被当成了"没有内容"**。空文本只说明这一遍没解出来，
 *     不说明这段音频该扔。所以判据是：VAD 说有语音 + 文本为空 → **留着**。
 *
 * 三条约束（都是算术，喂数字就能测）：
 *   · 起点只能往前挪，不能晚于 `start`（`min`）
 *   · 最多往前 `capSamples`（`CARRY_MAX_MS`），否则接力会一路把整段历史带上
 *   · 不能早于 `baseOffset` —— 早于它 `takeRange` 也取不到音频，白算
 *
 * @param {{start?:number, carryFrom?:number, baseOffset?:number, capSamples?:number}} s
 * @returns {number} 实际该从哪个绝对样本位置开始取
 */
export function carryStartFor({ start, carryFrom, baseOffset, capSamples } = {}) {
  const s = Number(start);
  // 起点本身不合法 → **原样返回**（调用方拿到的还是它传进来的那个值，语义上"没动"）
  if (!Number.isFinite(s)) return start;
  const from = Number(carryFrom);
  if (!Number.isFinite(from) || from < 0) return s;
  let eff = Math.min(from, s);
  const cap = Number(capSamples);
  if (Number.isFinite(cap) && cap > 0) eff = Math.max(eff, s - cap);
  const base = Number(baseOffset);
  if (Number.isFinite(base) && base >= 0) eff = Math.max(eff, base);
  return eff;
}

/**
 * 「这段文本和它的音频时长对不上」—— 幻听的第二种形态。
 *
 * ⭐ 实测（v2.66.64 用户导出，本地 Whisper）：
 *
 *     分片 · 0.7s 一句 · 9 字 · 静音 480ms · 先不收，和后面拼
 *     … 最后拼成「横のボタンを押して って言われても 私の ない 私が作った」
 *
 *   那 0.7s 里**静音占 480ms**，真正有语音的只有约 **220ms** —— 9 个字 / 0.22 秒
 *   等于每秒 40 个字，日语真人最快也就 8~10 字/秒。这不是"听错"，是模型在几乎空的
 *   音频上编了一句。它还会被拼进后面那句真话里，于是整句都读不通 ✗
 *
 * 判据只看比值：**文本字数 ÷ VAD 认定的语音秒数**。
 *   · 用 `vadSpeechMs` 而不是分片总长 —— 静音不算"说话时间"（这正是那次的成因）
 *   · 少于 3 个字不判（「はい」「ええ」这类短应答本来就短，别误伤）
 *   · 拿不到语音时长（NaN / 0）→ **不判**（宁可放过，也别把好句子当幻觉）
 *
 * ⭐ **阈值 15 字/秒**（v2.66.76 从 20 降下来）。为什么是 15 —— 三份真机日志算出来的：
 *
 *     正常句（必须过 ✓）: 5.2s/33 字 = 6.3 · 1.8s/10 字 = 7.6 · 2.9s/21 字 = 8.7
 *                        1.1s/ 8 字 = 12.9   ← **最快的正常句，留 2.1 的余量**
 *     幻听（必须拦 ✗）  : 0.7s/13 字 = **59.1**「横のボタンを押してください」
 *                        0.7s/ 7 字 = **31.8**「あーついてこそ」
 *                        0.7s/ 6 字 = **27.3**「では、また。」
 *                        0.7s/ 6 字 = **27.3**「ある とかもあるよ」
 *
 *   20 会漏掉什么：「では、また。」只剩 4 个字（去掉标点），4 / 0.22 = **18.2** ——
 *   正好卡在 20 下面 ✗。它是 Whisper 在静音上的**教科书式结尾幻觉**，必须能拦。
 *   所以 15 不是一个"更严"的拍脑袋值，而是**被这 7 个实测数夹出来的**
 *   （正常上限 12.9 < 15 < 18.2 幻听下限）。
 *
 * ⚠️ 余量只有 2.1（12.9 vs 15），所以**别再把阈值往上抬** —— 那会放回 18.2 那条 ✗；
 *    也别往下压到 13 —— 那会开始误伤 12.9 那种正常快句 ✗。
 *
 * @param {string} text 识别文本
 * @param {number} speechMs VAD 认定的语音毫秒数
 * @returns {boolean} true = 明显不可能是这段音频说的
 */
export function looksTooFastForAudio(text, speechMs, opts = {}) {
  const {
    maxCharsPerSec = 20,
    minChars = 3,
    /** ⭐ 绝对判据（见函数上方注释）：语音**极短**却有很多字 */
    tinySpeechMs = 250,
    tinyMinChars = 4,
  } = opts;
  const chars = [...String(text || '').replace(/[\s、。,.!?！？…「」『』・]/g, '')].length;
  if (chars < minChars) return false;
  const ms = Number(speechMs);
  if (!Number.isFinite(ms) || ms <= 0) return false;
  /**
   * ⭐ **绝对判据优先于比值**（v2.66.76 第二版，被闭环抓出来的）。
   *
   * ⚠️ 纯比值 15 会误杀真话 ✗ —— 闭环实测两次：
   *    「わけないじゃん」 7 字 / 0.44s = **16.0 字/秒** ✗ 被丢（而它是完整的一句）
   *    「そうそうそう…」 17 字 / 1.04s = **16.3 字/秒** ✗ 被丢
   *  ⚠️ 16 字/秒在日语里**是可以说到的**（快语速主播）——
   *     比值拦的是"语速"，而幻觉的特征不是"语速快"，是"**语音极短却有很多字**" ✗
   *
   * ✅ 对全部实测数据的判别（换成绝对判据的依据）：
   *    幻觉「横のボタンを押してください」13 字 / 0.22s → ① ✓ 丢
   *    幻觉「では、また。」              4 字 / 0.22s → ① ✓ 丢（边界，刚好够）
   *    幻觉「あーついてこそ」            7 字 / 0.22s → ① ✓ 丢
   *    真话「わけないじゃん」            7 字 / 0.44s → ①②③ 全不命中 ✓ **保住**
   *    真话「そうそうそう…」            17 字 / 1.04s → 全不命中 ✓ **保住**
   *    真话「1.1s/8 字」                 8 字 / 0.62s → 全不命中 ✓ **保住**
   *    而 ③ 仍能拦"语音 0.5s 却 40 字"（80 字/秒）✓
   */
  if (ms < tinySpeechMs && chars >= tinyMinChars) return true;
  return chars / (ms / 1000) > maxCharsPerSec;
}

/**
 * 「这段音频里**几乎没人说话**，而 Whisper 还是吐了字」—— 幻听的第四种形态。
 *
 * ⭐ 实测（`xhsp.mp4` 闭环 · `xhsp-anchor1` · 新断句路径）：
 *
 *     批起 49.52 · 锚 49.52（**+0.00**）· 1 字 / **8.00s** = **0.1 字/秒** ✗
 *
 *   而同一窗口里 VAD 的逐帧概率说明那段**根本没有开口**（音乐床贴着阈值浮动 ✗）。
 *   Whisper 对着非语音吐出 1 个字，于是这条字幕的「起点」只能取批起点 ⇒ 提前 8 秒 ✗
 *   —— 它同时是「字幕提前」和「一句话只闪一下」的来源之一 ✓
 *
 * ⭐ **这一次不是"起点算错"，而是"这段本来就不该被采纳"** ✗
 *    ⇒ 所以在 `isTextTrustworthy` 里拦掉它 ✓（`decideAdvance` 会把它当 pending，
 *      下一批从它的 `start` 重采 ⇒ 而那正是想要的 ✓）
 *
 * 判据只看比值（**字数 ÷ 段总时长**），而**必须先过跨度门槛**：
 *   · 跨度 < 6 秒 → **不判** ✓（「はい」「ええ」这类短应答本来就短，别误伤 ✗）
 *   · 跨度 ≥ 6 秒而字数 ÷ 秒数 < **0.6** → 判为"几乎没人说话" ✓
 *
 * ⭐ **0.6 是怎么夹出来的**（三份真机日志的真实数字）：
 *
 *     必须拦 ✗: 1 字 / 8.00s  = **0.13**  ← 那 1 个字是 Whisper 在非语音上编的
 *     必须过 ✓: 9 字 / 5.50s  = **1.64**  ← 真的在慢慢说（句间有长停顿，而内容完整）
 *               17 字 / 5.40s = **3.15** ✓ · 19 字 / 4.20s = **4.52** ✓
 *   ⇒ 0.6 落在 0.13 与 1.64 之间，两侧余量分别 4.6× 与 2.7× ✓
 *
 * ⚠️ **不许再往下压到 0.4** —— 那会开始误伤 1.64 那种真话 ✗
 * ⚠️ **不许往上抬到 1.0** —— 那会放过 0.13 那种（只差 1.7×）✗
 *
 * ⚠️ `♪` 之类的符号**先剥掉再数**：实测有一条 `[50.44-60.44]「♪」`（10 秒只有 ♪）
 *    被当成一句采纳了 ✗ —— 剥掉之后字数 = 0，跨度 ≥ 6 秒 ⇒ 正好被这条拦住 ✓
 *
 * @param {string} text 识别文本
 * @param {number} durationMs 这段的时长（毫秒）—— 新路里只能用 Whisper 的 `end - start`
 * @returns {boolean} true = 这段里几乎没人说话
 */
export function looksTooSlowForAudio(text, durationMs, opts = {}) {
  const { minCharsPerSec = 0.6, minDurationMs = 6000 } = opts;
  const ms = Number(durationMs);
  /**
   * ⚠️ 拿不到时长 → **不判** ✓（宁可放过，也别把好句子当幻觉 ✗）
   *    而 `Number(null) === 0` ⇒ 必须用 `Number.isFinite` 而不是真值判断 ✓
   */
  if (!Number.isFinite(ms) || ms < minDurationMs) return false;
  /** 标点 / 空白 / 音乐符号都不算"说了字" ✓ */
  const chars = [...String(text || '').replace(/[\s、。,.!?！？…「」『』・♪]/g, '')].length;
  /** 跨度 ≥ 6 秒而**一个字都没有** ⇒ 那就是非语音 ✓ */
  if (chars === 0) return true;
  return chars / (ms / 1000) < minCharsPerSec;
}

/**
 * 「是不是该提醒用户把「静音确认」调大」—— 短片段太多的判据。
 *
 * ⭐ 实测（v2.66.65 用户导出，慢速解说、静音确认设的 480ms）：
 *
 *     分片 · 0.7s 一句 · 4 字 · 静音 480ms · 先不收，和后面拼
 *     [+56.230s] 整句上屏 · 10 字 · watchdog · 累积 2 片 · 跨度 4.8s
 *                识别 まずいでほ ではでは        ← 正确内容是三句「マジで欲しいの／…」
 *
 *   每个停顿（~500ms）都被当成句尾切开，于是 Whisper 拿到的是一堆 0.7 秒的碎片：
 *   要么丢掉大半内容，要么在几乎没有信息的音频上凭空编一句。
 *   这不是模型坏了，是**喂给它的音频太碎**。
 *
 * 判据（纯算术，便于断言）：
 *   · 窗口内至少 8 段（少了下不了结论）
 *   · 其中 **≥60%** 短于 1 秒 → 说明切得比说话还碎
 *
 * ⚠️ 只提醒、不自动改设置：静音确认调大对**快语速**主播是反效果
 *    （他们的停顿本来就短，450ms 是刻意的）。自动改等于替用户做错决定。
 *
 * @param {{ms:number}[]} segments 最近窗口内的分片（每项只有时长 ms 有用）
 * @returns {boolean}
 */
export function shouldHintShortSegments(segments, { shortMs = 1000, minCount = 8, minRatio = 0.6 } = {}) {
  const list = Array.isArray(segments) ? segments : [];
  if (list.length < minCount) return false;
  let short = 0;
  for (const s of list) {
    const ms = Number(s && s.ms);
    if (Number.isFinite(ms) && ms >= 0 && ms < shortMs) short += 1;
  }
  return short / list.length >= minRatio;
}

/**
 * 给 `looksTooFastForAudio` 用的「**真正在说话**的时长」。
 *
 * ⚠️ 不能直接用 `vadSpeechMs`：gate 的 `speechFrames` 在语音态里**每帧都自增**，
 * 包括还没达到静音门槛的那段尾巴 —— 于是它约等于**分片总长**。
 * 实测（v2.66.66）：0.7s 的分片报出来是 0.7s，于是 14 个字 / 0.7s = **20.0 字/秒**，
 * 正好卡在阈值上，「横のボタンを押してください」和「どうもありがとうございました」
 * 两次幻听全漏了过去 ✗
 *
 * 真正该用的是「分片时长 − 静音」（0.7 − 0.48 = 0.22s）。
 * 两者取小的更保守：万一静音那段没记准，也不至于把时长算大。
 *
 * @param {{durationMs?:number, silenceMs?:number, vadSpeechMs?:number}} o
 * @returns {number} 毫秒；拿不到可信值时返回 `vadSpeechMs`（可能是 NaN，判据会自己放过）
 */
export function effectiveSpeechMs({ durationMs, silenceMs, vadSpeechMs } = {}) {
  const d = Number(durationMs);
  const sil = Number(silenceMs) || 0;
  const voiced = Number.isFinite(d) ? Math.max(0, d - sil) : 0;
  const vad = Number(vadSpeechMs);
  if (voiced > 0) return Number.isFinite(vad) ? Math.min(vad, voiced) : voiced;
  return vad;
}

/**
 * ⭐ 「硬切之后那条尾巴」的语音时长门槛 —— 低于它的碎片，文本**不可采信** ✗
 *
 * ⚠️ 为什么是 350ms（v2.66.78：从 250 抬上来 ✓）：
 *
 *   实测两个边界（闭环插桩量出来的真实入参）：
 *     · 硬切尾巴   :语音 80ms  + 留白 200 = **280ms**（合成素材）
 *                    真机那次 0.7−0.48 = **220ms** ✓
 *     · 自然短应答 :语音 250ms + 留白 200 = **450ms**（「はい」量级）
 *   → 250 时**拦不住 280** ✗（差 30ms），而 350 正好把两者分开 ✓
 *
 * ⚠️ 而真正的分界不是语音多长，是**留白之后剩多少**：
 *   留白 adPadMs = 200ms 两头都补，所以它把两边同时抬高 200ms ⇒ 差值不变 ✓
 *   ⇒ 门槛必须落在「尾巴语音 + 200」和「短应答语音 + 200」之间 ✓
 *
 * ⚠️ 别指望 chars 来分：「はい」2 字 ✓ 而合成尾巴 5 字（「わかんねえ」）✗
 *   两者重叠，所以**只能靠时长** ✓
 */
export const HARD_CUT_TAIL_SPEECH_MS = 350;

/**
 * 判断一个分片是不是「**上一段被硬切之后掉下来的尾巴**」—— 纯函数，可单测 ✓
 *
 * ⚠️ 判据**只看一件**：`speechMs < HARD_CUT_TAIL_SPEECH_MS` ✓
 *
 * ⚠️⚠️ 这里曾经**还要求** `prevCut === 'max-length'`（上一段是到上限硬切）✗ ——
 *      而**真机日志证明那个条件几乎不成立** ✗：
 *        三份真机日志（v2.66.75）里共 43 个分片、14 条 `voiced < 350ms` 的尾巴,
 *        而其中 `prevCut === 'max-length'` 只有 **2 条**（14%）✗
 *        其余 12 条的前一段是「自然静音收句」（5 条）或「先不收的碎片」（7 条）✗
 *      ⇒ 那条判据**只覆盖 14%**,等于半废 ✗（"看起来有保护、实际几乎不起作用"这一族）
 *
 * ⭐ 而真机里**尾巴的形态其实是**：「静音确认 450ms」把它判成句尾 ⇒ 说话人隔了
 *    480ms 又说了 0.2 秒 ⇒ 那一小段被单独切出来 ✗。它的**开头没有落在词中间**,
 *    但**只有 0.2 秒的音频**,Whisper 照样编 —— 实测:「では、また。」「あーついてこそ」✗
 *    ⇒ 所以病根不是"从词中间起手",而是"**这段音频太短,信息量不够**" ✓
 *
 * ⭐ 而"能不能用别的信号分开短应答和尾巴"—— 都试过,**都不行** ✗：
 *    · `gap`（距上一段的间隔）：尾巴 0.598~5.613s ✗ vs 非尾巴最小 1.691s ⇒ **重叠** ✗
 *    · `prevChars`（上一段字数）：尾巴 2~30 ✗ vs 非尾巴最小 2 ⇒ **重叠** ✗
 *    · `chars`（本段字数）：「はい」2 字 ✗ vs 尾巴 2~13 字 ⇒ **重叠** ✗
 *    ⇒ **只有 `voiced` 本身分得开** ✓：
 *       尾巴 **220 / 320ms** · 而真机非尾巴最小 **620ms** ⇒ 安全的门槛区间是 320~620 ✓
 *       取 350（偏保守侧 ✓）
 *
 * ⚠️ 而**代价要说清**：一个真的、说得很快的「はい」（语音约 250ms ⇒ voiced 约 450ms）
 *    在这个门槛下**仍不会被判**（450 > 350 ✓）。而如果它更快、voiced 掉到 350 以下,
 *    就会被误伤 ✗ —— 真机三份日志里这种实例 **0 条**,但并不等于不存在 ✓
 *    （所以下面「文本不采信」那一行**必须留在日志里** ✓，用户能看见 ✓）
 *
 * ⚠️ 而**不要"接力"这段音频** ✗ —— v2.66.67 试过（把音频并进下一段），
 *    结果比不拦更差（「かはない」「を設定」那种从半句开始的拼接 ✗）。
 *    这里只做"**这段文本不采信**"，音频照常往前走 ✓
 *
 * @param {string} prevCut    **上一段**的切法 —— ⚠️ 现在**不参与判定** ✓
 *                            留着这个参数只是为了调用点不用改、日志里能打出来 ✓
 * @param {number} speechMs   这一段的语音时长（分片总长 − 静音 ✓）
 * @returns {boolean} true = 是极短尾巴，文本不可采信
 */
export function isHardCutTail(prevCut, speechMs) {
  // ⚠️ `prevCut` 不再参与判定 —— 见上面那段实测（它只覆盖 14% ✗）✓
  void prevCut;
  /**
   * ⚠️ `null` 必须**显式挡掉** —— `Number(null)` 是 **0**，而 `0 < 250` 成立 ✗
   *    于是"拿不到时长"会被判成"语音极短"，那就成了**凭一个缺失值丢文本** ✗
   *    （同一个坑在 `exitThreshold` 那里踩过：`Number(null) = 0` ⇒ 每帧都算继续 ✓）
   */
  if (speechMs === null || speechMs === undefined || speechMs === '') return false;
  const s = Number(speechMs);
  if (!Number.isFinite(s)) return false;
  return s < HARD_CUT_TAIL_SPEECH_MS;
}

/**
 * ⭐ 软边界之后「还差多少毫秒静音才该收句」—— 纯函数，可单测 ✓
 *
 * ⚠️ 存在的理由（这是「句子留不住」的根子）：
 *   软边界只发 `final`、不发 `utteranceEnd`（设计就是"和后面拼"），
 *   而「静音够久就收句」这条只在 `flushSpeech` 里被检查 ——
 *   而 `flushSpeech` 只在**有新分片要发**时才被调用。
 *   ⇒ 人真停了就再也没有下一个分片 ⇒ 那条判据**永远不会再被检查**。
 *   也就是说：它的触发条件，恰恰是它自己的前提所排除的那个条件。
 *
 * 所以把"还差多少"算出来，交给逐帧循环（`handleFrame`）去数。
 *
 * @param {number} silenceMs        这一次切分依据的静音时长
 * @param {number} utteranceEndMs   收句静音门槛
 * @param {boolean} hard            这次是不是已经按硬边界收句了
 * @returns {number} 还需要累计多少毫秒静音；0 = 不需要（已收句）
 */
export function softEndNeed(silenceMs, utteranceEndMs, hard) {
  if (hard) return 0;
  const need = Number(utteranceEndMs);
  if (!Number.isFinite(need) || need <= 0) return 0;
  return Math.max(0, need - (Number(silenceMs) || 0));
}

/**
 * 软边界计时器的**一帧**推进 —— 纯函数，可单测 ✓
 *
 * ⚠️ 三条不变量（断言钉着）：
 *   ① **超过已静音时长才能触发** —— 总静音必须真的达到 `utteranceEndMs`，一分不少 ✗
 *   ② **人又开口就作废** —— 否则会收在半句话中间 ✗
 *   ③ **触发一次就清零** —— 否则会重复收句 ✗
 *
 * @param {{needMs:number, silentMs:number}} state
 * @param {{inSpeech:boolean, frameMs:number}} frame
 * @returns {{needMs:number, silentMs:number, fire:boolean}}
 */
export function softEndTick(state, { inSpeech, frameMs } = {}) {
  const needMs = Number(state && state.needMs) || 0;
  const silentMs = Number(state && state.silentMs) || 0;
  if (!(needMs > 0)) return { needMs: 0, silentMs: 0, fire: false };
  // 人又开口了：这一句还要继续，作废（下一次 flushSpeech 会重新决定）
  if (inSpeech) return { needMs: 0, silentMs: 0, fire: false };
  const step = Number(frameMs) > 0 ? Number(frameMs) : 40;
  const next = silentMs + step;
  if (next >= needMs) return { needMs: 0, silentMs: 0, fire: true };
  return { needMs, silentMs: next, fire: false };
}

export function createSession({ config, global, onEvent }) {
  /**
   * 文本从哪来 —— VAD 定轴这一半是共用的，只有「把这一句换成文本」这一步因服务而异。
   *
   *   'whisper'   → 本地 / 自建的 OpenAI 兼容 Whisper 服务（默认）
   *   'dashscope' → 阿里云百炼 Qwen-ASR（国内直连）
   *
   * ⚠️ 别把整个 VAD 引擎复制一份给新服务 —— 那 600 行里有大量踩过坑的细节
   * （窗长 576、帧计数口径、两级边界、音频裁剪），复制出去必然两边走偏。
   */
  const backend = String(config.backend || 'whisper').trim();

  const apiKey = String(config.apiKey || '').trim();
  const language = String(global.language || 'auto').trim();

  /**
   * 两个后端的「地址」是各自独立的：
   *   whisper   → 本地 Whisper 服务（baseUrl 必填）
   *   dashscope → 阿里云百炼固定端点（baseUrl 无关，缺了也不该拦）
   * ⚠️ 原来这里无条件要求 baseUrl，用 DashScope 的人如果没配本地服务就会被莫名其妙拦住。
   */
  let baseUrl = '';
  let dsEndpoint = '';
  let dsModel = '';
  if (backend === 'dashscope') {
    dsModel = String(config.model || 'qwen3-asr-flash').trim();
    if (!apiKey) throw new Error('阿里云百炼 API Key 未配置，请到设置页填写。');
    if (!dsModel) throw new Error('阿里云百炼模型名未配置（默认 qwen3-asr-flash）。');
    /**
     * ⚠️ 原来这里也读 `config.endpoint` 并拿它做"地址为空"的校验 —— 那是个陷阱:
     * 它的默认值是个**非空的内置 URL**,所以这个检查永远不会触发(等于没检查);
     * 而一旦有人把设置页的地址清空,它又会**误报**「接口地址为空」——
     * 可清空恰恰是正确用法(留空=用自动选择)。
     * 端点的决定权只属于 `resolveDashscopeEndpoint`,这里不再另搞一份。
     */
    dsEndpoint = resolveDashscopeEndpoint(dsModel, config.endpointMode, config.endpoint).url;
  } else {
    baseUrl = String(config.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) throw new Error('Whisper 服务地址未配置（本地 VAD 与识别校正共用同一个地址）。');
  }

  const model = String(config.model || 'whisper-1').trim();
  /**
   * 重识别提示词 —— 和分片模式取的是同一个字段（`asr.whisperChunked.prompt`）。
   * 以前 VAD 模式完全不读它，等于用户填了没用。
   *
   * ⚠️ 现在它由 `buildWhisperPrompt` 拼出来：用户提示词 + **识别热词**（可选并入术语表源词）。
   * 三条理由见那个函数的注释 —— 核心是 Whisper 只认末尾 224 token，写长了前面会被截掉。
   */
  const promptInfo = buildWhisperPrompt({
    prompt: config.prompt,
    hotwords: config.hotwords,
    /**
     * 内置「直播热词」（`lib/hotwords/ja-live.js`）—— **默认开**。
     * ⚠️ 判法用 `!== false`：合并后的设置一定带 `liveHotwords`，读到就是默认值；
     *    而直接构造会话（测试 / 别处）时缺这个字段，也应当当作"开"。
     * ⚠️ 原来那条「术语表源词」的路（`whisperGlossaryWords` / `glossaryHotwords`）
     *    v2.66.80 起按用户要求删掉了 —— 术语表是翻译用的表，整表塞进 prompt 会带偏识别。
     */
    liveHotwords: JA_LIVE_HOTWORD_LIST,
    includeLiveHotwords: config.liveHotwords !== false,
    language,
  });
  const prompt = promptInfo.text;
  if (promptInfo.hotwords > 0) {
    onEvent({
      type: 'status',
      status: 'vad',
      detail:
        `识别提示词 · 热词 ${promptInfo.hotwords} 个` +
        // 「N/M」= 内置词表 M 个里带上了 N 个（140 字符装不下全部，见 js 里的注释）
        `${promptInfo.live > 0 ? `（含内置直播词 ${promptInfo.live}/${promptInfo.liveTotal}）` : ''}` +
        `${promptInfo.truncated ? '（超出长度上限，后面的没带）' : ''}`,
    });
  }

  /**
   * ⭐ **新断句路径**（Whisper 先断 · 静音只做确认）—— `asr.whisperChunked.whisperSegments`
   *
   * ⚠️ **默认关**。关着时 `segmentLoop` 是 `null`：
   *    · `push()` 不会调 `pumpSegments()` ✓
   *    · `handleFrame()` 里那条 `if (segmentLoop) return;` 不会命中 ✓
   *    · `trimAudio()` 的保留基准不会多算一项 ✓
   *    ⇒ **旧路（`flushSpeech` / `softEndNeed` / `softEndTick` / `gate` / 累积器）逐字不变** ✓
   *    —— 这是硬要求：要能 A/B、能回退 ✓
   *
   * ⚠️ **只对 `backend === 'whisper'` 生效** ✗：DashScope 那条不返回 `segments`
   *    （见 `pickDashscopeText` 上方的注释），而新路的全部依据就是 segments 的边界 ✓
   *
   * ⚠️ 代价：**字幕会晚约 3 秒**（首批音频 6 秒 + 一次往返 + 静音确认）。
   *    所以这条路径有一个配套建议：把「画面延迟」从 7 秒提到 10 秒左右 ✓
   */
  const useWhisperSegments = backend === 'whisper' && config.whisperSegments === true;
  let segmentLoop = null;
  /** 防重入：一批在飞的时候不许再开一批（`next()` 里也有 inflight，双保险 ✓） */
  let segmentsInflight = false;
  let segmentsBatches = 0;
  let segmentsAccepted = 0;
  let segmentsEmpty = 0;
  let segmentsFailed = 0;
  /**
   * 上一次报 `新断句` 时的音频时间（秒）—— 低频心跳用 ✓
   *
   * ⚠️ 用 `-Infinity` 而不是 `0`：第一帧就该报一次，否则"起没起来"要等 30 秒才知道 ✗
   */
  let segmentsLastReportSec = -Infinity;
  /** 上一次报「还在等音频」时的音频时间（秒）—— 见 `push()` 里的存活心跳 ✓ */
  let segmentsLastStarveSec = -Infinity;
  /**
   * 上一条**已下发**字幕的 `at`（绝对秒）—— 排期单调夹紧用 ✗
   *
   * ⚠️ 按**下发顺序**记，不是"时间上最晚的那条" ✗
   *    播放器是被"最新 push 进来的那条"顶掉的 ⇒ 基准只能是最后 push 出去的那条 ✓
   * ⚠️ 初值必须是 `null`（= 还没有任何一条），**不能是 `0`** ——
   *    `0` 会把开头第一条当成"上一条在 0.0 秒"，于是它被无端推到 0.5 秒 ✗
   */
  let segmentsLastShownSec = null;
  /** 被"排期单调夹紧"往后推过的条数 —— 进心跳，否则这事在日志里看不见 ✗ */
  let segmentsPushedLater = 0;
  /**
   * ⭐ **段内切分**的次数与条数 —— 进心跳 ✓
   *
   * 为什么必须看得见：切分**会改变字幕条数**（一段变两条），
   * 而"条数变了"和"识别变碎"在日志里长得一样 ✗
   * ⇒ 不印出来就分不清是"Whisper 更碎了"还是"我们切开了" ✓
   * （"看不见"这一族今天已栽过六次 ✓）
   */
  let segmentsSplit = 0;
  let segmentsSplitPieces = 0;
  /**
   * ⭐ **开口锚账本** —— 按"决策 / 原因"累加，进 30 秒心跳 ✓
   *
   * ## 为什么必须累加，而不能只靠逐段诊断
   *
   * 逐段诊断是 `type:'status'`，而**面板只保留最后一条 status** ✗
   * ⇒ 导出时大部分段诊断**已经被覆盖** ✓
   * 实测 `xhsp-ab6-B`：4 份日志里只有 **19** 条段诊断，而采纳段有 **40+** ✓
   * ⇒ 「19 条里 4 条锚没动」这个比例**本身就不分母** ✗
   *
   * ⇒ 所以按原因计数，塞进那一行"总是最后一条"的心跳 ✓✓✓
   *
   * 各项含义（含"为什么这项和那项的修法不同"）：
   *   · `vad`            真的用 VAD 锚挪了 ✓
   *   · `rejected`       问了 VAD 但被拒 —— 再看 `byReason` 细分 ✗
   *       - `peak-low`      连续 7 帧够了但峰值不够 ⇒ 音乐床贴阈值 ⇒ 该加回落/抬峰值 ✓
   *       - `run-too-short` 断续 ⇒ 该放宽帧数 ✓
   *       - `no-frame-over` 一帧都没过阈值 ⇒ 纯静音/纯音乐 ⇒ **动不了** ✓
   *       - `window-too-short` 批太短 ⇒ 不动 ✓
   *   · `skipStart`      **首段 `start` 超过信任窗口 ⇒ 根本没问 VAD** ✗（今天的 3/4 就是它 ✓）
   *   · `shadowWould`    影子测量：若放宽窗口**本来可以采信**的条数 ⇒ 决定要不要放宽 ✓
   *   · `skipNotFirst`   非首段且 `start` 是真实边界 ⇒ 按设计不问 ✓
   */
  const anchorStats = {
    vad: 0,
    rejected: 0,
    byReason: {},
    skipStart: 0,
    shadow: 0,
    shadowWould: 0,
    skipNotFirst: 0,
    other: 0,
    /** 最近 4 条"值得看"的原始读数（跑太长会刷屏 ✓） */
    recent: [],
  };
  if (useWhisperSegments) {
    segmentLoop = createSegmentLoop({
      takeRange,
      sampleRate: meta.sampleRate,
      /**
       * 幻觉判据（注入）—— **复用 `vad.js` 里已有的那两条**，不另写一份 ✗
       * （「同一事实记两遍」这一族栽过多次：`tooShort` 没人消费、`Math.min` 永不生效…）
       *
       * ⚠️ `speechMs` 在新路里只能用 Whisper 自己的 `end - start` ——
       *    旧路有 VAD 的 `speechFrames`，而新路不切句、没有那个东西 ✓
       *    而这是**保守方向**：段的时长 ≥ 真实语音 ⇒ 比值偏小 ⇒ 不容易误杀 ✓
       *    （`isHardCutTail` 的 `< 350ms` 那条仍然有效：Whisper 断出的段正常都在 1 秒
       *      以上，短于 350ms 的段本身就是碎片 ✓）
       */
      isTextTrustworthy: (seg) => {
        const durMs = Math.max(1, (Number(seg.end) - Number(seg.start)) * 1000);
        if (looksTooFastForAudio(seg.text, durMs)) return false;
        /**
         * ⭐ **反方向的那条**（v2.66.83）：跨度 ≥ 6 秒而字数极少 ⇒
         *    这段里**几乎没人说话**，那 1 个字是 Whisper 在非语音上编的 ✗
         *
         * 实测（`xhsp-anchor1`）：`1 字 / 8.00s = 0.1 字/秒` ——
         * 而它的锚只能取批起点（`+0.00`）⇒ 字幕提前 8 秒 ✗
         * ⇒ **它不是"起点算错"，而是"这段本来就不该被采纳"** ✓
         *   （判据与 0.6 的来历见 `looksTooSlowForAudio` 的注释 ✓）
         */
        if (looksTooSlowForAudio(seg.text, durMs)) return false;
        /**
         * ⭐ **词级时间戳那条**（`words[]`）—— 比上面那条准，而且**不用等 6 秒** ✓
         *
         * `looksTooSlowForAudio` 要求 `跨度 ≥ 6 秒`，而实测那份素材里有一条
         * `1 个词占 2.00 秒`（`ん` 一个词，那 2 秒里**没有语音** ✗）—— **它拦不住** ✗
         *
         * 而词均时长判据：`(末词.end − 首词.start) / 词数 > 0.8 秒/词`
         *   · 正常段实测 0.17~0.50 秒/词 ✓（最大是 C 那 12 词 6.04 秒 = 0.50）
         *   · 垃圾段是 **2.00 秒/词** ✗ ⇒ **4 倍余量** ✓
         * ⇒ 而且它**只用 Whisper 自己给的数**，不依赖 VAD / 电平（那两个今天都失效了 ✗）
         *
         * ⚠️ `words` 缺失 ⇒ `false`（**不判** ✓ —— 老服务端没词级时间戳时行为逐字不变 ✓）
         */
        if (looksTooSlowByWords(seg)) return false;
        if (isHardCutTail(null, durMs)) return false;
        return true;
      },
      transcribe: transcribeSegments,
    });
    onEvent({
      type: 'status',
      status: 'vad',
      detail:
        '⚠ 新断句路径已启用（Whisper 先断 · VAD 只做静音确认）—— 实验性：' +
        '字幕会比旧路晚约 3 秒，建议把「画面延迟」调到 10 秒左右',
    });
  }

  const vadOpts = {
    threshold: Number(config.vadThreshold ?? 0.5),
    minSpeechMs: 250,
    minSilenceMs: Number(config.vadMinSilenceMs ?? 450),
    maxSpeechMs: Number(config.vadMaxSpeechSec ?? 20) * 1000,
    minUtteranceMs: Number(config.vadMinUtteranceMs ?? 400),
    padMs: Number(config.vadPadMs ?? 200),
    /**
     * 「合理断句」：到「单句上限」时回看末尾的换气处，把切点挪过去（见 findLullCut）。
     * ⚠️ **默认关**（v2.66.79 起；闭环 A/B 实测开着让整句中位 22→18 字、≤4 字整句 0→2，
     *    而它想治的 0.2 秒短尾巴一条没减少）。
     *    这里判 `!== false`，而 `player.js` 的 `smartCutEnabled()` 必须用同一判法；
     *    合并后的设置一定带这个字段（默认 false），所以读到就是默认值。
     */
    smartCut: config.vadSmartCut !== false,
    /**
     * ⚠️ 新字段，所以判法用 `=== true`：**缺省即关** ✓
     *    （和老字段 `smartCut !== false` 不同 —— 那个要保证老配置算"开"，
     *     而这个要保证老配置算"关"，方向相反，别照抄 ✗）
     */
    dropShort: config.vadDropShort === true,
  };

  /**
   * ⚠️ 这几个都是**自检之后才能定下来**的：
   * 不同版本的 Silero 对张量维度、窗长的要求不一样，喂错了模型就是"聋的"
   * （实测：真人语音峰值只有 0.001）。自检把候选都跑一遍，挑出能用的那一种。
   */
  let winSamples = VAD_FRAME_SAMPLES;
  let inDims = (n) => [1, n];
  let srDims = [];
  let gate = new VadGate({ ...vadOpts, frameSamples: winSamples });

  /**
   * ⭐ **VAD 逐帧概率历史** —— 新路「人真正开口在哪」的锚 ✓
   *
   * 为什么需要它：新路的批起点 = 上一句已采纳的 `end`，而 Whisper 给批首段的
   * `seg.start` **恒为 0** ✗ ⇒ 上屏时刻落在批起点上，而那里可能正是**音乐床 / 换气**。
   * 实测（`livedtranslate-20261020-143232`）：批 @26.84 的首段真实开口在 **30.5**，
   * 而引擎给它 26.84 ⇒ **提前 3.16 秒** ✗ ⇒ 它一上屏就把上一句顶掉（"只闪一下"）✓、
   * 而它自己"过一会才说" ✓ —— 三个现象一个 bug。
   *
   * 为什么不用音频电平：今天实测排掉过两条 ✗（`lullRatio` 全失败、自写的"电平 0.5×p90"
   * 净负收益）。而 VAD 概率分得开：音乐床 0.199 / 0.007，开口后 0.978 ✓
   * —— 而**旧路正是靠它切句**，而旧路的时机是用户认可的 ✓✓✓
   *
   * ⚠️ 环长按 90 秒：批最长 8 秒 + 一次往返，而我们要回看的是**当前批起点之后**
   *    （最多 8 秒）⇒ 90 秒绰绰有余 ✓（留大点是怕 `takeRange` 之后音频还在长 ✓）
   */
  const PROB_HISTORY_SEC = 90;
  let probRing = null; // Float32Array，按帧号取模
  let probRingLen = 0;
  let probRingLastFrame = -1;

  /** 记一帧的概率（`frameIdx` 是 `gate.frameIndex` 里的帧号，0 基） */
  function recordProb(frameIdx, p) {
    const frameSec = winSamples / Number(meta.sampleRate);
    if (!(frameSec > 0)) return;
    const need = Math.max(25, Math.ceil(PROB_HISTORY_SEC / frameSec));
    if (!probRing || probRingLen !== need) {
      probRing = new Float32Array(need);
      probRingLen = need;
    }
    probRing[frameIdx % probRingLen] = Number.isFinite(p) ? p : NaN;
    if (frameIdx > probRingLastFrame) probRingLastFrame = frameIdx;
  }

  /**
   * `[fromSec, toSec]` 里**第一个概率 ≥ 阈值**的时刻（绝对秒）；找不到返回 `null` ✓
   *
   * 返回的是**那一帧的起点**（`frameIdx × frameSec`），粒度 = 一帧（40ms）✓
   * —— 比"提前 3 秒"这个量级细 75 倍，够用 ✓
   *
   * ## ⚠️ 必须要求**连续 `minRunFrames` 帧**达标，不能只看单帧 ✗
   *
   * 实测（真机闭环，新路，7 次锚点里 2 次 `shift = 0.00`）：
   * ```
   * 批起 30.44 · start 0.00 · 锚 30.44（+0.00） · 7 字 / 5.64s = 1.2 字/秒  ✗ 锚没动
   * 批起 49.52 · start 0.00 · 锚 49.52（+0.00） · 2 字 / 8.00s = 0.3 字/秒  ✗ 锚没动
   * ```
   * 而那两条正是**最差的**（跨度过长）—— 因为**音乐床/呼吸在批起点就已经 ≥ 0.5** ✗
   * ⇒ 单帧判据会在 `base` 立刻返回 ⇒ `shift = 0` ⇒ 不采信 ✗
   *
   * ⭐ 而**旧路（用户认可的时机）要求「开口需 7 帧」** —— 连续 7 帧 ≈ 280ms ✓
   * ⇒ 这里用**同一个判据**：连续 `minRunFrames` 帧都 ≥ 阈值才算开口 ✓✓✓
   * （两个判据 = 两份真相 ✗；这一族今天栽过多次）
   *
   * ⚠️ 保守方向：找不到就返回 `null` ⇒ 不挪 ✓
   *    —— 那可能真是一段持续的底噪，而"不挪"最多维持现状，不会把对的挪歪 ✓
   */
  function firstSpeechAt(fromSec, toSec, threshold, minRunFrames = 1, probe = null) {
    /** 探针：记"死在哪一步" ✗ —— 否则 `null` 只有一种意思，查不出原因 ✓ */
    const why = (reason) => {
      if (probe && typeof probe === 'object') probe.reason = reason;
      return null;
    };
    if (!probRing || !(probRingLen > 0) || probRingLastFrame < 0) return why('no-history');
    const frameSec = winSamples / Number(meta.sampleRate);
    if (!(frameSec > 0)) return why('bad-frame');
    const thr = Number.isFinite(Number(threshold)) ? Number(threshold) : Number(vadOpts.threshold);
    if (!Number.isFinite(thr)) return why('bad-threshold');
    const f0 = Math.max(0, Math.floor(Number(fromSec) / frameSec));
    const f1 = Math.min(probRingLastFrame, Math.ceil(Number(toSec) / frameSec));
    if (!Number.isFinite(f0) || !Number.isFinite(f1)) return why('bad-range');
    /** 环里还留着的最老帧 —— 比它更早的已经被覆盖了 ✗ */
    const oldest = Math.max(0, probRingLastFrame - probRingLen + 1);
    const start = Math.max(f0, oldest);
    if (!(f1 >= start)) return why('bad-range');
    /**
     * ⚠️ **必须容纳整段连续帧**：若 `start + need - 1 > f1`，窗口末尾那几帧凑不满，
     *    而"凑不满"就是"这段里没有可靠的开口" ⇒ `findSpeechRun` 返回 `null` ✓（保守）
     *
     * ⭐ 判据本体搬去了 `lib/asr/speech-run.js`（纯函数，可断言 ✓）——
     *    这里只剩"环形缓冲 → 帧索引"的换算 ✓ · 行为与搬走之前逐字相同 ✓
     */
    const found = findSpeechRun(ringGetter(probRing, probRingLen, probRingLastFrame), {
      fromIdx: start,
      toIdx: f1,
      threshold: thr,
      minRunFrames,
      /**
       * ⭐ **「真的起来了」的峰值门槛** —— 光靠「连续 7 帧 ≥ 0.5」还不够 ✗
       * 音乐床能在阈值上下连续 7 帧达标 ⇒ 那 2 条「锚 +0.00」正是这么来的 ✗
       * 详见 `speech-run.js` 里 `peakThreshold` 的注释 ✓
       * ⚠️ 它**不抬基础阈值** ⇒ 轻声说话只要有一帧冲上去就算 ✓
       */
      peakThreshold: FIRST_SPEECH_PEAK,
      /** ⭐ 只读探针（不传 ⇒ 逐字不变 ✓） */
      probe,
    });
    if (probe && typeof probe === 'object') {
      probe.fromSec = start * frameSec;
      probe.toSec = f1 * frameSec;
      probe.f0 = start;
      probe.f1 = f1;
      probe.thr = thr;
    }
    return found === null ? null : found * frameSec;
  }

  /**
   * 硬边界门槛（毫秒）：静音超过它才算"这句真的说完了"。
   *
   * 这是 Deepgram 那套两级边界的本地等价物：
   *   VAD 静音（vadMinSilenceMs）  → 软边界：先发 final，文本到手但**先不收句**
   *   静音超过这个值              → 硬边界：收句
   * 中间那些被切出来的碎片会和后面拼成一句 —— 靠播放页本来就有的累积器，
   * 当初接 Deepgram 时它的多段 is_final 就是这么拼起来的。
   */
  const utteranceEndMs = Number(config.vadUtteranceEndMs ?? 900);

  /**
   * 新路"开口锚"要求**连续多少帧**概率达标（≈280ms，40ms 窗 ⇒ 7 帧）✗
   *
   * ⭐ **和旧路同一个数** —— 旧路的开口判据是 `ceil(minSpeechMs / frameMs)`，
   *    40ms 窗、280ms 门槛下正好 7 帧，日志里印成「开口需 7 帧」✓
   *
   * 为什么不能只看单帧：音乐床/呼吸在批起点就已经 ≥ 0.5 ✗
   * ⇒ 单帧判据会在批起点立刻返回 ⇒ `shift = 0` ⇒ 锚点形同不存在 ✗
   * 实测 7 次锚点里 2 次 `shift = 0.00`，而那两条正是跨度过长最严重的（1.2 / 0.3 字/秒）✗
   */
  const FIRST_SPEECH_MIN_RUN_FRAMES = 7;

  /**
   * ⭐ 开口锚的**峰值门槛**：那段连续帧里至少一帧要 ≥ 这个值 ✓
   *
   * 为什么光靠「连续 7 帧 ≥ 0.5」不够：**音乐床能在阈值上下连续 7 帧达标** ✗
   * 实测（`xhsp-anchor1` 闭环）那 2 条「锚 +0.00」的，正是跨度过长最严重的
   * （`1.2 字/秒` / `0.1 字/秒`）—— 而它们的窗口里音乐床一直贴着 0.5 ✗
   *
   * 取值依据（同一份真机日志的逐帧概率）：
   *   · 真语音 `33.35s` → **0.978** ✓
   *   · 音乐床 `27.32s` → **0.199** ✓（远在 0.5 以下，而它上下浮动时会越过 0.5）
   *   ⇒ 0.75 落在两者之间，而**比基础阈值 0.5 高** ✓
   *
   * ⚠️ **不是"抬基础阈值"** ✗：基础阈值仍是 0.5（旧路用的是 0.5，换它 = 两份真相 ✗）；
   *    这里只是额外要求"这一段里有一帧真的高" ⇒ 轻声说话仍然进得来 ✓
   */
  const FIRST_SPEECH_PEAK = 0.75;

  let stopped = false;
  let started = false;
  let ort = null;
  let vadSession = null;
  let vadState = null;

  /**
   * ⚠️ 两条**分开**的串行链，不能共用：
   *   vadChain   —— VAD 推理必须按帧顺序（state 有状态）
   *   httpChain  —— 识别请求很慢（几百毫秒）
   * 共用一条的话，一次识别会把后面所有 VAD 帧堵住，VAD 就"听不见"了。
   */
  let vadChain = Promise.resolve();
  let httpChain = Promise.resolve();

  /** 凑够 512 采样才是一帧 */
  let pending = new Int16Array(0);
  /** 自会话开始累计送入的采样数（绝对位置，不随裁剪变化） */
  let totalSamples = 0;
  /** 音频缓冲里第一个采样对应的绝对位置 */
  let baseOffset = 0;
  /** 音频缓冲（绝对位置 baseOffset ~ totalSamples） */
  let audio = [];

  /** 诊断用：喂进去多少帧、概率峰值、最近一次概率 */
  let framesFed = 0;
  /**
   * 被质量闸门拦掉的段数（幻听 / 无人说话 / 置信度低）。
   *
   * ⚠️ **按原因分开计** —— 原先只有一个 `rejected`，而它被印成「已拦掉 N 段**幻听**」✗
   * 于是看到那行的人（包括写这段的人）会以为"幻听清单拦了 N 段"，
   * 而它其实**主要**数的是数值闸门（无人说话 / 置信度低）✗
   *
   * 实测踩过：用户看到「已拦掉 1 段幻听」，无法判断那是**套话命中**（说明黑名单在干活）
   * 还是**数值闸门又误杀了真语音**（说明闸门有问题）—— 两者的处置方向完全相反。
   *
   * 而每一次丢弃本身**已经**印了原因和原文（见下面 `丢弃一段识别结果 · …`），
   * 所以这里只需把**汇总**也分开，别让标签说错。
   */
  let rejectedHallu = 0; // 命中幻听套话清单
  let rejectedGate = 0; // 数值闸门：无人说话 / 置信度低 / 解码回退
  let rejectedEmpty = 0; // 空文本（且 VAD 也没认）
  /**
   * 「空文本接力」的起点（绝对样本位置）；-1 = 没有待接力的音频。
   *
   * ⚠️ 它和 `rejectedEmpty` 是**相反的两件事**：
   *   · `rejectedEmpty` 是**丢了**
   *   · 这个是**留着，拼到下一句里重识**（见 `carryStartFor` 的实测说明）
   */
  let carryFrom = -1;
  /**
   * ⭐ 软边界之后的「还差多少静音才该收句」。
   *
   * ⚠️ 为什么需要它 —— 这是「句子留不住」那个抱怨的真正根子：
   *   软边界（静音 450~899ms）只发 `final`、不发 `utteranceEnd` ✓（设计就是"和后面拼"✓）
   *   而「静音继续到 utteranceEndMs 就该收句」那条**只在 flushSpeech 里被检查** ✗
   *   而 flushSpeech 只在**有新分片要发**时才被调用 ✗
   *   → 说话人真停了 ⇒ 没有下一个分片 ⇒ **再也检查不到** ⇒ utteranceEnd 永远不发 ✗
   *   → 碎片在 pending 里干等，最后由看门狗硬吐成一条「1 字」的字幕 ✗
   *
   * ⭐ 也就是说：「静音够久就收句」的触发条件，**恰恰是「静音够久」所排除的那个条件** ✗
   *
   * 所以这里记下"还差多少毫秒静音"，交给 `handleFrame` 那个**逐帧循环**去数 ✓
   * （它每帧都在跑，和"有没有新分片"无关 ✓）
   */
  let softEndNeedMs = 0;
  let softEndSilentMs = 0;
  /** 接力了几次（诊断用；**不是**"丢了几段"） */
  let carriedEmpty = 0;
  /** 「文本和音频时长对不上」被记了几次（诊断行只报前 3 条 ✓） */
  let flaggedFast = 0;
  /**
   * ⭐ 「字数/时长不合理」被**丢弃**了几次（v2.66.76 起真的拦了）。
   *
   * ⚠️ 和 `flaggedFast` 是两个数：那个是"诊断行打了几条"（封顶 3），
   *    这个是"真丢了几段"（不封顶，要能在 `已拦掉` 那行里看见 ✓）。
   */
  let rejectedFast = 0;
  /**
   * ⭐ **上一段**音频是怎么被切出来的（`'max-length'` = 到上限硬切）。
   *
   * ⚠️ 记的是「上一段」，不是「这一段」—— 因为要判断的是
   *    「**这一段是从被硬切的那句里掉下来的尾巴**」（见 `isHardCutTail` 的注释 ✓）。
   *    而硬切尾巴自己的切法是"静音"，从它自己的字段看不出来 ✗
   */
  let lastFinalCut = '';
  /** 被当成"硬切尾巴"丢掉文本的分片数（不封顶，要能在日志里看见真丢了几段 ✓） */
  let droppedHardCutTail = 0;
  /** 最近 60 秒的分片时长（诊断"切得太碎"用，见 `shouldHintShortSegments`） */
  const segStats = [];
  /** 上次「切得太碎」提醒的时刻（5 分钟内最多一次） */
  let shortHintAt = 0;
  /**
   * 被「VAD 说这一段确实是语音」**否决**掉的"无人说话"次数。
   *
   * ⚠️ 它不是"丢弃"的一类，而是**反过来**：这些段本来是会被丢的，最后一刻被放行了 ✓
   * 所以它不并进 `rejectedSummary` 那三个数（那三个是"被拦下的"）。
   */
  let releasedNoSpeech = 0;
  /** 因为太短被跳过的段数 */
  let skippedShort = 0;
  /** 因为缓冲里取不到那段音频而跳过的段数 */
  let skippedNoAudio = 0;
    /**
     * 「已喂给 gate 的帧数」—— `trimAudio` 的基准，理由见那个函数里的说明。
     * 自己数，不猜 gate 的内部字段（它没有暴露帧号）。
     */
    let framesFedToGate = 0;
    /** 「取到的音频比要的短」的计数，见 takeRange 后面那段说明 */
    let truncatedSegs = 0;
  /**
   * 收到了响应、但**认不出文本字段**的次数。
   *
   * ⚠️ 这和 `rejectedGate`（质量闸门拦下的段）是两回事，**必须分开计** ——
   * 混在一起的话，用户看到"丢弃一段 · 判定为无人说话"，会以为是音频问题，
   * 而实际是代码取的字段和服务端返回的形状对不上。
   */
  let shapeUnknown = 0;
  /** 短窗：最近约 3.2 秒的 {电平, 概率} —— 心跳那一栏看的就是它 */
  const win = [];
  /**
   * 长窗：**只**用来算「这条流自己的安静底噪」（低分位）。
   * ⚠️ 为什么不能拿短窗的中位当基准：人正在说话时中位会被说话本身抬高，
   * 于是"现在有没有声音"永远答"有" ✗ —— 底噪要用**长的低分位**才稳。
   */
  const levelHist = [];
  let maxProb = 0;
  let lastProb = 0;
  /**
   * ⚠️ 这是**原始**电平（归一化之前）—— 下面这些全都靠它，别拿归一化后的值填：
   * `vadLevelStats` 的 quietFloor/levelCeil、`deaf`、`sparse`、
   * 以及 `findLullCut` 的"这里是不是安静"。
   * 归一化后的值另有 `lastVadRms`，只用来把增益印出来 ✓
   */
  let lastInputRms = 0;
  /** VAD 支路的底噪估计（随每次 push 更新，见 `trackNoiseFloor`） */
  let vadNoiseFloor = 0;
  /** 最近一次 push 施加的增益（1 = 没放大） */
  let lastVadGain = 1;
  /** 最近一次 push 归一化之后的 RMS */
  let lastVadRms = 0;
  let lastBeatAt = 0;
  /**
   * ⭐ ⑥「语音起头了、但没凑够开口线」发生的**次数**。
   *
   * ⚠️ 为什么还要一个计数:`vadLevelStats` 里的 `sparse` 已经说了
   * 「认得太稀、凑不满一次开口」✓ —— **但它是个开关量**（当前窗口成不成立 ✗）,
   * 回答不了"到底发生了多少次" ✗。而"发生过几次"才是判断
   * 「要不要放宽开口线」的依据 ✓。
   * ⚠️ 只统计**起头后至少走到开口线一半**才断掉的脉冲 —— 否则一帧噪声抖动也算一次,
   * 那这个数就没有意义了 ✗。
   */
  let unopenedBursts = 0;
  /** 上一次 push 之后的 `speechRun`，用来发现"脉冲断掉但没开口" */
  let prevSpeechRun = 0;
  /** 这一轮心跳累计了多少次（决定什么时候印那条分布行） */
  let beatsSinceDist = 0;
  /** 上一个分布行报过之后、未开口发生了几次（报完清零，不累计） */
  let unopenedSinceDist = 0;
  /** 输出张量的实际键名与形状 —— 只在第一帧记一次 */
  let outKeys = '';
  let outShape = '';

  function newState() {
    return new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
  }

  async function loadOrt() {
    ort = globalThis.ort;
    if (!ort) {
      /**
       * ⚠️ 这条消息**不能假定自己在播放页**。
       *
       * 会触发它的至少有两个地方：播放页（有 `<script>` 引入，正常不会走到这里）
       * 和**设置页的「测试识别连接」**（那一页从来没引过 onnxruntime）。
       * 原来只说「播放页需要…」，于是设置页报错时用户跑去看播放页，方向完全错了。
       */
      throw new Error(
        'onnxruntime 没加载 —— 这个页面没有用 <script> 引入 vendor/ort.min.js。' +
          '（播放页和 offscreen 都该引；设置页的「测试识别连接」不引，' +
          '所以那个按钮测不了需要本地 VAD 的识别服务，请改用播放页实测。）' +
          '这属于扩展自身的缺失，请反馈。',
      );
    }
    try {
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
      // 单线程足够（不起线程池 Worker）。
        // ⚠️ 但别以为这样就不需要 SharedArrayBuffer —— 实测过：vendor/ort-wasm-simd-threaded.wasm
        // 的 memory import 声明为 shared（declared=1），非共享内存实例化会直接
        //   mismatch in shared state of memory
        // 所以 SAB 是**必需**的，与 numThreads 无关。好在扩展页面天然就有 SAB，
        // 不需要 COEP/COOP（已在 offscreen document 里量过：canAllocSAB=true、
        // crossOriginIsolated=false，并真的建出了 InferenceSession）。
        // （这句原来把 SAB 说成可以省掉，是错的 —— 而且它真的误导过一次排查。）
      ort.env.wasm.numThreads = 1;
    } catch {
      /* ignore */
    }
    return ort.InferenceSession.create(chrome.runtime.getURL('vendor/silero_vad.onnx'), {
      executionProviders: ['wasm'],
    });
  }

  /** 一帧 512 采样 → 语音概率 */
  async function speechProb(frame) {
    const input = new Float32Array(winSamples);
    for (let i = 0; i < winSamples; i += 1) {
      input[i] = (frame[i] || 0) / 32768;
    }
    /**
     * ⚠️ **这里不再写 `lastInputRms`** —— 帧是**归一化之后**的，写进去的话
     * 那一栏（以及 `vadLevelStats` / `findLullCut`）看到的就变成放大后的电平 ✗，
     * 而那套"相对这条流自己的底噪"的口径会整个失效 ✗
     * ⇒ 原始电平在 `push()` 里量（那里还拿着未归一化的 int16 ✓）
     */

    const out = await vadSession.run({
      input: new ort.Tensor('float32', input, inDims(winSamples)),
      state: vadState,
      sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(meta.sampleRate)]), srDims),
    });

    // 第一次跑就把输出的**实际键名**记下来。
    // ⚠️ 曾经因为取错键（out.output 是 undefined）而让概率恒为 0，
    // 而兜底返回 0 又把这件事掩盖成了"VAD 听不见" —— 两种原因的修法完全不同。
    if (!outKeys) {
      outKeys = Object.keys(out).join(',');
      const first = out.output ?? out[Object.keys(out)[0]];
      outShape = first?.dims ? `[${first.dims.join(',')}]` : '?';
    }

    vadState = out.stateN || out.state || vadState;
    const t = out.output ?? out[Object.keys(out)[0]];
    const p = t?.data?.[0];
    return Number.isFinite(p) ? p : NaN;
  }

  /**
   * 文本从哪来 —— 见上面 `backend` 的说明。别把整个 VAD 引擎复制一份给新服务。
   */
  async function transcribe(int16) {
    if (backend === 'dashscope') return transcribeDashscope(int16);
    return transcribeWhisper(int16);
  }

  /**
   * 阿里云百炼（DashScope）非实时语音识别，走 OpenAI 兼容的 HTTP 接口。
   *
   * ⚠️ 为什么必须走 HTTP，而不是像 Deepgram 那样开 WebSocket 流式：
   * DashScope 的流式接口**要求把 API Key 放在握手请求头**里（官方原文：「在 WebSocket
   * 握手请求中设置 Authorization。Authorization 是必需的。」「鉴权在握手阶段验证」）。
   * 而浏览器的 `new WebSocket()` **不允许设置任何请求头** —— Deepgram / OpenAI Realtime
   * 能直连是因为它们官方支持用 subprotocol 传凭据，DashScope 没有这个方案。
   * HTTP 接口用普通 `fetch`，请求头随便设，所以这是浏览器里唯一可行的路。
   * 扩展有 `<all_urls>` host 权限，跨域 fetch 也不受 CORS 限制。
   *
   * 代价：**非流式**，要等一整句说完才发请求，比流式多一句的延迟。
   * 这个取舍和当初选「本地 VAD + HTTP 发给 Whisper」是同一个 —— 延迟画面模式预算够。
   *
   * 已验证（对官方文档逐字段核对）：端点、鉴权头、请求体结构、音频用 base64 Data URL、
   * 响应取 `output.choices[0].message.content[0].text`、语种短码。
   * ⚠️ 未验证：没有真实 API Key，**从未真正调通**。首次使用请留意报错。
   */
  async function transcribeDashscope(int16) {
    const wav = buildWav(int16, meta.sampleRate);
    /**
     * 音频以 **base64 Data URL** 传（官方支持两种：公网可访问的 URL，或 Data URL）。
     * Data URL 不需要对象存储、不需要把音频暴露到公网 —— 对"音频不出本机"的诉求更友好。
     * 官方限制：**编码后**不超过 10 MB。16kHz 单声道 WAV 每秒约 32 KB，
     * base64 后约 1.33 倍 —— 本项目一句最长 5 秒（vadMaxSpeechSec），
     * 约 213 KB，离上限极远。
     */
    const dataUrl = `data:audio/wav;base64,${bytesToBase64(new Uint8Array(wav))}`;

    /**
     * 选端点 + 拼请求体。
     *
     * ⚠️ **两个端点的模型集合不一样**,这是用户实测撞过的:
     *   `qwen-audio-3.1-asr-flash` 在兼容端点下报
     *   404 `Unsupported model … for OpenAI compatibility mode`。
     * 所以这里按模型名(或设置页的显式选择)决定走哪一支,
     * **两支持各自的构造函数 —— 绝不用同一个拼**,否则很容易改坏已经跑通的那支。
     *
     * `config.endpoint` 里存着的**老版本默认值**不算数 —— 那是陈旧的脏数据,
     * 它会盖掉自动选择(详见 `resolveDashscopeEndpoint` 的注释)。
     * 只有**真正的自定义地址**才优先。
     */
    const picked = resolveDashscopeEndpoint(dsModel, config.endpointMode, config.endpoint);
    const endpoint = picked.url;
    const kind = picked.kind;

    /**
     * 内置术语表 → 热词（**只在原生端点这一支算** —— 兼容端点没有 vocabulary 的位置）。
     * 用户手填的在前，同名词以他的为准（`mergeGlossaryHotwords` 负责去重与跳过超长项）。
     */
    const mergedHotwords = mergeGlossaryHotwords(config.hotwords, global.glossaryWords);
    /**
     * ⚠️ 被跳过的条数要说出来。**静默丢弃**是这个项目的老教训 ——
     * 用户看着术语表里明明有那个词却没生效，会以为功能坏了。
     */
    if (!hotwordNoteSent && (mergedHotwords.dropped || mergedHotwords.overflow)) {
      hotwordNoteSent = true;
      const why = [];
      if (mergedHotwords.dropped) why.push(`${mergedHotwords.dropped} 个超长被跳过`);
      if (mergedHotwords.overflow) why.push(`${mergedHotwords.overflow} 个超出数量上限被跳过`);
      onEvent({
        type: 'status',
        status: 'hotwords',
        detail: `内置术语表已并入热词：+${mergedHotwords.added} 个（${why.join(String.fromCharCode(12289))}）`,
      });
    }
    const body =
      kind === 'native'
        ? buildDashscopeNativeBody({
            model: dsModel,
            language,
            dataUrl,
            prompt: config.prompt,
            /**
             * 内置术语表的源词并进用户手填的热词（**合并，不是替换**）。
             * 用户手填的优先；内置词表里不合规范的**跳过**并计数 ——
             * 内置词表不该让整个请求 400，而用户改不了它，报错也无从下手。
             */
            hotwords: mergedHotwords.text,
          })
        : buildDashscopeBody({ model: dsModel, language, dataUrl, prompt: config.prompt });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS);
    let res;
    try {
      const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      /**
       * 原生端点**必须带这个头**,否则会走 SSE 流式(官方 curl 示例里就有它)。
       * 兼容端点不需要,但带上也无害 —— 只在原生那支加,避免改动已跑通的请求。
       */
      if (kind === 'native') headers['X-DashScope-SSE'] = 'disable';
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new Error(`阿里云百炼超过 ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)} 秒没有响应（网络卡住？服务繁忙？）`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      /**
       * 把这几个状态码翻译成人话 —— 让用户一眼知道该去改什么。
       * 官方文档：「遇到 401/403 时，优先核对鉴权配置。」
       */
      let hint = '';
      const rawText = raw.toLowerCase();
      /**
       * ⚠️ **404 要能点明端点。**
       *
       * 用户实测撞过一次:填 `qwen-audio-3.1-asr-flash` 却走兼容端点 →
       * 404 `Unsupported model … for OpenAI compatibility mode`。
       * 光说"模型名不对"不够 —— **换模型名不等于只改名字,端点也得跟着换。**
       */
      if (res.status === 404 || rawText.includes('model_not_supported') || rawText.includes('unsupported model')) {
        hint =
          `（模型名或端点不对 —— **两个端点支持的模型不一样**:` +
          `「兼容端点」认 qwen3-asr-flash;「原生端点」认 qwen-audio-3.1-asr-flash 等。` +
          `到设置页把「端点」改成「自动」或「原生」再试）`;
      } else if (res.status === 401 || res.status === 403) {
        hint = '（API Key 无效、填错，或者不是这个地域的 Key —— 去设置页检查 DashScope API Key）';
      } else if (res.status === 429) {
        hint = '（频率超限或额度用尽 —— 到阿里云百炼控制台看用量；免费额度是 36000 秒 / 90 天）';
      } else if (res.status === 400) {
        /**
         * ⚠️ 400 要能**自诊断**。
         *
         * 上下文（提示词）那一段的形状是**拼两处官方文档得出的、从未被真实调用验证过**：
         *   · API 参考（兼容端点那节）只规定了 `role:'system'` 和"必须第一条"，**没给 content 形状**；
         *   · 「提升识别准确率」指南给了 `{type:'input_text',text}`，但例子用的是**原生端点**。
         * 而官方那页里 `input_text` **一次都没出现在兼容端点那节**（我核对过）。
         *
         * 所以用户第一次填提示词时有撞 400 的可能。**这里必须给出可行动的动作** ——
         * 「先清空提示词再试」，让他自己就能定位，不必回来问。
         * 这同时也是一条验证路径：清空后正常 = 提示词格式的问题；清空后仍 400 = 别的问题。
         */
        const promptNote = String(config.prompt || '').trim()
          ? '。⚠️ 你刚填了「提示词」，**先把它清空再试** —— 那一段的格式官方两处文档说法不一致，可能不被支持'
          : '';
        hint = `（请求被拒 —— 可能是模型名写错、音频不符合要求${promptNote}）`;
      } else if (res.status >= 500) {
        hint = '（阿里云服务端出错，稍后重试）';
      }
      throw new Error(`阿里云百炼返回 ${res.status}${hint}${raw ? '：' + raw.slice(0, 240) : ''}`);
    }

    const data = await res.json().catch(() => null);
    /**
     * ⚠️ 取文本走**共用函数** `pickDashscopeText` ——
     * 生产路径和设置页测试按钮必须是同一份,上一轮"两份实现只修了一份"就是这么栽的。
     *
     * 另外注意:`via` 为 null 表示**形状不认识**,和"音频里真的没人说话"是两回事。
     * 前者要报出来(见下面的 shapeNote),后者只能当空结果丢掉。
     */
    const { text, via } = pickDashscopeText(data);
    /**
     * ⚠️ 注意返回的 `data` 里**没有** segments/no_speech_prob/avg_logprob —— 那些是 Whisper 的。
     * 所以 `rejectReason` 对它只能跑"空文本"和"幻听套话"两道闸门，
     * 内容无关的置信度闸门在这里是缺席的。这是这个后端已知的能力差距。
     */
    return { text, data, via, shapeNote: via ? '' : dashscopeShapeNote(data) };
  }

  async function transcribeWhisper(int16) {
    const wav = buildWav(int16, meta.sampleRate);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', model);
    // ⚠️ 必须 verbose_json：只有它带 no_speech_prob / avg_logprob，
    // 而那正是**唯一不会误伤的幻听闸门**。
    // 用 json 的话，Whisper 在音乐/掌声上凭空吐出的"ご視聴ありがとうございました"
    // 会一路畅通地上屏（这个毛病存在了很久，根因就是这里没有闸门）。
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (language && language !== 'auto') form.append('language', language);
    /**
     * ⚠️ 提示词必须发出去。
     *
     * 这是**接线漏了**，不是新功能：分片模式（whisper-chunked）一直会发 `prompt`，
     * 而 VAD 模式没有 —— 于是用户在设置页填的提示词**静默无效**。
     * 对差音源 + 快语速尤其有用：可以把"说话快、有底噪、常见词是这些"塞进去引导。
     * 不填就不发，行为和以前完全一样（所以没有回归风险）。
     */
    if (prompt) form.append('prompt', prompt);

    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: form,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError') {
        throw new Error(`识别请求超过 ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)} 秒没有响应（服务卡住了？）`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Whisper 接口返回 ${res.status}${body ? '：' + body.slice(0, 240) : ''}`);
    }
    const data = await res.json();
    return { text: String(data?.text || '').trim(), data };
  }

  /**
   * 质量闸门 —— 和识别校正用的是同一套判据。
   *
   * 这是**内容无关**的那一道：Whisper 自己说"这段没人说话"或者"置信度很低"，
   * 就别把它的输出当回事。下面还有一道幻听清单兜底。
   *
   * @returns {null|string} null = 通过；否则是拒绝原因
   */
  function rejectReason(text, data) {
    if (!text) return '空文本';
    if (looksLikeHallucination(text)) return '命中幻听套话';
    const segs = Array.isArray(data?.segments) ? data.segments : [];
    for (const s of segs) {
      const t = Number(s?.temperature);
      if (Number.isFinite(t) && t > 0) return `解码回退到 temperature=${t}${readingNote(qualityStats(data))}`;
      const ns = Number(s?.no_speech_prob);
      if (Number.isFinite(ns) && ns > 0.6) return `判定为无人说话（no_speech_prob=${ns.toFixed(2)}）${readingNote(qualityStats(data))}`;
      const lp = Number(s?.avg_logprob);
      if (Number.isFinite(lp) && lp < -1.0) return `置信度低（avg_logprob=${lp.toFixed(2)}）${readingNote(qualityStats(data))}`;
    }
    return null;
  }

  /** 取绝对采样区间 [absStart, absEnd) 的拷贝 */
  function takeRange(absStart, absEnd) {
    const s = Math.max(baseOffset, absStart);
    const e = Math.min(totalSamples, absEnd);
    if (e <= s) return new Int16Array(0);
    const out = new Int16Array(e - s);
    let pos = baseOffset;
    for (const chunk of audio) {
      const cStart = pos;
      const cEnd = pos + chunk.length;
      pos = cEnd;
      if (cEnd <= s) continue;
      if (cStart >= e) break;
      const from = Math.max(0, s - cStart);
      const to = Math.min(chunk.length, e - cStart);
      out.set(chunk.subarray(from, to), cStart + from - s);
    }
    return out;
  }

  /**
   * 送一句去识别，然后**按两级边界**决定要不要收句
   *
   * @param {number} [speechMs] 这一段里 VAD 处于语音态多少毫秒（`gate` 的 `speechFrames × frameMs`）。
   *   ⚠️ 可选：`finalize` 那两处调用没有 gate 事件可依，传不进来就是"不知道"。
   *   而"不知道"时**不否决**（见 `noSpeechVetoed` 里对非有限值的处理）—— 宁可维持原判据 ✓
   */
  function flushSpeech(absStart, absEnd, reason, durationMs, silenceMs, speechMs) {
    const s = Math.max(baseOffset, absStart);
    const e = Math.min(totalSamples, absEnd);
    /**
     * 这一段 VAD 认了多少毫秒语音 —— 闸门末端的否决要用它。
     * ⚠️ 必须在进队列**之前**取：`gate` 的状态在这之后还会继续滚动。
     */
    const vadSpeechMs = Number(speechMs);
    const vadMinSpeechMs = Number(gate.minSpeechMs);
    // ⚠️ 不许静默 return：这一路曾经因为帧长口径不一致而"取不到音频"，
    // 结果只是"后面定住没新内容"，看不出任何原因。所有提前退出都要有痕迹。
    if (e - s < meta.sampleRate * 0.2) {
      skippedShort += 1;
      if (skippedShort <= 3 || skippedShort % 20 === 0) {
        onEvent({
          type: 'status',
          status: 'vad',
          detail: `跳过一段：太短（${((e - s) / meta.sampleRate).toFixed(2)}s）· 累计 ${skippedShort} 段`,
        });
      }
      return;
    }

    // ⚠️ 这里**不再丢弃过短片段**。
    // 曾经把短于 minUtteranceMs 的直接扔掉，代价是「はい」「ええ」这类短应答整句消失 ——
    // 用户反馈"丢信息"就是这个。噪声由下面的质量闸门负责，不该靠丢音频来治。

    /**
     * ⭐「合理断句」：`reason === 'max-length'` 时，切点是**按时间**定的 ——
     * 可能落在词中间。这里回看末尾有没有换气处，找到就把切点挪过去。
     *
     * ⚠️ 只对 `max-length` 做：
     *   · `silence` 那一路**本来就是切在停顿上**的，再挪一次纯属多余 ✗
     *   · `finalize` 那一路是"要停了"，必须把剩下的都收走，不能往回切 ✗
     *
     * ⚠️ 找不到（`findLullCut` 返回 0）→ **`cutEnd` 保持 `e`，逐字退回原样** ✓
     *   所以这个改动**只可能变好，不可能变坏**。
     */
    let cutEnd = e;
    /**
     * 「空文本接力」：上一段没识出字时，把它的音频一起带上（起点前挪）。
     * 取法见 `carryStartFor` —— 只往前挪，且受 CARRY_MAX_MS 与缓冲区边界两道约束。
     */
    const effStart = carryStartFor({
      start: s,
      carryFrom,
      baseOffset,
      capSamples: Math.round((meta.sampleRate * CARRY_MAX_MS) / 1000),
    });
    if (effStart < s) {
      if (carriedEmpty <= 3) {
        onEvent({
          type: 'status',
          status: 'vad',
          detail:
            `带上上一段没识出的音频 · 从 ${(effStart / meta.sampleRate).toFixed(1)}s 起` +
            `（多 ${((s - effStart) / meta.sampleRate).toFixed(1)}s）`,
        });
      }
    }
    let lullMovedSamples = 0;
    if (reason === 'max-length' && vadOpts.smartCut) {
      /**
       * ⚠️ 窗口由**上限**推出来（`min(1.5s, 上限 × 40%)`，见 `lullLookbackMs`）——
       * **不随上限放大**，否则"用户设的 8 秒会被偷偷变成 4 秒" ✗
       * 而上限很小时那条比例保底会生效，免得回看反而制造碎片。
       */
      const back = findLullCut(takeRange(s, e), meta.sampleRate, {
        lookbackMs: lullLookbackMs(vadOpts.maxSpeechMs),
      });
      // ⚠️ 挪完不能短于 0.5 秒 —— 否则"合理断句"会造出一个碎片，和它的目的相反 ✗
      if (back > 0 && e - back - s >= meta.sampleRate * 0.5) {
        cutEnd = e - back;
        lullMovedSamples = back;
      }
    }
    const pcm = takeRange(effStart, cutEnd);
    /**
     * ⚠️ 显式检查「取到的比要的少」——这原来是**静默**的 ✗
     *
     * `takeRange` 里 `s = Math.max(baseOffset, absStart)`，所以缓冲区被裁过头时会
     * 悄悄返回一段更短的音频，而送去识别的就是半句话（内容缺失 / 在残段上编词）。
     * 只报、不改行为 —— 截短已经发生，能做的只是让下一次看得见。
     */
    {
      const wantN = cutEnd - effStart;
      const gotN = pcm.length;
      if (wantN > 0 && gotN < wantN - Math.round(meta.sampleRate * 0.05)) {
        truncatedSegs += 1;
        if (truncatedSegs <= 5 || truncatedSegs % 20 === 0) {
          onEvent({
            type: 'status',
            status: 'vad',
            detail:
              '音频被缓冲区截断 · 要 ' + (wantN / meta.sampleRate).toFixed(2) + 's，' +
              '只取到 ' + (gotN / meta.sampleRate).toFixed(2) + 's' +
              '（缺头 ' + ((wantN - gotN) / meta.sampleRate).toFixed(2) + 's）' +
              ' · 累计 ' + truncatedSegs + ' 段',
          });
        }
      }
    }
    const startSec = effStart / meta.sampleRate;
    const durationSec = pcm.length / meta.sampleRate;
    if (!pcm.length) {
      skippedNoAudio += 1;
      onEvent({
        type: 'status',
        status: 'vad',
        detail:
          `取不到音频（要 ${(s / meta.sampleRate).toFixed(1)}~${(e / meta.sampleRate).toFixed(1)}s，` +
          `缓冲只剩 ${(baseOffset / meta.sampleRate).toFixed(1)}~${(totalSamples / meta.sampleRate).toFixed(1)}s）` +
          ` · 累计 ${skippedNoAudio} 段`,
      });
      return;
    }

    /**
     * 短片段统计 —— 见 `shouldHintShortSegments` 的实测说明。
     *
     * ⚠️ 只**提醒**、不自动改设置：静音确认调大对快语速主播是反效果。
     * 5 分钟内最多提一次，否则每段都提会把诊断面板刷爆。
     */
    const nowMs = Date.now();
    segStats.push({ at: nowMs, ms: pcm.length / meta.sampleRate * 1000 });
    while (segStats.length && nowMs - segStats[0].at > 60_000) segStats.shift();
    if (nowMs - shortHintAt > 5 * 60_000 && shouldHintShortSegments(segStats)) {
      shortHintAt = nowMs;
      const n = segStats.length;
      const short = segStats.filter((x) => x.ms < 1000).length;
      onEvent({
        type: 'status',
        status: 'vad',
        detail:
          `最近 60 秒有 ${short}/${n} 段短于 1 秒 —— Whisper 对这么碎的音频容易丢内容或凭空编词。` +
          `把「静音确认」从当前值调到 700~800ms 通常能改善（每个停顿都被当成句尾了）`,
      });
    }

    httpChain = httpChain
      .then(async () => {
        /**
         * ⚠️ `reason === 'finalize'` 排进来的收尾任务，**即便 stopped 已置真也必须跑完**。
         *
         * stop() 是先 flush、后置 stopped 的，所以这个任务入队时 stopped 还是 false，
         * 但轮到它执行时 stopped 已经是 true 了 —— 用原来的 `if (stopped) return`
         * 会把它自己丢掉，收尾白做（这正是"停止丢最后一句"的第二半）。
         */
        if ((stopped && reason !== 'finalize') || !pcm.length) return;
        const { text, data, via, shapeNote } = await transcribe(pcm);
        /**
         * ⚠️ **先分流"形状不认识",再走质量闸门。**
         *
         * `via === null` 表示**响应里没有我们认识的文本字段** —— 这**不是**
         * "音频里没人说话"。两者的处理完全相反：
         *   · 真的没人说话 → 正常丢掉，不打扰用户
         *   · 形状不认识   → **是代码和服务端不匹配，必须报出来**
         *
         * 为什么必须报：实测踩过一次 —— 原生端点返回的文本在 `output.text`，
         * 而代码在找 `output.choices[0].message.content[0].text`（猜的路径）。
         * 结果是**鉴权通过、请求体被接受（HTTP 200）、解析却永远是空**，
         * 用户只看到「识别成功 · 返回（空）」和"一直没有识别结果"，
         * 而这两句话完全指不出原因。
         *
         * 只报前两次：形状问题是持续性的，每句都报会把诊断面板刷爆。
         */
        if (!via && shapeNote) {
          shapeUnknown += 1;
          // 形状不认识 → 音频确实发过去了、只是解析不出来，接力没有意义（重发也还是这个形状）
          carryFrom = -1;
          if (shapeUnknown <= 2) {
            onEvent({
              type: 'status',
              status: 'vad',
              detail: `⚠ 收到响应但认不出文本字段（第 ${shapeUnknown} 次）· ${shapeNote}`,
            });
          }
          return;
        }
        // 质量闸门：Whisper 自己说没人说话 / 置信度低 / 命中套话，就整段丢掉
        /**
         * ⚠️ 末端多一道**否决**（`applyNoSpeechVeto`），而不是改 `rejectReason` 内部：
         * 原判据的返回值**逐字不变**，只是最后决定要不要执行。
         *
         * 依据是实测：VAD 报"说话中 · 连续 77 帧 · 0.9989"，而 Whisper 报
         * `no_speech_prob=0.86`、`avg_logprob=-0.10`（文本其实是可靠的）——
         * 两边矛盾时，那两句被整句扔掉了，而用户离线用同一段音频跑 Whisper 能出字 ✓。
         */
        const veto = applyNoSpeechVeto(rejectReason(text, data), { vadSpeechMs, vadMinSpeechMs });
        const why = veto.reason;
        if (why) {
          /**
           * ⭐ **空文本 + VAD 说这段确实是语音** → 不丢，留着和下一句一起重识。
           *
           * 实测（v2.66.61 用户导出）: 一句完整日语被 Whisper 返回成空文本，
           * 而我们整段丢掉，1.3 秒语音直接消失，下一句从半句开始。
           * 见 `carryStartFor` 的注释 —— 空文本只说明"这一遍没解出来"，不是"没有内容"。
           */
          if (why === '空文本' && noSpeechVetoed({ vadSpeechMs, vadMinSpeechMs })) {
            carriedEmpty += 1;
            carryFrom = carryFrom >= 0 ? Math.min(carryFrom, effStart) : effStart;
            if (carriedEmpty <= 3) {
              onEvent({
                type: 'status',
                status: 'vad',
                detail:
                  `空文本 · 音频先留着，和下一句一起重识` +
                  `（已攒 ${((e - effStart) / meta.sampleRate).toFixed(1)}s，第 ${carriedEmpty} 次）`,
              });
            }
            return;
          }
          // 其它理由的拒绝：音频不留（那些本来就是"这段不算内容"）
          carryFrom = -1;
          if (why === '命中幻听套话') rejectedHallu += 1;
          else if (why === '空文本') rejectedEmpty += 1;
          else rejectedGate += 1;
          onEvent({
            type: 'status',
            status: 'vad',
            detail: `丢弃一段识别结果 · ${why} · 原文「${text.slice(0, 24)}」`,
          });
          return;
        }
        /**
         * ⭐ **文本和音频时长对不上** → 按幻听处理：不采信，但**音频留着**拼到下一句重识。
         *
         * 实测（v2.66.64 用户日志）：0.7s 的分片、其中静音 480ms（真正语音 ~220ms），
         * Whisper 却给出 9 个字「横のボタンを押して」—— 每秒 40 字，不可能。
         * 它随后被拼进下一句真话里，整句读不通。判据见 `looksTooFastForAudio`。
         *
         * ⚠️ **不能用 `vadSpeechMs` 直接当时长**（v2.66.66 的教训）：gate 的 `speechFrames`
         * 在语音态里**每帧都自增**，包括还没达到静音门槛的那段尾巴 —— 于是它约等于**分片总长**。
         * 实测：0.7s 的分片报出来是 0.7s，于是 14 个字 / 0.7s = **20.0 字/秒**，
         * 正好卡在阈值上，两次幻听（「横のボタンを押してください」「どうもありがとうございました」）
         * 全漏了过去 ✗
         * 真正该用的是「**分片时长 − 静音**」——那才是说话的那段时间（0.7 − 0.48 = 0.22s）。
         * 取法见 `effectiveSpeechMs`。
         */
        const speechMsForGuard = effectiveSpeechMs({
          durationMs: (pcm.length / meta.sampleRate) * 1000,
          silenceMs,
          vadSpeechMs,
        });
        /**
         * ⭐ **超阈值就丢 —— 但绝不接力**（v2.66.76）。
         *
         * ⚠️ 这一条被改过两次，三版的历史必须记着，否则会再走一遍：
         *
         *   · v2.66.67：拒绝文本 **+ 把音频接力到下一句**（`carryFrom = effStart`）
         *     → 真机连跑几轮，用户明确反馈**比不拦更差** ✗
         *       出现「かはない」「を設定」这种从半句开始的拼接。
         *     → 病根**不是"拦"**，而是**"接力"**：把上一段的音频并进下一段，
         *       而 Whisper 对"从词中间开始的长音频"更容易丢开头，等于用一个错误换另一个 ✗
         *
         *   · v2.66.70：退回"只记录、不拦" ✗
         *     → 于是「横のボタンを押してください」这类**纯幻觉**直接上屏 ✗
         *       三份真机日志（v2.66.75）里它反复出现，还有「では、また。」「あーついてこそ」✗
         *
         *   · v2.66.76（现在）：**拦，但不接力** ✓
         *     → 文本丢，`carryFrom = -1`（和上面其它拒绝理由同一个做法 ✓）
         *     → 那 0.2 秒的碎片里本来也只有 1~2 个字（真的说出 13 个字需要 1.6 秒 ✗）
         *       → **丢掉它损失极小；而留在屏幕上是一个凭空编出来的句子** ✗
         *
         * ⚠️ 将来若要再动这条，**先看 `carryFrom` 有没有被设** ——
         *    那才是 v2.66.67 失败的原因，不是 `return` 本身 ✓
         */
        if (looksTooFastForAudio(text, speechMsForGuard)) {
          flaggedFast += 1;
          rejectedFast += 1;
          // ⭐ 不接力：这段音频就此作废，不拼到下一句（v2.66.67 就是在这里栽的 ✗）
          carryFrom = -1;
          if (flaggedFast <= 3) {
            const sec = Math.max(0.001, speechMsForGuard / 1000);
            onEvent({
              type: 'status',
              status: 'vad',
              detail:
                // ⚠️ 必须打**判据真正用到的那个时长**（`speechMsForGuard`），不是 `vadSpeechMs` ——
                // 后者约等于分片总长，两行数字对不上会让人以为判据算错了（v2.66.67 就犯过）
                `⚠ 丢弃 · 字数/时长不合理（${[...text].length} 字 / ${sec.toFixed(2)}s 说话` +
                ` = ${([...text].length / sec).toFixed(0)} 字/秒，判据：语音 ${sec < 0.35 ? '<350ms' : '比'} 装不下这些字` +
                `，分片 ${(pcm.length / meta.sampleRate).toFixed(1)}s 含静音 ${Math.round(Number(silenceMs) || 0)}ms）` +
                ` · 原文「${text.slice(0, 24)}」`,
            });
          }
          // ⭐ 不采信这段文本；也不发 final / utteranceEnd（那会把它送到屏幕上 ✗）
          return;
        }
        /**
         * 放行也是**一个决定**，而决定必须看得见 ✓ —— 只报前 3 次，
         * 否则每句都报会把诊断面板刷爆（和 `skippedShort` 同一个做法）。
         */
        if (veto.released) {
          releasedNoSpeech += 1;
          if (releasedNoSpeech <= 3) {
            onEvent({
              type: 'status',
              status: 'vad',
              detail:
                `⚠ VAD 认了这一段（${(vadSpeechMs / 1000).toFixed(1)}s 语音），` +
                `已放行被「${veto.released}」判掉的文本 · 原文「${text.slice(0, 24)}」`,
            });
          }
        }
        /**
         * ⚠️ 这里曾经尝试过"按 Whisper 返回的 segments 逐段上屏"，**已经撤掉**。
         *
         * 当时的推断是"segments 是语言模型给的句子边界，比静音门槛准" —— 推断错了。
         * 实测（真实直播）：一个 2.3 秒的片段被切成 2 句、5 秒被切成 3 句，
         * 每句 1 秒出头，日语一句话不可能这么短。
         * whisper.cpp 的 segments 是**紧密相邻的解码切块**（更早的实验里就量到过
         * 6.24→6.24、8.84→8.84 这种零间隔），不是句子边界。
         * 按它切只会更碎，所以回到"静音两级边界"这一套。
         *
         * ⚠️ 下面这行 final **必须**发：它是"文本先到手"的那一步。
         * 删掉软边界就永远不上屏 —— 我在改写这段时删过两次，都被测试抓到。
         */
        /**
         * ⚠️ `cut` 带的是**这一段音频是怎么被切出来的**（`max-length` = 到上限硬切）。
         *
         * 为什么要往上传：排期层要靠它判断"这句话本来没说完"，
         * 从而把后面那条**很短的尾巴**（合理断句切出来的）合并回来。
         *
         * ⚠️ 字段名**不能叫 `reason`** —— `lib/utterance.js` 的 `endUtterance` 已经在用
         * `ev.reason` 表示「speech_final / utterance_end」那个**另一层**的原因了。
         * 两者是不同的东西：一个是"音频怎么切的"，一个是"谁宣布这句话结束的"。
         */
        /**
         * ⭐ **硬切之后掉下来的尾巴：文本不采信** ✗（v2.66.77）
         *
         * 实测形态（用户真机 v2.66.75，三份日志都这样）：
         *   分片 5.2s · 26 字 · 收句（够长）      ← 到上限**硬切**了一刀
         *   分片 0.7s ·  2 字 · 静音 480ms · 先不收   ← 剩下的尾巴
         * → 0.7 − 0.48 = **0.22 秒语音**，而 Whisper 仍吐了两个字 ✗
         * → 那两个字被合并进下一句 → 「お札とかも」变成「**ある** とかもあるよ」✗
         *
         * ⭐ 病根不是"合并"（合并是对的 ✓），是**那 0.2 秒本来就认不出** ✗ ——
         *    它从**词中间**开始（硬切时人还在说话），Whisper 起手就是半个词 ✓
         *
         * ⚠️ 三条边界（都由 `isHardCutTail` 的判据保证）：
         *   ① **不丢**「はい」「ええ」那种完整短应答 ✓ —— 它的 `prevCut` 不是 `max-length` ✓
         *   ② **不接力音频** ✗ —— v2.66.67 栽在这里（比不拦更差 ✓）
         *   ③ 只在**语音 < 250ms** 时生效 ✓ —— 稍长一点的尾巴仍然照常合并 ✓
         */
        const hardCutTail = isHardCutTail(lastFinalCut, speechMsForGuard);
        if (hardCutTail) {
          droppedHardCutTail += 1;
          if (droppedHardCutTail <= 3) {
            const sec = Math.max(0.001, speechMsForGuard / 1000);
            onEvent({
              type: 'status',
              status: 'vad',
              detail:
                `⚠ 丢弃 · 极短尾巴（${[...text].length} 字 / ${sec.toFixed(2)}s 说话 < ` +
                `${HARD_CUT_TAIL_SPEECH_MS}ms，上一段是「${lastFinalCut || '?'}」）` +
                ` · 分片 ${(pcm.length / meta.sampleRate).toFixed(1)}s 含静音 ${Math.round(Number(silenceMs) || 0)}ms` +
                ` · 原文「${text.slice(0, 24)}」`,
            });
          }
        } else {
          // ⚠️ 只在**采信**这段文本时才更新 `lastFinalCut` ——
          //    否则连着两条尾巴时，第二条会因为上一段被改成"静音"而漏判 ✗
          lastFinalCut = String(reason || '');
        }
        if (hardCutTail) {
          // 文本不采信：不发 final（那会把它送进累积器 → 污染下一句 ✗）
        } else {
          onEvent({ type: 'final', text, start: startSec, duration: durationSec, cut: reason });
        }
        /**
         * ⭐ 「合理断句」把切点往前挪了 —— 而 `[cutEnd, e)` 那一段**语音是真的** ✗
         *
         * 它既不在本句里（本句只到 `cutEnd`），也不会在下一句里
         * （下一句的起点是"重新开口后"的 onset，而且 gate 那时已经 `reset` 过了）✗
         * → **那 0 ~ 1.5 秒的话被静默丢掉了** ✗✓✓
         *
         * 实测形态（v2.66.74，合理断句开）：整句
         * `私が作ったお守りだったらある` 被识别成 `たを守りだったらある ある`
         * —— 开头被吃掉、尾音重复了一遍，正好是"切点落在词中间 + 尾巴没接上"。
         *
         * 修法**不是**"别挪切点"（挪切点是合理断句的全部意义 ✓），
         * 而是**把丢掉的那一段接力给下一句** ✓ —— 复用已有的 `carryFrom`
         * （就是"空文本接力"那一套，见 `carryStartFor`）：
         * 下一句的起点会往前接到 `cutEnd`，那段语音就回来了 ✓
         * ⚠️ 上限由 `CARRY_MAX_MS` 兜着，不会一路把整段历史带上 ✓
         * ⚠️ 挪了才接力（`lullMovedSamples > 0`）；没挪就照旧清空 ✓
         */
        carryFrom = lullMovedSamples > 0 ? cutEnd : -1;

        /**
         * 「有句末标点」不能无条件收句。
         *
         * ⚠️ 实测：Whisper 会给一个 0.7 秒、3 个字的碎片也加上句号，
         * 于是 `0.7s 一句 · 3 字 · 收句（句末标点）` 单独成条 —— 碎片的第二大来源。
         * 太小的段不给它收句资格，让它并进下一句。
         */
        const tiny = durationSec < 1.0 || text.length < 5;
        const looksComplete = !tiny && /[.。!?！？…]["'）)」』]?$/.test(text.trim());
        /**
         * 硬边界条件（满足任一就立刻收句）：
         *   ① 这段**够长** —— 关键的一条
         *   ② 文本自带句末标点
         *   ③ 超长强制切断
         *
         * ⚠️ ① 是实测补上的。原来只有 ②③，于是一堆 0.6~1.6 秒的碎片全都"先不收"，
         * 累积器只能等 3 秒看门狗才吐 —— 实测出现「整句上屏 · -11.6s 后 · 77 字 ·
         * 识别滞后 17.6s」，字幕又长又迟到。
         * 加了"够长就收句"之后，持有最多跨一段，不会无限攒。
         */
        /**
         * 实测校准：Deepgram 那次**没有一条低于 12 字**，而这里 1.2 秒/6 字
         * 这种碎片仍然会单独成条。把门槛抬到 1.5 秒 / 10 字，让它和后面拼起来。
         * 门槛不能太高：抬过头就变成"什么都要拼"，持有变长、字幕又迟到。
         */
        const substantial = durationSec >= 1.5 || text.length >= 10;
        /**
         * ⚠️「合理断句挪过的那一刀算软边界还是硬边界」——**算硬边界，而且只能算硬边界**。
         *
         * 这个问题被提出来过（直觉是"切在换气处说明人还要继续说，那半句应该和后面拼"），
         * 但**在当前参数下不成立**，两条都算得出来：
         *
         * ① **`reason === 'max-length'` 这一条其实可有可无** ——
         *    回看挪完的段长 = 上限 − 窗口，最短也有 `上限 − 1.5s`
         *    （上限 5s → 最短 3.5s；上限 3.5s → 最短 2.1s）
         *    → **必然 ≥1.5s → 必然 `substantial`** → 无论如何都是硬边界。
         *    换句话说：**把 `max-length` 从 hard 里拿掉，行为一个字都不会变** ✗
         *
         * ② 要真让它变软，就必须**同时豁免 `substantial`** ——
         *    而 `substantial` 还管着别的路径（它是"碎片先不收"的主要兜底）✗
         *    豁免之后 5s + 5s 会攒成 ~50 字的字幕，而本项目自己的实测结论是
         *    「Deepgram 那次**没有一条低于 12 字**，最长 32 字」→ **那是变差，不是变好** ✗
         *
         * ③ 而回看切在**换气处**，那本来就是**自然边界** ——
         *    所以"当硬边界收句"是**一致的**：切点已经是"这句说完了"的样子 ✓
         *
         * 所以这里**故意保留** `reason === 'max-length'`（它让"超长被切断"这条语义
         * 在判据里显式可见，而不是靠"反正 substantial 会兜住"这种隐式依赖）。
         * ⚠️ 断言 `合理断句：挪过的那一刀必然被 substantial 兜成硬边界` 钉住了这个算术 ——
         *    哪天有人只改一半（把 max-length 拿掉却忘了 substantial 依然成立），它会报出来。
         */
        const hard =
          reason === 'max-length' || substantial || looksComplete || (Number(silenceMs) || 0) >= utteranceEndMs;
        let note = '';
        if (hard) {
          onEvent({ type: 'utteranceEnd' });
          note = looksComplete
            ? '（句末标点）'
            : substantial
              ? '（够长）'
              : `（静音 ${Math.round(Number(silenceMs) || 0)}ms）`;
          // 已经收句了 —— 没有"待收"这回事
          softEndNeedMs = 0;
          softEndSilentMs = 0;
        } else {
          /**
           * ⭐ 软边界：这一句先不收，和后面拼 ✓ —— 但**记下还差多少静音就该收** ✓
           *
           * ⚠️ 这一句必须放在 `onEvent({type:'final'})` **之后**（它在上面的 L2290 一带）——
           *    否则计时器可能先发 `utteranceEnd`，把一条**还是空**的整句收掉 ✗
           *
           * ⚠️ `final` 已经发出去了，所以此刻累积器里已经有这段文本 ✓
           *    → 计时器到点再发 `utteranceEnd`，就是把"这段文本"收掉 ✓ 顺序安全 ✓
           */
          softEndNeedMs = softEndNeed(silenceMs, utteranceEndMs, hard);
          softEndSilentMs = 0;
        }
        onEvent({
          type: 'status',
          status: 'chunk',
          detail:
            `${durationSec.toFixed(1)}s 一句${reason === 'max-length' ? '（超长被切断）' : ''} · ${text.length} 字` +
        /**
         * ⚠️ 只在**真的挪过**时才加这一句。措辞保留「超长被切断」不动 ——
         * 已经有断言盯着那个字符串，而这次的改动只是**补充信息**，不该改既有文案。
         */
        (lullMovedSamples ? ' · 已挪到换气处' : '') +
            ` · 静音 ${Math.round(Number(silenceMs) || 0)}ms · ${hard ? `收句${note}` : '先不收，和后面拼'}` +
            /**
             * ⚠️ 硬切尾巴这一行必须**说清文本没进累积器** ——
             *    否则它和正常的「先不收，和后面拼」长得一模一样 ✗，
             *    而读日志的人会以为这段文字待会儿会合进下一句（实际不会 ✓）。
             */
            (hardCutTail ? ' · 硬切尾巴，文本不采信' : '') +
            `${rejectedSummary(rejectedHallu, rejectedGate, rejectedEmpty, carriedEmpty, rejectedFast)}`,
        });
      })
      .catch((err) => onEvent({ type: 'error', message: err.message || String(err) }));
  }

  async function handleFrame(frame) {
    if (!vadSession) return; // 模型还没加载好，先丢掉这几帧（启动阶段很短）
    const p = await speechProb(frame);
    framesFed += 1;
    const ok = Number.isFinite(p);
    if (ok && p > maxProb) maxProb = p;
    lastProb = ok ? p : NaN;

    /**
     * 区分"没人说话"和"VAD 不认"。
     *
     * 这两种在单次读数上长得一样（概率都是 0），但修法完全相反：
     *   没人说话 → 不是 bug，等就行
     *   VAD 不认  → 是真 bug，得查状态/输入
     *
     * ⚠️ 判据**不能**用绝对电平门槛 —— 原来就是，而实测那种流里只有 **4%** 的帧够得着，
     * 于是那句警告**恒为 false**（设计来抓这个场景的告警，在这个场景下永远不响 ✗）。
     * 现在改成**相对这条流自己的安静底噪**，并额外分出
     * 「VAD 认得太稀、凑不满一次开口」那种形态。
     * 两处的计算都在模块级的 `vadLevelStats` 里 —— 那一段才是可测的。
     */
    if (Number.isFinite(lastInputRms)) {
      win.push({ rms: lastInputRms, p: ok ? p : 0 });
      if (win.length > 80) win.shift(); // 80 帧 ≈ 3.2 秒
      levelHist.push({ rms: lastInputRms });
      if (levelHist.length > 240) levelHist.shift(); // 240 帧 ≈ 9.6 秒 —— 底噪要有足够长的样本
    }

    // 心跳：没有它就只能看到"一直没有结果"，看不出是帧没进来、概率上不去、
    // 还是状态机不收句 —— 这三种原因的修法完全不同。
    const now = Date.now();
    if (now - lastBeatAt > 3000) {
      lastBeatAt = now;
      const lv = vadLevelStats(
        { recent: win, baseline: levelHist },
        {
          threshold: gate.threshold,
          exitThreshold: gate.exitThreshold,
          minSpeechMs: gate.minSpeechMs,
          frameMs: gate.frameMs,
        },
      );
      onEvent({
        // ⚠️ 用单独的 status：它只是读数，不是"识别请求回来了"。
        // 用 'chunk' 会污染播放页那个「已发出/回来」计数器，还会给出错误的建议。
        type: 'status',
        status: 'vad',
        detail:
          `帧 ${framesFed} · 概率 ${ok ? lastProb.toFixed(4) : 'NaN'}（峰值 ${maxProb.toFixed(4)}，阈值 ${gate.threshold}）` +
          ` · 输入电平 ${lastInputRms.toFixed(4)}` +
        `${lastVadGain > 1.01 ? ` → ${lastVadRms.toFixed(4)}（增益 ${lastVadGain.toFixed(1)}×）` : ''}` +
        ` · ${gate.inSpeech ? '说话中' : '静默'}` +
          vadLevelLine(lv, { seconds: win.length / 25 }) +
          /**
           * ⚠️ VAD 支路的"落后"读数 —— 没有它，`trimAudio` 剪错基准这件事**看不见** ✗
           *
           * `push()` 同步记账，`handleFrame()` 串行异步消费；两者一拉开，
           * 缓冲区就会剪掉**还没被处理**的音频，送去识别的就是半句。
           * 而症状（缺字 / 残段编词）和"识别质量差"长得一样，靠猜永远猜不到这里 ✗✓✓
           *
           * ⚠️ 只在真落后时才追加：正常时整行**逐字不变**（有断言钉着那几栏）✓
           */
          `${(framesFedToGate - (Number(gate.frameIndex) || 0)) >= 25
            ? ` · ⚠ VAD 落后 ${framesFedToGate - (Number(gate.frameIndex) || 0)} 帧` +
              `（${((framesFedToGate - (Number(gate.frameIndex) || 0)) / 25).toFixed(1)}s）`
            : ''}` +
          `${outKeys ? ` · 输出键 [${outKeys}]${outShape}` : ''}`,
      });
      /**
       * ⭐ ③ 电平分布那条**单独一行、低频**（约每 10 次心跳 = 30 秒一次 ✗）。
       *
       * ⚠️ 不并进上面那行:它已经 200 字符左右了,再塞三个分位会读不动 ✗ ——
       * 而这一项要的是"偶尔看一眼趋势",不是逐帧 ✓
       */
      beatsSinceDist += 1;
      if (beatsSinceDist >= 10) {
        onEvent({
          type: 'status',
          status: 'vad',
          detail: vadLevelDistLine(lv, {
            seconds: (win.length / 25) * beatsSinceDist,
            unopened: unopenedSinceDist,
            beats: beatsSinceDist,
          }),
        });
        beatsSinceDist = 0;
        unopenedSinceDist = 0;
      }
    }

    /**
     * ⚠️ 拿不到概率时**也要 push**，不能直接 return。
     *
     * gate 的 `frameIndex` 是"音频位置"的唯一记账（`toSamples` 靠它算切片，
     * `trimAudio` 也靠它算保留范围），而 `totalSamples` 是无条件推进的。
     * 这里一 return，gate 就少算一帧 —— 两边**永久错位，而且只增不减**：
     * 实测 10 帧里 4 帧 NaN 就偏了 0.144s。次生后果更难看：NaN 持续时 gate 冻在语音态 →
     * `trimAudio` 的保留起点固定不变 → **`audio` 数组无限增长**。
     * gate 内部本来就正确处理 NaN（推进计数、不动状态机），所以直接喂给它就行。
     */
    const ev = gate.push(ok ? p : NaN);
    /**
     * ⭐ 把这一帧的概率记进历史 —— 新路的"开口锚"靠它 ✓
     *
     * ⚠️ 位置在 `gate.push` **之后**：`push` 里已经 `frameIndex += 1`，
     *    所以刚喂进去的那一帧是 `frameIndex - 1` ✓（用错就是整整差一帧 = 40ms）
     * ⚠️ 新路/旧路**都要记** —— 锚点只在新路上用，但历史是同一份 ✓
     */
    recordProb(Math.max(0, (Number(gate.frameIndex) || 1) - 1), ok ? p : NaN);
    /**
     * ⭐ ⑥「起头了但没凑够开口线」的计数。
     *
     * ⚠️ 判据:`speechRun` 从有到无、**而 `inSpeech` 始终没立起来** ⇒ 那个脉冲没能开口 ✓
     * ⚠️ 门槛:`speechRun` 至少要走到开口线的一半才算"起头" ——
     * 否则一帧概率抖动也算一次,这个数就没意义了 ✗
     * ⚠️ 必须在 `gate.push` **之后**取:`gate` 的 push 里已经把这个帧算进 `speechRun` 了 ✓
     */
    const needHalf = Math.max(1, Math.ceil(Number(gate.minSpeechMs) / Number(gate.frameMs) / 2));
    if (!gate.inSpeech && gate.speechRun === 0 && prevSpeechRun >= needHalf) {
      unopenedBursts += 1;
      unopenedSinceDist += 1;
    }
    prevSpeechRun = gate.speechRun;
    /**
     * ⭐ **新断句路径：VAD 到此为止** ✗
     *
     * 从这里往下全是旧路的东西 —— 静默计时器、`gate.toSamples` 切片、
     * `flushSpeech` 送识别、两级边界收句。新路**一个都不用**：
     *   · 切句由 Whisper 的 segments 决定 ✓
     *   · 收句由「`end` 之后有没有静音」决定 ✓（用的是 `silence-span.js` 的 RMS，不走 gate）
     *   · 推进由 `whisper-batch.js` 的批次循环决定 ✓
     *
     * ⚠️ 若两条路同时跑，会**把同一段音频识别两遍**（CPU 双倍、字幕重复）✗
     *    —— 所以这里必须 `return`，不是"跳过某一段"✓
     * ⚠️ 而 `gate.push()` 已经在上面跑过了 ⇒ `gate.inSpeech` / `gate.frameIndex`
     *    仍在更新 ⇒ `trimAudio()` 的基准仍然有效 ✓
     */
    if (segmentLoop) return;
    /**
     * ⭐ 独立的静默计时器 —— 「软边界之后，静音累计够就自己收句」✓
     *
     * ⚠️ 为什么必须在这里而不是只靠 `flushSpeech` 里那条 `silenceMs >= utteranceEndMs`：
     *    那条只在**有新分片要发**时被检查，而"静音够久"恰恰意味着**没有新分片** ✗
     *    —— 判据的触发条件被它自己的前提排除了 ✗
     *    这个循环**每帧都在跑**（和"有没有新分片"无关 ✓），所以它能看见"人真的停了"✓
     *
     * ⚠️ 重复收句怎么防：
     *    · 发过一次就清零 ✓
     *    · 而下一段 `flushSpeech` 会重新设（软）或直接收（硬）✓
     *    · 所以同一个 pending 不会被收两次 ✓
     * ⚠️ 提前收句怎么防：
     *    · 只有 `softEndSilentMs >= softEndNeedMs` 才发，而 `softEndNeedMs` = 收句静音 − 已静音 ✓
     *    · 也就是说总静音时长**仍然必须达到 `utteranceEndMs`** ✓ 一分不少 ✓
     * ⚠️ 人又开口时立刻作废（下面 `gate.inSpeech` 那一支）—— 否则会收在半句话中间 ✗
     */
    if (softEndNeedMs > 0) {
      const tick = softEndTick(
        { needMs: softEndNeedMs, silentMs: softEndSilentMs },
        { inSpeech: gate.inSpeech, frameMs: gate.frameMs },
      );
      softEndNeedMs = tick.needMs;
      softEndSilentMs = tick.silentMs;
      if (tick.fire) {
        // ⚠️ 和硬边界那一处发的是**同一个事件**（`lib/utterance.js` 的 `endUtterance`）——
        // 它收的是累积器里**已经攒下的文本**，而此刻那段文本早就在里面了（`final` 先发）✓
        //
        // ⚠️ 而这里必须带 `soft: true` ✗：这个计时器的判据**只看"静音够久"**，
        //    不看累积器里有多少字 ✗ —— 于是它会**撤销"先不收，和后面拼"那个决定** ✗
        //    （实测：「分片 · 1.2s 一句 · 1 字 · 先不收」→ 900ms 后
        //      「整句上屏 · 1 字 · utterance-end」⇒ 一个字单独成句 ✗）
        //    ⭐ 这和 v2.66.29 修的那个「看门狗撤销断句决定」是**同一个形态** ✗
        //    → 所以这个事件要能被下游认出来，由累积器**按长度**决定收不收 ✓
        onEvent({ type: 'utteranceEnd', soft: true });
      }
    }
    if (!ev) return;
    if (ev.type === 'start') {
      // 新的一句开始了 —— 上一句的"待收句"作废（它自己的 final 会重新决定）
      softEndNeedMs = 0;
      softEndSilentMs = 0;
      // 新的一句：清掉上一句的循环状态
      vadState = newState();
      return;
    }
    // ⚠️ 必须显式传 frameSamples=winSamples。
    // 不传的话 toSamples 会用默认常量（576），而自检挑中的窗长可能是 640 ——
    // 帧号乘错之后位置会越算越偏（第 100 帧就差 6.4 秒），最后落到已裁剪的缓冲之外，
    // 取不到音频就静默 return。症状是"开始还行，后面定住没新内容"。
    const { start, end } = gate.toSamples(ev.startFrame, ev.endFrame, {
      totalSamples,
      frameSamples: winSamples,
      /**
       * ⚠️ `max-length` 硬切时**不补尾白** —— 那一路语音还在继续，
       * 而下一段的头部补白会把 `endFrame` 附近再取一遍 ✗
       * → 两边各补 200ms ⇒ 重叠 400ms ⇒ 重叠区那个词被识别两遍 ✗
       *   实测（v2.66.74 · 合理断句关）：`…中に入っているのは神様のお墓。`
       *   紧接着 `神様の力 自分は作るだけで` —— `神様の` 出现在两条字幕里 ✗✓✓
       * 尾巴不补：本段仍到 `endFrame` 为止（一个字不丢 ✓），重叠降到 200ms ✓
       */
      padEnd: ev.reason !== 'max-length',
    });
    /**
     * ⚠️ 把「这一段 VAD 认了多少**毫秒**语音」一起传下去 —— 闸门末端要用它否决
     * 「判定为无人说话」（实测那次误杀里 VAD 报的是"说话中 · 连续 77 帧 · 0.9989"）✓
     *
     * 用 `ev.speechFrames × gate.frameMs`：`speechFrames` 只在**语音态**里自增，
     * 开口之前那点前奏不算，所以它就是"这一段里 VAD 认定的语音时长" ✓
     *
     * ⚠️ `gate.frameMs` 是**实际帧长**（自检可能把窗长抬到 640 → 40ms），
     * 不能拿常量顶 —— 那是"两个 frameMs"那个旧坑 ✗
     */
    /**
     * ⭐「丢弃过短片段」—— **只有用户打开那个开关时才走这里** ✓
     *
     * ⚠️ 判据用的是 `ev.tooShort`（`vad-gate.js` 早就算好了：`durationMs < minUtteranceMs`），
     *    而 `durationMs` 是**语音跨度**（`endFrame` 已回退尾静音），不是"含静音的分片总长" ✓
     *    —— 所以「0.7s 分片里只有 0.22s 语音」那种会被正确判成过短 ✓
     *
     * ⚠️ 丢弃的是**这一段音频**，不发给识别 —— 代价是「はい」「ええ」这类
     *    整句消失（这正是默认关的原因 ✗）
     * ⚠️ 也**不发** `utteranceEnd`：这一段既然不要了，就别去收上一句 ✓
     */
    if (vadOpts.dropShort && ev.tooShort) {
      rejectedGate += 0; // 不动那个计数（它算的是"识别回来后被拒"，这里是"根本没发"✗）
      onEvent({
        type: 'status',
        status: 'vad',
        detail:
          `丢弃过短片段 · ${(Number(ev.durationMs) / 1000).toFixed(1)}s 语音 < 最短话段 ` +
          `${(Number(vadOpts.minUtteranceMs) / 1000).toFixed(1)}s · 未送识别（「丢弃过短片段」开关已开）`,
      });
      return;
    }
    flushSpeech(start, end, ev.reason, ev.durationMs, ev.silenceMs,
      Number(ev.speechFrames) * Number(gate.frameMs));
  }

  /**
   * 丢掉很旧的音频。
   * ⚠️ 只能丢"当前这句起点之前"的：正在说的那句必须完整留着，否则切片会缺头。
   * 绝对位置用 baseOffset 记账，所以裁剪不会打乱帧下标和绝对时间的对应关系。
   */
    /**
     * ⚠️ 基准必须是「**已经喂给 gate 的帧**」，不能是 `totalSamples`。
     *
     * `push()` 是同步的（`audio.push` + `totalSamples +=`），而 `handleFrame()` 跑在异步的
     * `vadChain` 里 —— 所以 gate 的位置**永远落后于 totalSamples**。
     *
     * 用 `totalSamples` 当基准时：一旦 gate 不在语音里（两句之间、或切完到下次开口之间），
     * `keepFrom = totalSamples - 2s` 就会剪掉**还没被 handleFrame 处理**的那段音频 ✗
     * 随后 `flushSpeech → takeRange` 里 `s = Math.max(baseOffset, absStart)` 会把这段的
     * **头静默切掉** ✗ —— 送去识别的只有半句，而 `if (!pcm.length)` 只挡"完全为空"，
     * **挡不住"被截短"** ✗✓✓
     *
     * 实测形态（v2.66.73 用户日志）：`分片 · 0.7s 一句 · 3 字 · 先不收`，
     * 而同一位置离线整段是完整一句 —— 那 0.7 秒是**被剪剩的**。
     */
    function trimAudio() {
    /**
     * ⚠️ 基准必须是 **gate 已经**处理**到哪**，不是"已经喂进去多少帧"✗。
     *
     * v2.66.74 那次改的是 `totalSamples` → `framesFedToGate`，**而那是同一个数** ✗：
     * `framesFedToGate += frames.length` 就写在 `push()` 里（同步），和 `totalSamples +=`
     * 同一个 tick —— 所以 `framesFedToGate * winSamples ≈ totalSamples`，
     * 那次"修复"只是换了个写法，**行为一个字没变** ✗✓✓（栽在这里的第三次）
     *
     * 真正落后的是 `gate.frameIndex`：`handleFrame()` 要先 `await speechProb()`（ONNX 推理）
     * 才调 `gate.push()`，而它在串行的 `vadChain` 里 —— 所以队列一积压，
     * gate 的位置就落后于 `totalSamples`，而 `trimAudio` 会把**还没被处理**的音频剪掉 ✗
     * 随后 `takeRange` 的 `s = Math.max(baseOffset, absStart)` 把段首静默切掉 ✗
     * —— 送去识别的就是半句（实测形态：`たを守りだったらある`，开头「私が作っ」没了）。
     *
     * ⚠️ 取 `min(已处理, 已喂)`：`gate.frameIndex` 在极端情况下可能超过
     * `framesFedToGate`（`gate.reset()` 会清零而记账不清），这时按已喂算，别越界 ✓
     */
    const processedFrom = (Number(gate.frameIndex) || 0) * winSamples;
    const fedFrom = framesFedToGate * winSamples;
    const inSpeechFrom = gate.inSpeech
      ? gate.startFrame * winSamples
      : Math.min(processedFrom, fedFrom);
    /**
     * ⭐ **新断句路径：批次还没消费的音频一个字都不能剪** ✗
     *
     * 引擎按「上一句已采纳的 `end`」推进，而那个位置可能比 `inSpeechFrom`
     * **落后好几秒**（要等静音确认 + 一次识别往返）✗
     * 这时若还按 `inSpeechFrom` 裁，`takeRange` 的 `Math.max(baseOffset, …)`
     * 会把批次开头静默切掉 ⇒ 每批音频都缺头 ⇒ **又回到"从词中间起手"那个老毛病** ✗
     * （而那正是这条新路要治的病 ✗✓✓）
     *
     * ⚠️ 只在 `segmentLoop` 存在时多算这一项 ⇒ 旧路 `keepFrom` 逐字不变 ✓
     */
    const loopFrom = segmentLoop
      ? Math.round(segmentLoop.state().nextStartSec * meta.sampleRate)
      : Infinity;
    const baseFrom = Math.min(inSpeechFrom, loopFrom);
    // 保留起点前 2 秒的余量（兜住 padMs 和还在排队的请求）
    const keepFrom = Math.max(0, baseFrom - meta.sampleRate * 2);
    if (keepFrom <= baseOffset) return;
    const dropped = keepFrom - baseOffset;
    let pos = baseOffset;
    const kept = [];
    for (const chunk of audio) {
      const cStart = pos;
      const cEnd = pos + chunk.length;
      pos = cEnd;
      if (cEnd <= keepFrom) continue;
      kept.push(cStart >= keepFrom ? chunk : chunk.subarray(keepFrom - cStart));
    }
    audio = kept;
    baseOffset = keepFrom;
  }

  /**
   * 送一批音频去 Whisper，只取引擎要的三个字段。
   * ⚠️ 复用 `transcribeWhisper` —— **和旧路同一条请求路径** ✓
   *    （另写一条的话，超时/鉴权/提示词/verbose_json 那些会两边走偏 ✗）
   */
  async function transcribeSegments(pcm) {
    const { data } = await transcribeWhisper(pcm);
    const segs = Array.isArray(data?.segments) ? data.segments : [];
    return segs.map((s) => ({
      start: Number(s?.start),
      end: Number(s?.end),
      text: String(s?.text || '').trim(),
    }));
  }

  /**
   * ⭐ 新断句路径的驱动：`push()` 每来一块音频就试一次「该不该开下一批」。
   *
   * 它**不切音频、不做判断** —— 只做三件：
   *   ① 问引擎该送什么（`loop.next(totalSamples)`），不够长就返回 ✓
   *   ② 送一次 Whisper（`transcribeSegments`）✓
   *   ③ 把结果喂回引擎（`loop.apply()`），把**采纳的段**按绝对时间发成 `final` + `utteranceEnd`
   *
   * ⚠️ **绝对时间 = `out.offsetSec + seg.start`** ✗ ——
   *    Whisper 的 `start`/`end` 是**相对这一批音频开头**的秒数（OpenAI 口径），
   *    而排期层要的是绝对时间 ✓
   *    漏加 `offsetSec` 的话所有字幕会挤在开头那一小段 —— 那是这条路上最容易犯的错 ✗
   *
   * ⚠️ 一段 `final` + 一次 `utteranceEnd` = **一条字幕** ✓
   *    （`lib/utterance.js` 的累积器就是这么收句的：`addFinal` 攒、`endUtterance` 收 ✓）
   *    而新路里每一段都已经被静音确认过 ⇒ 每段都是完整句子 ⇒ 逐段收句 ✓✓
   *    ⚠️ `utteranceEnd` **不许带 `soft`** ✗ —— 带 `soft` 会让累积器按长度推迟
   *       （那条是给旧路的静默计时器用的 ✓）
   *
   * ⚠️ 出错时必须 `loop.apply([])` 释放 `inflight` ✗：
   *    `next()` 在有 `inflight` 时返回 `null` ⇒ 不释放就**再也开不出下一批**
   *    （症状：字幕突然全停，日志里什么都没有 —— 这一类"静默停住"踩过多次 ✗）
   */
  async function pumpSegments(forceTail = false) {
    if (stopped || !segmentLoop || segmentsInflight) return;
    let plan = null;
    try {
      plan = segmentLoop.next(totalSamples, { allowShort: forceTail === true });
    } catch (e) {
      onEvent({ type: 'error', message: `新断句路径取音频失败：${e.message || String(e)}` });
      return;
    }
    if (!plan) {
      /**
       * ⭐ **存活心跳** ✗ —— 「新路没开批」和「新路压根没跑」必须分得出来 ✓
       *
       * `next()` 在音频不够长时返回 `null`（首批要 6 秒 ✓ 之后要"尾巴 + 5 秒"✓），
       * 而这一支**原来一声不哼** ✗ ⇒ 从日志上看，"还在等音频"和"引擎没被建/没被驱动"
       * **长得一模一样** ✗✓✓ —— 实测就为这个查了一整轮。
       *
       * ⇒ 每 30 秒报一条（低频，不刷面板 ✓；而它总是"最后一条 status" ⇒ 导出时看得见 ✓）
       */
      const nowSec = totalSamples / meta.sampleRate;
      if (nowSec - segmentsLastStarveSec >= 30) {
        segmentsLastStarveSec = nowSec;
        onEvent({
          type: 'status',
          status: 'vad',
          detail:
            `新断句 · 已收 ${nowSec.toFixed(1)}s 音频 · **还没到开批长度**` +
            ` · 累计 批 ${segmentsBatches} / 采纳 ${segmentsAccepted} 段 / 空 ${segmentsEmpty}`,
        });
      }
      return;
    }

    segmentsInflight = true;
    segmentsBatches += 1;
    try {
      const segs = await transcribeSegments(plan.pcm);
      const out = segmentLoop.apply(segs, { force: forceTail === true });
      if (!out.accepted.length) segmentsEmpty += 1;
      /**
       * ⭐ 「是不是这一批的第一段」✗ —— 决定 `seg.start` 值不值得信 ✓
       *
       * 第一段的 `seg.start` 是"从批首开始听"的产物，`0.04 / 0.3 / 0.9` **都不携带位置信息** ✗
       * ⇒ `shownStartOf` 对它放宽到 1 秒的信任窗口（见那里的说明）；
       *   而第一段之后的段是 Whisper 听完整个批给出的**段间边界** ⇒ 保持严格 0.02 ✓
       */
      let segIdx = 0;
      for (const s of out.accepted) {
        const isFirstSeg = segIdx === 0;
        segIdx += 1;
        const dur = Math.max(0, Number(s.end) - Number(s.start));
        /**
         * ⚠️ **上屏时刻不是段的音频起点，而是「人真正开口」的位置** ✗
         *
         * 批起点 = 上一句已采纳的 `end`，而 Whisper 的 `segments[0].start` **几乎总是 0**
         * ⇒ `offsetSec + s.start` 就落在**批起点**上 —— 而那里**可能正是一段换气/静音的开头** ✗
         * 于是字幕在人还没开口时就上屏了，提前的时长正好等于开头那段静音。
         *
         * 实测（把 0.8 秒静音插到素材最前面）：第一段原本上屏在 `0.00s`，而真实语音在 `0.80s` ✗
         *
         * ⚠️ 这段判断在 `shownStartOf` 里，**仿真也调同一个函数** ✓
         *    （写在 `vad.js` 里的话，仿真量出来的就不是真机那条路上算的值了 ✗）
         */
        /**
         * ⭐ 每段一个**只读探针容器** —— 回答「锚为什么没动」✗
         *
         * 三种"没动"在日志里都印成 `+0.00`，而修法完全不同 ✗：
         *   · `vad-rejected`     问了 VAD，但被三条采信条件之一拒了（原因看 `reason`）
         *   · `skipped-start-real` 首段 `start` 超过 1 秒信任窗口 ⇒ **根本没问** ✗
         *   · `skipped-not-first`  非首段且 `start` 是真实边界 ⇒ 按设计不问 ✓
         * ⇒ 没有它就只能猜，而今天已经猜错两次 ✓（"看不见"这一族已栽六次 ✗）
         */
        const anchorProbe = { shadowRequested: true };
        const anchoredAt = shownStartOf({
          offsetSec: out.offsetSec,
          seg: s,
          pcm: plan.pcm,
          sampleRate: meta.sampleRate,
          /**
           * ⭐ 「是不是这一批的第一段」—— 决定 `seg.start` 可不可信 ✓
           *
           * 第一段：Whisper 是从批首开始听的，它给的 `start`（0.04 / 0.3 / 0.9）
           * **不携带位置信息** ⇒ 信任窗口放宽到 1 秒，让 VAD 开口锚能生效 ✗
           * 其余段：`start` 是听完整个批之后的**段间边界** ⇒ 严格 0.02，不许被覆盖 ✓
           */
          isFirst: isFirstSeg,
          /**
           * ⭐ 注入 VAD 逐帧概率历史 —— 新路的"开口锚" ✓
           *
           * 批首 `seg.start` 恒为 0 ⇒ 上屏时刻落在批起点（可能是音乐床/换气 ✗）
           * ⇒ 用 VAD 找到"人真正开口"的时刻，而**旧路正是靠这个信号切句** ✓
           *
           * ⚠️ 阈值用 `vadOpts.threshold`（`vadThreshold` 默认 0.5）—— **同一个判据** ✓
           *    别新造一个：两个阈值就是两份真相 ✗
           *
           * 🔴 **必须要求连续 7 帧达标（≈280ms），不能只看单帧** ✗
           *
           * 实测（真机闭环，新路，7 次锚点里 2 次 `shift = 0.00`）：
           * ```
           * 批起 30.44 · start 0.00 · 锚 30.44（+0.00） · 7 字 / 5.64s = 1.2 字/秒  ✗
           * 批起 49.52 · start 0.00 · 锚 49.52（+0.00） · 2 字 / 8.00s = 0.3 字/秒  ✗
           * ```
           * ⇒ **音乐床/呼吸在批起点就已经 ≥ 0.5** ⇒ 单帧判据在 `base` 立刻返回
           *   ⇒ `shift = 0` ⇒ 不采信 ⇒ 那两条最差的恰好没被修 ✗✓✓
           *
           * ⭐ 而**旧路（用户认可的时机）要求「开口需 7 帧」** ⇒ 这里用**同一个数** ✓
           *    （`Math.max(1, Math.ceil(minSpeechMs / frameMs))` 在 40ms 窗、280ms 门槛下就是 7）
           */
          /**
           * ⚠️ **第 4 个参数是探针，必须往下传** ✗ ——
           *    原来只透传 `(a, b, thr)`，把 `shownStartOf` 传进来的探针**丢掉**了 ✓
           *    ⇒ 探针拿到的 `reason` 永远是 `undefined` ⇒ 又变成"看不见" ✗
           */
          firstSpeechAt: (a, b, thr, pr) => firstSpeechAt(a, b, thr, FIRST_SPEECH_MIN_RUN_FRAMES, pr),
          speechThreshold: vadOpts.threshold,
          /**
           * ⭐ 探针容器（只读）—— 每段一个，见下方诊断与心跳 ✓
           * 目的：区分「问了 VAD 但被拒」「根本没问（start 超窗）」「问了但 PDF 里没开口」✗
           * —— 这三种在日志里都印成 `+0.00`，而修法完全不同 ✓
           */
          probe: anchorProbe,
        });
        /**
         * 🔴 **排期单调夹紧** ✗ —— 播放器同一刻只显示一条字幕，
         *    所以"上一条显示了多久"**完全等于**两条 `at` 之间的距离 ✓
         *
         * 实测（同一份素材、两轮闭环、都延迟 10）：
         * ```
         * 旧路：`at` 倒退 0/41 ✓ · 停留 <0.5s 1/42（2.4%）✓
         * 新路：`at` 倒退 3/72 ✗（−0.454 / −0.034 / −0.350）
         *       + 4 处"前进但相距 <0.5s" ⇒ 停留 <0.5s 7/73（9.7%）✗
         * ```
         * ⇒ 那 7 处就是用户说的「上一句只显示了一瞬间就被顶掉」✗✓✓
         *
         * ⚠️ **只往后推，绝不提前** ✓ —— 不碰排期绝对值（那是"缓冲没填到目标延迟"，
         *    是另一个根 ✗），也不让"字幕早"变得更早 ✓
         * ⚠️ 基准按**下发顺序**记（播放器被"最新那条"顶掉 ✓），不是"时间最晚的"✗
         */
        /**
         * ⭐ **段内切分**（保守）—— Whisper 把两句话合成一段时，把它切开 ✗
         *
         * 判据见 `speech-run.js` 的 `planPauseSplit`；门槛是本文件模块级的
         * `PAUSE_SPLIT_MIN_*`（那一组**必须导出**，否则断言只能靠源码正则 ✗）。
         *
         * ⚠️ **只在段长 ≥ `PAUSE_SPLIT_MIN_SEG_SEC` 时才考虑** ✓
         *    —— 短句本来就不会被合并，去扫它只是浪费，而且更容易误切 ✗
         * ⚠️ **判不准就不切** ✓ —— `rawPieces` 保持 1 条，
         *    行为与"没有段内切分"时**逐字相同** ✓（回归保护）
         * ⚠️ **文本按时间比例分** ✗ —— 服务端不支持词级时间戳（`timestamp_granularities[]=word`
         *    实测解析失败），所以"词在哪个时刻"这个信息根本不存在 ✓
         *    ⇒ 只能按时间比例分配到字符上（`splitTextByFraction` 有说明）✓
         * ⚠️ **绝不丢字** ✓ —— 两段拼起来**必须**等于原文（断言钉住）✗
         */
        const segFromSec = Number(out.offsetSec) + Number(s.start);
        const segToSec = segFromSec + dur;
        const rawPieces = [{ text: String(s.text || ''), startSec: anchoredAt, endSec: segToSec }];
        if (dur >= PAUSE_SPLIT_MIN_SEG_SEC && probRing && probRingLen > 0 && probRingLastFrame >= 0) {
          const frameSecP = winSamples / Number(meta.sampleRate);
          const frameMsP = Number(gate.frameMs) > 0 ? Number(gate.frameMs) : 40;
          if (frameSecP > 0) {
            const f0 = Math.floor(segFromSec / frameSecP);
            const f1 = Math.min(probRingLastFrame, Math.ceil(segToSec / frameSecP));
            const splitProbe = {};
            let split = null;
            try {
              split = planPauseSplit(ringGetter(probRing, probRingLen, probRingLastFrame), {
                fromIdx: f0,
                toIdx: f1,
                threshold: vadOpts.threshold,
                minGapFrames: Math.max(1, Math.ceil(PAUSE_SPLIT_MIN_GAP_MS / frameMsP)),
                minLeadFrames: Math.max(1, Math.ceil(PAUSE_SPLIT_MIN_LEAD_MS / frameMsP)),
                minTailFrames: Math.max(1, Math.ceil(PAUSE_SPLIT_MIN_TAIL_MS / frameMsP)),
                probe: splitProbe,
              });
            } catch {
              // 一次切分判断不该把整条识别链带下水 ✗
              split = null;
            }
            if (split) {
              const splitSec = split.splitIdx * frameSecP;
              const span = segToSec - anchoredAt;
              const frac = span > 0 ? (splitSec - anchoredAt) / span : 0.5;
              const parts = splitTextByFraction(s.text, frac);
              if (parts && splitSec > anchoredAt && splitSec < segToSec) {
                rawPieces.length = 0;
                rawPieces.push({ text: parts[0], startSec: anchoredAt, endSec: splitSec });
                rawPieces.push({ text: parts[1], startSec: splitSec, endSec: segToSec });
                segmentsSplit += 1;
                segmentsSplitPieces += 2;
                anchorProbe.splitAt = splitSec;
                anchorProbe.splitGapMs = Math.round(split.gapFrames * frameMsP);
              } else if (anchorProbe) {
                anchorProbe.splitRejected = 'text-or-range';
              }
            } else if (anchorProbe) {
              anchorProbe.splitReason = splitProbe.reason || 'none';
            }
          }
        }
        /**
         * **排期单调夹紧** —— 逐条做，**顺序就是下发顺序** ✓
         *
         * ⚠️ 切开的第二条必须**排在前一条之后**（`segmentsLastShownSec` 逐条推进 ✓），
         *    否则两条会撞在同一个 `at` 上 ⇒ 前一条又被秒顶 ✗
         */
        const pieces = [];
        for (const raw of rawPieces) {
          const at = clampShownAt({ raw: raw.startSec, lastAt: segmentsLastShownSec });
          if (at > raw.startSec) segmentsPushedLater += 1;
          segmentsLastShownSec = at;
          pieces.push({ text: raw.text, endSec: raw.endSec, startSec: raw.startSec, startAbs: at });
        }
        const startAbs = pieces[0].startAbs;
        segmentsAccepted += pieces.length;
        /**
         * ⭐ **每个采纳段的开口锚诊断** ✗ —— 只在"锚点动过"或"跨度过长"时打
         *
         * ## 为什么必须有这一行
         *
         * 用户报「还是有提前」，而**日志里没有任何东西**能回答"锚点到底动没动、动了多少"✗
         * —— 段数、字数、`at` 都在，但 `seg.start` 和锚点结果**不在** ✗
         * ⇒ 只能靠离线仿真，而仿真**没有 VAD 概率**（`onnxruntime-node` 未安装）
         *   ⇒ 真机行为**永远验不了** ✗（"看不见"这一族今天已栽过五次 ✓）
         *
         * ## 为什么不是每条都打
         *
         * 采纳段 ≈ 每 3 秒一条，全打会刷爆面板。而**只有两类值得看**：
         * ① 锚点真的挪了（`|shift| >= 0.1s`）—— 它证明 VAD 锚生效了 ✓
         * ② 跨度过长（`字/秒 < 1.8`）—— 那正是"起点被夹在批首"的指纹 ✓
         * 其余段本来就没问题，不印 ✓（不刷屏，也不让"正常"看起来像有事 ✓）
         *
         * ⚠️ 印的是**四个值**：批起 · `seg.start` · 锚点结果 · 最终 `at` ——
         *    任何一个缺失都会让"哪一步错了"无法判断 ✗
         */
        const nChars = String(s.text || '').replace(/\s/g, '').length;
        const cps = dur > 0 ? nChars / dur : 0;
        const anchorShift = anchoredAt - (Number(out.offsetSec) + Number(s.start));
        /**
         * ⭐ **锚点账本** —— 只累加，不打日志 ✗
         *
         * 为什么不能只靠下面那条逐段诊断：它是 `type:'status'`，
         * 而**诊断面板只保留最后一条 status** ✗ ⇒ 大部分段诊断在导出时**已经被覆盖** ✓
         * （实测 `xhsp-ab6-B` 4 份日志里只有 19 条段诊断，而采纳段有 40+ ✓）
         * ⇒ 所以要**按原因累加**，并塞进 30 秒心跳那一行 —— 那一行总是"最后一条" ✓✓✓
         */
        const dec = anchorProbe.decision || 'none';
        if (dec === 'vad') anchorStats.vad += 1;
        else if (dec === 'vad-rejected') {
          anchorStats.rejected += 1;
          const r = anchorProbe.reason || 'unknown';
          anchorStats.byReason[r] = (anchorStats.byReason[r] || 0) + 1;
        } else if (dec === 'skipped-start-real') anchorStats.skipStart += 1;
        else if (dec === 'skipped-not-first') anchorStats.skipNotFirst += 1;
        else anchorStats.other += 1;
        if (anchorProbe.shadow === true) {
          anchorStats.shadow += 1;
          if (anchorProbe.shadowWould) anchorStats.shadowWould += 1;
        }
        /**
         * ⭐ 记下"最值得看"的几条（跨度过长 / 锚没动）—— 塞进心跳行 ✓
         * 只留最近 4 条，避免刷屏 ✓
         */
        if ((dur > 1 && cps < 1.8) || Math.abs(anchorShift) < 0.1) {
          const pk = Number.isFinite(anchorProbe.peak) ? anchorProbe.peak.toFixed(2) : '?';
          const rn = Number.isFinite(anchorProbe.run) ? anchorProbe.run : '?';
          const sh = Number.isFinite(anchorProbe.shadowShift)
            ? `影子${anchorProbe.shadowShift >= 0 ? '+' : ''}${anchorProbe.shadowShift.toFixed(2)}`
            : '';
          const tag =
            `批${Number(out.offsetSec).toFixed(1)}` +
            ` s${Number(s.start).toFixed(2)}` +
            ` ${dec}` +
            ` run${rn}/pk${pk}` +
            (anchorProbe.reason ? ` ${anchorProbe.reason}` : '') +
            (sh ? ` ${sh}` : '');
          anchorStats.recent.push(tag);
          if (anchorStats.recent.length > 4) anchorStats.recent.shift();
        }
        if (Math.abs(anchorShift) >= 0.1 || (dur > 1 && cps < 1.8) || Number.isFinite(anchorProbe.splitAt)) {
          onEvent({
            type: 'status',
            status: 'vad',
            detail:
              `新断句 · 段 · 批起 ${Number(out.offsetSec).toFixed(2)}` +
              ` · start ${Number(s.start).toFixed(2)}${isFirstSeg ? '（首段）' : ''}` +
              ` · 锚 ${anchoredAt.toFixed(2)}（${anchorShift >= 0 ? '+' : ''}${anchorShift.toFixed(2)}）` +
              // ⭐ 决策与原因 —— 区分「问了被拒」和「根本没问」✗
              ` · ${dec}${anchorProbe.reason ? `/${anchorProbe.reason}` : ''}` +
              // ⭐ 窗口统计 —— 判"断续(no-frame-over) / 太短(run-too-short) / 峰值不够(peak-low)" ✗
              ` · run${Number.isFinite(anchorProbe.run) ? anchorProbe.run : '?'}` +
              `/${Number.isFinite(anchorProbe.overThr) ? anchorProbe.overThr : '?'}` +
              `·${Number.isFinite(anchorProbe.frames) ? anchorProbe.frames : '?'}帧` +
              ` · pk${Number.isFinite(anchorProbe.peak) ? anchorProbe.peak.toFixed(2) : '?'}` +
              // ⭐ 影子测量（首段 start 超窗时"如果放宽会挪多少"）✓
              (anchorProbe.shadow
                ? ` · 影子${Number.isFinite(anchorProbe.shadowShift) ? `${anchorProbe.shadowShift >= 0 ? '+' : ''}${anchorProbe.shadowShift.toFixed(2)}` : '?'}${anchorProbe.shadowWould ? '（本可采信）' : ''}`
                : '') +
              ` · ${nChars} 字 / ${dur.toFixed(2)}s = ${cps.toFixed(1)} 字/秒` +
              /**
               * ⭐ 段内切分的结果 —— **切了就必须看得见** ✗
               * 否则"为什么这一条只有半个句子"在日志里无法解释 ✓
               */
              (Number.isFinite(anchorProbe.splitAt)
                ? ` · ⚠ 段内切开 @${Number(anchorProbe.splitAt).toFixed(2)}（停顿 ${anchorProbe.splitGapMs}ms）`
                : anchorProbe.splitRejected
                  ? ` · 段内切分被拒(${anchorProbe.splitRejected})`
                  : '') +
              ` · at ${startAbs.toFixed(2)}`,
          });
        }
        /**
         * ⭐ 逐条下发 —— 正常情况下 `pieces.length === 1`（行为与切分之前逐字相同 ✓）；
         * 只有段内切分命中时才 > 1 ✓
         *
         * ⚠️ `duration` 用**这一条自己的**区间（`endSec - startSec`），不是整段的 `dur` ✗
         *    —— 否则切开之后两条都报"整段时长"，日志里的"这句说了 X.Xs"就是假的 ✓
         */
        for (const piece of pieces) {
          const pieceDur = Math.max(0, piece.endSec - piece.startSec);
          onEvent({ type: 'final', text: piece.text, start: piece.startAbs, duration: pieceDur, cut: 'whisper-segment' });
          // ⚠️ 不带 `soft`：这一段已经静音确认过，是**真的说完了** ⇒ 无条件收句 ✓
          onEvent({ type: 'utteranceEnd' });
        }
      }
      /**
       * ⭐ **新路必须一直看得见** ✗ —— 前 3 批之后改成**低频心跳** ✓
       *
       * 原来只报前 3 批（`segmentsBatches <= 3`），而诊断面板**只保留最后一条 `status`** ✗
       * ⇒ 3 批一过，那条 `新断句 · 批 N` 就被后面的 status 覆盖掉 ⇒
       *   **日志里再也没有任何东西能证明新路跑没跑** ✗✓✓
       *
       * 实测代价：用户选了新模式，而日志里 `新断句` 一条都没有 ——
       * 我据此查了一整轮"新路为什么没跑"，而**它其实在跑**（只是被覆盖了）✗
       *
       * ⇒ 前 3 批逐批报（排查"它到底起没起来"用 ✓），之后**每 30 秒报一条**（低频 ✓，
       *   不会刷爆面板 ✓，而它总是"最后一条 status" ⇒ 随时导出的日志里都看得见 ✓✓✓）
       */
      const nowSec = totalSamples / meta.sampleRate;
      if (segmentsBatches <= 3 || nowSec - segmentsLastReportSec >= 30) {
        segmentsLastReportSec = nowSec;
        onEvent({
          type: 'status',
          status: 'vad',
          detail:
            `新断句 · 批 ${segmentsBatches} · ${(plan.pcm.length / meta.sampleRate).toFixed(1)}s 音频` +
            ` · ${segs.length} 段 → 采纳 ${out.accepted.length} · ${out.reason}` +
            // ⚠️ 印 state().nextStartSec（**绝对**），不印 out.nextStart ✗
            //    —— 后者混了两种单位（段自己的相对值 / NO_SEGMENTS 时的 from），
            //    直接印会显示成"推进到 3.9s"这种**看起来倒退**的读数。
            ` · 推进到 ${segmentLoop.state().nextStartSec.toFixed(1)}s` +
            `（相对本批 ${(out.nextStart >= 0 ? out.nextStart : 0).toFixed(1)}s）` +
            // ⭐ 累计数（心跳行才需要：前 3 批时它们和本批数字一样，没必要重复 ✓）
            ` · 累计 采纳 ${segmentsAccepted} 段 / 空 ${segmentsEmpty} / 失败 ${segmentsFailed}` +
            /**
             * ⭐ 被"排期单调夹紧"往后推过的条数 —— **必须看得见** ✗
             *
             * 否则这类条在日志里和正常条完全一样（今天的"看不见"那一族已栽过五次 ✗）。
             * 而为 0 时**不印**（不刷屏，也不让"正常"看起来像有事 ✓）
             */
            (segmentsPushedLater > 0 ? ` / 夹紧推后 ${segmentsPushedLater} 条` : '') +
            /**
             * ⭐ **段内切分账本** —— 只在真的切过时才印 ✓
             *
             * 必须看得见：切分**会改变条数**，而"条数变多"和"识别变碎"在日志里一样 ✗
             * ⇒ 印出"切开 N 段 → 多出 M 条"，才能分清是谁造成的 ✓
             */
            (segmentsSplit > 0 ? ` / 段内切开 ${segmentsSplit} 段→${segmentsSplitPieces} 条` : '') +
            /**
             * ⭐ **开口锚账本** —— 那一行"总是最后一条"的心跳里，所以它**不会丢** ✓
             *
             * 逐段诊断是 `status`，会被后面的 status 覆盖 ✗ ⇒ 只有这里的分母是真的 ✓
             * 形如：`锚 用 VAD 8 / 拒 2（peak-low 2）/ 跳过-start 3 / 影子本可 2 / 非首段 5`
             */
            (() => {
              const parts = [];
              parts.push(`用 VAD ${anchorStats.vad}`);
              if (anchorStats.rejected > 0) {
                const rs = Object.entries(anchorStats.byReason)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(' · ');
                parts.push(`拒 ${anchorStats.rejected}（${rs}）`);
              }
              if (anchorStats.skipStart > 0) parts.push(`跳过-start超窗 ${anchorStats.skipStart}`);
              if (anchorStats.skipNotFirst > 0) parts.push(`非首段 ${anchorStats.skipNotFirst}`);
              if (anchorStats.other > 0) parts.push(`其他 ${anchorStats.other}`);
              if (anchorStats.shadow > 0) {
                parts.push(`影子 ${anchorStats.shadow} 次本可采信 ${anchorStats.shadowWould}`);
              }
              const tail = parts.length > 1 ? ` / 锚 ${parts.join(' / ')}` : '';
              /**
               * ⚠️ 最近 4 条原始读数**只在有异常时印** ✗
               * 而"跑满屏"比"什么都不印"更糟 ⇒ 限 4 条、每条只留关键三项 ✓
               */
              const recent = anchorStats.recent.length
                ? ` / 锚异常近 ${anchorStats.recent.length}：${anchorStats.recent.join(' | ')}`
                : '';
              return tail + recent;
            })(),
        });
      }
    } catch (e) {
      segmentsFailed += 1;
      onEvent({ type: 'error', message: `新断句路径识别失败：${e.message || String(e)}` });
      // ⚠️ 必须释放 inflight —— 见函数头
      try {
        segmentLoop.apply([]);
      } catch { /* 再失败就没救了，下次 push 会重试 */ }
    } finally {
      segmentsInflight = false;
    }
  }

  function push(int16) {
    if (stopped || !int16 || !int16.length) return;

    /**
     * ⚠️ **两条路在这里分开，别弄混**：
     *   · `audio.push(int16)` → **原始**，切分片时从这里取，最终送给 Whisper ✓
     *   · 下面那个 `vadBlock`  → **归一化后**，切成帧喂 Silero ✓
     * 归一化只救小声的语音（见 `VAD_NORM` 的说明），它对 Whisper 没有必要，
     * 而改它只会引入新变量 ✗
     */
    audio.push(int16);

    // ── VAD 支路的电平处理 ───────────────────────────────────────────
    const rawRms = blockRms(int16);
    vadNoiseFloor = trackNoiseFloor(vadNoiseFloor, rawRms);
    const gain = vadGainFor(rawRms, vadNoiseFloor);
    lastInputRms = rawRms; // ← **原始**，诊断与相对口径都用它 ✓
    lastVadGain = gain;
    lastVadRms = rawRms * gain;
    const vadBlock = gain > 1 ? scaleInt16(int16, gain) : int16;

    const merged = new Int16Array(pending.length + vadBlock.length);
    merged.set(pending, 0);
    merged.set(vadBlock, pending.length);

    let off = 0;
    const frames = [];
    while (off + winSamples <= merged.length) {
      frames.push(merged.slice(off, off + winSamples));
      off += winSamples;
    }
    pending = merged.slice(off);
    // ⚠️ 先记账再排队：识别是异步的，而绝对位置必须在这一刻就是对的
    totalSamples += int16.length;

    /**
     * ⭐ 新断句路径：每次来音频都试一次「该不该开下一批」✓
     * ⚠️ 必须在 `totalSamples +=` **之后** —— 引擎按 `totalSamples` 判"够不够长" ✓
     * ⚠️ 不 await：它是后台跑的，而 `push()` 是同步的（`vadChain` 那边也一样 ✓）
     *    重入由 `segmentsInflight` 和引擎自己的 `inflight` 两道挡住 ✓
     */
    if (segmentLoop) void pumpSegments();

    // 帧序号本身就是绝对位置（每帧固定 512 采样、从不丢帧），
    // 所以 gate 给出的 frame × 512 直接就是音频时间，不需要另外记账。
    for (const frame of frames) {
      vadChain = vadChain.then(async () => {
        if (stopped) return;
        try {
          await handleFrame(frame);
        } catch (e) {
          onEvent({ type: 'error', message: e.message || String(e) });
        }
      });
    }

    framesFedToGate += frames.length;
    if (frames.length) trimAudio();
  }

  /**
   * 开箱自检：拿一段**确定含人声**的音频，把几种可能的调用方式**都跑一遍**，
   * 报出各自的峰值概率，并挑出能用的那一种。
   *
   * 为什么是"都跑一遍"而不是修一处再让用户重测：
   * 现场读数只能说明"概率一直是 0"，却分不清是模型坏了、音频没人说话，
   * 还是调用方式（张量维度、窗长）不对。而这几种的修法完全不同。
   * 一次把候选跑完，一轮就能定死，不用来回重载扩展。
   *
   * ⚠️ 每种变体都用**独立的 state**，绝不污染正在跑的那条流。
   */
  async function runVariant(i16, v) {
    let st = newState();
    let peak = 0;
    let frames = 0;
    const step = v.win;
    for (let off = 0; off + step <= i16.length; off += step) {
      const input = new Float32Array(step);
      for (let i = 0; i < step; i += 1) input[i] = i16[off + i] / 32768;
      const out = await vadSession.run({
        input: new ort.Tensor('float32', input, v.inDims(step)),
        state: st,
        sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(meta.sampleRate)]), v.srDims),
      });
      st = out.stateN || st;
      const p = out.output?.data?.[0];
      if (Number.isFinite(p) && p > peak) peak = p;
      frames += 1;
    }
    return { peak, frames };
  }

  async function selfTest() {
    const res = await fetch(chrome.runtime.getURL('vendor/vad-selftest.wav'));
    if (!res.ok) throw new Error(`自检音频读取失败 HTTP ${res.status}`);
    const i16 = new Int16Array(await res.arrayBuffer(), 44); // 跳过 44 字节 WAV 头

    const variants = [
      // ⚠️ 顺序就是优先级。576 是 Silero **v6**（master 分支）在 16kHz 下的窗长；
      // 512 是 v5 的，对 v6 模型完全无效 —— 概率恒为 0.001，而且**不报错**，
      // 看起来就像"音频里没人说话"。实测见 vad-gate.js 里那张表。
      { name: '576 窗（v6）', srDims: [], win: 576, inDims: (n) => [1, n] },
      { name: '640 窗', srDims: [], win: 640, inDims: (n) => [1, n] },
      { name: '608 窗', srDims: [], win: 608, inDims: (n) => [1, n] },
      { name: '512 窗（v5）', srDims: [], win: 512, inDims: (n) => [1, n] },
      { name: '576 窗 + sr[1]', srDims: [1], win: 576, inDims: (n) => [1, n] },
    ];

    const results = [];
    for (const v of variants) {
      try {
        const r = await runVariant(i16, v);
        results.push({ ...v, ...r });
      } catch (e) {
        results.push({ ...v, peak: NaN, frames: 0, err: e.message || String(e) });
      }
    }
    return results;
  }

  async function start() {
    started = true;
    onEvent({ type: 'status', status: 'connecting', detail: '正在加载本地 VAD 模型…' });
    vadSession = await loadOrt();
    vadState = newState();

    // 先自检，再报就绪 —— 这样"模型到底行不行"永远有一个已知答案作对照
    let results;
    try {
      results = await selfTest();
    } catch (e) {
      onEvent({ type: 'status', status: 'error', detail: `本地 VAD 自检没能跑起来 · ${e.message || e}` });
      return;
    }

    // 按峰值从高到低报一遍，谁能用一目了然
    const line = results
      .map((r) => `${r.name}=${Number.isFinite(r.peak) ? r.peak.toFixed(3) : '报错'}`)
      .join(' · ');
    const best = results.filter((r) => Number.isFinite(r.peak)).sort((a, b) => b.peak - a.peak)[0];

    if (!best || best.peak < gate.threshold) {
      onEvent({
        type: 'status',
        status: 'error',
        detail:
          `本地 VAD 所有调用方式都不响应（真人语音峰值最高只有 ${best ? best.peak.toFixed(3) : 'N/A'}，阈值 ${gate.threshold}）` +
          ` · ${line}`,
      });
      return;
    }

    // ✅ 挑中了：按这个变体配置后续的实时处理
    winSamples = best.win;
    inDims = best.inDims;
    srDims = best.srDims;
    /**
     * ⚠️ 必须复用 vadOpts（也就是用户设置页里那些值）。
     *
     * 这里曾经写死 `minSilenceMs: 300, maxSpeechMs: 20000` ——
     * 于是自检挑完窗长之后，**设置页里调的「静音确认」「一句最长」全部失效**，
     * 用户怎么调都没反应（我还让他去调过，是我不对）。
     * 两处创建 gate 必须用同一份参数，唯一不同的是它的 frameSamples。
     */
    gate = new VadGate({ ...vadOpts, frameSamples: winSamples });
    pending = new Int16Array(0);

    onEvent({
      type: 'status',
      status: 'connected',
      detail: `本地 VAD 自检通过 · 采用「${best.name}」真人语音峰值 ${best.peak.toFixed(3)}（阈值 ${gate.threshold}）· Whisper @ ${baseUrl}`,
    });
    onEvent({ type: 'status', status: 'vad', detail: `其余变体：${line}` });
  }

  function finalize() {
    if (stopped || !gate.inSpeech) return false;
    /**
     * ⭐ 新断句路径：收尾走**新路的兜底**（`force`），不走 `flushSpeech` ✗
     *    —— 两条都跑的话，同一段音频会被识别两遍（CPU 双倍 + 字幕重复）✗
     */
    if (segmentLoop) {
      void pumpSegments(true);
      return true;
    }
    const { start, end } = gate.toSamples(gate.startFrame, gate.frameIndex, {
      totalSamples,
      frameSamples: winSamples,
    });
    const durationMs = (gate.frameIndex - gate.startFrame) * gate.frameMs;
    // finalize 是"要停了"，静音时长按门槛算 —— 必须收句，否则这段永远不上屏
    flushSpeech(start, end, 'finalize', durationMs, utteranceEndMs);
    gate.reset();
    return true;
  }

  async function stop() {
    /**
     * ⚠️ 收尾必须在**置 stopped 之前**做完。
     *
     * 踩过的坑：`stop()` 原来是直接 `stopped = true` 然后等两条链结束 ——
     * 于是**每次停止都会丢掉正在说的那一整句**（最多 vadMaxSpeechSec 秒，那时是 5 秒）。
     * 为它准备的 `finalize()` 因为开头有 `if (stopped ...) return false`，
     * 从任何路径调都拒不动，成了死代码；而且全仓库也确实没有任何地方调它。
     * 两个问题叠在一起，症状就是"点停止，最后一句永远不上屏"。
     */
    try {
      if (gate.inSpeech) {
        /**
         * ⭐ 新断句路径：收尾走**新路的兜底**（`force`）✓
         *    `force` 的语义是"等不及了,硬采纳到 Whisper 最后一个段的 end" ——
         *    而"要停了"正是等不及 ✓（不用 VAD 找切点,见 `whisper-batch.js` 文件头 ✓）
         * ⚠️ 这里必须 `await`：`stop()` 是 async，而 `stopped = true` 之后
         *    `pumpSegments` 会直接 return ⇒ 不 await 就永远收不到最后那句 ✗
         */
        if (segmentLoop) {
          await pumpSegments(true);
        } else {
          const { start, end } = gate.toSamples(gate.startFrame, gate.frameIndex, {
            totalSamples,
            frameSamples: winSamples,
          });
          const durationMs = (gate.frameIndex - gate.startFrame) * gate.frameMs;
          flushSpeech(start, end, 'finalize', durationMs, utteranceEndMs);
        }
        gate.reset();
      }
    } catch {
      /* 收尾失败不该阻止停止本身 */
    }
    stopped = true;
    onEvent({ type: 'status', status: 'closed' });
    await vadChain.catch(() => {});
    await httpChain.catch(() => {});
  }

  return {
    sampleRate: meta.sampleRate,
    streaming: true,
    isOpen: () => started,
    start,
    push,
    finalize,
    stop,
  };
}
