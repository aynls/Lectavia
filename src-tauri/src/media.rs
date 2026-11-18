use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::Duration,
};

use crate::error::AppError;
use reqwest::{Client, Url, header, redirect::Policy};
use serde::Deserialize;
#[cfg(feature = "desktop")]
use serde::Serialize;
use serde_json::Value;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Manager, State};
use tempfile::TempDir;
use tokio::{io::AsyncReadExt, sync::watch};

#[cfg(feature = "desktop")]
use crate::task_runs::TaskRuns;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(feature = "desktop")]
use std::{collections::HashMap, sync::Mutex};

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MediaSource {
    Bilibili { url: String },
    Youtube { url: String },
    Local { path: PathBuf },
}

#[cfg(feature = "desktop")]
#[derive(Serialize)]
pub struct AudioChunks {
    directory: PathBuf,
    files: Vec<PathBuf>,
}

#[cfg(feature = "desktop")]
#[derive(Default)]
pub struct AudioCache(Mutex<HashMap<PathBuf, TempDir>>);

#[cfg(feature = "desktop")]
impl AudioCache {
    pub fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

pub struct PreparedAudio {
    scratch: TempDir,
    pub files: Vec<PathBuf>,
}

impl PreparedAudio {
    pub fn cleanup(self) {
        let _ = self.scratch.close();
    }
}

pub struct MediaTools {
    resource_dir: Option<PathBuf>,
    local_data_dir: Option<PathBuf>,
    require_bundled: bool,
}

impl MediaTools {
    pub fn cli() -> Self {
        Self {
            resource_dir: env::current_exe().ok().and_then(|path| {
                let directory = path.parent()?;
                #[cfg(target_os = "macos")]
                if directory.ends_with("Contents/MacOS") {
                    return Some(directory.with_file_name("Resources"));
                }
                #[cfg(target_os = "linux")]
                if directory.ends_with("usr/bin") {
                    return Some(directory.with_file_name("lib").join("Lectavia"));
                }
                Some(directory.to_path_buf())
            }),
            local_data_dir: None,
            require_bundled: false,
        }
    }

