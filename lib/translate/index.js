// 翻译提供方。统一入口：translate(text, settings, opts) -> string
// 所有实现都只用 fetch，无第三方依赖。
//
// opts.context：同一段话之前的几句原文。逐句独立翻译会丢掉指代和术语一致性，
// 把前文一起给翻译服务能明显改善连贯性。
//
// opts.onNote：给诊断面板用的旁路回调。术语表有没有真正生效、占位符有没有丢，
// 都会通过它报出去——不然用户只会看到"这个词还是译错了"却不知道为什么。

import { chunkText } from '../util.js';
import { md5, sha256Hex, hmac, toHex, hmacSha1Base64 } from '../crypto.js';
import { deeplTarget } from '../settings.js';
import { glossaryEntries, applyPlaceholders, restorePlaceholders, promptGlossaryText } from '../glossary.js';
import { ensureDeepLGlossary } from '../deepl-glossary.js';

const CONTEXT_MAX = 1200;

/**
 * 走 **OpenAI 兼容** 协议的服务商。
 *
 * 它们的请求体（messages / model / temperature）与响应结构（choices[0].message.content）
 * 完全一致，所以共用同一套实现，只差默认地址、默认模型、要不要 API Key。
 * 以后想再加（月之暗面、智谱、硅基流动、自建 vLLM…）只要往这里加一行。
 */
export const OPENAI_COMPAT = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, defaultModel: 'gpt-4o-mini' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', needsKey: true, defaultModel: 'deepseek-chat' },
  // 本地大模型：不联网、零成本、不需要 Key
  ollama: { label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, defaultModel: 'qwen2.5:7b' },
};

export function isTranslateEnabled(settings) {
  return settings.translate.provider !== 'none' && !!settings.translate.target;
}

/** 单次翻译的硬上限。没有它，一次卡住的请求会让字幕永远停在原文上。 */
const DEFAULT_DEADLINE_MS = 12000;

