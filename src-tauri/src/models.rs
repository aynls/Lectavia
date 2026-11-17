use std::{
    path::{Component, Path},
    sync::OnceLock,
    time::Duration,
};

use reqwest::{
    Client, StatusCode, Url,
    multipart::{Form, Part},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::fs::{self, File};

const MAX_AUDIO_BYTES: u64 = 25_000_000;

static CLIENT: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();

fn client() -> Result<&'static Client, String> {
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .redirect(Policy::none())
                .build()
        })
        .as_ref()
        .map_err(|_| "无法初始化模型服务的网络连接。".into())
}

fn endpoint(base_url: &str, route: &str) -> Result<Url, String> {
    let mut url = Url::parse(base_url.trim()).map_err(|_| "API Base URL 无效。")?;
    let is_local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && is_local))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("请输入有效的 API Base URL。外部服务请使用 HTTPS。".into());
    }

    let path = url.path().trim_end_matches('/');
    if ["/models", "/audio/transcriptions", "/chat/completions"]
        .iter()
        .any(|route| path.ends_with(route))
    {
        return Err(
            "请输入 API Base URL，去掉 /models、/audio/transcriptions 或 /chat/completions。"
                .into(),
        );
    }

    url.set_path(&format!("{path}/{route}"));
    Ok(url)
}

fn credentials<'a>(api_key: &'a str, model: &'a str) -> Result<(&'a str, &'a str), String> {
    let api_key = api_key.trim();
    let model = model.trim();
    if api_key.is_empty() || model.is_empty() {
        return Err("请填写 API Key 和模型 ID。".into());
    }
    Ok((api_key, model))
}

async fn checked_audio(app: &AppHandle, path: &Path) -> Result<File, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "无法确定 Lectavia 的缓存目录。")?;
    let media = fs::canonicalize(cache)
        .await
        .map_err(|_| "无法访问 Lectavia 的缓存目录。")?
        .join("media");
    let path = fs::canonicalize(path)
        .await
        .map_err(|_| "找不到待转写的音频分片。")?;
    let relative = path
        .strip_prefix(&media)
        .map_err(|_| "只允许转写 Lectavia 已准备的音频分片。")?;

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
                .map_err(|_| "无法打开待转写的音频分片。".into());
        }
    }

    Err("只允许转写 Lectavia 已准备的音频分片。".into())
}

async fn send_json(request: reqwest::RequestBuilder, task: &str) -> Result<Value, String> {
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            format!("{task}请求超时，请稍后重试。")
        } else {
            format!("{task}无法连接到模型供应商，请检查 Base URL 和网络连接。")
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        let reason = match status {
            StatusCode::BAD_REQUEST => "请检查模型、输入格式和供应商要求。",
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "请检查 API Key 和模型权限。",
            StatusCode::NOT_FOUND => "请检查 Base URL 和模型 ID。",
            StatusCode::PAYMENT_REQUIRED => "请检查供应商账户额度。",
            StatusCode::PAYLOAD_TOO_LARGE => "输入超出了模型供应商的大小限制。",
            StatusCode::TOO_MANY_REQUESTS => "请求过快或额度不足，请稍后重试或检查账户额度。",
            _ if status.is_redirection() => "请填写供应商最终提供服务的 API Base URL。",
            _ if status.is_server_error() => "模型供应商暂时不可用，请稍后重试。",
            _ => "请检查模型供应商的服务状态或配置。",
        };
        return Err(format!(
            "{task}请求失败（HTTP {}）。{reason}",
            status.as_u16()
        ));
    }
    response.json().await.map_err(|error| {
        if error.is_timeout() {
            format!("{task}响应超时，请稍后重试。")
        } else if error.is_decode() {
            format!("{task}接口返回了无效的 JSON。")
        } else {
            format!("{task}响应读取失败，请稍后重试。")
        }
    })
}

#[tauri::command]
pub async fn list_models(
    base_url: String,
    api_key: String,
    transcription: bool,
) -> Result<Value, String> {
    let mut url = endpoint(&base_url, "models")?;
    if transcription {
        url.query_pairs_mut()
            .append_pair("output_modalities", "transcription");
    }
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("请填写 API Key。".into());
    }
    send_json(
        client()?
            .get(url)
            .timeout(Duration::from_secs(30))
            .bearer_auth(api_key),
        "获取模型列表",
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
) -> Result<Value, String> {
    let url = endpoint(&base_url, "audio/transcriptions")?;
    let (api_key, model) = credentials(&api_key, &model)?;
    let audio = checked_audio(&app, Path::new(&path)).await?;
    let metadata = audio
        .metadata()
        .await
        .map_err(|_| "无法读取音频分片信息。")?;

    if !metadata.is_file() || metadata.len() == 0 {
        return Err("音频分片为空或无法读取。".into());
    }
    if metadata.len() > MAX_AUDIO_BYTES {
        return Err("音频分片超过 25 MB，请尝试重新处理视频。".into());
    }

    let part = Part::stream_with_length(audio, metadata.len())
        .file_name("chunk.mp3")
        .mime_str("audio/mpeg")
        .map_err(|_| "无法构造音频转写请求。")?;
    let form = Form::new()
        .text("model", model.to_owned())
        .part("file", part);
    send_json(
        client()?
            .post(url)
            .timeout(Duration::from_secs(90))
            .bearer_auth(api_key)
            .multipart(form),
        "语音转写",
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
}

#[tauri::command]
pub async fn complete_text(
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<Value, String> {
    let url = endpoint(&base_url, "chat/completions")?;
    let (api_key, model) = credentials(&api_key, &model)?;
    let body = ChatRequest { model, messages };
    send_json(
        client()?
            .post(url)
            .timeout(Duration::from_secs(180))
            .bearer_auth(api_key)
            .json(&body),
        "资料整理",
    )
    .await
}
