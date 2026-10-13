# 开发期工具

这些脚本**不参与扩展运行**，只用于开发自检。扩展本身零依赖、零构建。

## 跑测试

在扩展根目录（有 `package.json` 的那一层）：

```bash
node tools/manifest-check.mjs   # 91 项：manifest / 路径 / DOM id / 硬约束 静态完整性
node tools/smoke-test.mjs       # 335 项：模块加载 / 音频前端数值 / 断句状态机 / 预设 / 术语表 / 签名
node tools/pipeline-test.mjs    # 126 项：音频引擎全链路（桩对象驱动）
node tools/worker-test.mjs      # 60 项：service worker 状态机与消息路由
```

或者：

```bash
npm test
```

不需要 `npm install` —— 脚本只用 Node 内置能力。合计 **612 项断言**。

### `manifest-check.mjs`

没有构建步骤的扩展最容易死在"文件路径写错"上。这个脚本把清单、HTML 的 `src`/`href`、
JS 的 `import` 与 `chrome.runtime.getURL(...)` 全部对一遍磁盘，并检查几个硬约束：

- manifest.json 无 BOM、是合法 UTF-8、`manifest_version: 3`
- 图标、popup、service worker、options、内容脚本、WAR 资源全部存在
- 所有相对 import 都能解析
- `background.type === "module"`
- `content/content.js` 是经典脚本（不能含 `import`，内容脚本不支持 ESM）

### `smoke-test.mjs`

用桩 `chrome.*` 在 Node 里 import 所有扩展模块，确认：

- 相对导入路径全部可解析（Node 对 ESM 的解析规则和 Chrome 一致）
- 顶层代码不会抛异常
- `Resampler`（48k→16k / 48k→24k / 44100→16k）、`buildWav`、`rms`、`chunkText`、`int16ToBase64` 行为正确
- 每个 ASR / 翻译提供方都能被工厂正确构造，缺 Key 时报出可读的中文错误
- **每个识别服务都被就绪校验和适配器注册表同时认识**（漏一个就是"能选但不让启动"）
- **每个预设里的设置路径都真实存在**（写错路径会静默无效）；会改整套配置的预设必须带 `warn`
- **每个翻译服务的"清单 / 配置块 / 设置页字段"三者对得上**（缺一边就是选中就崩或永远选不到）
- **签名实现逐位对上标准测试向量**（MD5 用 RFC 1321 的 7 组含跨块输入 + 中文；
  HMAC-SHA256 用 RFC 4231；SHA-1 / SHA-256 用 `abc`）—— 签名算错时服务端只会回一句"签名不匹配"
- **VAD 断句状态机**（脱机纯逻辑）：迟滞（概率在阈值附近抖动时只收句一次）、
  软/硬边界、帧区间换算采样区间时的留白与夹取、`NaN` 帧能推进计数且不污染状态
- **幻听清单不误杀真实直播用语**（`チャンネル登録お願いします` / `おやすみなさい` / `ありがとうございました` 必须放行）
- 几个**防复发**的结构断言：源码里不许出现未定义的类名、改过默认值的设置项必须有迁移、
  启动失败必须清理、`stop()` 必须收尾冲刷

音频前端部分用一个**纯数值的滤波器测试**验证设计：按 RBJ cookbook 公式复现 Web Audio
`BiquadFilterNode` 的传递函数，算出 8 阶 Butterworth 级联的幅频特性，断言：

- 通带（300Hz / 1kHz / 3kHz / 6kHz）几乎无衰减
- 阻带 8kHz < −6dB、12kHz < −30dB、16kHz < −45dB
- 9.6kHz 处的抑制比旧的 3 点盒式平均**至少好 10dB**（这是本次改动的核心目的）
- 80Hz 高通在 20Hz 处 < −10dB，200Hz 以上几乎无影响
- AGC 策略：低于噪声门不放大、只提升不衰减、非法输入回落、增益能收敛也能回落

