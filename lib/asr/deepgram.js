// Deepgram 实时流式识别（浏览器直连：以 subprotocol 传递 Token）
//
// 契约：createSession({ config, global, onEvent }) -> { sampleRate, streaming, start, push, stop }
// onEvent: { type: 'status' | 'partial' | 'final' | 'speechStart' | 'utteranceEnd' | 'error', ... }

export const meta = {
  id: 'deepgram',
  label: 'Deepgram 实时流式',
  sampleRate: 16000,
  streaming: true,
  docs: 'https://developers.deepgram.com/docs/js-sdk-streaming-transcription',
};

// Deepgram 官方要求 10 秒内必须有数据或 KeepAlive，否则以 NET-0001 断开。
// 官方建议 3–5 秒一次，这里取 4 秒。
const KEEPALIVE_MS = 4000;

export function createSession({ config, global, onEvent }) {
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('Deepgram API Key 未配置，请到设置页填写。');

  const endpoint = String(config.endpoint || 'wss://api.deepgram.com/v1/listen').trim();
  const model = String(config.model || 'nova-3').trim();
  const language = String(global.language || 'auto').trim();

  const params = new URLSearchParams();
  params.set('model', model);
  params.set('encoding', 'linear16');
  params.set('sample_rate', String(meta.sampleRate));
  params.set('channels', '1');
  const useInterim = config.interim !== false;
  params.set('interim_results', useInterim ? 'true' : 'false');
  params.set('punctuate', 'true');
  params.set('smart_format', config.smartFormat === false ? 'false' : 'true');
  if (useInterim) {
    // Deepgram 的 utterance_end_ms / vad_events 依赖 interim_results，关掉中间结果时不能带这两个参数
    params.set('vad_events', 'true');
    params.set('utterance_end_ms', String(config.utteranceEndMs || 1200));
  }
  // endpointing 默认只有 10ms，会把自然停顿切成大量碎句；300ms 更接近人说话的断句
  const endpointing = Number(config.endpointing);
  if (Number.isFinite(endpointing) && endpointing > 0) {
    params.set('endpointing', String(endpointing));
  }

  if (language && language !== 'auto') {
    // nova-3 支持 language=multi 做多语种；其他模型用具体语言码
    params.set('language', language);
  } else if (/^nova-2/.test(model)) {
    params.set('detect_language', 'true');
  } else if (/^nova-3/.test(model)) {
    params.set('language', 'multi');
  }

  const keyterms = String(config.keyterms || '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  // keyterm 只有 nova-3 支持，其他模型带上会直接报错
  if (/^nova-3/.test(model)) {
    for (const k of keyterms.slice(0, 100)) params.append('keyterm', k);
  }

  const url = `${endpoint}?${params.toString()}`;

  let ws = null;
  let keepAlive = null;
  let stopping = false;
  let opened = false;
  const queue = [];

  function sendRaw(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    else if (queue.length < 400) queue.push(data);
  }

  async function start() {
    await new Promise((resolve, reject) => {
      let settled = false;
      try {
        // 浏览器 WebSocket 不能设置请求头，Deepgram 官方支持 subprotocol 传 Token。
        ws = new WebSocket(url, ['token', apiKey]);
      } catch (e) {
        reject(new Error(`无法创建 Deepgram WebSocket：${e.message}`));
        return;
      }
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        opened = true;
        settled = true;
        onEvent({ type: 'status', status: 'connected', detail: `Deepgram ${model}` });
        keepAlive = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }, KEEPALIVE_MS);
        for (const d of queue) ws.send(d);
        queue.length = 0;
        resolve();
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === 'Results') {
          const alt = msg.channel?.alternatives?.[0];
          const text = String(alt?.transcript || '').trim();
          if (msg.is_final) {
            if (text) {
              onEvent({
                type: 'final',
                text,
                confidence: alt?.confidence,
                // 结果覆盖的音频区间（相对本次流的第一帧），用来估算识别滞后
                start: msg.start,
                duration: msg.duration,
              });
            } else {
              onEvent({ type: 'silence' });
            }
          } else if (text) {
            // 中间结果也带音频区间：官方建议**只用中间结果**来算转写延迟，
            // 因为定稿还要额外等"说话结束检测"，混在一起会把延迟算大
            onEvent({ type: 'partial', text, start: msg.start, duration: msg.duration });
          }
          // ⚠️ 两种"说话结束"必须区分开，调用方要靠 reason 决定认不认：
          //   speech_final —— endpointing（默认 120ms 静音）触发，换气都算，太灵敏
          //   下面的 UtteranceEnd —— utterance_end_ms（默认 1000ms 静音）触发，才是真句子边界
          if (msg.speech_final && text) onEvent({ type: 'utteranceEnd', text, reason: 'speech_final' });
        } else if (msg.type === 'UtteranceEnd') {
          // last_word_end 为 -1 表示该事件不可靠，官方建议忽略
          if (Number(msg.last_word_end) >= 0) onEvent({ type: 'utteranceEnd', reason: 'utterance_end' });
        } else if (msg.type === 'SpeechStarted') {
          onEvent({ type: 'speechStart' });
        } else if (msg.type === 'Error' || msg.type === 'error') {
          onEvent({ type: 'error', message: msg.description || msg.message || 'Deepgram 返回错误' });
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Deepgram 连接失败：请检查 API Key、网络或代理。'));
        } else {
          onEvent({ type: 'error', message: 'Deepgram 连接异常' });
        }
      };

      ws.onclose = (ev) => {
        if (keepAlive) clearInterval(keepAlive);
        keepAlive = null;
        if (!settled) {
          settled = true;
          reject(new Error(`Deepgram 连接被关闭（code=${ev.code}）。请检查 Key 是否有效、余额是否充足。`));
        } else if (!stopping) {
          onEvent({ type: 'status', status: 'closed', detail: `code=${ev.code}` });
        }
      };
    });
  }

  /**
   * 请服务端立刻冲刷缓冲区、返回一个真正的定稿结果。
   * 官方文档明确这是**加速**手段，还专门推荐用它绕开 smart_format 的 3 秒定稿阈值。
   * 返回 false 表示当前没法发（比如连接没开），调用方应回落到本地兜底。
   * 注意：不保证一定有 `from_finalize` 回执，调用方要能容忍"发了但没回"。
   */
  function finalize() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ type: 'Finalize' }));
      return true;
    } catch {
      return false;
    }
  }

  function push(int16) {
    if (!int16 || !int16.length) return;
    sendRaw(int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength));
  }

  async function stop() {
    stopping = true;
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = null;
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Finalize 让服务端立刻冲刷缓冲区里还没出结果的音频，避免丢掉最后一个词
        ws.send(JSON.stringify({ type: 'Finalize' }));
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 350));
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 120));
    try {
      if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'client stop');
    } catch {
      /* ignore */
    }
    ws = null;
  }

  return {
    sampleRate: meta.sampleRate,
    streaming: true,
    isOpen: () => opened,
    start,
    push,
    finalize,
    stop,
  };
}
