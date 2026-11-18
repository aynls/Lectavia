use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::{
    error::AppError,
    media::{MediaSource, MediaTools, PreparedAudio, prepare_audio},
    models::transcribe,
    settings::{APP_IDENTIFIER, read_model_settings},
    video::{choose_parts, inspect, parse_source},
};

#[derive(Clone, Deserialize, JsonSchema, Serialize)]
pub(super) struct VideoInput {
    /// Local video path or HTTPS Bilibili / YouTube video URL.
    video: String,
    /// One-based Bilibili part numbers. Defaults to the URL's p parameter or the first part.
    #[serde(default)]
    parts: Vec<u32>,
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

struct Job {
    source: VideoInput,
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
}

#[derive(Default)]
struct Progress {
    status: Status,
    phase: Option<&'static str>,
    error: Option<AppError>,
}

impl Progress {
    fn running(&mut self, phase: &'static str) {
        self.status = Status::Running;
        self.phase = Some(phase);
    }

    fn finish(&mut self, outcome: Result<(), AppError>) {
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

struct PartInfo {
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
}

struct Artifact {
    info: Arc<PartInfo>,
    text: Arc<str>,
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

impl Jobs {
    pub fn new() -> std::io::Result<Self> {
        Ok(Self {
            registry: Default::default(),
            cache: Arc::new(tempfile::tempdir()?),
            workers: Arc::new(Semaphore::new(4)),
        })
    }

    pub fn submit(&self, request_id: String, source: VideoInput) -> Result<Value, AppError> {
        if request_id.trim().is_empty() {
            return Err("mcp.requestId".into());
        }
        let fingerprint = json!(source);
        let mut registry = self.registry.lock().unwrap();
        if let Some((previous, id)) = registry.requests.get(&request_id) {
            if *previous != fingerprint {
                return Err("mcp.requestConflict".into());
            }
            return Ok(json!({ "job_id": id }));
        }
        let id = new_id();
        let job = Arc::new(Job {
            source,
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
        tokio::spawn(async move {
            job.state.lock().unwrap().preparation.running("inspect");
            match jobs.prepare(&job.source).await {
                Ok(parts) => {
                    let mut state = job.state.lock().unwrap();
                    state.preparation.finish(Ok(()));
                    for part in &parts {
                        jobs.schedule_part(part.clone());
                    }
                    state.parts = parts;
                }
                Err(error) => job.state.lock().unwrap().preparation.finish(Err(error)),
            }
        });
    }

    async fn prepare(&self, input: &VideoInput) -> Result<Vec<Arc<Part>>, AppError> {
        let source = parse_source(input.video.clone().into())?;
        if !input.parts.is_empty() && !matches!(source, MediaSource::Bilibili { .. }) {
            return Err("cli.partsUnsupported".into());
        }
        let video = inspect(&MediaTools::cli(), source).await?;
        let title = video.title.clone();
        Ok(choose_parts(video, input.parts.clone())?
            .into_iter()
            .map(|part| {
                let info = PartInfo {
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

    fn schedule_part(&self, part: Arc<Part>) {
        let jobs = self.clone();
        tokio::spawn(async move {
            let _permit = jobs.workers.acquire().await.expect("job pool stays open");
            let result = jobs.run_part(&part).await;
            part.state.lock().unwrap().progress.finish(result);
        });
    }

    async fn run_part(&self, part: &Part) -> Result<(), AppError> {
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
        let text = transcribe(self.cache.path(), &audio.files, &settings.asr).await?;
        let id = new_id();
        self.registry.lock().unwrap().results.insert(
            id.clone(),
            Arc::new(Artifact {
                info: part.info.clone(),
                text: text.into(),
            }),
        );
        let mut state = part.state.lock().unwrap();
        state.transcript_id = Some(id);
        state.audio = None;
        Ok(())
    }
}
