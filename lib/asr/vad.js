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
import { VadGate, VAD_FRAME_SAMPLES } from './vad-gate.js';
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
export const TRANSCRIBE_TIMEOUT_MS = 20000;

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
   */
  const prompt = String(config.prompt || '').trim();

  const vadOpts = {
    threshold: Number(config.vadThreshold ?? 0.5),
    minSpeechMs: 250,
    minSilenceMs: Number(config.vadMinSilenceMs ?? 450),
    maxSpeechMs: Number(config.vadMaxSpeechSec ?? 20) * 1000,
    minUtteranceMs: Number(config.vadMinUtteranceMs ?? 400),
    padMs: Number(config.vadPadMs ?? 200),
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
  /** 被质量闸门拦掉的段数（幻听 / 无人说话 / 置信度低） */
  let rejected = 0;
  /** 因为太短被跳过的段数 */
  let skippedShort = 0;
  /** 因为缓冲里取不到那段音频而跳过的段数 */
  let skippedNoAudio = 0;
  /**
   * 收到了响应、但**认不出文本字段**的次数。
   *
   * ⚠️ 这和 `rejected`（真的没人说话）是两回事，**必须分开计** ——
   * 混在一起的话，用户看到"丢弃一段 · 判定为无人说话"，会以为是音频问题，
   * 而实际是代码取的字段和服务端返回的形状对不上。
   */
  let shapeUnknown = 0;
  /** 滚动窗口：最近约 3.2 秒的 {电平够不够高, 概率}，用来区分"没人说话"和"VAD 聋了" */
  const win = [];
  let maxProb = 0;
  let lastProb = 0;
  let lastInputRms = 0;
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
          '（播放页会引；设置页的「测试识别连接」不会，所以那个按钮测不了需要本地 VAD 的识别服务，请改用播放页实测）',
      );
    }
    try {
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
      // 单线程足够，而且省掉 SharedArrayBuffer 的跨源隔离要求
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
    let sum = 0;
    for (let i = 0; i < winSamples; i += 1) {
      const v = (frame[i] || 0) / 32768;
      input[i] = v;
      sum += v * v;
    }
    lastInputRms = Math.sqrt(sum / winSamples);

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
      if (Number.isFinite(t) && t > 0) return `解码回退到 temperature=${t}`;
      const ns = Number(s?.no_speech_prob);
      if (Number.isFinite(ns) && ns > 0.6) return `判定为无人说话（no_speech_prob=${ns.toFixed(2)}）`;
      const lp = Number(s?.avg_logprob);
      if (Number.isFinite(lp) && lp < -1.0) return `置信度低（avg_logprob=${lp.toFixed(2)}）`;
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

  /** 送一句去识别，然后**按两级边界**决定要不要收句 */
  function flushSpeech(absStart, absEnd, reason, durationMs, silenceMs) {
    const s = Math.max(baseOffset, absStart);
    const e = Math.min(totalSamples, absEnd);
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

    const pcm = takeRange(s, e);
    const startSec = s / meta.sampleRate;
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
        const why = rejectReason(text, data);
        if (why) {
          rejected += 1;
          onEvent({
            type: 'status',
            status: 'vad',
            detail: `丢弃一段识别结果 · ${why} · 原文「${text.slice(0, 24)}」`,
          });
          return;
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
        onEvent({ type: 'final', text, start: startSec, duration: durationSec });

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
            ` · 静音 ${Math.round(Number(silenceMs) || 0)}ms · ${hard ? `收句${note}` : '先不收，和后面拼'}` +
            `${rejected ? ` · 已拦掉 ${rejected} 段幻听` : ''}`,
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
     * 区分"没人说话"和"VAD 聋了"。
     *
     * 这两种在单次读数上长得一样（概率都是 0），但修法完全相反：
     *   没人说话 → 不是 bug，等就行
     *   VAD 聋了  → 是真 bug，得查状态/输入
     * 判据是**输入电平是否仍然是人声量级**：滚动统计最近一段窗口里
     * "电平超过 0.03 的帧占比"以及这些帧里的最高概率。
     * 电平一直够高而概率一直上不去 → 聋了；电平本来就低 → 没人说话。
     */
    if (Number.isFinite(lastInputRms)) {
      win.push({ loud: lastInputRms > 0.03, p: ok ? p : 0 });
      if (win.length > 80) win.shift(); // 80 帧 ≈ 3.2 秒
    }

    // 心跳：没有它就只能看到"一直没有结果"，看不出是帧没进来、概率上不去、
    // 还是状态机不收句 —— 这三种原因的修法完全不同。
    const now = Date.now();
    if (now - lastBeatAt > 3000) {
      lastBeatAt = now;
      const loud = win.filter((x) => x.loud);
      const loudRatio = win.length ? Math.round((loud.length / win.length) * 100) : 0;
      const loudPeak = loud.length ? Math.max(...loud.map((x) => x.p)) : 0;
      const deaf = win.length >= 40 && loud.length >= win.length * 0.3 && loudPeak < 0.2;
      onEvent({
        // ⚠️ 用单独的 status：它只是读数，不是"识别请求回来了"。
        // 用 'chunk' 会污染播放页那个「已发出/回来」计数器，还会给出错误的建议。
        type: 'status',
        status: 'vad',
        detail:
          `帧 ${framesFed} · 概率 ${ok ? lastProb.toFixed(4) : 'NaN'}（峰值 ${maxProb.toFixed(4)}，阈值 ${gate.threshold}）` +
          ` · 输入电平 ${lastInputRms.toFixed(4)} · ${gate.inSpeech ? '说话中' : '静默'}` +
          ` · 近 ${(win.length / 25).toFixed(0)}s 有声 ${loudRatio}%（其中峰值 ${loudPeak.toFixed(2)}）` +
          `${outKeys ? ` · 输出键 [${outKeys}]${outShape}` : ''}` +
          (deaf ? ' ⚠ 电平够高却一直不认，疑似 VAD 失效' : ''),
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
    flushSpeech(start, end, ev.reason, ev.durationMs, ev.silenceMs);
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

    audio.push(int16);
    const merged = new Int16Array(pending.length + int16.length);
    merged.set(pending, 0);
    merged.set(int16, pending.length);

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