    #[cfg(feature = "desktop")]
    fn desktop(app: &AppHandle) -> Self {
        Self {
            resource_dir: app.path().resource_dir().ok(),
            local_data_dir: app.path().app_local_data_dir().ok(),
            require_bundled: !cfg!(debug_assertions) && !tauri::is_dev(),
        }
    }
}

fn host_is(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

pub fn remote_source(input: &str) -> Result<MediaSource, AppError> {
    let url = Url::parse(input).map_err(|_| "error.malformedVideoUrl")?;
    let host = url.host_str().unwrap_or_default();
    let youtube = host_is(host, "youtube.com") || host == "youtu.be";
    let url = platform_url(input, youtube)?.to_string();
    Ok(if youtube {
        MediaSource::Youtube { url }
    } else {
        MediaSource::Bilibili { url }
    })
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

fn tool_filename(program: &str) -> String {
    format!("{program}{}", env::consts::EXE_SUFFIX)
}

fn find_tool(tools: &MediaTools, program: &str) -> Option<PathBuf> {
    let filename = tool_filename(program);
    let mut directories = Vec::new();
    if let Some(directory) = env::var_os("LECTAVIA_MEDIA_DIR") {
        directories.push(PathBuf::from(directory));
    }
    if let Some(directory) = &tools.local_data_dir {
        directories.push(directory.join("media-tools"));
    }
    if let Some(directory) = &tools.resource_dir {
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

fn require_tool(tools: &MediaTools, program: &str) -> Result<PathBuf, AppError> {
    find_tool(tools, program)
        .ok_or_else(|| AppError::from("error.missingTool").with("program", program))
}

fn require_ffmpeg(tools: &MediaTools) -> Result<PathBuf, AppError> {
    if let Some(resources) = &tools.resource_dir {
        let directory = resources.join("media-tools/ffmpeg/dist/bin");
        let ffmpeg = directory.join(tool_filename("ffmpeg"));
        if ffmpeg.is_file() && directory.join(tool_filename("ffprobe")).is_file() {
            return Ok(ffmpeg);
        }
    }
    if tools.require_bundled {
        return Err("error.missingBundledFfmpeg".into());
    }

    require_tool(tools, "ffmpeg")
}

async fn process_output(
    mut command: Command,
    failure: &'static str,
    cancellation: Option<&mut watch::Receiver<()>>,
) -> Result<Output, AppError> {
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    command.stdin(std::process::Stdio::null());
    let output = if let Some(cancellation) = cancellation {
        if cancellation.has_changed().is_err() {
            return Err("error.taskCancelled".into());
        }
        let mut child = tokio::process::Command::from(command)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| AppError::detail(failure, error))?;
        let mut stderr = child.stderr.take().unwrap();
        let mut diagnostics = Vec::new();
        let result = tokio::select! {
            biased;
            _ = cancellation.changed() => {
                let _ = child.kill().await;
                return Err("error.taskCancelled".into());
            }
            result = async { tokio::try_join!(child.wait(), stderr.read_to_end(&mut diagnostics)) } => result,
        };
        let (status, _) = result.map_err(|error| AppError::detail(failure, error))?;
        Output {
            status,
            stdout: Vec::new(),
            stderr: diagnostics,
        }
    } else {
        tokio::process::Command::from(command)
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|error| AppError::detail(failure, error))?
    };

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

fn add_js_runtime(command: &mut Command, name: &str, path: &Path) {
    let mut runtime = OsString::from(name);
    runtime.push(":");
    runtime.push(path);
    command.arg("--js-runtimes").arg(runtime);
}

fn online_media_command(tools: &MediaTools, youtube: bool) -> Result<Command, AppError> {
    if let Some(resources) = &tools.resource_dir {
        let directory = resources.join("media-tools/online/dist");
        let python = directory.join(if cfg!(windows) {
            "python/python.exe"
        } else {
            "python/bin/python3.14"
        });
        let yt_dlp = directory.join("yt-dlp.pyz");
        let quickjs = directory.join(tool_filename("qjs"));
        if python.is_file() && yt_dlp.is_file() && (!youtube || quickjs.is_file()) {
            let mut command = Command::new(python);
            command
                .args(["-I", "-B"])
                .arg(yt_dlp)
                .arg("--no-js-runtimes");
            if youtube {
                add_js_runtime(&mut command, "quickjs", &quickjs);
            }
            return Ok(command);
        }
    }
    if tools.require_bundled {
        return Err("error.missingBundledOnlineMedia".into());
    }

    let mut command = Command::new(require_tool(tools, "yt-dlp")?);
    if youtube {
        let runtimes: Vec<_> = ["deno", "node"]
            .into_iter()
            .filter_map(|name| find_tool(tools, name).map(|path| (name, path)))
            .collect();
        if runtimes.is_empty() {
            return Err("error.youtubeRuntime".into());
        }

        command.arg("--no-js-runtimes");
        for (name, path) in runtimes {
            add_js_runtime(&mut command, name, &path);
        }
    }
    Ok(command)
}

fn yt_dlp(tools: &MediaTools, youtube: bool, ffmpeg: Option<&Path>) -> Result<Command, AppError> {
    let mut command = online_media_command(tools, youtube)?;
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

    if let Some(ffmpeg) = ffmpeg {
        command.arg("--ffmpeg-location").arg(ffmpeg);
    }

    Ok(command)
}

pub async fn probe_video(
    tools: &MediaTools,
    url: String,
    youtube: bool,
    flat: bool,
) -> Result<Value, AppError> {
    let url = platform_url(&url, youtube)?;
    let ffmpeg = require_ffmpeg(tools).ok();
    let mut command = yt_dlp(tools, youtube, ffmpeg.as_deref())?;
    command.arg("--dump-single-json");
    if flat {
        command.arg("--flat-playlist");
    } else {
        command.args(["--no-playlist", "--playlist-items", "1"]);
    }
    command.arg("--").arg(url.as_str());
    let output = process_output(command, "error.probe", None).await?;
    serde_json::from_slice(&output.stdout).map_err(|_| "error.invalidVideoMetadata".into())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn probe_remote_video(
    app: AppHandle,
    url: String,
    youtube: bool,
    flat: bool,
) -> Result<Value, AppError> {
    probe_video(&MediaTools::desktop(&app), url, youtube, flat).await
}

fn bilibili_client() -> Result<Client, AppError> {
    Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(12))
        .user_agent("Mozilla/5.0")
        .build()
        .map_err(|error| AppError::detail("error.bilibiliDetails", error))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fetch_bilibili_video(video_id: String) -> Result<Value, AppError> {
    let mut url = Url::parse("https://api.bilibili.com/x/web-interface/view").unwrap();
    let (key, value) = bilibili_id_query(&video_id).ok_or("error.bilibiliId")?;
    url.query_pairs_mut().append_pair(key, value);

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

pub fn bilibili_id_query(video_id: &str) -> Option<(&'static str, &str)> {
    if let Some(id) = video_id.strip_prefix("BV")
        && id.len() == 10
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        Some(("bvid", video_id))
    } else if let Some(id) = video_id.strip_prefix("av")
        && (1..=19).contains(&id.len())
        && id.bytes().all(|byte| byte.is_ascii_digit())
    {
        Some(("aid", id))
    } else {
        None
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
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

#[cfg(feature = "desktop")]
pub fn app_cache_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_cache_dir()
        .map_err(|_| "error.cacheLocation".into())
}

async fn download_audio(
    tools: &MediaTools,
    directory: &Path,
    ffmpeg: &Path,
    url: &str,
    youtube: bool,
    cancellation: Option<&mut watch::Receiver<()>>,
) -> Result<PathBuf, AppError> {
    let url = platform_url(url, youtube)?;
    let mut command = yt_dlp(tools, youtube, Some(ffmpeg))?;
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
        ])
        .arg("--")
        .arg(url.as_str());
    process_output(command, "error.audioDownload", cancellation).await?;
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

pub async fn prepare_audio(
    tools: &MediaTools,
    cache_dir: &Path,
    source: MediaSource,
    mut cancellation: Option<&mut watch::Receiver<()>>,
) -> Result<PreparedAudio, AppError> {
    let ffmpeg = require_ffmpeg(tools)?;
    let root = cache_dir.join("media");
    fs::create_dir_all(root.as_path())
        .map_err(|error| AppError::detail("error.audioCacheCreate", error))?;
    let scratch = tempfile::Builder::new()
        .prefix("audio-")
        .tempdir_in(root)
        .map_err(|error| AppError::detail("error.audioCacheCreate", error))?;
    let directory = scratch.path();
    let (input, remove_input) = match source {
        MediaSource::Bilibili { url } => (
            download_audio(
                tools,
                directory,
                &ffmpeg,
                &url,
                false,
                cancellation.as_deref_mut(),
            )
            .await?,
            true,
        ),
        MediaSource::Youtube { url } => (
            download_audio(
                tools,
                directory,
                &ffmpeg,
                &url,
                true,
                cancellation.as_deref_mut(),
            )
            .await?,
            true,
        ),
        MediaSource::Local { path } => {
            if !path.is_absolute() || !path.is_file() {
                return Err("error.localVideoMissing".into());
            }
            (path, false)
        }
    };

    // Keep chunks below five minutes, including the encoder's frame alignment.
    let mut command = Command::new(&ffmpeg);
    command
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
        ]);
    process_output(command, "error.audioExtract", cancellation).await?;

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

    Ok(PreparedAudio { scratch, files })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn prepare_media_audio(
    app: AppHandle,
    runs: State<'_, TaskRuns>,
    run_id: String,
    source: MediaSource,
) -> Result<AudioChunks, AppError> {
    let mut cancellation = runs.subscribe(&run_id)?;
    let tools = MediaTools::desktop(&app);
    let cache = app_cache_dir(&app)?;
    let audio = prepare_audio(&tools, &cache, source, Some(&mut cancellation)).await?;
    let directory = audio.scratch.path().to_owned();
    app.state::<AudioCache>()
        .0
        .lock()
        .unwrap()
        .insert(directory.clone(), audio.scratch);
    Ok(AudioChunks {
        directory,
        files: audio.files,
    })
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn remove_media_audio(app: AppHandle, directory: PathBuf) -> Result<(), AppError> {
    let root = app_cache_dir(&app)?.join("media");
    if directory.parent() != Some(root.as_path())
        || !directory
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("audio-"))
    {
        return Err("error.audioCleanupRestricted".into());
    }

    let scratch = app
        .state::<AudioCache>()
        .0
        .lock()
        .unwrap()
        .remove(&directory);
    let Some(scratch) = scratch else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || match scratch.close() {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::detail("error.audioCleanup", error)),
    })
    .await
    .map_err(|error| AppError::detail("error.background", error))?
}
