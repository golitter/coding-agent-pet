use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

/// Priority order for aggregating multi-session states.
/// Higher number = higher priority.
const STATE_PRIORITY: &[(&str, i32)] = &[
    ("waiting", 8),
    ("running", 7),
    ("running-right", 6),
    ("running-left", 6),
    ("review", 5),
    ("jumping", 4),
    ("waving", 3),
    ("idle", 1),
    ("failed", 0),
];

fn get_priority(state: &str) -> i32 {
    STATE_PRIORITY
        .iter()
        .find(|(s, _)| *s == state)
        .map(|(_, p)| *p)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub struct SessionState {
    pub state: String,
    pub dialogue: String,
    #[allow(dead_code)]
    pub source: String,
    #[allow(dead_code)]
    pub is_terminal: bool,
    #[allow(dead_code)]
    pub updated_at: u64, // unix timestamp in seconds
}

#[derive(Debug, Clone, Serialize)]
pub struct StateChange {
    pub state: String,
    pub dialogue: String,
    pub active_count: usize,
}

/// Manages multiple concurrent sessions, aggregates them into a single display state.
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionState>>,
    sessions_dir: String,
    stale_timeout_sec: u64,
    current_state: Mutex<String>,
    current_dialogue: Mutex<String>,
    active_count: Mutex<usize>,
    tx: broadcast::Sender<StateChange>,
}

impl SessionManager {
    pub fn new(sessions_dir: String, stale_timeout_sec: u64) -> Self {
        let (tx, _) = broadcast::channel(16);
        Self {
            sessions: Mutex::new(HashMap::new()),
            sessions_dir,
            stale_timeout_sec,
            current_state: Mutex::new("idle".to_string()),
            current_dialogue: Mutex::new(String::new()),
            active_count: Mutex::new(0),
            tx,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StateChange> {
        self.tx.subscribe()
    }

    /// Update a session's state from a hook event.
    pub fn update(&self, session_id: &str, state: &str, dialogue: &str, source: &str, is_terminal: bool) {
        if is_terminal {
            self.sessions.lock().unwrap().remove(session_id);
            // Also delete file
            let path = PathBuf::from(&self.sessions_dir).join(format!("{}.json", session_id));
            let _ = std::fs::remove_file(path);
            self.aggregate_and_notify();
            return;
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let session = SessionState {
            state: state.to_string(),
            dialogue: dialogue.to_string(),
            source: source.to_string(),
            is_terminal: false,
            updated_at: now,
        };

        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), session);
        self.aggregate_and_notify();
    }

    /// Load all session files from disk.
    pub fn load_from_disk(&self) {
        let read_dir = match std::fs::read_dir(&self.sessions_dir) {
            Ok(d) => d,
            Err(_) => return,
        };

        let mut loaded: HashMap<String, SessionState> = HashMap::new();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }

            let file_stem = path.file_stem().unwrap().to_string_lossy().to_string();

            let data = match std::fs::read_to_string(&path) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let json: serde_json::Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let state = json["state"].as_str().unwrap_or("idle").to_string();
            let dialogue = json["dialogue"].as_str().unwrap_or("").to_string();
            let source = json["source"].as_str().unwrap_or("").to_string();
            let is_terminal = json["isTerminal"].as_bool().unwrap_or(false);

            if is_terminal {
                continue;
            }

            // Parse date
            let updated_at = json["updatedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp() as u64)
                .unwrap_or(0);

            // Skip stale sessions (> stale_timeout)
            if now.saturating_sub(updated_at) > self.stale_timeout_sec {
                continue;
            }

            loaded.insert(
                file_stem,
                SessionState {
                    state,
                    dialogue,
                    source,
                    is_terminal: false,
                    updated_at,
                },
            );
        }

        *self.sessions.lock().unwrap() = loaded;
        self.aggregate_and_notify();
    }

    /// Clean up sessions whose files have been deleted.
    pub fn cleanup_stale(&self) {
        let read_dir = match std::fs::read_dir(&self.sessions_dir) {
            Ok(d) => d,
            Err(_) => return,
        };

        let file_ids: std::collections::HashSet<String> = read_dir
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    path.file_stem().map(|s| s.to_string_lossy().to_string())
                } else {
                    None
                }
            })
            .collect();

        let mut sessions = self.sessions.lock().unwrap();
        let orphaned: Vec<String> = sessions
            .keys()
            .filter(|id| !file_ids.contains(*id))
            .cloned()
            .collect();

        if !orphaned.is_empty() {
            for id in &orphaned {
                sessions.remove(id);
            }
            drop(sessions);
            println!("[SessionManager] Cleaned up {} orphaned sessions", orphaned.len());
            self.aggregate_and_notify();
        }
    }

    /// Aggregate all sessions into a single display state using priority.
    fn aggregate_and_notify(&self) {
        let sessions = self.sessions.lock().unwrap();

        if sessions.is_empty() {
            drop(sessions);
            let changed = {
                let mut cs = self.current_state.lock().unwrap();
                let mut cd = self.current_dialogue.lock().unwrap();
                let mut ac = self.active_count.lock().unwrap();
                let c = *cs != "idle" || !cd.is_empty() || *ac != 0;
                *cs = "idle".to_string();
                *cd = String::new();
                *ac = 0;
                c
            };
            if changed {
                let _ = self.tx.send(StateChange {
                    state: "idle".to_string(),
                    dialogue: String::new(),
                    active_count: 0,
                });
            }
            return;
        }

        let mut best_session: Option<&SessionState> = None;
        let mut best_priority = -1i32;

        for s in sessions.values() {
            let priority = get_priority(&s.state);
            if priority > best_priority {
                best_priority = priority;
                best_session = Some(s);
            }
        }

        let new_state = best_session
            .map(|s| s.state.clone())
            .unwrap_or_else(|| "idle".to_string());
        let new_dialogue = best_session
            .map(|s| s.dialogue.clone())
            .unwrap_or_default();
        let new_count = sessions.values().filter(|s| s.state != "idle").count();

        drop(sessions);

        let changed = {
            let cs = self.current_state.lock().unwrap();
            let cd = self.current_dialogue.lock().unwrap();
            let ac = self.active_count.lock().unwrap();
            *cs != new_state || *cd != new_dialogue || *ac != new_count
        };

        if changed {
            *self.current_state.lock().unwrap() = new_state.clone();
            *self.current_dialogue.lock().unwrap() = new_dialogue.clone();
            *self.active_count.lock().unwrap() = new_count;

            println!(
                "[SessionManager] → state={} dialogue=\"{}\" active={}",
                new_state, new_dialogue, new_count
            );

            let _ = self.tx.send(StateChange {
                state: new_state,
                dialogue: new_dialogue,
                active_count: new_count,
            });
        }
    }
}
