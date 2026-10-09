# 声音模块

桌宠声音的代码、训练流程和本机资源统一放在这里。声音页面仍从桌宠的“角色设置 → 声音”打开。

## 目录

| 位置 | 内容 | 上传 GitHub |
| --- | --- | --- |
| `src/` | 声音配置、设置页面、引擎调度、中日双语与音频分块 | 是 |
| `engines/` | 本机 Python 服务、Fish 加速、适配器与缓存 | 是 |
| `tools/` | 声音服务启动入口 | 是 |
| `training/fish/` | 素材整理、日语转写校对、编码、LoRA 训练与评估脚本 | 是 |
| `examples/` | 不含个人路径或凭据的配置示例 | 是 |
| `.local/voice-lab/models/` | 下载的基础模型 | 否 |
| `.local/voice-lab/corpus/` | 原始语音与已有校对素材 | 否 |
| `.local/voice-lab/fish-aris-v1/` | 新素材、标注、训练集、权重、试听与评估结果 | 否 |
| `.local/voice-lab/envs/`、`repos/`、`cache/` | Python 环境、第三方项目与缓存 | 否 |
| `.local/gpt-sovits/` | GPT-SoVITS 组件、原有训练权重与环境 | 否 |
| `.local/settings/` | 本机声音配置、服务状态与临时认证信息 | 否 |
| `.local/imports/` | 从原 `Sound` 文件夹收拢的素材 | 否 |

`.local` 包含大量文件，默认隐藏在部分编辑器中；可在 Windows 文件资源管理器中直接打开。

## 使用与配置

桌宠仍从 `windows/code/desktop-pet` 启动，旧声音入口保留兼容转发。移动声音目录没有改变 Codex 登录方式或角色设定。

支持 GPT-SoVITS、Style-Bert-VITS2、CosyVoice、Fish Speech、Fish 微调和日语 TTS + RVC；各引擎需要各自的第三方依赖、基础模型与本机就绪配置。仓库不附带这些大文件，下载源码不代表模型已经可用。

直接启动当前选择的非 GPT-SoVITS 声音：

```powershell
node sound/tools/start-voice-engine.mjs
```

GPT-SoVITS 默认组件目录为 `sound/.local/gpt-sovits`，也可用启动参数或 `PET_GPTSOVITS_HOME` 指定。将 `examples/gpt-sovits-models.example.json` 复制到 `.local/gpt-sovits-models.json`，填写相对组件目录的权重路径，再启动：

```powershell
node sound/tools/start-gpt-sovits.mjs
```

声音配置在网页中保存。`examples/voice.example.json` 仅作为字段说明，不能覆盖正在使用的个人配置。参考音频及其准确原文须在本机填写。Fish 的参考配置、微调权重选择等仍存放于 `.local/voice-lab`。

聊天中的日语合成有 60 秒等待上限；声音加载或合成失败时保留中文字幕。取消或超时会清理本轮对应的声音服务，避免旧任务持续堵塞后续回复。试听保留较长等待时间。Fish 模型需要较多显存，同时运行其他 GPU 程序可能明显变慢。

## Fish 训练与日语校对

训练脚本默认读写 `.local/voice-lab/fish-aris-v1`，而不是源码目录。可通过 `PET_VOICE_LAB` 和 `PET_FISH_DATASET` 指定其他本机目录。使用配置了相应依赖的 Python 环境运行。

1. `collect.py` 根据本机 `kivo-*.json` 元数据整理与下载语音。
2. `transcribe.py` 生成独立日语识别结果。
3. `prepare.py` 对照网页日语台词与识别结果，筛选片段并划分训练、验证数据。
4. `encode.py` 生成语音编码；`train.py` 训练 Fish S2 Pro 的 fast 分支 LoRA。
5. `evaluate.py` 生成对比试听，`assess.py` 复核识别结果，`report.py` 生成本机报告。
6. `serve.py 12118` 打开仅监听 `127.0.0.1` 的试听报告服务。

这些脚本保留当前爱丽丝实验流程，需要对应元数据、参考配置与基础模型。自动转写和文本比对不等于逐条人工听音校对。素材、模型的许可沿用其各自来源，不随本项目源码一起发布。

## GitHub 上传检查

`sound/.gitignore` 排除本机素材、权重、环境、缓存、日志和个人配置。提交前在本仓库根目录运行：

```powershell
git status --short
git diff --cached --stat
git diff --cached --name-only
```

确认待提交列表没有 `.local`、音频、权重或密钥文件。不要使用 `git add -f` 绕过忽略规则。运行时生成的声音服务 token 与 OpenAI/Codex 登录凭据都不属于公开配置。

可运行 `python sound/tools/check-upload.py` 检查当前仓库的上传候选文件。检查器只报告路径、行号与问题类型，不打印密钥；覆盖常见密钥格式、大文件和私有资源误入，但不能代替完整的历史凭据审计。

本机迁移保留了旧路径的目录联接，供已有 Python 环境、标注中的绝对路径以及外部快捷方式继续使用；它们指向这里的真实文件，不是另一份模型副本。目录联接及本机资源不上传 GitHub。
