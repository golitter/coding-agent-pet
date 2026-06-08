use serde::Deserialize;
use std::path::{Path, PathBuf};
use tracing::info;

/// Resolved configuration used throughout the application.
#[derive(Debug, Clone)]
pub struct PetConfig {
    pub pet_base_dir: String,
    #[allow(dead_code)]
    pub pet_id: String,
    pub frames_dir: String,
    pub sessions_dir: String,
    pub socket_path: String,
    pub scale: f64,
    pub fps: f64,
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
    pub menu_items: Vec<MenuItem>,
}

#[derive(Debug, Clone)]
pub struct MenuItem {
    pub title: String,
    pub action: String, // "applescript", "quit", "separator"
    pub script: Option<String>,
}

/// Raw JSON config for deserialization.
#[derive(Debug, Deserialize, Default)]
struct RawConfig {
    pet_id: Option<String>,
    pet_base_dir: Option<String>,
    frames_dir: Option<String>,
    socket_path: Option<String>,
    sessions_dir: Option<String>,
    renderer: Option<RawRenderer>,
    dialogue: Option<RawDialogue>,
    menu: Option<RawMenu>,
}

#[derive(Debug, Deserialize)]
struct RawRenderer {
    scale: Option<f64>,
    fps: Option<f64>,
    stale_timeout_sec: Option<u64>,
    cleanup_interval_sec: Option<u64>,
    corner_margin: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct RawDialogue {
    font_size: Option<u32>,
    max_width: Option<u32>,
    #[serde(rename = "cornerRadius")]
    corner_radius: Option<u32>,
    fade_duration_sec: Option<f64>,
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
        // Auto-detect repo root:
        // src-tauri/ → cross-platform/ → desktop/ → repo root
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));

        // Walk up from executable to find repo root
        let detected_base = detect_repo_root(&exe_dir);

        // Find config file: try config.json, then config.example.json
        // Look in the cross-platform directory (3 levels up from exe_dir):
        //   target/debug/ → target/ → src-tauri/ → cross-platform/
        let config_dir = exe_dir
            .parent() // target/
            .and_then(|p| p.parent()) // src-tauri/
            .and_then(|p| p.parent()) // cross-platform/
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        let config_path = config_dir.join("config.json");
        let example_path = config_dir.join("config.example.json");

        let actual_path = if config_path.exists() {
            config_path
        } else if example_path.exists() {
            example_path
        } else {
            config_path.clone()
        };

        // Defaults
        let mut pet_id = "kotori-minami".to_string();
        let mut pet_base_dir = detected_base.clone();
        let mut socket_path = "/tmp/kotori-pet.sock".to_string();
        let mut scale = 0.6;
        let mut fps = 10.0;
        let mut stale_timeout_sec = 3600u64;
        let mut cleanup_interval_sec = 5u64;
        let mut corner_margin = 20i32;
        let mut dialogue_font_size = 10u32;
        let mut dialogue_max_width = 160u32;
        let mut dialogue_corner_radius = 6u32;
        let mut dialogue_fade_duration = 0.3;
        let mut frames_dir_override: Option<String> = None;
        let mut sessions_dir_override: Option<String> = None;
        let mut menu_items: Vec<MenuItem> = Vec::new();

        // Parse config file
        if let Ok(data) = std::fs::read_to_string(&actual_path) {
            if let Ok(raw) = serde_json::from_str::<RawConfig>(&data) {
                if let Some(dir) = raw.pet_base_dir {
                    pet_base_dir = resolve_path(&dir, &detected_base);
                }
                if let Some(id) = raw.pet_id {
                    pet_id = id;
                }
                if let Some(dir) = raw.frames_dir {
                    frames_dir_override = Some(resolve_path(&dir, &pet_base_dir));
                }
                if let Some(dir) = raw.sessions_dir {
                    sessions_dir_override = Some(resolve_path(&dir, &pet_base_dir));
                }
                if let Some(sp) = raw.socket_path {
                    socket_path = sp;
                }
                if let Some(r) = raw.renderer {
                    scale = r.scale.unwrap_or(scale);
                    fps = r.fps.unwrap_or(fps);
                    stale_timeout_sec = r.stale_timeout_sec.unwrap_or(stale_timeout_sec);
                    cleanup_interval_sec = r.cleanup_interval_sec.unwrap_or(cleanup_interval_sec);
                    corner_margin = r.corner_margin.unwrap_or(corner_margin);
                }
                if let Some(d) = raw.dialogue {
                    dialogue_font_size = d.font_size.unwrap_or(dialogue_font_size);
                    dialogue_max_width = d.max_width.unwrap_or(dialogue_max_width);
                    dialogue_corner_radius = d.corner_radius.unwrap_or(dialogue_corner_radius);
                    dialogue_fade_duration = d.fade_duration_sec.unwrap_or(dialogue_fade_duration);
                }
                if let Some(menu) = raw.menu {
                    for item in menu.items {
                        match item {
                            RawMenuItem::Separator { .. } => {
                                menu_items.push(MenuItem {
                                    title: String::new(),
                                    action: "separator".to_string(),
                                    script: None,
                                });
                            }
                            RawMenuItem::Action {
                                title,
                                action,
                                script,
                            } => {
                                menu_items.push(MenuItem {
                                    title,
                                    action,
                                    script,
                                });
                            }
                        }
                    }
                }
            }
        }

        let frames_dir =
            frames_dir_override.unwrap_or_else(|| format!("{}/{}/frames", pet_base_dir, pet_id));
        let sessions_dir = sessions_dir_override
            .unwrap_or_else(|| format!("{}/desktop/cross-platform/runtime/sessions", pet_base_dir));

        let config = Self {
            pet_base_dir,
            pet_id,
            frames_dir,
            sessions_dir,
            socket_path,
            scale,
            fps,
            stale_timeout_sec,
            cleanup_interval_sec,
            corner_margin,
            dialogue_font_size,
            dialogue_max_width,
            dialogue_corner_radius,
            dialogue_fade_duration,
            menu_items,
        };

        info!("Config: {}", actual_path.display());
        info!("  petBaseDir: {}", config.pet_base_dir);
        info!("  framesDir: {}", config.frames_dir);
        info!("  sessionsDir: {}", config.sessions_dir);
        info!("  scale: {}, fps: {}", config.scale, config.fps);

        config
    }
}

/// Resolve a path: expand ~, resolve relative paths against a base.
fn resolve_path(path: &str, base: &str) -> String {
    let expanded = if path.starts_with('~') {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        path.replacen('~', &home, 1)
    } else {
        path.to_string()
    };

    if Path::new(&expanded).is_absolute() {
        expanded
    } else {
        format!("{}/{}", base.trim_end_matches('/'), expanded)
    }
}

/// Walk up from a directory to find the repo root (directory containing kotori-minami/).
fn detect_repo_root(start: &Path) -> String {
    let mut dir = start.to_path_buf();
    for _ in 0..10 {
        if dir.join("kotori-minami").exists() || dir.join("desktop").join("cross-platform").exists()
        {
            return dir.to_string_lossy().to_string();
        }
        if !dir.pop() {
            break;
        }
    }
    // Fallback: 4 levels up from exe (release/ → .build/ → src-tauri/ → cross-platform/ → desktop/ → repo root)
    start
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}
