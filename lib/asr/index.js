// ASR 提供方工厂：根据设置挑一个实现，并把密钥/参数解析成该实现需要的 config。

import * as deepgram from './deepgram.js';
import * as openaiRealtime from './openai-realtime.js';
import * as whisperChunked from './whisper-chunked.js';
import * as vad from './vad.js';
import { effectiveOpenAiKey } from '../settings.js';

const MODULES = {
  deepgram,
  'openai-realtime': openaiRealtime,
  'whisper-chunked': whisperChunked,
  vad,
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
  } else {
    config = { ...settings.asr.whisperChunked };
  }

  return mod.createSession({
    config,
    global: { language: settings.asr.language },
    onEvent,
  });
}
