use crate::aggregator::ActivityAggregator;
use crate::config::{FrameTiming, PetConfig};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::info;

#[derive(Debug, Clone, Serialize)]
pub struct FrontendConfig {
    pub frames_dir: String,
    pub scale: f64,
    pub fps: f64,
    pub frame_timing: HashMap<String, FrameTiming>,
    pub dialogue_font_size: u32,
    pub dialogue_max_width: u32,
    pub dialogue_corner_radius: u32,
    pub dialogue_fade_duration: f64,
    pub corner_margin: i32,
    /// 宠物状态 → 气泡 CSS 样式（例如 waiting → warning）。
    pub style_map: HashMap<String, String>,
    pub menu_items: Vec<FrontendMenuItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FrontendMenuItem {
    pub title: String,
    pub action: String,
    pub script: Option<String>,
}

/// 校验文件路径是否落在配置的 frames 目录内。
/// 防止 webview 通过 IPC 读取任意系统文件。
fn validate_path_in_frames(path: &str, frames_dir: &str) -> Result<PathBuf, String> {
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("Cannot resolve path {}: {}", path, e))?;
    let frames_canonical = std::fs::canonicalize(frames_dir)
        .map_err(|e| format!("Cannot resolve frames_dir {}: {}", frames_dir, e))?;
    if !canonical.starts_with(&frames_canonical) {
        return Err("Path outside allowed frames directory".into());
    }
    Ok(canonical)
}

#[tauri::command]
pub fn get_config(config: tauri::State<'_, PetConfig>) -> FrontendConfig {
    FrontendConfig {
        frames_dir: config.frames_dir.clone(),
        scale: config.scale,
        fps: config.fps,
        frame_timing: config.frame_timing.clone(),
        dialogue_font_size: config.dialogue_font_size,
        dialogue_max_width: config.dialogue_max_width,
        dialogue_corner_radius: config.dialogue_corner_radius,
        dialogue_fade_duration: config.dialogue_fade_duration,
        corner_margin: config.corner_margin,
        style_map: config.style_map.clone(),
        menu_items: config
            .menu_items
            .iter()
            .map(|item| FrontendMenuItem {
                title: item.title.clone(),
                action: item.action.clone(),
                script: item.script.clone(),
            })
            .collect(),
    }
}

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle, config: tauri::State<'_, PetConfig>) {
    info!("quit_app command invoked from frontend");
    // app.exit() 会触发 process::exit()，从而跳过 Rust 的 Drop 实现——因此受托管的
    // SocketGuard（lib.rs）在这条主退出路径上永远不会执行。这里显式删除 socket。
    // 启动时的 connect 探测（覆盖会话间的崩溃/被杀）与 SocketGuard（覆盖 panic
    // unwind）补齐其余缺口，因此 socket 在每种终止情形下都会被回收。
    if !config.event_endpoint.starts_with("tcp://") {
        let _ = std::fs::remove_file(&config.event_endpoint);
    }
    app.exit(0);
}

/// 清除磁盘上所有会话文件，并清空内存中的活动 map。由前端三连击交互触发。
/// 返回文件数量，以便渲染器展示本次调用的气泡消息。
#[tauri::command]
pub fn purge_all_sessions(
    aggregator: tauri::State<'_, Arc<ActivityAggregator>>,
) -> Result<usize, String> {
    Ok(aggregator.purge_all())
}

#[tauri::command]
pub async fn run_applescript(script: String) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = script;
        Err("AppleScript is only available on macOS".into())
    }

    #[cfg(target_os = "macos")]
    {
        // 拒绝包含 shell 转义尝试的脚本。
        // 不区分大小写：AppleScript 本身大小写不敏感，因此字面的
        // `Do Shell Script` 否则会绕过朴素的 `contains("do shell script")`。
        // 反引号（`do shell script "..."` 的简写）无论大小写一律拦截。
        // 同时拦截 `do script`（Terminal.app 的命令执行）。
        let lower = script.to_lowercase();
        if lower.contains("do shell script") || lower.contains("do script") || script.contains('`')
        {
            return Err("Script contains disallowed patterns".into());
        }

        // 异步 spawn osascript，使缓慢的用户脚本不会阻塞主线程 / webview 事件循环。
        // `#[tauri::command]` 同步命令在主线程运行；将其改为 `async` 会把它移到
        // Tauri 的 tokio 运行时，`tokio::process::Command` 等待子进程而不占用线程。
        let output = tokio::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .await
            .map_err(|e| format!("Failed to run osascript: {}", e))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }
}

