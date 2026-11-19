---
name: verify-lectavia
description: Verify a user-facing feature in the Windows development build of Lectavia using its WebView2 window, or maintain the corresponding verification recipes.
---

# Verify Lectavia

Start with the [feature map](features/README.md) and select the requested behavior. This workflow drives the Windows desktop UI. The dev build shares the app's settings directory and Windows Credential Manager entry. Back up each persistent setting before changing it.

## Start the window

Run from the repository root in PowerShell.

```powershell
$skill = ".agents/skills/verify-lectavia"
$drive = "$skill/scripts/drive.js"
powershell -NoProfile -ExecutionPolicy Bypass -File "$skill/scripts/launch.ps1"
node $drive doctor
```

Launch requires Lectavia to be closed, ports 1420 and 9222 to be free, and the previous run to be cleaned up. It starts `pnpm tauri dev` with a process-local WebView2 debugging port. The first build can take several minutes. The launcher binds the desktop target and the Windows process that owns the debugging port, identified by a per-launch marker or its live ancestry. Each drive command checks the launch and browser process IDs and creation times, the target ID, the fixed workspace URL and the Tauri window. During startup only exit code 2 means to wait for readiness. An identity mismatch stops the run.

## Drive and observe

Accessible names live in `features/names.json`. Run `node $drive names <feature-id>` to print them for the window's current locale (`shared.*` entries cover the settings button, the back button and the language combobox). Keep `names.json` in sync with `src/locales/` whenever interface text changes. The values of the language and format selects are `zh-CN`, `ja`, `en`, `md` and `txt`.

`click` sends mouse input and checks that the intended control received it. Follow the action with the recipe's observable result. `query` can assert `--expect-selected`, `--expect-disabled`, or `--expect-value`. `reload` waits for a new main document and the initialized workspace. Use `--within` to scope a control to its named ancestor. When an accessible name may carry extra detail (format lists, counts), match with `--name-contains` instead of `--name`. To capture feedback, use `wait --role status` (or `alert`) with `--within`, `--text` and `--out`; scoped `--text` matches a substring of the node's text.

Keep the feature ID, action log and resulting evidence together in `artifacts/<feature-id>/`. For the workspace, capture the accessibility snapshot and screenshot at the step being verified. Screenshots can show the remembered output folder and model IDs. Whole-page captures are blocked in Settings, which contains model credentials. Use the audio recipe's scoped feedback and file readback there. Leave model settings and password fields alone.

The file and folder pickers are native dialogs. Leave them closed in unattended runs. Report each sub-feature as **passed**, **failed**, or **not run**, with the observation or missing prerequisite. Transcription and document organization require permission to use the configured services for that run. An empty queue and a disabled Generate button can be verified independently of generating a document.

## Restore and close

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$skill/scripts/cleanup.ps1"
```

Cleanup reads back the original language and stored key after reload, and checks the original bytes or absence of the audio setting. It removes each backup after that setting's check succeeds. A restore error returns a nonzero exit code and preserves the outstanding backup, instance record and any running verification window. Correct the reported cause and retry cleanup. Successful cleanup stops the recorded processes, removes the run directory and keeps the evidence.

If the recorded window exited before restoring its language, move `run/language-backup.json` to a new recovery folder outside `run/`. Clean up the old instance, launch a fresh verification window in the same dev profile, then copy the saved backup to the new `run/language-backup.json` and run cleanup again. Keep the recovery copy until that cleanup succeeds.
