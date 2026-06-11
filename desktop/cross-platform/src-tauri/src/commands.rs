use crate::aggregator::ActivityAggregator;
use crate::config::PetConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
pub struct FrontendConfig {
    pub frames_dir: String,
    pub scale: f64,
    pub fps: f64,
    pub dialogue_font_size: u32,
    pub dialogue_max_width: u32,
    pub dialogue_corner_radius: u32,
    pub dialogue_fade_duration: f64,
    pub corner_margin: i32,
    /// pet state → bubble CSS style (e.g. waiting → warning).
    pub style_map: HashMap<String, String>,
    pub menu_items: Vec<FrontendMenuItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FrontendMenuItem {
    pub title: String,
    pub action: String,
    pub script: Option<String>,
}

/// Validate that a file path falls within the configured frames directory.
/// Prevents the webview from reading arbitrary system files via IPC.
fn validate_path_in_frames(path: &str, frames_dir: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Cannot resolve path {}: {}", path, e))?;
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
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Wipe every session file on disk and clear the in-memory activities map.
/// Triggered by the frontend's triple-click interaction. Returns the file
/// count so the renderer can show a per-call bubble message.
#[tauri::command]
pub fn purge_all_sessions(
    aggregator: tauri::State<'_, Arc<ActivityAggregator>>,
) -> Result<usize, String> {
    Ok(aggregator.purge_all())
}

#[tauri::command]
pub fn run_applescript(script: String) -> Result<String, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = script;
        Err("AppleScript is only available on macOS".into())
    }

    #[cfg(target_os = "macos")]
    {
        // Reject scripts containing shell-escape attempts.
        // Case-insensitive: AppleScript is case-insensitive, so a literal
        // `Do Shell Script` would otherwise bypass a naive `contains("do shell script")`.
        // Backticks (`do shell script "..."` shorthand) are blocked regardless of case.
        // Also block `do script` (Terminal.app command execution).
        let lower = script.to_lowercase();
        if lower.contains("do shell script") || lower.contains("do script") || script.contains('`')
        {
            return Err("Script contains disallowed patterns".into());
        }

        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| format!("Failed to run osascript: {}", e))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }
}

/// Read raw file bytes for a frame PNG. Used by the hit-test alpha-mask
/// computation: JS fetch() cannot read asset:// URLs in WKWebView, and <img>
/// elements loaded from asset:// taint the canvas (blocking getImageData).
/// Returning raw bytes lets JS build an untainted blob URL instead.
///
/// Path is validated to be within the configured frames_dir to prevent
/// arbitrary file reads from the webview context.
#[tauri::command]
pub fn read_file_bytes(path: String, config: tauri::State<'_, PetConfig>) -> Result<Vec<u8>, String> {
    let validated = validate_path_in_frames(&path, &config.frames_dir)?;
    std::fs::read(&validated).map_err(|e| format!("Failed to read {}: {}", path, e))
}

/// Batch-read multiple frame PNGs in a single IPC call. Returns a map of
/// original_path → bytes for each file successfully read and validated.
/// Used by computeAlphaMasks to avoid 55+ individual IPC round trips.
#[tauri::command]
pub fn read_frames_batch(
    paths: Vec<String>,
    config: tauri::State<'_, PetConfig>,
) -> Result<HashMap<String, Vec<u8>>, String> {
    let frames_canonical = std::fs::canonicalize(&config.frames_dir)
        .map_err(|e| format!("Cannot resolve frames_dir: {}", e))?;

    let mut results = HashMap::with_capacity(paths.len());
    for path in paths {
        let canonical = match std::fs::canonicalize(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !canonical.starts_with(&frames_canonical) {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&canonical) {
            results.insert(path, bytes);
        }
    }
    Ok(results)
}

/// Get cursor position relative to the main window's content, in logical
/// pixels with Y measured from the TOP of the window.
///
/// Uses CGEvent (Core Graphics) to read the *hardware* mouse position, NOT
/// NSEvent.mouseLocation. Rationale: when `setIgnoreCursorEvents(true)` is
/// active (pass-through mode), the window stops processing mouse events, so
/// NSEvent.mouseLocation returns a STALE position (it reflects the last
/// processed event). CGEvent polls the live hardware position regardless.
///
/// CG coords use top-left origin with Y down; NS coords use bottom-left with
/// Y up. We convert using the primary screen height (H): cgY = H - nsY holds
/// globally. Final result is window-relative, Y from top.
#[tauri::command]
pub fn cursor_in_window(window: tauri::WebviewWindow) -> Result<(f64, f64), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("cursor_in_window is macOS-only".into())
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

        // Core Graphics C API: poll live hardware mouse position.
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
            // Live cursor in CG global coords (origin = primary display top-left, Y down).
            let event = CGEventCreate(std::ptr::null_mut());
            if event.is_null() {
                return Err("CGEventCreate returned null".into());
            }
            let cursor_cg: CGPoint = CGEventGetLocation(event);
            CFRelease(event);

            // Window frame in NS coords (origin = primary display bottom-left, Y up).
            let frame: NSRect = msg_send![ns_window, frame];

            // Primary screen height (NS points) for coordinate-space conversion.
            let screen_class = Class::get("NSScreen").ok_or("NSScreen class not found")?;
            let main_screen: *mut Object = msg_send![screen_class, mainScreen];
            let screen_frame: NSRect = msg_send![main_screen, frame];
            let screen_h = screen_frame.size.h;

            // relX: same X origin in both spaces.
            let rel_x = cursor_cg.x - frame.origin.x;
            // relY from window top: cgY is Y-down from primary top; window's top
            // edge in CG coords is (screen_h - (origin.y + size.h)). Subtract.
            let window_top_cg = screen_h - (frame.origin.y + frame.size.h);
            let rel_y = cursor_cg.y - window_top_cg;

            Ok((rel_x, rel_y))
        }
    }
}