/// 读取某一帧 PNG 的原始文件字节。用于命中检测 alpha 掩码计算：
/// 在 WKWebView 中 JS fetch() 无法读取 asset:// URL，而从 asset:// 加载的 <img>
/// 元素会污染 canvas（导致 getImageData 被阻断）。返回原始字节让 JS 改为构造
/// 未被污染的 blob URL。
///
/// 路径会被校验是否落在配置的 frames_dir 内，以防从 webview 上下文读取任意文件。
#[tauri::command]
pub async fn read_file_bytes(
    path: String,
    config: tauri::State<'_, PetConfig>,
) -> Result<Vec<u8>, String> {
    let validated = validate_path_in_frames(&path, &config.frames_dir)?;
    // `std::fs::read` 是阻塞式系统调用——放到阻塞池上运行，使其永不会卡住主线程 /
    // 异步 worker。同步的 `#[tauri::command]` 在主线程运行；改为 `async` 后会移到
    // Tauri 运行时，`spawn_blocking` 把真正的 I/O 停靠到专用线程上。
    let path_for_err = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::read(&validated))
        .await
        .map_err(|e| format!("Join error: {}", e))?
        .map_err(|e| format!("Failed to read {}: {}", path_for_err, e))
}

/// 在单次 IPC 调用中批量读取多个帧 PNG。返回一个 original_path → 字节 的 map，
/// 仅包含每个成功读取且通过校验的文件。供 computeAlphaMasks 使用，以避免 55+ 次
/// 独立的 IPC 往返。
///
/// 每个请求的路径在读取前先做规范化（canonicalize），再与规范的 frames_dir 比对。
/// 这样既避免从 asset 目录经符号链接逃逸，又把真正的文件 I/O 留在阻塞池上。
#[tauri::command]
pub async fn read_frames_batch(
    paths: Vec<String>,
    config: tauri::State<'_, PetConfig>,
) -> Result<HashMap<String, Vec<u8>>, String> {
    let frames_dir_path = std::path::Path::new(&config.frames_dir);
    let frames_canonical = std::fs::canonicalize(frames_dir_path)
        .map_err(|e| format!("Cannot resolve frames_dir: {}", e))?;

    // 整个批次（多达 55+ 次同步 `std::fs::read` 调用）被移到阻塞池。同步命令在
    // 主线程运行；即便异步命令，若读取留在行内也会卡住其 worker。`spawn_blocking`
    // 保证这些系统调用永不会触及主线程或某个异步 worker。
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = HashMap::with_capacity(paths.len());
        for path in paths {
            let canonical = match std::fs::canonicalize(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if canonical.starts_with(&frames_canonical) {
                if let Ok(bytes) = std::fs::read(&canonical) {
                    results.insert(path, bytes);
                }
            }
        }
        results
    })
    .await
    .map_err(|e| format!("Join error: {}", e))
}

