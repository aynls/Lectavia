mod document;

use document::Document;
pub(super) use document::DocumentOptions;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{sync::Semaphore, task::AbortHandle};
use uuid::Uuid;

use crate::{
    error::AppError,
    media::{MediaSource, MediaTools, PreparedAudio, prepare_audio},
    models::transcribe,
    settings::{APP_IDENTIFIER, read_model_settings},
    video::{choose_parts, inspect, parse_source},
};

#[derive(Clone, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct VideoInput {
    /// Local video path or HTTPS Bilibili / YouTube video URL.
    video: String,
    /// One-based Bilibili part numbers. Defaults to the URL's p parameter or the first part.
    #[serde(default)]
    parts: Vec<u32>,
}

#[derive(Deserialize, JsonSchema, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub(super) enum Source {
    Video(VideoInput),
    Transcripts { transcript_ids: Vec<String> },
}

#[derive(Clone)]
pub(super) struct Jobs {
    registry: Arc<Mutex<Registry>>,
    cache: Arc<TempDir>,
    workers: Arc<Semaphore>,
}

#[derive(Default)]
struct Registry {
    requests: HashMap<String, (Value, String)>,
    jobs: HashMap<String, Arc<Job>>,
    results: HashMap<String, Arc<Artifact>>,
}

impl Registry {
    fn previous(&self, request_id: &str, fingerprint: &Value) -> Result<Option<Value>, AppError> {
        if request_id.trim().is_empty() {
            return Err("mcp.requestId".into());
        }
        match self.requests.get(request_id) {
            Some((previous, id)) if previous == fingerprint => Ok(Some(json!({ "job_id": id }))),
            Some(_) => Err("mcp.requestConflict".into()),
            None => Ok(None),
        }
    }
}

struct Job {
    source: Source,
    document: Option<Document>,
    state: Mutex<JobState>,
}

#[derive(Default)]
struct JobState {
    preparation: Progress,
    parts: Vec<Arc<Part>>,
}

#[derive(Clone, Copy, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    #[default]
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Default)]
struct Progress {
    status: Status,
    phase: Option<&'static str>,
    error: Option<AppError>,
    worker: Option<AbortHandle>,
}

impl Progress {
    fn cancel(&mut self) {
        if matches!(self.status, Status::Queued | Status::Running) {
            if let Some(worker) = self.worker.take() {
                worker.abort();
            }
            self.status = Status::Cancelled;
            self.phase = None;
        }
    }

    fn running(&mut self, phase: &'static str) {
        self.status = Status::Running;
        self.phase = Some(phase);
    }

    fn finish(&mut self, outcome: Result<(), AppError>) {
        self.worker = None;
        match outcome {
            Ok(()) => {
                self.status = Status::Completed;
                self.phase = None;
            }
            Err(error) => {
                self.status = Status::Failed;
                self.error = Some(error);
            }
        }
    }
}

impl JobState {
    fn select_parts(&self, ids: Option<&[String]>) -> Result<Vec<Arc<Part>>, AppError> {
        if let Some(ids) = ids {
            if ids.is_empty() || ids.iter().any(|id| !self.parts.iter().any(|p| p.id == *id)) {
                return Err("mcp.partIds".into());
            }
            return Ok(self
                .parts
                .iter()
                .filter(|p| ids.contains(&p.id))
                .cloned()
                .collect());
        }
        Ok(self.parts.clone())
    }
}

struct PartInfo {
    video_key: String,
    multipart: bool,
    description: Option<String>,
    video_title: String,
    title: String,
    number: Option<u32>,
    source: MediaSource,
}

struct Part {
    id: String,
    info: Arc<PartInfo>,
    state: Mutex<PartState>,
}

#[derive(Default)]
struct PartState {
    progress: Progress,
    audio: Option<Arc<PreparedAudio>>,
    transcript_id: Option<String>,
    document_id: Option<String>,
    output_path: Option<String>,
}

