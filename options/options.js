import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  ASR_PROVIDERS,
  TRANSLATE_PROVIDERS,
  TARGET_LANGS,
  SOURCE_LANGS,
  LATENCY_PRESETS,
  applyPreset,
  detectPreset,
  detectPresetForUi,
  VAD_RATE_PRESETS,
  applyVadRate,
  detectVadRate,
} from '../lib/settings.js';
import { createAsrSession } from '../lib/asr/index.js';
import { testTranslate } from '../lib/translate/index.js';
import { buildWav, bytesToBase64 } from '../lib/util.js';
// 测试阿里云百炼时直接调**生产路径用的那个请求体构造函数** ——
// 复制一份到测试里只能证明"测试里那份是对的"（这个项目被这种缝隙坑过）
import {
  buildDashscopeBody,
  buildDashscopeNativeBody,
  resolveDashscopeEndpoint,
  pickDashscopeText,
  dashscopeShapeNote,
} from '../lib/asr/vad.js';

const $ = (id) => document.getElementById(id);

// [元素 id, 控件类型, 设置路径]
const FIELDS = [
  // —— 速度 / 断句 ——
  ['asr-maxSegmentMs', 'number', 'asr.maxSegmentMs'],
  // —— ASR ——
  ['asrProvider', 'text', 'asr.provider'],
  ['asrLanguage', 'text', 'asr.language'],
  // —— 延迟画面画质 ——
  ['delayQuality', 'text', 'capture.delayQuality'],
  ['cp-maxFrameRate', 'number', 'capture.maxFrameRate'],
  ['dg-apiKey', 'text', 'asr.deepgram.apiKey'],
  ['dg-model', 'text', 'asr.deepgram.model'],
  ['dg-endpoint', 'text', 'asr.deepgram.endpoint'],
  ['dg-utteranceEndMs', 'number', 'asr.deepgram.utteranceEndMs'],
  ['dg-endpointing', 'number', 'asr.deepgram.endpointing'],
  ['dg-keyterms', 'text', 'asr.deepgram.keyterms'],
  ['dg-interim', 'checkbox', 'asr.deepgram.interim'],
  ['dg-smartFormat', 'checkbox', 'asr.deepgram.smartFormat'],
  // 阿里云百炼（国内直连）
  ['dsc-apiKey', 'text', 'asr.dashscope.apiKey'],
  ['dsc-endpointMode', 'text', 'asr.dashscope.endpointMode'],
  ['dsc-hotwords', 'text', 'asr.dashscope.hotwords'],
  ['dsc-glossaryHotwords', 'checkbox', 'asr.dashscope.glossaryHotwords'],
  ['dsc-endpoint', 'text', 'asr.dashscope.endpoint'],
  ['dsc-model', 'text', 'asr.dashscope.model'],
  ['dsc-prompt', 'text', 'asr.dashscope.prompt'],

  ['rt-apiKey', 'text', 'asr.openaiRealtime.apiKey'],
  ['rt-baseUrl', 'text', 'asr.openaiRealtime.baseUrl'],
  ['rt-model', 'text', 'asr.openaiRealtime.model'],
  ['rt-silenceDurationMs', 'number', 'asr.openaiRealtime.silenceDurationMs'],
  ['rt-prompt', 'text', 'asr.openaiRealtime.prompt'],
  ['rt-useAsrKeyFromChunked', 'checkbox', 'asr.openaiRealtime.useAsrKeyFromChunked'],

  ['wc-baseUrl', 'text', 'asr.whisperChunked.baseUrl'],
  ['wc-apiKey', 'text', 'asr.whisperChunked.apiKey'],
  ['wc-model', 'text', 'asr.whisperChunked.model'],
  ['wc-chunkSeconds', 'number', 'asr.whisperChunked.chunkSeconds'],
  ['wc-silenceThreshold', 'number', 'asr.whisperChunked.silenceThreshold'],
  ['wc-pauseSec', 'number', 'asr.whisperChunked.pauseSec'],
  // —— 本地 VAD 断句 ——
  ['vd-threshold', 'number', 'asr.vad.vadThreshold'],
  ['vd-minSilenceMs', 'number', 'asr.vad.vadMinSilenceMs'],
  ['vd-utteranceEndMs', 'number', 'asr.vad.vadUtteranceEndMs'],
  ['vd-minUtteranceMs', 'number', 'asr.vad.vadMinUtteranceMs'],
  ['vd-maxSpeechSec', 'number', 'asr.vad.vadMaxSpeechSec'],
  ['vd-padMs', 'number', 'asr.vad.vadPadMs'],
  // 「合理断句」：到单句上限时回看换气处，把切点从"时间到的那一刻"挪过去（见 vad.js 的 findLullCut）
  ['vd-smartCut', 'checkbox', 'asr.vad.vadSmartCut'],
  ['wc-prompt', 'text', 'asr.whisperChunked.prompt'],
  ['wc-skipSilence', 'checkbox', 'asr.whisperChunked.skipSilence'],
  // AGC 档位：差麦克风场景下 gentle 常常比默认更稳（提升减半、收敛慢 4 倍、噪声门抬高）
  ['cp-agcProfile', 'text', 'capture.agcProfile'],

  // —— 识别校正 ——
  ['rf-enabled', 'checkbox', 'asr.refine.enabled'],
  ['rf-provider', 'text', 'asr.refine.provider'],
  ['rf-model', 'text', 'asr.refine.model'],
  ['rf-language', 'text', 'asr.refine.language'],
  ['rf-prompt', 'text', 'asr.refine.prompt'],

  // —— 翻译 ——
  ['tr-provider', 'text', 'translate.provider'],
  ['tr-target', 'text', 'translate.target'],
  ['tr-source', 'text', 'translate.source'],
  ['tr-translateInterim', 'checkbox', 'translate.translateInterim'],
  ['tr-reviewPass', 'checkbox', 'translate.reviewPass'],
  ['tr-interimIntervalMs', 'number', 'translate.interimIntervalMs'],
  ['tr-interimMinChars', 'number', 'translate.interimMinChars'],
  ['tr-contextSegments', 'number', 'translate.contextSegments'],
  ['g-endpoint', 'text', 'translate.google.endpoint'],
  ['o-apiKey', 'text', 'translate.openai.apiKey'],
  ['o-baseUrl', 'text', 'translate.openai.baseUrl'],
  ['o-model', 'text', 'translate.openai.model'],
  ['o-systemPrompt', 'text', 'translate.openai.systemPrompt'],
  // DeepSeek：OpenAI 兼容，字段结构完全一样
  ['ds-apiKey', 'text', 'translate.deepseek.apiKey'],
  ['ds-baseUrl', 'text', 'translate.deepseek.baseUrl'],
  ['ds-model', 'text', 'translate.deepseek.model'],
  ['ds-systemPrompt', 'text', 'translate.deepseek.systemPrompt'],
  // Ollama：本地，没有 Key 这一项
  ['ol-baseUrl', 'text', 'translate.ollama.baseUrl'],
  ['ol-model', 'text', 'translate.ollama.model'],
  ['ol-systemPrompt', 'text', 'translate.ollama.systemPrompt'],
  // 百度：签名用 APPID + 密钥
  ['bd-appid', 'text', 'translate.baidu.appid'],
  ['bd-key', 'text', 'translate.baidu.key'],
  ['tc-secretId', 'text', 'translate.tencent.secretId'],
  ['tc-secretKey', 'text', 'translate.tencent.secretKey'],
  ['tc-region', 'text', 'translate.tencent.region'],
  ['al-keyId', 'text', 'translate.ali.accessKeyId'],
  ['al-keySecret', 'text', 'translate.ali.accessKeySecret'],
  ['tr-glossary', 'text', 'translate.glossary'],
  ['tr-gamingGlossary', 'checkbox', 'translate.gamingGlossary'],
  ['tr-liveGlossary', 'checkbox', 'translate.liveGlossary'],
  ['d-apiKey', 'text', 'translate.deepl.apiKey'],
  ['d-pro', 'checkbox', 'translate.deepl.pro'],

  // —— 外观 ——
  ['ui-position', 'text', 'ui.position'],
  ['ui-bilingualOrder', 'text', 'ui.bilingualOrder'],
  ['ui-fontSize', 'number', 'ui.fontSize'],
  ['ui-opacity', 'number', 'ui.opacity'],
  ['ui-historyLines', 'number', 'ui.historyLines'],
  ['ui-hideAfterMs', 'number', 'ui.hideAfterMs'],
  ['ui-showOriginal', 'checkbox', 'ui.showOriginal'],
  ['ui-showDiag', 'checkbox', 'ui.showDiag'],
  ['audio-muteOriginal', 'checkbox', 'audio.muteOriginal'],
  ['audio-autoGain', 'checkbox', 'audio.autoGain'],

  // —— 其它 ——
  ['history-keep', 'number', 'history.keep'],
];

