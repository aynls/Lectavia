pub(crate) mod desktop;
mod generation;

use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use tokio::sync::watch;
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

use self::generation::{OutputTarget, PartInput};
use crate::{
    error::AppError,
    locale::Locale,
    media::{MediaTools, PreparedAudio},
    output::{OutputFormat, PendingOutput},
    video::{VideoPreview, inspect, parse_source},
};

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "mcp", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "mcp", schemars(inline))]
#[serde(rename_all = "snake_case")]
pub(crate) enum Mode {
    #[default]
    Document,
    Transcript,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "mcp", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub(crate) struct GenerationRequest {
    /// Unique ID for the submission. Reuse the same value when resending it.
    pub request_id: String,
    /// Local video path or HTTPS Bilibili / YouTube video URL.
    pub video: Option<String>,
    /// One-based Bilibili part numbers. Defaults to the URL's p parameter or first part.
    pub parts: Option<Vec<u32>>,
    /// Existing local UTF-8 transcript files. Use in document mode instead of video.
    pub transcript_paths: Option<Vec<PathBuf>>,
    /// Existing directory where the generated files should be saved.
    pub output_directory: String,
    /// document organizes the transcript; transcript saves the speech recognition output.
    #[serde(default)]
    pub mode: Mode,
    /// md or txt. Defaults to md for document mode and txt for transcript mode.
    pub format: Option<OutputFormat>,
    /// Language for file labels and built-in prompts. Defaults to zh-CN.
    pub locale: Option<Locale>,
    /// Target language for the organized document. Defaults to locale.
    pub output_language: Option<String>,
    /// Optional. Adds the user's extra requirements, such as section structure or tone, to
    /// Lectavia's built-in editing prompt. Omit for standard generation and in transcript mode.
    pub instructions: Option<String>,
}

impl GenerationRequest {
    fn validate(&self) -> Result<(), AppError> {
        if self.request_id.trim().is_empty() {
            return Err("mcp.requestId".into());
        }
        match (&self.video, &self.transcript_paths, &self.parts, self.mode) {
            (Some(video), None, _, _) if !video.trim().is_empty() => {}
            (None, Some(paths), None, Mode::Document) if !paths.is_empty() => {}
            _ => return Err("mcp.documentSource".into()),
        }
        if self.output_directory.trim().is_empty() {
            return Err("error.folderInvalid".into());
        }
        if self.mode == Mode::Transcript
            && (self.instructions.is_some() || self.output_language.is_some())
        {
            return Err("mcp.transcriptOptions".into());
        }
        Ok(())
    }

    fn locale(&self) -> Locale {
        self.locale.unwrap_or(Locale::ZhCn)
    }

    fn format(&self) -> OutputFormat {
        self.format.unwrap_or(match self.mode {
            Mode::Document => OutputFormat::Md,
            Mode::Transcript => OutputFormat::Txt,
        })
    }
}

#[derive(Clone, Copy, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    #[default]
    Queued,
    Running,
    Completed,
    Partial,
    Failed,
    Cancelled,
}

impl Status {
    fn unfinished(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Inspect,
    Audio,
    Transcription,
    Organization,
    Output,
}

#[derive(Default)]
struct Progress {
    status: Status,
    phase: Option<Phase>,
    error: Option<AppError>,
    cancellation: CancellationToken,
}

impl Progress {
    fn cancel(&mut self) {
        if self.status.unfinished() {
            self.cancellation.cancel();
            self.status = Status::Cancelled;
            self.phase = None;
        }
    }

    fn fail(&mut self, error: AppError) {
        self.status = Status::Failed;
        self.error = Some(error);
    }
}

struct Part {
    id: String,
    input: Arc<PartInput>,
    progress: Progress,
    audio: Option<Arc<PreparedAudio>>,
    transcript: Option<Arc<str>>,
    material: Option<Arc<str>>,
    output_path: Option<String>,
    output_directory: Option<String>,
}

impl Part {
    fn new(input: PartInput) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            input: Arc::new(input),
            progress: Progress::default(),
            audio: None,
            transcript: None,
            material: None,
            output_path: None,
            output_directory: None,
        }
    }

    fn release_checkpoints(&mut self) {
        self.audio = None;
        self.transcript = None;
        self.material = None;
    }
}