export async function translate(text, settings, { signal, context, onNote, review, deadlineMs } = {}) {
  const src = String(text || '').trim();
  if (!src) return '';
  if (!isTranslateEnabled(settings)) return '';

  const provider = settings.translate.provider;
  const target = settings.translate.target;
  const source = settings.translate.source || 'auto';
  const ctx = normalizeContext(context, src);
  const entries = glossaryEntries(settings);
  // 复核只有 OpenAI 有对应能力；其它家没有"再想一遍"的接口
  const wantReview = !!review && settings.translate.reviewPass === true && provider === 'openai';

  // 兜底超时 + 合并调用方给的 abort 信号。
  // 这一层是必须的：没有它，任何一个不响应的请求都会把整条字幕链挂死，
  // 而且现场只留下"翻译开始"，看不出是卡住了还是失败了。
  const ms = Number.isFinite(deadlineMs) ? Number(deadlineMs) : DEFAULT_DEADLINE_MS;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  const onOuterAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    if (provider === 'google-free') {
      return await translateGoogle(src, settings, { target, source, signal: ctl.signal, entries, onNote });
    }
    if (OPENAI_COMPAT[provider]) {
      return await translateOpenAI(src, settings, {
        target,
        source,
        signal: ctl.signal,
        context: ctx,
        entries,
        onNote,
        // 复核需要两次往返，只给 OpenAI 开；其他家省钱、也少一半延迟
        review: wantReview,
        cfgKey: provider,
      });
    }
    if (provider === 'baidu') {
      return await translateBaidu(src, settings, { target, source, signal: ctl.signal, onNote });
    }
    if (provider === 'tencent') {
      return await translateTencent(src, settings, { target, source, signal: ctl.signal });
    }
    if (provider === 'ali') {
      // 阿里官方支持 Context，把前文一起给它（对指代和术语一致性有帮助）
      return await translateAli(src, settings, { target, source, signal: ctl.signal, context: ctx });
    }
    if (provider === 'deepl') {
      return await translateDeepl(src, settings, {
        target,
        source,
        signal: ctl.signal,
        context: ctx,
        entries,
        onNote,
      });
    }
    return '';
  } catch (e) {
    if (timedOut) {
      const err = new Error(`翻译超时：${ms}ms 内没有得到响应（请求可能被拦截，或服务不可达）`);
      err.name = 'TranslateTimeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

function normalizeContext(context, selfText) {
  const raw = Array.isArray(context) ? context.join(' ') : String(context || '');
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // 上下文里绝不能包含待翻译文本本身，否则模型会把两段都吐出来
  if (trimmed === selfText.trim()) return '';
  return trimmed.length > CONTEXT_MAX ? trimmed.slice(-CONTEXT_MAX) : trimmed;
}

function describeGlossaryReason(reason) {
  if (reason === 'source-auto') {
    return '需要在设置页把「源语言」指定为具体语言——DeepL 不允许在自动检测时使用术语表';
  }
  if (reason === 'no-key') return '缺少 API Key';
  if (reason === 'no-entries') return '术语表是空的';
  if (reason === 'no-glossary-id') return 'DeepL 没有返回 glossary_id';

  const m = /^create-failed-(\d+):?([\s\S]*)$/.exec(String(reason));
  if (m) {
    const status = m[1];
    const detail = (m[2] || '').trim();
    // 把 DeepL 的原话放最前面。以前这里写的是"多为语言代码或格式问题"——
    // 那纯属我猜的，而且查过官方语言表之后发现恰恰猜错了：JA 和 ZH-HANS 都支持术语表。
    const head =
      status === '403'
        ? 'DeepL 拒绝（403，账号可能没有术语表权限）'
        : status === '456'
          ? 'DeepL 拒绝（456，账号配额已用尽）'
          : status === '429'
            ? 'DeepL 拒绝（429，请求过于频繁）'
            : `DeepL 拒绝（${status}）`;
    let hint = '';
    if (/duplicate/i.test(detail)) hint = '（术语表里有重复的原文词条）';
    else if (/language pair|source and target/i.test(detail)) hint = '（这个语言对不支持术语表）';
    else if (/limit|too many|maximum/i.test(detail)) hint = '（词条数超过上限）';
    else if (/authentication|authorization|api[- ]?key/i.test(detail)) hint = '（API Key 无效，或用 Pro 端点配了 Free Key）';
    return `${head}${hint}：${detail || '（DeepL 没有返回说明）'}`;
  }
  if (/^create-error:/.test(reason)) return `连不上 DeepL：${reason.slice('create-error:'.length)}`;
  return reason;
}

// ————————————————————————— Google 免 Key 通道 —————————————————————————

/**
 * 这条通道没有任何术语能力，所以用占位符绕过：
 * 把术语换成不含字母的私有区标记 → 翻译器没什么可翻的，通常原样带过去 → 回来换回目标词。
 * 不保证成功，丢了会通过 onNote 报出来。
 */
async function translateGoogle(text, settings, { target, source, signal, entries, onNote }) {
  const endpoint = settings.translate.google?.endpoint || 'https://translate.googleapis.com/translate_a/single';
  const parts = chunkText(text, 1200);
  const out = [];
  let lostTotal = 0;
  let lostTerms = [];

  for (const part of parts) {
    const prepared = entries?.length ? applyPlaceholders(part, entries) : { text: part, tokens: [] };
    const qs = new URLSearchParams({
      client: 'gtx',
      sl: source === 'auto' ? 'auto' : source,
      tl: target,
      dt: 't',
      q: prepared.text,
    });
    const res = await fetch(`${endpoint}?${qs.toString()}`, { signal });
    if (!res.ok) throw new Error(`Google 翻译返回 ${res.status}`);
    const data = await res.json();
    const segs = Array.isArray(data?.[0]) ? data[0] : [];
    const translated = segs.map((s) => (Array.isArray(s) ? s[0] : '')).filter(Boolean).join('');
    const restored = restorePlaceholders(translated, prepared.tokens);
    lostTotal += restored.lost;
    if (restored.lost) {
      lostTerms.push(
        ...prepared.tokens.filter((t) => !new RegExp(`\\uE000\\s*${t.index}\\s*\\uE001`).test(translated)).map((t) => t.from),
      );
    }
    out.push(restored.text);
  }

  if (lostTotal) {
    onNote?.(`术语占位符丢了 ${lostTotal} 个（${[...new Set(lostTerms)].slice(0, 5).join('、')}）——这几个词这次没被替换`);
  }
  return out.join(' ').trim();
}

// ————————————————————————— OpenAI 兼容 Chat —————————————————————————

/**
 * 百度翻译的语种代码和通用 BCP-47 不是一套，必须显式映射。
 * 写错了不会报错，只会得到**语种不对的译文**，所以这张表要照着官方文档核对。
 */
const BAIDU_LANG = {
  'zh-CN': 'zh',
  'zh-TW': 'cht',
  en: 'en',
  ja: 'jp',
  ko: 'kor',
  es: 'spa',
  fr: 'fra',
  de: 'de',
  ru: 'ru',
  pt: 'pt',
  it: 'it',
  ar: 'ara',
  hi: 'hi',
  th: 'th',
  vi: 'vie',
};

/**
 * 百度翻译（通用文本翻译 API）。
 *
 * 签名很简单：`sign = MD5(appid + q + salt + key)`，但**没有 WebCrypto 能算 MD5**，
 * 所以走 lib/crypto.js 里自带的那份实现（有测试向量钉着）。
 *
 * ⚠️ 免费版有 **QPS = 1** 的限制，也就是每秒最多一次请求。
 * 同传场景下中间结果刷新很快，容易撞限流 —— 频繁报错就把
 * 「中间结果翻译」关掉，只在句子定稿时翻。
 */
async function translateBaidu(text, settings, { target, source, signal, onNote }) {
  const cfg = settings.translate.baidu || {};
  const appid = String(cfg.appid || '').trim();
  const key = String(cfg.key || '').trim();
  if (!appid || !key) throw new Error('百度翻译未配置 APPID / 密钥');
  const endpoint = String(cfg.endpoint || 'https://fanyi-api.baidu.com/api/trans/vip/translate').trim();

  const to = BAIDU_LANG[target] || target;
  const from = source === 'auto' ? 'auto' : BAIDU_LANG[source] || source;

  const out = [];
  for (const part of chunkText(text, 1800)) {
    // salt 只要求"随机数"，用时间戳 + 随机数即可
    const salt = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const sign = md5(appid + part + salt + key);

    const body = new URLSearchParams({ q: part, from, to, appid, salt, sign });
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    });
    if (!res.ok) throw new Error(`百度翻译接口返回 ${res.status}`);
    const data = await res.json();
    // 百度把错误也放在 200 里，必须显式检查
    if (data.error_code) {
      const hint =
        data.error_code === '54003'
          ? '（触发 QPS 限流：免费版每秒只能请求一次，把「中间结果翻译」关掉会好很多）'
          : data.error_code === '54001'
            ? '（签名错误：检查 APPID 与密钥是否配对）'
            : data.error_code === '52003'
              ? '（未授权用户：APPID 可能填错了）'
              : '';
      throw new Error(`百度翻译报错 ${data.error_code}：${data.error_msg || ''}${hint}`);
    }
    const lines = Array.isArray(data.trans_result) ? data.trans_result.map((r) => r.dst) : [];
    if (lines.length) out.push(lines.join('\n'));
  }
  void onNote;
  return out.join('\n').trim();
}

