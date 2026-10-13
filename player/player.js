// livedtranslate 延迟同传播放页。
//
// 为什么需要单独一个页面：延迟画面**绝不能渲染在被捕获的标签页里**。
// 一旦渲染进去，tabCapture 会把我们自己的延迟画面也抓进去，形成无限回授。
// 所以这个页面本身就是「延迟显示端」，原标签页退化成纯信号源。
//
// 这一页同时承担四件事：
//   1. 消费 SW 指定的 tabCapture 流（consumerTabId 指向本页）
//   2. MediaRecorder + MSE 把画面推迟 D 秒再放
//   3. 用**未延迟的**原始音频跑识别与翻译（这才是提前量的来源）
//   4. 按音频时间戳把译文排期上屏，让它和延迟画面同时出现
//
// 因为画面被推迟了 D 秒，识别和翻译只要在 D 秒内完成就行，
// 所以这里**只用定稿翻译**——不需要那些边听边改的中间结果，译文质量更高也更稳。

import { getSettings, patchSettings, STORAGE_KEY } from '../lib/settings.js';
import { createAsrSession } from '../lib/asr/index.js';
import { translate, isTranslateEnabled } from '../lib/translate/index.js';
import { Resampler, float32ToInt16, rms } from '../lib/util.js';
import { UtteranceAccumulator } from '../lib/utterance.js';
import { PcmRing } from '../lib/pcm-ring.js';
import { createRefiner } from '../lib/asr/refine.js';
import { buildAnalysisChain, AgcController, setAgcProfile } from '../lib/audio-chain.js';
import {
  DelayedPlayback,
  SubtitleSchedule,
  isSupported,
  buildContextWindow,
  pickNextToTranslate,
  effectiveLeadMs,
  findStuckFlights,
  countInflight,
} from '../lib/delayed-player.js';

const $ = (id) => document.getElementById(id);
const JOB_KEY = 'livedub.playerJob';
const LEVEL_INTERVAL_MS = 250;
const CACHE_LIMIT = 400;

let settings = null;
let job = null;
let stream = null;
let ctx = null;
let playback = null;
let asr = null;
let resampler = null;
/** 滚动音频缓冲：延迟模式留着音频，才能拿它重新识别一遍 */
let pcmRing = null;
let refiner = null;
let schedule = new SubtitleSchedule();
/** 按上屏顺序保存的排期条目（和 schedule/rendered 共享同一批对象引用） */
const segs = [];
let inflight = 0;
const MAX_INFLIGHT = 2;
let translationCache = new Map();
let firstAudioAt = 0;
let lagEma = null;
let translateEma = null;
/** 上一次拿到识别结果（或开始收音频）的时刻；用来发现"连上了却一直没有结果" */
let lastResultAt = 0;
/** 最近一个分片的心跳，出问题时直接摆到画面上 */
let lastChunkNote = '';
/** 最近一次"收音频"心跳 */
let lastAudioNote = '';
/** 已经发出过多少次识别请求（每个分片一次），以及回来多少次 */
let asrRequestsSent = 0;
let asrRequestsDone = 0;
/** 上次刷新"没有识别结果"提示的时刻（要持续刷新，不能只报一次） */
let lastNoticeAt = 0;
/** 上次报告「缓冲落后实况多久」的时刻（每 10 秒报一次，免得刷屏） */
let lastRecLagAt = 0;
let actualDelayEma = null;
const agc = new AgcController();
let levelRms = 0;
let lastLevelAt = 0;
let running = false;
let pendingTranslate = new Map();
let finalController = null;

/**
 * 诊断日志。
 *
 * 保留量必须够大：排查"本地模型胡说八道"这类问题，要看的是**成对**的那几行
 * （流式给出 / 校正结果），而它们中间夹着别的输出。只留 7 行的话一眼就过去了，
 * 这正是之前发生的事。
 */
const DIAG_KEEP = 400; // 留在内存里的行数
const DIAG_SHOW = 60; // 面板上显示的行数（超出靠滚动看）

const diagLines = [];

function diag(line, toConsole) {
  const text = String(line);
  if (toConsole) {
    try {
      console.info('[livedtranslate]', text);
    } catch {
      /* ignore */
    }
  }
  // 连续重复的行不再刷屏，但计数器要让位给下一条真实日志
  if (diagLines[diagLines.length - 1] === text) return;
  diagLines.push(text);
  if (diagLines.length > DIAG_KEEP) diagLines.splice(0, diagLines.length - DIAG_KEEP);
  renderDiag();
}

function renderDiag() {
  const box = $('diag');
  const show = diagLines.slice(-DIAG_SHOW);
  const hidden = diagLines.length - show.length;
  box.textContent = (hidden > 0 ? `… 上面还有 ${hidden} 行（点「复制日志」拿全部）\n` : '') + show.join('\n');
  // 贴在底部：新日志永远可见，不用手动往下拖
  box.scrollTop = box.scrollHeight;
}

/**
 * 把**完整**日志复制走（不只是面板上显示的那几十行）。
 *
 * 排查问题时最需要的就是这个：面板再长也只能显示一屏，
 * 而"流式给出 / 校正结果"是成对出现的，中间夹着别的输出。
 */
async function copyDiag() {
  const text = diagLines.join('\n') || '(还没有日志)';
  try {
    await navigator.clipboard.writeText(text);
    diag(`已复制 ${diagLines.length} 行日志到剪贴板`, false);
    return;
  } catch {
    /* 剪贴板被拒时退回选中文本，用户按 Ctrl+C 就行 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    diag(ok ? `已复制 ${diagLines.length} 行日志` : '复制失败 · 请手动选中诊断面板里的文字', !ok);
  } catch (e) {
    diag(`复制失败 · ${e?.message || e}`, true);
  }
}

// ═══════════════════════════ 启动 ═══════════════════════════

async function boot() {
  $('verInfo').textContent = `v${chrome.runtime.getManifest().version}`;
  settings = await getSettings();
  applySettingsToUi();
  watchExternalSettings();

  // 版本号写进标签页标题：永远可见，不用开诊断面板也能确认跑的是哪一版
  try {
    document.title = `livedtranslate v${chrome.runtime.getManifest().version} · 延迟字幕`;
  } catch {
    /* ignore */
  }
  diag(`livedtranslate v${chrome.runtime.getManifest().version} · 播放页就绪`, true);

  // 播放页是"先于任务"被打开的：tabCapture 要求 consumerTabId 指向的标签页
  // 一开始就是合法 URL，所以不能先开 about:blank 再导航过来。代价就是这里要等。
  showOverlay('正在准备延迟画面…', '正在等待采集任务。', '');
  job = await waitForJob();

  if (!job) {
    showOverlay(
      '没有收到采集任务',
      '请回到视频页面，点扩展图标 → 呈现方式选「延迟画面」→ 开始同声传译。',
      '',
    );
    return;
  }
  if (job.error) {
    showOverlay('采集失败', '这一步的失败原因通常能直接定位问题。', job.error);
    diag(`采集失败 · ${job.error}`, true);
    return;
  }
  if (!job.streamId) {
    showOverlay('任务里没有流 ID', '请回到视频页面重新开始一次。', '');
    return;
  }

  $('srcInfo').textContent = job.tabTitle ? `来源：${job.tabTitle}` : `来源标签页 #${job.tabId}`;
  diag(`取得任务 · 消费方式 ${job.consumerMode || 'tab'}`, true);

  if (!isSupported()) {
    showOverlay('浏览器不支持延迟播放', '需要 MediaRecorder 与 MediaSource（Chrome 116+ 均可）。', '');
    return;
  }

  try {
    await startCapture();
  } catch (e) {
    showOverlay('启动失败', '下面的原因通常可以直接定位问题。', e?.message || String(e));
    diag(`启动失败 · ${e?.message || e}`, true);
    /**
     * ⚠️ 必须清理，不能只报错。
     *
     * `startCapture()` 在 getUserMedia 成功之后还有多个会抛错的点
     * （播放页建缓冲、音频引擎、识别连接）。一旦在那里失败而不清理：
     *   ① `stream` 的 track 不 stop → **源标签页保持静音**（tabCapture 的固有行为就是静音原页面），
     *      用户会以为"这扩展把我网页的声音搞坏了"，而且唯一的恢复办法是自己关掉播放页
     *   ② MediaSource / objectUrl / video.src 泄漏
     *   ③ 若已经 recorder.start()，MediaRecorder 会在后台**继续编码 4K**
     *   ④ 两个定时器继续跑
     * 用户看到的是屏幕正中一句报错，完全不知道背景里还在烧 CPU。
     */
    try {
      stopAll('启动失败');
    } catch (cleanupErr) {
      diag(`启动失败后的清理也出错了 · ${cleanupErr?.message || cleanupErr}`, true);
    }
  }
}

