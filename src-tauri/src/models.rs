use std::{
    path::{Component, Path},
    sync::OnceLock,
    time::Duration,
};

use crate::error::AppError;
use reqwest::{
    Client, StatusCode, Url,
    multipart::{Form, Part},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::fs::{self, File};

const MAX_AUDIO_BYTES: u64 = 25_000_000;

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

async fn checked_audio(app: &AppHandle, path: &Path) -> Result<File, AppError> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "error.cacheLocation")?;
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

#[tauri::command]
pub async fn transcribe_audio_chunk(
    app: AppHandle,
    base_url: String,
    api_key: String,
    model: String,
    path: String,
) -> Result<Value, AppError> {
    let url = endpoint(&base_url, "audio/transcriptions")?;
    let (api_key, model) = credentials(&api_key, &model)?;
    let audio = checked_audio(&app, Path::new(&path)).await?;
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
    send_json(
        client()?
            .post(url)
            .timeout(Duration::from_secs(90))
            .bearer_auth(api_key)
            .multipart(form),
        "model.purpose.asr",
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
pub struct ChatMessage {
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

#[tauri::command]
pub async fn complete_text(
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    reasoning_effort: Option<String>,
) -> Result<Value, AppError> {
    let url = endpoint(&base_url, "chat/completions")?;
    let (api_key, model) = credentials(&api_key, &model)?;
    let body = ChatRequest {
        model,
        messages,
        reasoning_effort: reasoning_effort.as_deref(),
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
