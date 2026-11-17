use std::{
    path::{Component, Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use crate::{error::AppError, locale::Locale, output::OutputFormat, settings::ModelConnection};
#[cfg(feature = "desktop")]
use crate::{media::app_cache_dir, task_runs::TaskRuns};
use reqwest::{
    Client, StatusCode, Url,
    multipart::{Form, Part},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[cfg(feature = "desktop")]
use tauri::{AppHandle, State};
use tokio::fs::{self, File};

const MAX_AUDIO_BYTES: u64 = 25_000_000;
const SECTION_SIZE: usize = 5_000;

static CLIENT: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();

fn client() -> Result<&'static Client, AppError> {
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .redirect(Policy::none())
                .build()
        })
        .as_ref()
        .map_err(|_| "error.modelNetworkInit".into())
}

fn endpoint(base_url: &str, route: &str) -> Result<Url, AppError> {
    let mut url = Url::parse(base_url.trim()).map_err(|_| "error.baseUrl")?;
    let is_local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && is_local))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("error.baseUrl".into());
    }

    let path = url.path().trim_end_matches('/');
    if ["/models", "/audio/transcriptions", "/chat/completions"]
        .iter()
        .any(|route| path.ends_with(route))
    {
        return Err("error.baseUrlHasRoute".into());
    }

    url.set_path(&format!("{path}/{route}"));
    Ok(url)
}

fn credentials<'a>(api_key: &'a str, model: &'a str) -> Result<(&'a str, &'a str), AppError> {
    let api_key = api_key.trim();
    let model = model.trim();
    if api_key.is_empty() || model.is_empty() {
        return Err("error.credentials".into());
    }
    Ok((api_key, model))
}

async fn checked_audio(cache: &Path, path: &Path) -> Result<File, AppError> {
    let media = fs::canonicalize(cache)
        .await
        .map_err(|_| "error.cacheAccess")?
        .join("media");
    let path = fs::canonicalize(path)
        .await
        .map_err(|_| "error.audioChunkMissing")?;
    let relative = path
        .strip_prefix(&media)
        .map_err(|_| "error.audioChunkRestricted")?;

    let mut parts = relative.components();
    if let (Some(Component::Normal(directory)), Some(Component::Normal(name)), None) =
        (parts.next(), parts.next(), parts.next())
    {
        let audio_dir = directory
            .to_str()
            .is_some_and(|directory| directory.starts_with("audio-"));
        let audio_name = name
            .to_str()
            .and_then(|name| name.strip_prefix("chunk-"))
            .and_then(|name| name.strip_suffix(".mp3"))
            .is_some_and(|index| {
                !index.is_empty() && index.bytes().all(|digit| digit.is_ascii_digit())
            });

        if audio_dir && audio_name {
            return File::open(path)
                .await
                .map_err(|_| "error.audioChunkOpen".into());
        }
    }

    Err("error.audioChunkRestricted".into())
}