/**
 * 轮询等待属于自己的任务。
 * 比对 playerTabId 是为了躲开上一次会话残留的旧任务。
 */
async function waitForJob(timeoutMs = 12000) {
  let myTabId = null;
  try {
    const me = await chrome.tabs.getCurrent();
    myTabId = me?.id ?? null;
  } catch {
    /* 拿不到就退化为接受任意任务 */
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await chrome.storage.session.get(JOB_KEY);
    const candidate = raw?.[JOB_KEY];
    if (candidate && (candidate.error || candidate.streamId)) {
      if (!myTabId || candidate.playerTabId === myTabId) return candidate;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

async function startCapture() {
  showOverlay('正在取得标签页画面…', '浏览器会同时把原标签页静音——这是 tabCapture 的固有行为，声音改由本页播放。', '');
  diag('正在取得标签页流…', true);

  /**
   * 采集帧率上限。0 = 不限制。不显式给的话 Chrome 默认常常只给 30fps。
   *
   * ⚠️ **必须钳一个下限 —— 压得太低会让画面和声音一起没有。**
   *
   * 踩过的坑（用户实测）:填 `5` → 黑屏 + 无声 + 字幕正常。
   * 机理:录制分片是 250ms 一片，5fps 时一片里只有约 1.25 帧 →
   * 编码器 GOP 被拉长 → **第一个分片里没有关键帧** → SourceBuffer 有数据、
   * `buffered` 也在涨，但**解不出任何一帧** → `<video>` 卡住不推进 →
   * 画面黑、声音也没有（声音来自这个元素的音轨），而字幕走独立管线、照常工作。
   *
   * 所以低于下限一律按下限走，**并且不报错**（用户填的是"上限"，钳上去是安全方向）。
   * 12 这个值的依据:分片 250ms 要拿到关键帧，帧间隔不能长到让一片里连一个 I 帧都没有；
   * 实测 5 必坏、45 正常，取 12 留了足够余量，同时远低于常见的 24/30/60 源帧率，
   * 不会影响任何正常来源。
   */
  const MIN_MAX_FRAME_RATE = 12;
  const rawMaxFrameRate = Number(settings.capture.maxFrameRate ?? 60) || 0;
  // 0 = 用户明确要不限制，尊重它；>0 但太小 → 钳到下限
  const maxFrameRate = rawMaxFrameRate > 0 ? Math.max(MIN_MAX_FRAME_RATE, rawMaxFrameRate) : 0;
  if (rawMaxFrameRate > 0 && rawMaxFrameRate < MIN_MAX_FRAME_RATE) {
    diag(
      `采集帧率上限 ${rawMaxFrameRate} 太低（会让分片里没有关键帧、画面和声音都出不来），` +
        `已按 ${MIN_MAX_FRAME_RATE} 走`,
      true,
    );
  }

  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: job.streamId,
        /**
         * ⚠️ 必须显式给帧率上限。
         *
         * 不设的话 Chrome 按默认给，实测拿到的是 30fps —— 而源本身如果是 60fps，
         * 就等于**白丢一半的帧**，运动画面看着发顿。这是上限（不是强制值），
         * 源只有 30fps 时不会有任何副作用。
         */
        ...(maxFrameRate > 0 ? { maxFrameRate } : {}),
      },
    },
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: job.streamId,
      },
    },
  });

  const vtrack = stream.getVideoTracks()[0];
  const atrack = stream.getAudioTracks()[0];
  if (!vtrack) throw new Error('没有拿到视频轨：该标签页可能没有画面，或内容是 DRM 保护的。');
  if (!atrack) throw new Error('没有拿到音频轨：该标签页当前没有声音输出。');
  atrack.onended = () => stopAll('来源标签页的音频已结束');
  vtrack.onended = () => stopAll('来源标签页的画面已结束');

  const vs = vtrack.getSettings();
  diag(
    `已取得流 · 视频 ${vs.width || '?'}×${vs.height || '?'}${vs.frameRate ? `@${Math.round(vs.frameRate)}` : ''}` +
      `${maxFrameRate ? `（上限 ${maxFrameRate}）` : ''}`,
    true,
  );

  // —— 延迟画面用的流：可以降分辨率 ——
  //
  // 这块画面是被 MediaRecorder **重新编码**一遍的，4K 的软件编码非常吃 CPU，
  // 而本地 Whisper 也在抢 CPU —— 两者一撞，画面就每隔几秒顿一下。
  // 实测证据：缓冲一直是满的（前方 6.7s）、见底 0 次，所以不是网络/缓冲的问题。
  // 延迟画面本来就是用来读字幕的辅助画面，降到 1080p 完全够看。
  let recordStream = stream;
  const maxHeight = Number(settings.capture.delayMaxHeight) || 0;
  if (maxHeight > 0 && (vtrack.getSettings().height || 0) > maxHeight) {
    try {
      const scaled = stream.clone();
      const st = scaled.getVideoTracks()[0];
      const s = st.getSettings();
      const w = Math.round(((s.width || 1920) * maxHeight) / (s.height || 1080));
      await st.applyConstraints({ width: w, height: maxHeight });
      recordStream = scaled;
      diag(`延迟画面已降到 ${w}×${maxHeight}（原 ${s.width}×${s.height}）· 减轻重编码负担`, true);
    } catch (e) {
      diag(`延迟画面降分辨率失败，按原样编码 · ${e.message || e}`, true);
    }
  }

  // —— 延迟画面 ——
  playback = new DelayedPlayback($('video'), {
    delaySec: Number(settings.capture.delaySec) || 2.5,
    // 0 / 未设 = 按实际画面尺寸自动估（4K 自动给到 20~40 Mbps）。
    // ⚠️ 以前写死 4 Mbps，4K 下运动画面会糊 —— 码率不够时编码器只能丢细节。
    bitsPerSecond: Number(settings.capture.delayBitsPerSecond) || 0,
    quality: settings.capture.delayQuality || 'high',
    smoothRate: settings.capture.smoothRate !== false,
    onStatus: (s) => {
      if (s.phase === 'playing') diag(`延迟播放已就绪 · 目标 ${s.delaySec}s`, true);
      // 编码格式很关键：H.264 一般是硬件编码，VP9/VP8 往往是软件编码（4K 下极重）
      if (s.phase === 'recording') {
        const hw = /avc1|h264/i.test(s.mimeType || '');
        diag(`录制格式 · ${s.mimeType || '默认'}${hw ? '（H.264，通常硬件编码）' : '（VP8/VP9，很可能是软件编码，4K 下吃紧）'}`, true);
        // 码率直接决定运动画面糊不糊，必须能一眼看到
        if (s.bitrateNote) diag(`视频码率 · ${s.bitrateNote}`, true);
      }
      if (s.phase === 'append-error') diag(`缓冲写入失败 · ${s.message}`, true);
      // 配额溢出后自救成功了 —— 要让用户知道"卡了一下但恢复了"
      if (s.phase === 'quota-recovered') diag('缓冲配额溢出 · 已清理并重试成功', true);
      /**
       * 延迟涨太多，跳过了一段把延迟硬拉回目标。
       * 这是"保命"动作：不做的话延迟会一路涨到撞穿 MSE 配额、播放头卡死
       * （实测涨到 21 秒、readyState 2、见底 5 次）。所以画面跳一下是**故意的**。
       */
      if (s.phase === 'resync') {
        diag(
          `延迟涨到 ${(s.aheadSec || 0).toFixed(1)}s，已跳到目标 ${playback?.delaySec ?? ''}s` +
            `（跳过 ${(s.skippedSec || 0).toFixed(1)}s 画面 —— 不跳的话会一路卡死）`,
          true,
        );
      }
      if (s.phase === 'play-blocked') {
        // 扩展打开的标签页本身没有用户手势，带声音的自动播放可能被浏览器拒绝。
        // 不能默默重试，必须给一个点击入口。
        diag(`自动播放被拒 · ${s.message}`, true);
        showOverlay(
          '需要点一下才能开始播放',
          '这个标签页是扩展程序打开的，浏览器要求用户手势才允许播放带声音的视频。点下面的按钮即可。',
          '',
          {
            label: '开始播放',
            run: async () => {
              const ok = await playback?.resume();
              if (ok) hideOverlay();
            },
          },
        );
      }
      /**
       * ⚠️ 缓冲在涨、却解不出任何一帧。
       *
       * 触发条件（实测）:采集帧率上限压得太低（如 5）→ 分片里没有关键帧；
       * 或者**源画面长时间静止** → 合成器不产新帧。两者是同一个根因:
       * `buffered` 在涨，但没有可解码的帧 → `<video>` 卡住不推进 →
       * **画面黑 + 声音也没有**（声音来自这个元素的音轨），而字幕照常 ——
       * 也就是那条「只有字幕没画面没声音」。
       *
       * 必须说出来，否则用户只能看到一个黑屏、完全不知道该查什么。
       * ⚠️ 说清"这是采不到可解码的帧"，而不是"扩展坏了"。
       */
      if (s.phase === 'no-decodable-frame') {
        diag(
          `缓冲已有 ${(s.bufferedSec || 0).toFixed(1)}s，但解不出帧` +
            `（readyState ${s.readyState}，等了 ${((s.waitedMs || 0) / 1000).toFixed(1)}s）`,
          true,
        );
        showOverlay(
          '收到了数据，但解不出画面',
          `已经缓冲 ${(s.bufferedSec || 0).toFixed(1)} 秒，可是解码器一帧都解不出来（readyState ${s.readyState}）。`,
          '常见原因：① 采集帧率上限设得太低（分片里没有关键帧）；'
            + '② 来源画面长时间静止（合成器不产新帧）。'
            + '把「采集帧率上限」改回 30 或 60、或让来源画面动起来再试。',
        );
      }
    },
  });
  diag('正在建立媒体缓冲…', true);
  await playback.start(recordStream);
  diag('媒体缓冲已建立', true);

  // —— 识别（用未延迟的原始音频）——
  await startAudioEngine(atrack);

  $('dot').classList.add('live');
  running = true;
  requestAnimationFrame(tickUi);
  pumpSubtitles();
  pumpTranslation();

  const startedAt = Date.now();
  /** 「还没收到画面数据」那段文字 —— 带上实时读数，好让下一个遇到的人看出数字到底动没动 */
  const overlayNoDataBody = () => {
    const ahead = Number.isFinite(playback?.bufferAheadSec) ? `${playback.bufferAheadSec.toFixed(1)}s` : '—';
    const total = playback?.totalFrames || 0;
    const dropped = playback?.droppedFrames || 0;
    const stalls = playback?.stallCount || 0;
    const waited = Math.round((Date.now() - startedAt) / 1000);
    return (
      `已等 ${waited} 秒 · 缓冲 ${ahead} · 收到 ${total} 帧（掉 ${dropped}） · 见底 ${stalls} 次。` +
      '通常是来源画面静止、或那个标签页没有画面输出 —— 让它动起来试试。'
    );
  };
  let noDataShownAt = 0;

  /**
   * ⚠️ 这个轮询是**收遮罩的唯一出口**，它必须一直活到画面真的动起来为止。
   *
   * 收遮罩的条件只有「画面真的在动」（`!video.paused`），只凭 `actualDelaySec` 是不够的 ——
   * 播放页是扩展打开的标签页，没有用户手势，带声音的 `play()` 会被自动播放策略拒绝
   * （`_notePlayBlocked` 会发 `play-blocked`，上面那段显示"需要点一下才能开始播放"）。
   * **而那时缓冲照样在涨、`actualLagSec` 照样算得出来、`actualDelaySec` 照样非 null**，
   * 于是这个 interval 会在 300ms 内把那个遮罩收掉 ——
   * 用户看到的就是**黑屏 + 字幕正常 + 零提示**，根本不知道该点一下。
   *
   * 唯一的例外是「被自动播放策略拒绝」：那时只有用户点按钮能恢复，
   * 所以停止轮询、把遮罩留给那个按钮，别把它刷掉。
   *
   * 另外：如果当前显示的是「还没收到画面数据…」，每 2 秒刷新一次读数 ——
   * 让用户看到「缓冲 / 帧数」到底在不在动，而不是盯着一组冻结的数字。
   */
  const waitPlaying = setInterval(() => {
    const v = $('video');
    if (!v.paused && playback?.actualDelaySec !== null && playback?.actualDelaySec !== undefined) {
      clearInterval(waitPlaying);
      hideOverlay();
      return;
    }
    if (playback?.playBlocked) {
      clearInterval(waitPlaying);
      return;
    }
    if (noDataShownAt && Date.now() - noDataShownAt > 2000) {
      noDataShownAt = Date.now();
      showOverlay('还没收到画面数据…', overlayNoDataBody(), '');
    }
  }, 300);

  setTimeout(() => {
    /**
     * ⚠️⚠️ 这里**绝对不能** `clearInterval(waitPlaying)`。
     *
     * 踩过的坑：原来这里写的是「15 秒到了就停掉那个轮询，并且只有 locked/playBlocked 才收遮罩」。
     * 于是源画面静止时会显示「还没收到画面数据…」，**而用户一旦让它动起来、
     * 数据开始流动、画面真的出来了，那个遮罩就永远没人收** ——
     * 它把画面永久挡住，而且它**没有按钮**（按钮只在 play-blocked 时才有），
     * 用户唯一的出路是关掉播放页。**比原来的黑屏更糟。**
     *
     * 正确语义：「没数据」这个提示只是一个**临时说明**，必须能在数据到来时自动让位。
     * 所以轮询留着，收遮罩的判据统一交给上面 `waitPlaying` 里那一处。
     *
     * 为什么不是 `if (!playback?.playBlocked)`：`playBlocked` 只表示"play() 被拒了"，
     * 而「压根没走到播放」（缓冲从没填够）时它同样是 false —— 那种情况必须给提示。
     * 实测：源画面静止 → tabCapture 一帧都不给（`缓冲 前方 0.0s · 掉帧 0/0 · 输入电平 0.0000`）
     * → `bufferedEnd()` 一直是 null → `_tick()` 早早 return → `locked` 从没置真 →
     * `play()` 压根没被调用 → 遮罩被无条件收掉，用户只看到黑屏。
     */
    if (playback?.locked || playback?.playBlocked) {
      hideOverlay();
      return;
    }
    noDataShownAt = Date.now();
    showOverlay('还没收到画面数据…', overlayNoDataBody(), '');
  }, 15000);

  void chrome.runtime
    .sendMessage({ type: 'LIVEDUB_PLAYER_READY', tabId: job.tabId, playerTabId: job.playerTabId })
    .catch(() => {});
}

