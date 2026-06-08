use crate::session::SessionManager;
use notify::Watcher;
use std::path::Path;
use std::sync::Arc;

/// Start a Unix socket server that receives JSON payloads from hook scripts.
/// Runs as a Tokio async task.
pub async fn start_socket_server(socket_path: &str, session_mgr: Arc<SessionManager>) {
    let path = socket_path.to_string();

    // Clean up stale socket
    let _ = std::fs::remove_file(&path);

    let listener = match tokio::net::UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[Watcher] ⚠️ Cannot bind socket {}: {}", path, e);
            return;
        }
    };

    println!("[Watcher] ✓ Socket listening: {}", path);

    loop {
        match listener.accept().await {
            Ok((mut stream, _)) => {
                let mgr = session_mgr.clone();
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    let mut buf = vec![0u8; 4096];
                    let n = match stream.read(&mut buf).await {
                        Ok(n) if n > 0 => n,
                        _ => return,
                    };

                    let data = &buf[..n];
                    let json: serde_json::Value = match serde_json::from_slice(data) {
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
                eprintln!("[Watcher] ⚠️ Accept error: {}", e);
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
            eprintln!(
                "[Watcher] ⚠️ Cannot create file watcher: {}",
                e
            );
            return;
        }
    };

    if let Err(e) = watcher.watch(Path::new(&dir), notify::RecursiveMode::Recursive) {
        eprintln!(
            "[Watcher] ⚠️ Cannot watch directory {}: {}",
            dir, e
        );
        return;
    }

    println!("[Watcher] ✓ Watching directory: {}", dir);

    // Process events — just trigger load_from_disk on any change
    loop {
        match rx.recv() {
            Ok(_event) => {
                session_mgr.load_from_disk();
            }
            Err(_) => break,
        }
    }
}