/* ─────────────────────────── 腾讯云 TMT ─────────────────────────── */

/**
 * 腾讯云的语种代码**不是** `zh-CN` 那种 BCP-47，简体中文是 `zh`。
 *
 * ⚠️ 这张表**没有从官方语言表逐条核对过** —— 腾讯云文档站的语言代码页始终跳回目录页，
 * 拿不到那张表。这里依据的是该接口的通行约定（ISO-639-1，繁体用 `zh-TW`）。
 * 所以配套的做法是：**没映射到的代码直接抛中文错误，绝不原样发出去** ——
 * 发错的代码服务端只会回一句"语种不支持"，用户根本不知道是哪里错了。
 */
export const TENCENT_LANG = {
  'zh-CN': 'zh',
  'zh-TW': 'zh-TW',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  de: 'de',
  ru: 'ru',
  pt: 'pt',
  it: 'it',
  ar: 'ar',
  hi: 'hi',
  th: 'th',
  vi: 'vi',
  zh: 'zh',
};

/**
 * 腾讯云 TC3-HMAC-SHA256 签名。**单独抽出来是为了能被测试直接调用** ——
 * 签名算错了服务端只会回一句"签名不匹配"，没有任何别的线索，所以必须对着官方
 * 示例向量逐位验证（见 tools/smoke-test.mjs 的断言）。
 */