async function startAudioEngine(audioTrack) {
  // 只做分析、不回放：声音来自延迟画面里的音轨。
  ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
  }
  diag(`AudioContext ${ctx.sampleRate}Hz · ${ctx.state}`, true);

  const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));

  const silentSink = ctx.createGain();
  silentSink.gain.value = 0;
  silentSink.connect(ctx.destination);

  // 必须先加载 worklet 模块，否则 new AudioWorkletNode 会抛
  // "AudioWorklet does not have a valid AudioWorkletGlobalScope"
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/pcm-worklet.js'));
  diag('音频处理模块已加载', true);

  const worklet = new AudioWorkletNode(ctx, 'livedub-pcm', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { blockSize: 1024 },
  });

  asr = createAsrSession(settings, handleAsrEvent);
  resampler = new Resampler(ctx.sampleRate, asr.sampleRate);

  // 延迟模式的价值在于"音频还留着"——留住了才能拿它重新识别一遍
  pcmRing = new PcmRing({ sampleRate: asr.sampleRate, seconds: 90 });
  refiner = createRefiner(settings, { onNote: (m) => diag(`重识别 · ${m}`, true) });
  // 分片模式（whisper-chunked）的收句信号是"下一个分片是静音"，
  // 所以要等一整个分片才来 —— 看门狗必须比 chunkSeconds 长，
  // 否则它会把每一片都强行收句，正好抵消掉"按静音断句"。
  if (asr.streaming === false) {
    const chunkSec = Math.max(1, Number(settings.asr?.whisperChunked?.chunkSeconds) || 5);
    utterances.setWatchdogMs(chunkSec * 1000 + 1500);
    diag(`分片断句 · 每片 ${chunkSec}s，静音才收句（看门狗 ${chunkSec + 1.5}s）`, false);
  }

  diag(
    refiner.available
      ? `识别校正已就绪 · ${refiner.provider} · ${refiner.model}${refineEnabled() ? '' : '（未启用）'}`
      : `识别校正不可用 · ${refiner.reason}`,
    true,
  );

  // 分片识别 + 同一家的重识别 = 同一个模型把同一段音频听两遍。
  // 这时校正的主要价值是"边界补齐"（两个 5 秒硬切之间的词被切掉，校正带 padding 能捞回来），
  // 不是模型变强了。说清楚，免得以为是两套不同的东西。
  if (refiner.available && refineEnabled() && asr.streaming === false && refiner.provider === 'whisper') {
    diag('提示：分片识别与识别校正用的是同一个本地模型 —— 校正是把同一段音频再听一遍，主要价值是补齐被硬切掉的边界', true);
  }

  setAgcProfile(settings.capture?.agcProfile);
  const analysis = buildAnalysisChain(ctx, source, asr.sampleRate);
  analysis.output.connect(worklet);
  worklet.connect(silentSink);

  worklet.port.onmessage = (ev) => {
    if (!running || !asr) return;
    const frame = new Float32Array(ev.data);
    const frameRms = rms(float32ToInt16(frame));
    levelRms = frameRms;

    const now = performance.now();
    if (settings.audio?.autoGain !== false) {
      const next = agc.update(frameRms, now);
      if (next !== null) {
        try {
          analysis.agc.gain.setTargetAtTime(next, ctx.currentTime, 0.25);
        } catch {
          analysis.agc.gain.value = next;
        }
      }
    }

    const resampled = resampler.process(frame);
    if (resampled.length) {
      if (!firstAudioAt) firstAudioAt = Date.now();
      const pcm = float32ToInt16(resampled);
      // 同一份 PCM 既喂流式识别（定时间轴），也存进环形缓冲（供事后重识别）
      pcmRing?.push(pcm);
      asr.push(pcm);
    }
  };

  await asr.start();
  diag(`识别已连接 · ${asr.sampleRate / 1000}kHz`, true);
}

