use std::{
    path::{self, Path, PathBuf},
    sync::Arc,
};

use tokio::sync::Mutex;

use super::{GenerationRequest, Mode, Phase, Status, Tasks};
use crate::{
    error::AppError,
    locale::Locale,
    media::{MediaSource, prepare_audio},
    models::{OrganizationOptions, organize, transcribe},
    output::{OutputLabels, create_output_directory, prepare_output, validate_output_directory},
    settings::read_model_settings,
    video::{VideoPreview, choose_parts, inspect, parse_source},
};

pub(super) struct PreparedJob {
    pub title: String,
    pub video: Option<VideoPreview>,
    pub parts: Vec<PartInput>,
}

pub(super) struct PartInput {
    pub title: Option<String>,
    pub number: Option<u32>,
    video_title: String,
    description: Option<String>,
    multipart: bool,
    source: Input,
}

impl PartInput {
    fn part_label(&self, locale: Locale) -> Option<String> {
        let number = self.number.filter(|_| self.multipart)?.to_string();
        let label = match &self.title {
            Some(title) => locale
                .text("media.partLabel")
                .replace("{{number}}", &number)
                .replace("{{title}}", title),
            None => locale.text("media.part").replace("{{number}}", &number),
        };
        Some(label)
    }

    fn output_title(&self, locale: Locale) -> String {
        self.title
            .clone()
            .or_else(|| self.part_label(locale))
            .unwrap_or_else(|| self.video_title.clone())
    }
}

enum Input {
    Video(MediaSource),
    Transcript(PathBuf),
}

fn file_title(path: &Path) -> Option<String> {
    path.file_stem()
        .map(|name| name.to_string_lossy().into_owned())
}

impl GenerationRequest {
    pub(super) fn initial_title(&self) -> String {
        if let Some(video) = &self.video {
            return if video.contains("://") {
                video.clone()
            } else {
                file_title(Path::new(video)).unwrap_or_else(|| video.clone())
            };
        }
        self.transcript_paths
            .as_ref()
            .and_then(|paths| paths.first())
            .and_then(|path| file_title(path))
            .unwrap_or_else(|| self.locale().text("output.fallbackTitle").into())
    }

    fn destination(&self) -> Result<String, AppError> {
        path::absolute(&self.output_directory)
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(|error| AppError::detail("cli.path", error))
    }
}

#[derive(Default)]
pub(super) struct OutputTarget(Mutex<Option<String>>);

impl OutputTarget {
    async fn directory(
        &self,
        base: String,
        input: &PartInput,
        locale: Locale,
    ) -> Result<String, AppError> {
        if !input.multipart {
            return Ok(base);
        }
        let mut existing = self.0.lock().await;
        if let Some(folder) = existing
            .as_ref()
            .filter(|folder| Path::new(folder).is_dir())
        {
            return Ok(folder.clone());
        }
        let folder = create_output_directory(
            base,
            input.video_title.clone(),
            locale.text("output.fallbackTitle").into(),
        )
        .await?;
        *existing = Some(folder.clone());
        Ok(folder)
    }
}

impl Tasks {
    pub(super) async fn prepare(
        &self,
        id: &str,
        request: &GenerationRequest,
    ) -> Result<PreparedJob, AppError> {
        validate_output_directory(request.destination()?).await?;
        if let Some(video) = &request.video {
            {
                let mut queue = self.0.queue.lock().unwrap();
                let preparation = &mut queue.job_mut(id)?.preparation;
                if preparation.status != Status::Running {
                    return Err("error.taskCancelled".into());
                }
                preparation.phase = Some(Phase::Inspect);
                self.changed();
            }
            let source = parse_source(video.into())?;
            let selected = request.parts.clone().unwrap_or_default();
            if !selected.is_empty() && !matches!(source, MediaSource::Bilibili { .. }) {
                return Err("cli.partsUnsupported".into());
            }
            let video = inspect(&self.0.tools, source).await?;
            let title = video.title.clone();
            let description = video.description.clone();
            let preview = VideoPreview::from(&video);
            let multipart = video.parts.len() > 1;
            let parts = choose_parts(video, selected)?
                .into_iter()
                .map(|part| PartInput {
                    title: part.title,
                    number: part.number,
                    video_title: title.clone(),
                    description: description.clone(),
                    multipart,
                    source: Input::Video(part.source),
                })
                .collect::<Vec<_>>();
            return Ok(PreparedJob {
                title,
                video: Some(preview),
                parts,
            });
        }
        let paths = request
            .transcript_paths
            .as_ref()
            .expect("validated request source");
        let parts = paths
            .iter()
            .map(|path| {
                let path =
                    path::absolute(path).map_err(|error| AppError::detail("cli.path", error))?;
                let title = file_title(&path)
                    .unwrap_or_else(|| request.locale().text("output.fallbackTitle").into());
                Ok(PartInput {
                    video_title: title.clone(),
                    title: Some(title),
                    number: None,
                    description: None,
                    multipart: false,
                    source: Input::Transcript(path),
                })
            })
            .collect::<Result<Vec<_>, AppError>>()?;
        Ok(PreparedJob {
            title: request.initial_title(),
            video: None,
            parts,
        })
    }

