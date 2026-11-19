# Interface language

Interface language changes the workspace labels immediately and keeps that language for the next launch of the same WebView profile.

## Sub-features

- `language-open` opens the language control from Settings.
- `language-apply` switches the workspace to the chosen language.
- `language-persist` shows the same language after the WebView reloads.
- `language-restore` puts back the language the run found.

## How to get to it (user POV)

- Choose 设置, Settings, or 設定 in the top bar.
- Change 界面语言, App language, or 表示言語.

## Driving it with drive.js

Preconditions:

- `drive.js doctor` prints `desktop: true`.
- No language backup exists yet in `.agents/skills/verify-lectavia/run/language-backup.json`.
- The target locale is `en` when `lang` is `zh-CN`, `ja` when `lang` is `en`, and `zh-CN` when `lang` is `ja`.
- Run `node .agents/skills/verify-lectavia/scripts/drive.js names interface-language` for the `shared.*` and `interface-language.video-heading` names of each locale.

- **Record the current language.** Run `node .agents/skills/verify-lectavia/scripts/drive.js lang --out .agents/skills/verify-lectavia/artifacts/interface-language/before-lang.txt`, `node .agents/skills/verify-lectavia/scripts/drive.js storage get lectavia.language --out .agents/skills/verify-lectavia/artifacts/interface-language/before-storage.txt`, and `node .agents/skills/verify-lectavia/scripts/drive.js backup-language --feature interface-language --log .agents/skills/verify-lectavia/artifacts/interface-language/actions.log`. The backup records both the locale and the exact stored value, including a missing key.
- **Open settings.** Choose the settings button for the recorded locale. For `zh-CN`, run `node .agents/skills/verify-lectavia/scripts/drive.js click --role button --name "设置" --feature interface-language --log .agents/skills/verify-lectavia/artifacts/interface-language/actions.log`. For `en`, use `--name "Settings"`. For `ja`, use `--name "設定"`. The language combobox is visible: 界面语言, App language, or 表示言語.
- **Choose the target language.** For a `zh-CN` start, run `node .agents/skills/verify-lectavia/scripts/drive.js select --name "界面语言" --value en --feature interface-language --log .agents/skills/verify-lectavia/artifacts/interface-language/actions.log`. For an `en` start, run `node .agents/skills/verify-lectavia/scripts/drive.js select --name "App language" --value ja --feature interface-language --log .agents/skills/verify-lectavia/artifacts/interface-language/actions.log`. For a `ja` start, run `node .agents/skills/verify-lectavia/scripts/drive.js select --name "表示言語" --value zh-CN --feature interface-language --log .agents/skills/verify-lectavia/artifacts/interface-language/actions.log`. Then wait with `node .agents/skills/verify-lectavia/scripts/drive.js wait --lang en --feature interface-language --log .agents/skills/verify-lectavia/artifacts/interface-language/actions.log`, replacing `en` with `ja` or `zh-CN` for the other starts. The back button reads Back to workspace, ワークスペースに戻る, or 返回工作台.
- **Return to the workspace.** Run `node .agents/skills/verify-lectavia/scripts/drive.js click --role button --name "Back to workspace" --feature interface-language --log .agents/skills/verify-lectavia/artifacts/interface-language/actions.log` after switching to English. Use ワークスペースに戻る after Japanese, or 返回工作台 after 简体中文. The video heading reads Choose a video, 動画を選択, or 选择视频.
- **Confirm persistence.** Run `node .agents/skills/verify-lectavia/scripts/drive.js reload --feature interface-language --log .agents/skills/verify-lectavia/artifacts/interface-language/actions.log`, then the same `wait --lang` command as above. Run `node .agents/skills/verify-lectavia/scripts/drive.js storage get lectavia.language --out .agents/skills/verify-lectavia/artifacts/interface-language/storage.txt --feature interface-language --log .agents/skills/verify-lectavia/artifacts/interface-language/actions.log`. The file contains the target locale.
- **Proof.** Run `node .agents/skills/verify-lectavia/scripts/drive.js wait --role heading --name "Choose a video" --text "Choose a video" --feature interface-language --log .agents/skills/verify-lectavia/artifacts/interface-language/actions.log` after an English switch. Substitute 動画を選択 or 选择视频 for both flags for the other targets. Run `node .agents/skills/verify-lectavia/scripts/drive.js snapshot --feature interface-language --path .agents/skills/verify-lectavia/artifacts/interface-language/workspace.aria.txt` and `node .agents/skills/verify-lectavia/scripts/drive.js screenshot --path .agents/skills/verify-lectavia/artifacts/interface-language/workspace.png`. Both show Lectavia and the translated video heading. The snapshot header includes `feature: interface-language`.
- **Restore.** Run `node .agents/skills/verify-lectavia/scripts/drive.js restore-language --feature interface-language --log .agents/skills/verify-lectavia/artifacts/interface-language/actions.log`. The command reloads a new document, checks the original language and raw stored value, and then releases the backup.

## Gotchas

- The settings button name changes with the language. Use the name for the locale on screen.
- Language is stored in the user's WebView profile. `backup-language` must run before the first change. Cleanup calls `restore-language` when the backup remains.
- Reloading closes Settings. Capture the workspace after reload, not the settings form. The settings form contains password fields.
- Option text such as English is not the select value. The values are `zh-CN`, `ja`, and `en`.
- An empty stored language and a stored `zh-CN` both display 简体中文. Restore the stored value, not only the visible language.
