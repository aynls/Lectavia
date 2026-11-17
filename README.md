# Lectavia

转写 Bilibili、YouTube 或本地视频中的语音，整理为可编辑的 Markdown 或纯文本文稿。

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

## 生成文稿

1. 打开「模型设置」，分别填写语音转写与文稿整理的 API Base URL 和 API Key。可以获取供应商的模型列表后选择，也可以直接填写模型 ID。文稿整理会自动显示模型目录公布的思考强度，也可以手动填写。留空时使用供应商默认设置。语音转写预设为 OpenRouter 和 `openai/whisper-large-v3-turbo`。
2. 粘贴视频链接或选择本地视频，两种来源只保留一种。链接会在粘贴或失焦后解析标题和分 P，Bilibili 多 P 视频可勾选要生成的分 P。
3. 默认保存到系统文档目录下的 `Lectavia`，也可以更改目录，应用会记住上次选择。选择文件格式，并可直接填写整理要求或追加一个 UTF-8 Markdown 文件。点击「生成文稿」后，在任务队列查看进度和文稿位置。

转写服务需支持 OpenAI 兼容的 `POST /audio/transcriptions`，整理服务需支持 `POST /chat/completions`。配置与队列仅在本次运行期间保存在内存中。保存目录会在任务开始前确认存在且可写，生成的文件保存在该目录。

## 检查与构建

- `pnpm format` 格式化项目文件，`pnpm format:check` 检查格式。
- `pnpm build` 检查 TypeScript 并构建前端，`pnpm tauri build` 构建桌面应用。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked` 运行 Rust 测试。
