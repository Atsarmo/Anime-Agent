# Windows local-models 0.1.0 — 2026-10-01

- 新增独立本地语音网关，供应用重构接入；桌宠版本保持 0.1.2，对话沿用已有云端配置，本地对话默认关闭。
- 实现 SenseVoice Small int8 与 Kokoro 82M 的 Windows CPU 推理和 OpenAI 语音接口；提供校验下载、staging 安装、损坏安装修复及真实音频 smoke。
- 保留 GPT-SoVITS 为主 TTS，适配原生参考音频、权重选择与完整音频；补齐权重对校验、串行合成、及时取消和后台状态未知处理，拒绝采样率不兼容的 raw PCM。
- 预留 Paraformer、Whisper 和 Qwen3-TTS 兼容服务配置，新增默认关闭的 MiniMax 原生云端语音适配。
- Windows 协议回归 16 项通过，真实 SenseVoice/Kokoro 和 TTS→ASR 回转写通过；GPT 微调权重与参考音频仍需自行配置。更新 Windows 文档和首页 Windows 信息。

验证范围见 [本地语音验证](WINDOWS-VALIDATION.md#2026-10-01-local-speech)。

# Windows 0.1.2 — 2026-09-19

- 修复管理员运行器默认以 Administrators 为文件所有者时的误拒绝：仅接纳当前提升令牌的 Administrators 所有者，继续拒绝其他所有者和宽泛访问权限。

- 同步上游独立情绪状态：用户情绪、桌宠心情、消息快照、后续推测和网页查询；保留来源失效、版本与并发校验。
- 完成旧聊天导入、自助 Key/模型选择和参考音频设置的 Windows 回归。
- 修复新增测试在 Windows 上的 SQLite 连接清理、无管理员符号链接和 POSIX 权限假设，并更新供应商目录断言。
- 增加使用现有 Electron 的 Chromium 情绪界面回归及合成服务，无需另装 WebKit 或浏览器依赖。
- 新增情绪后端及界面测试命令，保留现有 Windows CI；更新 Windows 安装、升级、记忆与验证文档和首页的平台说明。
- 保留 0.1.1 Codex/Harness 派发、ACL/文件身份、退出清理及本地模型参数覆盖。

验证及未覆盖设备见 [Windows validation](WINDOWS-VALIDATION.md#2026-09-19-windows-update)。Mac 实现和 Mac 专用文档未修改。

# Windows 0.1.1 — 2026-09-17

- Codex 派发改用 Windows 官方 app-server JSONL 接口，支持已有任务、继承设置和精确回执；响应不明时不自动重发。
- 补齐旧 Harness 转交预设缺失的 MCP 入口，校验本机管理会话并只返回任务回执。
- Harness 支持 Windows 盘符工作目录、自定义 DSH_HOME；修复预设文件 ACL，并提供准备工具。
- 修复 Windows Node 路径 stat 与句柄 fstat 的设备编号差异导致合法凭据、数据库被拒绝的问题。
- 退出时等待后端完成清理，避免提前断开管道遗留锁。
- 支持本地模型参数覆盖；私有模型通过原生外观开关关闭水印，素材和私人参数不发布。
- 修复人工编辑记忆的保留逻辑，更新过期供应商测试数据，固定 Windows npm script-shell。

验证与限制见 [Windows validation](WINDOWS-VALIDATION.md#2026-09-17-windows-reproduction)。本次修改仅位于 windows/。
