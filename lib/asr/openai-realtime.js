// OpenAI Realtime API：纯转写模式（transcription-only），浏览器直连。
//
// 鉴权：浏览器 WebSocket 无法设置 Authorization 头。官方推荐流程是
//   1) POST {baseUrl}/realtime/client_secrets 换取短时 client secret（旧版端点为 /realtime/sessions）
//   2) 用 subprotocol: ['realtime', 'openai-insecure-api-key.<临时密钥>', 'openai-beta.realtime-v1'] 连接
// 若换发失败（例如自建网关不支持该端点），本模块会退回直接用长期 API Key 走同样的 subprotocol。

export const meta = {
  id: 'openai-realtime',
  label: 'OpenAI Realtime 转写',
  sampleRate: 24000,
  streaming: true,
  docs: 'https://platform.openai.com/docs/guides/realtime-transcription',
};

const BETA = 'openai-beta.realtime-v1';

export function createSession({ config, global, onEvent }) {
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new Error('OpenAI API Key 未配置，请到设置页填写。');

  const baseUrl = String(config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const wsBase = baseUrl.replace(/^http/i, 'ws');
  const model = String(config.model || 'gpt-4o-mini-transcribe').trim();
  const language = String(global.language || 'auto').trim();
  const silenceDurationMs = Number(config.silenceDurationMs || 500);

  let ws = null;
  let stopping = false;
  let opened = false;
  let usedEphemeral = false;
  const url = `${wsBase}/realtime?intent=transcription`;
  const queue = [];
  const partialByItem = new Map();
  let currentItemId = 'live';

  function buildSessionUpdate() {
    const transcription = { model };
    if (language && language !== 'auto') transcription.language = language;
    if (config.prompt?.trim()) transcription.prompt = config.prompt.trim();

    const input = {
      format: { type: 'audio/pcm', rate: meta.sampleRate },
      transcription,
    };
    if (config.turnDetection !== 'none') {
      input.turn_detection = {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: silenceDurationMs,
        // 纯转写会话不需要模型生成回复，显式关掉，避免多出无意义的 response
        create_response: false,
        interrupt_response: false,
      };
    }
    return { type: 'session.update', session: { type: 'transcription', audio: { input } } };
  }

  async function fetchEphemeralKey() {
    const input = buildSessionUpdate().session.audio.input;
    const attempts = [
      {
        url: `${baseUrl}/realtime/client_secrets`,
        body: { expires_after: { anchor: 'created_at', seconds: 600 }, session: { type: 'transcription', audio: { input } } },
      },
      // 旧版 preview 端点，部分网关仍在用
      { url: `${baseUrl}/realtime/sessions`, body: { model, input_audio_format: 'pcm16', input_audio_transcription: { model } } },
      { url: `${baseUrl}/realtime/transcription_sessions`, body: { input_audio_transcription: { model } } },
    ];
    for (const a of attempts) {
      try {
        const res = await fetch(a.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(a.body),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const secret =
          data?.value ||
          data?.client_secret?.value ||
          (typeof data?.client_secret === 'string' ? data.client_secret : null) ||
          data?.session?.client_secret?.value ||
          null;
        if (typeof secret === 'string' && secret) return secret;
      } catch {
        /* 试下一个端点 */
      }
    }
    return null;
  }

  function sendRaw(obj) {
    const data = JSON.stringify(obj);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    else if (queue.length < 400) queue.push(data);
  }

  function handleEvent(msg) {
    const t = msg.type || '';
    if (t === 'conversation.item.input_audio_transcription.delta') {
      const id = msg.item_id || 'live';
      currentItemId = id;
      const prev = partialByItem.get(id) || '';
      const next = prev + (msg.delta || '');
      partialByItem.set(id, next);
      if (next.trim()) onEvent({ type: 'partial', text: next.trim() });
      return;
    }
    if (t === 'conversation.item.input_audio_transcription.completed') {
      const id = msg.item_id || 'live';
      const text = String(msg.transcript || partialByItem.get(id) || '').trim();
      partialByItem.delete(id);
      if (text) {
        onEvent({ type: 'final', text });
        onEvent({ type: 'utteranceEnd', text });
      }
      return;
    }
    if (t === 'conversation.item.input_audio_transcription.failed') {
      onEvent({ type: 'error', message: msg.error?.message || 'OpenAI 转写失败' });
      return;
    }
    if (t === 'input_audio_buffer.speech_started') {
      currentItemId = msg.item_id || 'live';
      partialByItem.set(currentItemId, '');
      onEvent({ type: 'speechStart' });
      return;
    }
    if (t === 'input_audio_buffer.speech_stopped') {
      onEvent({ type: 'speechStop' });
      return;
    }
    if (t === 'error') {
      onEvent({ type: 'error', message: msg.error?.message || 'OpenAI Realtime 返回错误' });
      return;
    }
    if (t === 'session.created' || t === 'session.updated') {
      onEvent({ type: 'status', status: 'connected', detail: `OpenAI ${model}` });
    }
  }

  async function connect(subprotocols) {
    await new Promise((resolve, reject) => {
      let settled = false;
      try {
        ws = new WebSocket(url, subprotocols);
      } catch (e) {
        reject(new Error(`无法创建 OpenAI WebSocket：${e.message}`));
        return;
      }
      ws.onopen = () => {
        opened = true;
        settled = true;
        onEvent({
          type: 'status',
          status: 'connected',
          detail: `OpenAI ${model}${usedEphemeral ? '（临时密钥）' : '（长期密钥）'}`,
        });
        sendRaw(buildSessionUpdate());
        for (const d of queue) ws.send(d);
        queue.length = 0;
        resolve();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          handleEvent(JSON.parse(ev.data));
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('OpenAI Realtime 连接失败：请检查 API Key、Base URL 或网络。'));
        } else {
          onEvent({ type: 'error', message: 'OpenAI Realtime 连接异常' });
        }
      };
      ws.onclose = (ev) => {
        if (!settled) {
          settled = true;
          const err = new Error(
            `OpenAI Realtime 连接被关闭（code=${ev.code}${ev.reason ? '：' + ev.reason : ''}）。` +
              '若为 401/403，请确认 Key 有 Realtime 权限，或改用 Deepgram / Whisper 分片。',
          );
          err.code = ev.code;
          err.reason = ev.reason || '';
          reject(err);
        } else if (!stopping) {
          onEvent({ type: 'status', status: 'closed', detail: `code=${ev.code}` });
        }
      };
    });
  }

  async function start() {
    // 官方建议：拿到临时密钥后立刻连接，不要缓存（session 里那份副本 TTL 约 60 秒）
    const secret = (await fetchEphemeralKey()) || apiKey;
    usedEphemeral = secret !== apiKey;

    try {
      await connect(['realtime', `openai-insecure-api-key.${secret}`, BETA]);
    } catch (e) {
      // 服务端下线 BETA 形状时会以 4000 立即关闭；退化成不带 beta 子协议再试一次
      if (e.code === 4000 || /beta/i.test(e.reason || '')) {
        ws = null;
        await connect(['realtime', `openai-insecure-api-key.${secret}`]);
      } else {
        throw e;
      }
    }
  }

  async function push(int16) {
    if (!int16 || !int16.length) return;
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    sendRaw({ type: 'input_audio_buffer.append', audio: btoa(binary) });
  }

  /**
   * server_vad 模式下服务端自己决定何时提交缓冲区，客户端没有强制手段，
   * 返回 false 让调用方走本地兜底。
   */
  function finalize() {
    if (config.turnDetection !== 'none') return false;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    sendRaw({ type: 'input_audio_buffer.commit' });
    return true;
  }

  async function stop() {
    stopping = true;
    try {
      // server_vad 下缓冲区会自动提交，手动 commit 空缓冲区会触发无意义的 error 事件
      if (config.turnDetection === 'none' && ws && ws.readyState === WebSocket.OPEN) {
        sendRaw({ type: 'input_audio_buffer.commit' });
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 250));
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
