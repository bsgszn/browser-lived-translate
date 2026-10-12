// livedtranslate service worker：只做编排与状态管理。
// 真正的音频处理、ASR 长连接、翻译请求都在 offscreen document 里，
// 因为 MV3 的 service worker 会在空闲时被回收。

import { getSettings, asrReadiness } from '../lib/settings.js';

/**
 * ⚠️ 这三个键名里的 `livedub` **不是品牌名，别改成 `livedtranslate`。**
 * 它们是 storage 的键；改了会让已安装用户的运行状态对不上（旧键残留、新键空白），
 * 而用户永远看不到它们。改名的理由见 `lib/settings.js` 里 STORAGE_KEY 上方那段注释。
 */
const STATE_KEY = 'livedub.runtime';
const HISTORY_KEY = 'livedub.history';
const PLAYER_JOB_KEY = 'livedub.playerJob';
const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const PLAYER_PATH = 'player/player.html';

const IDLE_STATE = {
  status: 'idle',
  /** 'overlay' 或 'delayed'，仅 running 时有意义 */
  mode: null,
  tabId: null,
  playerTabId: null,
  tabTitle: '',
  tabUrl: '',
  startedAt: null,
  error: null,
  asrStatus: null,
  asrDetail: '',
  level: 0,
  lagMs: null,
  translateMs: null,
  lowAudio: false,
  segments: 0,
};

/** 判断"音源太轻"用的门槛与持续时间。注意 offscreen 上报的是**经过自动增益之后**的电平，
 *  所以这里低于门槛意味着连 +12dB 都拉不起来——那是真的没声音。 */
const QUIET_LEVEL = 0.012;
const QUIET_MS = 8000;
let quietSince = null;

let creatingOffscreen = null;
let historyBuffer = [];
let historyFlushTimer = null;

// ═══════════════════════════ 状态存取 ═══════════════════════════

async function getState() {
  const raw = await chrome.storage.session.get(STATE_KEY);
  return { ...IDLE_STATE, ...(raw?.[STATE_KEY] || {}) };
}

/**
 * 状态更新的串行队列。
 *
 * 这是个真踩过的坑：更新是「读 storage → 合并 → 写 storage」，中间隔着 await。
 * 而 LIVEDUB_LEVEL 每 250ms 就来一条、延迟读数也随时会到，两个并发的更新会各自
 * 读到同一份旧状态、再先后写回，后写的那个把先写进去的字段直接抹掉。
 * 实测后果：连续两条历史推送，句数只加到 1。
 * 串行化之后，同一时刻只有一次读-改-写在飞行中。
 *
 * mutator 可以是对象，也可以是 (cur) => patch，后者能在同一个原子步骤里做依赖当前状态的决定。
 */
let stateChain = Promise.resolve();

function updateState(mutator) {
  stateChain = stateChain
    .then(async () => {
      const cur = await getState();
      const patch = typeof mutator === 'function' ? await mutator(cur) : mutator;
      if (!patch) return cur;
      const next = { ...cur, ...patch };
      await chrome.storage.session.set({ [STATE_KEY]: next });
      broadcast({ type: 'LIVEDUB_STATE', state: next });
      return next;
    })
    .catch(() => {
      /* 单次更新失败不能把整条队列卡死 */
    });
  return stateChain;
}

function setState(patch) {
  return updateState(patch);
}

function broadcast(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {
    /* 没有监听方（popup 未打开）时正常报错，忽略 */
  });
}

async function getHistory() {
  const raw = await chrome.storage.session.get(HISTORY_KEY);
  return Array.isArray(raw?.[HISTORY_KEY]) ? raw[HISTORY_KEY] : [];
}

/**
 * 历史记录也走一条独立的串行队列。
 * 同样的道理：追加和回填译文都是「读数组 → 改 → 写回」，交错执行会丢条目。
 */
let historyChain = Promise.resolve();

function updateHistory(mutator) {
  historyChain = historyChain
    .then(async () => {
      const list = await getHistory();
      const next = await mutator(list);
      if (!next) return;
      const keep = (await getSettings()).history?.keep ?? 300;
      const trimmed = next.slice(-keep);
      await chrome.storage.session.set({ [HISTORY_KEY]: trimmed });
      broadcast({ type: 'LIVEDUB_HISTORY', entries: trimmed.slice(-20) });
    })
    .catch(() => {
      /* 单次失败不卡死队列 */
    });
  return historyChain;
}