export async function tencentAuthorization({
  secretId,
  secretKey,
  service,
  host,
  timestamp,
  payload,
  contentType = 'application/json; charset=utf-8',
}) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const credentialScope = `${date}/${service}/tc3_request`;
  /**
   * ⚠️ 只签 `content-type;host`，**不要**加 `x-tc-action`。
   * 规范要求 canonicalHeaders 里的值与实际发出的请求头**逐字符一致**，
   * 而 `X-TC-Action` 实发是大写的 `TextTranslate` —— 规范化时若写成小写就会签名不匹配，
   * 而服务端只会回一句"签名不匹配"。官方 worked example 用的也正是这两个头。
   */
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const hashedPayload = await sha256Hex(payload);
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  // ⚠️ 每一级 HMAC 的 key 是上一级的**原始字节**，不是十六进制字符串。
  // 所以这里用 hmac()（返回 Uint8Array）而不是 hmacSha256Hex()。
  const kDate = await hmac('SHA-256', 'TC3' + secretKey, date);
  const kService = await hmac('SHA-256', kDate, service);
  const kSigning = await hmac('SHA-256', kService, 'tc3_request');
  const signature = toHex(await hmac('SHA-256', kSigning, stringToSign));

  return {
    signature,
    canonicalRequest,
    stringToSign,
    date,
    credentialScope,
    signedHeaders,
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * 腾讯云机器翻译（TextTranslate）。签名算法见 `tencentAuthorization()`。
 *
 * ⚠️ 没有真实凭据，**没能实机验证过**。签名已对官方示例向量验证通过，
 * 请求头/参数按官方文档与常用 SDK 的写法给出。
 */
async function translateTencent(text, settings, { target, source, signal }) {
  const cfg = settings.translate.tencent || {};
  const secretId = String(cfg.secretId || '').trim();
  const secretKey = String(cfg.secretKey || '').trim();
  if (!secretId || !secretKey) throw new Error('腾讯翻译未配置 SecretId / SecretKey');
  const region = String(cfg.region || 'ap-guangzhou').trim();
  const endpoint = String(cfg.endpoint || 'https://tmt.tencentcloudapi.com').trim();
  const host = new URL(endpoint).host;
  // 腾讯规定 service 就是域名前缀（tmt.tencentcloudapi.com → tmt）
  const service = host.split('.')[0];

  const ACTION = 'TextTranslate';
  const VERSION = '2018-03-21';
  const CT = 'application/json; charset=utf-8';

  const to = pickLang(TENCENT_LANG, target, '腾讯翻译');
  const from = source === 'auto' ? 'auto' : pickLang(TENCENT_LANG, source, '腾讯翻译');

  const out = [];
  // 官方对 TextTranslate 的单次长度上限按 2000 字符算，留一点余量
  for (const part of chunkText(text, 1800)) {
    const payload = JSON.stringify({ SourceText: part, Source: from, Target: to, ProjectId: 0 });
    const timestamp = Math.floor(Date.now() / 1000);
    const auth = await tencentAuthorization({ secretId, secretKey, service, host, timestamp, payload, contentType: CT });

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: auth.authorization,
        'Content-Type': CT,
        Host: host,
        'X-TC-Action': ACTION,
        'X-TC-Version': VERSION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': region,
      },
      body: payload,
      signal,
    });
    // 腾讯把业务错误也放在 HTTP 200 里，必须显式检查 Response.Error
    const data = await res.json().catch(() => null);
    const err = data?.Response?.Error;
    if (err) throw new Error(`腾讯翻译报错 ${err.Code || ''}：${err.Message || ''}${tencentHint(err.Code)}`);
    if (!res.ok) throw new Error(`腾讯翻译接口返回 ${res.status}`);
    const translated = data?.Response?.TargetText;
    if (typeof translated === 'string' && translated) out.push(translated);
  }
  return out.join('\n').trim();
}

/** 把腾讯的错误码翻译成"用户该去改什么"。 */
function tencentHint(code) {
  const c = String(code || '');
  if (c === 'AuthFailure.SignatureFailure' || c === 'AuthFailure.SignatureExpire') {
    return '（签名校验失败：检查 SecretId / SecretKey 是否配对；系统时间偏差超过 5 分钟也会这样）';
  }
  if (c === 'AuthFailure.SecretIdNotFound') return '（SecretId 不存在：多半填错了，或者密钥已被删除）';
  if (c === 'AuthFailure.UnauthorizedOperation') return '（这个密钥没有机器翻译的权限，去控制台开一下）';
  if (c === 'FailedOperation.NoFreeAmount' || c === 'FailedOperation.ServiceIsolate') {
    return '（额度用完了：去腾讯云控制台看机器翻译的剩余量）';
  }
  if (c === 'RequestLimitExceeded') return '（触发限流：把「中间结果翻译」关掉会好很多）';
  if (c === 'UnsupportedOperation.UnsupportedLanguage') return '（这个语种对不支持，换一个目标语言）';
  return '';
}

