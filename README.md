# Lectavia

把 Bilibili、YouTube 或本地视频整理成可保存的学习资料。

## 本地开发

需要 Node.js 24 LTS、pnpm、Rust stable 和 [Tauri 2 的系统依赖](https://v2.tauri.app/start/prerequisites/)。在 Windows 上，安装 Visual Studio 的 C++ 桌面开发工具和 WebView2。

```sh
pnpm install
pnpm tauri dev
```

用 `pnpm build` 检查 TypeScript 并构建前端，用 `pnpm tauri build` 构建桌面安装包。用 `pnpm dev` 可在浏览器中预览界面，本地文件对话框在桌面应用中可用。

运行 `pnpm format` 格式化项目文件，用 `pnpm format:check` 检查格式。

## 项目结构

- `src/` 包含 React 界面和 TypeScript 业务代码。目前可以识别视频来源，后续处理任务也在这一层编排。
- `src-tauri/` 提供桌面窗口和原生文件对话框。

当前版本完成了视频来源选择。音轨提取、语音转写、资料整理和文件导出尚未接入。
