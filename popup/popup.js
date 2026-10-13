import {
  getSettings,
  saveSettings,
  TARGET_LANGS,
  ASR_PROVIDERS,
  TRANSLATE_PROVIDERS,
  asrReadiness,
  applyPreset,
} from '../lib/settings.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let state = null;
let history = [];
let levelShown = 0;
let levelTarget = 0;

// ═══════════════ 初始化 ═══════════════

async function init() {
  settings = await getSettings();

  fillSelect($('targetLang'), TARGET_LANGS.map((l) => ({ value: l.id, label: l.label })), settings.translate.target);
  $('captureMode').classList.add('seg');
  $('delaySec').value = String(settings.capture?.delaySec ?? 3);
  $('delayVal').textContent = `${Number(settings.capture?.delaySec ?? 3).toFixed(1)}s`;
  setMode(currentMode());
  $('position').value = settings.ui.position;
  $('muteOriginal').checked = !!settings.audio.muteOriginal;
  $('showOriginal').checked = !!settings.ui.showOriginal;
  $('showDiag').checked = !!settings.ui.showDiag;
  $('fontSize').value = settings.ui.fontSize;
  $('fontSizeVal').textContent = settings.ui.fontSize;

  const asrLabel = ASR_PROVIDERS.find((p) => p.id === settings.asr.provider)?.label || settings.asr.provider;
  const trLabel = TRANSLATE_PROVIDERS.find((p) => p.id === settings.translate.provider)?.label || settings.translate.provider;
  $('providerInfo').textContent = `${asrLabel} · ${trLabel}`;
  $('verInfo').textContent = `v${chrome.runtime.getManifest().version}`;

  const ready = asrReadiness(settings);
  if (!ready.ok) {
    showWarn(`尚未配置识别服务：${ready.reason}。点右上角 ⚙ 完成配置后再开始。`);
  }

  // 语法糖：先本地渲染一次，再拉真实状态
  await refresh();
  bindEvents();
  requestAnimationFrame(tickLevel);
}

async function refresh() {
  const [st, hi] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'LIVEDUB_GET_STATE' }).catch(() => null),
    chrome.runtime.sendMessage({ type: 'LIVEDUB_GET_HISTORY' }).catch(() => null),
  ]);
  if (st?.state) state = st.state;
  if (hi?.history) history = hi.history;
  renderState();
  renderHistory();
}

function bindEvents() {
  $('toggleBtn').addEventListener('click', onToggle);
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  for (const btn of document.querySelectorAll('#captureMode .seg-btn')) {
    btn.addEventListener('click', async () => {
      setMode(btn.dataset.mode);
      await saveSettings(settings);
    });
  }

  const delay = $('delaySec');
  delay.addEventListener('input', () => {
    $('delayVal').textContent = `${Number(delay.value).toFixed(1)}s`;
    if (settings) settings.capture.delaySec = Number(delay.value);
  });
  delay.addEventListener('change', async () => {
    settings.capture.delaySec = Number(delay.value);
    await saveSettings(settings);
  });

  $('targetLang').addEventListener('change', async (e) => {
    settings.translate.target = e.target.value;
    await saveSettings(settings);
    await applyLive();
  });

  $('position').addEventListener('change', async (e) => {
    settings.ui.position = e.target.value;
    await saveSettings(settings);
    await applyLive();
  });

  $('muteOriginal').addEventListener('change', async (e) => {
    settings.audio.muteOriginal = e.target.checked;
    await saveSettings(settings);
    if (isActive()) {
      await chrome.runtime.sendMessage({ type: 'LIVEDUB_SET_MUTE', muted: e.target.checked }).catch(() => {});
    }
    await applyLive();
  });

  $('showOriginal').addEventListener('change', async (e) => {
    settings.ui.showOriginal = e.target.checked;
    await saveSettings(settings);
    await applyLive();
  });

  $('showDiag').addEventListener('change', async (e) => {
    settings.ui.showDiag = e.target.checked;
    await saveSettings(settings);
    await applyLive();
  });

  const fs = $('fontSize');
  fs.addEventListener('input', () => {
    $('fontSizeVal').textContent = fs.value;
    if (settings) settings.ui.fontSize = Number(fs.value);
  });
  fs.addEventListener('change', async () => {
    settings.ui.fontSize = Number(fs.value);
    await saveSettings(settings);
    await applyLive();
  });

  $('clearAll').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'LIVEDUB_CLEAR_HISTORY' }).catch(() => {});
    history = [];
    renderHistory();
  });

  $('copyAll').addEventListener('click', async () => {
    const text = history.map((h) => (h.translation ? `${h.translation}\n${h.original}` : h.original)).join('\n\n');
    if (!text) return;
    await navigator.clipboard.writeText(text).catch(() => {});
    $('copyAll').textContent = '已复制';
    setTimeout(() => ($('copyAll').textContent = '复制'), 1200);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'LIVEDUB_STATE' && msg.state) {
      state = msg.state;
      renderState();
    } else if (msg?.type === 'LIVEDUB_HISTORY' && Array.isArray(msg.entries)) {
      history = msg.entries;
      renderHistory();
    } else if (msg?.type === 'LIVEDUB_TOAST') {
      // info 是过程说明（比如"退化为扩展级消费"），不该用红色错误条吓人
      if (msg.level === 'info') showWarn(msg.message);
      else showError(msg.message);
    }
    return false;
  });
}

