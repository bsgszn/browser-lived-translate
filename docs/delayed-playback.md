# 设计笔记：让字幕追上画面（延迟播放 / 前读）

> 状态：**路线 A（延迟播放窗口）已实现**，见 `player/` 与 `lib/delayed-player.js`。
> 路线 B（前读影子音轨）仍未实现，留档在下面。
>
> 本文上半部分是当初的推导，下半部分「实现说明」记录最终落地的方案与实测不了的边界。

## 问题

同传字幕永远晚于画面。因为识别的输入就是画面正在播出的那一段音频：

```
画面播到内容位置 P 的这一刻，我们才刚拿到 P 的音频
   → 识别出字要 +0.3~1.0s
   → 翻译往返要 +0.3~1.5s
   → 字幕出现在那一刻之后
```

要让字幕**跟上甚至略微领先**画面，必须让 **识别到的音频位置比屏幕显示的位置超前 D 秒**，且 `D ≥ 识别+翻译的总延迟`。

## 为什么不能"就地推迟"页面里的 video

浏览器没有任何 API 能推迟一个 `<video>` 的播放。逐一验证过的思路：

| 想法 | 结果 |
|---|---|
| 改 `video.currentTime` 到更早的位置 | ❌ 只是"跳到那里继续**实时**播"，不产生相对偏移；而且之后画面会一直比声音早 |
| 调小 `playbackRate` 攒延迟 | ❌ 只会持续累积漂移，不是固定延迟，且音画会分离 |
| 只推迟音频 | ❌ 音画不同步，不能看 |
| 用 MediaSource 把自己的缓冲塞给页面 | ❌ 无法接管站点自己的 MSE（YouTube/Twitch 都是站点自建 SourceBuffer） |
| 隐藏副本超前播放 | ✅ 见"路线 B" |

根本原因：**要产生延迟，必须把"采集端"和"显示端"分开**。而现在这两者是同一个 `<video>` 元素。

## 路线 A：延迟播放窗口（直播唯一可行）

```
原标签页（保持播放，作为信号源）
   │ tabCapture（视频 + 音频）
   ▼
offscreen：MediaRecorder 分片 → MSE 缓冲 D 秒
   ▼
扩展自己的播放窗口（chrome.windows popup 或 Document PiP）
   ├─ 播放延迟画面 + 延迟音频
   └─ 字幕也画在这个窗口里
```

**必须渲染在被捕获的标签页之外。** 如果画在同一个标签页里，tabCapture 会把我们自己的延迟画面也抓进去，形成无限回授。

### 固有代价（都是 tabCapture 决定的，绕不过去）

- **原标签页会被自动静音**：这是 tabCapture 的固有行为，音频交给扩展自己回放。对延迟窗口来说反而正好。
- **必须重新编码**：MediaRecorder（VP8/VP9）或 WebCodecs。1080p 大约多 10–25% CPU，画质有轻微损失。
- **DRM 内容（Netflix 等）直接不可用。**
- **用户体验改变**：实际是在看我们的窗口，原标签页退化成"信号源"，需要在它顶部给一条提示避免困惑（但**不要用全屏遮罩**，见下面的实测反馈）。

### 工程难点

- **延迟值不能漂**。不能只靠"攒够 2 秒就开播"，那样会随时间累积误差。需要持续把播放头锁在 `playhead = bufferedEnd − D`，并在 seek / 切清晰度 / 广告之后重新校准。
- **MediaRecorder 的分片节奏不完全可控**，要实测 `dataavailable` 的实际间隔才能定 D 的下界。
- **Document PiP 需要用户手势**（`documentPictureInPicture.requestWindow()` 要求 transient user activation），从扩展 action 点击触发的场景不一定满足，稳妥做法是用 `chrome.windows.create({type:'popup'})`。

### 一个更轻的实现思路

不要让 offscreen 去搬分片数据（`chrome.runtime.sendMessage` 对 ArrayBuffer 会做 JSON 序列化，MB 级分片很贵）。改用：

```js
// SW 里指定消费者标签页
const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId, consumerTabId: playerTabId });
```

然后让**播放窗口自己**调 `getUserMedia` 拿流、做 MediaRecorder + MSE。顺便它也能直接跑 ASR 和翻译——那样连 offscreen 都不需要了，整个引擎搬进播放页。