/// 获取光标相对于主窗口内容的位置，单位为逻辑像素，Y 从窗口顶部起算。
///
/// 使用 CGEvent（Core Graphics）读取*硬件*鼠标位置，而非 NSEvent.mouseLocation。
/// 原因：当 `setIgnoreCursorEvents(true)` 激活时（穿透模式），窗口停止处理鼠标
/// 事件，NSEvent.mouseLocation 返回的是陈旧位置（反映最后一次已处理事件）。
/// CGEvent 则无论如何都轮询实时硬件位置。
///
/// CG 坐标以左上角为原点、Y 向下；NS 坐标以左下角为原点、Y 向上。我们用主屏幕
/// 高度（H）做换算：全局上 cgY = H - nsY。最终结果相对于窗口，Y 从顶部起算。
#[tauri::command]
pub fn cursor_in_window(window: tauri::WebviewWindow) -> Result<(f64, f64), String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = window;
        Err("cursor_in_window is only available on macOS and Windows".into())
    }

    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct Point {
            x: i32,
            y: i32,
        }

        #[link(name = "user32")]
        unsafe extern "system" {
            fn GetCursorPos(lp_point: *mut Point) -> i32;
        }

        let mut point = Point { x: 0, y: 0 };
        let ok = unsafe { GetCursorPos(&mut point) };
        if ok == 0 {
            return Err("GetCursorPos failed".into());
        }

        // 使用 inner_position（客户区原点），而非 outer_position（后者包含标题栏 /
        // 边框）。窗口配置为 decorations:false，因此两者当前重合，但 inner_position
        // 在语义上才是客户区命中检测的正确参照，且即使将来启用装饰也依然正确。
        let window_pos = window
            .inner_position()
            .map_err(|e| format!("inner_position: {}", e))?;
        let scale = window
            .scale_factor()
            .map_err(|e| format!("scale_factor: {}", e))?;

        Ok((
            (point.x - window_pos.x) as f64 / scale,
            (point.y - window_pos.y) as f64 / scale,
        ))
    }

    #[cfg(target_os = "macos")]
    {
        use objc::runtime::{Class, Object};
        use objc::{msg_send, sel, sel_impl};

        #[repr(C)]
        struct CGPoint {
            x: f64,
            y: f64,
        }
        #[repr(C)]
        struct NSSize {
            w: f64,
            h: f64,
        }
        #[repr(C)]
        struct NSPoint {
            x: f64,
            y: f64,
        }
        #[repr(C)]
        struct NSRect {
            origin: NSPoint,
            size: NSSize,
        }

        // Core Graphics C API：轮询实时硬件鼠标位置。
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventCreate(source: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
            fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
            fn CFRelease(cf: *mut std::ffi::c_void);
        }

        let ns_window_ptr = window
            .ns_window()
            .map_err(|e| format!("ns_window: {}", e))?;
        let ns_window: *mut Object = ns_window_ptr as *mut Object;

        unsafe {
            // CG 全局坐标下的实时光标（原点 = 主显示器左上角，Y 向下）。
            let event = CGEventCreate(std::ptr::null_mut());
            if event.is_null() {
                return Err("CGEventCreate returned null".into());
            }
            let cursor_cg: CGPoint = CGEventGetLocation(event);
            CFRelease(event);

            // NS 坐标下的窗口 frame（原点 = 主显示器左下角，Y 向上）。
            let frame: NSRect = msg_send![ns_window, frame];

            // 主屏幕高度（NS points），用于坐标系换算。
            let screen_class = Class::get("NSScreen").ok_or("NSScreen class not found")?;
            let main_screen: *mut Object = msg_send![screen_class, mainScreen];
            let screen_frame: NSRect = msg_send![main_screen, frame];
            let screen_h = screen_frame.size.h;

            // relX：两种坐标系下 X 原点相同。
            let rel_x = cursor_cg.x - frame.origin.x;
            // relY 从窗口顶部起算：cgY 是相对主屏幕顶部的 Y 向下值；窗口顶部边缘
            // 在 CG 坐标下为 (screen_h - (origin.y + size.h))。二者相减。
            let window_top_cg = screen_h - (frame.origin.y + frame.size.h);
            let rel_y = cursor_cg.y - window_top_cg;

            Ok((rel_x, rel_y))
        }
    }
}

/// 将 JS console 桥接到 Rust 日志。让前端写入的诊断消息出现在与 Rust 侧日志
/// 相同的流中（stdout / RUST_LOG）。
#[tauri::command]
pub fn js_log(level: String, tag: String, msg: String) {
    match level.as_str() {
        "error" => tracing::error!("[JS:{}]: {}", tag, msg),
        "warn" => tracing::warn!("[JS:{}]: {}", tag, msg),
        _ => info!("[JS:{}]: {}", tag, msg),
    }
}