async function applyLive() {
  await chrome.runtime
    .sendMessage({ type: 'LIVEDUB_APPLY_SETTINGS', settings })
    .catch(() => {});
}

// ═══════════════ 行为 ═══════════════

function currentMode() {
  return settings?.capture?.mode === 'delayed' ? 'delayed' : 'overlay';
}

/** 分段控件：呈现方式决定"开始"按钮做什么，运行中改了要等下次开始才生效 */
function setMode(mode) {
  if (!settings.capture) settings.capture = {};
  settings.capture.mode = mode;
  for (const btn of document.querySelectorAll('#captureMode .seg-btn')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
  syncDelayRow();
}

function syncDelayRow() {
  const delayed = currentMode() === 'delayed';
  $('delayRow').hidden = !delayed;
  $('delayHint').hidden = !delayed;
  const pending = isActive() ? '（正在运行，改动下次开始生效）' : '';
  $('modeHint').textContent = delayed
    ? `另开一个播放页，画面推迟上面这个秒数。字幕与画面同时出现，而且可以用最准的定稿翻译。${pending}`
    : `字幕直接叠在你的页面上，零延迟；但字幕必然晚于画面 1–3 秒。${pending}`;
}

function isActive() {
  return state?.status === 'running' || state?.status === 'starting';
}

async function onToggle() {
  const btn = $('toggleBtn');
  btn.disabled = true;
  try {
    if (isActive()) {
      const res = await chrome.runtime.sendMessage({ type: 'LIVEDUB_STOP' });
      if (res?.state) state = res.state;
    } else {
      hideError();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const res = await chrome.runtime.sendMessage({ type: 'LIVEDUB_START', tabId: tab?.id });
      if (res?.state) state = res.state;
      if (res && res.ok === false) showError(res.error || '启动失败');
    }
  } catch (e) {
    showError(e?.message || String(e));
  } finally {
    btn.disabled = false;
    renderState();
    // 启动/停止后状态可能还在流转，稍后再拉一次
    setTimeout(refresh, 350);
    setTimeout(refresh, 1200);
  }
}

// ═══════════════ 渲染 ═══════════════

function renderState() {
  const st = state || { status: 'idle', segments: 0 };
  const pill = $('statusPill');
  const map = {
    idle: ['未运行', ''],
    starting: ['启动中', 'starting'],
    running: ['运行中', 'running'],
    stopping: ['停止中', 'stopping'],
    error: ['出错', 'error'],
  };
  const [label, cls] = map[st.status] || map.idle;
  pill.textContent = label;
  pill.className = `pill ${cls}`;

  $('brandDot').className = `dot ${st.status === 'running' ? 'live' : ''}`;
  $('tabTitle').textContent = st.tabTitle || (st.tabId ? `标签页 #${st.tabId}` : '选择一个有声音的标签页开始');

  const btn = $('toggleBtn');
  if (isActive()) {
    btn.textContent = '停止';
    btn.classList.add('stop');
  } else {
    btn.textContent = '开始同声传译';
    btn.classList.remove('stop');
  }

  const statusBits = [];
  if (st.asrStatus === 'connecting') statusBits.push('连接识别服务…');
  else if (st.asrStatus === 'connected') statusBits.push('识别已连接');
  else if (st.asrStatus === 'closed') statusBits.push('识别已断开');
  else if (st.asrStatus === 'engine-ready') statusBits.push('音频就绪');
  if (st.asrDetail) statusBits.push(st.asrDetail);
  if (st.startedAt && st.status === 'running') statusBits.push(fmtDuration(Date.now() - st.startedAt));
  $('asrInfo').textContent = statusBits.join(' · ') || '待机';
  $('segInfo').textContent = `${st.segments || 0} 句`;

  // 延迟拆成两截显示：识别滞后（结果落后真实声音多久）与翻译往返耗时。
  // 用户抱怨"慢"的时候，这两个数字能直接指出瓶颈在哪一段。
  // 没测出来的一侧显示「—」而不是整段消失，否则用户分不清"还没测到"和"这个功能没有"。
  const lagBits = [];
  if (st.status === 'running') {
    lagBits.push(Number.isFinite(st.lagMs) ? `识别 ${(st.lagMs / 1000).toFixed(1)}s` : '识别 —');
    lagBits.push(Number.isFinite(st.translateMs) ? `翻译 ${(st.translateMs / 1000).toFixed(2)}s` : '翻译 —');
  }
  $('lagInfo').textContent = lagBits.join(' · ');

  if (st.error) showError(st.error);
  else hideError();

  const slowAsr = Number.isFinite(st.lagMs) && st.lagMs > 1500;
  const slowTrans = Number.isFinite(st.translateMs) && st.translateMs > 2000;
  const interimOff = settings && settings.translate.provider !== 'none' && settings.translate.translateInterim === false;

  if (st.status === 'running' && interimOff) {
    // 这是"慢"最常见、也最容易被忽略的原因：关掉它之后译文只在句子**定稿**后出现，
    // 而识别服务什么时候给定稿由模型判断，说话人不停顿就可能等很久。
    showWarn('「也翻译中间结果」是关着的：译文要等句子定稿才出现，说话人不停顿时会等很久。这是"慢"最常见的原因。', {
      label: '一键套用「速度优先」',
      run: applySpeedPreset,
    });
  } else if (st.status === 'running' && st.lowAudio) {
    showWarn('当前音源电平很低，识别准确率会明显下降。可以调高该标签页/系统的音量，或到设置页开启「安静音源自动增益」。');
  } else if (st.status === 'running' && (slowAsr || slowTrans)) {
    const parts = [];
    if (slowAsr) parts.push(`识别滞后 ${(st.lagMs / 1000).toFixed(1)}s`);
    if (slowTrans) parts.push(`翻译往返 ${(st.translateMs / 1000).toFixed(1)}s`);
    const advice = slowTrans
      ? '翻译慢多半是服务商往返久：换成「Google 翻译」免 Key 通道最快，或把翻译上下文句数调小。'
      : '识别慢多半是网络到识别服务的距离，或用了 language=multi（会更慢）。到设置页把「音频语言」明确指定成实际语言试试。';
    showWarn(`${parts.join('、')} 偏大。${advice}`);
  } else if (settings && !asrReadiness(settings).ok) {
    showWarn(`尚未配置识别服务：${asrReadiness(settings).reason}。点右上角 ⚙ 完成配置后再开始。`);
  } else {
    hideWarn();
  }
}

/** 弹窗里的一键修复：套用「速度优先」预设并立即生效 */
async function applySpeedPreset() {
  applyPreset(settings, 'speed');
  await saveSettings(settings);
  await chrome.runtime
    .sendMessage({ type: 'LIVEDUB_APPLY_SETTINGS', settings })
    .catch(() => {});
  // 预设可能改到弹窗上暴露的控件，回写一遍
  $('targetLang').value = settings.translate.target;
  renderState();
}

function renderHistory() {
  const box = $('history');
  const items = history.slice(-40).reverse();
  if (!items.length) {
    box.innerHTML = '<div class="empty">开始后这里会实时滚动显示双语字幕</div>';
    return;
  }
  box.innerHTML = '';
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'item';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = it.translation || it.original;
    div.appendChild(t);
    if (it.translation && it.original && it.translation !== it.original) {
      const o = document.createElement('div');
      o.className = 'o';
      o.textContent = it.original;
      div.appendChild(o);
    }
    box.appendChild(div);
  }
}

function tickLevel() {
  const target = state?.status === 'running' ? Number(state.level || 0) : 0;
  levelTarget = Math.min(1, target * 3.2);
  levelShown += (levelTarget - levelShown) * 0.35;
  $('meterFill').style.width = `${Math.round(levelShown * 100)}%`;
  requestAnimationFrame(tickLevel);
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

function showError(msg) {
  const el = $('errorBanner');
  el.textContent = msg;
  el.hidden = false;
}
function hideError() {
  $('errorBanner').hidden = true;
}
function showWarn(msg, action) {
  $('warnText').textContent = msg;
  const btn = $('warnAction');
  if (action) {
    btn.textContent = action.label;
    btn.hidden = false;
    btn.onclick = () => {
      btn.disabled = true;
      Promise.resolve(action.run())
        .catch(() => {})
        .finally(() => {
          btn.disabled = false;
        });
    };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
  $('warnBanner').hidden = false;
}
function hideWarn() {
  $('warnBanner').hidden = true;
}

function fillSelect(sel, options, current) {
  sel.innerHTML = '';
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}

init().catch((e) => showError(e?.message || String(e)));