struct Job {
    id: String,
    request: Arc<GenerationRequest>,
    prompt_name: Option<String>,
    title: String,
    video: Option<VideoPreview>,
    preparation: Progress,
    parts: Vec<Part>,
    target: Arc<OutputTarget>,
}

impl Job {
    fn status(&self) -> Status {
        if self.parts.is_empty() {
            return self.preparation.status;
        }
        let has = |status| self.parts.iter().any(|part| part.progress.status == status);
        if has(Status::Running) {
            Status::Running
        } else if has(Status::Queued) {
            Status::Queued
        } else if self
            .parts
            .iter()
            .all(|p| p.progress.status == Status::Completed)
        {
            Status::Completed
        } else if has(Status::Completed) {
            Status::Partial
        } else if has(Status::Failed) {
            Status::Failed
        } else {
            Status::Cancelled
        }
    }

    fn select(&self, ids: Option<&[String]>) -> Result<Vec<usize>, AppError> {
        if let Some(ids) = ids
            && (ids.is_empty()
                || ids
                    .iter()
                    .any(|id| !self.parts.iter().any(|part| &part.id == id)))
        {
            return Err("mcp.partIds".into());
        }
        Ok(self
            .parts
            .iter()
            .enumerate()
            .filter(|(_, part)| ids.is_none_or(|ids| ids.contains(&part.id)))
            .map(|(index, _)| index)
            .collect())
    }

    fn cancel(&mut self, ids: Option<&[String]>) -> Result<(), AppError> {
        let selected = self.select(ids)?;
        if ids.is_none() {
            self.preparation.cancel();
        }
        for index in selected {
            let part = &mut self.parts[index];
            part.progress.cancel();
            if part.progress.status == Status::Cancelled {
                part.release_checkpoints();
            }
        }
        Ok(())
    }

