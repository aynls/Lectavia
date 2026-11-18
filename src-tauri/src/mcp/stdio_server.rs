use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    pin::Pin,
    task::{Context, Poll},
};

use interprocess::local_socket::{
    ListenerOptions,
    tokio::{Listener, Stream, prelude::*},
};
use rmcp::ServiceExt;
use tempfile::{NamedTempFile, TempDir};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

use super::Lectavia;
use crate::mcp_stdio::{registration_path, socket_name};

struct Registration {
    path: PathBuf,
    _lock: File,
    _socket_directory: Option<TempDir>,
}

impl Registration {
    fn bind() -> io::Result<(Self, Listener)> {
        let path = registration_path()?;
        let directory = path
            .parent()
            .expect("stdio registration has a parent directory");
        fs::create_dir_all(directory)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path.with_extension("lock"))?;
        lock.try_lock()?;

        let (endpoint, socket_directory, options) = listener_options()?;
        let listener = options.name(socket_name(&endpoint)?).create_tokio()?;
        let mut registration = NamedTempFile::new_in(directory)?;
        registration.write_all(endpoint.as_bytes())?;
        registration.persist(&path).map_err(|error| error.error)?;
        Ok((
            Self {
                path,
                _lock: lock,
                _socket_directory: socket_directory,
            },
            listener,
        ))
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
fn listener_options() -> io::Result<(String, Option<TempDir>, ListenerOptions<'static>)> {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::Builder::new()
        .prefix("lmcp-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()?;
    let path = directory
        .path()
        .join("stdio")
        .into_os_string()
        .into_string()
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
    Ok((path, Some(directory), ListenerOptions::new()))
}

#[cfg(windows)]
fn listener_options() -> io::Result<(String, Option<TempDir>, ListenerOptions<'static>)> {
    use interprocess::os::windows::{
        local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor,
    };

    let owner_only = SecurityDescriptor::deserialize(widestring::u16cstr!("D:P(A;;GA;;;OW)"))?;
    let endpoint = format!("lectavia-mcp-{}", uuid::Uuid::new_v4());
    Ok((
        endpoint,
        None,
        ListenerOptions::new().security_descriptor(owner_only),
    ))
}

// Disabling stdio must close the pipe even if a client stopped reading responses.
struct Connection(Stream);

impl Drop for Connection {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            let Stream::NamedPipe(pipe) = &self.0;
            pipe.inner().assume_flushed();
        }
    }
}

impl AsyncRead for Connection {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl AsyncWrite for Connection {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

pub(super) struct StdioServer {
    shutdown: CancellationToken,
    task: JoinHandle<()>,
}

impl StdioServer {
    pub fn start(handler: Lectavia) -> io::Result<Self> {
        let (registration, listener) = Registration::bind()?;
        let shutdown = CancellationToken::new();
        let signal = shutdown.clone();
        let task = tokio::spawn(async move {
            let mut clients = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = signal.cancelled() => break,
                    _ = clients.join_next(), if !clients.is_empty() => {},
                    connection = listener.accept() => {
                        let Ok(connection) = connection else { break };
                        let handler = handler.clone();
                        let client_shutdown = signal.child_token();
                        clients.spawn(async move {
                            if let Ok(client) = handler.serve_with_ct(Connection(connection), client_shutdown).await {
                                let _ = client.waiting().await;
                            }
                        });
                    }
                }
            }
            drop(listener);
            signal.cancel();
            while clients.join_next().await.is_some() {}
            drop(registration);
        });
        Ok(Self { shutdown, task })
    }

    pub fn is_running(&self) -> bool {
        !self.task.is_finished()
    }

    pub async fn stop(mut self) {
        self.shutdown.cancel();
        let _ = (&mut self.task).await;
    }
}

impl Drop for StdioServer {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}