// ═══════════════════════════ ASR → 翻译 → 排期 ═══════════════════════════

function handleAsrEvent(ev) {
  // ⚠️ status 事件**不能**被 running 挡掉。
  //
  // 适配器的启动阶段（加载模型、跑自检）发生在 `running = true` **之前** ——
  // 也就是 `await asr.start()` 那一行里。而那时候发出的恰恰是最关键的信息：
  // "模型加载失败""自检没通过""连上了、阈值多少"。
  // 以前这些全被下面那行 `if (!running) return` 吞掉，症状就是
  // **启动阶段一片安静，出问题只能看到"一直没有结果"**。
  if (ev.type === 'status') {
    if (ev.status === 'closed') diag('识别连接已断开', true);
    // 连接阶段的细节别丢 —— 里面带着"用的是哪个模型、阈值多少"这类关键信息
    else if ((ev.status === 'connecting' || ev.status === 'connected') && ev.detail) {
      diag(`${ev.status === 'connecting' ? '识别连接中' : '识别就绪'} · ${ev.detail}`, true);
    }
    // 适配器自己在启动阶段判定失败（比如 VAD 自检不过），要当错误报出来
    else if (ev.status === 'error' && ev.detail) {
      diag(`识别不可用 · ${ev.detail}`, true);
      warn(`识别不可用：${ev.detail}`);
    }
    // 收音频的心跳（适配器收到多少）
    else if (ev.status === 'audio' && ev.detail) {
      lastAudioNote = ev.detail;
      diag(`收音频 · ${ev.detail}`, false);
    }
    // 分片处理完的结果
    else if (ev.status === 'chunk' && ev.detail) {
      lastChunkNote = ev.detail;
      asrRequestsDone += 1;
      diag(`分片 · ${ev.detail}`, false);
    }
    // VAD 的读数心跳 —— 只是读数，不能算进「识别请求回来了几次」
    else if (ev.status === 'vad' && ev.detail) diag(`VAD · ${ev.detail}`, false);
    // 分片送去识别（每个分片发一次请求）
    else if (ev.status === 'recognizing') asrRequestsSent += 1;
    return;
  }

  if (!running) return;
  if (ev.type === 'error') {
    diag(`识别出错 · ${ev.message}`, true);
    /**
     * ⚠️ 「本地服务没在跑？」这句提示**只对本地 Whisper 成立**。
     *
     * 实测踩过：用户用阿里云百炼（云端）识别报了 404 模型名不对，
     * 提示却让他去查**本地服务地址** —— 他根本没配本地服务，方向完全错了。
     * 所以按识别服务判断：只有走本地 Whisper 的那两个才给这个提示。
     */
    const provider = settings?.asr?.provider;
    const isLocal = provider === 'vad' || provider === 'whisper-chunked';
    const hint = isLocal ? '\n（本地服务没在跑？看设置页那一栏的服务地址）' : '';
    // 直接进诊断面板（不再有画面横幅）
    warn(`识别出错：${ev.message}${hint}`);
    return;
  }
  if (ev.type === 'partial') {
    noteAsrLatency(ev);
    return; // 画面延迟了，中间结果对不上时间轴，不用它上屏
  }
  if (ev.type === 'final') {
    if (asr?.streaming === false) noteAsrLatency(ev);
    lastResultAt = Date.now();
    // 只累积，不立刻上屏 —— 一次说话中间会有很多个 is_final
    const done = utterances.addFinal(ev);
    if (done) scheduleUtterance(done);
    return;
  }
  if (ev.type === 'utteranceEnd') {
    const done = utterances.endUtterance(ev);
    if (done) scheduleUtterance(done);
  }
}

function noteAsrLatency(ev) {
  if (!firstAudioAt) return;
  const start = Number(ev?.start);
  const duration = Number(ev?.duration);
  if (!Number.isFinite(start) || !Number.isFinite(duration)) return;
  const behind = (Date.now() - firstAudioAt) / 1000 - (start + duration);
  if (!Number.isFinite(behind)) return;
  const lagMs = Math.max(0, Math.min(20000, behind * 1000));
  lagEma = lagEma === null ? lagMs : lagEma + (lagMs - lagEma) * 0.3;
}

/**
 * 把 ASR 的 is_final 分片累积成「一次完整的说话」。
 *
 * 一次说话中间 Deepgram 会吐很多个 is_final，每个都上屏的话长句会变成一串碎片。
 * 判定逻辑在 lib/utterance.js（有单测），这里只负责接线。
 */
const utterances = new UtteranceAccumulator({ maxSpanSec: 15, watchdogMs: 3000 });

/**
 * 一整句到齐了：**只排期，不立刻翻译**。
 *
 * 这是延迟模式相对叠加模式最大的质量来源。画面推迟了 D 秒，我们可以等到临上屏之前
 * 再翻——那时这句话的**后文**也已经识别出来了，指代、术语、语气都能对上。
 * 定稿就翻等于把这段预算直接扔掉。
 *
 * 上屏时刻 = 这句**开口**的时刻 + D —— 也就是画面正好播到他张嘴的那一帧。
 * （不是"说完 + D"：那样字幕要等画面播完整句、再补等一个 D，就成了"人都快说完了才上"。）
 */
