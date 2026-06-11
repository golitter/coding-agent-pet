//! Activity aggregator — owns the live view of every AI agent process
//! (Claude Code / Codex / …) currently producing events, and rolls them up
//! into a single display state for the pet renderer.
//!
//! Naming note: the wire protocol and on-disk filename still use `session_id`
//! (e.g. `019ea736-...json`), since that identifier is owned by the agent.
//! Internally, however, what we are tracking is the *agent's current activity*
//! (running / waiting / jumping / …), not a long-lived session. Hence
//! `ActivityAggregator` + `AgentActivity` for the in-memory model.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tracing::info;

/// Priority order for aggregating multi-agent activities.
/// Higher number = higher priority. Kept as reference; get_priority uses match for O(1).
#[allow(dead_code)]
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
    match state {
        "waiting" => 8,
        "running" => 7,
        "running-right" | "running-left" => 6,
        "review" => 5,
        "jumping" => 4,
        "waving" => 3,
        "idle" => 1,
        _ => 0,
    }
}

/// Filesystem mtime of a path, as unix seconds (0 if unavailable).
/// Uses mtime (source of truth), not the JSON's `updatedAt` field — the filesystem
/// is what reflects reality after `common.py` does an atomic `os.replace()` write.
fn file_mtime_secs(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A session file is stale if its filesystem mtime is older than `timeout` seconds.
fn is_session_file_stale(path: &Path, now: u64, timeout: u64) -> bool {
    now.saturating_sub(file_mtime_secs(path)) > timeout
}

/// States that play once and revert (celebrations). Their session files should
/// not linger beyond the display window — see `reconcile_with_disk`.
fn is_oneshot_state(state: &str) -> bool {
    state == "jumping" || state == "waving"
}

/// How long a one-shot celebration file may survive on disk before the file
/// watcher's reconciliation clears it. Generous vs. the socket channel's 2s
/// `remove_if_state` delay so the animation finishes even under load.
const ONESHOT_DISPLAY_WINDOW_SEC: u64 = 5;

#[derive(Debug, Clone)]
pub struct AgentActivity {
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

/// All mutable state behind ONE Mutex. The map key is the agent's session_id
/// (kept as `String` here to honor the wire-protocol naming).
struct Inner {
    activities: HashMap<String, AgentActivity>,
    aggregated: AggregatedState,
}

/// Aggregates the live activity of multiple concurrent AI agents into a
/// single display state consumed by the pet renderer.
pub struct ActivityAggregator {
    inner: Mutex<Inner>,
    sessions_dir: String,
    stale_timeout_sec: u64,
    tx: broadcast::Sender<StateChange>,
}

// ── Convenience helpers for accessing `inner.activities` ──

impl ActivityAggregator {
    /// Lock inner and replace all activities atomically.
    fn replace_all_sessions(&self, new: HashMap<String, AgentActivity>) {
        let mut inner = self.inner.lock().unwrap();
        inner.activities = new;
    }

    /// Lock inner, collect orphaned session ids (those not in `file_ids`),
    /// then remove them. Returns the removed ids for logging.
    fn remove_orphaned_sessions(
        &self,
        file_ids: &std::collections::HashSet<String>,
    ) -> Vec<String> {
        let mut inner = self.inner.lock().unwrap();
        let orphaned: Vec<String> = inner
            .activities
            .keys()
            .filter(|id| !file_ids.contains(*id))
            .cloned()
            .collect();
        for id in &orphaned {
            inner.activities.remove(id);
        }
        orphaned
    }
}

impl ActivityAggregator {
    pub fn new(sessions_dir: String, stale_timeout_sec: u64) -> Self {
        let (tx, _) = broadcast::channel(16);
        Self {
            inner: Mutex::new(Inner {
                activities: HashMap::new(),
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

    /// Update an agent's activity from a hook event.
    pub fn update(
        &self,
        session_id: &str,
        state: &str,
        dialogue: &str,
        source: &str,
        is_terminal: bool,
    ) {
        // Single lock acquisition: insert/remove + aggregate under one hold,
        // then broadcast outside the lock to avoid blocking other callers.
        let change = {
            let mut inner = self.inner.lock().unwrap();

            if is_terminal {
                inner.activities.remove(session_id);
            } else {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs();
                inner.activities.insert(
                    session_id.to_string(),
                    AgentActivity {
                        state: state.to_string(),
                        dialogue: dialogue.to_string(),
                        source: source.to_string(),
                        is_terminal: false,
                        updated_at: now,
                    },
                );
            }

            Self::compute_change(&mut inner)
        };

        // File deletion and broadcast outside the lock
        if is_terminal {
            let path = PathBuf::from(&self.sessions_dir).join(format!("{}.json", session_id));
            let _ = std::fs::remove_file(path);
        }
        if let Some(change) = change {
            let _ = self.tx.send(change);
        }
    }

    /// Remove an agent's activity iff it is still in `expected_state`.
    ///
    /// Used for the Stop-delayed cleanup: when a Stop arrives we schedule a
    /// removal ~2s later so the "搞定啦" celebration is visible, but only
    /// commit it if the session is *still* in the Stop state ("jumping") when
    /// the timer fires. If a fresh event (UserPromptSubmit, PreToolUse, …)
    /// updated the activity in the meantime, its state changed and this is a
    /// no-op — the live activity survives. This cancellation-by-state check is
    /// why the cleanup lives in the backend (a long-lived process) rather than
    /// in the short-lived hook script, whose timer would never fire.
    pub fn remove_if_state(&self, session_id: &str, expected_state: &str) -> bool {
        let removed = {
            let mut inner = self.inner.lock().unwrap();
            let matches = inner
                .activities
                .get(session_id)
                .map(|s| s.state == expected_state)
                .unwrap_or(false);
            if matches {
                inner.activities.remove(session_id);
                true
            } else {
                false
            }
        };
        if removed {
            let path = PathBuf::from(&self.sessions_dir).join(format!("{}.json", session_id));
            let _ = std::fs::remove_file(path);
            self.aggregate_and_notify();
        }
        removed
    }

    /// Load all session files from disk.
    pub fn load_from_disk(&self) {
        let read_dir = match std::fs::read_dir(&self.sessions_dir) {
            Ok(d) => d,
            Err(_) => return,
        };

        let mut loaded: HashMap<String, AgentActivity> = HashMap::new();
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

            // Parse date from JSON (kept for the in-memory struct; not used for staleness).
            let updated_at = json["updatedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp() as u64)
                .unwrap_or(0);

            // Skip stale files using filesystem mtime — single source of truth
            // for staleness, shared with `cleanup_stale`.
            if is_session_file_stale(&path, now, self.stale_timeout_sec) {
                continue;
            }

            loaded.insert(
                file_stem,
                AgentActivity {
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

    /// Manual "purge all" — delete every `.json` file under the sessions dir
    /// and wipe the in-memory activities map. Triggered by the frontend's
    /// triple-click interaction regardless of file mtime; the user is asking
    /// for a clean slate on demand. Returns the number of files deleted so
    /// the renderer can surface a per-call count in the bubble.
    ///
    /// Warning: this kills active agents' session state on disk. They will
    /// appear idle to the renderer until they fire their next event, at which
    /// point their entry is recreated from the new file.
    pub fn purge_all(&self) -> usize {
        let read_dir = match std::fs::read_dir(&self.sessions_dir) {
            Ok(d) => d,
            Err(_) => return 0,
        };

        let mut deleted_ids: Vec<String> = Vec::new();

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                deleted_ids.push(stem.to_string());
            }
            let _ = std::fs::remove_file(&path);
        }

        let count = deleted_ids.len();
        if count > 0 {
            {
                let mut inner = self.inner.lock().unwrap();
                for id in &deleted_ids {
                    inner.activities.remove(id);
                }
            }
            info!("Purged all {} session files: {:?}", count, deleted_ids);
            self.aggregate_and_notify();
        }
        count
    }

    /// Clean up activities whose files have been deleted (memory-orphans),
    /// AND delete session files whose mtime exceeds `stale_timeout_sec` (disk-orphans).
    /// The disk-side cleanup is the backstop for crashed agents that never fire
    /// Stop — without it, files would accumulate until app restart.
    pub fn cleanup_stale(&self) {
        let read_dir = match std::fs::read_dir(&self.sessions_dir) {
            Ok(d) => d,
            Err(_) => return,
        };

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let mut file_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut stale_on_disk: usize = 0;

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let file_stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            if is_session_file_stale(&path, now, self.stale_timeout_sec) {
                // Stale file on disk → delete the file. The corresponding memory
                // entry (if any) becomes an orphan and is dropped below by
                // remove_orphaned_sessions, since the file no longer exists.
                let _ = std::fs::remove_file(&path);
                stale_on_disk += 1;
                continue;
            }

            file_ids.insert(file_stem);
        }

        // Activities in memory with no surviving file → drop. This covers both
        // legacy orphan-in-memory (file deleted externally) and the just-deleted
        // stale-on-disk cases.
        let orphaned = self.remove_orphaned_sessions(&file_ids);

        if !orphaned.is_empty() || stale_on_disk > 0 {
            info!(
                "Cleaned up {} memory-orphans, {} disk-orphans",
                orphaned.len(),
                stale_on_disk
            );
            self.aggregate_and_notify();
        }
    }

    /// Incremental reconciliation against disk — the file watcher's consumption
    /// path. Brings in activities that exist on disk but are missing from memory
    /// (covers events the socket channel missed), and prunes residue files the
    /// socket channel would otherwise have deleted (terminal files, and one-shot
    /// celebrations whose display window has elapsed).
    ///
    /// Activities already in memory are NEVER overwritten: the socket channel is
    /// authoritative and always at least as fresh as the file (both originate
    /// from the same hook payload, but the socket arrives without the watcher's
    /// debounce delay). The file channel exists only to backfill gaps and clear
    /// residue — replacing the old "replace_all on every change" that did O(n)
    /// reads per event and could clobber socket-fresh state.
    ///
    /// Contrast with `load_from_disk`, the startup full reload.
    pub fn reconcile_with_disk(&self) {
        let read_dir = match std::fs::read_dir(&self.sessions_dir) {
            Ok(d) => d,
            Err(_) => return,
        };

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // Stage all disk reads outside the lock; apply under one short lock.
        let mut to_insert: Vec<(String, AgentActivity)> = Vec::new();
        let mut to_remove: Vec<String> = Vec::new();
        let mut files_pruned = 0usize;

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };

            let data = match std::fs::read_to_string(&path) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let json: serde_json::Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let is_terminal = json["isTerminal"].as_bool().unwrap_or(false);

            // Terminal residue: `update()` deletes these on sight over the
            // socket channel. A file still on disk means socket missed the
            // event — do its job so the dead agent stops showing.
            if is_terminal {
                let _ = std::fs::remove_file(&path);
                to_remove.push(stem);
                files_pruned += 1;
                continue;
            }

            // Stale by mtime — leave for cleanup_stale (its TTL backstop).
            if is_session_file_stale(&path, now, self.stale_timeout_sec) {
                continue;
            }

            let state = json["state"].as_str().unwrap_or("idle").to_string();

            // One-shot celebration whose display window has elapsed. The socket
            // channel clears these via `remove_if_state` ~2s after Stop; if
            // socket is down, the pet would otherwise stay stuck "jumping".
            if is_oneshot_state(&state)
                && now.saturating_sub(file_mtime_secs(&path)) > ONESHOT_DISPLAY_WINDOW_SEC
            {
                let _ = std::fs::remove_file(&path);
                to_remove.push(stem);
                files_pruned += 1;
                continue;
            }

            let dialogue = json["dialogue"].as_str().unwrap_or("").to_string();
            let source = json["source"].as_str().unwrap_or("").to_string();
            let updated_at = json["updatedAt"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp() as u64)
                .unwrap_or(0);

            to_insert.push((
                stem,
                AgentActivity {
                    state,
                    dialogue,
                    source,
                    is_terminal: false,
                    updated_at,
                },
            ));
        }

        // Apply under one lock. Insert is idempotent against a fresher socket
        // update: if the socket channel populated `id` while we read disk,
        // skip — never let a stale disk read clobber authoritative socket state.
        let mut backfilled = 0usize;
        let mut removed = 0usize;
        {
            let mut inner = self.inner.lock().unwrap();
            for id in &to_remove {
                if inner.activities.remove(id).is_some() {
                    removed += 1;
                }
            }
            for (id, act) in to_insert {
                if inner.activities.contains_key(&id) {
                    continue;
                }
                inner.activities.insert(id, act);
                backfilled += 1;
            }
        }

        if backfilled > 0 || removed > 0 {
            info!(
                "Reconciled disk: {} backfilled, {} memory entries removed, {} residue files pruned",
                backfilled, removed, files_pruned
            );
            self.aggregate_and_notify();
        }
    }

    /// Compute aggregated state change from the current activities.
    /// Returns `Some(StateChange)` if the display state actually changed, `None` otherwise.
    fn compute_change(inner: &mut Inner) -> Option<StateChange> {
        if inner.activities.is_empty() {
            let changed = inner.aggregated.current_state != "idle"
                || !inner.aggregated.current_dialogue.is_empty()
                || inner.aggregated.active_count != 0;
            inner.aggregated.current_state = "idle".to_string();
            inner.aggregated.current_dialogue = String::new();
            inner.aggregated.active_count = 0;

            if changed {
                return Some(StateChange {
                    state: "idle".to_string(),
                    dialogue: String::new(),
                    active_count: 0,
                });
            }
            return None;
        }

        let mut best: Option<&AgentActivity> = None;
        let mut best_priority = -1i32;

        for s in inner.activities.values() {
            let priority = get_priority(&s.state);
            if priority > best_priority {
                best_priority = priority;
                best = Some(s);
            }
        }

        let new_state = best
            .map(|s| s.state.clone())
            .unwrap_or_else(|| "idle".to_string());
        let new_dialogue = best.map(|s| s.dialogue.clone()).unwrap_or_default();
        let new_count = inner.activities.len();

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

            Some(StateChange {
                state: new_state,
                dialogue: new_dialogue,
                active_count: new_count,
            })
        } else {
            None
        }
    }

    /// Aggregate all activities and broadcast if changed.
    fn aggregate_and_notify(&self) {
        let change = self.inner.lock().unwrap().aggregate();
        if let Some(change) = change {
            let _ = self.tx.send(change);
        }
    }
}

/// Helper methods on Inner for aggregation.
impl Inner {
    /// Compute and return state change (called while the lock is held).
    fn aggregate(&mut self) -> Option<StateChange> {
        ActivityAggregator::compute_change(self)
    }
}
