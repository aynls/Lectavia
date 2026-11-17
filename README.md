# Lectavia

转写 Bilibili、YouTube 或本地视频中的语音，整理为可编辑的 Markdown 或纯文本文稿。

Windows x64、Linux x64 和 Apple Silicon（macOS 26 及以上）的安装包自带 yt-dlp、Python、QuickJS-NG、FFmpeg 和 FFprobe。填写模型设置后即可处理 Bilibili、YouTube 和本地视频，无需另行安装媒体工具或配置 PATH。

## 本地开发

需要 Node.js 24、pnpm、Rust stable 和 [Tauri 2 的系统依赖](https://v2.tauri.app/start/prerequisites/)。Windows 上需要 Visual Studio 的 C++ 桌面开发工具和 WebView2。

Lectavia 用 `yt-dlp` 获取在线视频音轨，用 FFmpeg 抽取或切分音频。使用系统工具开发时，YouTube 还需要 Deno 或 Node.js 22 及以上。

```powershell
pnpm install
powershell -ExecutionPolicy Bypass -File scripts/setup-media.ps1
```

安装脚本通过 WinGet 安装缺少的开发用媒体工具。也可以把工具放到 PATH，或将 `LECTAVIA_MEDIA_DIR` 指向工具目录。安装后用新的终端启动应用。已有随包媒体工具的构建产物时，开发模式也会优先使用它们。

```powershell
pnpm tauri dev
```

## 生成文稿

1. 打开「模型设置」，分别填写语音转写与文稿整理的 API Base URL 和 API Key。可以获取供应商的模型列表后选择，也可以直接填写模型 ID。文稿整理会自动显示模型目录公布的思考强度，也可以手动填写。留空时使用供应商默认设置。语音转写预设为 OpenRouter 和 `openai/whisper-large-v3-turbo`。
2. 粘贴视频链接或选择本地视频，两种来源只保留一种。链接会在粘贴或失焦后解析标题和分 P，Bilibili 多 P 视频可勾选要生成的分 P。
3. 首次生成前选择保存目录。应用会记住上次选择，目录不可用时请重新选择。选择文件格式，并可直接填写整理要求或导入一个 UTF-8 Markdown 文件。可将当前要求存为快捷规范，下次从下拉菜单选用。点击「生成文稿」后，在任务队列查看进度和文稿位置。

转写服务需支持 OpenAI 兼容的 `POST /audio/transcriptions`，整理服务需支持 `POST /chat/completions`。模型配置及 API Key 保存在系统凭据库中，界面语言也会在重启后恢复。任务队列仅在本次运行期间保留。保存目录会在任务开始前确认存在且可写，生成的文件保存在该目录。

## 命令行

在 Lectavia 桌面端保存模型设置后，用同一个系统账户运行 `lectavia-cli`。每次调用处理一个视频，桌面应用可以关闭。

Windows 安装包将 `lectavia-cli.exe` 放在 Lectavia 的安装目录中，用完整路径或在该目录中运行。
Linux 的 `.deb` 将 `lectavia-cli` 安装到 `/usr/bin`。macOS 对应的路径为 `/Applications/Lectavia.app/Contents/MacOS/lectavia-cli`。

### 使用示例

将示例中的视频 ID 换成实际 ID，并确认本地文件和指定的输出目录已经存在。

```powershell
.\lectavia-cli.exe ".\lesson.mp4" -o "D:\Notes" --instructions "按主题分节，保留关键术语。"
.\lectavia-cli.exe "https://www.bilibili.com/video/BV_ID" --parts "1,3" --format txt
.\lectavia-cli.exe "https://www.youtube.com/watch?v=YOUTUBE_ID" --instructions-file ".\instructions.md" --lang en
```

### 参数

语法为 `lectavia-cli [选项] <视频>`。

| 参数                         | 说明                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<视频>`                     | 必填。传入一个本地视频路径，或一个 Bilibili、YouTube 视频的 HTTPS 链接。支持 Bilibili 短链接。                                                                      |
| `-o, --output-dir <目录>`    | 指定已有且可写的输出目录，支持相对路径和绝对路径。默认是当前工作目录。                                                                                              |
| `--format <格式>`            | `md`（Markdown，默认）或 `txt`（纯文本）。                                                                                                                          |
| `--parts <编号>`             | 仅用于 Bilibili。用逗号分隔从 1 开始的分 P 编号，如 `"1,3"`。省略时使用链接中的 `?p=` 编号，链接未指定时处理第一 P。多 P 视频的文稿保存在以视频标题命名的子目录中。 |
| `--instructions <文本>`      | 直接指定额外的整理要求。                                                                                                                                            |
| `--instructions-file <文件>` | 从 UTF-8 文件读取额外的整理要求。与 `--instructions` 互斥。                                                                                                         |
| `--lang <语言>`              | 内置整理提示词、文件名标签、进度和运行错误使用的语言。可选 `zh-CN`（默认）、`ja` 或 `en`。                                                                          |
| `-h, --help`                 | 显示帮助。                                                                                                                                                          |
| `-V, --version`              | 显示版本。                                                                                                                                                          |

### 在脚本中使用

处理视频时，CLI 将生成成功的文稿路径逐行写到标准输出，将进度和错误写到标准错误。PowerShell 可直接捕获路径，并通过 `$LASTEXITCODE` 获取退出码。

```powershell
$documents = & .\lectavia-cli.exe ".\lesson.mp4"
$exitCode = $LASTEXITCODE
```

| 退出码 | 含义                                                              |
| ------ | ----------------------------------------------------------------- |
| `0`    | 所有请求的文稿均已生成，或已显示帮助或版本。                      |
| `1`    | 运行失败或部分分 P 失败。已生成的文稿保留，路径仍会写到标准输出。 |
| `2`    | 命令行参数有误，例如缺少视频参数或指定了无效的格式。              |

### 单独构建 CLI

在项目根目录运行以下命令。

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --release --locked --no-default-features --bin lectavia-cli
```

Windows 上的默认产物路径为 `src-tauri/target/release/lectavia-cli.exe`。单独使用时，可通过 `PATH` 或 `LECTAVIA_MEDIA_DIR` 提供 FFmpeg。处理在线视频还需要 yt-dlp，YouTube 另需 Deno 或 Node.js 22 及以上。

## 检查与构建

- `pnpm format` 格式化项目文件，`pnpm format:check` 检查格式。
- `pnpm build` 检查 TypeScript 并构建前端，`pnpm tauri build` 构建桌面应用。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked` 运行 Rust 测试。

### 平台安装包

打包时会下载并校验预编译的 FFmpeg、FFprobe、Python、yt-dlp 和 QuickJS-NG。Windows 使用系统自带的 `curl.exe` 和 `tar.exe`，Linux 需要 `curl` 和 `xz-utils`，macOS 构建需要运行 macOS 26 或更高版本的 Apple Silicon Mac，以及 Xcode 命令行工具。

```bash
# Windows x64
npm run app:build:setup
# Linux x64
pnpm tauri build --bundles deb,appimage
# Apple Silicon macOS
pnpm tauri build --bundles dmg
```

FFmpeg 构建固定在 `scripts/prepare-ffmpeg.mjs`。Windows 和 Linux 使用 [FFmpeg-Builds 的 LGPL 构建](https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/autobuild-2026-10-31-12-59)，macOS 使用 [dfloresc 的 Apple Silicon LGPL 构建](https://github.com/dfloresc/ffmpeg-macos-builds/releases/tag/v9.0.1-1)。安装包内的 `media-tools/ffmpeg/dist` 提供许可文本以及对应的源代码和构建信息链接。更新在线媒体工具时，在 `scripts/prepare-online-media.ps1` 和 `scripts/prepare-online-media.sh` 中更新相关版本和校验值。

### GitHub 发布

在 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 更新版本号，并同步更新 `src-tauri/Cargo.lock`。提交后，为该提交创建并推送对应标签，例如 `git tag v0.1.0`、`git push origin v0.1.0`。

GitHub Actions 等三端构建都成功后，将 Windows `*_x64-setup.exe`、Linux `*_amd64.AppImage` 与 `*_amd64.deb`、macOS `*_aarch64.dmg` 放入同一份 Release 草稿。确认草稿内容后在 GitHub 手动发布。

要让下载的 macOS 应用通过 Gatekeeper，请在 GitHub Actions 的仓库 Secrets 中配置 `APPLE_CERTIFICATE`（Base64 编码的 Developer ID Application `.p12`）、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_ID`、`APPLE_PASSWORD`（应用专用密码）和 `APPLE_TEAM_ID`。默认构建使用临时签名，首次打开时可能需要在「隐私与安全性」中手动放行。