function scheduleUtterance(u) {
  const text = String(u?.text || '').trim();
  if (!text) return;

  const id = `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const timing = { start: u.start, duration: u.duration };
  const at = schedule.push(
    { id, original: text, translation: '' },
    timing,
    firstAudioAt || Date.now(),
    currentDelayMs(),
    Number(settings.capture.syncOffsetMs) || 0,
  );

  // 拿住排期条目的引用：译文回来时要能直接改到它，或者改到已经上屏的那一份
  const item = schedule.items[schedule.items.length - 1];
  if (item) {
    item.arrivedAt = Date.now();
    segs.push(item);
    if (segs.length > 40) segs.shift();
  }

  // ⚠️ 这里用**目标延迟**而不是 EMA 实测值，而且不调用 currentDelayMs()。
  // 那个函数有副作用（刷 EMA），在诊断里顺手调它会污染排期用的那个指数平均。
  const delayForDiagSec = Number(settings.capture.delaySec) || 2.5;
  const asrLagSec = delayForDiagSec - (at - Date.now()) / 1000;
  diag(
    `整句上屏 · ${((at - Date.now()) / 1000).toFixed(1)}s 后 · ${text.length} 字 · ${u.reason}` +
      ` · 识别滞后 ${asrLagSec.toFixed(1)}s${asrLagSec > delayForDiagSec ? ' ⚠ 超过延迟，必然迟到' : ''}`,
    asrLagSec > delayForDiagSec,
  );

  // 立刻开始重识别：它不需要后文，音频在收句的那一刻就齐了。
  // 而翻译要等到临上屏才做（那时才有后文），所以这段时间足够跑完一趟重识别。
  if (item && refineEnabled() && refiner?.available) {
    void refineItem(item, u);
  }
}

/** 识别校正开着没（默认关：它会让每段多一次请求，没配本地服务的人不该被默认拖累） */
function refineEnabled() {
  return settings?.asr?.refine?.enabled === true;
}

/**
 * 把这一段音频拿去重新识别，只替换文本 —— **时间轴一个字都不动**。
 *
 * 所以它失败、超时、退避中、或者没配，都只是"没拿到那份加成"，
 * 不会让字幕迟到、错位或消失。
 */
async function refineItem(item, u) {
  const start = Number(u?.start);
  const duration = Number(u?.duration);
  if (!pcmRing || !Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return;

  // 前后各留 0.25s：正好切在音节中间会让重识别丢掉开头或结尾
  const pcm = pcmRing.sliceBySeconds(start, start + duration, 0.25);
  if (!pcm.length) return;

  const t0 = Date.now();
  const p = refiner
    .refine(pcm, pcmRing.sampleRate)
    .then((res) => {
      const refined = String(res?.text || '').trim();
      const conf = Number.isFinite(res?.logprob) ? ` · 置信 ${res.logprob.toFixed(2)}` : '';

      // ⚠️ ok=false 时**必须沿用流式文本**。本地模型听错、或者干脆在编的时候，
      // 无条件覆盖会把 Deepgram 本来听对的也一起盖掉 —— 那比不做校正还差。
      if (!res?.ok) {
        item.refineDone = true;
        diag(`识别校正弃用 · ${Date.now() - t0}ms · ${res?.reason || '结果不可信'}（沿用流式文本）`, true);
        return;
      }
      if (!refined || refined === item.original) {
        item.refineDone = true;
        diag(`识别校正 · ${Date.now() - t0}ms · 与流式一致${conf}`, false);
        return;
      }
      // 覆盖 original：下游的上下文、翻译、显示都会自动用上更准的文本
      if (item.translated || item.inFlight) {
        // 已经按流式文本开翻了 —— 再改 original 会让"原文"和"译文"对不上
        item.refineDone = true;
        diag(`识别校正 · ${Date.now() - t0}ms · 翻译已开始，不改了`, false);
        return;
      }
      item.streamOriginal = item.original;
      item.original = refined;
      item.refineDone = true;
      diag(`识别校正 · ${Date.now() - t0}ms · ${refined.length} 字${conf}`, true);
      // ⚠️ 用词要准：分片识别（whisper-chunked）不是"流式"。
      // 说成"流式给出"会让人以为两行来自两个不同的服务 —— 实际上可能都是同一个本地模型。
      diag(`  ${asr?.streaming === false ? '分片给出' : '流式给出'}：${item.streamOriginal}`, false);
      diag(`  校正结果：${refined}`, false);
    });

  // 交给翻译泵去等（而且只在时间够的时候等），见 translateSegment
  item.refinePromise = p;
  await p;
}

/** 兜底：不管排期怎么算，一段话最多等这么久就必须开翻 */
const MAX_WAIT_MS = 4000;
/**
 * 开翻之前至少给翻译留这么多时间。
 *
 * 识别校正是"加成"，不是义务：如果等它会让翻译连这点时间都没有，
 * 就该拿流式文本先翻 —— 否则校正把字幕推得更晚，反而更糟。
 */
const MIN_TRANSLATE_MS = 600;
/** 在飞超过这么久就强制回收——只增不减的在飞计数会让翻译永久停摆 */
const STUCK_MS = 25000;

/**
 * 临上屏前的翻译泵。
 *
 * 调度判断本身放在 lib/delayed-player.js（pickNextToTranslate / findStuckFlights），
 * 有单测——因为这里踩过一个很贵的坑：
 *
 *   请求挂住不返回 → 在飞计数只增不减 → 攒够上限后整个泵永久停摆。
 *   现象正是"前几句有翻译，后面全没了"。
 *
 * 翻译时机是固定规则（见 lib/delayed-player.js 的 TRANSLATE_WINDOW_MS）：
 * 上屏前 0.7 秒开始翻，实测翻译更慢就自动往前让路。没有旋钮。
 */
function pumpTranslation() {
  // 先排下一轮：万一下面抛了异常，循环也不会就此永远停掉
  setTimeout(pumpTranslation, 150);
  if (!running) return;

  try {
    const now = Date.now();

    // 自愈：以实际在飞的条目为准重算计数。
    // 这个计数器只要漏还一份，翻译泵就会永久停摆——所以绝不能盲信它。
    const actual = countInflight(segs);
    if (actual !== inflight) {
      diag(`在飞计数自愈 · ${inflight} → ${actual}`, true);
      inflight = actual;
    }

    // 看门狗：强制回收卡住的在飞请求，否则后面全都不会再翻
    const stuck = findStuckFlights(segs, now, STUCK_MS);
    for (const s of stuck) {
      s.inFlight = false;
      s.startedAt = 0;
      s.translated = true; // 不重试，免得再挂一次
    }
    if (stuck.length) {
      diag(`翻译卡住超过 ${STUCK_MS / 1000}s · 释放 ${stuck.length} 条，否则后面全都不会翻`, true);
      inflight = countInflight(segs);
    }

    const index = pickNextToTranslate(segs, {
      now,
      // 固定规则：上屏前 TRANSLATE_WINDOW_MS 开始翻译；实测翻译更慢就自动往前让路。
      // 没有旋钮 —— 这个值不该让用户去权衡。
      leadMs: effectiveLeadMs(translateEma),
      inflight,
      maxInflight: MAX_INFLIGHT,
      maxWaitMs: MAX_WAIT_MS,
    });
    if (index >= 0) void translateSegment(segs[index]);
  } catch (e) {
    // 泵本身出问题也必须让用户看见，不能静默地什么都不翻
    diag(`翻译泵异常 · ${e?.message || e}`, true);
  }
}

async function translateSegment(seg) {
  seg.inFlight = true;
  seg.startedAt = Date.now();
  inflight += 1;
  const t0 = Date.now();

  try {
    if (!isTranslateEnabled(settings)) return;

    // 识别校正还没跑完就等一下 —— **但只在时间还够的时候等**。
    //
    // 校正只是"加成"，不该把字幕推到截止之后。原来这里无条件 await，
    // 而校正实测要 300~1100ms：长句本来就超预算，再等它就雪上加霜。
    // 预算不够就直接用流式文本开翻（那时 refineItem 也不会再覆盖文本了）。
    if (seg.refinePromise && !seg.refineDone) {
      const slack = seg.at - Date.now() - MIN_TRANSLATE_MS;
      if (slack > 0) {
        await Promise.race([
          seg.refinePromise.catch(() => {}),
          new Promise((r) => setTimeout(r, slack)),
        ]);
      }
      if (!seg.refineDone) diag('校正来不及 · 先用流式文本开翻', true);
    }

    const context = buildContext(seg);
    diag(`翻译开始 · 后文 ${seg.ctxForward || 0} 句 · ${settings.translate.provider}`, true);

    const key = `${settings.translate.target}|${seg.original}`;
    const hit = translationCache.get(key);
    let out;

    if (hit !== undefined) {
      // 同一句话在直播里会重复出现，直接复用。
      // 这里必须有一行日志——否则"翻译开始"之后什么都没有，看起来就像卡死了。
      out = hit;
      diag(`翻译命中缓存 · ${seg.original.length} 字`, false);
    } else {
      const controller = new AbortController();
      finalController = controller;
      try {
        out = await translate(seg.original, settings, {
          context,
          signal: controller.signal,
          review: true,
          onNote: (note) => diag(`术语表 · ${note}`, true),
        });
        translateEma =
          translateEma === null ? Date.now() - t0 : translateEma + (Date.now() - t0 - translateEma) * 0.3;
        const cost = Date.now() - t0;
        const late = Date.now() - seg.at;
        diag(
          late > 0
            ? `翻译完成 · ${cost}ms · **迟到 ${late}ms**（窗口只有 ${Math.max(0, seg.at - t0)}ms，把「画面延迟」调大）`
            : `翻译完成 · ${cost}ms · 赶上了（余量 ${-late}ms）`,
          late > 0,
        );
        // 只缓存成功的：把失败也缓存住，同一句话就永远不会再重试
        if (out) {
          translationCache.set(key, out);
          if (translationCache.size > CACHE_LIMIT) translationCache.delete(translationCache.keys().next().value);
        }
      } finally {
        if (finalController === controller) finalController = null;
      }
    }

    if (out) {
      seg.translation = out;
      // 还没上屏 → 上屏时自带译文；已经上屏 → 直接替换那一条
      if (rendered.has(seg.id)) renderSubs();
    }
  } catch (e) {
    diag(`翻译失败 · ${Date.now() - t0}ms · ${e?.message || e}`, true);
  } finally {
    // 必须无条件归位。原来这一步写在正常路径末尾，只要请求挂住一次，
    // 在飞计数就永久少还一份，攒够上限后翻译彻底停摆。
    seg.inFlight = false;
    seg.startedAt = 0;
    seg.translated = true;
    inflight = Math.max(0, inflight - 1);
  }
}

/**
 * 上下文 = 前两句 + 后两句（实现在 lib/delayed-player.js，有单测）。
 * 「后文」是延迟模式独有的：立刻翻译的话，这些内容此刻还没被识别出来。
 */
function buildContext(seg) {
  const i = segs.indexOf(seg);
  const { text, forward } = buildContextWindow(segs, i, { back: 2, forward: 2 });
  seg.ctxForward = forward;
  return text;
}

/** 排期用的延迟值：优先用实测的（平滑后），拿不到就退回目标值 */
function currentDelayMs() {
  const target = (Number(settings.capture.delaySec) || 2.5) * 1000;
  const actual = playback?.actualDelaySec;
  if (!Number.isFinite(actual) || actual <= 0) return target + recorderLagMs();
  // ⚠️ 必须把「录音/编码滞后」加进来 —— 这是字幕恒偏早的根因。
  //
  //   actualDelaySec = bufferedEnd − currentTime
  //   recorderLag    = (现在 − 开始录音) − bufferedEnd
  //   ─────────────────────────────────────────────────
  //   画面离实况的真实距离 = actualDelaySec + recorderLag
  //
  // 只用 actualDelaySec 排期的话，字幕会恒定偏早 recorderLag 那么多。
  // 实测（H.264/MP4 录制、4K 源）：约 1.0~1.4 秒，而且会缓慢漂移 ——
  // 所以拿同步微调这个固定旋钮是抵不掉的，必须动态补上。
  const ms = actual * 1000 + recorderLagMs();
  actualDelayEma = actualDelayEma === null ? ms : actualDelayEma + (ms - actualDelayEma) * 0.2;
  return actualDelayEma;
}

/**
 * 缓冲末尾落后实况多少毫秒。未知时给 0（宁可不动，也不要瞎补）。
 *
 * 夹在 0~2500ms：这是**排期**用的量，离谱的值比不补更糟。
 * 注意诊断里要同时报**原始值** —— 日志里出现过 "2.00s"，那是被夹住的，
 * 真实值可能更大，只报夹住后的值会把线索藏起来。
 */
function recorderLagMs() {
  const lag = playback?.recorderLagSec;
  if (!Number.isFinite(lag) || lag <= 0) return 0;
  return Math.min(2500, lag * 1000);
}

// ═══════════════════════════ 字幕渲染 ═══════════════════════════

const rendered = new Map(); // id -> {id, original, translation}
let history = [];

function pumpSubtitles() {
  if (!running) return;
  const now = Date.now();

  // 兜底：ASR 迟迟不发 utteranceEnd 时，别让这一句永远不上屏
  const stalled = utterances.tick(now);
  if (stalled) scheduleUtterance(stalled);

  // 「连上了却一直没有结果」也要有个说法，不能只是画面上什么都没有
  checkSilentAsr();
  // 画面顿也要有个说法 —— 而且要说清是"缓冲不够"还是"算力不够"
  checkHitching();

  // 每 10 秒报一次「缓冲末尾落后实况多久」。
  // 这笔滞后**没有**算进 actualDelaySec，所以字幕会恒定偏早这么多 ——
  // 先量出来看清楚它有多大，再决定要不要补进排期（或者让用户拿同步微调抵掉）。
  if (now - lastRecLagAt > 10000) {
    lastRecLagAt = now;
    const recLag = playback?.recorderLagSec;
    if (Number.isFinite(recLag)) {
      diag(
        `延迟测量 · 缓冲末尾落后实况 ${recLag.toFixed(2)}s（已补进排期，所以字幕不再因此偏早）`,
        false,
      );
    }
    // 变速纠偏会在人声上留下扑动感（时间伸缩失真），所以把它报出来：
    // 只在真正纠偏时报，免得刷屏
    const rate = playback?.video?.playbackRate;
    if (Number.isFinite(rate) && rate !== 1) {
      diag(`变速纠偏中 · 速率 ${rate.toFixed(3)} · 偏差 ${(playback.lastDriftSec || 0).toFixed(2)}s`, false);
    }
    // 卡顿：把"卡住那一刻的现场"报出来 —— 只说"顿了一下"没法定位
    // ⚠️ 只在**计数变化时**打一次。以前每 10 秒把同一条旧记录重打一遍，
    // 日志里一排一模一样的"卡顿 #1"，反而看不出到底卡了几次。
    if (playback?.hitchCount && playback.hitchCount !== lastHitchLogged) {
      lastHitchLogged = playback.hitchCount;
      const h = playback.lastHitch;
      diag(
        `卡顿 #${playback.hitchCount} · 冻住 ${h.frozenMs}ms · 缓冲 ${h.aheadSec}s · readyState ${h.readyState}` +
          ` · 速率 ${h.rate}${h.correcting ? '(纠偏中)' : ''} · 掉帧 ${h.dropped}`,
        h.frozenMs >= 150,
      );
    }

    // 缓冲健康度：播放头前面还剩多少。掉到很低说明 append 跟不上，那才会顿。
    const ahead = playback?.bufferAheadSec;
    if (Number.isFinite(ahead)) {
      const dropped = playback.droppedFrames || 0;
      const total = playback.totalFrames || 0;
      // 缓冲满却还在掉帧 → 卡在解码/编码侧（CPU/GPU 被抢），不是网络
      const bad = ahead < 1.5 || dropped > 0;
      diag(
        `缓冲 · 前方 ${ahead.toFixed(1)}s · 见底 ${playback.stallCount || 0} 次 · 掉帧 ${dropped}/${total}${
          ahead < 1.5 ? ' ⚠ 偏薄' : ''
        }${dropped > 0 && ahead >= 1.5 ? ' ⚠ 缓冲够却在掉帧：编码/解码抢不到资源' : ''}`,
        bad && dropped > 0,
      );
    }
  }

  // ⚠️ 每一拍都要重算，不能只在排期时算一次。
  // 实测延迟是**一直在动**的：起播时它才建立起来，之后前方缓冲涨太多时会被跳一次拉回目标。
  // 用户刚调过延迟、或者缓冲还在爬升时，排队中的条目必须跟着走，
  // 否则它们会按旧延迟上屏 —— 现象就是"字幕提前了"。
  // （`smoothRate` 默认关着，所以延迟不会平滑过渡，只会被那两种方式一次改变一个台阶。）
  // 这里顺带把实测延迟的 EMA 也刷新一次（原来一次一句，跟不上变化）。
  schedule.resync({
    firstAudioAt,
    delayMs: currentDelayMs(),
    syncOffsetMs: Number(settings.capture.syncOffsetMs) || 0,
    now,
  });

  for (const item of schedule.due(now, renderable(now))) {
    if (item.late) diagLate(item, now);
    if (!item.translation) diag('翻译没赶上 · 先显示原文', true);
    // 存引用而不是拷贝：译文晚到时才能直接改到已经上屏的这一条
    rendered.set(item.id, item);
    history.push(item.id);
    if (history.length > 3) {
      const drop = history.shift();
      rendered.delete(drop);
    }
    renderSubs();
  }
  setTimeout(pumpSubtitles, 100);
}

