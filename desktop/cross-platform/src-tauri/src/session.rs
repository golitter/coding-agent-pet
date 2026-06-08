use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tracing::info;

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

/// Aggregated display state — protected by a single Mutex to prevent deadlocks.
struct AggregatedState {
    current_state: String,
    current_dialogue: String,
    active_count: usize,
}

/// All mutable state behind ONE Mutex.
struct Inner {
    sessions: HashMap<String, SessionState>,
    aggregated: AggregatedState,
}

/// Manages multiple concurrent sessions, aggregates them into a single display state.
pub struct SessionManager {
    inner: Mutex<Inner>,
    sessions_dir: String,
    stale_timeout_sec: u64,
    tx: broadcast::Sender<StateChange>,
}

// ── Convenience helpers for accessing `inner.sessions` ──

impl SessionManager {
    /// Lock inner and remove a session by id. Returns true if removed.
    fn remove_session(&self, id: &str) -> bool {
        self.inner.lock().unwrap().sessions.remove(id).is_some()
    }

    /// Lock inner and insert a session.
    fn insert_session(&self, id: String, state: SessionState) {
        self.inner.lock().unwrap().sessions.insert(id, state);
    }

    /// Lock inner and replace all sessions atomically.
    fn replace_all_sessions(&self, new: HashMap<String, SessionState>) {
        let mut inner = self.inner.lock().unwrap();
        inner.sessions = new;
    }

    /// Lock inner, collect orphaned session ids (those not in `file_ids`), then remove them.
    fn remove_orphaned_sessions(&self, file_ids: &std::collections::HashSet<String>) -> Vec<String> {
        let mut inner = self.inner.lock().unwrap();
        let orphaned: Vec<String> = inner
            .sessions
            .keys()
            .filter(|id| !file_ids.contains(*id))
            .cloned()
            .collect();
        for id in &orphaned {
            inner.sessions.remove(id);
        }
        orphaned
    }
}

impl SessionManager {
    pub fn new(sessions_dir: String, stale_timeout_sec: u64) -> Self {
        let (tx, _) = broadcast::channel(16);
        Self {
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                aggregated: AggregatedState {
                    current_state: "idle".to_string(),
                    current_dialogue: String::new(),
                    active_count: 0,
                },
            }),
            sessions_dir,
            stale_timeout_sec,
            tx,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StateChange> {
        self.tx.subscribe()
    }

    /// Update a session's state from a hook event.
    pub fn update(&self, session_id: &str, state: &str, dialogue: &str, source: &str, is_terminal: bool) {
        if is_terminal {
            self.remove_session(session_id);
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

        self.insert_session(session_id.to_string(), session);
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

        self.replace_all_sessions(loaded);
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

        let orphaned = self.remove_orphaned_sessions(&file_ids);

        if !orphaned.is_empty() {
            info!("Cleaned up {} orphaned sessions", orphaned.len());
            self.aggregate_and_notify();
        }
    }

    /// Aggregate all sessions into a single display state using priority.
    fn aggregate_and_notify(&self) {
        let mut inner = self.inner.lock().unwrap();

        if inner.sessions.is_empty() {
            let changed = inner.aggregated.current_state != "idle"
                || !inner.aggregated.current_dialogue.is_empty()
                || inner.aggregated.active_count != 0;
            inner.aggregated.current_state = "idle".to_string();
            inner.aggregated.current_dialogue = String::new();
            inner.aggregated.active_count = 0;

            drop(inner);
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

        for s in inner.sessions.values() {
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
        let new_count = inner.sessions.values().filter(|s| s.state != "idle").count();

        let changed = inner.aggregated.current_state != new_state
            || inner.aggregated.current_dialogue != new_dialogue
            || inner.aggregated.active_count != new_count;

        if changed {
            inner.aggregated.current_state = new_state.clone();
            inner.aggregated.current_dialogue = new_dialogue.clone();
            inner.aggregated.active_count = new_count;

            info!(
                "state={} dialogue=\"{}\" active={}",
                new_state, new_dialogue, new_count
            );

            // Drop the lock before broadcasting to avoid blocking other callers.
            drop(inner);
            let _ = self.tx.send(StateChange {
                state: new_state,
                dialogue: new_dialogue,
                active_count: new_count,
            });
        }
    }
}