## 路线 B：前读影子音轨（点播体验更好，直播不可用）

点播内容是"已经存在"的，不需要延迟画面，只要让识别跑得比画面快：

- 建一个隐藏的 `<video>`，指向同一份媒体（`video.currentSrc`）
- 让它比主画面**超前 2 秒**静音播放
- 把它的音轨（`captureStream()` 或直接 `getUserMedia` 不行，得用 WebAudio）送给 ASR
- 字幕按时序表在正确时刻显示，永远提前就绪

**优点**：画面零延迟、零重编码、画质无损、CPU 低。

**代价**：
- **直播没有"未来"可读**，完全用不了。
- 依赖影子副本与主画面严格同步。seek、切码率、广告插入、缓冲策略变化都要重新对齐。
- YouTube 这类用 MSE 的站点，`currentSrc` 是 `blob:` URL。同一个 MediaSource 的 blob URL 理论上可以挂到多个 `<video>` 上并各自 seek，但这会加倍解码、并可能干扰站点自己的 buffer/abandonment 逻辑，比较脆。

## 结论与选择

| 路线 | 直播 | 点播 | 画质 | CPU | 风险 |
|---|---|---|---|---|---|
| A 延迟播放窗口 | ✅ | ✅ | 有损 | +10~25% | 中 |
| B 前读影子音轨 | ❌ | ✅ | 无损 | 低 | 站点相关，偏脆 |

当前决定：**先不改编排，把现架构的准确率抠到位**（抗混叠、去隆隆声、自动增益、翻译上下文、定稿优先——见 README 第六节），把 A/B 留到之后按需要再上。

## 已经铺好的地基

真要做 A 时，这些已经就位：

- **识别滞后读数**：`noteAsrLatency()` 已经在算"结果覆盖的音频时间点 vs 已送出音频时长"，弹窗也在显示。做 A 的时候，这个值就是决定 D 的输入。
- **ASR 事件已带音频时间戳**：Deepgram 的 `start`/`duration`、Whisper 分片的 `start`/`duration` 已经透传到 `onEvent`。把"音频时间"映射成"媒体时间"只差一个偏移量。
- **字幕渲染层与引擎解耦**：内容脚本只认 `{id, original, translation, state, done}`，加一个"按时间轴调度显示"的层不需要动引擎。
- **音频前端是一条独立支路**（`lib/audio-chain.js`），搬去播放页时整条链可以原样复用。

---

# 实现说明（路线 A）

## 最终方案

```
原标签页（保持播放，退化为信号源；被 tabCapture 自动静音）
   │  chrome.tabCapture.getMediaStreamId({ targetTabId, consumerTabId: 播放页 })
   ▼
播放页 player/player.html（同一个 streamId 的两条支路）
   ├─ 视频+音频 → MediaRecorder → MSE SourceBuffer ──► <video>（推迟 D 秒）
   └─ 原始音频 → 抗混叠 → AGC → AudioWorklet ──► ASR ──► 翻译 ──► 字幕排期
```

三个关键决定：

**1. 用 `consumerTabId` 让播放页直接消费流。**
早期方案是让 offscreen 抓流、再把 MediaRecorder 的分片传给播放页。但 `chrome.runtime.sendMessage`
对 ArrayBuffer 走 JSON 序列化，每秒几 MB 的分片根本搬不动。指定消费者标签页之后，播放页自己
调 `getUserMedia` 就行，一个字都不用搬。顺带整个引擎（识别 / 翻译 / 渲染）都能搬进播放页，
offscreen 在延迟模式下完全不参与。

**2. 直接开播放页，让播放页自己等任务。**

`consumerTabId` 需要一个已存在的标签页 id；而播放页一加载就会去读任务。看起来应该
「先开 `about:blank` → 取流 → 写任务 → 再导航过去」——**这条在真实浏览器里被证伪了**：

> `Caller tab.url is not a valid URL.`

tabCapture 会校验 `consumerTabId` 指向的标签页 url，`about:blank` 不是合法 URL，直接拒绝。
所以必须一开始就指向真正的播放页。代价是播放页可能比任务先加载完，它用 `waitForJob()`
轮询等待，并比对 `playerTabId` 躲开上一次会话残留的旧任务。