翻译部分桩掉 `fetch` 并检查真实请求体：上下文进 system 消息而不进 user 消息、上下文里混入
待翻译文本时被剔除、超长上下文被截断、术语表被写进 prompt、DeepL 走官方 `context` 字段、
Google 免 Key 通道不发送上下文。

### `pipeline-test.mjs`

桩掉 `AudioContext` / `AudioWorkletNode` / `WebSocket` / `fetch` / `getUserMedia` / `performance.now`，
直接驱动 `offscreen/offscreen.js` 的消息入口，走完真实链路：

```
OFFSCREEN_START → getUserMedia 约束 → AudioWorklet 加载 → 分析支路接线
      → PCM 块 → 重采样 → WebSocket 二进制帧 → 模拟 Deepgram Results
      → 翻译（带上下文）→ 下发字幕 → 热更新设置 → 停止并回收资源 → 重新启动
```

覆盖的关键不变量：

- 48k→16k 重采样后每块字节数正确
- PCM 以二进制帧（不是文本）送出
- **抗混叠链只挂在分析支路上**：`source` 有两个下游（回放增益 + 分析链），回放增益直连 destination，`source` 不直连 worklet
- 低通截止频率随目标采样率变化（16kHz 输出对应 7040Hz），Q 值等于标准 Butterworth 极点
- **AGC 会随时间收敛**（安静输入升到 +12dB 上限，变响后回落到 1），关闭开关后不再改动
- 中间结果与定稿复用同一字幕行，不重复开行
- 只补词时沿用旧译文；原文被改写时旧译文立刻清空（避免字幕错配）
- 同一文本走翻译缓存，不重复请求
- 中间结果字数门槛只拦中间结果，不拦定稿
- 识别滞后读数能算出来、异常值被夹在上限内、没有时间信息的服务不会上报 NaN
- 翻译上下文逐句累积、不含自身、受 `contextSegments` 限制
- 重复的 final 被去重，空白转写不产生字幕
- 停止后音轨 / AudioContext / Worklet / WebSocket 全部回收，且不再产生字幕

### `worker-test.mjs`

这是**后补的覆盖缺口**。service worker 是字幕与状态的中枢，但最初完全没有测试——结果一个
「跨 `await` 的读-改-写没有串行化」的竞态溜了过去：`LIVEDUB_LEVEL` 每 250ms 一条、
延迟读数随时会到，两个并发更新各自读到同一份旧状态再先后写回，后写的把先写的字段抹掉。
实测症状是**连续两条历史推送，句数只加到 1**。

脚本用内存版 `chrome.storage` 驱动 SW 的消息入口，并且**故意给存储加固定种子的伪随机延迟**
——那个"不按顺序完成"就是竞态的窗口，没有它测不出来。

覆盖：

- 启动流程：缺 Key 拒绝启动并给可读原因、成功启动后状态/角标/offscreen/streamId 都对
- **状态单调性**：一旦某个读数出现过，之后的任何一次状态广播都不许把它变回 `null`。
  判定不能用"最终值对不对"——那会被最后一次写入侥幸掩盖
- 只有一项更新时，不能把另一项清空
- 字幕按 offscreen 给的 tabId 转发；没带 tabId 时回落到状态里的 tabId
- 历史追加与译文回填不丢条目、句数正确累加
- 音源过低提示的触发与恢复
- 音频结束时自动停止、资源回收、读数归零
- **延迟模式**：**先取流、再建播放页**（顺序反了 `activeTab` 授权会失效，`getMediaStreamId`
  报 `Extension has not been invoked for the current page`）→ 任务落盘 → 关掉播放页 / 播放页报停
  都会整体停止并清掉任务与遮罩。取流时只传 `targetTabId`（那一刻播放页还不存在，
  给不出 `consumerTabId`），消费方式记为 `extension`

## 版本历史

