// ASR 提供方工厂：根据设置挑一个实现，并把密钥/参数解析成该实现需要的 config。

import * as deepgram from './deepgram.js';
import * as openaiRealtime from './openai-realtime.js';
import * as whisperChunked from './whisper-chunked.js';
import * as vad from './vad.js';
import * as dashscope from './dashscope.js';
import { effectiveOpenAiKey } from '../settings.js';
import { glossarySourceWords } from '../glossary.js';

const MODULES = {
  deepgram,
  'openai-realtime': openaiRealtime,
  'whisper-chunked': whisperChunked,
  vad,
  dashscope,
};

export { MODULES as ASR_MODULES };

export function createAsrSession(settings, onEvent) {
  const id = settings.asr.provider;
  const mod = MODULES[id];
  if (!mod) throw new Error(`未知的识别服务：${id}`);

  let config;
  if (id === 'deepgram') {
    config = { ...settings.asr.deepgram };
  } else if (id === 'openai-realtime') {
    config = { ...settings.asr.openaiRealtime, apiKey: effectiveOpenAiKey(settings) };
  } else if (id === 'vad') {
    // VAD 模式：地址沿用「本地 Whisper 服务」那一栏（和识别校正共用），
    // 另外带上 VAD 自己的几个参数。
    config = { ...settings.asr.whisperChunked, ...(settings.asr.vad || {}) };
  } else if (id === 'dashscope') {
    /**
     * 阿里云百炼：断句参数沿用 `asr.vad`（和本地 VAD 是同一套引擎、同一批旋钮），
     * 但**不能**把 whisperChunked 合并进来 —— 那份配置里的 `baseUrl` / `apiKey`
     * 是本地 Whisper 服务的，混进来会让人以为地址填错了。
     * 地址/密钥/模型各自独立（见 settings.asr.dashscope）。
     */
    config = { ...(settings.asr.vad || {}), ...(settings.asr.dashscope || {}) };
  } else {
    config = { ...settings.asr.whisperChunked };
  }

  return mod.createSession({
    config,
    global: {
      language: settings.asr.language,
      /**
       * 内置术语表的**源词**，供阿里云百炼的即时热词用。
       *
       * ⚠️ 只有用户显式开了 `asr.dashscope.glossaryHotwords` 才传 ——
       * 热词会改变识别行为，默认悄悄开着会让人困惑（而且它只在原生端点下有效）。
       *
       * 为什么在这里抽、而不是在 `vad.js` 里：`global` 只带 `settings.asr`，
       * 而术语表的开关在 `settings.translate`（`liveGlossary` / `gamingGlossary`）——
       * **只有这一层同时看得到两边。**
       */
      glossaryWords: settings.asr.dashscope?.glossaryHotwords ? glossarySourceWords(settings) : [],
      /**
       * 本地 Whisper 那两条路（VAD / 分片）的「术语表并入热词」。
       *
       * ⚠️ 和上面那个**分开传**：两个开关在两个面板上（`asr.dashscope.*` 与
       * `asr.whisperChunked.*`），共用一个字段会让"我只开了 Whisper 的，阿里云怎么也被影响了"。
       */
      whisperGlossaryWords: settings.asr.whisperChunked?.glossaryHotwords ? glossarySourceWords(settings) : [],
    },
    onEvent,
  });
}