struct Artifact {
    kind: &'static str,
    info: Arc<PartInfo>,
    text: Arc<str>,
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

impl Jobs {
    pub fn retry(
        &self,
        request_id: String,
        id: &str,
        ids: Option<&[String]>,
    ) -> Result<Value, AppError> {
        let fingerprint = json!({ "retry_job": id, "part_ids": ids });
        let mut registry = self.registry.lock().unwrap();
        if let Some(receipt) = registry.previous(&request_id, &fingerprint)? {
            return Ok(receipt);
        }
        let job = registry.jobs.get(id).cloned().ok_or("mcp.jobMissing")?;
        let mut state = job.state.lock().unwrap();
        let selected = state.select_parts(ids)?;
        let prepare = state.preparation.status == Status::Failed;
        let failed: Vec<_> = selected
            .into_iter()
            .filter(|p| p.state.lock().unwrap().progress.status == Status::Failed)
            .collect();
        if !prepare && failed.is_empty() {
            return Err("mcp.noFailedParts".into());
        }
        registry
            .requests
            .insert(request_id, (fingerprint, id.into()));
        drop(registry);
        if prepare {
            state.preparation = Progress::default();
            drop(state);
            self.schedule_job(job);
        } else {
            for part in failed {
                part.state.lock().unwrap().progress = Progress::default();
                self.schedule_part(job.clone(), part);
            }
        }
        Ok(json!({ "job_id": id }))
    }

    pub fn cancel(&self, id: &str, ids: Option<&[String]>) -> Result<Value, AppError> {
        let job = self.job(id)?;
        {
            let mut state = job.state.lock().unwrap();
            let selected = state.select_parts(ids)?;
            if ids.is_none() {
                state.preparation.cancel();
            }
            for part in selected {
                let mut state = part.state.lock().unwrap();
                state.progress.cancel();
                if state.progress.status == Status::Cancelled {
                    state.audio = None;
                }
            }
        }
        self.snapshot(id)
    }

    fn artifact(&self, id: &str) -> Result<Arc<Artifact>, AppError> {
        self.registry
            .lock()
            .unwrap()
            .results
            .get(id)
            .cloned()
            .ok_or_else(|| "mcp.resultMissing".into())
    }

    pub fn read(&self, id: &str, cursor: usize, limit: usize) -> Result<Value, AppError> {
        let result = self.artifact(id)?;
        let remaining = result.text.get(cursor..).ok_or("mcp.page")?;
        if !(1..=16000).contains(&limit) {
            return Err("mcp.page".into());
        }
        let end = remaining
            .char_indices()
            .nth(limit)
            .map(|(offset, _)| cursor + offset);
        Ok(json!({
        "result_id":id, "kind":result.kind, "video_title":result.info.video_title,
            "part_title": result.info.title, "number":result.info.number,
            "text": &result.text[cursor..end.unwrap_or(result.text.len())], "next_cursor":end,
        }))
    }

    fn job(&self, id: &str) -> Result<Arc<Job>, AppError> {
        self.registry
            .lock()
            .unwrap()
            .jobs
            .get(id)
            .cloned()
            .ok_or_else(|| "mcp.jobMissing".into())
    }

    pub fn snapshot(&self, id: &str) -> Result<Value, AppError> {
        let job = self.job(id)?;
        let state = job.state.lock().unwrap();
        let mut parts = Vec::with_capacity(state.parts.len());
        let mut statuses = Vec::with_capacity(state.parts.len());
        for part in &state.parts {
            let state = part.state.lock().unwrap();
            statuses.push(state.progress.status);
            parts.push(json!({
                "part_id": part.id, "number": part.info.number, "title": part.info.title,
                "video_title": part.info.video_title, "status": state.progress.status,
                "phase": state.progress.phase, "error": state.progress.error,
                "transcript_id": state.transcript_id, "document_id": state.document_id,
                "output_path": state.output_path,
            }));
        }
        let status = if statuses.is_empty() {
            json!(state.preparation.status)
        } else if statuses.contains(&Status::Running) {
            json!(Status::Running)
        } else if statuses.contains(&Status::Queued) {
            json!(Status::Queued)
        } else if statuses.iter().all(|s| *s == Status::Completed) {
            json!(Status::Completed)
        } else if statuses.contains(&Status::Completed) {
            json!("partial")
        } else if statuses.contains(&Status::Failed) {
            json!(Status::Failed)
        } else {
            json!(Status::Cancelled)
        };
        Ok(
            json!({"job_id":id,"status":status,"phase":state.preparation.phase,
            "error":state.preparation.error, "parts":parts}),
        )
    }