> **版本号在 1.0.0 处重置过一次。**
> 这个项目在开发期一路迭代到过 `1.9.1`，然后回退、又走到 `1.7.1`；
> 后来把当时的状态正式定为 **`1.0.0`**（第一个正式版本）。
> 所以 `_versions/` 里会看到 `v1.9.1_before-rollback_*` 和 `v1.0.0_release_*` 并排 ——
> **那些旧目录名是当时的真实版本号，没有改**，保留原样当历史记录。
> 看到 `v1.9.1` 比 `v1.0.0` "大"不代表它更新，按时间戳判断。

有两套机制，**都留着**——它们防的是不同的东西：

| | git | `_versions` 快照 |
|---|---|---|
| 粒度 | 逐行差异 | 整份拷贝 |
| 能回答 | "这行为什么变成这样" | "当时整个文件夹长什么样" |
| 位置 | 扩展目录内的 `.git/` | 扩展目录外的 `../_versions/` |
| 依赖 | 需要 git | 零依赖，纯文件操作 |

快照那套的意义在于：**万一 `.git` 本身坏了、或者误删了仓库，它还在**。

### git

这个项目用 git 记录历史。机器上的 git 是**便携版**（MinGit），解压在扩展目录外面的
`../_tools/git/`，**不在 PATH 里**——所以 `tools/git.mjs` 会自己去找它，查找顺序是：

1. PATH 里的 `git`（以后用 winget 正装了就走这条）
2. `../_tools/git/cmd/git.exe`
3. `../_tools/git/ucrt64/bin/git.exe`
4. `Program Files` / `LOCALAPPDATA` 下的常规安装位置

找不到时所有函数都安全降级——git 是锦上添花，不该让别的东西跟着挂掉。

**仓库内的配置**（只写 `.git/config`，不碰全局配置）：
`core.autocrlf=false`、`core.quotepath=false`、`user.name` / `user.email`。
配合 `.gitattributes` 里的 `* text=auto eol=lf`，行尾锁死 LF，
否则 Windows 上每次提交都会显示"整个文件都改了"。

#### ⚠️ 发布之后：不要重写历史

首次公开发布（v2.60.0）时，历史被**刻意压成过一条提交** —— 目的是去掉开发史、旧截图、
本机路径，让第一次见到这个仓库的人是干净的。

**那次之后不要再 `--amend`、不要再 `--force`。** 改动一律**新增提交**，用普通 `git push`。

理由：Release 已经发出去了，继续重写已发布的历史，会给 clone / fork 过的人造成冲突。
（这个项目在 v2.60.0 之后又 amend 过六次、force push 了三次，才把这条定下来 ——
每一次都是一次"重写公开历史"的机会。）

连带的一条：`node tools/bump-version.mjs` **会自动提交**。
以前为了让"发布只有一条提交"，每次都要 `git reset --soft HEAD~1` 再 amend 回去 ——
**现在不用了，让它留着那条提交就行。**

### `_versions` 快照

**这台机器上没有 git**（后来才装的便携版），而这个扩展被反复大改过。有一次需要
"回退到某个版本但保留其中一个功能"，只能靠手工一行行拆——很危险，而且拆错了没法恢复。
所以做成了**自动存档**：

```bash
node tools/snapshot.mjs                       # 存一份，标签 auto
node tools/snapshot.mjs before-big-change     # 动手前先存一份
node tools/snapshot.mjs --list                # 列出全部历史版本
node tools/snapshot.mjs --prune 20            # 只保留最近 20 份
```

快照存在扩展目录**外面**的 `../_versions/`（这样不会被当成扩展的一部分打包），
目录名形如 `v<版本>_<标签>_<时间戳>`，同时维护一份 `../_versions/INDEX.md` 索引。

还原某一份：

```powershell
node tools/snapshot.mjs before-restore        # 先把当前状态也存一份
robocopy ..\_versions\<目录名> . /MIR /XD node_modules .git
```