async function appendHistory(entry) {
  historyBuffer.push(entry);
  if (historyFlushTimer) return;
  historyFlushTimer = setTimeout(() => {
    historyFlushTimer = null;
    const pending = historyBuffer;
    historyBuffer = [];
    if (!pending.length) return;
    background('合并历史', updateHistory((list) => [...list, ...pending]));
  }, 800);
}

async function updateHistoryTranslation(id, translation) {
  if (!id || !translation) return;
  await updateHistory((list) => {
    const item = list.find((e) => e.id === id);
    if (!item || item.translation === translation) return null;
    item.translation = translation;
    return list;
  });
}

// ═══════════════════════════ 消息入口 ═══════════════════════════

const HANDLED = new Set([
  'LIVEDUB_START',
  'LIVEDUB_STOP',
  'LIVEDUB_TOGGLE',
  'LIVEDUB_GET_STATE',
  'LIVEDUB_GET_HISTORY',
  'LIVEDUB_CLEAR_HISTORY',
  'LIVEDUB_SET_MUTE',
  'LIVEDUB_APPLY_SETTINGS',
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;
  if (!type) return false;

  if (HANDLED.has(type)) {
    (async () => {
      try {
        switch (type) {
          case 'LIVEDUB_START':
            sendResponse({ ok: true, state: await startCapture(msg.tabId) });
            break;
          case 'LIVEDUB_STOP':
            await stopCapture('user');
            sendResponse({ ok: true, state: await getState() });
            break;
          case 'LIVEDUB_TOGGLE': {
            const cur = await getState();
            if (cur.status === 'running' || cur.status === 'starting') {
              await stopCapture('user');
            } else {
              await startCapture(msg.tabId);
            }
            sendResponse({ ok: true, state: await getState() });
            break;
          }
          case 'LIVEDUB_GET_STATE':
            sendResponse({ ok: true, state: await getState() });
            break;
          case 'LIVEDUB_GET_HISTORY':
            sendResponse({ ok: true, history: await getHistory(), state: await getState() });
            break;
          case 'LIVEDUB_CLEAR_HISTORY':
            await chrome.storage.session.set({ [HISTORY_KEY]: [] });
            broadcast({ type: 'LIVEDUB_HISTORY', entries: [] });
            sendResponse({ ok: true });
            break;
          case 'LIVEDUB_SET_MUTE': {
            const cur = await getState();
            if (cur.status === 'running') {
              await sendToOffscreen({ type: 'LIVEDUB_SET_MUTE', muted: !!msg.muted });
            }
            sendResponse({ ok: true });
            break;
          }
          case 'LIVEDUB_APPLY_SETTINGS': {
            const cur = await getState();
            if (cur.status === 'running') {
              await sendToOffscreen({ type: 'LIVEDUB_APPLY_SETTINGS', settings: msg.settings });
            }
            // 没在采集时 offscreen 不存在，但字幕层的样式开关仍要能实时生效
            await relayToTab({ type: 'LIVEDUB_STYLE', ui: msg.settings?.ui });
            sendResponse({ ok: true });
            break;
          }
          default:
            sendResponse({ ok: false, error: 'unhandled' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  // offscreen → SW 的单向事件
  switch (type) {
    case 'LIVEDUB_HISTORY_PUSH':
      background('追加历史', appendHistory(msg.entry));
      background('累计句数', bumpSegments());
      return false;
    case 'LIVEDUB_EMIT':
      background('投递字幕', relayToTab(msg.payload, msg.tabId));
      return false;
    case 'LIVEDUB_DIAG':
      background('投递诊断', relayToTab({ type: 'LIVEDUB_DIAG', line: msg.line, log: !!msg.log }, msg.tabId));
      return false;
    case 'LIVEDUB_HISTORY_UPDATE':
      background('回填译文', updateHistoryTranslation(msg.id, msg.translation));
      return false;
    case 'LIVEDUB_LEVEL':
      background('电平', onLevel(msg.level));
      return false;
    case 'LIVEDUB_LATENCY': {
      const patch = {};
      if (Number.isFinite(msg.lagMs)) patch.lagMs = msg.lagMs;
      if (Number.isFinite(msg.translateMs)) patch.translateMs = msg.translateMs;
      if (Object.keys(patch).length) background('写状态', setState(patch));
      return false;
    }
    case 'LIVEDUB_ASR_STATUS':
      background('识别状态', setState({ asrStatus: msg.status, asrDetail: msg.detail || '' }));
      return false;
    case 'LIVEDUB_TRANSLATE_ERROR':
      background('翻译错误', setState({ error: `翻译失败：${msg.message}` }));
      return false;
    case 'LIVEDUB_CAPTURE_ERROR':
      background('识别错误', setState({ error: msg.message || '识别服务出错' }));
      broadcast({ type: 'LIVEDUB_TOAST', level: 'error', message: msg.message || '识别服务出错' });
      return false;
    case 'LIVEDUB_STREAM_ENDED':
      background('停止(流结束)', stopCapture('stream-ended'));
      return false;
    case 'LIVEDUB_PLAYER_READY':
      background('引擎就绪', setState({ asrStatus: 'engine-ready', asrDetail: '延迟画面' }));
      return false;
    case 'LIVEDUB_PLAYER_STOPPED':
      background('停止(播放页)', stopCapture(msg.reason || '播放页停止'));
      return false;
    case 'LIVEDUB_OPEN_GAME':
      // 游戏语音字幕板块已移除
      return false;
    case 'LIVEDUB_FOCUS_PLAYER':
      void (async () => {
        const cur = await getState();
        if (!cur.playerTabId) return;
        try {
          await chrome.tabs.update(cur.playerTabId, { active: true });
        } catch {
          /* ignore */
        }
      })();
      return false;
    default:
      return false;
  }
});

/** 句数累加必须把"读当前值"放进串行队列里，否则两条推送会各自读到旧值、都写 1 */
function bumpSegments() {
  return updateState((cur) => ({ segments: (cur.segments || 0) + 1 }));
}

/**
 * 音量既驱动弹窗的电平条，也用来判断"这个音源是不是轻得离谱"。
 * 识别服务对低电平很敏感，长时间过低时主动提示用户，比默默识别不准要好。
 * 判断依赖当前状态，所以放进 mutator 里，和状态更新在同一个原子步骤内完成。
 */
function onLevel(level) {
  const value = Number(level) || 0;
  return updateState((cur) => {
    const patch = { level: value };
    const running = cur.status === 'running';

    if (!running || value >= QUIET_LEVEL) {
      quietSince = null;
      if (cur.lowAudio) patch.lowAudio = false;
    } else if (quietSince === null) {
      quietSince = Date.now();
    } else if (!cur.lowAudio && Date.now() - quietSince > QUIET_MS) {
      patch.lowAudio = true;
    }
    return patch;
  });
}

// ═══════════════════════════ 采集生命周期 ═══════════════════════════

const BLOCKED_URL = /^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|moz-extension|edge-extension):/i;
const BLOCKED_HOST = /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i;

async function startCapture(explicitTabId) {
  const cur = await getState();
  if (cur.status === 'running' || cur.status === 'starting') {
    if (explicitTabId && explicitTabId !== cur.tabId) {
      await stopCapture('switch-tab');
    } else {
      return cur;
    }
  }

  const settings = await getSettings();
  const ready = asrReadiness(settings);
  if (!ready.ok) {
    await setState({ status: 'error', error: `${ready.reason}，请先在设置页配置。` });
    openOptions();
    return getState();
  }

  let tab;
  try {
    tab = explicitTabId ? await chrome.tabs.get(explicitTabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  } catch {
    tab = null;
  }
  if (!tab?.id) {
    await setState({ status: 'error', error: '找不到要捕获的标签页。' });
    return getState();
  }
  if (BLOCKED_URL.test(tab.url || '') || BLOCKED_HOST.test(tab.url || '')) {
    await setState({ status: 'error', error: '浏览器内部页面与应用商店页面无法捕获音频，请切换到普通网页（如视频网站）后再试。' });
    return getState();
  }

  // 延迟模式走完全不同的链路：不在原页面叠字幕，而是另开一个播放页接管画面与声音
  if (settings.capture?.mode === 'delayed') {
    return startDelayedCapture(tab, settings);
  }

  await setState({
    status: 'starting',
    tabId: tab.id,
    tabTitle: tab.title || '',
    tabUrl: tab.url || '',
    error: null,
    asrStatus: 'connecting',
    asrDetail: '',
    level: 0,
    lagMs: null,
    translateMs: null,
    lowAudio: false,
    segments: 0,
  });
  quietSince = null;

  try {
    await ensureOffscreen();
    await ensureContentScript(tab.id);
    // 让页面上的字幕层立刻套用当前样式开关（包括诊断面板）
    await relayToTab({ type: 'LIVEDUB_STYLE', ui: settings.ui }, tab.id);

    // 必须在 service worker 里取 streamId，再交给 offscreen 消费
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await sendToOffscreen({
      type: 'LIVEDUB_OFFSCREEN_START',
      streamId,
      tabId: tab.id,
      settings,
    });
    if (!res?.ok) throw new Error(res?.error || '音频引擎启动失败');

    await setState({ status: 'running', startedAt: Date.now() });
    chrome.action.setBadgeText({ tabId: tab.id, text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#e5484d' });
  } catch (e) {
    await closeOffscreen();
    await setState({ status: 'error', error: e?.message || String(e), tabId: null });
    await resetContentScript(tab.id);
  }
  return getState();
}

async function stopCapture(reason) {
  const cur = await getState();
  if (cur.status === 'idle' && !cur.tabId && !cur.playerTabId) return;

  if (cur.status !== 'idle') await setState({ status: 'stopping' });

  // 延迟模式：关掉播放页、清掉任务、把原页面的遮罩拿掉
  if (cur.playerTabId) {
    try {
      await chrome.tabs.remove(cur.playerTabId);
    } catch {
      /* 用户可能已经自己关了 */
    }
  }
  try {
    await chrome.storage.session.remove(PLAYER_JOB_KEY);
  } catch {
    /* ignore */
  }
  if (cur.mode === 'delayed' && cur.tabId) {
    await relayToTab({ type: 'LIVEDUB_COVER', on: false }, cur.tabId);
  }

  try {
    await sendToOffscreen({ type: 'LIVEDUB_OFFSCREEN_STOP' });
  } catch {
    /* ignore */
  }
  await closeOffscreen();
  if (cur.tabId) {
    await resetContentScript(cur.tabId);
    try {
      chrome.action.setBadgeText({ tabId: cur.tabId, text: '' });
    } catch {
      /* ignore */
    }
  }
  await setState({
    status: 'idle',
    mode: null,
    tabId: null,
    tabTitle: '',
    tabUrl: '',
    playerTabId: null,
    startedAt: null,
    level: 0,
    lagMs: null,
    translateMs: null,
    lowAudio: false,
    asrStatus: null,
    asrDetail: '',
    error: reason === 'stream-ended' ? '标签页音频已结束（页面关闭、跳转或停止了播放）。' : null,
  });
  quietSince = null;
}

// ═══════════════════════════ 延迟模式 ═══════════════════════════

/**
 * 延迟画面模式。
 *
 * 顺序很讲究：
 *   1. 直接把播放页开出来，拿到 tab id —— consumerTabId 必须是已存在的标签页
 *   2. 用这个 id 去取流
 *   3. 把任务写进 session storage
 *   4. 播放页自己轮询等待任务
 *
 * 为什么不让"先开 about:blank，取完流再导航"：
 *   tabCapture 会校验 consumerTabId 指向的标签页 url，about:blank 不是合法 URL，
 *   直接报 `Caller tab.url is not a valid URL.`。必须一开始就指向真正的播放页。
 *   代价是播放页可能比任务先加载完，所以它必须能等——见 player.js 的 waitForJob。
 *
 * 再兜一层：consumerTabId 在某些版本/场景下可能不被接受。
 * 不传它时，"流只能被发起调用的扩展使用"——播放页属于同一个扩展，照样能消费，
 * 所以失败时退化成不传再试一次。
 */
async function startDelayedCapture(tab, settings) {
  await setState({
    status: 'starting',
    mode: 'delayed',
    tabId: tab.id,
    tabTitle: tab.title || '',
    tabUrl: tab.url || '',
    error: null,
    asrStatus: 'connecting',
    asrDetail: '',
    level: 0,
    lagMs: null,
    translateMs: null,
    lowAudio: false,
    segments: 0,
  });
  quietSince = null;

  let playerTab = null;
  try {
    // 清掉可能残留的旧任务，免得播放页捡到上一次的
    await chrome.storage.session.remove(PLAYER_JOB_KEY);

    /**
     * ⚠️ **取流必须在建任何标签页之前。**
     *
     * `chrome.tabCapture.getMediaStreamId({targetTabId})` 要求扩展**在那个标签页上被调用过**
     * （activeTab 授权）。只要中间插进一次 `chrome.tabs.create({active:true})`，
     * 直播页就失去焦点、授权随之失效，报错就是那句很难懂的：
     *   「Extension has not been invoked for the current page (see activeTab permission).」
     *
     * 之前试过"先用 active:false 建页、拿到流再切前台"——那也不够稳：
     * 建标签页这个动作本身就可能让授权失效。所以现在是
     *   **先取流（此刻直播页还是活动页，授权一定有效）→ 再建播放页**。
     *
     * 代价：不能再指定 consumerTabId，流归属整个扩展（consumerMode='extension'）。
     * 播放页本来就有这条退化路径，所以没有功能损失。
     */
    let streamId = '';
    const consumerMode = 'extension';
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (e) {
      const raw = String(e?.message || e);
      // 把浏览器那句很难懂的话翻译成人能照做的提示
      const hint = /not been invoked|activeTab/i.test(raw)
        ? '浏览器要求扩展先在你**要翻译的那个页面**上被手动调用过。请切到直播/视频页面，按 Alt+Shift+S 或点扩展图标再试一次。'
        : /cannot be captured|chrome pages?/i.test(raw)
          ? '浏览器内部页面和扩展自己的页面无法采集音频，请切到普通网页（视频网站）再试。'
          : raw;
      throw new Error(hint);
    }

    playerTab = await chrome.tabs.create({ url: chrome.runtime.getURL(PLAYER_PATH), active: true });
    if (!playerTab?.id) throw new Error('无法创建播放标签页');

    await chrome.storage.session.set({
      [PLAYER_JOB_KEY]: {
        streamId,
        tabId: tab.id,
        tabTitle: tab.title || '',
        playerTabId: playerTab.id,
        consumerMode,
        createdAt: Date.now(),
      },
    });

    // 原页面盖一层提示：声音和画面都搬到播放页去了，别让用户对着静音画面发呆
    await ensureContentScript(tab.id);
    await relayToTab(
      { type: 'LIVEDUB_COVER', on: true, delaySec: settings.capture.delaySec, playerTabId: playerTab.id },
      tab.id,
    );

    chrome.action.setBadgeText({ tabId: tab.id, text: 'DLY' });
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#4a9eff' });

    await setState({ status: 'running', playerTabId: playerTab.id, startedAt: Date.now() });
  } catch (e) {
    // 把原因留在任务槽里，播放页还能把它显示出来——否则用户只看到一个空白标签页
    try {
      await chrome.storage.session.set({
        [PLAYER_JOB_KEY]: { error: e?.message || String(e), playerTabId: playerTab?.id ?? null, createdAt: Date.now() },
      });
    } catch {
      /* ignore */
    }
    await setState({
      status: 'error',
      mode: null,
      playerTabId: null,
      error:
        `${e?.message || e}。` +
        '延迟模式需要能开新标签页并取得标签页视频流；若页面是 DRM 保护内容、或浏览器禁止第二路捕获，就会失败——可以先用「字幕叠加」模式。',
    });
  }
  return getState();
}

function diagLog(line) {
  broadcast({ type: 'LIVEDUB_TOAST', level: 'info', message: line });
}

// ═══════════════════════════ 游戏语音字幕（已移除）═══════════════════════════
// 这里原来有 openGameWindow()：开一个独立窗口 + Document PiP，把系统声音的
// 字幕置顶浮在游戏画面上。整个板块已按需求删除，game/ 目录也一并删掉。
// 保留这个 case 分支只是为了让还在跑的旧弹窗页面不会报错。

// ═══════════════════════════ offscreen 管理 ═══════════════════════════

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: '捕获标签页音频进行实时语音识别，并把原声回放到扬声器。',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch {
    /* ignore */
  }
}

async function sendToOffscreen(payload) {
  const res = await chrome.runtime.sendMessage(payload).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  return res;
}

// ═══════════════════════════ 内容脚本 ═══════════════════════════

async function ensureContentScript(tabId) {
  const myVersion = chrome.runtime.getManifest().version;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'LIVEDUB_PING' });
    // 版本一致才算就绪。不一致说明扩展更新过、页面里还是旧的字幕层
    // （旧实例很可能已经随重载失效，但它在 window 上留的标记还在，会把新脚本挡在门外）。
    if (r?.ok && r.version === myVersion) return true;
  } catch {
    /* 还没注入，或者旧实例的 context 已经失效 */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ['content/content.js'] });
    return true;
  } catch {
    return false;
  }
}

async function resetContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'LIVEDUB_RESET' });
  } catch {
    /* ignore */
  }
}

