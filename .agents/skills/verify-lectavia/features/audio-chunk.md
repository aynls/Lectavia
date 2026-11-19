# Audio chunk length

The setting controls the target length of the audio segments used for transcription. The field accepts integer seconds starting at 60.

## Sub-features

- `chunk-reject` rejects a short duration and preserves the original setting.
- `chunk-save` persists a different valid duration.
- `chunk-restore` restores the exact bytes or absence of the original file.

## How to get to it (user POV)

Open Settings, edit the transcription audio chunk length and choose the Save button in that row.

## Driving it with drive.js

Preconditions: start in the workspace with `doctor` reporting ready. Run these commands in PowerShell from the repository root. Set the three labels and both messages from `node $drive names audio-chunk` for the active language (`shared.settings`, `audio-chunk.field`, `audio-chunk.save`, `audio-chunk.invalid`, `audio-chunk.saved`).

- **Back up and open.** Stop on any nonzero command exit. The backup records whether the file existed and, if present, all its bytes. Record the loaded textbox value as `$previous`. Use `$next = '90'` or `'91'` if the previous value was already 90.

```powershell
$skill = ".agents/skills/verify-lectavia"
$drive = "$skill/scripts/drive.js"
$proof = "$skill/artifacts/audio-chunk"
$trace = @("--feature", "audio-chunk", "--log", "$proof/actions.log")
$file = Join-Path $env:APPDATA "io.github.aynls.lectavia\audio-chunk-seconds"
node $drive backup-audio @trace
node $drive click --role button --name $settings @trace
node $drive query --role textbox --name $field --expect-disabled false @trace
```

- **Reject a short value.** Capture the alert in the named chunk form, then compare the file with its backup.

```powershell
node $drive fill --name $field --value 30 @trace
node $drive click --role button --name $save --within $field @trace
node $drive wait --role alert --within $field --text $invalid --out "$proof/rejected.txt" @trace
node $drive check-audio @trace
```

- **Save a valid value.** Capture the status from that same form and independently read the saved file.

```powershell
node $drive fill --name $field --value $next @trace
node $drive click --role button --name $save --within $field @trace
node $drive wait --role status --within $field --text $saved --out "$proof/saved.txt" @trace
if ([IO.File]::ReadAllText($file) -cne $next) { throw "Saved duration differs from the selected value" }
Copy-Item -LiteralPath $file -Destination "$proof/audio-chunk-seconds.txt"
```

- **Restore.** Verify the original file state and read the value from the reopened form.

```powershell
node $drive restore-audio @trace
node $drive reload @trace
node $drive click --role button --name $settings @trace
node $drive query --role textbox --name $field --expect-value $previous @trace
```

## Gotchas

Several forms have a Save button. Scope both the click and the feedback to the chunk form. A missing file displays 1200. Preserve that absence on restore. Cleanup retries any outstanding backup.
