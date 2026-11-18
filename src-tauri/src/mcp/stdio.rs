use std::{fs, io, path::PathBuf, process::ExitCode, time::Duration};

#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use interprocess::local_socket::{
    Name,
    tokio::{Stream, prelude::*},
};
use rmcp::transport::stdio_pipes;

use crate::{error::AppError, locale::Locale, settings::APP_IDENTIFIER};

pub(crate) fn registration_path() -> io::Result<PathBuf> {
    dirs::config_dir()
        .map(|dir| dir.join(APP_IDENTIFIER).join("mcp-stdio-endpoint"))
        .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
}

pub(crate) fn socket_name(endpoint: &str) -> io::Result<Name<'_>> {
    #[cfg(unix)]
    return endpoint.to_fs_name::<GenericFilePath>();
    #[cfg(windows)]
    return endpoint.to_ns_name::<GenericNamespaced>();
}

async fn relay() -> Result<(), AppError> {
    let connect = async {
        let endpoint = fs::read_to_string(registration_path()?)?;
        Stream::connect(socket_name(&endpoint)?).await
    };
    let stream = tokio::time::timeout(Duration::from_secs(3), connect)
        .await
        .map_err(|error| AppError::detail("mcp.settings.stdioUnavailable", error))?
        .map_err(|error| AppError::detail("mcp.settings.stdioUnavailable", error))?;

    let (mut input, mut output) = stdio_pipes();
    let (mut reader, mut writer) = tokio::io::split(stream);
    tokio::select! {
        result = tokio::io::copy(&mut reader, &mut output) => result,
        result = tokio::io::copy(&mut input, &mut writer) => result,
    }
    .map(|_| ())
    .map_err(|error| AppError::detail("mcp.settings.stdioDisconnected", error))
}

pub fn run() -> ExitCode {
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| AppError::detail("mcp.settings.stdioUnavailable", error))
        .and_then(|runtime| {
            let result = runtime.block_on(relay());
            // A pending read of the client's stdin can outlive the desktop connection.
            runtime.shutdown_background();
            result
        });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("lectavia-mcp: {}", Locale::En.error(&error));
            ExitCode::FAILURE
        }
    }
}
