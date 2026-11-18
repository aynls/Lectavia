use std::{fmt::Display, future::Future, path::Path, time::Duration};

use ashpd::{desktop::open_uri::OpenDirectoryRequest, zbus};
use serde_json::{Value, json};
use tokio::time::timeout;

use crate::error::AppError;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

async fn attempt<Error: Display>(
    request: impl Future<Output = Result<(), Error>>,
) -> Result<(), Value> {
    match timeout(REQUEST_TIMEOUT, request).await {
        Ok(result) => result.map_err(|error| Value::String(error.to_string())),
        Err(_) => Err(json!({
            "key": "error.desktopServiceTimeout",
            "values": { "seconds": REQUEST_TIMEOUT.as_secs() }
        })),
    }
}

async fn show_item(uri: &str) -> zbus::Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some("org.freedesktop.FileManager1"),
            "/org/freedesktop/FileManager1",
            Some("org.freedesktop.FileManager1"),
            "ShowItems",
            &([uri].as_slice(), ""),
        )
        .await?;
    Ok(())
}

async fn reveal_with_portal(target: &Path) -> ashpd::Result<()> {
    let file = tokio::fs::File::open(target).await?;
    let connection = zbus::Connection::session().await?;
    OpenDirectoryRequest::default()
        .connection(Some(connection))
        .send(&file)
        .await?
        .response()
}

pub(super) async fn reveal_file(target: &Path) -> Result<(), AppError> {
    let uri = tauri::Url::from_file_path(target).map_err(|_| "error.outputGone")?;
    match attempt(show_item(uri.as_str())).await {
        Ok(()) => Ok(()),
        Err(primary) => attempt(reveal_with_portal(target))
            .await
            .map_err(|fallback| {
                AppError::from("error.outputRevealLinux")
                    .with("primary", primary)
                    .with("fallback", fallback)
            }),
    }
}
