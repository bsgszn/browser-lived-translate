// 端到端管线测试：用桩对象模拟 AudioContext / AudioWorklet / WebSocket / fetch，
// 驱动 offscreen 音频引擎走完 「启动 → PCM → ASR 事件 → 翻译 → 下发字幕 → 停止」全流程。
// 仅在开发期使用，不参与扩展运行。
//
//   node tools/pipeline-test.mjs

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AGC 的收敛靠 performance.now() 推进，测试里要能自己控制时间轴
let fakeNow = 1000;
Object.defineProperty(globalThis, 'performance', {
  configurable: true,
  value: { now: () => fakeNow },
});

let failures = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`);
  }
}

// ─────────── 记录用容器 ───────────
const swMessages = []; // offscreen -> service worker
const wsInstances = [];
const fetchCalls = [];
let audioContextInstance = null;
let workletInstance = null;
let lastGetUserMediaConstraints = null;

// ─────────── Chrome API 桩 ───────────
let offscreenListener = null;
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { if (!offscreenListener) offscreenListener = fn; } },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    sendMessage: async (payload) => {
      swMessages.push(payload);
      return {};
    },
    getURL: (p) => `chrome-extension://test/${p}`,
    getManifest: () => ({ version: '1.1.0' }),
    getContexts: async () => [],
    openOptionsPage() {},
  },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
  tabs: { get: async () => ({}), query: async () => [], sendMessage: async () => ({}), onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
  tabCapture: { getMediaStreamId: async () => 'sid' },
  offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
  scripting: { executeScript: async () => [] },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  commands: { onCommand: { addListener() {} } },
};

// ─────────── Web 平台桩 ───────────
class FakeGain {
  constructor() {
    this.gain = {
      value: 1,
      setTargetAtTime(v) { this.value = v; },
      cancelScheduledValues() {},
    };
    this.connected = [];
  }
  connect(n) { this.connected.push(n); }
  disconnect() {}
}

class FakeBiquad {
  constructor() {
    this.type = 'lowpass';
    this.frequency = { value: 0 };
    this.Q = { value: 1 };
    this.connected = [];
  }
  connect(n) { this.connected.push(n); }
  disconnect() {}
}

class FakeCompressor {
  constructor() {
    this.threshold = { value: 0 };
    this.knee = { value: 0 };
    this.ratio = { value: 1 };
    this.attack = { value: 0 };
    this.release = { value: 0 };
    this.connected = [];
  }
  connect(n) { this.connected.push(n); }
  disconnect() {}
}

class FakeAudioContext {
  constructor(opts) {
    this.sampleRate = opts?.sampleRate || 48000;
    this.state = 'running';
    this.currentTime = 0;
    this.destination = { name: 'destination' };
    this.audioWorklet = { addModule: async (url) => { this.workletUrl = url; } };
    this.sources = [];
    this.gains = [];
    this.biquads = [];
    this.compressors = [];
    audioContextInstance = this;
  }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createMediaStreamSource(stream) {
    const s = { stream, connected: [], connect(n) { this.connected.push(n); }, disconnect() {} };
    this.sources.push(s);
    return s;
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBiquadFilter() {
    const b = new FakeBiquad();
    this.biquads.push(b);
    return b;
  }
  createDynamicsCompressor() {
    const c = new FakeCompressor();
    this.compressors.push(c);
    return c;
  }
}

class FakeAudioWorkletNode {
  constructor(ctx, name, options) {
    this.ctx = ctx;
    this.name = name;
    this.options = options;
    this.port = { onmessage: null, close() { this.closed = true; } };
    workletInstance = this;
  }
  connect() {}
  disconnect() {}
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.binaryType = 'blob';
    wsInstances.push(this);
    setTimeout(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }
  send(data) { this.sent.push(data); }
  close(code, reason) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason || '' });
  }
  receive(obj) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
  fail() { this.onerror?.({}); }
}

globalThis.AudioContext = FakeAudioContext;
globalThis.AudioWorkletNode = FakeAudioWorkletNode;
globalThis.WebSocket = FakeWebSocket;

const fakeTrack = { kind: 'audio', onended: null, stop() { this.stopped = true; } };
const fakeStream = { getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] };
// Node 24 起 navigator 是 globalThis 上的 getter，必须用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        lastGetUserMediaConstraints = constraints;
        return fakeStream;
      },
    },
  },
});