/** offscreen 只负责算出字幕内容，实际投递统一走这里，避免依赖 offscreen 的 tabs API 权限边界 */
async function relayToTab(payload, tabIdHint) {
  if (!payload) return;
  // offscreen 会带上 tabId；只有拿不到时才回落到读 storage（字幕是热路径，能省一次就省一次）
  const tabId = tabIdHint || (await getState()).tabId;
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    /* 页面已关闭或尚未注入字幕层 */
  }
}

function openOptions() {
  try {
    chrome.runtime.openOptionsPage();
  } catch {
    /* ignore */
  }
}

// ═══════════════════════════ 后台任务的安全出口 ═══════════════════════════

/**
 * 发出去就不管的异步调用，统一从这里走。
 *
 * ⚠️ 这里踩过坑：SW 里到处是 `void someAsync(...)`，而**没有一处带 catch**。
 * 任何一处失败都会变成控制台里一句 `Uncaught (in promise): No tab with id: xxx` ——
 * 既不知道是谁、也不知道为什么，排查时只能靠猜。
 *
 * 现在每个后台任务都带名字，失败时打一行明确的日志，并留下 label 便于定位。
 */
function background(label, promise) {
  Promise.resolve(promise).catch((e) => {
    console.warn(`[livedtranslate] 后台任务「${label}」失败：${e?.message || e}`);
  });
}