排除规则：`node_modules` / `.git` / `_versions` / `dist` / `build` 不进快照
（不排除的话光是依赖就能撑到几百 MB，快照就没法用了）。

### ⚠️ 沙箱下的两个坑（都踩过，都有断言盯着）

1. **不要用管道捕获子进程输出。** `execFileSync` / `execSync` 默认 `stdio: 'pipe'`，
   在沙箱下一律 `EPERM`。`bump-version` 和 `git.mjs` 各踩过一次。
   正确做法是 `import` 同进程调用，或者把输出重定向到**文件描述符**：
   `spawnSync(exe, args, { stdio: ['ignore', ofd, efd] })`。

2. **静态检查要先剥注释。** 注释里出现 `execFileSync` / `new AudioWorkletNode` 这类词
   会让正则检查误报。这个项目因为不剥注释产生过**四次**假阳性
   （最近一次：有人在 `panelShown` 的文档注释里写了旧写法 `panel.dataset.panel === asrId`
   用来记录踩过的坑 —— 断言于是命中了**自己的注释**）。

## ⚠️ 不要用 `git checkout -- <file>` 去还原

**这条不是"注意事项"，是"这么干会丢工作"。上一轮连同上级在内，踩了五次。**

```bash
git checkout -- tools/README.md     # ✗ 别这么干
```

**为什么危险：它恢复的是 **HEAD 里的版本**，而不是"你五分钟前的样子"。**
**那个文件里所有**未提交的真实改动会一起消失** —— 包括你刚写对、还没来得及提交的部分。**

**为什么明知危险还会踩：因为人在着急的时候会本能地敲它。** 光写"不要这样做"没用，
得有一条**能照做的路子**：

### ✓ 要还原文件时这样做

```js
// 1. 先把文件复制到**仓库外**的备份副本
const fs = require('fs'), path = require('path'), os = require('os');
const BAK = path.join(os.tmpdir(), 'dsh-bak');          // ← 仓库外，不会进 git；别写死绝对路径
fs.mkdirSync(BAK, { recursive: true });

// ⚠️ 备份名**必须保留目录层级**
const backName = (rel) => rel.split('/').join('__');    // 'tools/README.md' → 'tools__README.md'

const src = path.join(ROOT, rel);
const dst = path.join(BAK, backName(rel));
fs.copyFileSync(src, dst);                              // ← 先备份，再动手

// 2. 改文件、做实验、跑变异测试……

// 3. 还原时从**备份副本**复制回去（不是从 git）
fs.copyFileSync(dst, src);

// 4. 逐字节确认还原正确
Buffer.compare(fs.readFileSync(dst), fs.readFileSync(src)) === 0;   // 必须为 true
```

**⚠️ 别用 `path.basename()` 命名备份 —— 它会撞车：**

| 表达式 | 结果 |
|---|---|
| `path.basename('README.md')` | `README.md` |
| `path.basename('tools/README.md')` | **`README.md`** ← 同名，第二个覆盖第一个 |

**真实事故：** 有人用 `basename` 命名备份，还原时把 `tools/README.md` 的内容写进了 `README.md`，
**1463 行的 README 变成了 301 行。** 从 git 恢复后重新应用了三处改动才救回来
（好在当时那三处改动都还记得是什么 —— 换成复杂的改动就未必了）。

**只有在你确定那处改动本来就不想要时，才可以用 `git checkout`。**
"做变异测试、试完想还原"**不属于**这种情况 —— 那正是最容易连带丢掉真实改动的场景。

## ⚠️ 不要用 PowerShell 往返文本

**这个项目被同一类问题咬了四次，四个不同的人踩过 —— 同一个根因，四个不同的入口：**

