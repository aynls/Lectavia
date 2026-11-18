use std::{fs, io, path::Path};

use serde::Serialize;
use tauri::{App, Emitter, Manager, State, async_runtime};

use super::{GenerationRequest, JobSnapshot, Tasks};
use crate::{error::AppError, media::MediaTools, video::VideoPreview};

const CONCURRENCY_MAX: u64 = 9_007_199_254_740_991;

pub(crate) fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let path = app.path().app_config_dir()?.join("task-concurrency.json");
    let limit = fs::read_to_string(&path)
        .ok()
        .and_then(|value| serde_json::from_str::<Option<u64>>(&value).ok())
        .flatten()
        .filter(|&limit| (1..=CONCURRENCY_MAX).contains(&limit));
    let tasks = Tasks::new(
        MediaTools::desktop(app.handle()),
        app.config().identifier.clone(),
        limit,
        path,
    )?;
    let mut updated = tasks.0.changed.subscribe();
    app.manage(tasks);
    let handle = app.handle().clone();
    async_runtime::spawn(async move {
        while updated.changed().await.is_ok() {
            let _ = handle.emit("tasks-changed", ());
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn get_max_concurrency(tasks: State<'_, Tasks>) -> Option<u64> {
    tasks.0.queue.lock().unwrap().limit
}

fn save_concurrency(path: &Path, limit: Option<u64>) -> io::Result<()> {
    let parent = path.parent().expect("concurrency settings directory");
    fs::create_dir_all(parent)?;
    let file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(file.as_file(), &limit)?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn set_max_concurrency(
    tasks: State<'_, Tasks>,
    limit: Option<u64>,
) -> Result<(), AppError> {
    tasks.set_concurrency(limit)
}

impl Tasks {
    pub(super) fn set_concurrency(&self, limit: Option<u64>) -> Result<(), AppError> {
        if limit.is_some_and(|limit| !(1..=CONCURRENCY_MAX).contains(&limit)) {
            return Err("settings.invalidConcurrency".into());
        }
        let mut queue = self.0.queue.lock().unwrap();
        save_concurrency(&self.0.concurrency_path, limit)
            .map_err(|error| AppError::detail("settings.saveConcurrencyFailed", error))?;
        queue.limit = limit;
        self.drain(&mut queue);
        self.changed();
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn inspect_task_video(
    tasks: State<'_, Tasks>,
    video: String,
) -> Result<VideoPreview, AppError> {
    tasks.inspect_video(video).await
}

#[tauri::command]
pub(crate) async fn submit_task(
    tasks: State<'_, Tasks>,
    request: GenerationRequest,
    prompt_name: Option<String>,
) -> Result<String, AppError> {
    tasks.submit(request, prompt_name)
}

#[tauri::command]
pub(crate) fn list_tasks(tasks: State<'_, Tasks>) -> Vec<JobSnapshot> {
    tasks
        .0
        .queue
        .lock()
        .unwrap()
        .jobs
        .iter()
        .map(super::Job::snapshot)
        .collect()
}

#[derive(Serialize)]
pub(crate) struct TaskDraft {
    request: GenerationRequest,
    prompt_name: Option<String>,
    video: Option<VideoPreview>,
}

#[tauri::command]
pub(crate) async fn get_task_draft(
    tasks: State<'_, Tasks>,
    job_id: String,
) -> Result<TaskDraft, AppError> {
    let queue = tasks.0.queue.lock().unwrap();
    let job = queue.job(&job_id)?;
    Ok(TaskDraft {
        request: job.request.as_ref().clone(),
        prompt_name: job.prompt_name.clone(),
        video: job.video.clone(),
    })
}

#[tauri::command]
pub(crate) async fn cancel_task(
    tasks: State<'_, Tasks>,
    job_id: String,
    part_ids: Option<Vec<String>>,
) -> Result<(), AppError> {
    tasks.cancel(&job_id, part_ids.as_deref()).map(|_| ())
}

#[tauri::command]
pub(crate) async fn remove_tasks(
    tasks: State<'_, Tasks>,
    job_id: Option<String>,
) -> Result<(), AppError> {
    tasks.remove(job_id.as_deref());
    Ok(())
}

#[tauri::command]
pub(crate) async fn retry_task(
    tasks: State<'_, Tasks>,
    job_id: String,
    part_id: Option<String>,
    output_directory: Option<String>,
) -> Result<bool, AppError> {
    tasks.retry(&job_id, part_id, output_directory)
}