    pub(super) async fn run_part(
        &self,
        id: &str,
        index: usize,
        request: Arc<GenerationRequest>,
        target: Arc<OutputTarget>,
        input: Arc<PartInput>,
    ) -> Result<(), AppError> {
        let material = match self.part(id, index, |part| part.material.clone())? {
            Some(material) => material,
            None => {
                let transcript = match self.part(id, index, |part| part.transcript.clone())? {
                    Some(text) => text,
                    None => self.transcript(id, index, &input.source).await?,
                };
                let text = if request.mode == Mode::Document {
                    self.part(id, index, |part| {
                        part.progress.phase = Some(Phase::Organization)
                    })?;
                    let settings = read_model_settings(self.0.identifier.clone())
                        .await?
                        .filter(|settings| settings.llm.is_configured())
                        .ok_or("mcp.llmSettings")?;
                    let options = OrganizationOptions {
                        video_title: input.video_title.clone(),
                        part_title: input.part_label(request.locale()),
                        description: input.description.clone(),
                        format: request.format(),
                        locale: request.locale(),
                        output_language: request.output_language.as_ref().map(|language| {
                            let key = format!("outputLanguage.{language}");
                            let translated = request.locale().text(&key);
                            if translated == key {
                                language.clone()
                            } else {
                                translated.into()
                            }
                        }),
                        instructions: request.instructions.clone(),
                    };
                    Arc::from(organize(&transcript, &settings.llm, &options).await?)
                } else {
                    transcript
                };
                self.part(id, index, |part| {
                    part.transcript = None;
                    part.material = Some(text.clone());
                })?;
                text
            }
        };
        self.part(id, index, |part| part.progress.phase = Some(Phase::Output))?;
        let locale = request.locale();
        let directory = target
            .directory(request.destination()?, &input, locale)
            .await?;
        let folder = input.multipart.then(|| directory.clone());
        let pending = tokio::task::spawn_blocking(move || {
            prepare_output(
                &directory,
                &input.output_title(locale),
                request.format().as_str(),
                &material,
                input.number.filter(|_| input.multipart),
                OutputLabels {
                    fallback_title: locale.text("output.fallbackTitle").into(),
                    document_suffix: locale
                        .text(match request.mode {
                            Mode::Document => "output.suffix",
                            Mode::Transcript => "output.transcriptSuffix",
                        })
                        .into(),
                },
            )
        })
        .await
        .map_err(|error| AppError::detail("error.outputWrite", error))??;
        self.publish(id, index, pending, folder)
    }

    async fn transcript(
        &self,
        id: &str,
        index: usize,
        source: &Input,
    ) -> Result<Arc<str>, AppError> {
        let text = match source {
            Input::Video(source) => {
                self.part(id, index, |part| {
                    part.progress.phase = Some(Phase::Transcription)
                })?;
                let settings = read_model_settings(self.0.identifier.clone())
                    .await?
                    .filter(|settings| settings.asr.is_configured())
                    .ok_or("mcp.asrSettings")?;
                let cache = self.0.cache.path();
                let audio = match self.part(id, index, |part| part.audio.clone())? {
                    Some(audio) => audio,
                    None => {
                        self.part(id, index, |part| part.progress.phase = Some(Phase::Audio))?;
                        let audio =
                            Arc::new(prepare_audio(&self.0.tools, cache, source.clone()).await?);
                        self.part(id, index, |part| part.audio = Some(audio.clone()))?;
                        audio
                    }
                };
                self.part(id, index, |part| {
                    part.progress.phase = Some(Phase::Transcription)
                })?;
                match transcribe(cache, &audio.files, &settings.asr).await {
                    Ok(text) => text,
                    Err(error) => {
                        if unusable_audio(&error) {
                            self.part(id, index, |part| part.audio = None)?;
                        }
                        return Err(error);
                    }
                }
            }
            Input::Transcript(path) => {
                self.part(id, index, |part| {
                    part.progress.phase = Some(Phase::Transcription)
                })?;
                if !path.is_file() {
                    return Err("mcp.transcriptFile".into());
                }
                let text = tokio::fs::read_to_string(path)
                    .await
                    .map_err(|error| AppError::detail("mcp.transcriptRead", error))?;
                let text = text.trim_start_matches('\u{feff}');
                if text.trim().is_empty() {
                    return Err("error.emptyTranscript".into());
                }
                text.to_owned()
            }
        };
        let text: Arc<str> = Arc::from(text);
        self.part(id, index, |part| {
            part.audio = None;
            part.transcript = Some(text.clone());
        })?;
        Ok(text)
    }
}

fn unusable_audio(error: &AppError) -> bool {
    let cause = error
        .values
        .get("cause")
        .and_then(|cause| cause["key"].as_str());
    matches!(
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
    )
}
