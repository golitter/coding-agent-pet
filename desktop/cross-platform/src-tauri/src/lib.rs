// Suppress unexpected_cfgs warnings from the `objc` crate's msg_send! macro.
// See: https://github.com/rust-lang/rust/issues/123797
#![allow(unexpected_cfgs)]

mod aggregator;
mod commands;
mod config;
mod watcher;

use aggregator::ActivityAggregator;
use config::PetConfig;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tracing::{info, warn};

/// macOS: Force NSWindow and WKWebView to transparent via objc.
#[cfg(target_os = "macos")]
fn make_window_transparent(window: &tauri::WebviewWindow) {
    use objc::runtime::{Class, Object, NO};
    use objc::{msg_send, sel, sel_impl};

    if let Ok(ptr) = window.ns_window() {
        unsafe {
            let ns_window: *mut Object = ptr as *mut Object;
            let clear: *mut Object = msg_send![Class::get("NSColor").unwrap(), clearColor];

            // NSWindow transparency
            let _: () = msg_send![ns_window, setOpaque: NO];
            let _: () = msg_send![ns_window, setBackgroundColor: clear];
            let _: () = msg_send![ns_window, setHasShadow: NO];
        }
    }

    // WKWebView transparency via Tauri's with_webview API
    let _ = window.with_webview(|webview| unsafe {
        let wk: *mut Object = webview.inner() as *mut Object;
        if !wk.is_null() {
            let clear: *mut Object = msg_send![Class::get("NSColor").unwrap(), clearColor];
            let _: () = msg_send![wk, setOpaque: NO];
            let _: () = msg_send![wk, setBackgroundColor: clear];
        }
    });
}

/// RAII guard that removes the Unix socket file on Drop.
/// Ensures cleanup on both graceful shutdown and panic.
struct SocketGuard {
    path: String,
}
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing subscriber
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            // 1. Load config
            let config = PetConfig::load();

            // 2. Hide from Dock (macOS accessory mode)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // 2b. Make window truly transparent on macOS
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                make_window_transparent(&window);
            }

            // 3. Ensure sessions directory exists
            std::fs::create_dir_all(&config.sessions_dir).ok();

            // 4. Create activity aggregator (tracks per-agent activity, rolls up to display state)
            let session_mgr = Arc::new(ActivityAggregator::new(
                config.sessions_dir.clone(),
                config.stale_timeout_sec,
            ));

            // 5. Wire state changes → frontend events
            let app_handle = app.handle().clone();
            let mut rx = session_mgr.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(change) => {
                            let _ = app_handle.emit("state-change", &change);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            warn!("ActivityAggregator lagged {} events", n);
                        }
                        Err(_) => break,
                    }
                }
            });

            // 6. Start Unix socket server
            let mgr_socket = session_mgr.clone();
            let socket_path = config.socket_path.clone();
            tauri::async_runtime::spawn(async move {
                watcher::start_socket_server(&socket_path, mgr_socket).await;
            });

            // 7. Start file watcher (in blocking thread)
            let mgr_file = session_mgr.clone();
            let sessions_dir = config.sessions_dir.clone();
            std::thread::spawn(move || {
                watcher::start_file_watcher(&sessions_dir, mgr_file);
            });

            // 8. Load existing sessions from disk
            session_mgr.load_from_disk();

            // 9. Stale cleanup timer
            let mgr_cleanup = session_mgr.clone();
            let interval = config.cleanup_interval_sec;
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(interval));
                loop {
                    ticker.tick().await;
                    mgr_cleanup.cleanup_stale();
                }
            });

            // 10. Store config + aggregator for frontend / command access
            let socket_path_for_guard = config.socket_path.clone();
            app.manage(session_mgr.clone());
            app.manage(config);
            // RAII guard — removes socket file when managed state is dropped on exit
            app.manage(SocketGuard { path: socket_path_for_guard });

            info!("KotoriPet ✓ Running. Press Ctrl+C to exit.");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::run_applescript,
            commands::quit_app,
            commands::purge_all_sessions,
            commands::read_file_bytes,
            commands::read_frames_batch,
            commands::cursor_in_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running KotoriPet");
}
