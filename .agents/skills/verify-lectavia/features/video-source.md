# Video source

Video source lets a person inspect a Bilibili or YouTube link, or switch to choosing a local file. The two modes keep one source at a time.

## Sub-features

- `source-link` shows the link field and the inspect action.
- `source-local` shows the local-file action and hides the link field.
- `source-return` switches back to the link field without keeping a local file.
- `source-pick-file` asks for a local video through the system file dialog.

## How to get to it (user POV)

- Choose 粘贴链接, Paste link, or リンクを貼り付け.
- Choose 本地文件, Local file, or ローカルファイル.
- Choose 选择视频文件, Choose a video file, or 動画ファイルを選択 to open the file dialog.

## Driving it with drive.js

Preconditions:

- `drive.js doctor` prints `desktop: true`.
- The workspace is showing. If Settings is open, choose 返回工作台, Back to workspace, or ワークスペースに戻る first.
- Run `node .agents/skills/verify-lectavia/scripts/drive.js names video-source` and use the printed names for the current locale.

- **Link tab.** Run `node .agents/skills/verify-lectavia/scripts/drive.js query --role tab --expect-selected true --name "粘贴链接" --feature video-source --log .agents/skills/verify-lectavia/artifacts/video-source/actions.log`, substituting the `video-source.link-tab` name for the current locale. `selected: true`. The link textbox shows under the `video-source.link-field` name.
- **Local tab.** Run `node .agents/skills/verify-lectavia/scripts/drive.js click --role tab --name "本地文件" --feature video-source --log .agents/skills/verify-lectavia/artifacts/video-source/actions.log` with the `video-source.local-tab` name. Then query that same tab with `--expect-selected true`. `selected: true`. A button containing the `video-source.pick-file` name is visible: `--name-contains "选择视频文件"` (the full accessible name also lists the accepted formats). The link textbox is gone.
- **Return to the link.** Click the link tab with the same `click --role tab` command used to identify it, then query it with `--expect-selected true`. `selected: true`, and the link textbox is back. No video title is shown.
- **Proof.** Run `node .agents/skills/verify-lectavia/scripts/drive.js snapshot --feature video-source --path .agents/skills/verify-lectavia/artifacts/video-source/source.aria.txt` and `node .agents/skills/verify-lectavia/scripts/drive.js screenshot --path .agents/skills/verify-lectavia/artifacts/video-source/source.png` while the local tab is selected, before returning to the link tab. The artifacts show Lectavia and the local-file button.
- **File dialog.** Do not click the pick-file button in an unattended run. That entry opens a Windows file dialog. Report `source-pick-file` as **not run**, with that command withheld and the dialog unreachable from `drive.js`.

## Gotchas

- The link field and the local-file button are alternatives. A selected local tab must not still show the link textbox.
- Inspecting a link calls yt-dlp and the network. A tab switch does not. Do not paste a URL while proving the tabs.
- The file dialog blocks the WebView. Leave it unopened unless a person is present to dismiss it.
- Tab names follow the interface language. They do not follow the output-language field.
- The pick-file button's accessible name ends with the accepted format list (`MP4、MKV、WebM、MOV、M4V、AVI`). Exact `--name` matching fails; use `--name-contains` with the `video-source.pick-file` value.
