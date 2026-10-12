# 第三方组件与许可

本项目自身以 **MIT** 许可发布（见 [LICENSE](LICENSE)）。
下面列出**随本项目一起分发**的第三方文件，以及它们各自的许可。
这些组件的许可都要求在使用时保留其版权与许可声明 —— 所以这份文件是必须的，不是可选的。

## 随仓库分发的文件（`vendor/`）

| 文件 | 组件 | 版本 | 许可 | 来源 |
|---|---|---|---|---|
| `vendor/ort.min.js` | [onnxruntime-web](https://github.com/microsoft/onnxruntime) | 1.20.1 | MIT | npm |
| `vendor/ort-wasm-simd-threaded.mjs` | 同上（WASM 加载器） | 1.20.1 | MIT | npm |
| `vendor/ort-wasm-simd-threaded.wasm` | 同上（CPU WASM 后端） | 1.20.1 | MIT | npm |
| `vendor/silero_vad.onnx` | [Silero VAD](https://github.com/snakers4/silero-vad) | v6 | MIT | GitHub |
| `vendor/vad-selftest.wav` | 本项目自制（一段 4 秒日语语音，用于 VAD 开箱自检） | — | 同本项目 | — |

## 只在运行时调用、不分发的组件

这些不随仓库分发，但项目功能依赖它们，用户需要自行准备：

| 组件 | 许可 | 用途 |
|---|---|---|
| [whisper.cpp](https://github.com/ggerganov/whisper.cpp) | MIT | 本地语音识别服务（推荐） |
| [faster-whisper-server](https://github.com/speaches-ai/speaches) | MIT | 本地语音识别服务（备选） |
| [OpenAI Whisper 模型](https://github.com/openai/whisper) | MIT | 识别模型本体（`large-v3` 等） |

## 云端服务

以下是**可选的**云端识别/翻译服务，使用时会把你所在标签页的音频发往对应服务商，
需要你自己申请 API Key，并遵守各自的服务条款：

| 服务 | 用途 |
|---|---|
| [Deepgram](https://deepgram.com/) | 实时流式语音识别 |
| [DeepL](https://www.deepl.com/) | 翻译 |
| [OpenAI](https://openai.com/) | 实时语音识别 / 翻译 |
| Google 翻译公开通道 | 翻译（无需 Key） |

## 商标

以上名称与商标归各自所有者所有。本项目与上述任一公司均无隶属或背书关系。