再兜一层：`consumerTabId` 若仍然被拒（版本差异、平台差异），退化成不传它——
不传时"流只能被发起调用的扩展使用"，而播放页属于同一个扩展，照样能消费。
消费方式记在任务里，播放页的诊断面板会显示。

失败时会把原因留在任务槽里，让播放页能把错误显示出来，而不是给用户留一个空白标签页。

**3. 只用定稿翻译，不要中间结果。**
画面已经推迟了 D 秒，识别和翻译只要在 D 秒内完成就行——所以可以等整句定稿，
拿最准的那一次译文，彻底摆脱"边听边改"的跳动。这是延迟模式相对叠加模式最大的质量收益，
比速度收益更值。

## 字幕为什么能对上画面

不需要把音频时间映射到媒体时间——因为延迟锁住之后，延迟画面的时间轴和墙上时钟是同步推进的：

```
音频在流里的位置 s（秒）
  → 它在墙上时钟 firstAudioAt + s 被采到
  → 它会在 firstAudioAt + s + D 出现在延迟画面上
```

所以直接把译文按 `firstAudioAt + (start + duration)·1000 + D + 微调` 排进队列，
到点就上屏（`SubtitleSchedule`）。翻译没赶上就先把原文上屏，译文到了再替换——
`late` 标记会记录下来，诊断面板里能看到迟到多少毫秒。

## 延迟怎么锁住

不能"攒够 D 秒就开播"然后不管：缓冲末尾和播放头都在实时推进，任何速率差都会让 D 慢慢漂走；
而频繁 seek 会肉眼可见地跳帧。所以用闭环：

```js
drift = 播放头 − (缓冲末尾 − D)
playbackRate = clamp(1 − drift × 0.4, 0.94, 1.06)   // 死区 ±0.25s
```

`preservesPitch = true` 保证 ±6% 的速率变化不会让人声变调。
启动时先等缓冲攒够 `D + 0.3s` 再 seek 到 `末尾 − D`，那一步天然就把延迟建立起来了。
`lagCorrectionRate()` 是纯函数，单测覆盖了死区、方向、限幅与非法输入。

## 已知代价与边界（都是 tabCapture / MSE 决定的，绕不过去）

- **原标签页会被自动静音**：tabCapture 的固有行为。声音改由播放页的 `<video>` 出，
  所以原页面顶部会弹一条提示（**12 秒后自动收起，也可手动 ✕**），说明"画面搬到播放窗口了"并给一个跳转按钮。
  最初实现成**全屏遮罩，被用户直接否掉了**——它会把整个页面挡住，回到原页面干别的事都不行。
  提示只占顶部一条，不挡内容，而且用户手动关过之后本次会话不再弹。
- **必须重新编码**：MediaRecorder（VP8/VP9）+ MSE。1080p 约多 10–25% CPU，画质有轻微损失。
  码率可以在播放页底部调，代价过高就往下压。
- **DRM 内容直接不可用**（Netflix 这类），会停在"取流失败"。
- **浏览器对同一标签页的第二路捕获可能被拒**，此时会给出可读错误并建议先用叠加模式。
- **MSE 缓冲要主动回收**：只保留播放头之后约 15 秒，否则内存会涨到 `QuotaExceededError`
  （真被拒时是丢一片而不是整条崩掉）。

## 没能验证的部分

**以下全部只在 Node 里测了纯逻辑，浏览器行为一次都没跑过**：

- `consumerTabId` 是否真的能让扩展页面标签消费 tabCapture 流 —— **已经被实测打过一次脸**：
  配合 `about:blank` 消费者会被拒（`Caller tab.url is not a valid URL.`），
  改成直接开播放页后是否成立**仍未经真实浏览器验证**；不成立时有"不带 consumerTabId"的退化路径
- MediaRecorder 的分片节奏与 MSE 的兼容性（`video/webm;codecs="vp9,opus"` 等候选已按优先级探测）
- 闭环纠偏在真实播放器上的稳定性，以及实际能达到的延迟精度
- 1080p60 下的真实 CPU 占用

`lagCorrectionRate` 与 `SubtitleSchedule` 的数学有单测；其余都得在真实浏览器里实测。

