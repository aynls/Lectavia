# Task queue

The task queue shows document jobs started during this launch. Before a job exists, the queue is empty and Generate stays unavailable until a video, a part, a usable output folder, and model settings are all present.

## Sub-features

- `queue-empty` shows an empty queue on a fresh window.
- `queue-blocked` keeps Generate unavailable and names the missing step.
- `queue-generate` adds a job and writes a document for a selected video.

## How to get to it (user POV)

- Look at 任务队列, Task queue, or タスクキュー on the workspace.
- Choose 生成文稿, Generate document, or 原稿を作成.

## Driving it with drive.js

Preconditions:

- `drive.js doctor` prints `desktop: true`.
- The window was started by this run, so the in-memory queue has no jobs.
- The workspace is showing.
- Run `node .agents/skills/verify-lectavia/scripts/drive.js names task-queue` and use the printed names for the current locale.

- **Empty queue.** Run `node .agents/skills/verify-lectavia/scripts/drive.js wait --role heading --name "还没有任务" --text "还没有任务" --feature task-queue --log .agents/skills/verify-lectavia/artifacts/task-queue/actions.log`, using the `task-queue.empty` value for both flags. The heading with that text is visible. There is no button named by `task-queue.clear`.
- **Generate stays unavailable.** Run `node .agents/skills/verify-lectavia/scripts/drive.js query --role button --expect-disabled true --name "生成文稿" --feature task-queue --log .agents/skills/verify-lectavia/artifacts/task-queue/actions.log` with the `task-queue.generate` name. `disabled: true`. Then run `node .agents/skills/verify-lectavia/scripts/drive.js wait --role status --text "选择视频" --out .agents/skills/verify-lectavia/artifacts/task-queue/blocked.txt --feature task-queue --log .agents/skills/verify-lectavia/artifacts/task-queue/actions.log` with the `task-queue.missing-video` value as the text. The readiness status contains that step, and no task card appears.
- **Proof.** Run `node .agents/skills/verify-lectavia/scripts/drive.js snapshot --feature task-queue --path .agents/skills/verify-lectavia/artifacts/task-queue/empty.aria.txt` and `node .agents/skills/verify-lectavia/scripts/drive.js screenshot --path .agents/skills/verify-lectavia/artifacts/task-queue/empty.png`. Both show Lectavia, the empty queue, and the unavailable generate button.
- **Generate a document.** In this unattended recipe, report `queue-generate` as **not run**. The video and output directory require native dialogs. Leave the remembered output folder alone. A separately requested attended generation check requires a supplied video, a directory created for the run, configured models and permission to use those services. Its evidence is the terminal job state and the document in the selected directory. Record **failed** if an exercised step diverges from its expected result.

## Gotchas

- Jobs disappear when the window closes. An empty queue after relaunch does not prove that a previous job was removed by the user.
- A disabled Generate button does not submit a job. Do not treat the button's presence as a completed document.
- The readiness status joins every missing step, so its text varies with state. `wait --role status --text` matches a substring of it; assert the video step, not the whole sentence.
- The readiness line can mention the model or the output folder before a video is chosen. The empty queue is still the proof that nothing was submitted.
- Clearing or cancelling a job is a separate action and appears only after a job exists. Do not invent a job to reach it.
- Transcription and document organization call the configured services. A blocked queue does not.
