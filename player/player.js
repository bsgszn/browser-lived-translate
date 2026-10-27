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
import { Resampler, float32ToInt16, rms, noteDue } from '../lib/util.js';
import { UtteranceAccumulator } from '../lib/utterance.js';
import { PcmRing, encodeWav } from '../lib/pcm-ring.js';
import { createRefiner } from '../lib/asr/refine.js';
// 诊断日志的追加与窗口切片收在 lib/diag-window.js —— 页面脚本在 smoke-test 里加载不了，
// 而「两个数组必须等长」和「窗口边界取 >=」这两条行为需要断言守住。
import { pushDiagPair, diagWindow, formatAlignNote, formatPromptNote, formatAtStamp } from '../lib/diag-window.js';
// ⚠️ 为了让「这次识别到底带了多长的提示词」能印出来，必须拿到**算提示词的那个函数本身** ——
//    在 player.js 里另写一份合并逻辑就是"同一事实记两遍"，迟早和它不一致 ✗。
//    `lib/asr/vad.js` 早已在模块图里（`lib/asr/index.js` 顶层 import 了它），
//    所以这里再加一条 import 不增加加载开销；而它的顶层依赖也只有 util / vad-gate /
//    hallucination / glossary / hotwords（onnxruntime 是运行时才动态取）。
import { buildWhisperPrompt } from '../lib/asr/vad.js';
// ⚠️ 只取两个**纯函数**（不引整条识别链）—— 它们和「什么时候该上屏」有关，
//    和 `shownStartOf` / `clampShownAt` 是同一族，放在同一个模块里 ✓
import {
  holdSwitchForGap,
  minShowHoldMs,
  MIN_SHOW_HOLD_MS,
  MIN_SHOW_GAP_SEC,
  shouldMergeShown,
  joinShownText,
  pickShownBatch,
  mergeShownBatch,
  SHOW_BATCH_TOLERANCE_SEC,
  displayHoldMs,
  TRANSLATE_FAIL_STREAK,
} from '../lib/asr/whisper-batch.js';
import { JA_LIVE_HOTWORD_LIST } from '../lib/hotwords/ja-live.js';
import { buildAnalysisChain, AgcController, setAgcProfile } from '../lib/audio-chain.js';
import {
  DelayedPlayback,
  DELAY_MIN_SEC,
  SubtitleSchedule,
  isSupported,
  buildContextWindow,
  pickNextToTranslate,
  effectiveLeadMs,
  findStuckFlights,
  countInflight,
  classifyThinBuffer,
  MIME_PROBE_MS,
  tailMergeTrigger,
  mergeTailText,
  MAX_PULL_FORWARD_MS,
} from '../lib/delayed-player.js';

// ⭐ 有效延迟：选「本地 Whisper 自断句」时，首批音频 6 秒 + 往返 + 确认 ⇒ 需要 ≈10 秒。
//    ⚠️ 只在运行时抬，**不写 storage** —— 用户切回别的服务就立刻回到他自己的值。
//    ⚠️ 这里不 clamp 上限：DelayedPlayback 自己会 clamp（现在是 3~20 秒）。
//    ⚠️ 判据有两支：**下拉项**（`asr.provider === 'vad-segments'`，正常路径）
//       和**旧开关**（`whisperSegments === true`，v2.66.82 迁移之前的残留数据）。
//       两支都要认 —— 否则老用户迁移完之前那一次打开会按旧延迟排期，字幕必然迟到。
/** 老位置：新路延迟下限的硬编码。现在只当**兜底**用（用户能从面板改，见 `minDelaySec`）。 */
const WHISPER_SEGMENTS_MIN_DELAY_SEC = 6.5;
/** 面板可调范围。下限 4 是 `DELAY_MIN_SEC` 之上一点 —— 再低排期预算就不够了。 */
const MIN_DELAY_SEC_RANGE = [4, 16];
/**
 * 旧路线（`provider === 'vad'`）的延迟下限 —— **5 秒**（用户定的：「旧线路延迟下限改为 5S」）。
 *
 * 🔴 为什么给旧路也加地板：`capture.delaySec` 的默认值是 **3 秒** ✗ ——
 *    而 3 秒连"识别定稿 + 翻译往返"都装不下 ⇒ 字幕必然比画面晚 ✗
 *
 * ⚠️ 它和新路的 6.5 **不是同一个数** ✗：
 *    旧路是流式识别（延迟 0.3~1 秒），不需要新路那么厚的预算 ✓
 * ⚠️ 反过来，新路的 `minDelaySec` **不许**染指旧路 ✓ —— 两条路各用各的地板。
 * ⚠️ 只抬不压：滑块高过 5 时滑块说了算 ✓
 */
const OLD_PATH_MIN_DELAY_SEC = 5;

/**
 * 新路延迟下限：**用户可调**（`asr.vadSegments.minDelaySec`，默认 6.5）。
 *
 * 🔴 为什么必须可调：它原来是个写死的 10，而**这台机器的缓冲只撑得起 7.9~8.4 秒**
 *    ⇒ 日志天天报「画面实际比目标靠前 2.0s ⇒ 这句会晚」✗ ——
 *    而用户把滑块调到 4.7 时发现"降不下去"，因为 10 是硬下限 ✓
 *
 * ⚠️ 脏值一律退回 6.5（不是退回 0 —— 0 会让排期预算消失，字幕全部提前）。
 * ⚠️ 也不要让它变得"读不到就见旧值"：这里和 `settings.js` 的默认值**必须一致** ✗
 */
function newPathMinDelaySec(settings) {
  const v = Number(settings?.asr?.vadSegments?.minDelaySec ?? WHISPER_SEGMENTS_MIN_DELAY_SEC);
  const [lo, hi] = MIN_DELAY_SEC_RANGE;
  return Number.isFinite(v) && v >= lo && v <= hi ? v : WHISPER_SEGMENTS_MIN_DELAY_SEC;
}

function effectiveDelaySec(settings) {
  const raw = Number(settings?.capture?.delaySec);
  const own = Number.isFinite(raw) && raw > 0 ? raw : DELAY_MIN_SEC;
  const onWhisperSegments =
    settings?.asr?.provider === 'vad-segments' ||
    settings?.asr?.whisperChunked?.whisperSegments === true;
  if (onWhisperSegments) {
    return Math.max(own, newPathMinDelaySec(settings));
  }
  return Math.max(own, OLD_PATH_MIN_DELAY_SEC);
}

const $ = (id) => document.getElementById(id);
const JOB_KEY = 'livedub.playerJob';
const LEVEL_INTERVAL_MS = 250;
const CACHE_LIMIT = 400;

let settings = null;
let job = null;
let stream = null;
let ctx = null;
let playback = null;

/**
 * 「这次识别带了多长的提示词」。
 *
 * ⚠️ 为什么必须印：v2.66.80 把 146 个内置热词默认塞进 Whisper 的 prompt，
 *    而**日志里一个字都看不到 prompt** ✗ —— 于是"每段少认一半的字"被读成
 *    "Whisper 认不全"，查了一整天才发现是我们自己让它**提前停**（`no_speech_prob` 0.93→0.01、
 *    识别段数 3→1）。一个会改变解码行为的输入没被印出来，错了就没人能一眼看出来。
 *
 * 数值全部来自 `buildWhisperPrompt` 本身（**不在这里另算一遍**），
 * 格式化交给 `lib/diag-window.js` 的 `formatPromptNote`（纯函数，可断言）。
 */
function promptDiagLine() {
  try {
    const wc = settings?.asr?.whisperChunked || {};
    const userRaw = String(wc.hotwords || '');
    const userCount = userRaw.split('\n').filter((l) => String(l).trim()).length;
    const built = buildWhisperPrompt({
      prompt: String(wc.prompt || ''),
      hotwords: userRaw,
      liveHotwords: JA_LIVE_HOTWORD_LIST,
      // ⚠️ 和 `vad.js` / `whisper-chunked.js` 用**同一个判法**（`!== false`）——
      //    判法不一致就会印出"关着"而实际带上了。
      includeLiveHotwords: wc.liveHotwords !== false,
    });
    return formatPromptNote({
      promptChars: String(built?.text || '').length,
      liveUsed: built?.live,
      liveTotal: built?.liveTotal,
      userCount,
      truncated: built?.truncated === true,
    });
  } catch {
    // 印不出来也不许把日志打挂 —— 和 `formatPromptNote` 的"全拿不到就印 —"是同一条约定
    return formatPromptNote({});
  }
}

/**
 * ⚠️ `appendBuffer` 失败的**累计次数**与**最后一次原因**。
 *
 * 为什么不能只靠现有那行 `diag('缓冲写入失败 · …')`:那是**一次性**的。
 * 而快照是**周期性**的 —— 它要在"某次失败之后又过了很久"时，仍然看得出
 * **曾经失败过几次、最后一次是什么**。两种记录方式互补，谁也替代不了谁。
 *
 * 重置点:`startCapture()` 开头（每次新采集从零开始）。
 */
let appendFails = 0;
let lastAppendError = null;
/**
 * 周期快照的定时器。
 *
 * ⚠️⚠️ **必须在停止时清掉**，否则"开始 → 停止 → 再开始"会累积多个定时器，
 * 越跑越密 —— 那正是"用着用着就卡了"的成因。
 *
 * ⚠️ 为什么周期打是必要的（2s/8s/20s 那三次不够）:
 * 缓冲区是 400 行的环形缓冲，实测约 3 行/秒 → **只装得下约 130 秒**。
 * 故障发生在第 5 分钟时，附近**没有任何快照** ✗。
 * 周期快照把"关键状态的轨迹"留下来：60 秒 2 行 → 400 行能装约 200 分钟。
 *
 * ⚠️ 而它不会把日志刷成全是快照:活跃时每秒约 3 行日志，快照只占约 1%；
 * 而完全静止时 `diag()` 自带"连续重复行不重复记"的去重，同一条只会留一行。
 */
let snapTimer = 0;
const SNAP_PERIOD_MS = 60000;
/**
 * `visibilitychange` 的监听器（采集开始时挂、停止时摘）。
 *
 * ⚠️ 为什么要有它:实测日志里出现过
 *   〔快照 2s·播放〕… 可见 hidden    〔快照 8s·录制〕字节 1252／2 片
 * —— 2 秒到 8 秒之间**几乎什么都没产出**，而同一次快照里写着 `可见 hidden`。
 *
 * ⚠️ 而那是**相关，不是因果** —— 我们只有那一条观测，还没有对照实验。
 * 所以措辞**必须留余地**（"可能被节流"），不能写成"切后台就会黑屏" ✗。
 * 而"回到前台"也只说"已回到前台"，**不说"采集已恢复"** —— 那个因果同样没测到。
 */
let visHandler = null;
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
/**
 * 字幕**真的上屏**了多少句，以及最近一次的时刻。
 *
 * ⚠️ 看门狗必须以这个为准，不能以「拿到识别结果」为准:
 * 用户看到的"什么都没有"是**屏幕上没有字幕**，而识别文本可能早就到手了
 * （卡在排期/翻译）。实测踩过:看门狗拿 `lastResultAt` 当基准，
 * 在字幕**正常上屏**时仍然报「已经 15 秒没有识别结果」，
 * 还给出「问题在下游（上屏环节）」这个**结论也错**的提示 —— 纯粹是假警报。
 */
let shownCount = 0;
let lastShownAt = 0;
/**
 * 上一次**换屏**的时刻（毫秒，与 `pumpSubtitles` 的 `now` 同基准）。
 *
 * ⚠️ 和 `lastShownAt` 不是一回事：那是 `Date.now()`（看门狗的基准），
 *    而这个是排期循环里的 `now`。**混用两个时钟**正是今天"晚多少对不上"的根 ✗
 *
 * `0` = 还没换过屏（不许当成"刚换过" ✗）
 */
let lastShowSwitchAt = 0;
/** 被「屏上让位」挡下来的次数（进心跳/诊断，否则这事在日志里看不见 ✗） */
let showHeldCount = 0;
/**
 * 上一条**真的上屏**的时刻 + 它有多少字（`performance.now()` 基准）。
 *
 * ⚠️ 存在的理由是一个**测量缺口**（实测发现）：
 *   「字幕上屏」那行原来**只在 `item.late` 时才打印** ✗，而 `item.late` 是**推入时**
 *   算的（`at <= Date.now()`），**不是上屏时重算** ✗
 *   ⇒ 被让位、但推入时"还没晚"的条目**根本不打印** ⇒ 日志里没有真实上屏时刻 ✗
 *   ⇒ 于是「在屏时长」只能拿 `at + 比排期晚` **反推**，而那对这批条目全是错的 ✗
 *     （实测：在屏<跨度 12/45、最短 0.14s —— 那些数**不可信** ✗）
 *
 * ⇒ 现在每一条真的上屏都打一行，并且**直接给出**上一条的真实在屏时长和阅读速度 ✓
 *   而"在屏时长"只能在下一条上屏时才算得出来 ⇒ 所以记在这里、由**下一条**报出来 ✓
 */
let lastShownPerf = 0;
/** 上一条上屏时它的字数（用来算**上一条**的阅读速度，不是这一条的 ✓） */
let lastShownChars = 0;
/**
 * 被「屏上合并」并进上一条的次数（和 `showHeldCount` 同一个理由：看不见就查不到 ✓）。
 *
 * 合并**不推迟任何东西** —— 它只是把"两句挤在一起、后一句把前一句顶掉"换成"一行显示两句" ✓
 * 而它和"让位"是**互斥**的两条路：能并就并（用户定的），并不了才让位 ✓
 */
let showMergedCount = 0;
/** 上次刷新"没有识别结果"提示的时刻（要持续刷新，不能只报一次） */
let lastNoticeAt = 0;
/** 上次报告「缓冲落后实况多久」的时刻（每 10 秒报一次，免得刷屏） */
let lastRecLagAt = 0;
/**
 * 「实测延迟 − 目标延迟」的毫秒差（负 = 画面比目标更靠前 ⇒ 按目标排会**偏晚**）。
 *
 * ⚠️ **只用于诊断，不参与排期** ✗ —— 排期按目标值走（见 `currentDelayMs`）。
 *    用户的原话是「不是要偏早,也不是要偏晚,而是要**准**；短句尤其不许早也不许晚」✗
 *    ⇒ 而"准"的前提是 `actual ≈ target`；达不到时必须**说出来**，
 *      不许用排期悄悄补偿（那会让"短句为什么晚"变得查不出来）✗
 */
let scheduleDeviationMs = null;
let scheduleDeviationEma = null;
/** 偏差超过这么多毫秒才值得报（0.3 秒，人眼开始能看出错位） */
const SCHEDULE_DEVIATION_WARN_MS = 300;
const agc = new AgcController();
let levelRms = 0;
let lastLevelAt = 0;
let running = false;
let pendingTranslate = new Map();
let finalController = null;

/**
 * 同一条「旁路提醒」的限流 —— **在首次出现时打，之后同一句最多每 5 分钟一次**。
 *
 * ⚠️ 存在理由（实测）:DeepL 的「术语表未生效」是**每一句翻译**都回调一次，
 * 用户日志里同一句出现了 8~9 次，把约两分钟的日志缓冲区吃掉一大块。
 * 而 `diag()` 的"连续重复行不重复记"挡不住它 —— 中间夹着「翻译开始/完成」，
 * 永远不是**连续**的。
 *
 * ⚠️ 但也不能"只打一次就永远不说":那是条**可操作**的提醒
 * （要去设置页把源语言指定成具体语言）。所以按时间限流，并把被压掉的次数
 * 在下次输出时带上 —— 否则"只出现一次"和"一直没发生"看起来是一样的。
 */
