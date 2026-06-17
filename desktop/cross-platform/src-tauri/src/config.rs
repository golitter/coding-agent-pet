use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Resolved configuration used throughout the application.
#[derive(Debug, Clone)]
pub struct PetConfig {
    pub pet_base_dir: String,
    #[allow(dead_code)]
    pub pet_id: String,
    pub frames_dir: String,
    pub sessions_dir: String,
    pub event_endpoint: String,
    pub scale: f64,
    pub fps: f64,
    pub frame_timing: std::collections::HashMap<String, FrameTiming>,
    /// How long a session file can stay unchanged before being considered dead.
    /// During this window, a session is counted as alive even if no events fire
    /// (covers reading/thinking/long-tool-calls). After it expires, the session
    /// is dropped from memory and its file is removed by `cleanup_stale`.
    pub stale_timeout_sec: u64,
    pub cleanup_interval_sec: u64,
    pub corner_margin: i32,
    pub dialogue_font_size: u32,
    pub dialogue_max_width: u32,
    pub dialogue_corner_radius: u32,
    pub dialogue_fade_duration: f64,
    /// pet state → bubble CSS style. Drives bubble coloring (e.g. waiting → warning).
    /// Kept here so the mapping lives in one place alongside the state map,
    /// not split between Rust and JS.
    pub style_map: std::collections::HashMap<String, String>,
    pub menu_items: Vec<MenuItem>,
}