async fn send_json(
    request: reqwest::RequestBuilder,
    task: &'static str,
) -> Result<Value, AppError> {
    let provider_error =
        |key: &'static str| AppError::from(key).with("task", json!({ "key": task }));
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            provider_error("error.providerTimeout")
        } else {
            provider_error("error.providerConnect")
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        let reason = match status {
            StatusCode::BAD_REQUEST => "error.httpBadRequest",
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "error.httpAccess",
            StatusCode::NOT_FOUND => "error.httpNotFound",
            StatusCode::PAYMENT_REQUIRED => "error.httpPayment",
            StatusCode::PAYLOAD_TOO_LARGE => "error.httpLarge",
            StatusCode::TOO_MANY_REQUESTS => "error.httpRate",
            _ if status.is_redirection() => "error.httpRedirect",
            _ if status.is_server_error() => "error.httpServer",
            _ => "error.httpOther",
        };
        return Err(provider_error("error.providerHttp")
            .with("status", status.as_u16())
            .with("reason", json!({ "key": reason })));
    }
    response.json().await.map_err(|error| {
        if error.is_timeout() {
            provider_error("error.providerResponseTimeout")
        } else if error.is_decode() {
            provider_error("error.providerJson")
        } else {
            provider_error("error.providerResponse")
        }
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn list_models(
    base_url: String,
    api_key: String,
    transcription: bool,
) -> Result<Value, AppError> {
    let mut url = endpoint(&base_url, "models")?;
    if transcription {
        url.query_pairs_mut()
            .append_pair("output_modalities", "transcription");
    }
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("error.apiKey".into());
    }
    send_json(
        client()?
            .get(url)
            .timeout(Duration::from_secs(30))
            .bearer_auth(api_key),
        "model.providerCatalog",
    )
    .await
}

async fn transcribe_audio_chunk(
    cache: &Path,
    connection: &ModelConnection,
    path: &Path,
) -> Result<String, AppError> {
    let url = endpoint(&connection.base_url, "audio/transcriptions")?;
    let (api_key, model) = credentials(&connection.api_key, &connection.model)?;
    let audio = checked_audio(cache, path).await?;
    let metadata = audio
        .metadata()
        .await
        .map_err(|_| "error.audioChunkMetadata")?;

    if !metadata.is_file() || metadata.len() == 0 {
        return Err("error.audioChunkEmpty".into());
    }
    if metadata.len() > MAX_AUDIO_BYTES {
        return Err("error.audioChunkTooLarge".into());
    }

    let part = Part::stream_with_length(audio, metadata.len())
        .file_name("chunk.mp3")
        .mime_str("audio/mpeg")
        .map_err(|_| "error.audioRequest")?;
    let form = Form::new()
        .text("model", model.to_owned())
        .part("file", part);
    let result = send_json(
        client()?
            .post(url)
            .timeout(Duration::from_secs(90))
            .bearer_auth(api_key)
            .multipart(form),
        "model.purpose.asr",
    )
    .await?;
    result["text"]
        .as_str()
        .map(|text| text.trim().to_owned())
        .ok_or_else(|| "error.transcriptionMissing".into())
}

pub async fn transcribe(
    cache: &Path,
    files: &[PathBuf],
    connection: &ModelConnection,
) -> Result<String, AppError> {
    let mut transcript = Vec::new();
    for (index, path) in files.iter().enumerate() {
        let text = transcribe_audio_chunk(cache, connection, path)
            .await
            .map_err(|error| {
                AppError::from("error.transcriptionChunk")
                    .with("number", index + 1)
                    .with("cause", json!(error))
            })?;
        if !text.is_empty() {
            transcript.push(text);
        }
    }
    if transcript.is_empty() {
        return Err("error.noSpeech".into());
    }
    Ok(transcript.join("\n\n"))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    runs: State<'_, TaskRuns>,
    run_id: String,
    files: Vec<PathBuf>,
    connection: ModelConnection,
) -> Result<String, AppError> {
    runs.run(
        &run_id,
        transcribe(&app_cache_dir(&app)?, &files, &connection),
    )
    .await
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ChatRole {
    System,
    User,
}

#[derive(Deserialize, Serialize)]
struct ChatMessage {
    role: ChatRole,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'a str>,
}

async fn complete_text(
    connection: &ModelConnection,
    messages: Vec<ChatMessage>,
) -> Result<Value, AppError> {
    let url = endpoint(&connection.base_url, "chat/completions")?;
    let (api_key, model) = credentials(&connection.api_key, &connection.model)?;
    let body = ChatRequest {
        model,
        messages,
        reasoning_effort: connection.selected_reasoning_effort(),
    };
    send_json(
        client()?
            .post(url)
            .timeout(Duration::from_secs(180))
            .bearer_auth(api_key)
            .json(&body),
        "model.purpose.llm",
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationOptions {
    pub locale: Locale,
    pub output_language: Option<String>,
    pub video_title: String,
    pub part_title: Option<String>,
    pub description: Option<String>,
    pub format: OutputFormat,
    pub instructions: Option<String>,
}

fn section_end(text: &str) -> usize {
    let mut units = 0;
    let mut sentence_end = None;
    let mut word_end = None;
    for (index, character) in text.char_indices() {
        let width = character.len_utf16();
        if units + width > SECTION_SIZE {
            return sentence_end.or(word_end).unwrap_or(index);
        }
        if units >= SECTION_SIZE / 2 {
            let end = index + character.len_utf8();
            if matches!(character, '\n' | '。' | '！' | '？')
                || (matches!(character, '!' | '?' | '.')
                    && units + 1 < SECTION_SIZE
                    && text[end..].starts_with(' '))
            {
                sentence_end = Some(end);
            }
            if character == ' ' {
                word_end = Some(end);
            }
        }
        units += width;
    }
    text.len()
}

fn organization_prompt(options: &OrganizationOptions) -> String {
    let locale = options.locale;
    let language = options.output_language.as_deref().unwrap_or_else(|| {
        locale.text(match locale {
            Locale::ZhCn => "outputLanguage.zh-CN",
            Locale::Ja => "outputLanguage.ja",
            Locale::En => "outputLanguage.en",
        })
    });
    let intro = locale
        .text(match options.format {
            OutputFormat::Md => "prompt.markdown",
            OutputFormat::Txt => "prompt.plainText",
        })
        .replace("{{language}}", language);
    let mut paragraphs = vec![
        intro.as_str(),
        locale.text("prompt.fidelity"),
        locale.text("prompt.context"),
        locale.text("prompt.priority"),
    ];
    if let Some(instructions) = options.instructions.as_deref().map(str::trim)
        && !instructions.is_empty()
    {
        paragraphs.extend([locale.text("prompt.custom"), instructions]);
    }
    paragraphs.join("\n\n")
}

pub async fn organize(
    mut transcript: &str,
    connection: &ModelConnection,
    options: &OrganizationOptions,
) -> Result<String, AppError> {
    let mut sections = Vec::new();
    while !transcript.is_empty() {
        let (section, rest) = transcript.split_at(section_end(transcript));
        if !section.trim().is_empty() {
            sections.push(section.trim());
        }
        transcript = rest;
    }
    if sections.is_empty() {
        return Err("error.emptyTranscript".into());
    }

    let system_prompt = organization_prompt(options);
    let mut material = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        let mut source = json!({
            "videoTitle": options.video_title,
            "section": index + 1,
            "sectionCount": sections.len(),
            "transcript": section,
        });
        if let Some(part_title) = &options.part_title {
            source["partTitle"] = json!(part_title);
        }
        if let Some(description) = &options.description {
            source["description"] = json!(description);
        }

        let response = complete_text(
            connection,
            vec![
                ChatMessage {
                    role: ChatRole::System,
                    content: system_prompt.clone(),
                },
                ChatMessage {
                    role: ChatRole::User,
                    content: source.to_string(),
                },
            ],
        )
        .await?;
        let choice = &response["choices"][0];
        let finish_reason = choice["finish_reason"].as_str().unwrap_or_default();
        if finish_reason == "length" {
            return Err("error.outputLength".into());
        }
        if finish_reason == "content_filter"
            || choice["message"]["refusal"]
                .as_str()
                .is_some_and(|refusal| !refusal.is_empty())
        {
            return Err("error.modelRefusal".into());
        }
        let content = choice["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .trim();
        if !matches!(finish_reason, "" | "stop") || content.is_empty() {
            return Err("error.modelEmpty".into());
        }
        material.push(content.to_owned());
    }
    Ok(material.join("\n\n") + "\n")
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn organize_transcript(
    runs: State<'_, TaskRuns>,
    run_id: String,
    transcript: String,
    connection: ModelConnection,
    options: OrganizationOptions,
) -> Result<String, AppError> {
    runs.run(&run_id, organize(&transcript, &connection, &options))
        .await
}
