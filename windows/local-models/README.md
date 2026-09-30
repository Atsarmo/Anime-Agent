# Windows 本地语音准备 — local-models 0.1.0

[Windows 安装说明](../README-WINDOWS.md) · [验证记录](../WINDOWS-VALIDATION.md#2026-10-01-local-speech)

当前先准备 **ASR 和 TTS**，对话继续使用桌宠已有的云端设置。本模块独立运行，供正在重构的 Windows 应用接入；旧版桌宠的供应商配置和网页选项尚未接到这里。桌宠应用仍为 0.1.2，本模块独立版本为 0.1.0。

## 模型选择

| 类别 | 模型 | 当前准备情况 |
| --- | --- | --- |
| ASR 首选 | SenseVoice Small int8 | 已提供 Windows CPU 推理、模型下载与 OpenAI 转写接口，实测中文样例和 TTS 回转写。|
| ASR 备选 | Paraformer-zh-streaming | 保留配置位置；原生 SDK/WebSocket 是增量识别，需部署兼容转写服务后启用。|
| ASR 备选 | faster-whisper small / turbo | 保留配置位置；需单独部署 OpenAI 兼容服务。|
| TTS 主方案 | **GPT-SoVITS，使用自己的微调模型** | 原生 `/tts` 到 OpenAI 语音接口的适配已完成；需要匹配模型版本的 API 服务、权重和参考音频。|
| TTS CPU 备选 | Kokoro 82M v1.1 中文 int8 | 已提供 Windows CPU 推理、下载与 WAV 接口；固定音色，供单独选择。|
| TTS GPU 备选 | Qwen3-TTS 12Hz 0.6B Base | 预留兼容服务配置；vLLM-Omni 的语音服务需 Linux/WSL，未在本次安装或实测。|

[SenseVoice 官方 ONNX 文档](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)提供小型 CPU 模型。它按整句识别，实时录音应由客户端用 VAD 分段，不能当作逐帧 partial 流式识别。[Paraformer 模型](https://huggingface.co/funasr/paraformer-zh-streaming)和 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)的原生 SDK 不等于 OpenAI 服务；配置中的端口是待部署位置，并非已启动服务。

[Kokoro v1.1 官方音色表与 Node 示例](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html)列出 103 个音色：中文女声 ID 3–57，男声 58–102，输出 24 kHz。默认测试用 ID `3`，它不会替换 GPT-SoVITS。另一个候选为 [Qwen3-TTS 0.6B Base](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base)，兼容服务参考 [vLLM-Omni Speech API](https://docs.vllm.ai/projects/vllm-omni/en/stable/serving/speech_api/)。

## 在 Windows 启动

要求 Windows x64、Node.js 22.12+ 和系统自带的 `curl.exe`、`tar.exe`。ASR 与 Kokoro 使用 CPU，无需 PyTorch/CUDA。以下命令从仓库根目录开始：

```powershell
cd windows/local-models
npm.cmd ci
npm.cmd run configure
& ./tools/prepare-sensevoice.ps1
& ./tools/prepare-model.ps1 -Model kokoro
npm.cmd start
```

网关默认地址 **`http://127.0.0.1:19380/v1`**。配置在 `windows/.local/local-models/config.local.json`，模型、样音和验证结果也保存在该目录。`configure` 不覆盖已有配置。新模块的 `.npmrc` 使用 Windows `ComSpec`，避免本机 npm 的全局 Bash/WSL 配置让测试误入 Linux。

若系统的脚本策略拒绝 `.ps1`，可对这一条启动命令使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./tools/prepare-model.ps1 -Model sensevoice`，以及相同命令的 `-Model kokoro`；无需修改全局脚本策略。

两个量化包分别为 163,002,883 B 和 147,031,220 B。下载器核验精确长度、固定 SHA256 与解包路径，先在 staging 解包，校验完整资源后安装，并记录文件长度和哈希。重跑可修复缺文件或损坏的安装；旧损坏目录保留为 `.incomplete-…`。自定义 `-DataDir` 时，应同时用 `--config PATH` 指定放在该数据目录里的配置，使模型相对路径一致。

模型目录和配置在 Git 忽略范围内。保留下载包中的许可；sherpa 软件、Kokoro、Qwen3-TTS 的许可与 SenseVoice 权重条款分别核对。[FunASR 模型许可](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)不因使用 sherpa 而自动变为 Apache 2.0。

## 接入 GPT-SoVITS 微调音色

使用自己现有的 GPT-SoVITS 版本和 `.ckpt/.pth`，在该安装目录启动：

```powershell
python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

将本模块配置中的 `gpt-sovits.voices` 改为自己的音色，例如：

```json
{
  "pet": {
    "refAudioPath": "C:/AAAAGENT-voices/reference.wav",
    "promptText": "参考音频中实际说出的原文。",
    "promptLanguage": "zh",
    "textLanguage": "zh",
    "gptWeightsPath": "C:/GPT-SoVITS/GPT_weights/your-voice.ckpt",
    "sovitsWeightsPath": "C:/GPT-SoVITS/SoVITS_weights/your-voice.pth"
  }
}
```

参考 WAV 按官方推理要求准备为 3–10 秒；路径必须是本机 GPT 进程能读取的文件。`.ckpt/.pth` 是示例后缀，具体模型必须与安装版本匹配。若权重已在后端 YAML 固定，可在所有音色中省略两个权重字段；若需要按音色切换，所有音色都必须填写完整权重对。配置修改后重启网关。

接口按[官方 `api_v2.py`](https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py)发送 `/tts`，使用 `streaming_mode:false` 兼容旧整合包。权重选择通过独立的 `/set_gpt_weights` 和 `/set_sovits_weights`，完整选择与合成按同一个服务串行处理。客户端取消后，后台合成完成才释放权重锁。后台硬超时后状态未知，需要重启 GPT API 和网关再继续；没有自动重试。

**RTX 50 系列**应使用与微调版本匹配的官方 `nvidia50` 整合包或 CU128 环境。比如[官方 v2Pro 50 系包](https://huggingface.co/lj1995/GPT-SoVITS-windows-package/blob/main/GPT-SoVITS-v2pro-20250604-nvidia50.7z)约 8.84 GB；本次没有下载或替换 GPT 模型版本。`doctor` 只核对服务与参考资源，自己的微调音色效果仍需真实试听。

## 接口与调用

提供 [OpenAI 转写请求](https://developers.openai.com/api/reference/typescript/resources/audio/subresources/transcriptions/methods/create)和[语音请求](https://developers.openai.com/api/reference/cli/resources/audio/subresources/speech/methods/create)的常用子集：

| 接口 | 行为 |
| --- | --- |
| `GET /v1/models` | 已启用的配置目录，不代表每个后端已就绪。|
| `GET /health` | 网关状态；后端就绪度用 `doctor` 检查。|
| `POST /v1/audio/transcriptions` | multipart `model/file/language/response_format`。SenseVoice 支持 `json/text/verbose_json`，PCM16 单声道 WAV，8–48 kHz，每段最多 60 秒。|
| `POST /v1/audio/speech` | JSON `model/input/voice/response_format/speed`，返回二进制音频。GPT 和 Kokoro 默认 WAV，当前适配为完整音频。|

GPT 适配支持 `wav/ogg/aac`；Kokoro 支持 WAV。GPT raw 可能为 32 kHz，与 [OpenAI PCM 的 24 kHz 约定](https://developers.openai.com/api/docs/guides/text-to-speech#supported-output-formats)不一致，因此当前拒绝 `pcm`，不会把不同采样率的裸音频伪装成标准输出。GPT 的 OGG/AAC 还取决于其本机编码器，首轮建议统一 WAV。

OpenAI SDK 可将 `base_url` 指向网关，并使用占位 `api_key="local"`。该占位值不转发给后端。后续重构可直接引用 `src/server.mjs` 的 `createGateway(config)`，或作为独立服务消费语音端点。与旧应用连接时，要明确传递实际音频采样率；Kokoro 为 24 kHz，GPT 以 WAV 头为准。

```powershell
# 用实际录音替换文件路径
curl.exe http://127.0.0.1:19380/v1/audio/transcriptions `
  -F 'model=sensevoice-small' -F 'language=zh' -F 'file=@C:/audio/recording.wav'

$speech = @{ model='kokoro-82m'; input='你好，今天我们一起测试本地语音。'; voice='3'; response_format='wav' } | ConvertTo-Json
Invoke-WebRequest -Uri http://127.0.0.1:19380/v1/audio/speech -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($speech)) -OutFile sample.wav
# GPT-SoVITS: model='gpt-sovits', voice='pet'
```

备用 OpenAI 兼容服务的 `baseUrl` 应包含 `/v1`；模型别名映射到该服务真实加载的模型 ID。Qwen Base 克隆等扩展参数需按自己的兼容服务文档填写，网关原样转发，不假定所有 TTS 原生支持 OpenAI。

## MiniMax 与后续对话接口

MiniMax 官方语音支持 `speech-2.8-turbo/hd` 的 `/t2a_v2` 到 OpenAI 语音格式适配，处理 hex 音频和 HTTP 200 内部错误。默认关闭，显式启用并设置 `$env:MINIMAX_API_KEY` 才调用。它是云端服务，不是本机小型权重；[官方语音协议](https://platform.minimax.io/docs/api-reference/speech-t2a-http)说明了模型与格式。现有百炼托管 MiniMax 路径继续使用原桌宠配置。本次没有调用付费云端语音。

通用 `/v1/chat/completions` 和 Ollama `/api/chat` 保留为后续接口，默认所有对话提供方关闭。当前对话继续使用原桌宠云端配置，本次语音 smoke 不发送对话请求。未来启用 Ollama 时，使用其[官方兼容接口](https://docs.ollama.com/api/openai-compatibility)；MiniMax 文本也可用[官方 OpenAI 协议](https://platform.minimax.io/docs/api-reference/text-openai-api)。

## 验证与当前边界

另开一个 PowerShell，在模块目录运行：

```powershell
npm.cmd test
npm.cmd run doctor
node tools/smoke.mjs --tts-model kokoro-82m --voice 3
# 自己的录音
node tools/smoke.mjs --audio C:/audio/recording.wav --tts-model kokoro-82m --voice 3
# 微调 GPT 服务就绪后
node tools/smoke.mjs --tts-model gpt-sovits --voice pet
```

`doctor` 在 GPT 音色未配置时返回未就绪，这是实际缺项；不会以 Kokoro 自动代替。smoke 识别官方样例、生成语音、检查非静音 WAV，再转写生成音频；结果写入 `.local/local-models/validation.json`。16 项协议与取消测试在 Windows 通过；真实 SenseVoice 和 Kokoro 已运行。GPT 使用模拟 HTTP 验证参数、权重与取消语义；自己的微调音色、Qwen 服务、麦克风和扬声器尚未完成实测。详见[本次验证](../WINDOWS-VALIDATION.md#2026-10-01-local-speech)。

另已用现有 DeepSeek 云端配置完成一次“本地 ASR → 云端对话 → 本地 Kokoro TTS”的真实测试，云端回复为“收到，本地语音测试正常。”。该测试没有启用本地对话模型，也没有修改旧桌宠配置。

## English

This is a separate Windows speech preparation service, version 0.1.0. The pet remains 0.1.2 and keeps its existing cloud dialogue configuration. Local dialogue is disabled. During the application refactor, connect ASR/TTS clients to `http://127.0.0.1:19380/v1`; the existing pet UI/provider schema has not yet been switched to this service.

Use `npm.cmd ci`, `npm.cmd run configure`, the two PowerShell download commands above, then `npm.cmd start`. Downloads use pinned SHA256, staging and a file inventory, preserving incomplete installations. All weights, local settings and samples live under ignored `windows/.local/local-models/`.

SenseVoice int8 runs on CPU and accepts utterance WAV uploads. GPT-SoVITS is the primary TTS and needs your matching weights, 3–10 second reference audio and native API. Kokoro 82M is an explicitly selected CPU alternative; Qwen3-TTS 0.6B remains an optional Linux/WSL compatible-server candidate. Native ASR SDKs also need a compatible server before enabling the reserved Paraformer/Whisper entries. MiniMax native cloud speech is supported but disabled and was not called in validation.

Run `npm.cmd test` and `node tools/smoke.mjs --tts-model kokoro-82m --voice 3` with the gateway running. Windows CPU inference and the speech round trip passed; GPT fine-tuned voice quality and physical microphone/speaker use remain unverified.