// 兜底：真出现了没人接的拒绝，也要打出堆栈，而不是只留一句无头无尾的报错。
// 用 globalThis 的可选调用而不是 self.addEventListener —— 单测在 Node 里加载这个模块时
// 没有 self，直接写会让整个测试文件崩掉。
globalThis.addEventListener?.('unhandledrejection', (ev) => {
  console.warn('[livedtranslate] 未处理的后台拒绝：', ev?.reason?.stack || ev?.reason);
});

// ═══════════════════════════ 浏览器事件 ═══════════════════════════

/**
 * 事件监听器也是 async 的 —— 它们抛错同样会变成"未处理的后台拒绝"。
 * 统一包一层，失败时留下事件名字。
 */
function safeListener(label, fn) {
  return (...args) => {
    Promise.resolve(fn(...args)).catch((e) => {
      console.warn(`[livedtranslate] 事件「${label}」处理失败：${e?.message || e}`);
    });
  };
}

chrome.tabs.onRemoved.addListener(
  safeListener('标签页关闭', async (tabId) => {
    const cur = await getState();
    if (cur.playerTabId && cur.playerTabId === tabId) {
      await stopCapture('player-closed');
      return;
    }
    if (cur.tabId === tabId) await stopCapture('tab-closed');
  }),
);

