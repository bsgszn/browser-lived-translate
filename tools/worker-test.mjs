// service worker 测试：用桩 chrome.* 驱动 background/service-worker.js 的消息入口。
//
// 这个文件补的是一个真实的覆盖缺口：SW 是字幕与状态的中枢，但之前完全没有测试，
// 结果一个"跨 await 的读-改-写没有串行化"的竞态把 translateMs 一直冲掉。
//
//   node tools/worker-test.mjs

const listeners = () => ({ addListener() {}, removeListener() {} });

let failures = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────── 可注入延迟的存储桩 ───────────
// 真实的 chrome.storage 是异步的，而且每次延迟都不一样——这个"不按顺序完成"，
// 就是读-改-写竞态的根源。用固定种子的伪随机延迟，既能复现又保证可重复。
let storageDelayMs = 3;
let rngState = 20240607;
function jitter() {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return (rngState / 0x7fffffff) * storageDelayMs * 4;
}
function makeArea(map) {
  return {
    async get(key) {
      await sleep(jitter());
      if (key === null || key === undefined) return Object.fromEntries(map);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (map.has(k)) out[k] = clone(map.get(k));
      return out;
    },
    async set(obj) {
      await sleep(jitter());
      for (const [k, v] of Object.entries(obj)) map.set(k, clone(v));
    },
    async remove(key) {
      await sleep(jitter());
      map.delete(key);
    },
  };
}
function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

const sessionStore = new Map();
const localStore = new Map();
const broadcasts = [];
const tabMessages = [];
const createdTabs = [];
const updatedTabs = [];
const removedTabs = [];
const streamIdRequests = [];
const scriptInjections = [];
const createdWindows = [];
const updatedWindows = [];
let messageListener = null;
let tabsRemovedListener = null;
let badgeText = null;
let offscreenOpen = false;
let createdTabId = null;
let nextTabId = 500;
let rejectConsumerTabId = false;

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { messageListener = fn; } },
    onInstalled: listeners(),
    onStartup: listeners(),
    onConnect: listeners(),
    sendMessage: async (payload) => {
      broadcasts.push(clone(payload));
      // offscreen 会对 OFFSCREEN_START / OFFSCREEN_STOP 回一个 ok
      if (payload?.type === 'LIVEDUB_OFFSCREEN_START') return { ok: true, sampleRate: 16000 };
      if (payload?.type === 'LIVEDUB_OFFSCREEN_STOP') return { ok: true };
      return {};
    },
    getURL: (p) => `chrome-extension://test/${p}`,
    getManifest: () => ({ version: '1.1.0' }),
    getContexts: async () => (offscreenOpen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
    openOptionsPage() {},
  },
  storage: {
    session: makeArea(sessionStore),
    local: makeArea(localStore),
  },
  tabs: {
    get: async (id) => ({ id, url: 'https://example.com/live', title: '示例直播' }),
    query: async (q) => {
      // 带 url 过滤的查询是"游戏窗口是否已经开着"，测试里当作没开
      if (q?.url) return [];
      return [{ id: createdTabId, url: 'https://example.com/live', title: '示例直播' }];
    },
    create: async (opts) => {
      const tab = { id: nextTabId++, url: opts?.url || 'about:blank', active: !!opts?.active };
      createdTabs.push(tab);
      return tab;
    },
    update: async (tabId, props) => {
      updatedTabs.push({ tabId, props });
      return { id: tabId };
    },
    remove: async (tabId) => {
      removedTabs.push(tabId);
    },
    sendMessage: async (tabId, payload) => {
      tabMessages.push({ tabId, payload: clone(payload) });
      // 内容脚本必须回报版本号，否则 SW 会认为页面上的字幕层是旧构建
      if (payload?.type === 'LIVEDUB_PING') return { ok: true, version: '1.1.0' };
      return { ok: true };
    },
    onRemoved: { addListener: (fn) => { tabsRemovedListener = fn; } },
    onUpdated: listeners(),
  },
  tabCapture: {
    getMediaStreamId: async (opts) => {
      streamIdRequests.push(clone(opts));
      // 模拟 Chrome 的行为：consumerTabId 指向的标签页 url 不合法时直接拒绝
      if (rejectConsumerTabId && opts?.consumerTabId) {
        throw new Error('Caller tab.url is not a valid URL.');
      }
      return 'stream-id-123';
    },
  },
  offscreen: {
    createDocument: async () => { offscreenOpen = true; },
    closeDocument: async () => { offscreenOpen = false; },
  },
  scripting: {
    executeScript: async (opts) => {
      scriptInjections.push(clone(opts));
      return [];
    },
  },
  windows: {
    create: async (opts) => {
      createdWindows.push(clone(opts));
      return { id: 900, ...opts };
    },
    update: async (id, props) => {
      updatedWindows.push({ id, props });
      return { id };
    },
  },
  action: {
    setBadgeText: ({ text }) => { badgeText = text; },
    setBadgeBackgroundColor() {},
  },
  commands: { onCommand: listeners() },
};