| 入口 | 默认编码 | 后果（都真实发生过） |
|---|---|---|
| `Set-Content` | **GBK** | 中文全变乱码，README 从 1283 行掉到 874 行 |
| `Set-Content` | GBK | 又一次 |
| `Set-Content` | GBK | 又一次 |
| `>` 重定向 | **UTF-16LE** | `git log … > msg.txt` 读回来是 `��v 2 . 6 5 . 0` |

**规矩：改文件、读命令输出，一律走 Node + 显式 `utf8`。**

```js
const fs = require('fs');
const s = fs.readFileSync(p, 'utf8');   // ← 显式 utf8，别省
fs.writeFileSync(p, s, 'utf8');         // ← 同上
```

**不要用** PowerShell 的 `Set-Content` / `Out-File` / `>` / `>>` **往返任何含中文的文本**。

### 还有一条相关的：`node -e` 里的 `${}` 会被 PowerShell 吃掉

PowerShell 会把内联 `node -e "…${var}…"` 里的 `${}` 当成自己的变量引用，
导致脚本报 `Expected ',', got '<eof>'` 之类的语法错。这个坑也踩过不止一次。

**所以稍复杂一点的脚本，写成 `.cjs` 文件再 `node xxx.cjs` 跑**，不要硬扛内联字符串。
（`.mjs` 里没有 `require`，要用 `import`；这类小脚本用 `.cjs` 最省事。）

## 改版本号

```bash
node tools/bump-version.mjs 1.2.1     # 指定版本
node tools/bump-version.mjs patch     # 自动 +0.0.1
node tools/bump-version.mjs minor     # 自动 +0.1.0
```

版本号唯一的真相在 `manifest.json`。脚本会：

1. 同步到 `package.json`
2. 列出文档里还停留在旧版本号的位置（`manifest-check` 也会因此报错）
3. **自动存一份 `_versions` 快照**
4. **自动提交一次 git**（没装 git / 不是仓库时安全跳过）

**为什么值得有这个脚本**：这个项目被"改了代码忘记升版本号，用户在弹窗里看到的还是旧号，
根本没法判断自己加载的是哪个构建"坑过不止一次——连带把好几轮修复的验证都拖成了无用功。

### ⚠️ 先提交修复，再改版本号

**`bump-version` 会自动提交一次 git，而它的提交信息只有版本号。** 所以次序反了会变成这样：

```
✗ 错的次序：先 bump-version，再提交修复

  3b1ce5e  v2.66.8                                    ← 消息只有版本号，但**全部代码改动在这里**
  7755f93  fix(options): 选「阿里云百炼」时看不到断句旋钮   ← 消息写得很详细，实际只改了 README.md

  → git log 读起来像"修复在第二条"，而第二条里根本没有代码
  → 以后排查"这个 bug 是哪次改的"，会查到错的那条提交上
```

```
✓ 对的次序：先提交修复，再 bump-version

  a1b2c3d  fix(options): 选「阿里云百炼」时看不到断句旋钮    ← 代码 + 详细说明
  e4f5g6h  v2.66.8                                     ← 只有版本号，因为它确实只改了版本号
```

所以流程是：

```bash
# 1. 先把修复提交掉，消息写清"为什么"
git add -A
git commit -m "fix(...): ..."

# 2. 再升版本号（它会自己提交一次，只带版本号）
node tools/bump-version.mjs patch

# 3. 如果版本号还需要同步文档，再单独提交一次
git add -A
git commit -m "docs: 同步 README 的版本号与断言数到 X.Y.Z"
```

**这条是 v2.66.8 那次真实事故之后定的**：当时 `bump-version` 先跑，代码被卷进 `v2.66.8`
那条只有版本号的提交里，而详细的修复说明落在了一条只改了 `README.md` 的提交上 ——
两条都没推，所以只是历史读起来别扭；**但一旦推上去就改不回来了。**

## 生成图标

```bash
python tools/make_icons.py     # 需要 Pillow，输出到 icons/
```

纯几何绘制（深色圆角底 + 蓝色声波），不依赖字体，所以不同平台结果一致。
