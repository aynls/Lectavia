use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

use axum::{
    Router,
    extract::Request,
    http::StatusCode,
    middleware::{self, Next},
    response::IntoResponse,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager,
    tower::{StreamableHttpServerConfig, StreamableHttpService},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{App, AppHandle, Manager, State, async_runtime};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::{
    net::TcpListener,
    sync::{Mutex, OnceCell},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use super::{Jobs, Lectavia, stdio_server::StdioServer};
use crate::{error::AppError, media::MediaTools};

const HOST: &str = "127.0.0.1";
const MCP_PATH: &str = "/mcp";

#[derive(Clone, Deserialize, Serialize)]
struct Preferences {
    port: u16,
    auto_start: bool,
    #[serde(default)]
    stdio_enabled: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            port: 8765,
            auto_start: false,
            stdio_enabled: false,
        }
    }
}

fn load_preferences(path: &Path) -> Result<Preferences, AppError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Preferences::default()),
        Err(error) => return Err(AppError::detail("mcp.settings.loadFailed", error)),
    };
    let preferences: Preferences = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::detail("mcp.settings.loadFailed", error))?;
    if preferences.port == 0 {
        return Err("mcp.settings.invalidPort".into());
    }
    Ok(preferences)
}

fn save_preferences(path: &Path, preferences: &Preferences) -> Result<(), AppError> {
    let directory = path.parent().expect("settings file has a parent directory");
    fs::create_dir_all(directory)
        .map_err(|error| AppError::detail("mcp.settings.saveFailed", error))?;
    let file = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| AppError::detail("mcp.settings.saveFailed", error))?;
    serde_json::to_writer(file.as_file(), preferences)
        .map_err(|error| AppError::detail("mcp.settings.saveFailed", error))?;
    file.persist(path)
        .map_err(|error| AppError::detail("mcp.settings.saveFailed", error.error))?;
    Ok(())
}

struct Server {
    shutdown: CancellationToken,
    task: JoinHandle<()>,
}