chrome.tabs.onUpdated.addListener(
  safeListener('标签页更新', async (tabId, changeInfo) => {
    const cur = await getState();
    if (cur.tabId !== tabId || cur.status !== 'running') return;
    // 延迟模式下画面在播放页，原页面跳转不影响捕获，也不该重注入字幕层
    if (cur.mode === 'delayed') return;
    if (changeInfo.status === 'loading' && changeInfo.url) {
      await setState({ tabUrl: changeInfo.url });
    }
    if (changeInfo.status === 'complete') {
      // 页面刷新后内容脚本会被重新注入（manifest 声明式），这里只需补一次确保存在
      await ensureContentScript(tabId);
    }
  }),
);

chrome.commands?.onCommand.addListener(
  safeListener('快捷键', async (command) => {
    if (command !== 'toggle-capture') return;
    const cur = await getState();
    if (cur.status === 'running' || cur.status === 'starting') {
      await stopCapture('user');
    } else {
      await startCapture();
    }
  }),
);

chrome.runtime.onInstalled.addListener(
  safeListener('安装/更新', async (details) => {
    await chrome.storage.session.set({ [STATE_KEY]: IDLE_STATE });
    if (details.reason === 'install') openOptions();
  }),
);

chrome.runtime.onStartup.addListener(
  safeListener('浏览器启动', async () => {
    await chrome.storage.session.set({ [STATE_KEY]: IDLE_STATE });
  }),
);
