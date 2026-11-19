# Output format

Output format chooses whether the next document is Markdown or plain text. The choice applies to the current session.

## Sub-features

- `format-markdown` starts on Markdown.
- `format-text` selects plain text.
- `format-session` returns to Markdown after the WebView reloads.

## How to get to it (user POV)

- On the workspace, change 文件格式, File format, or ファイル形式.
- The choices are Markdown (.md) and 纯文本 (.txt), Plain text (.txt), or プレーンテキスト (.txt).

## Driving it with drive.js

Preconditions:

- `drive.js doctor` prints `desktop: true`.
- The workspace is showing.
- Run `node .agents/skills/verify-lectavia/scripts/drive.js names output-format` and use the `output-format.format` name for the current locale.

- **Initial format.** Run `node .agents/skills/verify-lectavia/scripts/drive.js query --role combobox --expect-value md --name "文件格式" --feature output-format --log .agents/skills/verify-lectavia/artifacts/output-format/actions.log`, substituting the `output-format.format` name. If the role is not found, query `--role popUpButton` with the same name. `value: md`.
- **Choose plain text.** Run `node .agents/skills/verify-lectavia/scripts/drive.js select --name "文件格式" --value txt --feature output-format --log .agents/skills/verify-lectavia/artifacts/output-format/actions.log`, using the `output-format.format` name. Query the same combobox with `--expect-value txt`. `value: txt`.
- **Proof.** Run `node .agents/skills/verify-lectavia/scripts/drive.js snapshot --feature output-format --path .agents/skills/verify-lectavia/artifacts/output-format/format.aria.txt` and `node .agents/skills/verify-lectavia/scripts/drive.js screenshot --path .agents/skills/verify-lectavia/artifacts/output-format/format.png`. The query output is the second view of the selected value. No document file is created.
- **Session boundary.** Run `node .agents/skills/verify-lectavia/scripts/drive.js reload --feature output-format --log .agents/skills/verify-lectavia/artifacts/output-format/actions.log`, then query the combobox again with `--expect-value md`. `value: md`.

## Gotchas

- The select value is `md` or `txt`. The visible option text includes the file extension.
- Reload discards the choice. That is the session boundary, not a failure to save.
- The format control is on the workspace, not in Settings. The settings page has a different set of fields.
- Changing format does not enable 生成文稿, Generate document, or 原稿を作成.