impl Server {
    fn start(listener: TcpListener, handler: Lectavia) -> Self {
        let config = StreamableHttpServerConfig::default().enforce_origin_validation();
        let shutdown = config.cancellation_token.clone();
        let service = StreamableHttpService::new(
            move || Ok(handler.clone()),
            LocalSessionManager::default().into(),
            config,
        );

        let request_shutdown = shutdown.clone();
        let router = Router::new()
            .route_service(MCP_PATH, service)
            .layer(middleware::from_fn(move |request: Request, next: Next| {
                let shutdown = request_shutdown.clone();
                async move {
                    tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => StatusCode::SERVICE_UNAVAILABLE.into_response(),
                        response = next.run(request) => response,
                    }
                }
            }));
        let signal = shutdown.clone();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(signal.cancelled_owned())
                .await;
        });
        Self { shutdown, task }
    }

    async fn stop(mut self) {
        self.shutdown.cancel();
        if tokio::time::timeout(Duration::from_secs(1), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
            let _ = (&mut self.task).await;
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

struct Runtime {
    path: PathBuf,
    preferences: Preferences,
    server: Option<Server>,
    start_error: Option<AppError>,
    stdio: Option<StdioServer>,
    stdio_error: Option<AppError>,
    jobs: Option<Jobs>,
}

impl Runtime {
    fn endpoint(&self) -> String {
        format!("http://{HOST}:{}{MCP_PATH}", self.preferences.port)
    }

    fn persist(&mut self, preferences: Preferences) -> Result<(), AppError> {
        save_preferences(&self.path, &preferences)?;
        self.preferences = preferences;
        Ok(())
    }

    fn handler(&mut self, app: &AppHandle) -> io::Result<Lectavia> {
        if self.jobs.is_none() {
            self.jobs = Some(Jobs::new(MediaTools::desktop(app))?);
        }
        Ok(Lectavia {
            jobs: self.jobs.as_ref().expect("MCP jobs initialized").clone(),
        })
    }

    async fn start(&mut self, app: &AppHandle) -> Result<(), AppError> {
        let port = self.preferences.port;
        let listener = TcpListener::bind((HOST, port)).await.map_err(|error| {
            if error.kind() == io::ErrorKind::AddrInUse {
                AppError::from("mcp.settings.portInUse").with("port", port)
            } else {
                AppError::detail("mcp.settings.startFailed", error)
            }
        })?;
        let handler = self
            .handler(app)
            .map_err(|error| AppError::detail("mcp.settings.startFailed", error))?;
        self.server = Some(Server::start(listener, handler));
        Ok(())
    }

    fn start_stdio(&mut self, app: &AppHandle) -> Result<(), AppError> {
        let server = self
            .handler(app)
            .and_then(StdioServer::start)
            .map_err(|error| AppError::detail("mcp.settings.stdioStartFailed", error))?;
        self.stdio = Some(server);
        Ok(())
    }

    async fn stop_http(&mut self) {
        if let Some(server) = self.server.take() {
            server.stop().await;
        }
    }

    async fn stop_stdio(&mut self) {
        if let Some(server) = self.stdio.take() {
            server.stop().await;
        }
    }

    async fn clear_idle_jobs(&mut self) {
        if self.server.is_none()
            && self.stdio.is_none()
            && let Some(jobs) = self.jobs.take()
        {
            jobs.finish_shutdown().await;
        }
    }

    fn status(&self) -> McpStatus {
        McpStatus {
            port: self.preferences.port,
            endpoint: self.endpoint(),
            auto_start: self.preferences.auto_start,
            running: self.server.is_some(),
            start_error: self.start_error.clone(),
            stdio_enabled: self.preferences.stdio_enabled,
            stdio_running: self.stdio.as_ref().is_some_and(StdioServer::is_running),
            stdio_error: self.stdio_error.clone(),
        }
    }
}

#[derive(Default)]
pub(crate) struct McpState(OnceCell<Mutex<Runtime>>);

impl McpState {
    async fn runtime(&self, app: &AppHandle) -> Result<&Mutex<Runtime>, AppError> {
        self.0
            .get_or_try_init(|| async {
                let path = app
                    .path()
                    .app_config_dir()
                    .map_err(|error| AppError::detail("mcp.settings.loadFailed", error))?
                    .join("mcp-settings.json");
                let preferences = load_preferences(&path)?;
                let mut runtime = Runtime {
                    path,
                    preferences,
                    server: None,
                    start_error: None,
                    stdio: None,
                    stdio_error: None,
                    jobs: None,
                };
                if runtime.preferences.auto_start {
                    runtime.start_error = runtime.start(app).await.err();
                }
                if runtime.preferences.stdio_enabled {
                    runtime.stdio_error = runtime.start_stdio(app).err();
                    runtime.clear_idle_jobs().await;
                }
                Ok(Mutex::new(runtime))
            })
            .await
    }
}

pub(crate) fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let app = app.handle().clone();
    async_runtime::spawn(async move {
        let _ = app.state::<McpState>().runtime(&app).await;
    });
    Ok(())
}

pub(crate) fn shutdown(app: &AppHandle) {
    if let Some(runtime) = app.state::<McpState>().0.get() {
        async_runtime::block_on(async {
            let mut runtime = runtime.lock().await;
            runtime.stop_stdio().await;
            runtime.stop_http().await;
            runtime.clear_idle_jobs().await;
        });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpStatus {
    port: u16,
    endpoint: String,
    auto_start: bool,
    running: bool,
    start_error: Option<AppError>,
    stdio_enabled: bool,
    stdio_running: bool,
    stdio_error: Option<AppError>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum McpUpdate {
    SetRunning { running: bool },
    SetStdio { enabled: bool },
    SetAutoStart { enabled: bool },
    SetPort { port: u16 },
}

#[tauri::command]
pub(crate) async fn get_mcp_status(
    app: AppHandle,
    state: State<'_, McpState>,
) -> Result<McpStatus, AppError> {
    Ok(state.runtime(&app).await?.lock().await.status())
}

#[tauri::command]
pub(crate) async fn update_mcp(
    app: AppHandle,
    state: State<'_, McpState>,
    update: McpUpdate,
) -> Result<McpStatus, AppError> {
    let mut runtime = state.runtime(&app).await?.lock().await;
    match update {
        McpUpdate::SetRunning { running } => {
            if !running {
                runtime.stop_http().await;
                runtime.start_error = None;
            } else if runtime.server.is_none() {
                runtime.start_error = runtime.start(&app).await.err();
            }
        }
        McpUpdate::SetStdio { enabled } => {
            let mut preferences = runtime.preferences.clone();
            preferences.stdio_enabled = enabled;
            runtime.persist(preferences)?;
            if !enabled {
                runtime.stop_stdio().await;
                runtime.stdio_error = None;
            } else if !runtime.stdio.as_ref().is_some_and(StdioServer::is_running) {
                runtime.stop_stdio().await;
                runtime.stdio_error = runtime.start_stdio(&app).err();
            }
        }
        McpUpdate::SetAutoStart { enabled } => {
            let mut preferences = runtime.preferences.clone();
            preferences.auto_start = enabled;
            runtime.persist(preferences)?;
        }
        McpUpdate::SetPort { port } => {
            if runtime.server.is_some() {
                return Err("mcp.settings.portLocked".into());
            }
            if port == 0 {
                return Err("mcp.settings.invalidPort".into());
            }
            let mut preferences = runtime.preferences.clone();
            preferences.port = port;
            runtime.persist(preferences)?;
            runtime.start_error = None;
        }
    }
    runtime.clear_idle_jobs().await;
    Ok(runtime.status())
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConfigTransport {
    Http,
    Stdio,
}

#[tauri::command]
pub(crate) async fn copy_mcp_config(
    app: AppHandle,
    state: State<'_, McpState>,
    transport: ConfigTransport,
) -> Result<(), AppError> {
    let servers = match transport {
        ConfigTransport::Http => {
            let runtime = state.runtime(&app).await?.lock().await;
            json!({
                "lectavia": {
                    "type": "http",
                    "url": runtime.endpoint(),
                }
            })
        }
        ConfigTransport::Stdio => {
            let (command, args) = stdio_command()
                .map_err(|error| AppError::detail("mcp.settings.copyFailed", error))?;
            json!({ "lectavia-stdio": { "type": "stdio", "command": command, "args": args } })
        }
    };
    let config = json!({ "mcpServers": servers });
    let text = serde_json::to_string_pretty(&config).expect("MCP configuration is serializable");
    app.clipboard()
        .write_text(text)
        .map_err(|error| AppError::detail("mcp.settings.copyFailed", error))
}

fn stdio_command() -> io::Result<(PathBuf, Vec<&'static str>)> {
    #[cfg(target_os = "linux")]
    if let Some(image) = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Ok((image, vec!["--mcp-stdio"]));
    }

    let executable = std::env::current_exe()?;
    let helper = executable.with_file_name(if cfg!(windows) {
        "lectavia-mcp.exe"
    } else {
        "lectavia-mcp"
    });
    if helper.is_file() {
        Ok((helper, Vec::new()))
    } else {
        Ok((executable, vec!["--mcp-stdio"]))
    }
}