let current = null;

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

// ═══════════════ 初始化 ═══════════════

async function init() {
  current = await getSettings();
  $('verInfo').textContent = `livedtranslate v${chrome.runtime.getManifest().version}`;

  fillSelect($('asrProvider'), ASR_PROVIDERS.map((p) => ({ value: p.id, label: p.label })));
  /**
   * 延迟画面画质档位。
   * 档位是**相对"标准档"码率的倍率**，实际码率按画面尺寸算，所以换分辨率不用重调。
   * 会糊的根因是码率不够（不是分辨率不够），所以这里只调码率。
   */
  fillSelect($('delayQuality'), [
    { value: 'low', label: '省资源（×0.5，4K 约 20 Mbps）' },
    { value: 'standard', label: '标准（×1.0，4K 约 40 Mbps，快速运动可能发糊）' },
    { value: 'high', label: '高画质（×1.6，4K 约 64 Mbps，推荐）' },
    { value: 'ultra', label: '极致（×2.4，4K 约 96 Mbps，基本无二次压缩）' },
  ]);
  $('delayQuality').addEventListener('change', updateQualityHint);
  /**
   * 语速档位。断句参数跟语速强相关，而"这人说话快不快"用户一眼就知道，
   * 比让他去猜「静音确认填 300 还是 450」直观得多。
   * 选档位只是把一组合理的起点写进那几个旋钮，之后仍可单独微调。
   */
  fillSelect($('vd-rate'), [
    ...VAD_RATE_PRESETS.map((p) => ({ value: p.id, label: p.label })),
    { value: 'custom', label: '自定义（下面几项手动调过）' },
  ]);
  $('vd-rate').addEventListener('change', () => {
    const id = $('vd-rate').value;
    if (id === 'custom') return;
    current = collect();
    applyVadRate(current, id);
    saveSettings(current);
    loadIntoForm(current);
    updateVadRateHint();
    toast(`已套用「${VAD_RATE_PRESETS.find((p) => p.id === id)?.label}」`);
  });
  updateVadRateHint();
  /**
   * AGC 档位。默认 standard = 这一项加进来**之前的行为**，不动就是零风险。
   * 差麦克风/快语速值得试 gentle：提升上限减半、收敛慢 4 倍、噪声门抬高 ——
   * 音量拉平得没那么狠，但不会来回"泵"，也不会把底噪一起放大。
   */
  fillSelect($('cp-agcProfile'), [
    { value: 'off', label: '关闭（固定增益，完全不自动调整）' },
    { value: 'gentle', label: '温和（差麦克风推荐）' },
    { value: 'standard', label: '标准（默认，一直是这个）' },
    { value: 'strong', label: '强力（音源本身很轻时才用）' },
  ]);
  $('cp-agcProfile').addEventListener('change', updateAgcHint);
  updateAgcHint();
  fillSelect($('tr-provider'), TRANSLATE_PROVIDERS.map((p) => ({ value: p.id, label: p.label })));
  fillSelect($('tr-target'), TARGET_LANGS.map((l) => ({ value: l.id, label: l.label })));
  fillSelect($('tr-source'), SOURCE_LANGS.map((l) => ({ value: l.id, label: l.label })));
  fillSelect($('asrLanguage'), SOURCE_LANGS.map((l) => ({ value: l.id, label: l.id === 'auto' ? '自动检测（受识别服务能力限制）' : l.label })));

  $('presetSelect').innerHTML = '';
  for (const p of LATENCY_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    $('presetSelect').appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = '自定义（各项已手动调整）';
  $('presetSelect').appendChild(customOpt);

  loadIntoForm(current);
  syncPanels();
  syncPreset();
  updateGlossaryHint();

  $('asrProvider').addEventListener('change', () => {
    syncPanels();
    updateAsrHint();
  });
  $('asrLanguage').addEventListener('change', updateAsrHint);
  $('dg-model').addEventListener('change', updateAsrHint);
  $('dg-smartFormat').addEventListener('change', updateAsrHint);
  $('tr-provider').addEventListener('change', () => {
    syncPanels();
    updateGlossaryHint();
  });
  $('tr-source').addEventListener('change', updateGlossaryHint);
  $('tr-target').addEventListener('change', updateGlossaryHint);
  $('tr-gamingGlossary').addEventListener('change', updateGlossaryHint);
  $('tr-liveGlossary').addEventListener('change', updateGlossaryHint);

  $('presetSelect').addEventListener('change', async () => {
    const id = $('presetSelect').value;
    if (id === 'custom') return;
    const preset = LATENCY_PRESETS.find((p) => p.id === id);
    /**
     * ⚠️ 带 `warn` 的预设装的是**整套方案**（会改识别服务/语言/翻译服务/呈现方式），
     * 不是只动延迟旋钮。而这里是"改完立刻写盘"，连保存都不用点 ——
     * 没有这道确认，一个看英文直播、用 Google 免 Key 的用户顺手点一下「推荐」，
     * 就会变成"日语 + DeepL 无 Key"，翻译全挂而不知道为什么。
     */
    if (preset?.warn && !confirm(preset.warn)) {
      syncPreset(); // 把下拉拨回当前实际匹配的项
      return;
    }
    current = collect();
    applyPreset(current, id);
    await saveSettings(current);
    loadIntoForm(current);
    applyLive();
    updateVadRateHint(); // 延迟预设不碰断句参数，但重新载入后下拉要重新对一遍
    toast(`已套用「${preset?.label || id}」`);
  });

  for (const [id] of FIELDS) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('change', () => {
      if (id === 'ui-fontSize') $('ui-fontSizeVal').textContent = el.value;
      if (id === 'ui-opacity') $('ui-opacityVal').textContent = Number(el.value).toFixed(2);
      // 手改了断句旋钮就把语速档位显示成「自定义」—— 别用档位名骗用户
      if (/^vd-/.test(id)) updateVadRateHint();
    });
    el.addEventListener('input', () => {
      if (id === 'ui-fontSize') $('ui-fontSizeVal').textContent = el.value;
      if (id === 'ui-opacity') $('ui-opacityVal').textContent = Number(el.value).toFixed(2);
    });
  }

  $('btnSave').addEventListener('click', () => save(true));
  $('btnReset').addEventListener('click', onReset);
  $('btnTestAsr').addEventListener('click', onTestAsr);
  $('btnTestTranslate').addEventListener('click', onTestTranslate);

  updateAsrHint();
  updateQualityHint();
}