const NOTE_REPEAT_MS = 5 * 60 * 1000;
const noteLastAt = new Map();
const noteSeenCount = new Map();

/** @returns {string|null} 该打的文本（重复过就带次数），或 null 表示这次压掉 */
function takeNote(note) {
  const text = String(note || '').trim();
  if (!text) return null;
  const n = (noteSeenCount.get(text) || 0) + 1;
  noteSeenCount.set(text, n);
  const now = Date.now();
  if (!noteDue(noteLastAt.get(text) || 0, now, NOTE_REPEAT_MS)) return null;
  noteLastAt.set(text, now);
  return n > 1 ? `${text}（同一提示已出现 ${n} 次，不再逐句重复）` : text;
}

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
/**
 * 与 `diagLines` 一一对应的**单调**时间戳（`performance.now()`）。
 *
 * ⚠️ 只用 `performance.now()`，**不要 `Date.now()`** —— 后者会被系统对时改掉，
 * 切出来的「那 30 秒」就会错位。基准是 `DIAG_T0`（本模块加载那一刻）。
 *
 * ⚠️ 面板和「复制日志」**不显示**时间戳（保持原来的可读性），
 * 只有**导出的 .log 文件**里会带上 —— 那里才需要和音频对齐。
 */
const diagTimes = [];
/** 日志时间戳的零点。页面重开就换一个，不需要跨页面对齐。 */
const DIAG_T0 = performance.now();

/**
 * 每句的「识别文本」与「实际显示文本」—— **只进导出的文件，不进屏幕**。
 *
 * ⚠️ 这两个文本发生在**不同时刻**：识别在收句那一刻就有，显示要等翻译完、排期到点。
 *    所以按 `id` 先存识别、上屏时再回填显示 —— 是**一条记录的两个字段**，
 *    不是两条各说各的日志（那样对不上号）。
 *
 * ⚠️ 为什么要它：配上导出的 WAV，就能回答"当时识别成了什么 / 显示成了什么"。
 *    面板上的诊断行**仍然只印长度、不印正文**（那是故意的，正文不该刷屏）。
 */
const SUBLOG_KEEP = 120; // 条数。60 秒通常 20~60 句，留足余量；挤掉时导出会如实写明
const subLog = [];

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
  // （成对 push + 成对裁剪收在 pushDiagPair 里，免得两个数组哪天只改了一处）
  if (pushDiagPair(diagLines, diagTimes, text, performance.now(), DIAG_KEEP)) renderDiag();
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
 * 一份**紧凑的**状态快照（一行）。
 *
 * ⚠️ 为什么要有它:现有日志全是「某件事**发生了**」的记录，而故障常常是
 * 「某件事**从没发生**」—— 那时最需要的那段反而什么都没留下。
 * 排查"黑屏无声有字幕"时就是这样:「卡顿」只在播放卡住时才打，而播放根本没开始;
 * 「延迟播放已就绪」只在准备好时才打，而它从没准备好。
 *
 * ⚠️ 必须是一行:缓冲区 400 行、面板只显示 60 行。一条快照占 20 行的话，
 * 三次快照就把**启动阶段**挤出缓冲区 —— 而那恰恰是最需要的一段。
 *
 * ⚠️ 任何字段取不到都不许抛 —— **打日志绝不能把播放搞挂**。
 */
function snapshotLine(tag) {
  try {
    const v = $('video');
    const p = playback;
    const g = (fn, d = '?') => {
      try {
        const x = fn();
        return x === null || x === undefined ? d : x;
      } catch {
        return d;
      }
    };
    const r = p?.recorder;
    const sb = p?.sourceBuffer;
    const sbRanges = g(() => sb?.buffered?.length ?? 0);
    const vRanges = g(() => v?.buffered?.length ?? 0);
    const vEnd = g(() => (v?.buffered?.length ? v.buffered.end(v.buffered.length - 1) : null), null);
    /**
     * ⚠️ 缓冲的**起点** —— 这一格是为了让「裁剪到底有没有发生」在日志里可判 ✗。
     *
     * 原来只有 `末尾 {vEnd}`，于是这两种**完全相反**的状态在日志里长得一模一样:
     *   · `t60.0 … 末尾 66.0` 而 `起 0.0`   ⇒ 裁剪**一次都没生效**（缓冲从 0 一直挂到 66）✗
     *   · `t60.0 … 末尾 66.0` 而 `起 55.2`  ⇒ 裁剪正常工作（后面 6 秒是留的余量）✓
     * 有个用户报「延迟模式跑一段时间稳定崩溃」，而"是不是缓冲在涨"正好卡在这一格上 ✗。
     */
    const vStart = g(() => (v?.buffered?.length ? v.buffered.start(0) : null), null);
    /**
     * 裁剪统计 + 缓冲占用**估算**（只读，见 `DelayedPlayer#sbDiagnostics` 的注释）。
     * ⚠️ 取不到就整体不印 —— 不许因为一个新读数把快照打挂。
     */
    const sbx = g(() => p?.sbDiagnostics, null);
    const lag = g(() => {
      const x = p?.actualDelaySec;
      return x === null || x === undefined ? '—' : Number(x).toFixed(1);
    });
    /**
     * 起播 seek 的**次数**与**最后一次的位置**。
     * ⚠️ 只留这两个，不留完整历史 —— 见 `delayed-player.js` 里那两个字段的注释。
     * 正常只该有 1 次；次数大于 1 说明起播反复过。
     */
    const seekN = g(() => p?.seekCount);
    const seekT = g(() => {
      const x = p?.lastSeekTarget;
      return x === null || x === undefined ? null : Number(x).toFixed(1);
    }, null);
    /**
     * ⚠️ 轨道的**实际**设置 —— 这是唯一能回答「applyConstraints 到底生效没有」的读数。
     * `stream` 是模块级变量，所以不用新加状态。
     * ⚠️ 它取的是**活的**那条轨（`stream` 自己的），而采集侧取偶正是改这条轨，
     * 所以这里拿到的就是**取偶之后**的值 —— 顺序上取偶在 `已取得流` 之前完成。
     *
     * ⚠️ 还要带轨**自己**的状态，那是 `getSettings()` 给不了的:
     * `readyState` 变 `ended`（来源流断了）、`muted`、`enabled=false`
     * —— 这三种都会让"录制器 0 字节"，而光看尺寸完全看不出来 ✗
     * （尺寸照样报 3840×2160@60，看着一切正常）。
     * 为了守住"快照只有一行"，**muted/enabled 只在异常时**才拼上去。
     */
    const vtrack = g(() => stream?.getVideoTracks?.()[0], null);
    const vs = g(() => vtrack?.getSettings?.(), null) || {};
    const vtState = String(g(() => vtrack?.readyState));
    const vtFlag =
      (g(() => vtrack?.muted) === true ? '·静音' : '') +
      (g(() => vtrack?.enabled) === false ? '·已禁用' : '');
    const vt = `${vs.width || '?'}×${vs.height || '?'}@${vs.frameRate ? Math.round(vs.frameRate) : '?'} ${vtState}${vtFlag}`;
    return (
      `〔快照 ${tag}·录制〕` +
      ` ${g(() => r?.mimeType) || '(空)'}/${g(() => r?.state)}` +
      ` · 字节 ${g(() => p?.bytes)}／${g(() => p?.chunks)} 片` +
      ` · 轨道 ${vt}` +
      ` · SB ${sb ? '有' : '无'}${g(() => (sb?.updating ? '/更新中' : ''))}/${sbRanges} 段 · MS ${g(() => p?.mediaSource?.readyState)}` +
      /**
       * ⚠️ append 失败要进快照 —— 否则"录到了但写不进去"这条分支只能靠
       * 恰好抓到那一瞬间的一次性日志，事后完全看不出来。
       * 错误文本可能很长（配额溢出的原文很长），截断到 40 字，**保住"只有一行"这条硬约束**。
       */
      ` · append 成功 ${g(() => p?.appendOk)}／失败 ${appendFails}${lastAppendError ? `(${String(lastAppendError).slice(0, 40)})` : ''}` +
      `\n〔快照 ${tag}·播放〕` +
      ` rs${g(() => v?.readyState)} ${g(() => (v?.paused ? '暂停' : '播放中'))}` +
      ` t${g(() => Number(v?.currentTime || 0).toFixed(1))}/${vRanges} 段` +
      (vStart === null ? '' : ` 起 ${Number(vStart).toFixed(1)}`) +
      (vEnd === null ? '' : ` 末尾 ${Number(vEnd).toFixed(1)}`) +
      /**
       * ⚠️ 裁剪统计和缓冲估算 —— **必须和上面的 `起` / `t` 一起读**，单独看会说谎:
       *   · `裁 0次` 而 `起 0.0`   ⇒ 裁剪**从来没发起过** ✗
       *   · `裁 3次` 而 `起 0.0`   ⇒ 发起了却**没落地**（remove 排进队列但没生效）✗
       *   · `裁 3次` 而 `起 55.2`  ⇒ 正常 ✓
       * `缓冲估` 只回答"**量级**在不在涨" ✗ —— 它是码率×时长算出来的估算，
       * 不是显存读数（见 `DelayedPlayer#sbDiagnostics` 里为什么刻意不印 `performance.memory`）。
       */
      (sbx && sbx.trimCount !== null
        ? ` · 裁 ${sbx.trimCount}次` +
          (sbx.sinceTrimSec === null ? '' : `/${Number(sbx.sinceTrimSec).toFixed(1)}s前`) +
          (sbx.estBytes === null ? '' : ` · 缓冲估 ${(Number(sbx.estBytes) / 1048576).toFixed(1)}MB`)
        : '') +
      ` · locked ${g(() => p?.locked)} · 被拒 ${g(() => p?.playBlocked)} · 延迟 ${lag}` +
      ` · seek ${seekN}${seekT === null ? '' : `@${seekT}`}` +
      ` · 见底 ${g(() => p?.stallCount)} · 帧 ${g(() => p?.totalFrames)}/${g(() => p?.droppedFrames)}` +
      ` · 可见 ${g(() => document.visibilityState)}` +
      /**
       * AudioContext 的**当前**状态。起采集时已经打过一次（`AudioContext 48000Hz · running`），
       * 但那是**一次性**的 —— 它中途变成 suspended/interrupted 时，只有周期快照看得见。
       */
      ` · AC ${g(() => ctx?.state)}@${g(() => ctx?.sampleRate)}`
    );
  } catch (e) {
    return `〔快照 ${tag}〕(生成失败: ${e?.message || e})`;
  }
}

/**
 * 把**完整**日志复制走（不只是面板上显示的那几十行）。
 *
 * 排查问题时最需要的就是这个：面板再长也只能显示一屏，
 * 而"流式给出 / 校正结果"是成对出现的，中间夹着别的输出。
 *
 * ⚠️ 末尾**额外拼一份当前快照**（不替换缓冲区）—— 这样这一份日志是**自足**的，
 * 不用再回头问用户"你当时是什么状态"。
 */
