use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

use crate::{
    error::AppError,
    locale::Locale,
    output::OutputFormat,
    settings::{AsrConnection, AsrProvider, ModelConnection},
};
use reqwest::{
    Client, RequestBuilder, Response, StatusCode, Url,
    header::HeaderValue,
    multipart::{Form, Part},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::fs::{self, File};

const MAX_AUDIO_BYTES: u64 = 25_000_000;

static CLIENT: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsrPreset {
    transcription_url: String,
    #[cfg(feature = "desktop")]
    catalog_url: String,
}

impl AsrProvider {
    fn preset(self) -> Option<&'static AsrPreset> {
        static PRESETS: OnceLock<HashMap<AsrProvider, AsrPreset>> = OnceLock::new();
        PRESETS
            .get_or_init(|| {
                serde_json::from_str(include_str!("../../src/asr-providers.json"))
                    .expect("valid built-in ASR providers")
            })
            .get(&self)
    }
}

fn client() -> Result<&'static Client, AppError> {
    CLIENT
        .get_or_init(|| Client::builder().redirect(Policy::none()).build())
        .as_ref()
        .map_err(|_| "error.modelNetworkInit".into())
}

fn endpoint_url(value: &str) -> Result<Url, AppError> {
    let url = Url::parse(value.trim()).map_err(|_| "error.baseUrl")?;
    let is_local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && is_local))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("error.baseUrl".into());
    }

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

fn provider_error(task: &'static str, key: &'static str) -> AppError {
    AppError::from(key).with("task", json!({ "key": task }))
}

async fn send_request(request: RequestBuilder, task: &'static str) -> Result<Response, AppError> {
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            provider_error(task, "error.providerTimeout")
        } else {
            provider_error(task, "error.providerConnect")
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
        return Err(provider_error(task, "error.providerHttp")
            .with("status", status.as_u16())
            .with("reason", json!({ "key": reason })));
    }
    Ok(response)
}

fn response_error(task: &'static str, error: reqwest::Error) -> AppError {
    let key = if error.is_timeout() {
        "error.providerResponseTimeout"
    } else if error.is_decode() {
        "error.providerJson"
    } else {
        "error.providerResponse"
    };
    provider_error(task, key)
}

async fn send_json(request: RequestBuilder, task: &'static str) -> Result<Value, AppError> {
    send_request(request, task)
        .await?
        .json()
        .await
        .map_err(|error| response_error(task, error))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn list_models(
    url: String,
    api_key: String,
    asr_provider: Option<AsrProvider>,
) -> Result<Value, AppError> {
    let preset = asr_provider.and_then(AsrProvider::preset);
    let url = endpoint_url(preset.map_or(&url, |preset| &preset.catalog_url))?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("error.apiKey".into());
    }
    let task = "model.providerCatalog";
    let request = client()?
        .get(url)
        .timeout(std::time::Duration::from_secs(30));
    if asr_provider == Some(AsrProvider::ElevenLabs) {
        // The published batch-ASR catalog is public and does not take credentials.
        let markdown = send_request(request, task)
            .await?
            .text()
            .await
            .map_err(|error| response_error(task, error))?;
        return elevenlabs_catalog(&markdown);
    }
    send_json(request.bearer_auth(api_key), task).await
}

#[cfg(feature = "desktop")]
fn elevenlabs_catalog(markdown: &str) -> Result<Value, AppError> {
    let models: Vec<_> = markdown
        .lines()
        .skip_while(|line| line.trim() != "## Models overview")
        .skip(1)
        .take_while(|line| {
            !line.trim_start().starts_with("## ") && !line.trim_start().starts_with("### ")
        })
        .filter_map(|line| {
            let mut cells = line.trim().strip_prefix('|')?.split('|').map(str::trim);
            let id = cells.next()?.strip_prefix('`')?.strip_suffix('`')?;
            let description = cells.next()?.to_ascii_lowercase();
            let languages = cells.next()?;
            if languages.contains("/capabilities/speech-to-text")
                && !description.contains("real-time")
                && !description.contains("realtime")
            {
                Some(json!({"id": id}))
            } else {
                None
            }
        })
        .collect();
    if models.is_empty() {
        return Err("error.catalogFormat".into());
    }
    Ok(json!({"data": models}))
}

async fn transcribe_audio_chunk(
    cache: &Path,
    asr: &AsrConnection,
    path: &Path,
) -> Result<String, AppError> {
    let connection = &asr.connection;
    let url = endpoint_url(
        asr.provider
            .preset()
            .map_or(&connection.base_url, |preset| &preset.transcription_url),
    )?;
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
    let request = client()?.post(url);
    let (request, model_field) = if asr.provider == AsrProvider::ElevenLabs {
        let mut key = HeaderValue::from_str(api_key).map_err(|_| "error.apiKey")?;
        key.set_sensitive(true);
        (request.header("xi-api-key", key), "model_id")
    } else {
        (request.bearer_auth(api_key), "model")
    };
    let form = Form::new()
        .text(model_field, model.to_owned())
        .part("file", part);
    let result = send_json(request.multipart(form), "model.purpose.asr").await?;
    result["text"]
        .as_str()
        .map(|text| text.trim().to_owned())
        .ok_or_else(|| "error.transcriptionMissing".into())
}

pub async fn transcribe(
    cache: &Path,
    files: &[PathBuf],
    connection: &AsrConnection,
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
    let url = endpoint_url(&connection.base_url)?;
    let (api_key, model) = credentials(&connection.api_key, &connection.model)?;
    let body = ChatRequest {
        model,
        messages,
        reasoning_effort: connection.selected_reasoning_effort(),
    };
    send_json(
        client()?.post(url).bearer_auth(api_key).json(&body),
        "model.purpose.llm",
    )
    .await
}

pub struct OrganizationOptions {
    pub locale: Locale,
    pub output_language: Option<String>,
    pub video_title: String,
    pub part_title: Option<String>,
    pub description: Option<String>,
    pub format: OutputFormat,
    pub instructions: Option<String>,
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
    transcript: &str,
    connection: &ModelConnection,
    options: &OrganizationOptions,
) -> Result<String, AppError> {
    if transcript.trim().is_empty() {
        return Err("error.emptyTranscript".into());
    }

    let mut source = json!({
        "videoTitle": options.video_title,
        "transcript": transcript,
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
                content: organization_prompt(options),
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
    Ok(format!("{content}\n"))
}