// ─────────── 载入被测模块 ───────────
const settingsMod = await import('../lib/settings.js');
await import('../background/service-worker.js');

/** 直接给消息监听器发一条消息，等 sendResponse */
function send(msg, { awaitResponse = true } = {}) {
  return new Promise((resolve) => {
    if (!awaitResponse) {
      messageListener(msg, {}, () => {});
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => resolve({ __timeout: true }), 4000);
    messageListener(msg, {}, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

async function readState() {
  const res = await send({ type: 'LIVEDUB_GET_STATE' });
  return res?.state;
}

/**
 * 轮询直到状态满足条件。
 * 不能用"连续两次读到相同值"当作稳定判据：队列积压时状态本来就不变，
 * 会在更新真正落地之前就返回。必须等具体的目标值。
 */
async function waitFor(pred, maxMs = 8000) {
  const t0 = Date.now();
  let st = await readState();
  while (Date.now() - t0 < maxMs) {
    if (pred(st)) return st;
    await sleep(80);
    st = await readState();
  }
  return st;
}

function seedSettings(overrides = {}) {
  const s = JSON.parse(JSON.stringify(settingsMod.DEFAULT_SETTINGS));
  s.asr.deepgram.apiKey = 'dg-test-key';
  Object.assign(s, overrides);
  localStore.set(settingsMod.STORAGE_KEY, s);
  return s;
}

// ═══════════════════════════════════════════════════════════
console.log('\n[1] 基本装配');
check('注册了消息监听器', typeof messageListener === 'function');

await send({ type: 'LIVEDUB_CLEAR_HISTORY' });
seedSettings();
createdTabId = 7;

{
  const res = await send({ type: 'LIVEDUB_GET_STATE' });
  check('GET_STATE 有响应', res?.ok === true, JSON.stringify(res));
  check('初始状态是 idle', res?.state?.status === 'idle');
  check('初始状态带 translateMs 字段', 'translateMs' in (res?.state || {}));
}

// ═══════════════════════════════════════════════════════════
console.log('\n[2] 启动采集');
{
  // 没有 API Key 时必须拒绝并给出可读原因
  const bare = JSON.parse(JSON.stringify(settingsMod.DEFAULT_SETTINGS));
  bare.asr.deepgram.apiKey = '';
  localStore.set(settingsMod.STORAGE_KEY, bare);
  const bad = await send({ type: 'LIVEDUB_START', tabId: 7 });
  check('缺 API Key 时拒绝启动并给出原因', bad?.state?.status === 'error' && /API Key/.test(bad.state.error || ''), JSON.stringify(bad));

  seedSettings();
  const res = await send({ type: 'LIVEDUB_START', tabId: 7 });
  check('START 成功', res?.ok === true, JSON.stringify(res));
  check('状态变为 running', res?.state?.status === 'running', JSON.stringify(res?.state));
  check('记录了 tabId', res?.state?.tabId === 7);
  check('offscreen 已创建', offscreenOpen === true);
  check('设置了 REC 角标', badgeText === 'REC');
  check('向 offscreen 下发了 OFFSCREEN_START', broadcasts.some((b) => b.type === 'LIVEDUB_OFFSCREEN_START'));
  check('向 offscreen 下发了 streamId', broadcasts.some((b) => b.type === 'LIVEDUB_OFFSCREEN_START' && b.streamId === 'stream-id-123'));
}

// ═══════════════════════════════════════════════════════════
console.log('\n[3] 延迟读数在并发下不能丢（回归：读-改-写竞态）');
{
  // 真实场景：LIVEDUB_LEVEL 每 250ms 一条，延迟读数每来一次翻译就一条，
  // 两者都在做「读 state → 合并 → 写 state」。没有串行化就会互相覆盖。
  //
  // 判定不能用"最终值对不对"——那样会被最后一次写入侥幸掩盖。
  // 真正的不变量是**单调性**：一旦某个读数出现过，之后的任何一次状态广播都不该把它变回 null。
  // 用户看到的现象正是「有识别、没翻译」，也就是 translateMs 被反复打回 null。
  const seen = { lagMs: false, translateMs: false };
  const violations = { lagMs: [], translateMs: [] };
  const baseline = broadcasts.length;

  const rounds = 25;
  for (let i = 0; i < rounds; i++) {
    // 故意不 await：模拟两条消息几乎同时到达
    send({ type: 'LIVEDUB_LEVEL', level: 0.2 }, { awaitResponse: false });
    send({ type: 'LIVEDUB_LATENCY', lagMs: 420, translateMs: 260 }, { awaitResponse: false });
  }
  const burstState = await waitFor((s) => s?.lagMs === 420 && s?.translateMs === 260 && s?.level === 0.2);

  for (const b of broadcasts.slice(baseline)) {
    if (b?.type !== 'LIVEDUB_STATE' || !b.state) continue;
    for (const key of ['lagMs', 'translateMs']) {
      if (b.state[key] !== null && b.state[key] !== undefined) seen[key] = true;
      else if (seen[key]) violations[key].push(b.state);
    }
  }

  check(
    `并发 ${rounds * 2} 条消息后 lagMs 没有被回退成 null（违规 ${violations.lagMs.length} 次）`,
    violations.lagMs.length === 0,
    JSON.stringify(violations.lagMs[0]),
  );
  check(
    `并发 ${rounds * 2} 条消息后 translateMs 没有被回退成 null（违规 ${violations.translateMs.length} 次）——这正是弹窗看不到"翻译 X.Xs"的原因`,
    violations.translateMs.length === 0,
    JSON.stringify(violations.translateMs[0]),
  );

  const st = burstState;
  check(`最终 lagMs 仍是 420（${st?.lagMs}）`, st?.lagMs === 420, JSON.stringify(st));
  check(`最终 translateMs 仍是 260（${st?.translateMs}）`, st?.translateMs === 260, JSON.stringify(st));
  check(`同一次并发里 level 也保住了（${st?.level}）`, st?.level === 0.2, JSON.stringify(st));
}

// ═══════════════════════════════════════════════════════════
console.log('\n[4] 只有一项时不应把另一项清空');
{
  await send({ type: 'LIVEDUB_LATENCY', lagMs: null, translateMs: 300 }, { awaitResponse: false });
  const st = await waitFor((s) => s?.translateMs === 300);
  check('translateMs 更新为 300', st?.translateMs === 300, JSON.stringify(st));
  check('lagMs 仍是上一轮的 420（null 不应清空已有值）', st?.lagMs === 420, JSON.stringify(st));

  await send({ type: 'LIVEDUB_LATENCY', lagMs: 500, translateMs: null }, { awaitResponse: false });
  const st2 = await waitFor((s) => s?.lagMs === 500);
  check('lagMs 更新为 500', st2?.lagMs === 500, JSON.stringify(st2));
  check('translateMs 仍是 300', st2?.translateMs === 300, JSON.stringify(st2));
}

// ═══════════════════════════════════════════════════════════
console.log('\n[5] 字幕投递');
{
  tabMessages.length = 0;
  await send({ type: 'LIVEDUB_EMIT', tabId: 7, payload: { type: 'LIVEDUB_SUBTITLE', segment: { id: 's1' } } }, { awaitResponse: false });
  await sleep(60);
  check('按 offscreen 给的 tabId 转发字幕', tabMessages.some((m) => m.tabId === 7 && m.payload?.type === 'LIVEDUB_SUBTITLE'));

  tabMessages.length = 0;
  await send({ type: 'LIVEDUB_EMIT', payload: { type: 'LIVEDUB_STYLE', ui: {} } }, { awaitResponse: false });
  await sleep(60);
  check('没带 tabId 时回落到状态里的 tabId', tabMessages.some((m) => m.tabId === 7 && m.payload?.type === 'LIVEDUB_STYLE'));
}

// ═══════════════════════════════════════════════════════════
console.log('\n[6] 历史记录');
{
  await send({ type: 'LIVEDUB_CLEAR_HISTORY' });
  await send({ type: 'LIVEDUB_HISTORY_PUSH', entry: { id: 's1', original: 'hello', at: Date.now() } }, { awaitResponse: false });
  await send({ type: 'LIVEDUB_HISTORY_PUSH', entry: { id: 's2', original: 'world', at: Date.now() } }, { awaitResponse: false });
  await sleep(1300); // appendHistory 有 800ms 的合批窗口
  await send({ type: 'LIVEDUB_HISTORY_UPDATE', id: 's1', translation: '你好' }, { awaitResponse: false });
  await waitFor((s) => (s?.segments || 0) >= 2);
  await sleep(300);

  const res = await send({ type: 'LIVEDUB_GET_HISTORY' });
  const list = res?.history || [];
  check('两条历史都写进去了', list.length === 2, JSON.stringify(list));
  check('译文回填到对应条目', list.find((e) => e.id === 's1')?.translation === '你好', JSON.stringify(list));
  check('句数计数累加', (res?.state?.segments || 0) >= 2, String(res?.state?.segments));
}

// ═══════════════════════════════════════════════════════════
console.log('\n[7] 音源过低提示');
{
  // 连续低电平超过 QUIET_MS 才提示，且只在 running 时判断
  for (let i = 0; i < 8; i++) {
    await send({ type: 'LIVEDUB_LEVEL', level: 0.001 }, { awaitResponse: false });
    await sleep(30);
  }
  const st = await readState();
  check('短时间低电平不会立刻报警（需要持续 8 秒）', st?.lowAudio === false, JSON.stringify(st));

  await send({ type: 'LIVEDUB_LEVEL', level: 0.5 }, { awaitResponse: false });
  await sleep(300);
  const st2 = await readState();
  check('电平恢复后不报警', st2?.lowAudio === false);
}

// ═══════════════════════════════════════════════════════════
console.log('\n[8] 停止与异常');
{
  await send({ type: 'LIVEDUB_STREAM_ENDED' }, { awaitResponse: false });
  const st = await waitFor((s) => s?.status === 'idle');
  check('音频结束会自动停止采集', st?.status === 'idle', JSON.stringify(st));
  check('停止时给出可读原因', /已结束/.test(st?.error || ''), st?.error);
  check('offscreen 已关闭', offscreenOpen === false);
  check('清空了 REC 角标', badgeText === '');

  const stopped = await send({ type: 'LIVEDUB_GET_STATE' });
  check('停止后 lagMs / translateMs 归零', stopped?.state?.lagMs === null && stopped?.state?.translateMs === null, JSON.stringify(stopped?.state));
}

// ═══════════════════════════════════════════════════════════
console.log('\n[9] 延迟模式');
{
  const delayed = JSON.parse(JSON.stringify(settingsMod.DEFAULT_SETTINGS));
  delayed.asr.deepgram.apiKey = 'dg-test-key';
  delayed.capture.mode = 'delayed';
  delayed.capture.delaySec = 3;
  localStore.set(settingsMod.STORAGE_KEY, delayed);

  createdTabs.length = 0;
  updatedTabs.length = 0;
  removedTabs.length = 0;
  streamIdRequests.length = 0;
  tabMessages.length = 0;

  const res = await send({ type: 'LIVEDUB_START', tabId: 7 });
  check('延迟模式启动成功', res?.ok === true && res?.state?.status === 'running', JSON.stringify(res?.state));
  check('状态里记录了 mode=delayed', res?.state?.mode === 'delayed');
  check(
    '直接开播放页，不经过 about:blank（tabCapture 会拒绝不合法的 consumer url）',
    createdTabs.length === 1 && String(createdTabs[0].url).includes('player/player.html'),
    JSON.stringify(createdTabs),
  );
  // ⚠️ 取流必须排在新建任何标签页之前 —— 中间建页会让 activeTab 授权失效，
  // 报「Extension has not been invoked for the current page」。
  check(
    '取流时还没有播放页（先取流再建页，否则 activeTab 会失效）',
    streamIdRequests.length >= 1 && streamIdRequests[0].targetTabId === 7,
    JSON.stringify(streamIdRequests),
  );
  check('走扩展级消费（取流时播放页还不存在，没法指定 consumerTabId）', res?.state?.mode === 'delayed');
  // 建页在取流之后，所以这里不必再容忍 active:false
  check('直接开播放页，不经过 about:blank（tabCapture 会拒绝不合法的 consumer url）', createdTabs.length === 1);
  const navigations = updatedTabs.filter((t) => t.props && 'url' in t.props);
  check('不做事后导航（导航正是被 tabCapture 拒绝的旧方案）', navigations.length === 0, JSON.stringify(navigations));

  const playerId = createdTabs[0]?.id;
  // ⚠️ 这里曾经断言"取流时带上了 consumerTabId"。现在**故意不带**了：
  // 取流必须排在新建标签页之前（否则 activeTab 失效，报 "not been invoked"），
  // 而那时播放页还不存在，自然给不出 consumerTabId。
  check(
    '取流时只传 targetTabId（播放页还没建，给不出 consumerTabId）',
    streamIdRequests.length === 1 && streamIdRequests[0].targetTabId === 7 && !streamIdRequests[0].consumerTabId,
    JSON.stringify(streamIdRequests),
  );
  check('状态里记录了 playerTabId', res?.state?.playerTabId === playerId);

  const job = sessionStore.get('livedub.playerJob');
  check('任务写进了 session storage', !!job && job.streamId === 'stream-id-123' && job.playerTabId === playerId, JSON.stringify(job));
  check('任务里记录了消费方式，便于排查', job?.consumerMode === 'extension');

  check(
    '给原页面弹出延迟提示条（不是全屏遮罩——那会把整个页面挡住）',
    tabMessages.some((m) => m.tabId === 7 && m.payload?.type === 'LIVEDUB_COVER' && m.payload.on === true),
  );
  check('角标显示 DLY', badgeText === 'DLY');

  // 播放页报到
  await send({ type: 'LIVEDUB_PLAYER_READY' }, { awaitResponse: false });
  const ready = await waitFor((s) => s?.asrStatus === 'engine-ready');
  check('播放页报到后状态更新为已就绪', ready?.asrStatus === 'engine-ready', JSON.stringify(ready));

  // 用户直接关掉播放页 → 必须整体停止，不能留下一个没画面的"运行中"
  tabsRemovedListener?.(playerId);
  const afterClose = await waitFor((s) => s?.status === 'idle');
  check('关掉播放页后自动停止', afterClose?.status === 'idle', JSON.stringify(afterClose));
  check('停止时清掉了任务', !sessionStore.has('livedub.playerJob'));
  check(
    '停止时收掉了原页面的提示条',
    tabMessages.some((m) => m.tabId === 7 && m.payload?.type === 'LIVEDUB_COVER' && m.payload.on === false),
  );
  check('停止后 mode / playerTabId 归位', afterClose?.mode === null && afterClose?.playerTabId === null, JSON.stringify(afterClose));

  // 播放页自己报停止
  const res2 = await send({ type: 'LIVEDUB_START', tabId: 7 });
  check('可以再次进入延迟模式', res2?.state?.mode === 'delayed');
  const playerId2 = createdTabs[createdTabs.length - 1].id;
  await send({ type: 'LIVEDUB_PLAYER_STOPPED', reason: '测试停止' }, { awaitResponse: false });
  const afterStop = await waitFor((s) => s?.status === 'idle');
  check('播放页报停止后整体停止', afterStop?.status === 'idle');
  check('并且关掉了播放页标签', removedTabs.includes(playerId2), JSON.stringify(removedTabs));

  // ⚠️ 这里直接复现用户实际撞到的那句原话。
  // 它出现在屏幕上时完全看不出该怎么办，所以必须被翻成"切到直播页按 Alt+Shift+S"。
  // 成因：取流前新建了标签页 → 直播页失去 activeTab 授权。修法是取流排在建页之前。
  {
    const saved = chrome.tabCapture.getMediaStreamId;
    chrome.tabCapture.getMediaStreamId = async () => {
      throw new Error(
        'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.',
      );
    };
    streamIdRequests.length = 0;
    const res3 = await send({ type: 'LIVEDUB_START', tabId: 7 });
    chrome.tabCapture.getMediaStreamId = saved;
    check('activeTab 未授权时进入 error（不是静默失败）', res3?.state?.status === 'error', JSON.stringify(res3?.state));
    check(
      '把浏览器那句原话翻译成可照做的提示',
      /Alt\+Shift\+S/.test(String(res3?.state?.error || '')),
      String(res3?.state?.error),
    );
    await send({ type: 'LIVEDUB_STOP' });
  }

  // 彻底失败时：原因要留在任务槽里，播放页才能显示出来（否则用户只看到一个空白标签页）
  rejectConsumerTabId = true;
  sessionStore.delete('livedub.playerJob');
  const savedImpl = chrome.tabCapture.getMediaStreamId;
  chrome.tabCapture.getMediaStreamId = async () => {
    throw new Error('Cannot capture a tab with a protected content.');
  };
  const res4 = await send({ type: 'LIVEDUB_START', tabId: 7 });
  check('取流彻底失败时状态进入 error', res4?.state?.status === 'error', JSON.stringify(res4?.state));
  check('错误里带上了原始原因', /protected content/.test(res4?.state?.error || ''), res4?.state?.error);
  check(
    '失败原因留在任务槽里，播放页能显示（而不是留一个空白标签页）',
    /protected content/.test(sessionStore.get('livedub.playerJob')?.error || ''),
    JSON.stringify(sessionStore.get('livedub.playerJob')),
  );
  chrome.tabCapture.getMediaStreamId = savedImpl;
  rejectConsumerTabId = false;
  await chrome.storage.session.remove('livedub.playerJob');

  localStore.set(settingsMod.STORAGE_KEY, seedSettings());
}

console.log('\n[10] 游戏语音字幕板块已移除');
{
  createdWindows.length = 0;
  await send({ type: 'LIVEDUB_OPEN_GAME' }, { awaitResponse: false });
  await sleep(150);
  // 板块删掉了。保留这条消息分支只是为了让还开着的旧弹窗页面不报错 ——
  // 但绝不能再真的开窗口出来。
  check('收到旧消息也不再开窗口（板块已移除）', createdWindows.length === 0, JSON.stringify(createdWindows));
}

console.log(`\n${failures === 0 ? '全部通过 ✅' : `失败 ${failures} 项 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
