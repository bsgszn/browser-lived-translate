// 阿里云百炼（DashScope）Qwen-ASR —— 国内直连，不需要代理。
//
// ⚠️ 这个模块**不是**一份独立的识别实现，而是「本地 VAD 定轴 + 阿里云出文本」的组合：
// 断句仍然由浏览器内的 Silero VAD 完成（和 `vad` 那个服务用的是同一套引擎），
// 只是把「把这一整句换成文本」这一步从本地 Whisper 换成了阿里云的 HTTP 接口。
//
// 为什么不做成 WebSocket 流式：
//   DashScope 的流式接口要求把 API Key 放在 **WebSocket 握手请求头**里，
//   而浏览器的 `new WebSocket()` 不允许设置任何请求头。
//   （Deepgram / OpenAI Realtime 能浏览器直连，是因为它们官方支持用 subprotocol 传凭据。）
//   HTTP 接口用普通 `fetch`，请求头随便设 —— 这是浏览器里唯一可行的路。
//   代价是非流式：要等一句说完才发请求，比流式多一句的延迟。
//
// 这个取舍和项目当初选「本地 VAD + HTTP 发给 Whisper」是同一个 ——
// 延迟画面模式本来就有几秒预算，而 VAD 已经保证了送出去的是**完整的一句**。

import * as vadEngine from './vad.js';

export const meta = {
  id: 'dashscope',
  label: '阿里云百炼 Qwen-ASR（国内直连，不需要代理）',
  sampleRate: 16000,
  // 收句信号来自真正的语音检测，来得很及时 —— 按"流式"对待，
  // 播放页就不会给累积器套上"分片模式"那个很长的看门狗。
  streaming: true,
  docs: 'https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference',
};

/** 与 vad 共用同一个超时（阿里云偶尔会慢，20 秒足够） */
export const TRANSCRIBE_TIMEOUT_MS = vadEngine.TRANSCRIBE_TIMEOUT_MS;

/**
 * 复用 VAD 引擎，只把转写后端换成 dashscope。
 *
 * 不复制引擎代码是刻意的：`vad.js` 里那几百行有大量踩过坑的细节
 * （Silero v6 窗长 576、帧计数口径、两级边界、音频裁剪窗口），
 * 一旦复制成两份，以后修一边就会漏另一边。
 */
export function createSession({ config, global, onEvent }) {
  return vadEngine.createSession({
    config: { ...config, backend: 'dashscope' },
    global,
    onEvent,
  });
}