/* ─────────────────────────── 阿里云机器翻译 ─────────────────────────── */

/**
 * 阿里云的语种代码。⚠️ **繁体是 `zh-tw`（全小写）**，不是 `zh-TW` ——
 * 这是从官方语言代码表逐条核对来的。`auto` 官方明确支持自动检测。
 */
export const ALI_LANG = {
  'zh-CN': 'zh',
  'zh-TW': 'zh-tw',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  de: 'de',
  ru: 'ru',
  pt: 'pt',
  it: 'it',
  ar: 'ar',
  hi: 'hi',
  th: 'th',
  vi: 'vi',
  zh: 'zh',
};

/** 阿里的百分号编码：比 encodeURIComponent 多替换三处（官方规定） */
function aliPercentEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

/**
 * 阿里的规范化查询串：参数名按字典序排序，名与值各做一次 percentEncode，用 `&` 连接。
 * 单独抽出来是为了能被测试直接调用。
 */
export function aliCanonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${aliPercentEncode(k)}=${aliPercentEncode(params[k])}`)
    .join('&');
}

/**
 * 阿里的 POP RPC 签名：`Base64(HMAC-SHA1(AccessKeySecret + '&', StringToSign))`。
 *
 * ⚠️ key 尾部那个 `&` 是**阿里特有的**，漏了就签名错。
 * 已对官方示例向量验证过（StringToSign 与签名都逐字符一致）。
 */
export async function aliSignature({ params, accessKeySecret, method = 'GET' }) {
  const canonical = aliCanonicalQuery(params);
  const stringToSign = `${method}&${aliPercentEncode('/')}&${aliPercentEncode(canonical)}`;
  const signature = await hmacSha1Base64(accessKeySecret + '&', stringToSign);
  return { canonical, stringToSign, signature };
}

/**
 * 阿里云机器翻译（TranslateGeneral）。签名算法见 `aliSignature()`。
 *
 * ⚠️ 没有真实凭据，**没能实机验证过**。签名已对官方示例向量验证通过。
 */
async function translateAli(text, settings, { target, source, signal, context }) {
  const cfg = settings.translate.ali || {};
  const keyId = String(cfg.accessKeyId || '').trim();
  const keySecret = String(cfg.accessKeySecret || '').trim();
  if (!keyId || !keySecret) throw new Error('阿里翻译未配置 AccessKeyId / AccessKeySecret');
  const region = String(cfg.regionId || 'cn-hangzhou').trim();
  const endpoint = String(cfg.endpoint || 'https://mt.aliyuncs.com/').trim();

  const to = pickLang(ALI_LANG, target, '阿里翻译');
  const from = source === 'auto' ? 'auto' : pickLang(ALI_LANG, source, '阿里翻译');

  const out = [];
  // 官方文档写明单次上限 5000 字符，留一点余量
  for (const part of chunkText(text, 4500)) {
    const params = {
      Action: 'TranslateGeneral',
      Format: 'JSON',
      Version: '2018-10-12',
      AccessKeyId: keyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      RegionId: region,
      // ⚠️ FormatType 是**必填**参数（官方文档里标了「是」），官方示例值是 text
      FormatType: 'text',
      SourceLanguage: from,
      TargetLanguage: to,
      SourceText: part,
      Scene: 'general',
    };
    // 上下文：官方支持 Context，同传里对指代和术语一致性有帮助
    if (context) params.Context = String(context).slice(0, 1000);

    const { canonical, signature } = await aliSignature({ params, accessKeySecret: keySecret, method: 'GET' });
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${canonical}&Signature=${aliPercentEncode(signature)}`;
    const res = await fetch(url, { method: 'GET', signal });
    const data = await res.json().catch(() => null);
    // 阿里把错误放在 Code/Message 里，HTTP 状态不一定非 200
    if (data && data.Code !== undefined && Number(data.Code) !== 200) {
      throw new Error(`阿里翻译报错 ${data.Code}：${data.Message || ''}${aliHint(data.Code)}`);
    }
    if (!res.ok) throw new Error(`阿里翻译接口返回 ${res.status}`);
    const translated = data?.Data?.Translated;
    if (typeof translated === 'string' && translated) out.push(translated);
  }
  return out.join('\n').trim();
}

