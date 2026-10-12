// livedtranslate 页面字幕层（内容脚本）
//
// 设计要点：
//   · 整个 UI 放在 Shadow DOM 里，彻底隔离宿主页面的 CSS（很多视频站有非常激进的全局样式）
//   · 全屏时把宿主节点移动到 document.fullscreenElement 里，否则字幕会被全屏层盖住
//   · 内容脚本用经典脚本（非 module），保证 manifest 声明式注入和 scripting.executeScript 都能用

(function () {
  const MY_VERSION = extensionVersion();

  /**
   * 幂等 + 可接管。
   *
   * 原来用的是 `window.__livedubContentLoaded` 这个布尔标记，它有个致命问题：
   * 扩展一重新加载，已打开页面里的旧内容脚本就被废掉（context invalidated），
   * 但它在 window 上留下的标记还在。于是新脚本被注入后第一件事就是看到那个标记然后
   * 直接 return —— **页面上再也没有可用的字幕层，只能靠刷新页面恢复**。
   * 调试期间这个陷阱会让所有修复看起来都没生效。
   *
   * 现在改成按版本判断：同一版本重复注入才跳过；版本不同（说明扩展更新过）就接管，
   * 并清掉旧实例可能残留的宿主节点。
   */
  if (window.__livedubVersion === MY_VERSION) return;
  window.__livedubVersion = MY_VERSION;
  try {
    document.getElementById('livedub-overlay-root')?.remove();
  } catch {
    /* ignore */
  }

  // 无条件打一行版本号。这是"到底跑到哪个构建"的唯一可靠证据：
  // 打开任意页面按 F12，看到这一行就说明加载的是新代码。
  try {
    console.info(`[livedtranslate] 字幕层已加载 · v${MY_VERSION}`);
  } catch {
    /* ignore */
  }

  const DEFAULT_UI = {
    position: 'bottom',
    fontSize: 24,
    opacity: 0.86,
    showOriginal: true,
    historyLines: 2,
    hideAfterMs: 7000,
    bilingualOrder: 'translation-first',
    showDiag: true,
  };

  function extensionVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return '?';
    }
  }

  const CSS = `
    :host { all: initial; }
    .box {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      max-width: min(1120px, 90vw);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
                   "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
      transition: opacity .4s ease;
    }
    .box.hidden { opacity: 0; }
    .line {
      box-sizing: border-box;
      max-width: 100%;
      padding: .42em .85em;
      border-radius: .58em;
      background: var(--livedub-bg, rgba(8, 10, 14, .78));
      -webkit-backdrop-filter: blur(10px) saturate(1.25);
      backdrop-filter: blur(10px) saturate(1.25);
      box-shadow: 0 8px 28px rgba(0, 0, 0, .45), 0 0 0 1px rgba(255, 255, 255, .06) inset;
      color: #fff;
      text-align: center;
      line-height: 1.36;
      word-break: break-word;
      overflow-wrap: anywhere;
      display: flex;
      flex-direction: column;
      transition: opacity .25s ease, transform .25s ease;
    }
    .line.history { opacity: .42; transform: scale(.84); transform-origin: center bottom; }
    .line .tr { font-weight: 600; font-size: 1em; }
    .line .src { margin-top: .18em; font-size: .62em; font-weight: 400; color: #aab5c5; }
    .line .tr.pending::after {
      content: '';
      display: inline-block;
      width: .42em;
      height: .42em;
      margin-left: .45em;
      border-radius: 50%;
      background: #5ac8fa;
      vertical-align: middle;
      animation: livedub-pulse 1.1s ease-in-out infinite;
    }
    @keyframes livedub-pulse { 0%, 100% { opacity: .22; } 50% { opacity: 1; } }
    .diag {
      display: none;
      align-self: center;
      max-width: 100%;
      margin-bottom: .3em;
      padding: .3em .7em;
      border-radius: .45em;
      background: rgba(6, 10, 16, .86);
      border: 1px solid rgba(90, 200, 250, .35);
      color: #9fd8ff;
      font-size: .46em;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      line-height: 1.55;
      text-align: left;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .diag.on { display: block; }
    /* 延迟模式提示条：只占顶部一条，不挡页面内容。
       之前用的是全屏遮罩，太重了——用户回原页面干别的事都会被挡住。 */
    .notice {
      display: none;
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      align-items: center;
      gap: 10px;
      max-width: 92vw;
      padding: 8px 10px 8px 14px;
      border-radius: 10px;
      background: rgba(10, 14, 20, .93);
      border: 1px solid rgba(74, 158, 255, .45);
      box-shadow: 0 8px 28px rgba(0, 0, 0, .45);
      color: #dce8f5;
      font-size: 13px;
      line-height: 1.4;
      pointer-events: auto;
      z-index: 2;
    }
    .notice.on { display: flex; }
    .notice .txt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .notice .txt b { color: #8fc6ff; font-weight: 600; }
    .notice button {
      flex: 0 0 auto;
      background: rgba(74, 158, 255, .18);
      border: 1px solid rgba(74, 158, 255, .5);
      color: #cfe4ff;
      border-radius: 7px;
      padding: 5px 11px;
      font-size: 12.5px;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .notice button:hover { background: rgba(74, 158, 255, .3); }
    .notice button.x {
      background: transparent;
      border-color: transparent;
      color: #7d8896;
      padding: 5px 8px;
      font-size: 15px;
      line-height: 1;
    }
    .notice button.x:hover { color: #dce8f5; background: rgba(255, 255, 255, .08); }
  `;

  let ui = { ...DEFAULT_UI };
  let entries = []; // { id, original, translation, state, done, at }
  const nodes = new Map();
  let host = null;
  let root = null;
  let box = null;
  let diagEl = null;
  let diagBody = null;
  let diagLines = [];
  let noticeEl = null;
  let noticeTxt = null;
  let noticeDismissed = false;
  let noticeTimer = null;
  let hideTimer = null;
  let listenersBound = false;

  // ————————————————————— DOM 构建 —————————————————————

  function ensureHost() {
    if (host && host.isConnected && host.parentNode) return;
    if (host) host.remove();

    host = document.createElement('div');
    host.id = 'livedub-overlay-root';
    host.style.cssText =
      'all:initial !important;' +
      'position:fixed !important;' +
      'left:0 !important;right:0 !important;' +
      'z-index:2147483647 !important;' +
      'pointer-events:none !important;' +
      'display:flex !important;' +
      'justify-content:center !important;' +
      'margin:0 !important;padding:0 !important;border:0 !important;';

    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    box = document.createElement('div');
    box.className = 'box';
    root.appendChild(box);

    // 诊断面板放在字幕上方：它走的是和字幕完全相同的通道，
    // 所以"页面有、弹窗没有"就能直接断定问题出在状态通道上。
    diagEl = document.createElement('div');
    diagEl.className = 'diag';
    diagBody = document.createElement('div');
    diagEl.appendChild(diagBody);
    box.appendChild(diagEl);

    // 延迟模式提示条：画面和声音都搬到播放页去了，得让用户知道，
    // 但只用顶部一条，不挡页面内容，而且可以关掉。
    noticeEl = document.createElement('div');
    noticeEl.className = 'notice';
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = 'livedtranslate 延迟播放中 —— 画面已搬到播放窗口（按 tabCapture 的规则本页已静音）';
    noticeTxt = txt;
    const goBtn = document.createElement('button');
    goBtn.textContent = '切换到播放窗口';
    goBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'LIVEDUB_FOCUS_PLAYER' }).catch(() => {});
    });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'x';
    closeBtn.textContent = '✕';
    closeBtn.title = '关闭提示（不影响延迟播放）';
    closeBtn.addEventListener('click', () => {
      noticeDismissed = true;
      noticeEl.classList.remove('on');
    });
    noticeEl.appendChild(txt);
    noticeEl.appendChild(goBtn);
    noticeEl.appendChild(closeBtn);
    root.appendChild(noticeEl);

    // 面板第一行就是版本号：看不到这一行，就说明页面上的字幕层不是新构建。
    // 这里直接写 textContent，不能走 pushDiag（它会回头调 ensureHost，成环）。
    diagLines = [`livedtranslate v${extensionVersion()} · 字幕层就绪`];
    diagBody.textContent = diagLines.join('\n');

    mountHost();
    applyUi();
    bindGlobalListeners();
  }

  function mountHost() {
    if (!host) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
    let target = fs;
    if (target && target.tagName === 'VIDEO') {
      // 原生 <video> 全屏时，子节点不会被渲染。绝大多数播放器（YT/B站等）用的是容器
      // div 全屏，因此这里只是兜底提示。
      console.warn('[livedtranslate] 当前站点使用了原生 <video> 全屏，字幕无法叠加；请改用播放器的网页全屏或窗口模式。');
    }
    if (!target) target = document.documentElement || document.body;
    if (!target || host.parentNode === target) {
      applyUi();
      return;
    }
    try {
      target.appendChild(host);
    } catch {
      /* ignore */
    }
    applyUi();
  }

  function applyUi() {
    if (!host) return;
    const top = ui.position === 'top';
    host.style.setProperty('top', top ? '6vh' : 'auto', 'important');
    host.style.setProperty('bottom', top ? 'auto' : '7vh', 'important');
    if (box) {
      box.style.fontSize = `${Number(ui.fontSize) || DEFAULT_UI.fontSize}px`;
      box.style.setProperty('--livedub-bg', `rgba(8, 10, 14, ${Number(ui.opacity) || DEFAULT_UI.opacity})`);
    }
    if (diagEl) diagEl.classList.toggle('on', !!ui.showDiag);
  }

  function bindGlobalListeners() {
    if (listenersBound) return;
    listenersBound = true;
    document.addEventListener('fullscreenchange', mountHost, true);
    document.addEventListener('webkitfullscreenchange', mountHost, true);
    window.addEventListener('resize', applyUi, true);
  }

  // ————————————————————— 渲染 —————————————————————

  function buildLine() {
    const el = document.createElement('div');
    el.className = 'line';
    const tr = document.createElement('div');
    tr.className = 'tr';
    const src = document.createElement('div');
    src.className = 'src';
    el.appendChild(tr);
    el.appendChild(src);
    return el;
  }

  function updateLine(el, entry, isLive) {
    const trEl = el.querySelector('.tr');
    const srcEl = el.querySelector('.src');
    const hasTranslation = !!entry.translation;

    if (hasTranslation) {
      trEl.textContent = entry.translation;
      trEl.classList.remove('pending');
      srcEl.textContent = entry.original;
      srcEl.style.display = ui.showOriginal ? '' : 'none';
    } else {
      trEl.textContent = entry.original;
      trEl.classList.toggle('pending', !entry.done);
      srcEl.textContent = '';
      srcEl.style.display = 'none';
    }

    const orderOriginalFirst = ui.bilingualOrder === 'original-first';
    trEl.style.order = orderOriginalFirst ? '2' : '1';
    srcEl.style.order = orderOriginalFirst ? '1' : '2';

    el.classList.toggle('history', !isLive);
    el.style.transformOrigin = ui.position === 'top' ? 'center top' : 'center bottom';
  }

  function render() {
    ensureHost();
    if (!box) return;

    const maxHistory = Math.max(0, Math.min(6, Number(ui.historyLines) ?? DEFAULT_UI.historyLines));
    const keep = entries.slice(-(maxHistory + 1));
    const keepIds = new Set(keep.map((e) => e.id));

    for (const [id, el] of [...nodes]) {
      if (!keepIds.has(id)) {
        el.remove();
        nodes.delete(id);
      }
    }

    keep.forEach((entry, index) => {
      let el = nodes.get(entry.id);
      if (!el) {
        el = buildLine();
        nodes.set(entry.id, el);
        box.appendChild(el);
      }
      updateLine(el, entry, index === keep.length - 1);
    });
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    const last = entries[entries.length - 1];
    if (!last) return;
    if (!last.done) return; // 还在识别/翻译中，保持可见
    const ms = Number(ui.hideAfterMs);
    if (!ms || ms < 0) return;
    hideTimer = setTimeout(() => {
      if (box) box.classList.add('hidden');
    }, ms);
  }

  function showNow() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (box) box.classList.remove('hidden');
  }

  // ————————————————————— 消息处理 —————————————————————

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const type = msg?.type;
    if (type === 'LIVEDUB_PING') {
      // 把版本带回去：SW 靠它判断页面上的字幕层是不是当前构建
      sendResponse({ ok: true, version: MY_VERSION });
      return false;
    }
    if (type === 'LIVEDUB_SUBTITLE') {
      upsert(msg.segment);
      sendResponse({ ok: true });
      return false;
    }
    if (type === 'LIVEDUB_STYLE') {
      ui = { ...ui, ...(msg.ui || {}) };
      applyUi();
      render();
      sendResponse({ ok: true });
      return false;
    }
    if (type === 'LIVEDUB_RESET') {
      reset();
      sendResponse({ ok: true });
      return false;
    }
    if (type === 'LIVEDUB_DIAG') {
      pushDiag(msg.line, msg.log);
      sendResponse({ ok: true });
      return false;
    }
    if (type === 'LIVEDUB_COVER') {
      ensureHost();
      if (noticeEl) {
        if (msg.on) {
          // 用户手动关掉过就别再弹，否则很烦
          if (!noticeDismissed) {
            if (noticeTxt && Number.isFinite(Number(msg.delaySec))) {
              noticeTxt.textContent =
                `livedtranslate 延迟播放中（推迟 ${Number(msg.delaySec).toFixed(1)}s）—— ` +
                '画面已搬到播放窗口，本页按 tabCapture 的规则已静音';
            }
            noticeEl.classList.add('on');
            // 用户主要在播放窗口看，这条提示只在刚切回来的时候有用。
            // 不自动收掉会一直杵在页面顶上，所以给个自动消失 + 手动 ✕。
            if (noticeTimer) clearTimeout(noticeTimer);
            noticeTimer = setTimeout(() => {
              noticeTimer = null;
              noticeEl?.classList.remove('on');
            }, 12000);
          }
        } else {
          noticeEl.classList.remove('on');
          if (noticeTimer) clearTimeout(noticeTimer);
          noticeTimer = null;
          noticeDismissed = false; // 下一次开始时重新允许提示
        }
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  /** 诊断行：面板里保留最近几条，标记了 log 的同步打到页面控制台，方便复制粘贴上报 */
  function pushDiag(line, log) {
    ensureHost();
    const text = String(line || '').trim();
    if (!text) return;
    if (log) {
      try {
        console.info('[livedtranslate]', text);
      } catch {
        /* ignore */
      }
    }
    // 读数不变时不刷屏
    if (diagLines[diagLines.length - 1] === text) return;
    diagLines.push(text);
    if (diagLines.length > 8) diagLines.splice(0, diagLines.length - 8);
    if (diagBody) diagBody.textContent = diagLines.slice(-6).join('\n');
    showNow();
  }

  function upsert(segment) {
    if (!segment || !segment.id) return;
    ensureHost();
    showNow();
    const idx = entries.findIndex((e) => e.id === segment.id);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], ...segment };
    } else {
      entries.push({ ...segment, at: Date.now() });
      if (entries.length > 24) entries.splice(0, entries.length - 24);
    }
    render();
    scheduleHide();
  }

  function reset() {
    entries = [];
    diagLines = [];
    if (diagBody) diagBody.textContent = '';
    if (noticeEl) noticeEl.classList.remove('on');
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
    noticeDismissed = false;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    for (const [, el] of nodes) el.remove();
    nodes.clear();
    if (box) box.classList.remove('hidden');
  }
})();
