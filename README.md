# Lectavia

把 Bilibili、YouTube 或本地视频整理为 Markdown 或纯文本学习资料。

## 本地开发

需要 Node.js 24、pnpm、Rust stable 和 [Tauri 2 的系统依赖](https://v2.tauri.app/start/prerequisites/)。Windows 上需要 Visual Studio 的 C++ 桌面开发工具和 WebView2。

Lectavia 用 `yt-dlp` 获取在线视频音轨，用 FFmpeg 抽取或切分音频。YouTube 还需要 Deno 或 Node.js 22 及以上。

```powershell
pnpm install
powershell -ExecutionPolicy Bypass -File scripts/setup-media.ps1
```

安装脚本通过 WinGet 安装缺少的媒体工具。也可以把工具放到 PATH，或将 `LECTAVIA_MEDIA_DIR` 指向工具目录。安装后用新的终端启动应用。

```powershell
pnpm tauri dev
```

## 生成学习资料

1. 打开「模型设置」，分别填写语音转写与资料整理的 API Base URL 和 API Key。可以获取供应商的模型列表后选择，也可以直接填写模型 ID。资料整理会自动显示模型目录公布的思考强度，也可以手动填写。留空时使用供应商默认设置。语音转写预设为 OpenRouter 和 `openai/whisper-large-v3-turbo`。
2. 粘贴视频链接或选择本地视频。Bilibili 多 P 视频可勾选要生成的分 P。
3. 选择输出目录和文件格式，可选一个 UTF-8 Markdown 文件补充整理要求。点击「生成学习资料」后，在任务队列查看进度和成品位置。

转写服务需支持 OpenAI 兼容的 `POST /audio/transcriptions`，整理服务需支持 `POST /chat/completions`。配置与队列仅在本次运行期间保存在内存中。生成的文件保存在用户选择的目录。

## 检查与构建

- `pnpm format` 格式化项目文件，`pnpm format:check` 检查格式。
- `pnpm build` 检查 TypeScript 并构建前端，`pnpm tauri build` 构建桌面应用。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked` 运行 Rust 测试。