/** 把阿里的错误码翻译成"用户该去改什么"。 */
function aliHint(code) {
  const c = String(code || '');
  if (c === '10005') return '（这个语向不支持，换一个目标语言）';
  if (c === '10004') return '（参数缺失：多半是某个必填项没填）';
  if (c === '10006') return '（语种识别失败：把源语言从「自动检测」改成具体语言试试）';
  if (c === '10001') return '（请求超时：网络或服务端慢，重试即可）';
  return '';
}

/**
 * 取语言代码。**没映射到就抛中文错误，绝不原样透传** ——
 * 透传的后果是服务端回一句"语种不支持"，而用户完全看不出是自己选的语言不在支持列表里。
 */
export function pickLang(table, code, label) {
  const mapped = table[code];
  if (!mapped) {
    throw new Error(`${label}不支持「${code}」这个语种，去设置页换一个目标/源语言`);
  }
  return mapped;
}

async function translateOpenAI(text, settings, { target, source, signal, context, entries, onNote, review, cfgKey = 'openai' }) {
  /**
   * 走 OpenAI 兼容协议的服务商都从这里取配置。
   *
   * 为什么参数化：DeepSeek、Ollama、以及各种"OpenAI 兼容"的自建端点，
   * 请求体与响应结构一模一样，差别只有 baseUrl / model / 要不要 Key。
   * 复制三份代码只会让以后改一处忘两处。
   */
  const cfg = settings.translate[cfgKey];
  // 显式失败，不要回退到 openai 的配置 —— 那会把文本**连同 API Key 一起**
  // 发往 OpenAI 的端点并按 OpenAI 计费。这种失败必须响，不能静默。
  if (!cfg) throw new Error(`翻译服务「${cfgKey}」没有配置块（设置可能损坏，去设置页重选一次）`);
  const meta = OPENAI_COMPAT[cfgKey] || {};
  const apiKey = String(cfg.apiKey || '').trim();
  // 读表里的声明，别硬编码服务商 id —— 否则以后加一个不需要 Key 的本地服务（LM Studio / vLLM）
  // 光往表里加一行是不生效的（这个坑踩过：needsKey 字段成了死数据，测试还绿着）
  if (meta.needsKey !== false && !apiKey) throw new Error(`${meta.label || cfgKey} 翻译未配置 API Key`);
  const baseUrl = String(cfg.baseUrl || meta.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  /**
   * ⚠️ 模型名不能用别家的兜底。
   * 原来 chatOnce 里写的是 `model || 'gpt-4o-mini'`，而参数化之后
   * DeepSeek/Ollama 的模型框一旦被清空，请求会带着 gpt-4o-mini 发往它们 ——
   * 服务端回 model not found，而错误信息里完全不提模型名，用户根本指不到原因。
   */
  const model = String(cfg.model || '').trim();
  if (!model) throw new Error(`${meta.label || cfgKey} 翻译未配置模型名（去设置页填写）`);

  const langName = target === 'zh-CN' ? '简体中文' : target === 'zh-TW' ? '繁體中文' : target;
  const systemParts = [String(cfg.systemPrompt || '').trim()];
  systemParts.push(`目标语言：${langName}。`);
  if (source !== 'auto') systemParts.push(`源语言：${source}。`);
  const terms = promptGlossaryText(entries);
  if (terms) {
    systemParts.push(
      `术语表（必须严格遵守，出现这些词时必须用指定的译法）：${terms}`,
    );
  }
  if (context) {
    systemParts.push(
      '下面是同一段内容的前后文，用【之前】【之后】标出。' +
        '它们**只用来帮你理解指代、术语与语气**：不要翻译它们，也不要在输出里重复它们。\n' +
        '"""\n' +
        context +
        '\n"""',
    );
  }
  systemParts.push('只翻译用户消息里的内容，只输出译文本身。');
  const system = systemParts.filter(Boolean).join('\n\n');

  const parts = chunkText(text, 4000);
  const out = [];
  for (const part of parts) {
    let translated = await chatOnce(baseUrl, apiKey, model, system, part, signal);
    if (review && translated) {
      translated = await reviewOnce(baseUrl, apiKey, model, part, translated, terms, signal);
    }
    out.push(translated);
  }
  void onNote;
  return out.join(' ').trim();
}

async function chatOnce(baseUrl, apiKey, model, system, user, signal) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      // ⚠️ 这里**不能**给别家的模型名兜底。调用方（translateOpenAI）已经校验过非空，
      // 万一这里为空，宁可显式报错，也不要拿着 gpt-4o-mini 去请求 DeepSeek/Ollama ——
      // 那会得到一句 model not found，而错误里完全不提模型名，用户指不到原因。
      model: model || (() => { throw new Error('翻译请求缺少模型名'); })(),
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI 翻译返回 ${res.status}${body ? '：' + body.slice(0, 200) : ''}`);
  }
  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

/**
 * 复核校正：把原文和初译一起交给模型，只让它改错。
 *
 * 初译是"盲翻"的——模型看不到自己的输出，也没有回看的机会。给它一次复核，
 * 术语不一致、指代搞反、数字抄错这类错误能被抓回来。
 * 代价是第二次调用，所以只在延迟模式（有预算）里才建议开。
 */
async function reviewOnce(baseUrl, apiKey, model, source, draft, terms, signal) {
  const system = [
    '你是严格的译文审校。用户会给你一段原文和它的初译。',
    '只修正确定的错误：术语译错、指代搞反、数字与专名抄错、语义偏移。',
    '不要润色、不要改变句式风格、不要增删信息。如果初译已经正确，原样返回。',
    '只输出最终译文本身，不要任何说明或前后缀。',
    terms ? `术语表（必须遵守）：${terms}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const user = `原文：\n"""\n${source}\n"""\n\n初译：\n"""\n${draft}\n"""`;
  try {
    const fixed = await chatOnce(baseUrl, apiKey, model, system, user, signal);
    return fixed || draft;
  } catch {
    // 复核失败不能把已经拿到的初译弄丢
    return draft;
  }
}

