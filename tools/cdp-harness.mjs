// 通过 Chrome DevTools Protocol 自己驱动浏览器跑一遍，把诊断面板读回来。
//
// 为什么要它：断句调参一直是"我改一个值 → 让你重载扩展 → 你贴日志"，
// 一轮只能试一个值，而且启动期的信息还常常缺失。
// 有了这个测试台，我可以用一段**已知内容**的真人日语音频跑，
// 自己判断断句对不对，自己调参，不用再打扰你。
//
// 注意：沙箱里启动的进程在命令结束后会死，所以"启动浏览器 → 测试 → 关掉"
// 必须在同一次调用里完成。

/**
 * ⚠️ 存储键名必须和 lib/settings.js 的 STORAGE_KEY 一致。
 * 这里曾经写成 `'settings'` —— 后果是**设置静默不生效**：
 * 测试台以为自己配了 VAD + 本地 Whisper + 延迟模式，实际跑在默认设置上，
 * 而默认是 Deepgram（没 Key）。用测试台的人会得出错误结论。
 */
const STORAGE_KEY = 'livedub.settings';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 路径全部相对**扩展根目录**推导，不写死任何绝对路径 —— 别人克隆下来就能跑。
 * 都能用环境变量覆盖（和下面的 CDP_PORT 一个写法）。
 */
const EXT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number(process.env.CDP_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * 测试音源。默认用仓库里自带的那段 4 秒真人日语
 * （`vendor/vad-selftest.wav`，本来是给 VAD 开箱自检用的）——
 * 这样不依赖任何本机路径，克隆下来直接能跑。
 * 想换成更长/更典型的素材就设 TEST_AUDIO。
 */
const AUDIO = process.env.TEST_AUDIO || path.join(EXT_ROOT, 'vendor', 'vad-selftest.wav');
const EXT_PATH = process.env.EXT_PATH || EXT_ROOT;
const WHISPER = process.env.WHISPER_URL || 'http://127.0.0.1:8080/v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  const res = await fetch(BASE + path);
  return res.json();
}

/** 极简 CDP 客户端 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate 出错');
    return r.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const log = (...a) => console.log(...a);

async function main() {
  log('=== 1. 找扩展 ===');
  const targets = await getJson('/json/list');
  const extTargets = targets.filter((t) => (t.url || '').startsWith('chrome-extension://'));
  if (!extTargets.length) throw new Error('没看到扩展目标 —— 扩展没加载上');
  const extId = new URL(extTargets[0].url).host;
  log(`  扩展 ID = ${extId}`);

  const sw = extTargets.find((t) => t.type === 'service_worker');
  log(`  service worker: ${sw ? '✓' : '✗'}`);

  const opts = extTargets.find((t) => t.url.includes('options/options.html'));
  if (!opts) throw new Error('没有打开的设置页 —— 需要它来写设置');
  const cdpOpts = await Cdp.connect(opts.webSocketDebuggerUrl);

  log('\n=== 2. 写入设置（VAD 模式 + 本地 Whisper + 不翻译，专心测断句）===');
  const settings = {
    asr: {
      provider: 'vad',
      language: 'ja',
      whisperChunked: { baseUrl: WHISPER, model: 'whisper-1', apiKey: '' },
      refine: { enabled: false },
    },
    capture: { mode: 'delayed', delaySec: 6, smoothRate: false, delayMaxHeight: 0 },
    translate: { provider: 'none' },
  };
  const setRes = await cdpOpts.eval(`(async () => {
    const cur = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {};
    const deep = (a, b) => { for (const k of Object.keys(b)) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) { a[k] = a[k] || {}; deep(a[k], b[k]); }
      else a[k] = b[k];
    } return a; };
    const next = deep(cur, ${JSON.stringify(settings)});
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return JSON.stringify(next.asr.provider) + ' / ' + next.asr.whisperChunked.baseUrl + ' / ' + next.capture.mode;
  })()`);
  log('  已写入：', setRes);

  log('\n=== 3. 用浏览器级连接开一个测试页（循环播放已知内容的日语音频）===');
  const ver = await getJson('/json/version');
  const cdpBrowser = await Cdp.connect(ver.webSocketDebuggerUrl);

  const wavB64 = fs.readFileSync(AUDIO).toString('base64');
  const html = `<!doctype html><meta charset="utf-8"><title>livedtranslate 测试音源</title>
<body style="background:#111;color:#eee;font:14px sans-serif">
<h3>livedtranslate 断句测试音源</h3>
<p id="st">加载中…</p>
<audio id="a" loop></audio>
<script>
  const a = document.getElementById('a');
  a.src = 'data:audio/wav;base64,${wavB64}';
  a.volume = 1;
  a.addEventListener('canplay', async () => {
    try { await a.play(); document.getElementById('st').textContent = '播放中 ' + a.duration.toFixed(1) + 's'; }
    catch (e) { document.getElementById('st').textContent = '播放失败：' + e.message; }
  });
</script>`;

  const testUrl = 'data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64');
  const created = await cdpBrowser.send('Target.createTarget', { url: testUrl });
  const testTabId = created.targetId;
  log('  测试页已创建');

  log('\n=== 4. 等音频开始，然后按快捷键启动捕获（Alt+Shift+S）===');
  await sleep(2500);
  const tabs1 = await getJson('/json/list');
  const testTab = tabs1.find((t) => t.id === testTabId);
  const cdpTest = await Cdp.connect(testTab.webSocketDebuggerUrl);
  const st = await cdpTest.eval(`document.getElementById('st').textContent`);
  log('  测试页状态：', st);

  // 激活测试页并触发扩展快捷键
  await cdpTest.send('Page.bringToFront').catch(() => {});
  for (const type of ['keyDown', 'keyUp']) {
    await cdpTest.send('Input.dispatchKeyEvent', {
      type,
      modifiers: 1 | 8, // Alt | Shift  -> 实际用 rawKeyDown 更稳
      key: 'S',
      code: 'KeyS',
      windowsVirtualKeyCode: 83,
      nativeVirtualKeyCode: 83,
    });
  }
  log('  已发送快捷键');

  log('\n=== 5. 观察 40 秒，抓播放页的诊断面板 ===');
  let playerCdp = null;
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    await sleep(2000);
    const list = await getJson('/json/list');
    const player = list.find((t) => t.url.includes('/player/player.html'));
    if (player) {
      if (!playerCdp) {
        playerCdp = await Cdp.connect(player.webSocketDebuggerUrl);
        log('  找到播放页 ✓');
      }
      try {
        const txt = await playerCdp.eval(`(document.getElementById('diag')||{}).textContent || ''`);
        for (const line of String(txt).split('\n')) {
          const s = line.trim();
          if (s && !seen.has(s)) {
            seen.add(s);
            log('    ' + s);
          }
        }
      } catch {
        /* 页面还在加载 */
      }
    }
  }

  log('\n=== 6. 结果汇总 ===');
  if (!playerCdp) {
    log('  ✗ 始终没出现播放页 —— 快捷键没触发？');
  } else {
    const lines = [...seen];
    log(`  共 ${lines.length} 行诊断`);
    const seg = lines.filter((l) => /一句|片段/.test(l));
    log(`  其中断句相关 ${seg.length} 行`);
  }

  cdpTest.close();
  cdpBrowser.close();
  cdpOpts.close();
  playerCdp?.close();
}

main().catch((e) => {
  console.error('测试台失败：', e.message);
  process.exit(1);
});
