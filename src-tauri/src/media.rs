use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::Duration,
};

use crate::error::AppError;
use reqwest::{Client, Url, header, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MediaSource {
    Bilibili { url: String },
    Youtube { url: String },
    Local { path: PathBuf },
}

#[derive(Serialize)]
pub struct AudioChunks {
    directory: PathBuf,
    files: Vec<PathBuf>,
}

fn host_is(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn platform_url(input: &str, youtube: bool) -> Result<Url, AppError> {
    let url = Url::parse(input).map_err(|_| "error.malformedVideoUrl")?;
    let host = url.host_str().unwrap_or_default();
    let known_host = if youtube {
        host_is(host, "youtube.com") || host == "youtu.be"
    } else {
        host_is(host, "bilibili.com") || host == "b23.tv"
    };

    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !known_host
    {
        return Err("error.unsupportedVideoUrl".into());
    }

    Ok(url)
}

fn find_tool(app: &AppHandle, program: &str) -> Option<PathBuf> {
    let filename = if cfg!(windows) {
        format!("{program}.exe")
    } else {
        program.to_string()
    };
    let mut directories = Vec::new();
    if let Some(directory) = env::var_os("LECTAVIA_MEDIA_DIR") {
        directories.push(PathBuf::from(directory));
    }
    if let Ok(directory) = app.path().app_local_data_dir() {
        directories.push(directory.join("media-tools"));
    }
    if let Ok(directory) = app.path().resource_dir() {
        directories.push(directory.join("media-tools"));
    }
    if let Some(path) = env::var_os("PATH") {
        directories.extend(env::split_paths(&path).filter(|path| path.is_absolute()));
    }

    directories
        .into_iter()
        .filter(|path| path.is_absolute())
        .map(|path| path.join(&filename))
        .find(|path| path.is_file())
}

fn require_tool(app: &AppHandle, program: &str) -> Result<PathBuf, AppError> {
    find_tool(app, program)
        .ok_or_else(|| AppError::from("error.missingTool").with("program", program))
}

fn process_output(command: &mut Command, failure: &'static str) -> Result<Output, AppError> {
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = command
        .output()
        .map_err(|error| AppError::detail(failure, error))?;
    if output.status.success() {
        return Ok(output);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail: String = stderr
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .chars()
        .take(420)
        .collect();
    if detail.is_empty() {
        Err(AppError::detail(failure, output.status))
    } else {
        Err(AppError::detail(failure, detail))
    }
}

fn yt_dlp(app: &AppHandle, youtube: bool) -> Result<Command, AppError> {
    let mut command = Command::new(require_tool(app, "yt-dlp")?);
    command.args([
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-cache-dir",
        "--encoding",
        "UTF-8",
        "--socket-timeout",
        "15",
        "--retries",
        "1",
        "--extractor-retries",
        "1",
    ]);

    if youtube {
        let runtimes: Vec<_> = ["deno", "node"]
            .into_iter()
            .filter_map(|name| find_tool(app, name).map(|path| (name, path)))
            .collect();
        if runtimes.is_empty() {
            return Err("error.youtubeRuntime".into());
        }

        command.arg("--no-js-runtimes");
        for (name, path) in runtimes {
            command
                .arg("--js-runtimes")
                .arg(format!("{name}:{}", path.display()));
        }
    }
    Ok(command)
}

#[tauri::command]
pub async fn probe_remote_video(
    app: AppHandle,
    url: String,
    youtube: bool,
    flat: bool,
) -> Result<Value, AppError> {
    let url = platform_url(&url, youtube)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = yt_dlp(&app, youtube)?;
        command.arg("--dump-single-json");
        if flat {
            command.arg("--flat-playlist");
        } else {
            command.args(["--no-playlist", "--playlist-items", "1"]);
        }
        command.arg("--").arg(url.as_str());
        let output = process_output(&mut command, "error.probe")?;
        serde_json::from_slice(&output.stdout).map_err(|_| "error.invalidVideoMetadata".into())
    })
    .await
    .map_err(|error| AppError::detail("error.background", error))?
}

fn bilibili_client() -> Result<Client, AppError> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(12))
        .user_agent("Mozilla/5.0")
        .build()
        .map_err(|error| AppError::detail("error.bilibiliDetails", error))
}

#[tauri::command]
pub async fn fetch_bilibili_video(video_id: String) -> Result<Value, AppError> {
    let mut url = Url::parse("https://api.bilibili.com/x/web-interface/view").unwrap();
    let query = if let Some(id) = video_id.strip_prefix("BV") {
        if id.len() != 10 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
            return Err("error.bilibiliId".into());
        }
        ("bvid", video_id.as_str())
    } else if let Some(id) = video_id.strip_prefix("av") {
        if id.is_empty() || id.len() > 19 || !id.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err("error.bilibiliId".into());
        }
        ("aid", id)
    } else {
        return Err("error.bilibiliId".into());
    };
    url.query_pairs_mut().append_pair(query.0, query.1);

    bilibili_client()?
        .get(url)
        .header(header::REFERER, "https://www.bilibili.com/")
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| AppError::detail("error.bilibiliDetails", error))?
        .json()
        .await
        .map_err(|error| AppError::detail("error.bilibiliDetails", error))
}