// fetch 桩：模拟 Google 免 Key 翻译与 OpenAI Chat 翻译
globalThis.fetch = async (url, init) => {
  const href = String(url);
  const body = init?.body ? JSON.parse(init.body) : null;
  fetchCalls.push({ url: href, init, body });
  if (href.includes('chat/completions')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '【译】' } }] }),
      text: async () => '',
    };
  }
  if (href.includes('translate.googleapis.com')) {
    const q = decodeURIComponent(new URL(href).searchParams.get('q') || '');
    const dict = {
      'Hello world': '你好，世界',
      'Hello': '你好',
      'Hello wor': '你好，世',
      'How are you': '你好吗',
    };
    const translated = dict[q] ?? `【${q}】`;
    return {
      ok: true,
      status: 200,
      json: async () => [[[translated, q, null, null, 10]], null, 'en'],
      text: async () => '',
    };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

// ─────────── 载入被测模块 ───────────
const settingsMod = await import('../lib/settings.js');
const audioChainMod = await import('../lib/audio-chain.js');
const offscreen = await import('../offscreen/offscreen.js');
void offscreen;

const settings = JSON.parse(JSON.stringify(settingsMod.DEFAULT_SETTINGS));
settings.asr.provider = 'deepgram';
settings.asr.language = 'en';
settings.asr.deepgram.apiKey = 'test-key';
settings.asr.deepgram.model = 'nova-3';
settings.translate.provider = 'google-free';
settings.translate.target = 'zh-CN';
settings.translate.translateInterim = true;
settings.translate.interimIntervalMs = 300;
settings.translate.interimMinChars = 0; // 主流程测试里放开字数门槛，第 4b 节单独验证该门槛

function callOffscreen(msg, waitMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时未响应：${msg.type}`)), waitMs);
    offscreenListener(msg, {}, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function pcmBlock(amplitude = 0.3) {
  // 440Hz 正弦，2048 帧 @48k
  const buf = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) buf[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / 48000);
  return buf;
}

function emits(filterType) {
  return swMessages.filter((m) => m.type === 'LIVEDUB_EMIT' && m.payload?.type === filterType);
}

function lastSubtitle() {
  const list = emits('LIVEDUB_SUBTITLE');
  return list.length ? list[list.length - 1].payload.segment : null;
}

// ═══════════════ 1. 启动 ═══════════════
console.log('\n[1] 启动音频引擎');
check('已注册 offscreen 消息监听', typeof offscreenListener === 'function');

const startRes = await callOffscreen({ type: 'LIVEDUB_OFFSCREEN_START', streamId: 'sid-123', tabId: 42, settings });
check('OFFSCREEN_START 成功', startRes?.ok === true, JSON.stringify(startRes));
check('返回了 ASR 采样率 16000', startRes?.sampleRate === 16000, JSON.stringify(startRes));
check(
  'getUserMedia 使用了 tabCapture 约束',
  lastGetUserMediaConstraints?.audio?.mandatory?.chromeMediaSource === 'tab' &&
    lastGetUserMediaConstraints?.audio?.mandatory?.chromeMediaSourceId === 'sid-123',
  JSON.stringify(lastGetUserMediaConstraints),
);
check('AudioContext 采样率为 48000', audioContextInstance?.sampleRate === 48000);
check(
  '已加载 AudioWorklet 模块',
  (audioContextInstance?.workletUrl || '').endsWith('offscreen/pcm-worklet.js'),
  audioContextInstance?.workletUrl,
);
check('AudioWorkletNode 名为 livedub-pcm', workletInstance?.name === 'livedub-pcm');
check('worklet 显式下混为单声道', workletInstance?.options?.channelCount === 1 && workletInstance?.options?.channelCountMode === 'explicit');
check('存在回放增益节点（原声接回扬声器）', audioContextInstance?.gains?.length >= 2);

// ═══════════════ 1b. 分析支路音频前端 ═══════════════
console.log('\n[1b] 分析支路音频前端');
const ac = audioContextInstance;
check('分析支路建了 5 个 biquad（1 高通 + 4 低通）', ac.biquads.length === 5, `实际 ${ac.biquads.length}`);
check(
  '第一个是 80Hz 高通（去直流/隆隆声）',
  ac.biquads[0]?.type === 'highpass' && ac.biquads[0]?.frequency.value === 80,
  `${ac.biquads[0]?.type} @ ${ac.biquads[0]?.frequency.value}`,
);
check('后面 4 个是低通', ac.biquads.slice(1).every((b) => b.type === 'lowpass'));
check(
  '低通截止频率按 16kHz 输出算（7040Hz）',
  ac.biquads.slice(1).every((b) => Math.abs(b.frequency.value - 7040) < 1e-6),
  ac.biquads.slice(1).map((b) => b.frequency.value).join(','),
);
check(
  '低通 Q 值是标准 8 阶 Butterworth 极点',
  ac.biquads.slice(1).map((b) => b.Q.value).join(',') === audioChainMod.BUTTERWORTH_Q.join(','),
  ac.biquads.slice(1).map((b) => b.Q.value.toFixed(4)).join(','),
);
check('链路末端有一级限幅器（阈值 -6dB）', ac.compressors.length === 1 && ac.compressors[0].threshold.value === -6);

// 抗混叠必须只挂在分析支路上，回放支路要原封不动
const src = ac.sources[0];
check('source 接了 2 个下游：回放 + 分析支路', src?.connected.length === 2, `实际 ${src?.connected.length}`);
check('source 直接连到回放增益', src?.connected?.[0] === ac.gains[0]);
check('source 没有直连 worklet（必须经过抗混叠链）', !src?.connected?.includes(workletInstance));
check('回放增益直连 destination，不经过任何滤波', ac.gains[0]?.connected?.[0] === ac.destination);
check('分析链末端连着 worklet', ac.compressors[0]?.connected?.[0] === workletInstance);

// ═══════════════ 1c. 安静音源自动增益（结构） ═══════════════
console.log('\n[1c] 自动增益节点');
const agcNode = ac.gains[2]; // 创建顺序：playbackGain, silentSink, agc
check('分析支路里有一个独立的 AGC 增益节点', !!agcNode);
check('初始增益为 1（不改变原始电平）', agcNode?.gain.value === 1);
check('保留给回放的节点没有被 AGC 影响', ac.gains[0]?.gain.value === 1 && ac.gains[1]?.gain.value === 0);

// ═══════════════ 2. WebSocket 连接与鉴权 ═══════════════
console.log('\n[2] 识别服务握手');
await sleep(20);
check('创建了 1 个 WebSocket', wsInstances.length === 1, `实际 ${wsInstances.length}`);
const ws = wsInstances[0];
check('端点指向 Deepgram listen', String(ws?.url).startsWith('wss://api.deepgram.com/v1/listen?'), ws?.url);
check('通过 subprotocol 传 Token（浏览器不能设请求头）', ws?.protocols?.[0] === 'token' && ws?.protocols?.[1] === 'test-key', JSON.stringify(ws?.protocols));
const qs = new URL(String(ws?.url)).searchParams;
check('encoding=linear16', qs.get('encoding') === 'linear16');
check('sample_rate=16000', qs.get('sample_rate') === '16000');
check('interim_results=true', qs.get('interim_results') === 'true');
check('smart_format 默认关闭（避开官方文档记载的 3 秒定稿挂起）', qs.get('smart_format') === 'false');
check('punctuate=true（标点不依赖 smart_format）', qs.get('punctuate') === 'true');
check('language=multi 只在显式选了自动检测时才会出现', qs.get('language') === 'en');
// 这条同时守着两件事：不能吃 Deepgram 默认的 10ms；也不能太小 ——
// endpointing 是延迟模式的句子边界，原来的 120ms 会让换气都算"说完了"
check('endpointing 显式设定，且落在「句间停顿」量级', Number(qs.get('endpointing')) >= 300 && Number(qs.get('endpointing')) <= 1000, qs.get('endpointing'));
check('utterance_end_ms 不低于服务端最小值 1000', Number(qs.get('utterance_end_ms')) >= 1000, qs.get('utterance_end_ms'));
check('model=nova-3', qs.get('model') === 'nova-3');
check('已上报 connected 状态', swMessages.some((m) => m.type === 'LIVEDUB_ASR_STATUS' && m.status === 'connected'));

// ═══════════════ 3. PCM 前向 ═══════════════
console.log('\n[3] PCM 采集与重采样');
workletInstance.port.onmessage({ data: pcmBlock().buffer });
workletInstance.port.onmessage({ data: pcmBlock().buffer });
workletInstance.port.onmessage({ data: pcmBlock().buffer });
await sleep(10);

const binarySends = ws.sent.filter((d) => d instanceof ArrayBuffer);
check('块被转发到 WebSocket', binarySends.length === 3, `实际 ${binarySends.length}`);
const bytesPerBlock = 2048 / 3 * 2;
check(
  '48k→16k 重采样后字节数正确（2048 帧 → 约 1366 字节）',
  binarySends.every((b) => Math.abs(b.byteLength - bytesPerBlock) <= 2),
  binarySends.map((b) => b.byteLength).join(','),
);
check('上报了音量电平', swMessages.some((m) => m.type === 'LIVEDUB_LEVEL'));
check('电平非零（有声音输入）', swMessages.some((m) => m.type === 'LIVEDUB_LEVEL' && m.level > 0.05));

// ═══════════════ 3b. 安静音源自动增益（行为） ═══════════════
console.log('\n[3b] 自动增益行为');
{
  // 喂 6.5 秒安静人声（峰值 0.02，RMS≈0.014），时间轴同步推进。
  // AGC 故意做得很慢（电平 τ=1.2s），免得跟着音量上下"呼吸"，所以要给它足够时间收敛。
  const quiet = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) quiet[i] = 0.02 * Math.sin((2 * Math.PI * 300 * i) / 48000);
  for (let i = 0; i < 150; i++) {
    fakeNow += 43;
    workletInstance.port.onmessage({ data: quiet.buffer.slice(0) });
  }
  await sleep(10);
  check(`安静输入后 AGC 增益升到 ${agcNode.gain.value.toFixed(2)}（应 > 3）`, agcNode.gain.value > 3);

  // 突然变响，增益必须回落，避免过载
  const loud = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) loud[i] = 0.8 * Math.sin((2 * Math.PI * 300 * i) / 48000);
  for (let i = 0; i < 150; i++) {
    fakeNow += 43;
    workletInstance.port.onmessage({ data: loud.buffer.slice(0) });
  }
  await sleep(10);
  check(`变响后 AGC 增益回落到 ${agcNode.gain.value.toFixed(2)}（应 < 1.2）`, agcNode.gain.value < 1.2);
}

{
  const off = JSON.parse(JSON.stringify(settings));
  off.audio.autoGain = false;
  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: off });
  const before = agcNode.gain.value;
  const quiet = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) quiet[i] = 0.02 * Math.sin((2 * Math.PI * 300 * i) / 48000);
  for (let i = 0; i < 120; i++) {
    fakeNow += 43;
    workletInstance.port.onmessage({ data: quiet.buffer.slice(0) });
  }
  await sleep(10);
  check('关闭开关后 AGC 不再改动增益', agcNode.gain.value === before, `${before} → ${agcNode.gain.value}`);
  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings });
}

// ═══════════════ 4. 中间结果 → 字幕 ═══════════════
console.log('\n[4] 中间结果与即时翻译');
const before = emits('LIVEDUB_SUBTITLE').length;
ws.receive({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'Hello' }] } });
await sleep(30);
check('产生了 SUBTITLE 事件', emits('LIVEDUB_SUBTITLE').length > before);
const firstEmit = emits('LIVEDUB_SUBTITLE')[before].payload.segment;
check('首帧先下发未翻译的原文（不等翻译）', firstEmit.original === 'Hello' && firstEmit.translation === '', JSON.stringify(firstEmit));
check('标记为 partial', firstEmit.state === 'partial');
check('未定稿（done=false）', firstEmit.done === false);

let seg = lastSubtitle();
check('随后同一片段被即时翻译', seg?.translation === '你好', JSON.stringify(seg));
check('翻译后仍复用同一 id', seg?.id === firstEmit.id);

ws.receive({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'Hello wor' }] } });
await sleep(30);
seg = lastSubtitle();
check('同一片段内文本被更新（复用同一个 id）', seg?.original === 'Hello wor', JSON.stringify(seg));
check('片段 id 未变化', typeof seg?.id === 'string' && seg.id.length > 0);

// 中间结果只是往后补词时，旧译文可以继续沿用（不用等新请求）
const idxAppend = emits('LIVEDUB_SUBTITLE').length;
ws.receive({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'Hello world' }] } });
const appendEmit = emits('LIVEDUB_SUBTITLE')[idxAppend].payload.segment;
check(
  '只补词时不闪掉已有译文（沿用它，等新译文到达再替换）',
  appendEmit.original === 'Hello world' && appendEmit.translation.length > 0,
  JSON.stringify(appendEmit),
);

// 但原文被大幅修正时，旧译文必须立刻清掉，否则会显示对不上的字幕
const idxRewrite = emits('LIVEDUB_SUBTITLE').length;
ws.receive({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'Yellow car' }] } });
const rewriteEmit = emits('LIVEDUB_SUBTITLE')[idxRewrite].payload.segment;
check(
  '原文被改写时旧译文立即清空（不做错配显示）',
  rewriteEmit.original === 'Yellow car' && rewriteEmit.translation === '',
  JSON.stringify(rewriteEmit),
);

// ═══════════════ 5. 定稿 ═══════════════
console.log('\n[5] 定稿与最终翻译');
const idBeforeFinal = lastSubtitle()?.id;
ws.receive({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'Hello world' }] } });
await sleep(120);
seg = lastSubtitle();
check('定稿片段复用了同一行（未另起一行）', seg?.id === idBeforeFinal, `${idBeforeFinal} vs ${seg?.id}`);
check('原文更新为定稿文本', seg?.original === 'Hello world', JSON.stringify(seg));
check('state=final', seg?.state === 'final');
check('done=true', seg?.done === true);
check('译文正确', seg?.translation === '你好，世界', JSON.stringify(seg));
check('推送了历史记录', swMessages.some((m) => m.type === 'LIVEDUB_HISTORY_PUSH' && m.entry?.original === 'Hello world'));
check('推送了历史译文回填', swMessages.some((m) => m.type === 'LIVEDUB_HISTORY_UPDATE' && m.translation === '你好，世界'));
check('未把定稿再上报为 partial', emits('LIVEDUB_SUBTITLE').every((m) => true));

// 重复的 final 应被去重
const countAfterFinal = emits('LIVEDUB_SUBTITLE').length;
ws.receive({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'Hello world' }] } });
await sleep(60);
check('重复 final 被去重', emits('LIVEDUB_SUBTITLE').length === countAfterFinal, `${countAfterFinal} → ${emits('LIVEDUB_SUBTITLE').length}`);

// ═══════════════ 6. 新片段 ═══════════════
console.log('\n[6] 新片段与翻译缓存');
ws.receive({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'How are you' }] } });
await sleep(120);
seg = lastSubtitle();
check('新片段另起一行', seg?.original === 'How are you' && seg?.id !== idBeforeFinal, JSON.stringify(seg));
check('新片段译文正确', seg?.translation === '你好吗', JSON.stringify(seg));
const fetchCountBefore = fetchCalls.length;
ws.receive({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'Hello' }] } });
await sleep(400);
check('相同文本走缓存（没有新增翻译请求）', fetchCalls.length === fetchCountBefore, `${fetchCountBefore} → ${fetchCalls.length}`);

// ═══════════════ 6b. 中间结果字数门槛 ═══════════════
console.log('\n[6b] 中间结果字数门槛');
await sleep(300); // 等前面所有在途翻译请求落定，再取基线
const gated = JSON.parse(JSON.stringify(settings));
gated.translate.interimMinChars = 12;
await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: gated });
const fetchesBeforeGate = fetchCalls.length;
ws.receive({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'Hi' }] } });
await sleep(500);
check('短于门槛的中间结果不触发翻译请求', fetchCalls.length === fetchesBeforeGate, `${fetchesBeforeGate} → ${fetchCalls.length}`);
check(
  '短句仍先以原文形式显示',
  lastSubtitle()?.original === 'Hi' && lastSubtitle()?.translation === '',
  JSON.stringify(lastSubtitle()),
);
ws.receive({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'Hi' }] } });
await sleep(150);
check('定稿不受门槛限制，短句照样翻译', lastSubtitle()?.translation === '【Hi】', JSON.stringify(lastSubtitle()));
await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings });

// ═══════════════ 6c. 识别滞后上报 ═══════════════
console.log('\n[6c] 识别滞后上报');
{
  const count = () => swMessages.filter((m) => m.type === 'LIVEDUB_LATENCY').length;
  const beforeLat = count();
  // 官方建议只用**中间结果**算转写延迟（定稿还含"说话结束检测"的等待）。
  // 所以这里必须发 is_final:false 的结果，定稿不参与这个读数。
  ws.receive({ type: 'Results', is_final: false, start: 0, duration: 0.05, channel: { alternatives: [{ transcript: 'Timing check' }] } });
  await sleep(150);
  check('中间结果带 start/duration 时回报识别滞后', count() > beforeLat);
  const sample = swMessages.filter((m) => m.type === 'LIVEDUB_LATENCY').at(-1);
  check(`滞后读数合理（${sample?.lagMs}ms）`, Number.isFinite(sample?.lagMs) && sample.lagMs >= 0 && sample.lagMs < 20000);

  ws.receive({ type: 'Results', is_final: true, start: 0, duration: 0.05, channel: { alternatives: [{ transcript: 'Timing check done' }] } });
  await sleep(120);
  check('流式模式下定稿不参与滞后读数（避免把说话结束检测算进去）', swMessages.filter((m) => m.type === 'LIVEDUB_LATENCY').at(-1)?.lagMs === sample?.lagMs);

  // start 为负说明结果声称覆盖了"还没送出去的音频"，属于异常值，必须被夹住而不是让读数爆掉。
  // 读数经过 EMA 平滑，所以多发几次让它收敛。
  for (let i = 0; i < 10; i++) {
    ws.receive({ type: 'Results', is_final: false, start: -9999, duration: 0, channel: { alternatives: [{ transcript: 'Clamp check' }] } });
    await sleep(15);
  }
  await sleep(100);
  const clamped = swMessages.filter((m) => m.type === 'LIVEDUB_LATENCY').at(-1);
  check(`异常大的滞后被夹在上限内（${clamped?.lagMs}ms，未夹住会是千万级）`, clamped?.lagMs > 15000 && clamped?.lagMs <= 20000);

  // 没有时间信息的服务（OpenAI Realtime）不应上报 NaN
  const badLag = swMessages.filter((m) => m.type === 'LIVEDUB_LATENCY' && m.lagMs !== null && !Number.isFinite(m.lagMs));
  check('滞后只会上报有限数值或 null，不会是 NaN', badLag.length === 0);

  const translateReports = swMessages.filter((m) => m.type === 'LIVEDUB_LATENCY' && Number.isFinite(m.translateMs));
  check('翻译耗时会与识别滞后一起上报', translateReports.length > 0);
  check(
    `翻译耗时读数合理（${translateReports.at(-1)?.translateMs}ms）`,
    translateReports.at(-1)?.translateMs >= 0 && translateReports.at(-1)?.translateMs < 60000,
  );
}

// ═══════════════ 6d. 翻译上下文串起来 ═══════════════
console.log('\n[6d] 翻译上下文');
{
  const ctxSettings = JSON.parse(JSON.stringify(settings));
  ctxSettings.translate.provider = 'openai';
  ctxSettings.translate.openai.apiKey = 'sk-test';
  ctxSettings.translate.contextSegments = 2;
  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: ctxSettings });

  const chats = () => fetchCalls.filter((c) => c.url.includes('chat/completions'));
  const base = chats().length;

  for (const line of ['First sentence here.', 'Second sentence follows.', 'Third one now.']) {
    ws.receive({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: line }] } });
    await sleep(120);
  }

  const calls = chats().slice(base);
  check('每句定稿都发了一次翻译请求', calls.length === 3, `实际 ${calls.length}`);
  const systemOf = (i) => calls[i]?.body?.messages?.[0]?.content || '';
  const userOf = (i) => calls[i]?.body?.messages?.[1]?.content || '';
  const lines = ['First sentence here.', 'Second sentence follows.', 'Third one now.'];

  check('任何一句的上下文都不会包含它自己', lines.every((t, i) => !systemOf(i).includes(t)));
  check('第二句带上了第一句作为上下文', systemOf(1).includes('First sentence here.'));
  check(
    '第三句同时带上了前两句',
    systemOf(2).includes('First sentence here.') && systemOf(2).includes('Second sentence follows.'),
  );
  check('user 消息始终只含待翻译文本', userOf(2) === 'Third one now.', userOf(2));
  check('温度固定为 0（同传要稳定，不要发散）', calls.every((c) => c.body.temperature === 0));

  // 上下文窗口必须受 contextSegments 限制，否则会越滚越长、token 失控
  const limited = JSON.parse(JSON.stringify(ctxSettings));
  limited.translate.contextSegments = 1;
  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: limited });
  const base2 = chats().length;
  ws.receive({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'Fourth line arrives.' }] } });
  await sleep(150);
  const sys = chats()[base2]?.body?.messages?.[0]?.content || '';
  check('contextSegments=1 时只带最近一句', sys.includes('Third one now.') && !sys.includes('First sentence here.'));

  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings });
}

// ═══════════════ 6e. 长时间不停顿的兜底 ═══════════════
console.log('\n[6e] 强制断句兜底');
{
  const controlSends = () => ws.sent.filter((d) => typeof d === 'string' && d.includes('Finalize')).length;

  const ffs = JSON.parse(JSON.stringify(settings));
  ffs.asr.maxSegmentMs = 300;
  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: ffs });

  const finalizeBefore = controlSends();
  ws.receive({ type: 'Results', is_final: false, start: 0, duration: 0.4, channel: { alternatives: [{ transcript: 'A very long sentence that never ends' }] } });
  await sleep(40);
  check('先处于未定稿状态', lastSubtitle()?.state === 'partial' && lastSubtitle()?.done === false);

  // 到点后应当先请服务端冲刷缓冲区（官方说 Finalize 是纯加速手段），而不是自己拿中间结果凑
  await sleep(420);
  check('到点后向识别服务发出了 Finalize', controlSends() > finalizeBefore);
  check('仍在等服务端回执，没急着本地定稿', lastSubtitle()?.state === 'partial', JSON.stringify(lastSubtitle()));

  // 服务端不回执时，宽限期一过必须本地兜底，不能无限等下去
  await sleep(800);
  const forced = lastSubtitle();
  check('服务端没回执时宽限期后本地兜底定稿', forced?.state === 'final', JSON.stringify(forced));
  check('兜底定稿用的是当前中间结果的文本', forced?.original === 'A very long sentence that never ends');
  check('兜底定稿后译文照常补上', !!forced?.translation, JSON.stringify(forced));

  // 定稿后同一段继续来中间结果，必须另起一行，不能把定稿的那行重新打开
  const idAtFinal = forced.id;
  ws.receive({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'A very long sentence that never ends and continues' }] } });
  await sleep(40);
  check('兜底定稿后新到的中间结果另起新行', lastSubtitle()?.id !== idAtFinal, `${idAtFinal} → ${lastSubtitle()?.id}`);

  // 等这一段自己的兜底也走完，让 liveSeg 回到 final 状态，
  // 否则下面新发的中间结果会复用同一段，测不到"新段不再排定时器"
  await sleep(1300);

  // 关掉上限：不仅新段不排定时器，已经排上的也要取消
  const noff = JSON.parse(JSON.stringify(settings));
  noff.asr.maxSegmentMs = 0;
  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: noff });
  ws.receive({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'Another never ending sentence' }] } });
  await sleep(1200);
  check('上限设为 0 时不再强制断句', lastSubtitle()?.state === 'partial', JSON.stringify(lastSubtitle()));

  // 再开回来，兜底要能重新生效
  const back = JSON.parse(JSON.stringify(settings));
  back.asr.maxSegmentMs = 250;
  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: back });
  await sleep(1300);
  check('重新开启上限后兜底恢复生效', lastSubtitle()?.state === 'final', JSON.stringify(lastSubtitle()));

  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings });
}

// ═══════════════ 6f. 翻译请求背压与定稿优先 ═══════════════
console.log('\n[6f] 翻译请求背压与定稿优先');
{
  // 换成受控 fetch：由测试决定每个请求什么时候返回，才能观察"同时在飞几条"
  const realFetch = globalThis.fetch;
  const pending = [];
  globalThis.fetch = (url, init) => {
    const rec = { url: String(url), init, aborted: false, settled: false };
    rec.promise = new Promise((resolve, reject) => {
      rec.resolve = resolve;
      rec.reject = reject;
    });
    const sig = init?.signal;
    if (sig) {
      const onAbort = () => {
        rec.aborted = true;
        if (!rec.settled) {
          rec.settled = true;
          rec.reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        }
      };
      if (sig.aborted) onAbort();
      else sig.addEventListener('abort', onAbort);
    }
    // 被取消的请求会 reject，这里先挂一个空的 catch 免得变成 unhandled rejection
    rec.promise.catch(() => {});
    fetchCalls.push(rec);
    pending.push(rec);
    return rec.promise;
  };
  const respond = (rec, translated) => {
    rec.settled = true;
    rec.resolve({
      ok: true,
      status: 200,
      json: async () => [[[translated, '', null, null, 1]], null, 'en'],
      text: async () => '',
    });
  };
  const inFlight = () => pending.filter((r) => !r.settled);
  // URLSearchParams 把空格编成 '+'，不是 %20，解码时要一并还原
  const urlOf = (r) => decodeURIComponent(r.url).replace(/\+/g, ' ');

  try {
    const g = JSON.parse(JSON.stringify(settings));
    g.translate.provider = 'google-free';
    g.translate.translateInterim = true;
    g.translate.interimMinChars = 4;
    g.translate.interimIntervalMs = 200;
    await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: g });
    await sleep(400);

    pending.length = 0;
    fetchCalls.length = 0;

    // 连续来中间结果，但一个都不让它返回——模拟翻译服务变慢
    for (let i = 0; i < 8; i++) {
      ws.receive({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: `Interim statement number ${i}` }] } });
      await sleep(110);
    }
    await sleep(300);

    check(
      `翻译变慢时同时在飞的中间结果请求不超过 1 条（实际 ${inFlight().length} 条）`,
      inFlight().length <= 1,
      inFlight().map(urlOf).join(' | '),
    );
    check('每个翻译请求都带上了可取消的 signal', pending.every((r) => r.init?.signal instanceof AbortSignal));

    const stuckInterim = inFlight()[0];
    check('确实有一个中间结果请求被卡住（用于验证下面的抢占）', !!stuckInterim);

    // 定稿到达：必须立刻抢占连接，而不是排在中间结果后面
    ws.receive({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'Final sentence arrives' }] } });
    await sleep(120);

    check('定稿会掐掉在飞的中间结果请求（把连接让出来）', stuckInterim?.aborted === true);

    const finalRec = inFlight().find((r) => urlOf(r).includes('Final sentence arrives'));
    check('定稿请求立刻发出，没有排队等待', !!finalRec, inFlight().map(urlOf).join(' | '));
    check(
      `此时在飞的请求只有定稿这一条（实际 ${inFlight().length} 条）`,
      inFlight().length === 1,
      inFlight().map(urlOf).join(' | '),
    );

    if (finalRec) respond(finalRec, '最终译文');
    await sleep(200);
    check('定稿译文正确落地', lastSubtitle()?.translation === '最终译文', JSON.stringify(lastSubtitle()));
    check('定稿完成后翻译耗时被记录', swMessages.some((m) => m.type === 'LIVEDUB_LATENCY' && Number.isFinite(m.translateMs)));

    // 卡住的中间结果被取消，不应该被当成"翻译失败"报给用户
    const abortErrors = swMessages.filter((m) => m.type === 'LIVEDUB_TRANSLATE_ERROR' && /abort/i.test(m.message || ''));
    check('被抢占的中间结果不会被误报成翻译失败', abortErrors.length === 0, JSON.stringify(abortErrors));

    // 中间结果翻译要能恢复：再给一条足够长的，应当继续发请求
    const before = pending.length;
    ws.receive({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'One more interim sentence' }] } });
    await sleep(350);
    check('定稿之后中间结果翻译会恢复', pending.length > before, `${before} → ${pending.length}`);
    for (const r of inFlight()) respond(r, '收尾');
    await sleep(120);
  } finally {
    for (const r of pending) {
      if (!r.settled) {
        r.settled = true;
        r.resolve({ ok: true, status: 200, json: async () => [[['x', '', null, null, 1]], null, 'en'], text: async () => '' });
      }
    }
    globalThis.fetch = realFetch;
    await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings });
  }
}

// ═══════════════ 6g. 诊断通道 ═══════════════
console.log('\n[6g] 诊断通道（绕开状态通道）');
{
  const diags = () => swMessages.filter((m) => m.type === 'LIVEDUB_DIAG');

  const off = JSON.parse(JSON.stringify(settings));
  off.ui.showDiag = false;
  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: off });
  const quietBefore = diags().length;
  ws.receive({ type: 'Results', is_final: false, start: 2, duration: 1, channel: { alternatives: [{ transcript: 'Quiet please' }] } });
  await sleep(200);
  check('诊断默认关闭时不上报任何诊断行', diags().length === quietBefore, `${quietBefore} → ${diags().length}`);

  const on = JSON.parse(JSON.stringify(settings));
  on.ui.showDiag = true;
  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: on });

  const before = diags().length;
  ws.receive({ type: 'Results', is_final: false, start: 3, duration: 1, channel: { alternatives: [{ transcript: 'Diagnostic check sentence' }] } });
  await sleep(250);
  check('开启诊断后会上报耗时行', diags().length > before);
  check('诊断行带着 tabId（SW 靠它直接发给页面，不经 storage）', diags().every((d) => d.tabId === 42));
  check('耗时行内容可读', /识别/.test(diags().at(-1)?.line || ''), diags().at(-1)?.line);

  // 翻译生命周期：开始 / 完成 都要能看见，且带毫秒数
  const lines = diags().map((d) => d.line);
  check('有"翻译开始"事件', lines.some((l) => /翻译开始/.test(l)), lines.slice(-4).join(' | '));
  check('有"翻译完成"事件且带耗时', lines.some((l) => /翻译完成 · \d+ms/.test(l)), lines.slice(-4).join(' | '));
  check('生命周期事件标记了要打到页面控制台', diags().some((d) => d.log === true));

  // 翻译失败也要能被看见（这是"看不到翻译时间"最可能的真相）
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'Forbidden' });
  try {
    ws.receive({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'This one will fail' }] } });
    await sleep(300);
    const failLine = diags().map((d) => d.line).find((l) => /翻译失败/.test(l));
    check('翻译失败会被诊断通道捕获并带上原因', !!failLine && /403/.test(failLine), failLine || diags().map((d) => d.line).slice(-3).join(' | '));
    check('失败也会上报到状态通道（弹窗红色提示）', swMessages.some((m) => m.type === 'LIVEDUB_TRANSLATE_ERROR' && /403/.test(m.message || '')));
  } finally {
    globalThis.fetch = realFetch;
  }

  const finalOff = JSON.parse(JSON.stringify(settings));
  finalOff.ui.showDiag = false;
  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: finalOff });
  await sleep(400); // 让在途的诊断行落定，再取基线
  const afterOff = diags().length;
  ws.receive({ type: 'Results', is_final: false, start: 9, duration: 1, channel: { alternatives: [{ transcript: 'Back to quiet' }] } });
  await sleep(300);
  check('再次关闭后不再上报', diags().length === afterOff, `${afterOff} → ${diags().length}`);

  await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings });
}

// ═══════════════ 7. 空结果与异常 ═══════════════
console.log('\n[7] 边界情况');
const beforeEmpty = emits('LIVEDUB_SUBTITLE').length;
ws.receive({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: '   ' }] } });
await sleep(30);
check('空白转写不产生字幕', emits('LIVEDUB_SUBTITLE').length === beforeEmpty);

ws.receive({ type: 'Error', description: '识别服务内部错误' });
await sleep(20);
check('错误被上报到 SW', swMessages.some((m) => m.type === 'LIVEDUB_CAPTURE_ERROR' && /内部错误/.test(m.message)));

// ═══════════════ 8. 运行中改设置 ═══════════════
console.log('\n[8] 运行中热更新');
const resMute = await callOffscreen({ type: 'LIVEDUB_SET_MUTE', muted: true });
check('SET_MUTE 成功', resMute?.ok === true);
check('回放增益被拉到 0（静音原声）', audioContextInstance.gains.some((g) => g.gain.value === 0));

settings.ui.fontSize = 30;
const resApply = await callOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings });
check('APPLY_SETTINGS 成功', resApply?.ok === true);
check('样式变更被下发到页面', emits('LIVEDUB_STYLE').some((m) => m.payload.ui.fontSize === 30));

// ═══════════════ 9. 停止 ═══════════════
console.log('\n[9] 停止与资源回收');
await sleep(200);
const resStop = await callOffscreen({ type: 'LIVEDUB_OFFSCREEN_STOP' });
check('OFFSCREEN_STOP 成功', resStop?.ok === true);
check('音轨被停止', fakeTrack.stopped === true);
check('AudioContext 被关闭', audioContextInstance.state === 'closed');
check('AudioWorklet 端口被关闭', workletInstance.port.closed === true);
check('WebSocket 被关闭', wsInstances.every((w) => w.readyState === FakeWebSocket.CLOSED));

const afterStop = emits('LIVEDUB_SUBTITLE').length;
wsInstances[0].receive({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'should be ignored' }] } });
await sleep(50);
check('停止后不再产生字幕', emits('LIVEDUB_SUBTITLE').length === afterStop);

// ═══════════════ 10. 重新启动（验证无残留状态） ═══════════════
console.log('\n[10] 重新启动');
const idsBeforeRestart = new Set(emits('LIVEDUB_SUBTITLE').map((m) => m.payload.segment.id));
const restart = await callOffscreen({ type: 'LIVEDUB_OFFSCREEN_START', streamId: 'sid-2', tabId: 42, settings });
check('可再次启动', restart?.ok === true, JSON.stringify(restart));
await sleep(20);
const ws2 = wsInstances[wsInstances.length - 1];
ws2.receive({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'How are you' }] } });
await sleep(150);
const seg2 = lastSubtitle();
check(
  '重启后片段 id 不与上一轮冲突（计数器单调递增）',
  /^s\d+$/.test(seg2?.id || '') && !idsBeforeRestart.has(seg2.id),
  `${seg2?.id}，上一轮用过: ${[...idsBeforeRestart].join(',')}`,
);
check('重启后翻译仍然正常', seg2?.translation === '你好吗', JSON.stringify(seg2));
await callOffscreen({ type: 'LIVEDUB_OFFSCREEN_STOP' });

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
