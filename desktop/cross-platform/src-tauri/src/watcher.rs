use crate::session::SessionManager;
use notify::Watcher;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{info, warn};

/// Start a Unix socket server that receives JSON payloads from hook scripts.
/// Runs as a Tokio async task.
pub async fn start_socket_server(socket_path: &str, session_mgr: Arc<SessionManager>) {
    let path = socket_path.to_string();

    // Clean up stale socket
    let _ = std::fs::remove_file(&path);

    let listener = match tokio::net::UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            warn!("Cannot bind socket {}: {}", path, e);
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

    info!("Socket listening: {}", path);

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

                    mgr.update(&session_id, &state, &dialogue, &source, is_terminal);
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
pub fn start_file_watcher(sessions_dir: &str, session_mgr: Arc<SessionManager>) {
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

    // Process events with debounce: coalesce rapid fs events (100ms window)
    // so that multiple file changes in quick succession only trigger one reload.
    let debounce = Duration::from_millis(100);
    let mut last_reload = Instant::now() - debounce; // allow first event immediately

    loop {
        match rx.recv() {
            Ok(_event) => {
                // Drain any queued events first
                while rx.try_recv().is_ok() {}

                let now = Instant::now();
                if now.duration_since(last_reload) >= debounce {
                    session_mgr.load_from_disk();
                    last_reload = now;
                }
                // else: within debounce window, skip — the next event will pick it up
            }
            Err(_) => break,
        }
    }
}