#[tauri::command]
pub async fn resolve_bilibili_short_link(url: String) -> Result<String, AppError> {
    let url = platform_url(&url, false)?;
    if url.host_str() != Some("b23.tv") {
        return Err("error.bilibiliShortRequired".into());
    }
    let response = bilibili_client()?
        .get(url.clone())
        .send()
        .await
        .map_err(|error| AppError::detail("error.bilibiliResolve", error))?;
    let location = response
        .headers()
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "error.bilibiliShortMissing")?;
    let resolved = url
        .join(location)
        .map_err(|error| AppError::detail("error.bilibiliResolve", error))?;
    platform_url(resolved.as_str(), false).map(|url| url.to_string())
}

fn media_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("media"))
        .map_err(|_| "error.cacheLocation".into())
}

fn download_audio(
    app: &AppHandle,
    directory: &Path,
    ffmpeg: &Path,
    url: &str,
    youtube: bool,
) -> Result<PathBuf, AppError> {
    let url = platform_url(url, youtube)?;
    let mut command = yt_dlp(app, youtube)?;
    if youtube {
        command.arg("--check-formats");
    }
    command
        .current_dir(directory)
        .args([
            "--no-playlist",
            "--playlist-items",
            "1",
            "--no-progress",
            "--format",
            "bestaudio/best",
            "--output",
            "source.%(ext)s",
            "--ffmpeg-location",
        ])
        .arg(ffmpeg)
        .arg("--")
        .arg(url.as_str());
    process_output(&mut command, "error.audioDownload")?;
    list_files(directory)?
        .into_iter()
        .find(|path| path.file_stem().is_some_and(|stem| stem == "source"))
        .ok_or_else(|| "error.noDownloadedAudio".into())
}

fn list_files(directory: &Path) -> Result<Vec<PathBuf>, AppError> {
    fs::read_dir(directory)
        .and_then(|entries| {
            entries
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| AppError::detail("error.audioCacheRead", error))
}

fn prepare_audio(app: &AppHandle, source: MediaSource) -> Result<AudioChunks, AppError> {
    let ffmpeg = require_tool(app, "ffmpeg")?;
    let root = media_root(app)?;
    fs::create_dir_all(root.as_path())
        .map_err(|error| AppError::detail("error.audioCacheCreate", error))?;
    let scratch = tempfile::Builder::new()
        .prefix("audio-")
        .tempdir_in(root)
        .map_err(|error| AppError::detail("error.audioCacheCreate", error))?;
    let directory = scratch.path();
    let (input, remove_input) = match source {
        MediaSource::Bilibili { url } => {
            (download_audio(app, directory, &ffmpeg, &url, false)?, true)
        }
        MediaSource::Youtube { url } => {
            (download_audio(app, directory, &ffmpeg, &url, true)?, true)
        }
        MediaSource::Local { path } => {
            if !path.is_absolute() || !path.is_file() {
                return Err("error.localVideoMissing".into());
            }
            (path, false)
        }
    };

    // Keep chunks below five minutes, including the encoder's frame alignment.
    process_output(
        Command::new(&ffmpeg)
            .current_dir(directory)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-protocol_whitelist",
                "file",
                "-i",
            ])
            .arg(&input)
            .args([
                "-map",
                "0:a:0",
                "-vn",
                "-map_metadata",
                "-1",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "libmp3lame",
                "-b:a",
                "64k",
                "-f",
                "segment",
                "-segment_time",
                "240",
                "-reset_timestamps",
                "1",
                "chunk-%06d.mp3",
            ]),
        "error.audioExtract",
    )?;

    if remove_input {
        fs::remove_file(input)
            .map_err(|error| AppError::detail("error.audioSourceCleanup", error))?;
    }

    let mut files: Vec<_> = list_files(directory)?
        .into_iter()
        .filter(|path| path.extension().is_some_and(|extension| extension == "mp3"))
        .collect();
    files.sort();
    if files.is_empty() {
        return Err("error.noAudio".into());
    }

    Ok(AudioChunks {
        directory: scratch.keep(),
        files,
    })
}

#[tauri::command]
pub async fn prepare_media_audio(
    app: AppHandle,
    source: MediaSource,
) -> Result<AudioChunks, AppError> {
    tauri::async_runtime::spawn_blocking(move || prepare_audio(&app, source))
        .await
        .map_err(|error| AppError::detail("error.background", error))?
}

#[tauri::command]
pub async fn remove_media_audio(app: AppHandle, directory: PathBuf) -> Result<(), AppError> {
    let root = media_root(&app)?;
    if directory.parent() != Some(root.as_path())
        || !directory
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("audio-"))
    {
        return Err("error.audioCleanupRestricted".into());
    }

    tauri::async_runtime::spawn_blocking(move || match fs::remove_dir_all(directory) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::detail("error.audioCleanup", error)),
    })
    .await
    .map_err(|error| AppError::detail("error.background", error))?
}