#[derive(Debug, Clone)]
pub struct MenuItem {
    pub title: String,
    pub action: String, // "applescript", "quit", "separator"
    pub script: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameTiming {
    pub holds: Vec<u32>,
}

/// Raw JSON config for deserialization.
#[derive(Debug, Deserialize, Default)]
struct RawConfig {
    pet_id: Option<String>,
    pet_base_dir: Option<String>,
    frames_dir: Option<String>,
    socket_path: Option<String>,
    event_endpoint: Option<String>,
    sessions_dir: Option<String>,
    renderer: Option<RawRenderer>,
    dialogue: Option<RawDialogue>,
    menu: Option<RawMenu>,
}

#[derive(Debug, Deserialize, Default)]
struct RawRenderer {
    scale: Option<f64>,
    fps: Option<f64>,
    frame_timing: Option<std::collections::HashMap<String, FrameTiming>>,
    stale_timeout_sec: Option<u64>,
    cleanup_interval_sec: Option<u64>,
    corner_margin: Option<i32>,
}

#[derive(Debug, Deserialize, Default)]
struct RawDialogue {
    font_size: Option<u32>,
    max_width: Option<u32>,
    #[serde(rename = "cornerRadius")]
    corner_radius: Option<u32>,
    fade_duration_sec: Option<f64>,
    style_map: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct RawMenu {
    items: Vec<RawMenuItem>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawMenuItem {
    #[allow(dead_code)]
    Separator { r#type: String },
    Action {
        title: String,
        action: String,
        script: Option<String>,
    },
}

impl PetConfig {
    /// Load configuration from config.json or config.example.json,
    /// with auto-detection of paths relative to the repo root.
    pub fn load() -> Self {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));

        let config_path = find_config_path(&exe_dir);
        let config_dir = config_path
            .as_ref()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("."));
        let detected_base = detect_repo_root(&config_dir);
        let actual_path = config_path.unwrap_or_else(|| config_dir.join("config.json"));

        let raw: RawConfig = std::fs::read_to_string(&actual_path)
            .ok()
            .and_then(|data| serde_json::from_str(&data).ok())
            .unwrap_or_default();

        let pet_id = raw.pet_id.unwrap_or_else(|| "kotori-minami".to_string());
        let pet_base_dir = raw
            .pet_base_dir
            .map(|d| resolve_path(&d, &detected_base))
            .unwrap_or_else(|| detected_base.clone());
        let frames_dir_override = raw.frames_dir.map(|d| resolve_path(&d, &pet_base_dir));
        let sessions_dir_override = raw.sessions_dir.map(|d| resolve_path(&d, &pet_base_dir));
        let event_endpoint = raw
            .event_endpoint
            .unwrap_or_else(|| default_event_endpoint(raw.socket_path));

        let renderer = raw.renderer.unwrap_or_default();
        let scale = renderer.scale.unwrap_or(0.6);
        let fps = renderer.fps.unwrap_or(10.0);
        let frame_timing = renderer.frame_timing.unwrap_or_default();
        let stale_timeout_sec = renderer.stale_timeout_sec.unwrap_or(3600);
        let cleanup_interval_sec = renderer.cleanup_interval_sec.unwrap_or(30);
        let corner_margin = renderer.corner_margin.unwrap_or(20);

        let dialogue = raw.dialogue.unwrap_or_default();
        let dialogue_font_size = dialogue.font_size.unwrap_or(10);
        let dialogue_max_width = dialogue.max_width.unwrap_or(160);
        let dialogue_corner_radius = dialogue.corner_radius.unwrap_or(6);
        let dialogue_fade_duration = dialogue.fade_duration_sec.unwrap_or(0.3);
        let style_map = dialogue.style_map.unwrap_or_default();

        let menu_items = raw
            .menu
            .map(|m| {
                m.items
                    .into_iter()
                    .map(|item| match item {
                        RawMenuItem::Separator { .. } => MenuItem {
                            title: String::new(),
                            action: "separator".to_string(),
                            script: None,
                        },
                        RawMenuItem::Action {
                            title,
                            action,
                            script,
                        } => MenuItem {
                            title,
                            action,
                            script,
                        },
                    })
                    .collect()
            })
            .unwrap_or_default();

        let frames_dir = frames_dir_override
            .unwrap_or_else(|| join_path_string(&pet_base_dir, &["assets", &pet_id, "frames"]));
        let sessions_dir = sessions_dir_override.unwrap_or_else(|| {
            join_path_string(
                &pet_base_dir,
                &["desktop", "cross-platform", "runtime", "sessions"],
            )
        });

        let config = Self {
            pet_base_dir,
            pet_id,
            frames_dir,
            sessions_dir,
            event_endpoint,
            scale,
            fps,
            frame_timing,
            stale_timeout_sec,
            cleanup_interval_sec,
            corner_margin,
            dialogue_font_size,
            dialogue_max_width,
            dialogue_corner_radius,
            dialogue_fade_duration,
            style_map,
            menu_items,
        };

        info!("Config: {}", actual_path.display());
        info!("  petBaseDir: {}", config.pet_base_dir);
        info!("  framesDir: {}", config.frames_dir);
        info!("  sessionsDir: {}", config.sessions_dir);
        info!("  eventEndpoint: {}", config.event_endpoint);
        info!("  scale: {}, fps: {}", config.scale, config.fps);

        config
    }
}

fn find_cross_platform_dir(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    for _ in 0..12 {
        if dir.join("config.example.json").exists() && dir.join("src-tauri").exists() {
            return Some(dir);
        }

        if dir.ends_with(Path::new("desktop/cross-platform")) {
            return Some(dir);
        }

        if !dir.pop() {
            break;
        }
    }
    None
}

fn find_config_path(start: &Path) -> Option<PathBuf> {
    let cross_platform_dir = find_cross_platform_dir(start)?;
    let config_path = cross_platform_dir.join("config.json");
    if config_path.exists() {
        return Some(config_path);
    }

    let example_path = cross_platform_dir.join("config.example.json");
    if example_path.exists() {
        return Some(example_path);
    }

    None
}

/// Resolve a path: expand ~, resolve relative paths against a base.
fn resolve_path(path: &str, base: &str) -> String {
    let expanded = if path.starts_with('~') {
        let home = home_dir_string().unwrap_or_else(|| "/".to_string());
        path.replacen('~', &home, 1)
    } else {
        path.to_string()
    };

    if Path::new(&expanded).is_absolute() {
        expanded
    } else {
        PathBuf::from(base)
            .join(expanded)
            .to_string_lossy()
            .to_string()
    }
}

fn join_path_string(base: &str, parts: &[&str]) -> String {
    let mut path = PathBuf::from(base);
    for part in parts {
        path.push(part);
    }
    path.to_string_lossy().to_string()
}

fn home_dir_string() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            if !profile.trim().is_empty() {
                return Some(profile);
            }
        }
        let drive = std::env::var("HOMEDRIVE").ok();
        let path = std::env::var("HOMEPATH").ok();
        if let (Some(drive), Some(path)) = (drive, path) {
            if !drive.trim().is_empty() && !path.trim().is_empty() {
                return Some(format!("{}{}", drive, path));
            }
        }
    }

    std::env::var("HOME")
        .ok()
        .filter(|home| !home.trim().is_empty())
}

