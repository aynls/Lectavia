# Lectavia verification map

This directory is the maintained source for verifying Lectavia's desktop behavior. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `.agents/skills/verify-lectavia/scripts/launch.ps1` from the repository root.
- Require `drive.js doctor` to report the recorded pid, `http://127.0.0.1:1420/`, `desktop: true`, and the shared profile, config, and credential store.
- Do not start a run while `lectavia.exe` is open. Do not drive a window this run did not start.
- The WebView profile, `%APPDATA%\io.github.aynls.lectavia`, and the model credential are the user's real Lectavia state. Back up a value before changing it, and restore it before cleanup.
- Do not save model settings or read password fields.

## Driving conventions

- Start every recipe from the doctor result unless its preconditions say otherwise.
- Run `node .agents/skills/verify-lectavia/scripts/drive.js names <feature-id>` to print the accessible names for the window's current locale. `names.json` is the single source for those names; update it when `src/locales/` changes.
- Substitute the accessible names and expected text for the current locale.
- Run WebView actions through `node .agents/skills/verify-lectavia/scripts/drive.js`. Use `--name` for exact accessible names and `--name-contains` when a name may carry variable detail.
- Leave proof files in `.agents/skills/verify-lectavia/artifacts/<feature-id>/`. Cleanup removes `run/` only.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- Capture the workspace with an accessibility snapshot and screenshot. In Settings collect feedback from the relevant form and independently read back the saved value.
- Persistence proof includes a second view: `localStorage`, the settings file, or the control value after reload.
- Record the feature id on the snapshot and in `actions.log`.
- Report **passed** when the expected result was observed, **failed** when the exercised behavior diverged from its expected result, and **not run** when an entry point or prerequisite was unavailable. Record the specific reason and report each sub-feature independently.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with drive.js` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Interface language](./interface-language.md) covers the settings language control, the translated workspace, and restoring the previous language.
- [Video source](./video-source.md) covers the link and local-file tabs. Choosing a file opens a native dialog the harness cannot complete.
- [Output format](./output-format.md) covers the Markdown and plain-text choice for the next document. The choice lasts for the session.
- [Audio chunk length](./audio-chunk.md) covers the shared transcription chunk setting, including rejection of a value below 60 seconds and restoration of the previous file.
- [Task queue](./task-queue.md) covers the empty queue and the disabled generate action. Completing a document needs a local video, model settings, and a directory created for the run.
