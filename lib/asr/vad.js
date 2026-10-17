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
 *          maxWords?:number, maxChars?:number}} [o]
 * @returns {{text:string, hotwords:number, truncated:boolean}}
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
  return { text, hotwords: used, truncated: overflow > 0 };
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
export function rejectedSummary(hallu, gate, empty, carried) {
  const out = [];
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  if (n(hallu) > 0) out.push(`幻听套话 ${n(hallu)}`);
  if (n(gate) > 0) out.push(`闸门 ${n(gate)}`);
  if (n(empty) > 0) out.push(`空文本 ${n(empty)}`);
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
    windowPeak, maxRun, maxRunStrict, need, observed,
    hasSignal, levelUp, deaf, sparse,
  };
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
 *   · 阈值 20 字/秒：真人上限约 10~12，留了将近一倍余量（那次是 40）
 *   · 拿不到语音时长（NaN / 0）→ **不判**（宁可放过，也别把好句子当幻觉）
 *
 * @param {string} text 识别文本
 * @param {number} speechMs VAD 认定的语音毫秒数
 * @returns {boolean} true = 明显不可能是这段音频说的
 */
export function looksTooFastForAudio(text, speechMs, { maxCharsPerSec = 20, minChars = 3 } = {}) {
  const chars = [...String(text || '').replace(/[\s、。,.!?！？…「」『』・]/g, '')].length;
  if (chars < minChars) return false;
  const ms = Number(speechMs);
  if (!Number.isFinite(ms) || ms <= 0) return false;
  return chars / (ms / 1000) > maxCharsPerSec;
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
    glossary: global?.whisperGlossaryWords,
    includeGlossary: config.glossaryHotwords === true,
    language,
  });
  const prompt = promptInfo.text;
  if (promptInfo.hotwords > 0) {
    onEvent({
      type: 'status',
      status: 'vad',
      detail:
        `识别提示词 · 热词 ${promptInfo.hotwords} 个` +
        `${promptInfo.truncated ? '（超出长度上限，后面的没带）' : ''}`,
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
     * ⚠️ 只有 `=== false` 才算关 —— 与其它开关一样，**默认开**
     * （老配置里没有这个字段时必须仍然是开的，否则"改了默认值老用户拿不到"那个坑又来了）。
     */
    smartCut: config.vadSmartCut !== false,
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
   * 硬边界门槛（毫秒）：静音超过它才算"这句真的说完了"。
   *
   * 这是 Deepgram 那套两级边界的本地等价物：
   *   VAD 静音（vadMinSilenceMs）  → 软边界：先发 final，文本到手但**先不收句**
   *   静音超过这个值              → 硬边界：收句
   * 中间那些被切出来的碎片会和后面拼成一句 —— 靠播放页本来就有的累积器，
   * 当初接 Deepgram 时它的多段 is_final 就是这么拼起来的。
   */
  const utteranceEndMs = Number(config.vadUtteranceEndMs ?? 900);

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
  /** 接力了几次（诊断用；**不是**"丢了几段"） */
  let carriedEmpty = 0;
  /** 「文本和音频时长对不上」被记录了几次（**不拦截**，只做诊断） */
  let flaggedFast = 0;
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
         * ⚠️ **只记录，不拦截**（v2.66.70 起，按用户实测反馈改的）。
         *
         * v2.66.67 把它做成了"拒绝文本 + 把音频接力到下一句"。真机连跑几轮之后，
         * 用户明确反馈：**比不拦更差**（丢的丢、错的错，甚至出现「かはない」「を設定」
         * 这种从半句开始的拼接）。原因是接力会把上一段的音频并进下一段——
         * 而 Whisper 对"从词中间开始的长音频"更容易丢开头，等于用一个错误换另一个。
         *
         * 所以退回 v2.66.65 的**接受**行为，只保留这行诊断：它仍然能指出
         * "这段音频短到不可能说出这些字"，是判断"该调静音确认还是该加热词"的依据。
         * 真要靠它拦截，得等热词到位、并且重新用 A/B 对比验证过再说。
         */
        if (looksTooFastForAudio(text, speechMsForGuard)) {
          flaggedFast += 1;
          if (flaggedFast <= 3) {
            onEvent({
              type: 'status',
              status: 'vad',
              detail:
                // ⚠️ 必须打**判据真正用到的那个时长**（`speechMsForGuard`），不是 `vadSpeechMs` ——
                // 后者约等于分片总长，两行数字对不上会让人以为判据算错了（v2.66.67 就犯过）
                `⚠ 识别结果和音频时长对不上（${[...text].length} 字 / ${(speechMsForGuard / 1000).toFixed(2)}s 说话` +
                `，分片 ${(pcm.length / meta.sampleRate).toFixed(1)}s 含静音 ${Math.round(Number(silenceMs) || 0)}ms）` +
                `—— 文本照常收下，只记录 · 原文「${text.slice(0, 24)}」`,
            });
          }
          // ⚠️ 这里**不 return、不设置 carryFrom** —— 文本继续往下走
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
        onEvent({ type: 'final', text, start: startSec, duration: durationSec, cut: reason });
        // 这一句收下了，接力结束 —— 下一句回到正常起点
        carryFrom = -1;

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
            `${rejectedSummary(rejectedHallu, rejectedGate, rejectedEmpty, carriedEmpty)}`,
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
          `${outKeys ? ` · 输出键 [${outKeys}]${outShape}` : ''}`,
      });
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
    if (!ev) return;
    if (ev.type === 'start') {
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
    flushSpeech(start, end, ev.reason, ev.durationMs, ev.silenceMs,
      Number(ev.speechFrames) * Number(gate.frameMs));
  }

  /**
   * 丢掉很旧的音频。
   * ⚠️ 只能丢"当前这句起点之前"的：正在说的那句必须完整留着，否则切片会缺头。
   * 绝对位置用 baseOffset 记账，所以裁剪不会打乱帧下标和绝对时间的对应关系。
   */
  function trimAudio() {
    const inSpeechFrom = gate.inSpeech ? gate.startFrame * winSamples : totalSamples;
    // 保留起点前 2 秒的余量（兜住 padMs 和还在排队的请求）
    const keepFrom = Math.max(0, inSpeechFrom - meta.sampleRate * 2);
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
        const { start, end } = gate.toSamples(gate.startFrame, gate.frameIndex, {
          totalSamples,
          frameSamples: winSamples,
        });
        const durationMs = (gate.frameIndex - gate.startFrame) * gate.frameMs;
        flushSpeech(start, end, 'finalize', durationMs, utteranceEndMs);
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
