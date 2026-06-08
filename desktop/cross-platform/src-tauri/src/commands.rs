use crate::config::PetConfig;
use serde::Serialize;

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
    pub menu_items: Vec<FrontendMenuItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FrontendMenuItem {
    pub title: String,
    pub action: String,
    pub script: Option<String>,
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

#[tauri::command]
pub fn run_applescript(script: String) -> Result<String, String> {
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