// ————————————————————————— DeepL —————————————————————————

async function translateDeepl(text, settings, { target, source, signal, context, entries, onNote }) {
  const cfg = settings.translate.deepl;
  const apiKey = String(cfg.apiKey || '').trim();
  if (!apiKey) throw new Error('DeepL 未配置 API Key');
  const host = cfg.pro ? 'https://api.deepl.com' : 'https://api-free.deepl.com';

  // DeepL 有正式术语表 API，比占位符可靠得多
  let glossaryId = null;
  let usePlaceholders = false;
  if (entries?.length) {
    const g = await ensureDeepLGlossary({
      apiKey,
      pro: !!cfg.pro,
      source: source === 'auto' ? '' : source,
      target: deeplTarget(target),
      entries,
      signal, // 术语表接口也必须能被超时打断，否则它一卡就什么都没有了
    });
    if (g.id) {
      glossaryId = g.id;
    } else {
      // 官方术语表用不了（语言对不支持、配额用满、Key 权限不足……）时，
      // 退回到占位符方案：不如官方术语表可靠，但"这个词必须这么译"至少还能生效。
      usePlaceholders = true;
      // 失败已经被缓存住，这里只在真正尝试过的那一次提醒，免得刷屏
      if (!g.cachedFailure) {
        onNote?.(`DeepL 术语表未生效，已改用占位符替换：${describeGlossaryReason(g.reason)}`);
      }
    }
  }

  const chunks = chunkText(text, 4000);
  const prepared = chunks.map((c) => (usePlaceholders ? applyPlaceholders(c, entries) : { text: c, tokens: [] }));

  const body = {
    text: prepared.map((p) => p.text),
    target_lang: deeplTarget(target),
  };
  if (source && source !== 'auto') body.source_lang = String(source).toUpperCase();
  if (context) body.context = context;
  if (glossaryId) body.glossary_id = glossaryId;

  const res = await fetch(`${host}/v2/translate`, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`DeepL 返回 ${res.status}${t ? '：' + t.slice(0, 200) : ''}`);
  }
  const data = await res.json();
  const translations = data?.translations || [];
  return translations
    .map((t, i) => restorePlaceholders(t?.text || '', prepared[i]?.tokens || []).text)
    .join(' ')
    .trim();
}

/** 设置页的"测试翻译"按钮用 */
export async function testTranslate(settings) {
  const sample =
    settings.translate.source === 'zh' ? '你好，这是一次同声传译测试。' : 'Hello, this is a live interpretation test.';
  const notes = [];
  const out = await translate(sample, settings, { onNote: (n) => notes.push(n) });
  return { input: sample, output: out, notes };
}
