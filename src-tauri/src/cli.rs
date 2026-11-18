use std::{
    fs,
    io::{self, Write},
    path::{self, PathBuf},
    process::ExitCode,
};

use clap::Parser;
use serde_json::json;
use tempfile::TempDir;

use crate::{
    error::AppError,
    locale::Locale,
    media::{MediaSource, MediaTools, prepare_audio},
    models::{OrganizationOptions, organize, transcribe},
    output::{
        OutputFormat, OutputLabels, create_output_directory, validate_output_directory,
        write_output,
    },
    settings::{APP_IDENTIFIER, ModelSettings, read_model_settings},
    video::{VideoPart, choose_parts, inspect, parse_source},
};

#[derive(Parser)]
#[command(
    name = "lectavia-cli",
    version,
    about = "Transcribe one video into a document without opening Lectavia."
)]
struct Args {
    /// Bilibili or YouTube URL, or the path to a local video
    #[arg(value_name = "VIDEO")]
    video: PathBuf,

    /// Existing output directory
    #[arg(short, long, default_value = ".")]
    output_dir: PathBuf,

    /// Output file format
    #[arg(long, value_enum, default_value = "md")]
    format: OutputFormat,

    /// Bilibili part numbers (comma-separated)
    #[arg(long, value_delimiter = ',', value_parser = clap::value_parser!(u32).range(1..))]
    parts: Vec<u32>,

    /// Additional instructions for organizing the transcript
    #[arg(long, conflicts_with = "instructions_file")]
    instructions: Option<String>,

    /// UTF-8 file containing instructions
    #[arg(long)]
    instructions_file: Option<PathBuf>,

    /// Language for built-in instructions, file labels, and progress
    #[arg(long, value_enum, default_value = "zh-CN")]
    lang: Locale,
}

struct Job {
    tools: MediaTools,
    cache: TempDir,
    settings: ModelSettings,
    directory: String,
    video_title: String,
    description: Option<String>,
    multipart: bool,
    format: OutputFormat,
    locale: Locale,
    instructions: Option<String>,
}

impl Job {
    async fn write_part(&self, part: VideoPart, title: String) -> Result<String, AppError> {
        let phase = |key| match part.number {
            Some(number) => report(&format!("[P{number}] {}", self.locale.text(key))),
            None => report(self.locale.text(key)),
        };
        phase("task.phase.audio");
        let audio = prepare_audio(&self.tools, self.cache.path(), part.source).await?;

        phase("task.phase.transcription");
        let transcript = transcribe(self.cache.path(), &audio.files, &self.settings.asr).await;
        audio.cleanup();
        let transcript = transcript?;

        phase("task.phase.organization");
        let options = OrganizationOptions {
            video_title: self.video_title.clone(),
            part_title: self.multipart.then(|| title.clone()),
            description: self.description.clone(),
            format: self.format,
            locale: self.locale,
            output_language: None,
            instructions: self.instructions.clone(),
        };
        let document = organize(&transcript, &self.settings.llm, &options).await?;

        phase("task.phase.output");
        write_output(
            self.directory.clone(),
            title,
            self.format.as_str().to_owned(),
            document,
            part.number,
            OutputLabels {
                fallback_title: self.locale.text("output.fallbackTitle").to_owned(),
                document_suffix: self.locale.text("output.suffix").to_owned(),
            },
        )
        .await
    }
}

fn report(text: &str) {
    let _ = writeln!(io::stderr().lock(), "{text}");
}

async fn generate(args: Args) -> Result<ExitCode, AppError> {
    let locale = args.lang;
    let source = parse_source(args.video)?;
    if !args.parts.is_empty() && !matches!(source, MediaSource::Bilibili { .. }) {
        return Err("cli.partsUnsupported".into());
    }
    let directory =
        path::absolute(args.output_dir).map_err(|error| AppError::detail("cli.path", error))?;
    let mut directory = validate_output_directory(directory.to_string_lossy().into_owned()).await?;
    let instructions = match args.instructions_file {
        Some(path) => Some(
            fs::read_to_string(path)
                .map_err(|error| AppError::detail("cli.instructionsRead", error))?
                .trim_start_matches('\u{feff}')
                .to_owned(),
        ),
        None => args.instructions,
    };
    let settings = read_model_settings(APP_IDENTIFIER.to_owned())
        .await?
        .filter(|settings| settings.asr.is_configured() && settings.llm.is_configured())
        .ok_or("cli.settingsMissing")?;
    let tools = MediaTools::cli();
    report(locale.text("cli.inspect"));
    let video = inspect(&tools, source).await?;
    let multipart = video.parts.len() > 1;
    let title = video.title.clone();
    let description = video.description.clone();
    let parts = choose_parts(video, args.parts)?;
    let cache =
        tempfile::tempdir().map_err(|err| AppError::detail("error.audioCacheCreate", err))?;
    if multipart {
        directory = create_output_directory(
            directory,
            title.clone(),
            locale.text("output.fallbackTitle").to_owned(),
        )
        .await?;
    }
    let job = Job {
        tools,
        cache,
        settings,
        directory,
        video_title: title.clone(),
        description,
        multipart,
        format: args.format,
        locale,
        instructions,
    };
    let mut status = ExitCode::SUCCESS;
    for mut part in parts {
        let number = part.number;
        let part_title = part
            .title
            .take()
            .or_else(|| {
                number.filter(|_| multipart).map(|number| {
                    locale
                        .text("media.part")
                        .replace("{{number}}", &number.to_string())
                })
            })
            .unwrap_or_else(|| title.clone());
        match job.write_part(part, part_title).await {
            Ok(path) => writeln!(io::stdout().lock(), "{path}")
                .map_err(|error| AppError::detail("cli.printPath", error))?,
            Err(error) => {
                status = ExitCode::FAILURE;
                let error = match number {
                    Some(number) => AppError::from("cli.partFailed")
                        .with("number", number)
                        .with("cause", json!(error)),
                    None => error,
                };
                report(&locale.error(&error));
            }
        }
    }
    Ok(status)
}

#[tokio::main(flavor = "current_thread")]
pub async fn run() -> ExitCode {
    let args = Args::parse();
    let locale = args.lang;
    match generate(args).await {
        Ok(status) => status,
        Err(error) => {
            report(&locale.error(&error));
            ExitCode::FAILURE
        }
    }
}