/**
 * 扣住没有译文的条目，等译文到了再上屏。
 *
 * ⚠️ 原文和译文是两回事：识别一到手就有原文，翻译还要再花时间。
 * 以前这里直接放行，于是译文没回来时字幕会**先显示日文原文**、
 * 过一会儿才变成中文 —— 看起来就是"上屏了但没翻译"。
 *
 * 但也不能无限扣：翻译挂了的话整句字幕就永远不出现了。
 * 所以扣够 LATE_TRANSLATION_MS 之后退回显示原文 —— 总比什么都没有好。
 */
const LATE_TRANSLATION_MS = 4000;

function renderable(now) {
  return (item) => {
    if (item.translation) return true;
    // 第一次到点却没译文时记下时刻，用它衡量"已经扣了多久"
    if (!item.dueSince) item.dueSince = now;
    return now - item.dueSince >= LATE_TRANSLATION_MS;
  };
}

/**
 * 字幕晚到了多少 —— 相对**排期时刻**，那才是用户感知到的量。
 *
 * 排期时刻 at = 画面播到这句「开口」的那一刻（由实测延迟算出来）。
 * 所以 `now − at` 就是"比应该出现的时刻晚了多少"。
 *
 * ⚠️ 别拿 `now − (firstAudioAt + start*1000)` 当滞后：那是相对**实况**的，
 * 而画面本来就晚了 D 秒，那个数会把 D 加进去（D=8 时报"晚 8.6 秒"，实际只晚 0.6 秒）。
 * 这正是我上一次犯的错。
 */
