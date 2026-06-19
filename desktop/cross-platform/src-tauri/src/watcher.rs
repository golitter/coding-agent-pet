use crate::aggregator::ActivityAggregator;
use notify::Watcher;
use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tracing::{info, warn};

#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;

/// 对 TCP 绑定地址的尽力而为的 loopback 检查。
///
/// TCP 取代了 Unix socket 的文件权限（0o600）保护，因此这是一个补偿性安全措施：
/// 当某个端点可能接受来自其他主机的连接时发出警告。从 `host:port` /
/// `[ipv6]:port` 形式中解析出主机，并用 [`IpAddr::is_loopback`] 测试。裸主机名
/// 仅当其字面值为 `localhost` 时才被信任——其他任何名称（可能经 hosts/DNS
/// 解析到本机之外）都被视为非 loopback。
fn is_loopback_endpoint(addr: &str) -> bool {
    // SocketAddr::parse 直接覆盖 `127.0.0.1:port` 与 `[::1]:port`。
    if let Ok(socket) = addr.parse::<SocketAddr>() {
        return socket.ip().is_loopback();
    }

    // 对 SocketAddr 拒绝的形式（如不带方括号的裸 `::1:port`）回退到拆分主机/端口，
    // 并将主机作为 IpAddr 测试。
    if let Some((host, _port)) = split_host_port(addr) {
        if let Ok(ip) = host.parse::<IpAddr>() {
            return ip.is_loopback();
        }
        // 主机名：仅信任字面值 localhost。
        return host == "localhost";
    }

    false
}

/// 将 `host:port` / `[host]:port` 拆分为 (host, port)，不做 DNS 解析。
/// 找不到端口分隔符时返回 None。
fn split_host_port(addr: &str) -> Option<(&str, &str)> {
    if let Some(rest) = addr.strip_prefix('[') {
        // `[ipv6]:port`
        let end = rest.find(']')?;
        let host = &rest[..end];
        let after = &rest[end + 1..];
        let port = after.strip_prefix(':')?;
        return Some((host, port));
    }
    // 对普通 `host:port`，按最后一个 ':' 拆分（对裸 IPv6 处理不佳，
    // 但这些已由上面的 SocketAddr::parse 路径覆盖）。
    let idx = addr.rfind(':')?;
    Some((&addr[..idx], &addr[idx + 1..]))
}

#[cfg(unix)]
fn is_replaceable_socket_path(path: &Path) -> Result<bool, std::io::Error> {
    if !path.exists() {
        return Ok(false);
    }

    Ok(std::fs::symlink_metadata(path)?.file_type().is_socket())
}

#[cfg(unix)]
fn ensure_socket_parent_dir(path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    Ok(())
}

pub async fn start_event_server(endpoint: &str, session_mgr: Arc<ActivityAggregator>) {
    if let Some(addr) = endpoint.strip_prefix("tcp://") {
        start_tcp_server(addr, session_mgr).await;
        return;
    }

    #[cfg(unix)]
    {
        start_unix_socket_server(endpoint, session_mgr).await;
    }

    #[cfg(not(unix))]
    {
        let _ = session_mgr;
        warn!(
            "Unix socket endpoint {} is not supported on this platform; use tcp://127.0.0.1:17361",
            endpoint
        );
    }
}

async fn read_payload<R>(mut stream: R, session_mgr: Arc<ActivityAggregator>)
where
    R: AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(8192);
    let mut tmp = [0u8; 4096];
    loop {
        match stream.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => return,
        };
        if buf.len() > 65536 {
            warn!("Event payload too large ({} bytes), dropping", buf.len());
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

    session_mgr.update(&session_id, &state, &dialogue, &event, &source, is_terminal);

    if event == "Stop" || state == "jumping" || state == "waving" {
        let mgr2 = session_mgr.clone();
        let sid = session_id.clone();
        let expected = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            mgr2.remove_if_state(&sid, &expected);
        });
    }
}

fn schedule_oneshot_cleanup_from_paths(
    paths: &[std::path::PathBuf],
    session_mgr: &Arc<ActivityAggregator>,
) {
    for path in paths {
        if path.extension().and_then(|e| e.to_str()) != Some("json") || !path.exists() {
            continue;
        }
        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let data = match std::fs::read_to_string(path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let json: serde_json::Value = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let state = json["state"].as_str().unwrap_or("").to_string();
        if state != "jumping" && state != "waving" {
            continue;
        }
        let mgr = session_mgr.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            mgr.remove_if_state(&session_id, &state);
        });
    }
}

fn dedupe_paths(paths: Vec<std::path::PathBuf>) -> Vec<std::path::PathBuf> {
    let mut seen = HashSet::with_capacity(paths.len());
    let mut deduped = Vec::with_capacity(paths.len());
    for path in paths {
        if seen.insert(path.clone()) {
            deduped.push(path);
        }
    }
    deduped
}

async fn start_tcp_server(addr: &str, session_mgr: Arc<ActivityAggregator>) {
    if !is_loopback_endpoint(addr) {
        warn!(
            "TCP event endpoint {} is not loopback; local event injection protection is reduced",
            addr
        );
    }

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            warn!("Cannot bind TCP event endpoint {}: {}", addr, e);
            return;
        }
    };

    info!("Event TCP listening: {}", addr);

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let mgr = session_mgr.clone();
                tokio::spawn(async move {
                    read_payload(stream, mgr).await;
                });
            }
            Err(e) => warn!("TCP accept error: {}", e),
        }
    }
}

#[cfg(unix)]
pub async fn start_unix_socket_server(socket_path: &str, session_mgr: Arc<ActivityAggregator>) {
    let path = PathBuf::from(socket_path);

    if let Err(err) = ensure_socket_parent_dir(&path) {
        warn!(
            "Cannot create socket parent directory for {}: {}",
            path.display(),
            err
        );
        return;
    }

    if path.exists() {
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

    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
            warn!("Cannot set socket permissions: {}", e);
        }
    }

    info!("Socket listening: {}", path.display());

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let mgr = session_mgr.clone();
                tokio::spawn(async move {
                    read_payload(stream, mgr).await;
                });
            }
            Err(e) => warn!("Socket accept error: {}", e),
        }
    }
}

/// 在会话目录上启动文件系统监视器。
/// 使用 `notify` crate，并在阻塞线程中运行。
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

    let debounce = Duration::from_millis(100);

    while let Ok(event) = rx.recv() {
        let mut changed_paths = match event {
            Ok(ev) => ev.paths,
            Err(_) => Vec::new(),
        };

        while let Ok(next) = rx.try_recv() {
            if let Ok(ev) = next {
                changed_paths.extend(ev.paths);
            }
        }

        loop {
            match rx.recv_timeout(debounce) {
                Ok(next) => {
                    if let Ok(ev) = next {
                        changed_paths.extend(ev.paths);
                    }
                    while let Ok(queued) = rx.try_recv() {
                        if let Ok(ev) = queued {
                            changed_paths.extend(ev.paths);
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }

        let changed_paths = dedupe_paths(changed_paths);

        session_mgr.reconcile_paths(changed_paths.clone());
        schedule_oneshot_cleanup_from_paths(&changed_paths, &session_mgr);
    }
}