function fillSelect(sel, options) {
  sel.innerHTML = '';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
}

function loadIntoForm(settings) {
  for (const [id, kind, path] of FIELDS) {
    const el = $(id);
    if (!el) continue;
    const v = getPath(settings, path);
    if (kind === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
  $('ui-fontSizeVal').textContent = settings.ui.fontSize;
  $('ui-opacityVal').textContent = Number(settings.ui.opacity).toFixed(2);
}

function collect() {
  const out = JSON.parse(JSON.stringify(current));
  for (const [id, kind, path] of FIELDS) {
    const el = $(id);
    if (!el) continue;
    if (kind === 'checkbox') setPath(out, path, el.checked);
    else if (kind === 'number') setPath(out, path, Number(el.value));
    else setPath(out, path, el.value);
  }
  return out;
}

/**
 * 术语表在三家服务商上的落地方式差别很大，不写清楚用户会以为"填了就该生效"。
 */
function updateGlossaryHint() {
  const provider = $('tr-provider').value;
  const source = $('tr-source').value;
  const target = $('tr-target').value;
  const gaming = $('tr-gamingGlossary').checked;
  const hasOwn = !!$('tr-glossary').value.trim();
  const notes = [];

  if (provider === 'deepl') {
    notes.push('DeepL：走官方术语表 API，三家里面最可靠——DeepL 会保证遵守。');
    if (source === 'auto') {
      notes.push('⚠️ 但 DeepL **不允许在「源语言 = 自动检测」时使用术语表**，请在右上角把源语言指定成具体语言。');
    }
    notes.push('（术语表会在首次使用时自动创建并缓存，改了内容会自动重建。）');
  } else if (provider === 'openai') {
    notes.push('OpenAI：术语表写进系统提示词，模型会尽量遵守，但不是硬保证。');
  } else if (provider === 'google-free') {
    notes.push(
      '⚠️ Google 免 Key 通道**没有术语能力**，只能做占位符替换：把术语换成标记送过去，回来再换回目标词。' +
        '多数情况能用，但翻译器偶尔会吞掉标记——真丢了会在页面诊断面板里提示，不会静默出错。',
    );
    notes.push('想要可靠的术语表，请换 DeepL。');
  } else {
    notes.push('当前没有启用翻译，术语表不会生效。');
  }

  if (gaming) {
    if (!/^zh/i.test(target)) {
      notes.push('⚠️ 内置游戏词表的译文是中文，当前目标语言不是中文，因此**不会**被并入。');
    } else {
      notes.push('内置游戏词表已并入（整词匹配、忽略大小写）。');
    }
  }
  if ($('tr-liveGlossary').checked) {
    if (!/^zh/i.test(target)) {
      notes.push('⚠️ 内置直播词表的译文也是中文，当前目标语言不是中文，因此**不会**被并入。');
    } else {
      notes.push(
        '内置直播词表已并入（英文整词匹配，日文子串匹配）。' +
          '日文条目是按子串匹配的，所以像「草 / 笑 / 枠 / 乙 / 凸 / わかる」这些容易是别的词一部分的黑话故意没收——收了会把「わからない」变成「懂ない」。',
      );
    }
  }
  if (!hasOwn && !gaming && !$('tr-liveGlossary').checked) {
    notes.push('术语表和两个内置词表都没启用，现在没有任何替换规则。');
  }

  $('glossaryHint').textContent = notes.join(' ');
}

/**
 * `data-panel` 是**空格分隔的 id 列表**，不是单个 id。
 *
 * ⚠️ 为什么需要多个：断句由浏览器内的 Silero VAD 做，而**不止一个识别服务**用它 ——
 * 「本地 VAD 断句」（backend 默认 whisper）和「阿里云百炼」（`dashscope.js` 复用
 * `vad.js` 的 `createSession`，只把 backend 换成 dashscope）**是同一套断句引擎**。
 *
 * 踩过的坑：原来这里是 `panel.dataset.panel === asrId`（精确匹配单个 id），
 * 于是选中「阿里云百炼」时，装着「语速档位 / 静音确认 / 收句静音 / 最短话段 /
 * 单句上限 / 前后留白 / 判定阈值 / 自动增益档位」的那个面板**整块消失** ——
 * 而那些旋钮对阿里**照样生效**（切句还在浏览器里做）。
 * 用户的原话是「我就是想问这个 我看不到了」。
 */
function panelShown(panel, id) {
  return (panel.dataset.panel || '')
    .split(/\s+/)
    .filter(Boolean)
    .includes(id);
}

/**
 * 面板里有些文案**只对其中一个 backend 成立** ——
 * 比如「把完整的一句交给**本地 Whisper**」在选阿里时是错的
 *（阿里用的是 DashScope 的 HTTP 接口，压根没有"本地 Whisper 服务"那回事）。
 *
 * 所以这些块带 `data-backend="whisper"` / `data-backend="dashscope"`，按当前 backend 显隐。
 * **公共说明不加属性，两边都显示。**
 *
 * ⚠️ backend 的判定与 `lib/asr/vad.js` 的 `config.backend || 'whisper'` 对齐；
 * 复用 VAD 引擎的服务由各自 adapter 设 backend（见 `lib/asr/dashscope.js`）。
 * 这一处和 smoke-test 里那条"VAD 支撑的服务必须能看到 VAD 旋钮"的断言是同一条规则的两种写法。
 */
function currentVadBackend() {
  return $('asrProvider').value === 'dashscope' ? 'dashscope' : 'whisper';
}

function syncPanels() {
  const asrId = $('asrProvider').value;
  for (const panel of document.querySelectorAll('#cardAsr .panel')) {
    panel.classList.toggle('active', panelShown(panel, asrId));
  }
  const backend = currentVadBackend();
  for (const el of document.querySelectorAll('#cardAsr [data-backend]')) {
    el.hidden = el.dataset.backend !== backend;
  }
  const trId = $('tr-provider').value;
  for (const panel of document.querySelectorAll('#cardTranslate .panel')) {
    panel.classList.toggle('active', panelShown(panel, trId));
  }
}

/**
 * 画质档位的说明。
 *
 * 自动码率是按**画面尺寸**算的，所以这里把三档在常见分辨率下的参考值一并列出来 ——
 * 否则用户选完不知道到底会占多少编码压力。倍率定义见 lib/delayed-player.js。
 */
/**
 * 语速档位的下拉要反映"当前实际匹配哪一档"。
 * 用户改动了任何一个旋钮就显示「自定义」—— 那说明他在微调，别用档位名去骗他。
 */
function updateVadRateHint() {
  const sel = $('vd-rate');
  const el = $('vdRateHint');
  if (!sel) return;
  const id = detectVadRate(current || {});
  sel.value = id;
  if (el) el.textContent = VAD_RATE_PRESETS.find((p) => p.id === id)?.hint || '下面几项被手动调过 —— 想回到某一档就重新选一次。';
}

/**
 * AGC 档位的说明。把每一档实际改了什么列出来 —— 否则用户不知道该选哪个。
 * 参数定义在 lib/audio-chain.js 的 AGC_PROFILES。
 */
function updateAgcHint() {
  const el = $('agcHint');
  if (!el) return;
  const table = {
    off: '完全不做自动增益。音量本来就稳定的音源适用。',
    gentle: '提升上限 +12dB → +6dB，增益收敛 0.35s → 1.5s，噪声门抬高 2.4 倍。音量拉平得没那么狠，但不会来回泵、也不会把底噪放大。',
    standard: '只提升不衰减，最多 +12dB，增益 0.35 秒收敛。这是默认值，也是以前一直用的那套。',
    strong: '提升上限 +12dB → +15.6dB，收敛更快。音源本身很轻又稳定时才用。',
  }[$('cp-agcProfile')?.value] || '';
  el.textContent = table;
}

function updateQualityHint() {
  const el = $('qualityHint');
  if (!el) return;
  const table = {
    low: ['省资源', 0.5, '编码压力最小，快速运动会有可见的软化。'],
    standard: ['标准', 1.0, '约 0.16 bpp —— 静止够用，快速运动可能发糊。'],
    high: ['高画质', 1.6, '约 0.26 bpp —— 运动画面干净（默认）。'],
    ultra: ['极致', 2.4, '约 0.39 bpp —— 基本看不出二次压缩，编码压力最大。'],
  }[ $('delayQuality')?.value ] || ['高画质', 1.6, ''];
  const mbps = (w, h) => ((Math.min(150_000_000, Math.max(4_000_000, ((w * h) / (1920 * 1080)) * 10_000_000)) * table[1]) / 1e6).toFixed(1);
  el.textContent =
    `当前：${table[0]}。参考码率 1080p ${mbps(1920, 1080)} Mbps · 2K ${mbps(2560, 1440)} Mbps · 4K ${mbps(3840, 2160)} Mbps。${table[2]}`;
}

  function updateAsrHint() {
  const provider = $('asrProvider').value;
  const p = ASR_PROVIDERS.find((x) => x.id === provider);
  $('asrHint').textContent = p?.hint || '';

  // 「自动检测」在各家的真实含义差别很大，而且 nova-3 的 multi 语种里没有中文，
  // 不提示的话用户会遇到"中文语音被当英文识别"这种很难自查的问题。
  const lang = $('asrLanguage').value;
  const el = $('asrLangHint');
  const notes = [];
  if (lang === 'auto') {
    if (provider === 'deepgram') {
      const model = $('dg-model').value || 'nova-3';
      notes.push(
        /^nova-3/.test(model)
          ? '⚠️ nova-3 的「自动检测」实际走 language=multi，只覆盖英/西/法/德/印地/俄/葡/日/意/荷 10 种语言——**不含中文和韩文**。源语言是中文请显式选「中文」，否则会被按这 10 种语言硬猜。'
          : '⚠️ Deepgram 的自动检测只在 nova-2 系列上可用（detect_language）。建议直接指定语言，更准也更快。',
      );
    } else if (provider === 'openai-realtime') {
      notes.push('OpenAI 转写不指定语言时由模型自行判断，通常可用，但明确指定会更稳。');
    } else {
      notes.push('Whisper 不指定语言时会先做语言检测，明确指定能省一步、更稳。');
    }
  } else {
    notes.push('已指定具体语言：识别更快也更准。');
  }
  if (provider === 'deepgram' && $('dg-smartFormat').checked) {
    notes.push('⚠️ 当前开着 smart_format：官方说明流式下可能把定稿推迟最多 3 秒。做实时字幕建议关掉。');
  }
  el.textContent = notes.join(' ');
}

// ═══════════════ 保存 ═══════════════

async function save(notify) {
  current = collect();
  await saveSettings(current);
  await applyLive();
  syncPreset();
  updateGlossaryHint();
  if (notify) toast('设置已保存');
}

/** 让运行中的采集立即用上新配置，不必停掉重开 */
async function applyLive() {
  await chrome.runtime.sendMessage({ type: 'LIVEDUB_APPLY_SETTINGS', settings: current }).catch(() => {});
}

function syncPreset() {
  const id = detectPresetForUi(current || {});
  $('presetSelect').value = id;
  const preset = LATENCY_PRESETS.find((p) => p.id === id);
  $('presetHint').textContent = preset
    ? preset.hint
    : '当前是自定义组合，下面各项按你手动设置的值生效。想回到预设，在上面的下拉里选一个即可。';
}

async function onReset() {
  current = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  await saveSettings(current);
  loadIntoForm(current);
  syncPanels();
  updateAsrHint();
  syncPreset();
  toast('已恢复默认设置');
}

// ═══════════════ 测试 ═══════════════

function setResult(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = `result ${cls || ''}`;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时（${ms / 1000}s）`)), ms)),
  ]);
}

async function onTestAsr() {
  const btn = $('btnTestAsr');
  btn.disabled = true;
  setResult('asrTestResult', '测试中…', '');
  const settings = collect();
  try {
    // 本地 VAD 和 Whisper 分片打的是同一个端点，测试方式一样
    if (settings.asr.provider === 'whisper-chunked' || settings.asr.provider === 'vad') {
      const status = await probeWhisper(settings.asr.whisperChunked);
      setResult('asrTestResult', `端点可达（HTTP ${status}）`, 'ok');
    } else if (settings.asr.provider === 'dashscope') {
      /**
       * ⚠️ dashscope **不能**掉进下面那条通用分支。
       *
       * 它复用本地 Silero VAD 引擎来断句，而**设置页从来没引过 onnxruntime** ——
       * 掉进去就会抛「onnxruntime 没加载」，用户完全看不懂（而且那条消息原来还写着"播放页"，方向更错）。
       *
       * 也不能像本地 Whisper 那样只探端点：本地那条要验的是"HTTP 可达"，
       * 而云端这条要验的是 **Key + 模型名 + 端点 + 请求体形状** 四件事。
       * 只探端点的话，Key 是错的也会显示"测试通过" —— 那比没有测试更糟。
       * 所以这里**真的发一次请求**。
       */
      const r = await probeDashscope(settings.asr.dashscope, settings.asr.language);
      if (r.via) {
        setResult('asrTestResult', `识别成功 · 返回「${r.text}」（取自 ${r.via}）`, 'ok');
      } else {
        /**
         * ⚠️ 这里**不能**说"识别成功"。
         *
         * 原来写的是「识别成功 · 返回（空）」—— 用户看到"成功"却什么都没拿到,
         * 只会以为音频里没人说话。而真实原因很可能是**响应里的文本字段不在我们
         * 认识的路径上**(实测踩过:原生端点的文本在 `output.text`,
         * 代码却去 `output.choices[0].message.content[0].text` 找 —— 那条路径是猜的)。
         *
         * 测试音频是仓库自带的 4 秒真人日语,**里面有话** —— 所以拿不到文本
         * 基本就是形状问题,不是"没人说话"。`shapeNote` 里会写明到底是哪种。
         */
        setResult('asrTestResult', `请求成功（HTTP 200），但没拿到文本 —— ${r.shapeNote}`, 'err');
      }
    } else {
      const events = [];
      const session = createAsrSession(settings, (ev) => events.push(ev));
      await withTimeout(session.start(), 15000, '连接');
      await session.stop();
      const err = events.find((e) => e.type === 'error');
      if (err) throw new Error(err.message);
      setResult('asrTestResult', `连接成功 · ${session.sampleRate / 1000}kHz`, 'ok');
    }
  } catch (e) {
    setResult('asrTestResult', e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

/**
 * 真测一次阿里云百炼：拿仓库里自带的 4 秒真人日语当输入，发一次真实请求。
 *
 * 这样一次就同时验掉了 **Key / 模型名 / 端点 / 请求体形状** 四件事 ——
 * 而且返回值就是识别出来的文本，用户一眼能看出"通没通、准不准"。
 *
 * 代价：消耗一次调用额度（4 秒音频）。**这个代价值得** —— 本地 VAD 那条路本来就难自检，
 * 而云端这条只探端点等于什么都没验。
 */
async function probeDashscope(cfg, language) {
  const apiKey = String(cfg?.apiKey || '').trim();
  if (!apiKey) {
    throw new Error('没有填 DashScope API Key —— 到 https://bailian.console.aliyun.com/ 开通百炼后创建');
  }
  const model = String(cfg?.model || '').trim();
  if (!model) throw new Error('没有填模型名（默认是 qwen3-asr-flash）');

  /**
   * ⚠️⚠️ 端点**必须**走生产路径同一个函数,不能在这里另搞一份。
   *
   * 这里原来是:
   *   const endpoint = String(cfg?.endpoint || '').trim();
   *   if (!endpoint) throw new Error('没有填端点地址');
   *   …buildDashscopeBody(…)          ← 永远用兼容请求体
   * 三个后果,全都真实发生过:
   *   ① 直接用 storage 里的 `endpoint` —— 而那里面躺着**老版本的默认 URL**,
   *      于是模型是 `qwen-audio-3.1-asr-flash` 却发去兼容端点 → 404
   *      （用户实测撞的就是这个,而真正的采集路径早就修好了 ——
   *        **两份实现,只修了一份**）
   *   ② `if (!endpoint) throw '没有填端点地址'` 是个陷阱:**清空地址恰恰是正确用法**,
   *      留空表示"用自动选择"。用户按提示清空后,测试按钮反而报"没有填端点地址"。
   *   ③ 不区分端点就永远用兼容请求体,即使端点对了、请求体也是错的;
   *      而且不会加原生端点必需的 `X-DashScope-SSE: disable` 头。
   */
  const picked = resolveDashscopeEndpoint(model, cfg?.endpointMode, cfg?.endpoint);
  const endpoint = picked.url;

  // 仓库里自带的 4 秒真人日语，正好当测试音频 —— 不用另外准备素材
  const res0 = await fetch(chrome.runtime.getURL('vendor/vad-selftest.wav'));
  if (!res0.ok) throw new Error('读不到测试音频 vendor/vad-selftest.wav');
  const wav = new Uint8Array(await res0.arrayBuffer());
  const dataUrl = `data:audio/wav;base64,${bytesToBase64(wav)}`;

  // ⚠️ 走**生产路径同一个函数**，不另写一份请求体；而且按端点选对应的那支
  const body =
    picked.kind === 'native'
      ? buildDashscopeNativeBody({
          model,
          language,
          dataUrl,
          prompt: String(cfg?.prompt || '').trim(),
          hotwords: cfg?.hotwords,
        })
      : buildDashscopeBody({ model, language, dataUrl, prompt: String(cfg?.prompt || '').trim() });

  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  // 原生端点必须带这个头，否则会走 SSE 流式（和生产路径一致）
  if (picked.kind === 'native') headers['X-DashScope-SSE'] = 'disable';

  const res = await withTimeout(
    fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }),
    20000,
    '百炼请求',
  );
  const text = await res.text();
  if (!res.ok) {
    // 把状态码翻译成人话 —— 用户不该去读阿里的英文原文
    const hint =
      res.status === 401 || res.status === 403
        ? '（Key 无效、填错，或者不是这个地域的 Key）'
        : res.status === 404 || /unsupported model|model_not_supported/i.test(text)
          ? '（模型名或端点不对 —— **两个端点支持的模型不一样**：' +
            '「兼容端点」认 qwen3-asr-flash；「原生端点」认 qwen-audio-3.1-asr-flash 等。' +
            '到设置页把「端点」改成「自动」或「原生」再试）'
          : res.status === 429
            ? '（频率超限或额度用尽 —— 去百炼控制台看用量）'
            : res.status === 400
              ? '（请求被拒 —— 多半是模型名或端点与请求体形状不配套；若刚填了「提示词」或「热词」，先清空它们再试）'
              : '';
    throw new Error(`HTTP ${res.status}${hint}：${text.slice(0, 200)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 120)}`);
  }
  // ⚠️ 解析走**生产路径同一个函数** `pickDashscopeText`。
  // 上一轮的教训：测试按钮复制了一份端点/请求体逻辑，结果生产路径修好了、它没修。
  // 解析同一份，就不会再出现"测试说的和生产跑的不一样"。
  // （变量名不叫 `text` —— 上面 `const text = await res.text()` 已经占用了那个名字）
  const pickedText = pickDashscopeText(data);
  return {
    text: pickedText.text,
    via: pickedText.via,
    shapeNote: pickedText.via ? '' : dashscopeShapeNote(data),
    kind: picked.kind,
  };
}

async function probeWhisper(cfg) {
  const baseUrl = String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('请先填写服务地址');
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`服务地址要以 http:// 开头，现在是「${baseUrl}」`);
  }
  const silence = new Int16Array(8000); // 0.5s @16k
  const wav = buildWav(silence, 16000);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'probe.wav');
  form.append('model', cfg.model || 'whisper-1');
  form.append('response_format', 'json');
  const headers = {};
  if (cfg.apiKey?.trim()) headers.Authorization = `Bearer ${cfg.apiKey.trim()}`;
  const url = `${baseUrl}/audio/transcriptions`;
  let res;
  try {
    // 超时给到 45 秒：whisper.cpp 启动后**第一次**请求要把 CUDA 内核编译成这张卡的机器码，
    // 实测约 27 秒。原来卡 20 秒，正好把它拦在门外，看起来就像"连不上"。
    res = await withTimeout(fetch(url, { method: 'POST', headers, body: form }), 45000, '请求');
  } catch (e) {
    const msg = String(e?.message || e);
    if (/超时/.test(msg)) {
      throw new Error(
        `${msg} —— ${url}\n` +
          '服务可能正在编译 CUDA 内核（首次约 27 秒）。再点一次通常就好了；' +
          '或者先双击「启动本地字幕服务.bat」，它会自动热身。',
      );
    }
    // 走到这里就是浏览器**连请求都没发出去**：TypeError: Failed to fetch。
    // 它跟"服务器返回了错误"是两回事，所以不能只把原话抛给用户。
    throw new Error(
      `连不上 ${url}\n` +
        '（浏览器报 Failed to fetch = 请求根本没发出去，不是服务器拒绝了它）\n' +
        '① 服务真的在跑吗？先双击「启动本地字幕服务.bat」\n' +
        '② 地址里的主机名用 127.0.0.1，别用 localhost —— 服务只监听 IPv4，\n' +
        '   localhost 可能被解析成 IPv6 的 ::1，那就连不上\n' +
        '③ 地址填到「你的服务挂 /audio/transcriptions 的那一段」为止 ——\n' +
        '   挂在 /v1/audio/transcriptions 就填 http://127.0.0.1:8080/v1，\n' +
        '   直接挂在 /audio/transcriptions 就不带 /v1。两种都试一下\n' +
        `④ 服务没启动完就点测试也会这样，等它打印出 listening 再试`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // ⚠️ 「未找到文件」最常见的**不是**服务坏了，而是地址前缀多一段或少一段 ——
    // 因为扩展会在你填的地址后面自己接 /audio/transcriptions。
    // 这条提示必须放在这里（服务有响应），而不是上面那个 Failed to fetch 分支：
    // 前缀错了服务器是**会回包**的，只是回 404。
    const prefixHint =
      res.status === 404 || /not\s*found|未找到/i.test(body)
        ? `\n完整请求地址是 ${url}\n` +
          '「未找到文件」通常是地址前缀的问题，不是服务坏了：\n' +
          '  · 服务挂在 /v1/audio/transcriptions → 地址填到 /v1 为止\n' +
          '  · 服务直接挂在 /audio/transcriptions → 地址就不带 /v1\n' +
          '把 /v1 加上或去掉，再点一次测试。'
        : '';
    throw new Error(`HTTP ${res.status}${body ? '：' + body.slice(0, 200) : ''}${prefixHint}`);
  }
  return res.status;
}

async function onTestTranslate() {
  const btn = $('btnTestTranslate');
  btn.disabled = true;
  setResult('trTestResult', '测试中…', '');
  try {
    const settings = collect();
    const r = await withTimeout(testTranslate(settings), 20000, '翻译请求');
    if (!r.output) throw new Error('接口返回了空译文');
    setResult('trTestResult', `${r.input} → ${r.output}`, 'ok');
  } catch (e) {
    setResult('trTestResult', e?.message || String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

// ═══════════════ 反馈 ═══════════════

let toastTimer = null;
function toast(msg, isError) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${isError ? 'err' : ''}`;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2200);
}

// 自动保存：任何字段变更后延迟写盘
let autoSaveTimer = null;
document.addEventListener('change', () => {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    save(false).catch(() => {});
  }, 600);
});
init().catch((e) => toast(e?.message || String(e), true));