function diagLate(item, now) {
  const lateMs = now - item.at;
  const saidMs = Number.isFinite(item.start) && Number.isFinite(item.end) ? (item.end - item.start) * 1000 : 0;
  // 画面把这句说完的时刻 ≈ at + 句长（at 已经含了延迟），所以这句还在放 = lateMs <= saidMs
  const inside = saidMs > 0 && lateMs <= saidMs;
  diag(
    `字幕上屏 · 比排期晚 ${(lateMs / 1000).toFixed(2)}s · 这句说了 ${(saidMs / 1000).toFixed(1)}s${inside ? ' · 仍在句内' : ''}`,
    // 晚得还在句内 = 观感可接受，不用报警
    !inside,
  );
}

/**
 * 警告：**一律进诊断面板，绝不上屏**。
 *
 * 这里曾经有一条画面上方的红色横幅，理由是"识别挂了的时候用户只会看到什么都没有，
 * 而原因藏在默认关闭的面板里"。但用户明确要求画面干净 —— 所以横幅彻底删掉了。
 * 代价是：**诊断面板关着的时候看不到这些警告**，排查时记得把它打开。
 */
function warn(text) {
  const body = String(text || '');
  const [first, ...rest] = body.split('\n');
  diag(`⚠ ${first}`, true);
  for (const line of rest) diag(`   ${line}`, false);
}

/**
 * 「连上了却一直没有结果」的看门狗。
 *
 * 存在理由：识别断了、音源被判成静音、服务地址不对…… 这些都会表现为
 * **什么都没有**。内容进诊断面板，不再上屏。
 */
function checkSilentAsr() {
  if (!running || !firstAudioAt) return;
  const since = Math.max(firstAudioAt, lastResultAt || 0);
  const waited = Date.now() - since;
  if (waited < 15000) return;

  // ⚠️ 必须**持续刷新**，不能只报一次。
  // 一次性提示会永远停在它第一次触发的那一刻，读到的数字是几分钟前的快照 ——
  // 用户会以为"一直卡在这里"，而其实状态早就变了（这个坑踩过）。
  if (Date.now() - lastNoticeAt < 2000) return;
  lastNoticeAt = Date.now();

  // 「已发出 N 次 · 回来 M 次」是这里最有用的两个数：
  //   N 涨、M 不涨  → 请求发出去了但回不来（服务卡住 / 地址不通）
  //   N 根本不涨    → 分片没攒满，音频侧的问题
  //   N、M 都涨     → 请求正常，问题在下游（排期/上屏）
  const lines = [`已经 ${Math.round(waited / 1000)} 秒没有识别结果`];
  if (lastAudioNote) lines.push(`收音频：${lastAudioNote}`);
  lines.push(`识别请求：已发出 ${asrRequestsSent} 次 · 回来 ${asrRequestsDone} 次`);
  if (asrRequestsSent > asrRequestsDone + 1) {
    lines.push('→ 请求发出去了但回不来：检查本地服务在不在、地址对不对');
  } else if (asrRequestsSent === 0 && asrRequestsDone === 0) {
    // 本地 VAD 模式下不发"分片请求"，这个提示要说得准
    lines.push('→ 还没产生任何一句（看上面的 VAD 读数：帧数在涨吗？概率峰值上得去吗？）');
  } else if (asrRequestsDone > 0) {
    lines.push('→ 识别有结果了，问题在下游（上屏环节）');
  }
  warn(lines.join('\n'));
}

/** 上次刷新的"画面顿"提示时刻，以及当时的掉帧基数 */
let lastHitchNoticeAt = 0;
let lastDroppedBase = 0;
/** 上次打印过现场的卡顿序号 —— 避免同一条记录被反复重打 */
let lastHitchLogged = 0;

/**
 * 「画面顿一下」的看门狗。
 *
 * 关键在于**区分两种完全不同的成因**：
 *   缓冲不够（网络/写入跟不上）   → 调大画面延迟、或降分辨率都没用，要查网络
 *   缓冲够却在掉帧（算力不够）     → 是解码/编码/本地识别在抢 CPU 或 GPU
 * 以前只能靠用户描述"顿了一下"，没法定位；现在直接把判据说清楚。
 */
function checkHitching() {
  const dropped = playback?.droppedFrames || 0;
  const ahead = playback?.bufferAheadSec;
  if (!Number.isFinite(ahead) || !dropped) return;
  if (Date.now() - lastHitchNoticeAt < 5000) return;

  const delta = dropped - lastDroppedBase;
  if (lastDroppedBase && delta < 20) return; // 掉得不多，别打扰
  if (!lastDroppedBase) {
    lastDroppedBase = dropped;
    return;
  }
  // 字幕正常时才报（没字幕时那条更紧急）
  if (!lastResultAt) return;

  lastHitchNoticeAt = Date.now();
  lastDroppedBase = dropped;
  warn(
    `画面在丢帧：最近几秒丢了 ${delta} 帧（累计 ${dropped}）\n` +
      `缓冲前方还有 ${ahead.toFixed(1)}s —— ${
        ahead >= 1.5 ? '缓冲够却掉帧：是算力问题（解码/编码/本地识别在抢资源）' : '缓冲见底：是写入跟不上'
      }`,
  );
}

function renderSubs() {
  const box = $('subs');
  const ids = history.filter((id) => rendered.has(id));
  box.textContent = '';
  ids.forEach((id, i) => {
    const item = rendered.get(id);
    const el = document.createElement('div');
    el.className = `line${i === ids.length - 1 ? '' : ' hist'}${item.translation ? '' : ' pending'}`;
    const tr = document.createElement('div');
    tr.className = 'tr';
    tr.textContent = item.translation || item.original;
    el.appendChild(tr);
    if (item.translation && item.original && item.translation !== item.original && settings.ui.showOriginal !== false) {
      const src = document.createElement('div');
      src.className = 'src';
      src.textContent = item.original;
      el.appendChild(src);
    }
    box.appendChild(el);
  });
}

// ═══════════════════════════ UI ═══════════════════════════

function applySettingsToUi() {
  $('delay').value = String(settings.capture.delaySec ?? 2.5);
  $('delayVal').textContent = `${Number(settings.capture.delaySec ?? 2.5).toFixed(1)}s`;
  $('sync').value = String(settings.capture.syncOffsetMs ?? 0);
  $('syncVal').textContent = `${settings.capture.syncOffsetMs ?? 0}ms`;
  $('vol').value = String(settings.capture.volume ?? 1);
  $('volVal').textContent = `${Math.round((settings.capture.volume ?? 1) * 100)}%`;
  $('video').volume = Number(settings.capture.volume ?? 1);
  $('diagOn').checked = !!settings.ui.showDiag;
  $('diag').classList.toggle('on', !!settings.ui.showDiag);
  $('refineOn').checked = refineEnabled();
  $('quality').value = String(settings.capture.delayMaxHeight ?? 0);
  $('smoothRate').checked = settings.capture.smoothRate !== false;
}

let saveTimer = null;

/**
 * 待落盘的设置项——**只写自己动过的字段**。
 *
 * 以前这里是 `saveSettings(settings)`，把整份本地副本写回去。而这份副本是页面启动时读的，
 * 之后再也没刷新过（这个页面也不监听 storage 变化），于是：
 *
 *   你在设置页改了术语表 → 播放页动一下任何一个滑块 → 整份旧副本覆盖回去 → 你的改动没了。
 *
 * 因为是静默的，你只会发现"我明明加过那个词，怎么又不见了"。
 * 改成逐字段 patch（底层是先重读、再只改这一个字段），外部的改动就不会被抹掉。
 *
 * @param {string} path 设置路径，例如 'capture.delaySec'
 */
const pendingPatches = new Map();

function scheduleSave(path, value) {
  pendingPatches.set(path, value);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPatches, 500);
}

async function flushPatches() {
  saveTimer = null;
  const entries = [...pendingPatches];
  pendingPatches.clear();
  for (const [path, value] of entries) {
    try {
      await patchSettings(path, value);
    } catch (e) {
      diag(`设置保存失败 · ${path} · ${e?.message || e}`, true);
    }
  }
}

/**
 * 别的页面（设置页 / 弹窗）改了设置 → 刷新本地副本。
 *
 * 正在拖滑块时不刷新——否则你手上那个值会被存储里的旧值弹回去。
 */
