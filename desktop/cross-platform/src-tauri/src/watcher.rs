use crate::aggregator::ActivityAggregator;
use notify::Watcher;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;

#[cfg(unix)]
fn is_replaceable_socket_path(path: &Path) -> Result<bool, std::io::Error> {
    if !path.exists() {
        return Ok(false);
    }

    Ok(std::fs::symlink_metadata(path)?.file_type().is_socket())
}

fn ensure_socket_parent_dir(path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    Ok(())
}

/// Start a Unix socket server that receives JSON payloads from hook scripts.
/// Runs as a Tokio async task.
pub async fn start_socket_server(socket_path: &str, session_mgr: Arc<ActivityAggregator>) {
    let path = PathBuf::from(socket_path);

    if let Err(err) = ensure_socket_parent_dir(&path) {
        warn!(
            "Cannot create socket parent directory for {}: {}",
            path.display(),
            err
        );
        return;
    }

    // Clean up stale socket — connect first to avoid TOCTOU symlink attacks.
    // If the socket is live (another instance running), exit instead of clobbering it.
    // Only remove the file when we confirm it's a dead socket (connect fails).
    if path.exists() {
        #[cfg(unix)]
        match is_replaceable_socket_path(&path) {
            Ok(true) => {}
            Ok(false) => {
                warn!(
                    "Socket path {} already exists and is not a Unix socket; refusing to replace it",
                    path.display()
                );
                return;
            }
            Err(err) => {
                warn!("Cannot inspect socket path {}: {}", path.display(), err);
                return;
            }
        }

        match tokio::net::UnixStream::connect(&path).await {
            Ok(_) => {
                warn!("Socket {} is in use by another instance", path.display());
                return;
            }
            Err(_) => {
                // Stale socket file — safe to remove
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    let listener = match tokio::net::UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            warn!("Cannot bind socket {}: {}", path.display(), e);
            return;
        }
    };

    // Restrict socket file permissions to owner-only (prevent other users from injecting events)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
            warn!("Cannot set socket permissions: {}", e);
        }
    }

    info!("Socket listening: {}", path.display());

    loop {
        match listener.accept().await {
            Ok((mut stream, _)) => {
                let mgr = session_mgr.clone();
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    // Read the full payload in a growing buffer until EOF.
                    // Hook scripts open a connection, write one JSON blob, then close.
                    let mut buf = Vec::with_capacity(8192);
                    let mut tmp = [0u8; 4096];
                    loop {
                        match stream.read(&mut tmp).await {
                            Ok(0) => break,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                            Err(_) => return,
                        };
                        // Safety cap: reject payloads larger than 64 KB
                        if buf.len() > 65536 {
                            warn!("Socket payload too large ({} bytes), dropping", buf.len());
                            return;
                        }
                    }

                    let json: serde_json::Value = match serde_json::from_slice(&buf) {
                        Ok(v) => v,
                        Err(_) => return,
                    };

                    let session_id = json["session_id"].as_str().unwrap_or("unknown").to_string();
                    let state = json["state"].as_str().unwrap_or("idle").to_string();
                    let dialogue = json["dialogue"].as_str().unwrap_or("").to_string();
                    let source = json["source"].as_str().unwrap_or("").to_string();
                    let is_terminal = json["isTerminal"].as_bool().unwrap_or(false);
                    let event = json["event"].as_str().unwrap_or("").to_string();

                    mgr.update(&session_id, &state, &dialogue, &source, is_terminal);

                    // Stop → schedule a delayed removal in the backend. The hook
                    // script is short-lived and cannot reliably run a timer (a
                    // threading.Timer there is killed when the process exits),
                    // so we do it here. The 2s delay lets the "搞定啦" celebration
                    // show; remove_if_state cancels the removal if a new turn
                    // (state no longer "jumping") started within the window.
                    if event == "Stop" {
                        let mgr2 = mgr.clone();
                        let sid = session_id.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            mgr2.remove_if_state(&sid, "jumping");
                        });
                    }
                });
            }
            Err(e) => {
                warn!("Socket accept error: {}", e);
            }
        }
    }
}

/// Start a file system watcher on the sessions directory.
/// Uses the `notify` crate and runs in a blocking thread.
pub fn start_file_watcher(sessions_dir: &str, session_mgr: Arc<ActivityAggregator>) {
    let dir = sessions_dir.to_string();

    let (tx, rx) = std::sync::mpsc::channel();

    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(e) => {
            warn!("Cannot create file watcher: {}", e);
            return;
        }
    };

    if let Err(e) = watcher.watch(Path::new(&dir), notify::RecursiveMode::Recursive) {
        warn!("Cannot watch directory {}: {}", dir, e);
        return;
    }

    info!("Watching directory: {}", dir);

    // Debounce: coalesce a burst of filesystem events into exactly one
    // reconcile after activity settles. Unlike the previous "skip events inside
    // the window" scheme, this never drops the trailing event of a burst — it
    // waits for `debounce` of silence, then reconciles once.
    let debounce = Duration::from_millis(100);

    while let Ok(_event) = rx.recv() {
        // Drain any events already queued from the same burst.
        while rx.try_recv().is_ok() {}

        // Extend the quiet window on each new event; only reconcile after the
        // channel falls silent for the full debounce interval.
        loop {
            match rx.recv_timeout(debounce) {
                Ok(_) => while rx.try_recv().is_ok() {},
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }

        // Incremental reconciliation — backfills socket misses, prunes residue
        // (terminal files + elapsed one-shots), never overwrites socket-fresh
        // state. Contrast `load_from_disk` (the startup full reload).
        session_mgr.reconcile_with_disk();
    }
}
