/**
 * 本地 Whisper **自断句** —— 和 `vad.js` 同一个引擎、同一批旋钮，
 * 唯一的差别是打开「让 Whisper 自己断句」那条新路（`config.whisperSegments = true`）。
 *
 * ⭐ 为什么单独做成一个适配器，而不是让用户在 `vad` 之外再勾一个框：
 *    · 那是**两条不同的断句策略**，不是同一策略上的一个微调 —— 而设置页的
 *      「识别服务」下拉本来就是用来选策略的（`panelShown()` 也按这个 id 切面板）；
 *    · 勾选框 + 下拉的组合会让「选 A 却实际跑 B」变得可能（本项目栽过
 *      “两份清单不一致”），而一个 id 只能对应一个策略时那种状态不存在；
 *    · 面板可见性、就绪校验、popup 上的服务名、`ASR_MODULES` 的推导
 *      **全都按 id 走**，做成 id 就不必为每一处单独加一条分支。
 *
 * ⚠️ `backend: 'whisper'` 必须**字面写出来**：`lib/asr/vad.js` 那边是
 *    `config.backend || 'whisper'`，而 `tools/smoke-test.mjs` 里那条
 *    「凡是复用 VAD 引擎的识别服务，设置页都必须让它看到 VAD 的那组旋钮」
 *    是**从源码推**出 provider → backend 的；不写字面量它就推不出这个服务，
 *    于是设置页会以为它不用 VAD 引擎，整组旋钮对它隐藏 —— 而那些旋钮对它生效。
 *
 * ⚠️ `whisperSegments` 在这里**强制打开**，不看设置里的那个旧开关：
 *    哪个 id 决定哪条路径，只允许有一个来源。
 */
import * as vadEngine from './vad.js';

export function createSession(opts = {}) {
  const config = { ...(opts.config || {}), backend: 'whisper', whisperSegments: true };
  return vadEngine.createSession({ ...opts, config });
}