function watchExternalSettings() {
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes?.[STORAGE_KEY]) return;
    if (pendingPatches.size) return;
    const before = settings;
    try {
      settings = await getSettings();
    } catch {
      return;
    }
    applySettingsToUi();
    const d = Number(settings.capture?.delaySec);
    if (Number.isFinite(d) && d !== Number(before?.capture?.delaySec)) playback?.setDelay(d);
    /**
     * ⚠️ 画质 / 码率 / 帧率**改不了正在跑的这一次**，必须说清楚。
     *
     * 码率在 start() 时就烘进了 MediaRecorder 的 videoBitsPerSecond，
     * 帧率烘进了 getUserMedia 的约束 —— 两者都无法中途改。
     * 原来改完毫无反应也不提示，用户会以为档位坏了（这事真发生过）。
     * 延迟秒数能热改（上面那行），其余三项只能重启。
     */
    const needRestart = [
      ['capture.delayQuality', '画质档位'],
      ['capture.delayBitsPerSecond', '视频码率'],
      ['capture.maxFrameRate', '采集帧率'],
      ['capture.mode', '呈现方式'],
    ].filter(([key]) => {
      const path = key.split('.');
      return before?.[path[0]]?.[path[1]] !== settings?.[path[0]]?.[path[1]];
    });
    diag('设置已从别处更新', true);
    if (needRestart.length) {
      diag(
        `⚠ ${needRestart.map(([, label]) => label).join('、')} 的改动**要重新开始同声传译才会生效**` +
          `（这几项在启动时就定死了，无法中途更改）`,
        true,
      );
    }
  });
}

function tickUi() {
  if (!running) return;
  const actual = playback?.actualDelaySec;
  $('statDelay').textContent = `延迟 ${Number.isFinite(actual) ? actual.toFixed(2) + 's' : '—'}`;
  $('statAsr').textContent = `识别 ${lagEma === null ? '—' : (lagEma / 1000).toFixed(1) + 's'}`;
  $('statTr').textContent = `翻译 ${translateEma === null ? '—' : (translateEma / 1000).toFixed(2) + 's'}`;
  const end = playback?.bufferedEnd?.();
  const buf = end === null || end === undefined ? null : end - ($('video').currentTime || 0);
  $('statBuf').textContent = `缓冲 ${buf === null ? '—' : buf.toFixed(1) + 's'}`;

  // 把"延迟预算怎么花的"直接写在界面上：延迟 = 等后文的时间 + 翻译的时间
  const delayMs = Number.isFinite(actual) && actual > 0 ? actual * 1000 : (Number(settings.capture.delaySec) || 2.5) * 1000;
  const leadMs = effectiveLeadMs(translateEma);
  const budget = delayMs - leadMs;
  if (buf !== null && buf < 0.6 && actual !== null && actual !== undefined) {
    $('hint').textContent = '缓冲快见底了：把延迟调大一点，或降低码率。';
  } else if (budget <= 0) {
    $('hint').textContent = `画面延迟只有 ${(delayMs / 1000).toFixed(1)}s，比翻译窗口还短 —— 把延迟调大。`;
  } else {
    $('hint').textContent = `翻译窗口 ${(leadMs / 1000).toFixed(1)}s（实测翻译 ${translateEma === null ? '—' : Math.round(translateEma) + 'ms'}）· 可用于等后文 ≈ ${(budget / 1000).toFixed(1)}s`;
  }
  requestAnimationFrame(tickUi);
}

function bindUi() {
  $('delay').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('delayVal').textContent = `${v.toFixed(1)}s`;
    settings.capture.delaySec = v;
    playback?.setDelay(v);
    scheduleSave('capture.delaySec', v);
  });
  $('sync').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('syncVal').textContent = `${v}ms`;
    settings.capture.syncOffsetMs = v;
    scheduleSave('capture.syncOffsetMs', v);
  });
  $('vol').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('volVal').textContent = `${Math.round(v * 100)}%`;
    $('video').volume = v;
    settings.capture.volume = v;
    scheduleSave('capture.volume', v);
  });
  $('diagOn').addEventListener('change', (e) => {
    settings.ui.showDiag = e.target.checked;
    $('diag').classList.toggle('on', e.target.checked);
    scheduleSave('ui.showDiag', e.target.checked);
    if (e.target.checked) renderDiag();
  });
  $('btnCopyDiag').addEventListener('click', () => void copyDiag());
  $('btnFull').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      // ⚠️ 全屏的是 frame（整个画面区），不是 video ——
      // video 原生全屏只渲染 video 元素本身，DOM 里的字幕层会被一起藏掉。
      else await $('frame').requestFullscreen();
    } catch (e) {
      diag(`全屏失败 · ${e.message || e}`, true);
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    $('btnFull').textContent = on ? '退出全屏' : '全屏';
  });
  $('smoothRate').addEventListener('change', (e) => {
    settings.capture.smoothRate = e.target.checked;
    scheduleSave('capture.smoothRate', e.target.checked);
    if (playback) playback.smoothRate = e.target.checked;
    diag(e.target.checked ? '变速纠偏已开（延迟更稳，画面可能有变速顿挫）' : '变速纠偏已关（画面更顺，延迟会慢慢漂移；字幕依然对得上）', true);
  });
  $('quality').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    settings.capture.delayMaxHeight = v;
    scheduleSave('capture.delayMaxHeight', v);
    // 编码在开始录制时就定了，改这个必须重新开始捕获
    diag(`延迟画质改为 ${v ? `${v}p` : '原样'} —— 重新开始捕获才生效`, true);
  });
  $('refineOn').addEventListener('change', (e) => {
    if (!settings.asr) settings.asr = {};
    if (!settings.asr.refine) settings.asr.refine = {};
    settings.asr.refine.enabled = e.target.checked;
    scheduleSave('asr.refine.enabled', e.target.checked);
    if (!e.target.checked) {
      diag('识别校正已关闭', true);
    } else if (!refiner?.available) {
      diag(`识别校正打不开 · ${refiner?.reason || '重识别器没建起来'}`, true);
    } else {
      diag(`识别校正已开启 · ${refiner.provider} · ${refiner.model}`, true);
    }
  });
  $('btnBack').addEventListener('click', () => {
    if (job?.tabId) chrome.tabs.update(job.tabId, { active: true }).catch(() => {});
  });
  $('btnStop').addEventListener('click', () => stopAll('用户停止'));
}

function showOverlay(title, body, err, action) {
  $('overlay').classList.remove('hidden');
  $('ovTitle').textContent = title;
  $('ovBody').textContent = body || '';
  $('ovErr').textContent = err || '';
  $('ovErr').style.display = err ? '' : 'none';
  const btn = $('ovAction');
  if (action) {
    btn.textContent = action.label;
    btn.hidden = false;
    btn.onclick = () => {
      btn.hidden = true;
      Promise.resolve(action.run()).catch(() => {});
    };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
}
function hideOverlay() {
  $('overlay').classList.add('hidden');
}

function stopAll(reason) {
  /**
   * ⚠️ 守卫必须把 `stream` 也算上。
   *
   * 原来只看 running/playback/asr —— 但「没有拿到视频轨」这类错误正好发生在
   * `getUserMedia` 已成功、`playback` 还没建的窗口里。那时三个都是空的 → 早退 →
   * **stream 的 track 永远不 stop → 源标签页永久静音**（tabCapture 的固有行为就是静音原页面）。
   * 用户会以为扩展把他的网页搞坏了，而且不关播放页就恢复不了。
   */
  if (!running && !playback && !asr && !stream) {
    return;
  }
  running = false;
  diag(`停止 · ${reason}`, true);
  try {
    asr?.stop();
  } catch {
    /* ignore */
  }
  asr = null;
  try {
    playback?.stop();
  } catch {
    /* ignore */
  }
  playback = null;
  try {
    stream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  stream = null;
  try {
    ctx?.close();
  } catch {
    /* ignore */
  }
  ctx = null;
  try {
    finalController?.abort();
  } catch {
    /* ignore */
  }
  schedule.clear();
  segs.length = 0;
  inflight = 0;
  utterances.reset();
  pcmRing?.clear();
  pcmRing = null;
  refiner = null;
  $('dot').classList.remove('live');
  chrome.storage.session.remove(JOB_KEY).catch(() => {});
  void chrome.runtime.sendMessage({ type: 'LIVEDUB_PLAYER_STOPPED', reason }).catch(() => {});
  showOverlay('已停止', '可以关闭这个标签页，或回到原页面重新开始。', '');
}

// 关闭页面前把流和录制停掉，别留悬挂的 tabCapture
window.addEventListener('pagehide', () => {
  try {
    stream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  try {
    playback?.stop();
  } catch {
    /* ignore */
  }
});

bindUi();
boot();