    pub fn new() -> std::io::Result<Self> {
        Ok(Self {
            registry: Default::default(),
            cache: Arc::new(tempfile::tempdir()?),
            workers: Arc::new(Semaphore::new(4)),
        })
    }

    pub fn submit(
        &self,
        request_id: String,
        source: Source,
        document: Option<DocumentOptions>,
    ) -> Result<Value, AppError> {
        let fingerprint = json!({"source": source, "document": document});
        let mut registry = self.registry.lock().unwrap();
        if let Some(receipt) = registry.previous(&request_id, &fingerprint)? {
            return Ok(receipt);
        }
        let id = new_id();
        let job = Arc::new(Job {
            source,
            document: document.map(Document::new),
            state: Default::default(),
        });
        registry
            .requests
            .insert(request_id, (fingerprint, id.clone()));
        registry.jobs.insert(id.clone(), job.clone());
        drop(registry);
        self.schedule_job(job);
        Ok(json!({ "job_id": id }))
    }

    fn schedule_job(&self, job: Arc<Job>) {
        let jobs = self.clone();
        let owner = job.clone();
        let mut state = owner.state.lock().unwrap();
        let worker = tokio::spawn(async move {
            job.state.lock().unwrap().preparation.running("inspect");
            match jobs.prepare(&job).await {
                Ok(parts) => {
                    let mut state = job.state.lock().unwrap();
                    state.preparation.finish(Ok(()));
                    for part in &parts {
                        jobs.schedule_part(job.clone(), part.clone());
                    }
                    state.parts = parts;
                }
                Err(error) => job.state.lock().unwrap().preparation.finish(Err(error)),
            }
        });
        state.preparation.worker = Some(worker.abort_handle());
    }

    async fn prepare(&self, job: &Job) -> Result<Vec<Arc<Part>>, AppError> {
        if let Some(document) = &job.document {
            job.state.lock().unwrap().preparation.running("output");
            document.destination().await?;
        }
        job.state.lock().unwrap().preparation.running("inspect");
        let input = match &job.source {
            Source::Video(input) => input,
            Source::Transcripts { transcript_ids } => {
                let mut seen = std::collections::HashSet::new();
                if transcript_ids.is_empty() || !transcript_ids.iter().all(|id| seen.insert(id)) {
                    return Err("mcp.transcriptIds".into());
                }
                return transcript_ids
                    .iter()
                    .map(|id| {
                        let artifact = self.artifact(id)?;
                        if artifact.kind != "transcript" {
                            return Err("mcp.transcriptRequired".into());
                        }
                        Ok(Arc::new(Part {
                            id: new_id(),
                            info: artifact.info.clone(),
                            state: Mutex::new(PartState {
                                transcript_id: Some(id.clone()),
                                ..Default::default()
                            }),
                        }))
                    })
                    .collect();
            }
        };
        let source = parse_source(input.video.clone().into())?;
        if !input.parts.is_empty() && !matches!(source, MediaSource::Bilibili { .. }) {
            return Err("cli.partsUnsupported".into());
        }
        let video = inspect(&MediaTools::cli(), source).await?;
        let title = video.title.clone();
        let multipart = video.parts.len() > 1;
        let description = video.description.clone();
        Ok(choose_parts(video, input.parts.clone())?
            .into_iter()
            .map(|part| {
                let info = PartInfo {
                    video_key: input.video.clone(),
                    multipart,
                    description: description.clone(),
                    video_title: title.clone(),
                    title: part.title.unwrap_or_else(|| title.clone()),
                    number: part.number,
                    source: part.source,
                };
                Arc::new(Part {
                    id: new_id(),
                    info: Arc::new(info),
                    state: Default::default(),
                })
            })
            .collect())
    }

