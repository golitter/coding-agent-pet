// 抑制 `objc` crate 的 msg_send! 宏产生的 unexpected_cfgs 警告。
// 参见：https://github.com/rust-lang/rust/issues/123797
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

/// macOS：通过 objc 强制让 NSWindow 与 WKWebView 透明。
#[cfg(target_os = "macos")]
fn make_window_transparent(window: &tauri::WebviewWindow) {
    use objc::runtime::{Class, Object, NO};
    use objc::{msg_send, sel, sel_impl};

    let Some(ns_color) = Class::get("NSColor") else {
        warn!("NSColor class not available; skipping transparency setup");
        return;
    };

    if let Ok(ptr) = window.ns_window() {
        unsafe {
            let ns_window: *mut Object = ptr as *mut Object;
            let clear: *mut Object = msg_send![ns_color, clearColor];

            // NSWindow 透明
            let _: () = msg_send![ns_window, setOpaque: NO];
            let _: () = msg_send![ns_window, setBackgroundColor: clear];
            let _: () = msg_send![ns_window, setHasShadow: NO];
        }
    }

    // 通过 Tauri 的 with_webview API 让 WKWebView 透明
    let _ = window.with_webview(|webview| unsafe {
        let wk: *mut Object = webview.inner() as *mut Object;
        if !wk.is_null() {
            let clear: *mut Object = msg_send![ns_color, clearColor];
            let _: () = msg_send![wk, setOpaque: NO];
            let _: () = msg_send![wk, setBackgroundColor: clear];
        }
    });
}

/// 在 Drop 时删除 Unix socket 文件的 RAII 守卫。
///
/// 注意：正常退出路径是 `quit_app` → `app.exit()` → `process::exit()`，
/// 该路径会跳过 Drop，因此本守卫在优雅关闭时不会触发——`quit_app` 会显式
/// 删除 socket。本守卫覆盖剩余情形：触发栈展开的 panic（Drop 在展开期间运行）。
/// Unix 事件服务器启动时的 connect 探测是为崩溃/被杀后遗留文件的最终兜底，
/// 在下次启动时回收它。
struct SocketGuard {
    endpoint: String,
}
impl Drop for SocketGuard {
    fn drop(&mut self) {
        if !self.endpoint.starts_with("tcp://") {
            let _ = std::fs::remove_file(&self.endpoint);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化 tracing 订阅者
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                info!("Window close requested: {}", window.label());
            }
            tauri::WindowEvent::Destroyed => {
                warn!("Window destroyed: {}", window.label());
            }
            _ => {}
        })
        .setup(|app| {
            // 1. 加载配置
            let config = PetConfig::load();

            // 2. 从 Dock 隐藏（macOS accessory 模式）
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // 2b. 在 macOS 上让窗口真正透明
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                make_window_transparent(&window);
            }

            // 3. 确保会话目录存在
            if let Err(err) = std::fs::create_dir_all(&config.sessions_dir) {
                return Err(Box::new(err));
            }

            // 4. 创建活动聚合器（追踪各 agent 活动，汇总为显示状态）
            let session_mgr = Arc::new(ActivityAggregator::new(
                config.sessions_dir.clone(),
                config.stale_timeout_sec,
            ));

            // 5. 将状态变更连接 → 前端事件
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

            // 6. 启动事件服务器（Unix 上为 Unix socket，Windows 上为 TCP loopback）
            let mgr_socket = session_mgr.clone();
            let event_endpoint = config.event_endpoint.clone();
            tauri::async_runtime::spawn(async move {
                watcher::start_event_server(&event_endpoint, mgr_socket).await;
            });

            // 7. 启动文件监视器（在阻塞线程中）
            let mgr_file = session_mgr.clone();
            let sessions_dir = config.sessions_dir.clone();
            std::thread::spawn(move || {
                watcher::start_file_watcher(&sessions_dir, mgr_file);
            });

            // 8. 从磁盘加载已有会话
            session_mgr.load_from_disk();

            // 9. 陈旧清理定时器
            let mgr_cleanup = session_mgr.clone();
            let interval = config.cleanup_interval_sec;
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(interval));
                // tokio interval 的首次 tick 会立即触发。`load_from_disk` 刚扫描过
                // 同一目录，因此消费掉这次 tick，等待第一个真正的清理周期再扫描。
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    mgr_cleanup.cleanup_stale();
                }
            });

            // 10. 存储配置 + 聚合器，供前端 / 命令访问
            let endpoint_for_guard = config.event_endpoint.clone();
            app.manage(session_mgr.clone());
            app.manage(config);
            // RAII 兜底：若进程 panic 并展开（Drop 在展开期间运行），则删除 socket
            // 文件。正常退出路径会在 `quit_app` 中显式清理；见 SocketGuard 的文档注释。
            app.manage(SocketGuard {
                endpoint: endpoint_for_guard,
            });

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
            commands::cursor_in_window,
            commands::js_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running KotoriPet");
}