    fn snapshot(&self) -> JobSnapshot {
        JobSnapshot {
            job_id: self.id.clone(),
            title: self.title.clone(),
            mode: self.request.mode,
            status: self.status(),
            phase: self.preparation.phase,
            error: self.preparation.error.clone(),
            can_restore: self.request.mode == Mode::Document && self.request.video.is_some(),
            parts: self
                .parts
                .iter()
                .map(|part| PartSnapshot {
                    part_id: part.id.clone(),
                    number: part.input.number,
                    title: part.input.title.clone(),
                    status: part.progress.status,
                    phase: part.progress.phase,
                    error: part.progress.error.clone(),
                    output_path: part.output_path.clone(),
                    output_directory: part.output_directory.clone(),
                })
                .collect(),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct JobSnapshot {
    job_id: String,
    title: String,
    mode: Mode,
    status: Status,
    phase: Option<Phase>,
    error: Option<AppError>,
    can_restore: bool,
    parts: Vec<PartSnapshot>,
}

#[derive(Serialize)]
struct PartSnapshot {
    part_id: String,
    number: Option<u32>,
    title: Option<String>,
    status: Status,
    phase: Option<Phase>,
    error: Option<AppError>,
    output_path: Option<String>,
    output_directory: Option<String>,
}

enum Pending {
    Preparing(String),
    Part(String, usize),
}

impl Pending {
    fn job_id(&self) -> &str {
        match self {
            Self::Preparing(id) | Self::Part(id, _) => id,
        }
    }
}

#[derive(Default)]
struct Queue {
    jobs: Vec<Job>,
    requests: HashMap<String, (Arc<GenerationRequest>, String)>,
    pending: VecDeque<Pending>,
    active: usize,
    limit: Option<u64>,
    stopped: bool,
}

impl Queue {
    fn job(&self, id: &str) -> Result<&Job, AppError> {
        self.jobs
            .iter()
            .find(|job| job.id == id)
            .ok_or_else(|| "mcp.jobMissing".into())
    }

    fn job_mut(&mut self, id: &str) -> Result<&mut Job, AppError> {
        self.jobs
            .iter_mut()
            .find(|job| job.id == id)
            .ok_or_else(|| "mcp.jobMissing".into())
    }
}

struct Inner {
    tools: MediaTools,
    identifier: String,
    cache: TempDir,
    queue: Mutex<Queue>,
    workers: TaskTracker,
    changed: watch::Sender<()>,
    concurrency_path: PathBuf,
}

#[derive(Clone)]
pub(crate) struct Tasks(Arc<Inner>);

impl Tasks {
    fn new(
        tools: MediaTools,
        identifier: String,
        limit: Option<u64>,
        concurrency_path: PathBuf,
    ) -> std::io::Result<Self> {
        Ok(Self(Arc::new(Inner {
            tools,
            identifier,
            cache: tempfile::tempdir()?,
            queue: Mutex::new(Queue {
                limit,
                ..Queue::default()
            }),
            workers: TaskTracker::new(),
            changed: watch::Sender::new(()),
            concurrency_path,
        })))
    }

    fn changed(&self) {
        self.0.changed.send_replace(());
    }

    pub(crate) async fn inspect_video(&self, video: String) -> Result<VideoPreview, AppError> {
        let result = inspect(&self.0.tools, parse_source(video.into())?).await?;
        Ok(VideoPreview::from(&result))
    }

    pub(crate) fn submit(
        &self,
        request: GenerationRequest,
        prompt_name: Option<String>,
    ) -> Result<String, AppError> {
        request.validate()?;
        let mut queue = self.0.queue.lock().unwrap();
        if let Some((previous, id)) = queue.requests.get(&request.request_id) {
            return if previous.as_ref() == &request {
                Ok(id.clone())
            } else {
                Err("mcp.requestConflict".into())
            };
        }
        if queue.stopped {
            return Err("error.taskCancelled".into());
        }
        let id = Uuid::new_v4().to_string();
        let title = request.initial_title();
        let request = Arc::new(request);
        queue
            .requests
            .insert(request.request_id.clone(), (request.clone(), id.clone()));
        queue.jobs.push(Job {
            id: id.clone(),
            title,
            request,
            prompt_name,
            video: None,
            preparation: Progress::default(),
            parts: Vec::new(),
            target: Arc::default(),
        });
        queue.pending.push_back(Pending::Preparing(id.clone()));
        self.drain(&mut queue);
        self.changed();
        Ok(id)
    }

    #[cfg(feature = "mcp")]
    pub(crate) fn get(&self, id: &str) -> Result<JobSnapshot, AppError> {
        Ok(self.0.queue.lock().unwrap().job(id)?.snapshot())
    }

    pub(crate) fn cancel(&self, id: &str, ids: Option<&[String]>) -> Result<JobSnapshot, AppError> {
        let mut queue = self.0.queue.lock().unwrap();
        let job = queue.job_mut(id)?;
        job.cancel(ids)?;
        let snapshot = job.snapshot();
        self.drain(&mut queue);
        self.changed();
        Ok(snapshot)
    }

    fn remove(&self, id: Option<&str>) {
        let mut queue = self.0.queue.lock().unwrap();
        queue.jobs.retain_mut(|job| {
            let remove = id.is_none_or(|id| job.id == id);
            if remove {
                let _ = job.cancel(None);
            }
            !remove
        });
        queue
            .pending
            .retain(|work| id.is_some_and(|id| id != work.job_id()));
        self.drain(&mut queue);
        self.changed();
    }

    fn retry(
        &self,
        id: &str,
        part: Option<String>,
        directory: Option<String>,
    ) -> Result<bool, AppError> {
        let mut queue = self.0.queue.lock().unwrap();
        if queue.stopped {
            return Err("error.taskCancelled".into());
        }
        let job = queue.job_mut(id)?;
        if part.is_none() && job.status().unfinished() {
            return Ok(false);
        }
        let failed: Vec<_> = job
            .select(part.as_ref().map(std::slice::from_ref))?
            .into_iter()
            .filter(|&index| job.parts[index].progress.status == Status::Failed)
            .collect();
        let failed_preparation = job.preparation.status == Status::Failed;
        if failed.is_empty() && !failed_preparation {
            return Ok(false);
        }
        if let Some(directory) = directory {
            if directory.trim().is_empty() {
                return Err("error.folderInvalid".into());
            }
            Arc::make_mut(&mut job.request).output_directory = directory;
            job.target = Arc::default();
        }
        if failed_preparation {
            job.preparation = Progress::default();
            queue.pending.push_back(Pending::Preparing(id.to_owned()));
        } else {
            for &index in &failed {
                job.parts[index].progress = Progress::default();
            }
            queue.pending.extend(
                failed
                    .into_iter()
                    .map(|index| Pending::Part(id.to_owned(), index)),
            );
        }
        self.drain(&mut queue);
        self.changed();
        Ok(true)
    }

    fn start_preparation(&self, queue: &mut Queue, id: &str) {
        let job = queue.job_mut(id).expect("submitted job");
        job.preparation.status = Status::Running;
        job.preparation.phase = Some(Phase::Output);
        let request = job.request.clone();
        let cancellation = job.preparation.cancellation.clone();
        queue.active += 1;
        let tasks = self.clone();
        let id = id.to_owned();
        self.0.workers.spawn(async move {
            let result = tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err("error.taskCancelled".into()),
                result = tasks.prepare(&id, &request) => result,
            };
            let mut queue = tasks.0.queue.lock().unwrap();
            if let Ok(job) = queue.job_mut(&id)
                && job.preparation.status == Status::Running
            {
                match result {
                    Ok(prepared) => {
                        job.title = prepared.title;
                        job.video = prepared.video;
                        job.parts = prepared.parts.into_iter().map(Part::new).collect();
                        job.preparation.status = Status::Completed;
                        job.preparation.phase = None;
                    }
                    Err(error) => job.preparation.fail(error),
                }
            }
            queue.active -= 1;
            tasks.drain(&mut queue);
            tasks.changed();
        });
    }

    fn drain(&self, queue: &mut Queue) {
        while !queue.stopped
            && queue
                .limit
                .is_none_or(|limit| (queue.active as u64) < limit)
        {
            let Some(work) = queue.pending.pop_front() else {
                break;
            };
            match work {
                Pending::Preparing(id) => {
                    let Ok(job) = queue.job(&id) else { continue };
                    if job.preparation.status == Status::Queued {
                        self.start_preparation(queue, &id);
                        queue.pending.push_front(Pending::Preparing(id));
                        break;
                    }
                    if job.preparation.status.unfinished() {
                        queue.pending.push_front(Pending::Preparing(id));
                        break;
                    }
                    let part_count = job.parts.len();
                    for index in (0..part_count).rev() {
                        queue.pending.push_front(Pending::Part(id.clone(), index));
                    }
                }
                Pending::Part(id, index) => {
                    let Ok(job) = queue.job_mut(&id) else {
                        continue;
                    };
                    let part = &mut job.parts[index];
                    if part.progress.status != Status::Queued {
                        continue;
                    }
                    part.progress.status = Status::Running;
                    let cancellation = part.progress.cancellation.clone();
                    let request = job.request.clone();
                    let target = job.target.clone();
                    let input = part.input.clone();
                    queue.active += 1;
                    let tasks = self.clone();
                    self.0.workers.spawn(async move {
                        let result = tokio::select! {
                            biased;
                            _ = cancellation.cancelled() => Err("error.taskCancelled".into()),
                            result = tasks.run_part(&id, index, request, target, input) => result,
                        };
                        let mut queue = tasks.0.queue.lock().unwrap();
                        if let Err(error) = result
                            && let Ok(job) = queue.job_mut(&id)
                            && job.parts[index].progress.status == Status::Running
                        {
                            job.parts[index].progress.fail(error);
                        }
                        queue.active -= 1;
                        tasks.drain(&mut queue);
                        tasks.changed();
                    });
                }
            }
        }
    }

    fn part<T>(
        &self,
        id: &str,
        index: usize,
        update: impl FnOnce(&mut Part) -> T,
    ) -> Result<T, AppError> {
        let mut queue = self.0.queue.lock().unwrap();
        let part = &mut queue.job_mut(id)?.parts[index];
        if part.progress.status != Status::Running {
            return Err("error.taskCancelled".into());
        }
        let value = update(part);
        self.changed();
        Ok(value)
    }

    fn publish(
        &self,
        id: &str,
        index: usize,
        pending: PendingOutput,
        directory: Option<String>,
    ) -> Result<(), AppError> {
        // File publication and cancellation observe the same task state under this lock.
        self.part(id, index, |part| {
            part.output_path = Some(pending.publish()?);
            part.output_directory = directory;
            part.release_checkpoints();
            part.progress.status = Status::Completed;
            part.progress.phase = None;
            Ok(())
        })?
    }

    pub(crate) async fn shutdown(&self) {
        {
            let mut queue = self.0.queue.lock().unwrap();
            queue.stopped = true;
            queue.pending.clear();
            for job in &mut queue.jobs {
                let _ = job.cancel(None);
            }
            self.0.workers.close();
        }
        self.0.workers.wait().await;
    }
}