    fn schedule_part(&self, job: Arc<Job>, part: Arc<Part>) {
        let jobs = self.clone();
        let owner = part.clone();
        let mut state = owner.state.lock().unwrap();
        let worker = tokio::spawn(async move {
            let _permit = jobs.workers.acquire().await.expect("job pool stays open");
            let result = jobs.run_part(&part, job.document.as_ref()).await;
            part.state.lock().unwrap().progress.finish(result);
        });
        state.progress.worker = Some(worker.abort_handle());
    }

    async fn run_part(&self, part: &Part, document: Option<&Document>) -> Result<(), AppError> {
        let cached = part.state.lock().unwrap().transcript_id.clone();
        let transcript_id = match cached {
            Some(id) => id,
            None => self.transcribe_part(part).await?,
        };
        if let Some(document) = document {
            let cached = part.state.lock().unwrap().document_id.clone();
            let id = match cached {
                Some(id) => id,
                None => {
                    part.state.lock().unwrap().progress.running("organization");
                    let transcript = self.artifact(&transcript_id)?;
                    let text = document.organize(&transcript.text, &part.info).await?;
                    let id = self.store_result(part, "document", text);
                    part.state.lock().unwrap().document_id = Some(id.clone());
                    id
                }
            };
            part.state.lock().unwrap().progress.running("output");
            let result = self.artifact(&id)?;
            let path = document.save(&part.info, &result.text).await?;
            part.state.lock().unwrap().output_path = Some(path);
        }
        Ok(())
    }

    async fn transcribe_part(&self, part: &Part) -> Result<String, AppError> {
        part.state.lock().unwrap().progress.running("transcription");
        let settings = read_model_settings(APP_IDENTIFIER.to_owned())
            .await?
            .ok_or("mcp.asrSettings")?;
        if settings.asr.api_key.trim().is_empty() || settings.asr.model.trim().is_empty() {
            return Err("mcp.asrSettings".into());
        }
        let cached = part.state.lock().unwrap().audio.clone();
        let audio = match cached {
            Some(audio) => audio,
            None => {
                part.state.lock().unwrap().progress.running("audio");
                let audio = Arc::new(
                    prepare_audio(
                        &MediaTools::cli(),
                        self.cache.path(),
                        part.info.source.clone(),
                        None,
                    )
                    .await?,
                );
                part.state.lock().unwrap().audio = Some(audio.clone());
                audio
            }
        };
        part.state.lock().unwrap().progress.running("transcription");
        let text = transcribe(self.cache.path(), &audio.files, &settings.asr)
            .await
            .map_err(|error| {
                let cause = error
                    .values
                    .get("cause")
                    .and_then(|cause| cause["key"].as_str());
                if matches!(
                    cause,
                    Some(
                        "error.cacheAccess"
                            | "error.audioChunkMissing"
                            | "error.audioChunkRestricted"
                            | "error.audioChunkOpen"
                            | "error.audioChunkMetadata"
                            | "error.audioChunkEmpty"
                            | "error.audioChunkTooLarge"
                    )
                ) {
                    part.state.lock().unwrap().audio = None;
                }
                error
            })?;
        let id = self.store_result(part, "transcript", text);
        let mut state = part.state.lock().unwrap();
        state.transcript_id = Some(id.clone());
        state.audio = None;
        Ok(id)
    }

    fn store_result(&self, part: &Part, kind: &'static str, text: String) -> String {
        let id = new_id();
        self.registry.lock().unwrap().results.insert(
            id.clone(),
            Arc::new(Artifact {
                kind,
                info: part.info.clone(),
                text: text.into(),
            }),
        );
        id
    }
}