fn default_event_endpoint(_socket_path: Option<String>) -> String {
    #[cfg(target_os = "windows")]
    {
        "tcp://127.0.0.1:17361".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        _socket_path.unwrap_or_else(|| "/tmp/kotori-pet.sock".to_string())
    }
}

/// Walk up from a directory to find the repo root (directory containing the
/// `desktop/cross-platform/` app source tree — a stable landmark that survives
/// resource reorganization, unlike pet-specific asset directories).
fn detect_repo_root(start: &Path) -> String {
    let mut dir = start.to_path_buf();
    for _ in 0..12 {
        if dir.join("desktop").join("cross-platform").exists() {
            return dir.to_string_lossy().to_string();
        }
        if !dir.pop() {
            break;
        }
    }
    warn!(
        "Unable to detect repo root from {}, falling back to {}",
        start.display(),
        start.display()
    );
    start.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        detect_repo_root, find_config_path, find_cross_platform_dir, join_path_string, resolve_path,
    };
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("kotori-pet-{label}-{unique}"))
    }

    #[test]
    fn resolve_path_handles_relative_and_absolute_inputs() {
        assert_eq!(
            Path::new(&resolve_path("frames", "/repo")),
            Path::new("/repo").join("frames")
        );
        #[cfg(windows)]
        assert_eq!(resolve_path("C:\\tmp\\frames", "/repo"), "C:\\tmp\\frames");
        #[cfg(not(windows))]
        assert_eq!(resolve_path("/tmp/frames", "/repo"), "/tmp/frames");
    }

    #[test]
    fn join_path_string_uses_native_separators() {
        assert_eq!(
            Path::new(&join_path_string("/repo", &["assets", "kotori", "frames"])),
            Path::new("/repo")
                .join("assets")
                .join("kotori")
                .join("frames")
        );
    }

    #[test]
    fn find_cross_platform_dir_walks_up_to_project_root() {
        let root = temp_dir("config-search");
        let nested = root.join("desktop/cross-platform/src-tauri/target/debug");
        fs::create_dir_all(&nested).unwrap();
        fs::write(
            root.join("desktop/cross-platform/config.example.json"),
            "{}",
        )
        .unwrap();
        fs::create_dir_all(root.join("desktop/cross-platform/src-tauri")).unwrap();

        let found = find_cross_platform_dir(&nested).unwrap();
        assert_eq!(found, root.join("desktop/cross-platform"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn find_config_path_prefers_config_json_over_example() {
        let root = temp_dir("config-file");
        let cross_platform = root.join("desktop/cross-platform");
        fs::create_dir_all(cross_platform.join("src-tauri")).unwrap();
        fs::write(cross_platform.join("config.example.json"), "{}").unwrap();

        let start = cross_platform.join("src-tauri");
        let example = find_config_path(&start).unwrap();
        assert_eq!(example, cross_platform.join("config.example.json"));

        fs::write(cross_platform.join("config.json"), "{\"pet_id\":\"real\"}").unwrap();
        let config = find_config_path(&start).unwrap();
        assert_eq!(config, cross_platform.join("config.json"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detect_repo_root_returns_workspace_root_when_landmark_exists() {
        let root = temp_dir("repo-root");
        let start = root.join("desktop/cross-platform/src-tauri");
        fs::create_dir_all(&start).unwrap();

        let detected = detect_repo_root(Path::new(&start));
        assert_eq!(detected, root.to_string_lossy());

        let _ = fs::remove_dir_all(root);
    }
}