async function copyDiag() {
  const text = `${diagLines.join('\n') || '(还没有日志)'}\n${snapshotLine('复制时')}`;
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

/**
 * 导出「最近 N 秒的音频 + 同一时间窗的日志」，各存一个文件。
 *
 * ⚠️ 为什么要有它:排查「识别结果不对」这类问题时，日志只能说**发生过什么**，
 * 而真正缺的是**当时那段音频** —— 有了它，开发者可以在本地把同一段音频重跑一遍，
 * 确定性地复现。
 *
 * ⚠️ 导出的音频是 **ASR 实际吃到的那一份**（16kHz 单声道 int16），不是采集流。
 * 只有这样才能保证重放逐字节相同、结果可复现。它同时也是识别校正用的那份缓冲
 * （`pcmRing`，90 秒），所以这里不需要另建缓冲 —— 切最后 60 秒即可。
 *
 * ⚠️ **隐私:必须是用户主动点。** 这个扩展的卖点是「音频不出本机」，
 * 所以绝不自动存、不在后台存、不在出错时自动存。存下来的文件在用户自己机器上，
 * 发不发由他决定。
 *
 * ⚠️ 任何一步失败都不许抛 —— 打日志/导出绝不能把播放搞挂。
 */
const SAVE_WINDOW_SEC = 60;

function downloadBlob(blob, filename) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function saveAudioAndLog() {
  const cutMs = performance.now() - SAVE_WINDOW_SEC * 1000;

  // —— 音频:从已有的 90 秒环形缓冲里切最后 SAVE_WINDOW_SEC 秒 ——
  let wavBlob = null;
  let audioNote = '';
  /** ⭐ 实际切出来的音频秒数 —— ⑤ 的时间对齐要用它（`take` 在 try 块里，出不来 ✗） */
  let audioTakeSec = 0;
  try {
    const have = pcmRing ? pcmRing.bufferedSeconds : 0;
    const take = Math.min(SAVE_WINDOW_SEC, have);
    audioTakeSec = take;
    if (!pcmRing || take <= 0.1) {
      audioNote = '没有音频可导出(采集还没开始,或刚开始)';
    } else {
      const endSec = pcmRing.writeIndex / pcmRing.sampleRate;
      const pcm = pcmRing.sliceBySeconds(endSec - take, endSec);
      wavBlob = new Blob([encodeWav(pcm, pcmRing.sampleRate)], { type: 'audio/wav' });
      audioNote =
        `音频 ${take.toFixed(1)}s(${pcm.length} 样本 @ ${pcmRing.sampleRate}Hz` +
        `${take < SAVE_WINDOW_SEC ? `，不足 ${SAVE_WINDOW_SEC}s:采集开始不久` : ''})`;
    }
  } catch (e) {
    audioNote = `音频导出失败 · ${e?.message || e}`;
  }

  // —— 日志:按时间戳切同一个窗口 ——
  // 起点算法收在 lib/diag-window.js（边界取 >=，正好等于 cutMs 的那行算进来）
  const win = diagWindow(diagTimes, cutMs);
  const lines = diagLines.slice(win.from);
  const times = diagTimes.slice(win.from);
  const body = lines.map((t, i) => `[+${((times[i] - DIAG_T0) / 1000).toFixed(3)}s] ${t}`).join('\n');

  // ⚠️ 日志缓冲区是按**行数**留的（`DIAG_KEEP`），不是按秒 ——
  //    所以「最近 60 秒」只是**请求的窗口**，实际能覆盖多久取决于行密度。
  //    实测 8 份导出:平均 1.57~2.40 行/秒、最密 5 秒里 4.4 行/秒 ⇒ 400 行大约够 90 秒以上，
  //    正常情况下装得下 60 秒还有余量。但**出故障时行会突然变密** ——
  //    而那时恰恰最需要日志。所以这里算出**实际覆盖**，不够就明说:
  //    导出头不许在"只覆盖 20 秒"的时候写着"最近 60 秒" ✗
  const nowMs = performance.now();
  const coveredSec =
    win.oldestMs !== null && Number.isFinite(win.oldestMs) ? Math.max(0, (nowMs - win.oldestMs) / 1000) : 0;
  const logCoverNote =
    lines.length === 0
      ? `(这一窗口内没有日志行 —— 缓冲区最早只有 ${coveredSec.toFixed(1)}s 前的记录)\n`
      : coveredSec + 1 < SAVE_WINDOW_SEC
        ? `(⚠ 日志只覆盖最近 ${coveredSec.toFixed(1)} 秒 —— 缓冲区满、更早的行已被挤掉；音频仍是完整 ${SAVE_WINDOW_SEC} 秒)\n`
        : '';

  // —— 识别与显示:同一时间窗内每句的「识别文本 / 实际显示文本」 ——
  // ⚠️ 单独成段,不混进上面的诊断行:那些是**过程**（谁在什么时候做了什么），
  //    这一段是**结果**（这句最后识别成了什么、屏幕上显示成了什么）。
  //    配上同一次导出的 WAV，"识别不对 / 翻译不对"才有得对照。
  // ⚠️ 筛选基准:**识别时间或显示时间任一落在窗口内**。
  //    只按识别时间筛,会**稳定地**丢掉窗口开头那几句 —— 它们识别在窗口之前、
  //    显示落在窗口之内,而"显示比识别晚"是常态(排期 + 翻译要几百毫秒到几秒)。
  //    实测证据:某份导出里第一行是「字幕上屏」,而窗口内没有对应的「整句上屏」。
  const subRows = subLog.filter((r) => r.t >= cutMs || (r.dt != null && r.dt >= cutMs));
  // ⚠️ whisper 返回的文本里可能带换行(它把相邻的小段合成一句)。
  //    原样打印会把导出的版式打断、缩进丢掉,读的人会以为那是另外几句 ✗
  const flat = (s) => String(s == null ? '' : s).replace(/\s*\n\s*/g, ' / ').trim();
  const subBody = subRows
    .map((r) => {
      const at = `[+${((r.t - DIAG_T0) / 1000).toFixed(3)}s]`;
      // ⚠️「还没显示」和「未记录」是两回事:前者是译文没赶上（字幕会等），
      //    后者是识别那条已被环形缓冲挤掉（`asr` 里已经写着「(未记录)」）。
      const shown = r.shown === null ? '（还没显示）' : flat(r.shown) || '（空）';
      return `${at} 识别  ${flat(r.asr) || '（空）'}\n${' '.repeat(at.length)} 显示  ${shown}`;
    })
    .join('\n');
  const subNote =
    subRows.length === 0
      ? '(这一窗口内没有记录)'
      : `共 ${subRows.length} 句` + (subLog.length >= SUBLOG_KEEP ? '，缓冲区已满、更早的句被挤掉了' : '');

  /**
   * ⭐ ⑤ 音频与日志的**时间对齐** —— 原来只能假设"音频起点 = 日志第一行" ✗
   *
   * 算法收在 `lib/diag-window.js` 的 `formatAlignNote` 里 ✓ —— 页面脚本在 smoke-test
   * 里加载不了，凡是需要被断言的行为都得落在 `lib/`（这个模块存在的理由，见它文件头）。
   */
  const alignNote = formatAlignNote({
    audioTakeSec,
    nowMs,
    logFromMs: times.length ? times[0] : NaN,
    logToMs: times.length ? times[times.length - 1] : NaN,
    lineCount: lines.length,
    t0: DIAG_T0,
  });

  /**
   * ⭐ ④ 配置快照 —— 原来导出头只有 `录制格式` / `视频码率` / `VAD 自检` ✗
   *
   * "这句为什么被切成 3.8 秒""那个百分比为什么读不了"这类问题,
   * 一半的答案在**设置页里** ✗ —— 而日志里没有,只能反过来问用户 ✗。
   * ⚠️ 取不到就印 `?`,但**不许整行省略**（省略会被读成"这一项不存在" ✗）
   */
  const cfg = (get) => {
    try {
      const v = typeof get === 'function' ? get() : get;
      return v === undefined || v === null || v === '' ? '?' : String(v);
    } catch {
      return '?';
    }
  };
  const sv = () => settings || {};
  const configNote =
    `配置快照(导出时实际生效的值;? = 读不到):\n` +
    `  识别 ${cfg(() => sv()?.asr?.provider)}` +
    /** ⚠️ **识别语言必须印出来**。它曾经默认 `'en'` 而预设里是 `'ja'` ——
     *  于是日语视频全部认错（「お札とかもあるよ」被认成「マリオ」），
     *  而那两个错**看起来像模型问题**，不像配置问题，所以错了很久没人发现 ✗
     *  → 一个没被印出来的配置，错了就没人能一眼看出来。 */
    ` · 识别语言 ${cfg(() => sv()?.asr?.language)}` +
    /**
     * ⚠️ 键名是 `translate`，不是 `translation` ✗
     *    写错过一次 ⇒ 快照上那格一直印 `翻译 ?` ⇒ 查"翻译到底开没开"时看了一眼却没看出问题
     *    （`DEFAULT_SETTINGS` 里是 `translate: { provider, target, ... }`）
     */
    ` · 翻译 ${cfg(() => sv()?.translate?.provider)}` +
    /**
     * ⚠️ **必须印生效值，而不是设定值** —— 两处会不一致，而那个不一致害过一次 ✗
     *
     * 用户选了「本地 Whisper 自断句」（`provider === 'vad-segments'`）：
     * 设置页与滑块显示 `effectiveDelaySec()` = **10 秒** ✓
     * 而 storage 里 `capture.delaySec` 仍是 **7.1** ✓（那是用户自己的旧值，切回别的服务时要用 ✓）
     * ⇒ 只印裸值就会出现「**UI 说 10、日志说 7.1**」✗ —— 而看到日志的人会以为新模式没生效，
     *    于是往"新路没接上"那个方向查了整整一轮（实测踩过 ✗）。
     *
     * ⇒ 印生效值；**两个不一致时把设定值也带上** ✓ —— 那本身就是要能一眼看出来的信息。
     */
    ` · 目标延迟 ${cfg(() => {
      const eff = effectiveDelaySec(sv());
      const raw = Number(sv()?.capture?.delaySec);
      return Number.isFinite(raw) && Math.abs(raw - eff) > 1e-6
        ? `${eff}（设定 ${raw}）`
        : eff;
    })}s` +
    // ⭐ 新路延迟下限必须印出来 —— 否则"滑块调了 4.7 而实际还是 10"这件事在日志里看不见 ✗
    //    （用户就是被它困住的：以为降下去了，其实被这个下限顶着 ✓）
    /**
     * ⚠️ 三元必须写在 `cfg` 回调**里面** ✗ ——
     *    `cfg()` 返回的是**字符串**（`String(v)`）⇒ `'0'` 是 truthy ⇒
     *    `cfg(() => (… ? 1 : 0)) ? A : B` **永远走 A** ✗
     *    ⇒ 旧路会被印成「新路下限 6.5s」（实测踩到：旧路那轮日志印的正是 6.5）✗
     *    ⇒ 让 `cfg` 去字符串化，三元放在回调里 ✓
     */
    ` · ${cfg(() => (sv()?.asr?.provider === 'vad-segments'
      ? `新路下限 ${newPathMinDelaySec(sv())}s`
      : `旧路下限 ${OLD_PATH_MIN_DELAY_SEC}s`))}` +
    ` · 帧率上限 ${cfg(() => sv()?.capture?.maxFrameRate)}\n` +
    `  VAD 阈值 ${cfg(() => sv()?.asr?.vad?.vadThreshold)}` +
    ` · 静音确认 ${cfg(() => sv()?.asr?.vad?.vadMinSilenceMs)}ms` +
    ` · 收句静音 ${cfg(() => sv()?.asr?.vad?.vadUtteranceEndMs)}ms` +
    ` · 单句上限 ${cfg(() => sv()?.asr?.vad?.vadMaxSpeechSec)}s` +
    ` · 前后留白 ${cfg(() => sv()?.asr?.vad?.vadPadMs)}ms\n` +
    `  合理断句 ${cfg(() => (sv()?.asr?.vad?.vadSmartCut === false ? '关' : '开'))}` +
    /** ⚠️ 这一项**目前不参与丢弃判定**（见 lib/asr/vad.js 的注释）—— 但照样印出来，
     *  否则读日志的人会按它去解释"这句为什么被丢了" ✗ */
    ` · 最短话段 ${cfg(() => sv()?.asr?.vad?.vadMinUtteranceMs)}ms(⚠ 目前不参与丢弃判定)` +
    ` · 延迟画面高度上限 ${cfg(() => sv()?.capture?.delayMaxHeight)}\n` +
      /** ⚠️ **提示词长度必须印出来**。理由见 `promptDiagLine()` 上面那段注释：
       *  v2.66.80 的热词 prompt 让 Whisper 提前停（同一段音频 5.6s 从 22 字掉到 7 字），
       *  而当时日志里**一个字都看不到 prompt**，于是所有症状都被读成"识别不准" ✗。 */
      promptDiagLine();

  const logText =
    `livedtranslate 诊断导出 · v${chrome.runtime.getManifest().version}\n` +
    `导出时刻 ${new Date().toISOString()}\n` +
    `窗口:最近 ${SAVE_WINDOW_SEC} 秒(音频与日志同一基准 performance.now())\n` +
    `${audioNote}\n` +
    logCoverNote +
    alignNote +
    configNote +
    `---\n${body || '(空)'}\n` +
    `\n=== 识别与显示 · ${subNote} ===\n${subBody || '(空)'}\n` +
    `${snapshotLine('导出时')}\n`;

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  downloadBlob(wavBlob, `livedtranslate-${stamp}.wav`);
  downloadBlob(new Blob([logText], { type: 'text/plain;charset=utf-8' }), `livedtranslate-${stamp}.log`);
  diag(`已导出最近 ${SAVE_WINDOW_SEC}s · ${audioNote} · ${lines.length} 行日志`, true);
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

/**
 * 向下取到偶数。
 *
 * ⚠️ 这个函数有两个调用点，而**它们的理由完全不同**，别混为一谈：
 *   ① 采集侧（`startCapture` 里，给原始 tab-capture 轨做取偶）—— 理由见那段的长注释；
 *   ② 延迟画面降分辨率那条路 —— 那里**本来就在缩放**，取偶不增加任何成本，
 *      而它确实会产出奇数（`Math.round(2561 × 1440 / 1441)` = **2559**）。
 *      所以那一处是"顺手规范化"，**不是在修什么** ✓
 *
 * ⚠️ 而曾经有过一段**误判**，记在这里免得下次又删一遍：
 * 反馈者的标签页是 **2561×1441**（两个都是奇数 —— 比标准的 2560×1440 各多 1 像素），
 * 而他的录制器一个字节都没产出。当时猜"奇数宽高让编码器产不出数据"，于是加了取偶。
 * 后来**两次"实测推翻"**了它：
 *   ① canvas 直喂编码器:`2561×1441`（奇数）产出 2,524,851 字节 ✓
 *   ② 真实标签页采集:窗口 2561×1441，正常录出 26.6 MB ✓
 * → 于是 v2.66.31 把采集侧那处**删掉了**（"收益为零、代价未知"）。
 *
 * ⚠️⚠️ 而**删错了** —— 那两次测试都**没有落在** `MediaRecorder + avc1+mp4a + 2561×1441@30`
 * 这个确切组合上 ✗。编码器拒绝的是"**配置**"（codecs + 尺寸 + 帧率 + 码率的组合），
 * 换任何一个维度就不是同一个配置了。真实复现见 `startCapture` 里那段。
 *
 * 返回 0 表示"给的值没法用"（调用方决定退回原样）。
 */
function evenFloor(n) {
  const v = Math.floor(Number(n) || 0);
  return v >= 2 ? v - (v % 2) : 0;
}

async function startCapture() {
  showOverlay('正在取得标签页画面…', '浏览器会同时把原标签页静音——这是 tabCapture 的固有行为，声音改由本页播放。', '');
  diag('正在取得标签页流…', true);

  // 每次新采集从零开始 —— 否则上一次的失败次数会累加到这一次的快照里，读起来会误导
  appendFails = 0;
  lastAppendError = null;
  /**
   * ⚠️ 先清掉上一次的定时器再建新的 —— 否则"开始 → 停止 → 再开始"会累积多个，
   * 越跑越密（那正是"用着用着就卡了"的成因）。`stopAll()` 里也会清一次，两道保险。
   */
  clearInterval(snapTimer);
  snapTimer = setInterval(() => diag(snapshotLine('周期'), false), SNAP_PERIOD_MS);

  /**
   * 页面被切到后台时**即时**说一声 —— 以前只有快照里能看到可见性，
   * 而快照 60 秒才一次，中途切走时日志里一片空白 ✗（实测就是这样）。
   *
   * ⚠️ 措辞留余地:我们只观测到"hidden 期间字节几乎不涨"这一条**相关**，
   * 没有对照实验，所以是"可能被节流"，不是"就会黑屏" ✗。
   */
  if (visHandler) document.removeEventListener('visibilitychange', visHandler);
  visHandler = () => {
    if (document.visibilityState === 'hidden') {
      diag(
        '⚠ 播放页被切到后台了 —— 画面采集可能被浏览器节流，画面/声音可能停住。把本页保持在前台可见。',
        false,
      );
    } else {
      diag('播放页已回到前台', false);
    }
  };
  document.addEventListener('visibilitychange', visHandler);

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

  /**
   * 奇数尺寸取偶 —— **v2.66.31 删过，这里恢复**，而这次的理由是对的。
   *
   * ⭐ 真实复现（v2.66.40，反馈者的导出日志）：
   *     已取得流 · 视频 **2561×1441@30**
   *     录制格式 · video/mp4;codecs="avc1.42E01E,mp4a.40.2"（H.264，通常硬件编码）
   *     ⚠ 录制器报错 · **EncodingError: The given encoder configuration is not supported by the encoder.**
   *     ⚠ 录制器停了 · 已输出 **0 字节／0 片、跑了 0 秒**
   *     → 而**字幕照常**（走独立音频管线）→ 用户看到的就是「只有字幕，没有画面和声音」✗
   *   同一个用户**手动换成 VP8 就能录** ✓
   *
   * ⚠️ 当初为什么删错了 —— 那两次"实测推翻"都没有落在
   * `MediaRecorder + avc1+mp4a + 2561×1441@30` 这个确切组合上 ✗。
   * 详见 `evenFloor` 的注释。
   *
   * ⚠️⚠️ **而"奇数就是病因"这个猜测，真机实测同样没复现（v2.66.58 补记）。**
   * Edge 155 / Windows / 无头（软件编码）上，`2561×1441` + `avc1.42E01E,mp4a.40.2`
   * 正常录出 **877,000 字节**；`3840×2160@45 + 78.6 Mbps` 也正常。
   * 所以取偶**不是**治那个 `EncodingError` 的药 —— 它只是"别把不规整的尺寸递下去"的规范化，
   * 在硬件编码器上仍可能有用（那类 MFT 对尺寸的容忍度比软件编码低），代价又极小，所以保留。
   * 真正的解药是 `lib/delayed-player.js` 的**编码器回落链** ✓
   *
   * ⚠️ 另一个曾经的嫌疑是 AAC（`mp4a`）—— 真机上 **MP4+Opus** 也确实可用
   * （`avc1.640033,opus` 录出 2,019,000 字节），所以候选里保留了两档：
   * 先 AAC（有平台编码器时最常规），再 Opus（Chrome 内置，兜住没有 AAC 的机器）。
   *
   * ⚠️ `applyConstraints` 在原始 tab-capture 轨上究竟会不会真的改尺寸，**仍然没实测过** ✗
   * —— 所以它失败时必须**按原样继续**，不能让采集整个坏掉。
   */
  let evenNote = '';
  let evenFail = '';
  let evenIgnored = false;
  let evenFps = 0;
  try {
    const s0 = vtrack.getSettings();
    const w0 = Number(s0.width) || 0;
    const h0 = Number(s0.height) || 0;
    const w1 = evenFloor(w0);
    const h1 = evenFloor(h0);
    // 只有真的是奇数才动 —— 偶数本来就是对的，碰它没有收益
    if (w1 && h1 && (w1 !== w0 || h1 !== h0)) {
      /**
       * ⚠️ `applyConstraints` 是**整组替换**约束：没写进去的属性会恢复成默认值
       * （MDN 写得很明确）。所以必须把 `maxFrameRate` 一起带上 ——
       * 否则取偶会顺手把帧率上限丢掉，4K 60fps 的源照 60 采集，
       * 正好抵消掉这里想省的 CPU，而日志还会照着旧变量印"（上限 60）"，等于在说谎 ✗
       */
      const c = { width: w1, height: h1 };
      if (maxFrameRate > 0) c.frameRate = { max: maxFrameRate };
      await vtrack.applyConstraints(c);
      const s1 = vtrack.getSettings();
      const w2 = Number(s1.width) || 0;
      const h2 = Number(s1.height) || 0;
      evenFps = Number(s1.frameRate) || 0;
      evenNote = `${w0}×${h0} → ${w2 || '?'}×${h2 || '?'}`;
      evenIgnored = w2 === w0 && h2 === h0;
    }
  } catch (e) {
    evenFail = (e && (e.message || e.name)) || String(e);
  }

  const vs = vtrack.getSettings();
  diag(
    `已取得流 · 视频 ${vs.width || '?'}×${vs.height || '?'}${vs.frameRate ? `@${Math.round(vs.frameRate)}` : ''}` +
      `${maxFrameRate ? `（上限 ${maxFrameRate}）` : ''}`,
    true,
  );
  // 取偶的结果要能一眼看到 —— 否则"到底改没改、改成了什么"只能靠猜
  if (evenNote) {
    diag(
      evenIgnored
        ? `奇数尺寸取偶 · 请求了 ${evenNote}，但浏览器没照做（按原样继续）`
        : `奇数尺寸取偶 · ${evenNote} —— 编码器对奇数分辨率可能直接拒绝`,
      true,
    );
    /**
     * ⚠️ 取偶会整组替换约束（见上面那段）—— 帧率上限有没有被顺手丢掉，必须能看见。
     * 读回来的 `frameRate` 明显超过用户设的上限，就说明 `frameRate` 约束没生效，
     * 这正是"4K 60fps 吃满 CPU"的入口。
     */
    if (maxFrameRate > 0 && evenFps > maxFrameRate + 1) {
      diag(
        `⚠ 取偶之后帧率上限没保住 · 实际 ${Math.round(evenFps)}fps > 上限 ${maxFrameRate}fps` +
          ` —— 4K 下这会多吃 CPU`,
        true,
      );
    }
  } else if (evenFail) {
    diag(`奇数尺寸取偶失败，按原样继续 · ${evenFail}`, true);
  }

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
      /**
       * ⚠️ 两边都取偶。
       *
       * 在**这一条路**上它是纯粹规范化：`Math.round` 会产出奇数
       * （实测 2561×1440/1441 → 2559），而这条本来就在缩放，取偶不增加成本 ✓
       *
       * ⚠️ 别把这里的理由和**采集侧**那处混起来 —— 采集侧那处的理由是
       * "编码器可能直接拒绝奇数配置"（有真实复现，见 `startCapture` 里的长注释）。
       * 两处都在用同一个 `evenFloor`，但**它们防的不是同一件事** ✗
       */
      const w = evenFloor(((s.width || 1920) * maxHeight) / (s.height || 1080)) || 2;
      const h = evenFloor(maxHeight) || 2;
      /**
       * ⚠️ 同样要把 `maxFrameRate` 带上：`applyConstraints` 是整组替换约束，
       * 漏了它这个"降分辨率省 CPU"的流反而会以更高的帧率跑（见采集侧那段说明）。
       */
      const sc = { width: w, height: h };
      if (maxFrameRate > 0) sc.frameRate = { max: maxFrameRate };
      await st.applyConstraints(sc);
      recordStream = scaled;
      diag(`延迟画面已降到 ${w}×${h}（原 ${s.width}×${s.height}）· 减轻重编码负担`, true);
    } catch (e) {
      diag(`延迟画面降分辨率失败，按原样编码 · ${e.message || e}`, true);
    }
  }

  // —— 延迟画面 ——
  playback = new DelayedPlayback($('video'), {
    delaySec: effectiveDelaySec(settings),
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
        /**
         * ⚠️ 回落链有动作时**必须报**，否则"最后用的是哪个格式、前面为什么没用"只能靠猜 ✗
         * 而这条恰恰是"`isTypeSupported` 说支持、编码器却拒绝"那个 bug 的**唯一证据**。
         */
        const fb = Array.isArray(s.fallbacks) ? s.fallbacks : [];
        if (fb.length) {
          diag(
            (s.retried
              ? `⚠ 启动阶段换过录制格式（上一个起不来）· 已用上面这个重来 · 最近一次失败：${fb[fb.length - 1]}`
              : `⚠ 前 ${fb.length} 个录制格式被编码器拒绝，已自动退到上面这个 · 第一个失败：${fb[0]}`),
            true,
          );
        }
        /**
         * ⚠️ 观察窗里没拿到分片 **不等于**故障 —— v2.66.59 的真机日志打出来了：
         * 4K45 + MP4+AAC，8 秒里只有 3 片（平均 2.7s 一片），因为 Chrome 的 MP4 muxer
         * 按 **fragment 边界**切、`timeslice` 只当参考。所以 3s 窗口内拿不到首片是**常态**。
         *
         * 这条原来写成「⚠ …还没被证实」，在健康启动里也刷一条 —— 警告刷多了就没人看了 ✗。
         * 现在降级成一句说明（不进 console）；真出不来时下面的「缓冲」诊断会用
         * `no-output` / `no-frames` 明确报出来。
         */
        if (s.proven === false) {
          diag(
            `${s.mimeType || '这个格式'} 的首片还没到（观察窗 ${Math.round(MIME_PROBE_MS / 1000)}s）` +
              '—— MP4 按 fragment 边界切、首片常要 2s+，属正常；一直不出会由下面的缓冲诊断报',
            false,
          );
        }
        // 码率直接决定运动画面糊不糊，必须能一眼看到
        if (s.bitrateNote) diag(`视频码率 · ${s.bitrateNote}`, true);
      }
      /**
       * ⚠️ **所有候选都被编码器拒绝** —— 画面和声音都出不来，而字幕照常。
       *
       * 这正是反馈者那条「只有字幕，没有画面和声音」最可能的内核形态：
       * `EncodingError: The given encoder configuration is not supported by the encoder.`
       * 这里要做的不是让用户自己猜，而是**直接说结论 + 给出可试的两条路** ✗
       */
      if (s.phase === 'recorder-failed') {
        const tried = Array.isArray(s.tried) ? s.tried : [];
        diag(
          `⚠ 没有任何录制格式能起来（试了 ${tried.length} 个）—— 画面和声音都出不来，字幕照常 · ` +
            `最后一个失败：${tried[tried.length - 1] || '?'}`,
          true,
        );
        /**
         * ⚠️ 别在这里猜原因。旧文案让用户"调低分辨率/改帧率"——
         * 而真机实测（v2.66.58）里 codec 串的 level、奇数尺寸、78.6 Mbps 高码率**都能正常录**，
         * 所以那三条建议**没有一条**是对症的。真正会走到这里的，最常见的是
         * **这台机器没有可用的 H.264/AAC 编码器**（Windows N 版缺 Media Feature Pack 之类），
         * 而那是改任何采集参数都救不了的 ✗ —— 用户照着做一遍没用，反馈也白给。
         * 所以直接把**编码器原话**摆到遮罩上，并让他把这行发回来。
         */
        showOverlay(
          '录制器起不来',
          `浏览器拒绝了所有录制格式（试了 ${tried.length} 个），所以画面和声音出不来。` +
            '字幕走独立的音频管线，照常工作。',
          `第一个报错：${tried[0] || '（没拿到原因）'} —— 把这一行发给我们就能定位` +
            '（最常见的原因是这台机器没有可用的 H.264 / AAC 编码器，例如 Windows N 版缺 Media Feature Pack）。',
        );
      }
      if (s.phase === 'append-error') {
        appendFails += 1;
        lastAppendError = s.message || '';
        diag(`缓冲写入失败 · ${s.message}`, true);
      }
      // 配额溢出后自救成功了 —— 要让用户知道"卡了一下但恢复了"
      if (s.phase === 'quota-recovered') diag('缓冲配额溢出 · 已清理并重试成功', true);
      /**
       * ⚠️ 录制器**自己**报错 / **自己**停了 —— 这两个事件以前没有任何 handler，
       * 于是故障只剩"字节不涨 / 缓冲填不上"这种**结果**，日志里看不到**原因**。
       *
       * 措辞要给出可判断的后果:录制器停了 = 画面和声音都会停
       * （声音来自延迟 `<video>` 的音轨），而字幕走独立音频管线、照常 ——
       * 这正是用户报的那条「只有字幕没画面没声音」的形态之一。
       */
      if (s.phase === 'recorder-error') {
        diag(
          `⚠ 录制器报错 · ${s.message} —— 录制一断，画面和声音都会停（字幕走独立管线，照常）` +
            // 没被证实的格式崩了，说明"启动时没抓到"而已 —— 把这层因果说出来
            (s.proven === false ? '（注：这个格式在启动观察窗里就没被证实）' : ''),
          true,
        );
      }
      if (s.phase === 'recorder-stopped') {
        diag(
          `⚠ 录制器停了（不是我们停的）· 已输出 ${s.bytes || 0} 字节／${s.chunks || 0} 片、` +
            `跑了 ${Math.round((s.elapsedMs || 0) / 1000)} 秒 —— 来源流可能断了（标签页关闭/跳转、编码器出错）`,
          true,
        );
      }
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
  /**
   * ⚠️ `start()` 现在会返回 `false` = **所有录制格式都被编码器拒绝**。
   * 那种情况它**不抛异常**（抛了下面的识别就不会启动，字幕一起没 ✗），
   * 所以这里要自己分辨，别把"没建起来"说成"已建立" ✗
   */
  const recorderOk = await playback.start(recordStream);
  diag(recorderOk === false ? '⚠ 媒体缓冲没建起来（没有可用的录制格式）' : '媒体缓冲已建立', true);

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
    /**
     * ⚠️ `bytes` 是**录制器实际吐出来的字节数**（`delayed-player.js` 的 `ondataavailable` 累加）。
     *
     * 它和 `掉帧` 是两个不同层面的读数，**必须一起看才能分开两种完全不同的故障**：
     *   · `掉帧` 来自 `video.getVideoPlaybackQuality()` —— **播放/解码侧**
     *   · `bytes` 来自 `MediaRecorder` —— **录制/编码侧**
     *
     * 而这个区分是有实际意义的（实测反馈里两种都出现过）：
     *   · `bytes` 一直是 0    → 录制器什么都没产出 **（连音频都没录到）** —— 修在录制侧
     *   · `bytes` 在涨        → 录到了，但 `appendBuffer` 进不去 —— 修在缓冲接收侧
     *     （这两种的修法完全不同，而以前只显示"收到 0 帧"，**分不出来**）
     */
    const bytes = Number(playback?.bytes) || 0;
    const bytesText =
      bytes === 0 ? '0 字节' : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
    const hunch =
      bytes === 0
        ? '⚠️ 录制器一个字节都没吐出来（连音频也没有）—— 问题在录制/编码侧，不是来源画面静止。'
        : '⚠️ 录制器在输出，但缓冲一直填不上 —— 数据可能进不了缓冲（appendBuffer），也可能来源没有新画面。看旁边的「收到 N 帧」和「见底 N 次」能分辨。';
    return (
      `已等 ${waited} 秒 · 缓冲 ${ahead} · 收到 ${total} 帧（掉 ${dropped}） · 见底 ${stalls} 次 · 录制器已输出 ${bytesText}。` +
      hunch
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

  /**
   * 定时快照（2s / 8s / 20s 各一行）。
   *
   * ⚠️ 为什么不能只靠"事件触发时才打日志":那种设计在「某件事从没发生」的故障里
   * **什么都不留** —— 而这一轮排查黑屏时遇到的正是这一类。
   *
   * ⚠️ 三个固定时间点、每次一行:既能覆盖"启动初期 / 起播前后 / 稳定期"，
   * 又不会把 400 行缓冲区吃光（吃光就等于丢掉启动阶段，而那最需要）。
   */
  [2, 8, 20].forEach((sec) => {
    setTimeout(() => diag(snapshotLine(`${sec}s`), false), sec * 1000);
  });

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
  // ⚠️ 顺带把「这次识别带了多长的提示词」印进**真机日志**（不只是导出时才有的配置快照）。
  //    理由见 promptDiagLine() 上面那段注释 —— 这个输入会改变解码行为，
  //    而它曾经完全不可见，让"每段少认一半的字"看起来像模型问题。
  diag(promptDiagLine().trim(), true);
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
    //
    // ⚠️ 但「丢弃一段识别结果」走的**也是** `status: 'vad'`，而它和心跳完全不是一回事：
    // 心跳是每秒约 3 行的正常读数，而丢弃记录是**质量闸门真的扔了一段**。
    // 混在同一个 `VAD ·` 前缀里 → 在导出的 .log 里根本分不出来，
    // 于是"这句是漏听了、还是被闸门扔了"永远判不了（实测踩过：用户丢了三句，
    // 从导出里完全看不出原因）。
    // 所以给它一个**独立、可 grep** 的前缀，并提升到 warn 级（进控制台）。
    else if (ev.status === 'vad' && ev.detail) {
      if (ev.detail.startsWith('丢弃一段识别结果')) diag(`⚠ 闸门丢弃 · ${ev.detail}`, true);
      else diag(`VAD · ${ev.detail}`, false);
    }
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
    /**
     * ⚠️ 名单要和 `asrReadiness()` 里那组「共用本地 Whisper 服务地址」的服务**保持一致**
     * （`lib/settings.js` 里 `whisper-chunked` / `vad` / `vad-segments` 同一支）。
     *
     * 不一致的后果是静默的：本地服务没跑时，`vad-segments` 的用户只会看到一条光秃秃的
     * 识别出错，**没有任何地方提示他去检查服务地址** —— 而那正是他唯一要改的东西。
     * （`dashscope` 刚接进来时就是这个问题：404 模型名不对，提示却让他查本地地址，
     * 方向完全反了。所以这里按"是否走本地 Whisper"判，不是按"是不是 vad"。）
     */
    const isLocal = provider === 'vad' || provider === 'whisper-chunked' || provider === 'vad-segments';
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
    // ⚠️ 这里也要记「文本到手了」—— 原来只记 `final` 那一支，
    // 于是走 utterance-end 收句时 `lastResultAt` 会一直陈旧，
    // 看门狗据此把"其实一直在出结果"误判成"没有结果"。
    lastResultAt = Date.now();
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
 *
 * ⚠️ `maxSpanSec` 原来是 **15**，实测在口语速率下一条字幕能到 **89~127 字** ✗
 *    （探针驱动真源码：60 秒连续说话、分片每 1.5 秒一个 → 每条 89 字）。
 *    收到 **10** 秒 → 一条最多约 54~85 字 ✓。
 * ⚠️ `maxChars` 是**另一条独立上限**：有些服务不给时间戳，那时 `spanSec` 恒为 0，
 *    `maxSpanSec` 永远不命中（实测能攒成 359 字）✗ —— 所以两条都要给。见 lib/utterance.js。
 */
const utterances = new UtteranceAccumulator({ maxSpanSec: 10, maxChars: 60, watchdogMs: 3000 });

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
/**
 * 「合理断句」开着没。**默认关**（v2.66.79 起；闭环 A/B 实测开着让句子更碎）。
 *
 * ⚠️ 判 `!== false` 而不是 `=== true`，且必须和 `lib/asr/vad.js` 读它的方式**一致** ——
 *    两处不一致就会出现"断句按开着做、合并按关着做"这种半开半关的状态。
 * ⚠️ 这里的 `settings` 一定来自 `getSettings()`（已合并默认值），而
 *    `DEFAULT_SETTINGS.asr.vad.vadSmartCut` 是 false ⇒ 没调过的人读到 false。
 *    **默认关由默认值保证，不由这个判法保证**；改成 `=== true` 收益为零、还要两处同改。
 */
function smartCutEnabled() {
  return settings?.asr?.vad?.vadSmartCut !== false;
}

/**
 * 这条短段该不该并进上一句？该并就并掉，返回 true（调用方**不要再排期**）。
 *
 * ⚠️ 时间轴一个字不动：第一段照常按原排期上屏，这里只把文本并回去、原地替换那一条
 *    （复用"译文晚到时替换已上屏条目"那套机制）。
 *    刻意**不**取消第一段的排期去等这条短段 —— 那会让它晚 2~5 秒才出现，
 *    而实测的识别滞后本来就贴着延迟预算（6.6s），再等就必然迟到。
 */
function tryMergeTail(u) {
  const prev = segs[segs.length - 1];
  const trigger = tailMergeTrigger(prev, u, { smartCut: smartCutEnabled() });
  if (!trigger) return false;
  /**
   * ⚠️ prev 必须**还能被改到**，否则这条文本会凭空消失。
   *   两种都行：还排在队里（上屏时就用新文本）、或正显示在屏幕上（替换它）。
   *   "已经上屏、又被挤出 history"的那种不行 —— 改它没人看得见，这条就白并了。
   */
  const stillQueued = schedule.items.includes(prev);
  const onScreen = rendered.has(prev.id);
  if (!stillQueued && !onScreen) return false;

  prev.original = mergeTailText(prev.original, u.text);
  prev.tailMerged = (Number(prev.tailMerged) || 0) + 1;
  /**
   * 重新翻一次 —— 但**不等待**：旧译文先留着（有就显示），新译文回来原地替换。
   * ⚠️ 不能把 `translation` 清空：`renderable()` 见到空译文会把条目**扣住**最多 4 秒，
   *    那就正好破坏了"上屏时间不变"这个前提。
   */
  prev.translated = false;
  prev.inFlight = false;
  prev.startedAt = 0;
  // 让正在飞的那份译文作废（否则它回来会把**旧短文本**的译文盖上去，见 translateSegment）
  prev.gen = (Number(prev.gen) || 0) + 1;
  if (onScreen) renderSubs();
  diag(
    `并进上一句 · ${String(u.text).length} 字（${trigger}）· 并后 ${prev.original.length} 字 · 上屏时刻不变`,
    false,
  );
  return true;
}

function scheduleUtterance(u) {
  const text = String(u?.text || '').trim();
  if (!text) return;

  // 短段并进上一句 —— 并掉了就**不建新条目**（时间轴不动，也不会多出一条字幕）
  if (tryMergeTail({ ...u, text })) return;

  const id = `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const timing = { start: u.start, duration: u.duration };
  /**
   * ⚠️ 只调**一次** `currentDelayMs()`（它有副作用，会刷 EMA）——
   *    排期和诊断必须用**同一个数**，否则日志里那格解释不了排在哪儿 ✗
   */
  const usedDelayMs = currentDelayMs();
  const at = schedule.push(
    // ⚠️ `cut` 要存进条目：合并判据要看**上一段**的切法，那时 u 已经过去了
    { id, original: text, translation: '', cut: String(u.cut || '') },
    timing,
    firstAudioAt || Date.now(),
    usedDelayMs,
    Number(settings.capture.syncOffsetMs) || 0,
  );

  // 拿住排期条目的引用：译文回来时要能直接改到它，或者改到已经上屏的那一份
  const item = schedule.items[schedule.items.length - 1];
  if (item) {
    item.arrivedAt = Date.now();
    /**
     * ⭐ 把「推入排期那一刻的 `at`」原样存一份 —— 诊断要用它判「排期有没有被挪过」。
     *
     * ⚠️ `item.at` 会被 `resync()` **每拍重算**（延迟一变就整体平移，见
     *    `lib/delayed-player.js` 的 `resync`）。而"上屏时机乱"要查的正是
     *    「排期在排队期间动没动、动了多少」✗ —— 所以**必须**留一个推入时的快照，
     *    否则到上屏那一刻只能看到最终值，中间挪了几次、挪了多少全都看不见 ✗。
     */
    item.atPush = at;
    /**
     * ⭐ **"人真正开口"那一格**（用户报「有时候早有时候晚」，而日志量不到 ✓）
     *
     * `at` 是 `firstAudioAt + u.start*1000 + 延迟 + 同步偏移`（见上方的 `schedule.push`）✗
     * ⇒ 反推"词首绝对时刻"需要存两个数：
     *   · `delayPlusSyncMs` —— 这句排期里**加进去的延迟预算**（`at` 减去它就是音频时刻 ✓）
     *   · `wordShiftMs`     —— `words[0].start` 相对 `u.start` 的偏移
     *     （锚点被关掉时它让 `u.start = offset + words[0].start`，所以 `词首 == at − 预算`；
     *       而锚点再打开时它会≠0，正好把锚点位移显出来 ✓）
     *
     * ⇒ 于是 `diagShown` 能印 `词首`，而 `真 − 词首` 就是**观众真的看到**这句比人开口
     *   早/晚多少 —— 那才是"早/晚"的定义 ✓（`比排期晚` 只量"上屏 vs `at`"，量不到这个 ✗）
     */
    item.delayPlusSyncMs = usedDelayMs + (Number(settings.capture.syncOffsetMs) || 0);
    item.wordShiftMs =
      Number.isFinite(Number(u.wordStart)) && Number.isFinite(Number(u.start))
        ? (Number(u.wordStart) - Number(u.start)) * 1000
        : null;
    segs.push(item);
    if (segs.length > 40) segs.shift();
  }

  // ⚠️ 这里用**目标延迟**而不是 EMA 实测值，而且不调用 currentDelayMs()。
  // 那个函数有副作用（刷 EMA），在诊断里顺手调它会污染排期用的那个指数平均。
  const delayForDiagSec = effectiveDelaySec(settings);
  /**
   * 距上屏还有多久 —— **会为负**（排期时刻已经过去了）。
   *
   * ⚠️ 这里踩过：直接印 `${x}s 后`，于是日志里出现「**-2.3s 后**」这种自相矛盾的行
   * （用户实测）。负号的含义是"已经迟了"，不是"还要等负 2.3 秒"。
   */
  /**
   * ⚠️ 两套时钟**成对**取一次，别各取各的。
   *
   * `at` 是 `Date.now()` 口径（epoch ms），而诊断行前缀是 `performance.now()` 口径
   * ⇒ 要印一个能对账的绝对时刻，就必须同时拿到"此刻"的两个读数（见 `formatAtStamp`）。
   * 这里成对取一次，下面的倒计时和 `at=` 用的是**同一对**，所以两格一定自洽。
   */
  const nowEpoch = Date.now();
  const nowPerf = performance.now();
  const remainSec = (at - nowEpoch) / 1000;
  const whenText = remainSec >= 0 ? `${remainSec.toFixed(1)}s 后` : `已迟 ${(-remainSec).toFixed(1)}s`;
  /**
   * ⭐ 把排期时刻**本身**印出来（绝对刻度，可和行前缀直接对账）。
   *
   * ⚠️ 此前这一行只印倒计时 ✗ —— 于是对账要拿 `at − now` 反推 `at`，
   *    而那跨了 `Date.now()` / `performance.now()` 两个基准 ⇒ 永远对不上 ✗
   *    （实测 8 条里 1 条对得上，其余差 0.19~1.45 秒，那个差里混着基准误差。）
   * ⇒ 现在两行都印 `at=`：**印了同一个数，才谈得上"上屏时机乱"到底乱在哪** ✓
   */
  const atStamp = formatAtStamp({ at, atPush: at, now: nowEpoch, perfNow: nowPerf, t0: DIAG_T0 });
  const atNote = atStamp ? `${atStamp} · ` : '';
  /**
   * 识别滞后 = 延迟预算 + 已经迟掉的部分。
   *
   * ⚠️ `asrLagSec > delayForDiagSec` 与 `remainSec < 0` **数学上完全等价** ——
   * 也就是说这两个字段在讲同一件事。所以**分工必须明确**：
   *   `whenText`  是「什么时候上屏」（相对排期）
   *   下面这个   是「识别滞后 vs 延迟预算」（量 + 是否超预算）
   * 因此这里**不再重复写一遍"迟到"**，只把预算摆出来，让那个 ⚠ 有依据可读。
   */
  const asrLagSec = delayForDiagSec - remainSec;
  const overBudget = asrLagSec > delayForDiagSec;
  /**
   * ⚠️ 排期按**目标值**排（`currentDelayMs`），而画面**实际**落后多少是另一回事。
   *    两者差得多时，这一句就会**偏早 / 偏晚**那个差值 —— 而**必须报出来** ✗
   *
   *    原因：用户报过「句子明明很短，但是出来的晚 —— 或者说很早就出来了」✗
   *    而排期如果悄悄按实测值挪（v2.66.83 干过），就变成"字幕时准时不准，
   *    而日志里看不出为什么" ✗ —— 那比偏差本身更难查 ✓
   *
   *    ⇒ 这里只**说清偏差**，不动排期；真正该改的是"缓冲要真的填满"
   *      （或者把目标降下来 —— 即缩短批长，见 `MAX_BATCH_SEC`）✓
   */
  const devSec = scheduleDeviationEma === null ? null : scheduleDeviationEma / 1000;
  const devText =
    devSec === null || Math.abs(devSec) * 1000 < SCHEDULE_DEVIATION_WARN_MS
      ? ''
      : ` · ⚠ 画面实际比目标${devSec < 0 ? '靠前' : '靠后'} ${Math.abs(devSec).toFixed(1)}s` +
        ` ⇒ 这句会${devSec < 0 ? '晚' : '早'} ${Math.abs(devSec).toFixed(1)}s（缓冲没填到目标）`;
  /**
   * 「这条字幕为什么这么长」—— 原来答不出来。
   *
   * ⚠️ `reason` 本来就印着（`max-span` / `max-chars` 就在那一格），但**只有标签没有量**，
   *    于是这两种情况在日志里长得一样 ✗:
   *      `44 字 · utterance-end`  那一段音频本身就说得多（**单**个分片）
   *      `99 字 · max-span`        攒到了上限（**好几个**分片）
   *    —— 而用户报「句子会很长，好像过度合并了」时要判的正是这个。
   * 所以补两个数：**片数**（累没累积）+ **跨度**（那段音频有多久）。
   *
   * ⚠️ 缺值一律印 `?`，**但单位要留着**：别印 `undefined` / `NaN`
   *    （这个项目为裸 `undefined` 和 `98.37255859375ms` 那种 15 位浮点各栽过一次 ✗）。
   *    ⚠️ 而且 `?` 后面**必须**带单位 —— 否则同一行里两个 `?`（片数 / 跨度）分不清谁是谁 ✗
   */
  const fmtNum = (v, digits, suffix) =>
    v === null || v === undefined || !Number.isFinite(Number(v))
      ? `?${suffix}`
      : `${Number(v).toFixed(digits)}${suffix}`;
  // 记下这一句的识别文本；显示文本等它真的上屏时再回填（见 diagShown）。
  // ⚠️ 用上面刚生成的局部 `id`，不要用 `item.id` —— L1193 判过 `if (item)`，
  //    也就是说 `item` 可能是 undefined（排期没接住这个条目），而 `id` 一定在。
  subLog.push({ t: performance.now(), id, asr: String(text || ''), shown: null });
  if (subLog.length > SUBLOG_KEEP) subLog.shift();
  diag(
    // ⚠️ `at=` 放最前面（紧跟行前缀），因为它和行前缀同刻度 ⇒ 一眼就能算出差多少
    `整句上屏 · ${atNote}${whenText} · ${text.length} 字 · ${u.reason}` +
      /**
       * ⚠️ **`切` 必须印** —— 它是**唯一**能一眼分出「这条字幕是哪条路收的」的字段 ✗
       *
       * `u.reason` 是「累积器为什么收句」（`utterance-end` / `max-span` / `max-chars` …），
       * **两条路都会给它** ⇒ 光看它分不出新旧路 ✗
       * 而 `u.cut` 是「这段音频**怎么被切出来的**」：
       *   · 旧路 → `lib/asr/vad.js:2710` 的 `reason`（`utterance-end` / `max-length` / …）
       *   · 新路 → `vad.js:3212` 固定写 `'whisper-segment'` ✓
       *
       * 实测踩过：用户选了新模式，而日志里 `新断句` 一条都没有 ——
       * 于是查了一整轮"新路为什么没跑"✗，而我**没有任何一条日志能证明它跑了没有** ✗
       * （`新断句 · 批 N` 是 `status` 事件，只保留最后一条；`累积 1 片` 两条路都有）
       * ⇒ 印出 `cut` 之后，这类问题一眼就能判 ✓
       */
      ` · 切 ${u.cut || '?'}` +
      ` · 累积 ${fmtNum(u.parts, 0, ' 片')} · 跨度 ${fmtNum(u.duration, 1, 's')}` +
      ` · 识别滞后 ${asrLagSec.toFixed(1)}s${overBudget ? ` ⚠ 超过延迟预算 ${delayForDiagSec}s` : ''}` +
      devText,
    overBudget,
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
  /**
   * 这一趟翻译对应的**文本版本**。
   *
   * ⚠️ 翻的过程中这句可能被"合并短段"追加了新内容 —— 那份译文对应的是**旧的短文本**，
   *    贴上去就是"字幕显示半句译文、而原文已经是整句"，比不翻还糟。
   *    所以回来时对一次号，对不上就作废，并且**不能**把 translated 置真
   *    （置真了泵就不会重翻，字幕会永久停在错译文上）。
   */
  const gen = Number(seg.gen) || 0;

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
          onNote: (note) => {
            // ⚠️ 必须限流:DeepL 那句「术语表未生效」是**每句翻译**都回调一次，
            // 不限流会把约两分钟的缓冲区吃掉一大块（实测同一句 8~9 次）。
            const t = takeNote(note);
            if (t) diag(`术语表 · ${t}`, true);
          },
        });
        translateEma =
          translateEma === null ? Date.now() - t0 : translateEma + (Date.now() - t0 - translateEma) * 0.3;
        const cost = Date.now() - t0;
        const late = Date.now() - seg.at;
        diag(
          late > 0
            ? `翻译完成 · ${cost}ms · 迟到 ${Math.round(late)}ms（窗口只有 ${Math.round(Math.max(0, seg.at - t0))}ms，把「画面延迟」调大）`
            : `翻译完成 · ${cost}ms · 赶上了（余量 ${Math.round(-late)}ms）`,
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
      // 翻译成功 ⇒ 失败连击清零（服务恢复后立刻回到"等译文"的正常行为 ✓）
      translateFailStreak = 0;
      if ((Number(seg.gen) || 0) !== gen) {
        // 期间被并进了新内容 → 这份译文作废（原文已经变长，它只对应前半截）
        diag(`译文作废 · 这句刚被并进了新内容，需重翻`, true);
      } else {
        seg.translation = out;
        // 还没上屏 → 上屏时自带译文；已经上屏 → 直接替换那一条
        if (rendered.has(seg.id)) renderSubs();
      }
    }
  } catch (e) {
    /**
     * 🔴 **连续翻译失败要计数** ✗ —— 否则它会变成"每条字幕都等 4 秒"的吞吐天花板
     *
     * 实测（2026-10-23 闭环，`xhsp-nofix-B`）：出网被拦，`translate.googleapis.com`
     * 全程 `Failed to fetch` / 12 秒超时 ⇒ 52 条字幕**全部**撞上 `LATE_TRANSLATION_MS`
     * 的 4 秒兜底、全部显示日文原文 ✗ ⇒ 显示吞吐被钉死 **4 秒/条**，
     * 而识别约 **2.5 秒/条** ⇒ 队列越积越长 ⇒「比排期晚」从 6 秒涨到 **19 秒** ✗
     * 而观众体感就是"**普遍都晚那么多**" ✓
     *
     * ⇒ 连续失败够多就**不再等译文**：立刻显示原文，译文真到了再由 `renderSubs()` 补上
     *    （那条路径本来就有 ✓ 见上面 `if (rendered.has(seg.id)) renderSubs();`）
     * ⚠️ 成功一次就复位 —— 服务恢复后立刻回到"等译文"的正常行为 ✓
     */
    translateFailStreak += 1;
    if (translateFailStreak === TRANSLATE_FAIL_STREAK) {
      diag(
        `翻译失败 · 连续 ${translateFailStreak} 次 ⇒ 不再等译文（否则每条白等 ${LATE_TRANSLATION_MS}ms，` +
          `字幕会一路变晚 ✗）；原文先上屏，译文回来再补`,
        true,
      );
    }
    diag(`翻译失败 · ${Date.now() - t0}ms · ${e?.message || e}`, true);
  } finally {
    // 必须无条件归位。原来这一步写在正常路径末尾，只要请求挂住一次，
    // 在飞计数就永久少还一份，攒够上限后翻译彻底停摆。
    seg.inFlight = false;
    seg.startedAt = 0;
    // ⚠️ 被合并改过文本的**不算翻完** —— 留 false 让泵重翻，否则字幕停在旧译文上
    seg.translated = (Number(seg.gen) || 0) === gen;
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

/**
 * 排期用的延迟值（毫秒）—— **我们向播放器要的那个延迟**。
 *
 * ⚠️ 这里用的是 `effectiveDelaySec`（**目标值**），不是实测值。为什么，是用户定的：
 *
 *   > 「宁可早，不晚 —— 记得不是绝对的。如果句子真的很长可以稍微晚点。
 *   >   但是不要说：句子明明很短，但是出来的晚 —— 或者说很早就出来了」
 *
 *   ⇒ **目标不是"偏早"也不是"偏晚"，而是"误差小到看不出来"** ✓
 *   ⇒ 而排期按**目标值**排，就等于"假定画面真的在目标延迟那个位置" ✓
 *      —— 那是**设计意图**，也是字幕本该对齐的地方 ✓
 *
 * ⚠️⚠️ 而 `actualDelaySec`（缓冲领先播放头多少）**明显小于**目标值时，
 *    画面**其实还在更前面**，按目标排就会让这句**偏晚** ✗ ——
 *    而**这个偏差不许悄悄用排期去掩盖**（那会让"短句晚/早"变得看不出原因）✗
 *    ⇒ 所以这里**只报警**（`scheduleDeviationMs`，见调用处那行诊断）✓，
 *      **不改排期** ✓；真正的修法是**让 actual 达到 target**（缩短批长 / 让缓冲真的填满）✓
 *
 * ⚠️ 例外：还没测到实测值时，回落到目标值（那是唯一能用的估计）。
 */
function currentDelayMs() {
  const target = effectiveDelaySec(settings) * 1000;
  const lag = recorderLagMs();
  const actual = playback?.actualDelaySec;
  /**
   * 实测与目标差多少毫秒（负 = 画面比目标**更靠前** ⇒ 按目标排会**晚**）。
   * `null` = 还没测到。
   */
  scheduleDeviationMs = Number.isFinite(actual) && actual > 0 ? actual * 1000 - target : null;
  // 平滑只为诊断可读（实测是台阶值，瞬时值抖）；**不参与排期**
  if (scheduleDeviationMs !== null) {
    scheduleDeviationEma =
      scheduleDeviationEma === null
        ? scheduleDeviationMs
        : scheduleDeviationEma + (scheduleDeviationMs - scheduleDeviationEma) * 0.2;
  }
  return target + lag;
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
  /**
   * ⚠️ 拍子收尾抽成函数 —— 让 `setTimeout(pumpSubtitles, 100)` 在文件里**只剩一处** ✓
   *
   * 为什么要这样（实测）：把 `between('schedule.due(', 'setTimeout(pumpSubtitles')` 当
   * "渲染循环"的那条断言，用的是**第一个**终点锚点 ✗ ⇒ 按批分支里的提前退出会把窗口截短
   * （981 字符），于是 `lastShownAt = Date.now()` / `shownCount += …` 落到窗口外
   * ⇒ **在完全正确的代码上先红** ✗（这一族今天栽过两次）
   */
  const pumpLater = () => setTimeout(pumpSubtitles, 100);

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
      /**
       * ⚠️ `bytes` = 录制器吐出的字节数（录制/编码侧）；`掉帧` = video 的解码质量（播放/解码侧）。
       *
       * 两个一起看才能分开两种**修法完全不同**的故障：
       *   0 字节而前方一直不涨  → 录制侧没产出（连音频都没有）
       *   有字节而前方一直不涨  → 录制正常，数据进不了 SourceBuffer
       * 以前这两行都不显示 `bytes`，于是「黑屏」只能靠猜 —— 实测里确实猜错过一次。
       */
      const bytes = Number(playback.bytes) || 0;
      const bytesText =
        bytes === 0 ? '0 字节' : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
      /**
       * ⚠️ `bytes === 0` 在**启动初期是正常的** —— MediaRecorder 要几秒才吐出第一片。
       *
       * 真实标签页采集实测（两次）:前几拍是 `0 字节`，随后就变成 13~27 MB，
       * 而那两次的启动**完全健康**。所以「0 字节」本身不是故障信号，
       * **只有超过宽限期仍然是 0 才是** —— 反馈者那次是 63 秒仍然 0，那是真故障。
       *
       * ⚠️ 基准必须用 `playback.startedAt`（录制开始那一刻），**不是"遮罩显示的时刻"**：
       * 遮罩要 15 秒兜底才出现，拿它当基准等于把宽限期白送掉。
       * （判据基准选错这个项目栽过两次，所以这里写清楚。）
       */
      const recElapsedMs = playback.startedAt ? Date.now() - Number(playback.startedAt) : 0;
      /**
       * ⚠️ 判据抽成了纯函数（`lib/delayed-player.js` 的 `classifyThinBuffer`）——
       * 这样断言只要喂数字，不必在假 video 上推进时间。
       *
       * ⚠️ **不能只看 `ahead < 1.5`**：`_tick()` 在 `!locked` 时会提前 return（等缓冲攒够），
       * 所以**起播之前 `bufferAheadSec` 一直接近 0，而且压根没被更新过**。
       * 于是「前方 0.0s」在启动阶段是**预期状态**，不是故障 ——
       * 早先只看 `ahead < 1.5 && bytes > 0`，结果在**完全健康**的启动里报了
       * 「录制器在输出但缓冲填不上：数据进不了 SourceBuffer」，
       * 而**下一行**就是「延迟播放已就绪 · 目标 6.6s」。
       *
       * 这条误报的危害不只是噪音:它把用户**直接引向错的那一层**，
       * 而"录制/采集层 vs 缓冲层"正是排查这个故障最贵的一次分辨。
       */
      const thin = ahead < 1.5;
      /**
       * ⚠️ `recorderInactive` 只在**它自己停了**时为真:我们主动 `stop()` 时
       * `playback.stopped` 已置真，所以不会被算成"自己停的"（否则正常收摊也会报警）。
       * 不把这一条传进去的话，录制器一停就会被误判成 `cannot-append` ✗
       * （前方缓冲被播放头吃光 → 落到"数据进不了 SourceBuffer"，而真正断的是采集）。
       */
      const recorderInactive = playback.recorder?.state === 'inactive' && playback.stopped !== true;
      /**
       * ⚠️ 「只有初始化段」要靠**可播区间数**来判，不能只看字节数。
       * 实测（v2.66.57，静止标签页，4K45）: 记录器 30 秒只输出 **36 字节 / 1 片**，
       * SourceBuffer 里 **0 个区间** —— 那是 fMP4 的文件头，不是画面。
       * 当时日志报的是「缓冲里有数据但画面起不来，卡在采集/编码侧」，把用户引向了编码器，
       * 而真正的原因是**源标签页静止**（tabCapture 只在画面有变化时给帧）。
       */
      const sbRanges = (() => {
        try {
          return playback.sourceBuffer?.buffered?.length ?? 0;
        } catch {
          return 0;
        }
      })();
      const thinKind = thin
        ? classifyThinBuffer({
            elapsedMs: recElapsedMs,
            bytes,
            ranges: sbRanges,
            locked: playback.locked === true,
            delayMs: currentDelayMs(),
            recorderInactive,
          })
        : 'warming';
      const thinNote = !thin
        ? ''
        : thinKind === 'recorder-stopped'
          ? ` ⚠ 录制器已经停了（不是我们停的）：采集断了，画面和声音都会停 —— 看上面那条「录制器停了」`
          : thinKind === 'no-output'
            ? ` ⚠ 录制器还没输出任何数据（已 ${Math.round(recElapsedMs / 1000)} 秒）：可能是录制/编码层面没产出`
            : thinKind === 'no-frames'
              ? ` ⚠ 只收到一个初始化段（${bytes} 字节、0 个可播区间，已 ${Math.round(recElapsedMs / 1000)} 秒）：编码器一帧画面都没拿到 —— 源标签页可能静止（tabCapture 只在画面有变化时给帧；暂停的视频、纯静态页面都会这样）`
              : thinKind === 'never-started'
                ? ` ⚠ 一直没能起播（已 ${Math.round(recElapsedMs / 1000)} 秒）：缓冲里有数据但画面起不来，卡在采集/编码侧`
                : thinKind === 'cannot-append'
                  ? ' ⚠ 录制器在输出但缓冲填不上：数据进不了 SourceBuffer'
                  : bytes === 0
                    ? ' · 录制器还没开始输出（启动初期属正常）'
                    : ' · 缓冲还在攒（启动初期属正常）';
      // 缓冲满却还在掉帧 → 卡在解码/编码侧（CPU/GPU 被抢），不是网络
      /**
       * 掉帧改**按比例**判 —— 原来只看绝对条数，于是
       *   掉帧 1/1195（0.08%） 和 19/330（5.8%）报的是**同一句** ⚠，严重度差 70 倍 ✗。
       * 而一个总在响的警告会被训练成看不见（这一轮已有先例）。
       * ⚠️ 样本不足（< 100 帧）时不下结论 —— 否则 1/10 = 10% 会误报。
       */
      const dropRatio = total >= 100 ? dropped / total : 0;
      const bad = thin || dropRatio > 0.01;
      /**
       * ⚠️ 判定出**真故障**时也要进 console。
       * 原来第二个参数是 `bad && dropped > 0` —— 而那意味着"0 字节"这类故障
       * 永远进不了 console（它们的 dropped 恒为 0），面板一关就只剩"什么都没有"。
       */
      const realFault =
        thinKind === 'no-output' ||
        thinKind === 'no-frames' ||
        thinKind === 'never-started' ||
        thinKind === 'cannot-append' ||
        thinKind === 'recorder-stopped';
      diag(
        `缓冲 · 前方 ${ahead.toFixed(1)}s · 录制器已输出 ${bytesText} · 见底 ${playback.stallCount || 0} 次 · 掉帧 ${dropped}/${total}${
          thin ? ' ⚠ 偏薄' : ''
        }${thinNote}${
          dropRatio > 0.01 && ahead >= 1.5
            ? ` ⚠ 缓冲够却在掉帧（${(dropRatio * 100).toFixed(1)}%）：编码/解码抢不到资源`
            : ''
        }`,
        realFault || (bad && dropped > 0),
      );
    }
  }

  // ⚠️ 每一拍都要重算，不能只在排期时算一次。
  // 实测延迟是**一直在动**的：起播时它才建立起来，之后前方缓冲涨太多时会被跳一次拉回目标。
  // 用户刚调过延迟、或者缓冲还在爬升时，排队中的条目必须跟着走，
  // 否则它们会按旧延迟上屏 —— 现象就是"字幕提前了"。
  // （`smoothRate` 默认关着，所以延迟不会平滑过渡，只会被那两种方式一次改变一个台阶。）
  // 这里顺带把实测延迟的 EMA 也刷新一次（原来一次一句，跟不上变化）。
  //
  // ⭐ **新路**额外限制"一次往前拉"的量（`maxPullForwardMs`）——
  //    实测缓冲只领先 3 秒而目标是 10 秒，`resync` 会一直在往前拉排期：
  //    排期变早 ⇒"字幕提前"，而字幕已在路上 ⇒ 追不上 ⇒"字幕晚"（同一件事的两面）。
  //    详细信息与实测取舍见 `lib/delayed-player.js` 的 `MAX_PULL_FORWARD_MS` 注释。
  //    ⚠️ **旧路不传这个参数** ⇒ `Infinity` ⇒ 逐字不变 ✓
  //    ⚠️ 判据和 `effectiveDelaySec` / `holdEnabled` 同一套（那两处也各自内联了一份）✓
  const onWhisperSegmentsForResync =
    settings?.asr?.provider === 'vad-segments' ||
    settings?.asr?.whisperChunked?.whisperSegments === true;
  schedule.resync({
    firstAudioAt,
    delayMs: currentDelayMs(),
    syncOffsetMs: Number(settings.capture.syncOffsetMs) || 0,
    now,
    maxPullForwardMs: onWhisperSegmentsForResync ? MAX_PULL_FORWARD_MS : Infinity,
  });

  /**
   * ⚠️ `schedule.due()` 是**从队列里 `shift()` 弹出**的（`lib/delayed-player.js:1948`）✗
   *    ⇒ 绝不能 `break` 一走了之 —— 那样弹出来的条目就**永远丢了** ✗✗
   *    （症状：字幕莫名少一句，而日志里什么都没有 —— 比"闪一下"严重得多 ✓）
   * ⇒ 让位时把**这一条和后面还没处理的**放回队首（`unshift` 一整个块保持原序 ✓）
   */
  const dueItems = schedule.due(now, renderable(now));
  const holdEnabled = String(settings?.asr?.provider || '') === 'vad-segments';

  /**
   * ⭐ **按批刷新（新路）** ✗ —— 一批的几句**同时出现**,而不是一条一条换 ✓
   *
   * 用户定的规矩（原话）：
   * > 「同时出现 都放一行就行 不行再折叠换行,我不信几秒延迟能说太多话导致挡画面」
   *
   * 为什么（实测）：延迟窗口里平均能完成 **2 句**（在屏中位 3.5s/句）；
   * 而一条一条换时，**同步到的两句会互相顶掉** ⇒ 观众看到"闪一下" ✗
   * ⇒ 改成"队首 `at` 到点就刷，把容差内已完成的**一起**带上，合并成一行" ✓
   *
   * ⚠️ 容差 1.5 秒（`SHOW_BATCH_TOLERANCE_SEC`）—— **不是**整个延迟窗口 ✗
   *    取 7 秒会让后一句提前 7 秒，那正是这一整天在治的病 ✗
   * ⚠️ **只改显示层**：`at` / 排期 / 识别一个字不动 ✓（「比排期晚」仍诚实 ✓）
   * ⚠️ **旧路不进这里**（`holdEnabled` 只对 `vad-segments` 为真 ✓）⇒ 旧路逐字不变 ✓
   */
  if (holdEnabled && dueItems.length) {
    /**
     * 🔴 **宽限等待已撤掉** ✗ —— 用户定的
     *
     * 用户原话：
     * > 「你对闪的优化有问题。**不要有什么上屏时间限制**。只有下一句该上了就上。
     * >   问题是**什么时候该上**,而不是让他**前面的延长**」
     *
     * 原来这里有一段"队首到点后再等 1.5 秒，把这段内到期的收进来" ✗ ——
     * 它确实让「屏上批量」从 3 次涨到 13 次 ✓，但代价是**每批都白等最多 1.5 秒**，
     * 真机实测「比排期晚」中位 **1.29 → 1.69 秒** ✗。
     *
     * ⇒ **"等"换来的是"晚"，而"晚"是累积的** ✗（越往后越落后）
     * ⇒ 撤掉之后：`schedule.due()` 这一拍弹出来的就是这一批 ✓
     *    —— 同一拍里到期的条目仍然**一起上屏**（"同时出现"保留 ✓）、**合一行** ✓
     *    而**不再为了凑批而故意多等** ✓
     *
     * ⚠️ 真正的解是 ②：把 `at`（该上的时刻）算准（见 `shownStartOf` 的多段锚）✗
     *    而不是靠"等"或"让前面那条多待" —— 那两者都只会让时间轴往后塌 ✓
     */
    const { batch, rest } = pickShownBatch(dueItems);
    /**
     * 屏上那一条的最小在屏时长。
     * ⚠️ 现在只剩 `MIN_SHOW_SEC`（0.6 秒）这一个绝对下限 ——
     *    "跨度剩余"和"字数÷6"两项已按用户要求撤掉（见 `minShowHoldMs` 的说明）✗
     */
    let minHoldMs = MIN_SHOW_HOLD_MS;
    if (history.length) {
      const onScreen = rendered.get(history[history.length - 1]);
      if (onScreen) {
        const onStart = Number(onScreen.start);
        const onEnd = Number(onScreen.end);
        minHoldMs = minShowHoldMs({
          chars: String(onScreen.original || '').length,
          spanSec: Number.isFinite(onStart) && Number.isFinite(onEnd) ? onEnd - onStart : 0,
          elapsedMs: lastShowSwitchAt > 0 ? now - lastShowSwitchAt : 0,
        });
      }
    }
    if (holdSwitchForGap({ now, lastSwitchAt: lastShowSwitchAt, minHoldMs, enabled: true })) {
      // 整批让位（记在队首头上）—— 全部放回队首，保持原序 ✗（不放回就是丢字幕 ✗）
      if (!batch[0].heldSince) batch[0].heldSince = now;
      showHeldCount += 1;
      schedule.items.unshift(...dueItems);
      pumpLater();
      return;
    }
    const item = batch[0];
    /**
     * 🔴 **给这一批每一条都打上"已消费"标记** ✗ —— 幂等保护 ✓
     * `pickShownBatch` 会滤掉带 `shownAt` 的条目，防止同一条被反复 flush ✓
     */
    for (const b of batch) b.shownAt = now;
    if (batch.length > 1) {
      const merged = mergeShownBatch(batch);
      if (merged) {
        item.original = merged.original;
        item.translation = merged.translation;
        if (Number.isFinite(merged.end)) item.end = merged.end;
        if (Number.isFinite(merged.start) && !Number.isFinite(Number(item.start))) item.start = merged.start;
        item.mergedCount = batch.length;
      }
      diag(
        `屏上批量 · ${batch.length} 条一起上屏 · 合计 ${String(item.original || '').length} 字` +
          ` · 排期跨度 ${((batch[batch.length - 1].at - item.at) / 1000).toFixed(2)}s` +
          `（容差 ${SHOW_BATCH_TOLERANCE_SEC}s ⇒ 它们本来会一条顶一条）`,
        false,
      );
    }
    diagShown(item, now);
    if (!item.translation && !translationOff()) diag('翻译没赶上 · 先显示原文', true);
    rendered.set(item.id, item);
    history.push(item.id);
    if (history.length > 3) {
      const drop = history.shift();
      rendered.delete(drop);
    }
    shownCount += batch.length;
    lastShownAt = Date.now();
    lastShowSwitchAt = now;
    if (rest.length) schedule.items.unshift(...rest);
    renderSubs();
    pumpLater();
    return;
  }

  for (let di = 0; di < dueItems.length; di += 1) {
    const item = dueItems[di];
    /**
     * ⭐ **屏上合并闸** ✓ —— 两句排期撞在一起（一批出两句）时，**并成一行一起显示** ✓
     *
     * 用户定的规矩（原话）：
     * > 「如果句子比较短,且第一句不超排期的话,两句或者多句一起送出可以」
     * > 「注意是最后上字幕一起送出来,**不是说改变识别方式**」
     *
     * ⇒ 所以它**只动显示**：识别结果、`at`、排期一个都不改 ✓
     *
     * 为什么要有它（实测）：`段内切分` 会一批出两条，而那两条的 `at` 只差几十毫秒
     * （`xhsp-seg25-B` 的 `91.092 → 91.013` = **−0.079s**）⇒ 后一条一到就把前一条顶掉 ✗
     * 而下面的「让位」只能把它**推迟** 0.5 秒（那又变成"晚"✗）。
     * ⇒ **能并就并、并不了才让位** —— 顺序不能反 ✗
     */
    if (holdEnabled) {
      const prevId = history.length ? history[history.length - 1] : null;
      const prevItem = prevId ? rendered.get(prevId) : null;
      if (
        shouldMergeShown({
          prev: prevItem,
          next: item,
          now,
          prevShownAt: lastShowSwitchAt,
        })
      ) {
        const joinedOriginal = joinShownText(prevItem.original, item.original);
        const joinedTranslation = joinShownText(prevItem.translation, item.translation);
        prevItem.original = joinedOriginal;
        prevItem.translation = joinedTranslation;
        // 跨度只用于诊断（"这句说了多久"）—— 并了就把尾巴接上 ✓
        const prevEnd = Number(prevItem.end);
        if (Number.isFinite(item.end)) {
          prevItem.end = Number.isFinite(prevEnd) ? Math.max(prevEnd, item.end) : item.end;
        }
        prevItem.mergedCount = (Number(prevItem.mergedCount) || 0) + 1;
        showMergedCount += 1;
        /**
         * ⚠️ **不更新 `lastShowSwitchAt`** —— 屏上那一条**没有换**，只是变长了 ✓
         *    更新它会让下一条被无端"让位"0.5 秒 ✗
         * ⚠️ **不 push `history`** —— 否则就是两行、又回到"分别推送"✗
         */
        diag(
          `屏上合并 · 第 ${showMergedCount} 次 · 合计 ${joinedOriginal.length} 字` +
            ` · 两条排期差 ${((item.at - prevItem.at) / 1000).toFixed(2)}s` +
            `（< ${MIN_SHOW_GAP_SEC}s ⇒ 本来会顶掉前一条）· 上屏时刻不变`,
          false,
        );
        renderSubs();
        continue;
      }
    }
    /**
     * 🔴 **屏上让位闸** ✗ —— 上一条还没在屏上待够 `MIN_SHOW_HOLD_MS`，
     *    这一拍先别换屏，下一拍（100ms 后）再来 ✓
     *
     * 为什么必须在这一层（实测）：
     *   `clampShownAt` 夹的是**音频时间**，而 `at` 里还有会变的 `delayMs` ✗
     *   ⇒ `xhsp-ab3-B` 里「夹紧推后」**一次都没触发**（0 次），而导出日志里仍有
     *     `73.512 → 72.992（−0.52）` / `91.146 → 91.046（−0.10）` 这种倒退 ✗
     *   ⇒ 那几条推入时的 `usedDelayMs` 不同，于是排期在音频时间之外又倒了过来 ✓
     *
     * ⚠️ **只对新路启用** —— 旧路的时机用户认可，动它就是回归 ✗
     * ⚠️ **不改排期值** ⇒「比排期晚」仍然诚实；让位出去的时间单独印出来 ✗
     */
    /**
     * ⭐ **每条「待够再换」** ✗ —— 而不是固定 0.5 秒。
     *
     * 实测（用户报 "5 秒内两句连跳 / 句子还是短,还是很快被顶下去"）:
     *   · 7/56 条**在屏时长 < 它自己的跨度**（还没说完就被换 ✗）
     *   · 阅读速度 **20~210 字/秒**（正常 5~8 ✗）—— 例:`21 字 / 2s` 在 0.1s 后被换 ✗
     *
     * ⇒ 每条的最小在屏时长按它**自己**算（`minShowHoldMs`）：
     *   ① 还没说完的部分 ② 读完它要多久 ③ 0.6 秒下限 ✓
     * ⚠️ 只在**新路**算；旧路仍用 `MIN_SHOW_HOLD_MS`（时机用户认可，动它就是回归 ✗）
     * ⚠️ 不改 `at` ⇒「比排期晚」仍然诚实 ✓
     */
    let minHoldMs = MIN_SHOW_HOLD_MS;
    if (holdEnabled && history.length) {
      const onScreen = rendered.get(history[history.length - 1]);
      if (onScreen) {
        const onStart = Number(onScreen.start);
        const onEnd = Number(onScreen.end);
        minHoldMs = minShowHoldMs({
          chars: String(onScreen.original || '').length,
          spanSec: Number.isFinite(onStart) && Number.isFinite(onEnd) ? onEnd - onStart : 0,
          elapsedMs: lastShowSwitchAt > 0 ? now - lastShowSwitchAt : 0,
        });
      }
    }
    if (holdSwitchForGap({ now, lastSwitchAt: lastShowSwitchAt, minHoldMs, enabled: holdEnabled })) {
      // 记在**这一条**头上：它到点上屏却被让位，诊断里要看得见这多少毫秒 ✗
      if (!item.heldSince) item.heldSince = now;
      showHeldCount += 1;
      // 🔴 **放回队首**（保持原顺序）—— 不放回就是丢字幕 ✗
      schedule.items.unshift(...dueItems.slice(di));
      break;
    }
    /**
     * 🔴 **无条件**记录"这一条真的上屏了" ✗ —— 不再看 `item.late`。
     *
     * 原来写的是 `if (item.late) diagLate(item, now)`，而 `item.late` 是**推入时**算的 ✗
     * ⇒ 被让位、但推入时"还没晚"的条目既不打印、也不记录 `subLog.dt` ✗
     * ⇒ 导出里那些句子的"上屏时刻"是**缺的**，而"在屏时长"只能反推 ⇒ 那些数不可信 ✗
     */
    diagShown(item, now);
    if (!item.translation && !translationOff()) diag('翻译没赶上 · 先显示原文', true);
    // 存引用而不是拷贝：译文晚到时才能直接改到已经上屏的这一条
    rendered.set(item.id, item);
    history.push(item.id);
    if (history.length > 3) {
      const drop = history.shift();
      rendered.delete(drop);
    }
    // ⚠️ 这里才是"字幕真的上屏" —— 看门狗要的是这个，不是"识别回来了"。
    shownCount += 1;
    lastShownAt = Date.now();
    // 换屏基准用排期循环的 `now`（和 `holdSwitchForGap` 同一个时钟 ✗）
    lastShowSwitchAt = now;
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

/**
 * 当前**连续**翻译失败次数（成功一次清零 ✓）。
 *
 * ⚠️ 阈值和判据都在 `lib/asr/whisper-batch.js`（`displayHoldMs` / `translationHoldMs`，纯函数、有断言 ✓）
 *    —— 这里只负责计数，别在显示层再写一份判据（两份真相 ✗）
 */
let translateFailStreak = 0;

/**
 * 翻译被**关掉**了吗（`translate.provider === 'none'` = 「不翻译（仅显示原文）」）。
 *
 * ⚠️ 和 `lib/translate/index.js` 的 `isTranslateEnabled` 是**同一个判据**，
 *    只是这里不吃 `null` settings（那边会直接抛）✓
 */
function translationOff() {
  const t = settings?.translate;
  return !!(t && t.provider === 'none');
}

function renderable(now) {
  return (item) => {
    if (item.translation) return true;
    // 第一次到点却没译文时记下时刻，用它衡量"已经扣了多久"
    if (!item.dueSince) item.dueSince = now;
    /**
     * 要等译文多久 —— **判据只在 lib 一处**（`displayHoldMs`，纯函数、有断言 ✓）✗
     *
     * 它管两件事，两件都会把吞吐钉死成 `LATE_TRANSLATION_MS` 一条：
     *   ① 翻译**关掉**（「不翻译（仅显示原文）」）⇒ 0 —— 译文永远不来，等就是白等
     *   ② 连续失败 ≥ `TRANSLATE_FAIL_STREAK` ⇒ 0 —— 翻译挂了，同样等不到
     * 实测（闭环 · 不翻译 · 160 秒）：不修则在屏时长恒定 **4.02s**（32/35 条）、
     * 「比排期晚」中位 **15.30s** / 最大 **37.13s** ✗；修后中位 **1.32s** / 最大 **2.37s** ✓
     */
    const holdMs = displayHoldMs({
      translateOn: !translationOff(),
      failStreak: translateFailStreak,
      lateMs: LATE_TRANSLATION_MS,
    });
    return now - item.dueSince >= holdMs;
  };
}

/**
 * 这一条**真的上屏了** —— 记下真实时刻，并把它和上一条的**在屏时长/阅读速度**打进日志。
 *
 * ⚠️ 名字原来是 `diagLate`（只报"晚了多少"），而它有个**测量缺口** ✗：
 *    它只在 `item.late` 时被调用，而 `item.late` 是**推入时**算的 ⇒
 *    被让位、但推入时"还没晚"的条目**既不打印、也不记 `subLog.dt`** ✗
 *    ⇒ 导出里那些句子的上屏时刻是**缺的**，"在屏时长"只能反推 ⇒ 那些数不可信 ✗
 *
 * `比排期晚` 的基准仍是**排期时刻**（那才是用户感知到的量）：
 * 排期时刻 `at` = 画面播到这句「开口」的那一刻（由实测延迟算出来）
 * ⇒ `now − at` 就是"比应该出现的时刻晚了多少" ✓
 *
 * ⚠️ 别拿 `now − (firstAudioAt + start*1000)` 当滞后：那是相对**实况**的，
 * 而画面本来就晚了 D 秒，那个数会把 D 加进去（D=8 时报"晚 8.6 秒"，实际只晚 0.6 秒）。
 * 这正是我上一次犯的错。
 */
function diagShown(item, now) {
  const lateMs = now - item.at;
  const saidMs = Number.isFinite(item.start) && Number.isFinite(item.end) ? (item.end - item.start) * 1000 : 0;
  // 画面把这句说完的时刻 ≈ at + 句长（at 已经含了延迟），所以这句还在放 = lateMs <= saidMs
  const inside = saidMs > 0 && lateMs <= saidMs;
  /**
   * ⭐ **上一条在屏上待了多久 / 它有多少字 ⇒ 它的阅读速度** ✗
   *
   * 「在屏时长」只能在下一条上屏时才算得出来 ⇒ 由**下一条**替上一条报出来 ✓
   * `字/秒` 用的是**上一条**的字数（那才是"它在屏上那段时间的阅读速度"）✓
   * 正常中文阅读 5~8 字/秒；实测出现过 **20~210 字/秒**（= 根本没时间读 ✗）
   */
  const shownPerf = performance.now();
  const dwellMs = lastShownPerf > 0 ? Math.max(0, shownPerf - lastShownPerf) : 0;
  const prevCps = dwellMs > 0 && lastShownChars > 0 ? lastShownChars / (dwellMs / 1000) : 0;
  // 回填"这一句实际显示的是什么"。
  // ⚠️ 取 `translation || original` —— 译文没赶上时字幕显示的是**原文**，
  //    所以要记的是真正显示出去的那一版，不是"本该显示什么"。
  {
    const shown = String(item.translation || item.original || '');
    // ⚠️ `dt` = 这一句**真的上屏**的时刻。导出筛选要用它:
    //    只按识别时间筛会丢掉"识别在窗口外、显示在窗口内"的那几句（窗口开头最常见）。
    const shownAt = performance.now();
    const rec = subLog.find((r) => r.id === item.id);
    if (rec) {
      rec.shown = shown;
      rec.dt = shownAt;
    }
    // 识别那条已经被环形缓冲挤掉 → 补一条并**如实标出缺的那半边**，
    // 别让导出的记录看起来像"这句没有识别文本"（那是另一回事）。
    else {
      subLog.push({ t: shownAt, dt: shownAt, id: item.id, asr: '(未记录)', shown });
      // ⚠️ 这条兜底 push 也必须配对裁剪 —— 否则 subLog 会超过 SUBLOG_KEEP，
      //    让导出那句"缓冲区已满、更早的句被挤掉了"变得不准。
      if (subLog.length > SUBLOG_KEEP) subLog.shift();
    }
  }
  /**
   * ⭐ 这里印的是**同一个** `at`（当前值），并把它和推入时的快照比一次。
   *
   * ⚠️ `item.at` 会被 `resync()` 每拍重算 —— 所以"排期时刻"在排队期间**会变** ✗。
   *    这里若和推入时不同就明写 `排期被挪 ±X.XXs`，而不是悄悄用新值算 `比排期晚` ✗
   *    （`lateMs` 一直用当前值，那是"真的晚了多少"，对 ✓）。
   * ⇒ 和「整句上屏」那行的 `at=` 一对比，就能判出"上屏时机乱"是不是排期在动造成的 ✓
   */
  const atStamp = formatAtStamp({
    at: item.at,
    atPush: item.atPush,
    now,
    perfNow: performance.now(),
    t0: DIAG_T0,
  });
  const atNote = atStamp ? `${atStamp} · ` : '';
  /**
   * ⭐ 被「屏上让位」挡了多久 —— **必须印** ✗
   *
   * 否则「比排期晚」会因为闸门而变大，而读日志的人会以为那是缓冲/排期的锅 ✗
   * （"看不见"这一族今天已栽过五次 ✓）
   */
  const heldSec = item.heldSince ? Math.max(0, (now - item.heldSince) / 1000) : 0;
  const heldNote = heldSec >= 0.01 ? ` · 屏上让位 +${heldSec.toFixed(2)}s` : '';
  /**
   * ⭐ **无条件**一行，且必须能**自己算出来**在屏时长/阅读速度 ✓
   *
   * 每一格都有理由：
   *   · `at=`        原排期时刻（和「整句上屏」那行**同一个数**，可对账 ✓）
   *   · `真 +X.XXXs` 这一条**真的**上屏的时刻，和 `at=` 同刻度（`DIAG_T0`）✓
   *   · `上条待 X.XXs/Y 字 = Z 字/秒` —— ⭐ **上一条**的真实在屏时长和阅读速度 ✓
   *     ⇒ 正常 5~8 字/秒；>8 说明"还没读完就被换掉" ✗（实测见过 20~210 ✗）
   *   · `切`          这段音频**怎么被切出来的**（新路 `whisper-segment` / 旧路 `utterance-end`…）
   *     ⇒ 一眼分得出"这一条是新路还是旧路" ✓
   *   · `屏上让位`    被闸门挡了多久（否则会把闸门的锅算到缓冲头上 ✗）
   */
  const realSec = Math.round(((shownPerf - DIAG_T0) / 1000) * 1000) / 1000;
  const realStamp = `真 ${realSec < 0 ? '-' : '+'}${Math.abs(realSec).toFixed(3)}s`;
  /**
   * ⭐ **"人真正开口"的绝对时刻** —— 用户报的「有时候早有时候晚」靠它才量得到 ✗
   *
   * `比排期晚` 只回答"上屏 vs `at`"；而"`at` 本身早不早"它**量不到** ✗
   * （`at` 就是基准 ⇒ 基准错了这个数照样是 0.0x ✓ —— 今天在这一点上绕过一整圈 ✓）
   *
   * ⇒ 印 `词首`，于是这一行同时给出：
   *   · `真 − 词首` = **观众真的看到**这句比人开口早/晚多少 ← **"早/晚"的定义** ✓
   *   · `at − 词首` = 排期的延迟预算 + 锚点位移（诊断排期用 ✓）
   *
   * ⚠️ 换算：`at` 是 `Date.now()` 口径、`真` 是 `performance.now()` 口径 ⇒
   *    用**同一对** `(item.at, now)` 把 `at` 映射到 perf 刻度（和 `formatAtStamp` 同一个思路 ✓）
   * ⚠️ 缺 `words` ⇒ 印 `词首 —`（**绝不印 0**：0 会被读成"就是这一刻"✗）
   */
  const atPerf = shownPerf + (Number(item.at) - Number(now));
  const wordPerf =
    Number.isFinite(item.wordShiftMs) && Number.isFinite(Number(item.delayPlusSyncMs))
      ? atPerf - Number(item.delayPlusSyncMs) + Number(item.wordShiftMs)
      : null;
  const wordSec = wordPerf === null ? null : (wordPerf - DIAG_T0) / 1000;
  const wordStamp =
    wordSec === null
      ? ' · 词首 —'
      : ` · 词首 ${wordSec < 0 ? '-' : '+'}${Math.abs(wordSec).toFixed(3)}s`;
  const chars = String(item.translation || item.original || '').length;
  // ⚠️ 第一句没有上一条（`dwellMs = 0`）⇒ 印 `—`，不许印 0（0 会被当成"没待"✗）
  const dwellNote =
    dwellMs > 0
      ? ` · 上条待 ${(dwellMs / 1000).toFixed(2)}s/${lastShownChars} 字 = ${prevCps.toFixed(1)} 字/秒${prevCps > 8 ? ' ⚠ 读不完' : ''}`
      : ' · 上条待 —';
  diag(
    `屏上 · ${atNote}${realStamp}${wordStamp} · 比排期晚 ${(lateMs / 1000).toFixed(2)}s` +
      ` · ${chars} 字${saidMs > 0 ? ` / 说了 ${(saidMs / 1000).toFixed(1)}s` : ''}` +
      `${inside ? ' · 仍在句内' : ''}${dwellNote}${heldNote} · 切 ${item.cut || '?'}`,
    // 晚得还在句内 = 观感可接受；而"读不完"（>8 字/秒）要报警 ✓
    !inside || prevCps > 8,
  );
  // 记在**这一条**头上：下一条上屏时用它算"上一条待了多久" ✓
  lastShownPerf = shownPerf;
  lastShownChars = chars;
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
 *
 * ⚠️ **基准是「字幕真的上屏」，不是「拿到识别结果」** —— 踩过的坑:
 * 原来用 `lastResultAt` 当基准，而它只在 `ev.type === 'final'` 时更新；
 * 走 utterance-end 收句时它会一直陈旧，于是**字幕正常上屏**的情况下
 * 仍然报「已经 15 秒没有识别结果」，而且给出的结论
 * 「识别有结果了，问题在下游（上屏环节）」**也是错的**。
 * 用户看到的"什么都没有"= 屏幕上没有字幕，所以基准就该是上屏。
 *
 * ⚠️ 计数也必须**按模式说人话**：`asrRequestsDone` 数的是 `status === 'chunk'`
 * （本地 VAD 下 = VAD 切出来的分片），而 `asrRequestsSent` 只数
 * `status === 'recognizing'` —— **本地 VAD 适配器根本不发这个事件**。
 * 于是日志里出现过「已发出 0 次 · 回来 8 次」这种自相矛盾的行，
 * 而"回来 8 次"其实只是"切出了 8 段"。
 */
function checkSilentAsr() {
  if (!running || !firstAudioAt) return;
  const since = Math.max(firstAudioAt, lastShownAt || 0);
  const waited = Date.now() - since;
  if (waited < 15000) return;

  // ⚠️ 必须**持续刷新**，不能只报一次。
  // 一次性提示会永远停在它第一次触发的那一刻，读到的数字是几分钟前的快照 ——
  // 用户会以为"一直卡在这里"，而其实状态早就变了（这个坑踩过）。
  if (Date.now() - lastNoticeAt < 2000) return;
  lastNoticeAt = Date.now();

  const lines = [`已经 ${Math.round(waited / 1000)} 秒没有字幕上屏`];
  if (lastAudioNote) lines.push(`收音频：${lastAudioNote}`);
  lines.push(`分片 ${asrRequestsDone} 段 · 字幕上屏 ${shownCount} 句`);
  // ⚠️ 「已发出」只有请求式的适配器才发 `recognizing`；0 不代表异常，所以只在非 0 时才印。
  if (asrRequestsSent > 0) lines.push(`识别请求：已发出 ${asrRequestsSent} 次 · 回来 ${asrRequestsDone} 次`);

  if (asrRequestsSent > asrRequestsDone + 1) {
    lines.push('→ 请求发出去了但回不来：检查本地服务在不在、地址对不对');
  } else if (asrRequestsDone === 0) {
    // 一段都没切出来：前端的事（本地 VAD 模式下不发"分片请求"，这个提示要说得准）
    lines.push('→ 还没产生任何一句（看上面的 VAD 读数：帧数在涨吗？概率峰值上得去吗？）');
  } else if (lastResultAt && Date.now() - lastResultAt < 15000) {
    // ⚠️ 这一支现在**有依据**了：文本确实刚到手，却没上屏。
    lines.push('→ 识别有结果了，问题在下游（排期 / 翻译 / 上屏环节）');
  } else {
    lines.push('→ 切出了分片，但一直没有文本回来：看上面有没有「识别出错」，以及本地服务的地址');
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
  $('delay').value = String(effectiveDelaySec(settings));
  $('delayVal').textContent = `${effectiveDelaySec(settings).toFixed(1)}s`;
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
    /**
     * ⚠️ 必须走 `effectiveDelaySec`，**不能裸读 `settings.capture.delaySec`** ✗
     *
     *    裸读的后果（v2.66.83 修）：选着「本地 Whisper 自断句」时 storage 里是 7.1，
     *    而新模式要 10 —— 裸读会把正在跑的播放延迟**从 10 拉回 7.1**，
     *    画面只落后 7.1 秒而字幕按 10 排 ⇒ 字幕提前 2.9 秒。
     *    比的是**生效值**，所以"只切了识别服务"也会被正确识别成一次延迟变化。
     */
    const d = effectiveDelaySec(settings);
    const prevD = effectiveDelaySec(before ?? settings);
    if (Number.isFinite(d) && d !== prevD) playback?.setDelay(d);
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
        `⚠ ${needRestart.map(([, label]) => label).join('、')} 的改动要重新开始同声传译才会生效` +
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
  const delayMs = Number.isFinite(actual) && actual > 0 ? actual * 1000 : effectiveDelaySec(settings) * 1000;
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
    const raw = Number(e.target.value);
    /**
     * ⚠️ 两条路都有**硬下限**（新路 6.5 秒 / 旧路 5 秒），拖到下面也不会生效 —— 所以滑块当场弹回下限。
     *
     *    不弹回去就会出现「滑块 7、标签 7、实际按 10 排」这种三个数各不相同的情况 ✗
     *    （本项目为「滑块 10 而标签 3.0s」专门写过断言，那是同一类问题。）
     *
     *    ⚠️ 但 storage 里**存用户自己的原值**：切回别的识别服务时，他要的就是那个值。
     *       显示与生效都走 `effectiveDelaySec`，所以看着一致、切回去也不丢他的设置。
     */
    const v = effectiveDelaySec({ ...settings, capture: { ...settings.capture, delaySec: raw } });
    const snapped = v !== raw;
    if (snapped) $('delay').value = String(v);
    $('delayVal').textContent = snapped ? `${v.toFixed(1)}s（最低 ${v.toFixed(1)}s）` : `${v.toFixed(1)}s`;
    settings.capture.delaySec = raw;
    playback?.setDelay(v);
    scheduleSave('capture.delaySec', raw);
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
  $('btnSaveAudio').addEventListener('click', () => void saveAudioAndLog());
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
  /**
   * ⚠️ 必须清掉周期快照的定时器。
   *
   * `stopAll()` 是唯一的停止入口（用户点停止、来源结束、出错、`boot()` 的 catch），
   * 所以清在这里能覆盖所有路径。不清的话，停掉之后定时器还在跑 ——
   * 日志里会继续冒快照（而且所有字段都成了 `null`），既误导又白占缓冲区。
   */
  clearInterval(snapTimer);
  snapTimer = 0;
  if (visHandler) {
    document.removeEventListener('visibilitychange', visHandler);
    visHandler = null;
  }
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
