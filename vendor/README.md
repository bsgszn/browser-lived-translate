# vendor/ —— 本地 VAD 的运行时依赖

这里的东西是「本地 VAD 断句」（识别服务选 `vad`）用的，**不参与任何构建，直接原样使用**。

| 文件 | 大小 | 是什么 |
|---|---|---|
| `ort.min.js` | 436 KB | onnxruntime-web 1.20.1 的 UMD 运行时，由 `player/player.html` 用 `<script>` 引入 |
| `ort-wasm-simd-threaded.mjs` | 24 KB | **加载器** —— 主包里用动态 `import()` 拉它 |
| `ort-wasm-simd-threaded.wasm` | 11.0 MB | onnxruntime 的 CPU WASM 后端（本体） |
| `silero_vad.onnx` | 2.2 MB | Silero VAD **v6** 模型（**16kHz 窗长 576**，不是 v5 的 512） |

> ⚠️ **`.mjs` 和 `.wasm` 是两个文件，少一个都不行。**
> 只下本体的话，启动时会报
> `Failed to fetch dynamically imported module: .../ort-wasm-simd-threaded.mjs`。
> 这个坑踩过一次。

## 为什么必须放本地

MV3 的扩展页 CSP 只允许 `'self'`，**不能从 CDN 加载脚本或 WASM**。
所以这些文件必须随扩展一起打包。

## 为什么 manifest 里要加 `wasm-unsafe-eval`

MV3 默认的 `extension_pages` CSP 不允许编译 WebAssembly。
没有它，`onnxruntime` 初始化时会直接失败：

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

## 怎么更新

```powershell
$dst = "vendor"
curl.exe -sL -o "$dst\silero_vad.onnx" "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx"
curl.exe -sL -o "$dst\ort-wasm-simd-threaded.mjs" "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.mjs"
curl.exe -sL -o "$dst\ort-wasm-simd-threaded.wasm" "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.wasm"
curl.exe -sL -o "$dst\ort.min.js" "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js"
```

**升级 onnxruntime 时两个文件必须是同一个版本**，否则 JS 和 WASM 对不上，会在初始化时报版本不匹配。

## 模型接口（Silero VAD）

```
输入:  input  float32 [1, N]       一帧 16kHz 采样，归一化到 -1~1
       state  float32 [2, 1, 128]  循环状态，逐帧传递
       sr     int64   []           采样率，固定 16000
输出:  output float32 [1, 1]       这一帧"有人在说话"的概率
       stateN float32 [2, 1, 128]  更新后的状态
```

### ⚠️ `N` 是 576，不是 512

**这一点极易踩坑。** 网上关于 Silero 的资料绝大多数写的是「16kHz 用 512」——
那是 **v5** 的参数。而 `master` 分支现在给的是 **v6** 模型，窗长 **576**。

**喂错窗长的症状极具迷惑性：模型不报错、输出形状也对、输入电平完全正常，
但概率恒为 0.001** —— 看起来就像"音频里根本没人说话"。

实测（本地跑真模型，4 秒真人语音）：

| 窗长 | 帧数 | 概率中位 | 最高 | 高于 0.9 的帧 |
|---|---|---|---|---|
| 512 | 125 | 0.001 | 0.001 | 0.0% ← 完全聋 |
| 544 | 117 | 0.001 | 0.001 | 0.0% |
| **576** | 111 | 0.069 | **1.000** | **25.2%** ← 正常工作 |
| 640 | 100 | 0.090 | 1.000 | 28.0% |
| 768 以上 | — | 报错（模型拒绝过大的窗） | | |

代码见 `lib/asr/vad.js`；**断句的判断逻辑单独抽在 `lib/asr/vad-gate.js`**，
因为那部分能脱离 ONNX 单测（推理在 Node 里跑不了）。
线上还有**开箱自检**兜底：启动时会用 `vad-selftest.wav` 把几种窗长各跑一遍，
自动挑出峰值最高的那一种 —— 换模型版本时不用改代码。
