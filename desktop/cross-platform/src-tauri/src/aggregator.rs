//! 活动聚合器——持有当前每个正在产生事件的 AI agent 进程
//! （Claude Code / Codex / …）的实时视图，并将它们汇总为宠物渲染器使用的
//! 单一显示状态。
//!
//! 命名说明：线上协议与磁盘上的文件名仍使用 `session_id`
//! （例如 `019ea736-...json`），因为该标识符归 agent 所有。
//! 然而在内部，我们追踪的是 *agent 当前的活动*
//! （running / waiting / jumping / …），而非长期存活的会话。因此内存模型
//! 使用 `ActivityAggregator` + `AgentActivity`。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;
use tracing::info;

/// 多 agent 活动汇总时的状态优先级顺序。
/// 数字越大优先级越高。仅作参考保留；get_priority 用 match 实现 O(1) 查找。
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

/// 路径的文件系统 mtime，以 unix 秒为单位（不可用时为 0）。
/// 使用 mtime（事实来源），而非 JSON 的 `updatedAt` 字段——在 `common.py`
/// 执行原子 `os.replace()` 写入后，文件系统才反映真实情况。
fn file_mtime_secs(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 当会话文件的文件系统 mtime 比 `timeout` 秒更旧时，即视为陈旧。
fn is_session_file_stale(path: &Path, now: u64, timeout: u64) -> bool {
    now.saturating_sub(file_mtime_secs(path)) > timeout
}

/// 播放一次后即还原的状态（庆祝动画）。其会话文件不应在显示窗口之后继续残留——
/// 见 `reconcile_with_disk`。
fn is_oneshot_state(state: &str) -> bool {
    state == "jumping" || state == "waving"
}

/// 一次性庆祝文件在磁盘上允许存活的最长时间，超过后由文件监视器的对账清除。
/// 相比 socket 通道 2s 的 `remove_if_state` 延迟更宽松，以便动画即使在高负载下也能播完。
const ONESHOT_DISPLAY_WINDOW_SEC: u64 = 5;

/// 当一次性庆祝文件（jumping/waving）的显示窗口已过时，删除该文件。
/// 会重新读取文件以检查其 `state`，因此调用方应仅对 mtime 显然已过窗口的路径
/// 调用它——下面的廉价 mtime 预检会跳过对新文件的读取。
///
/// 这是 Stop / SessionEnd 庆祝的*时钟驱动*兜底机制。
/// socket 通道通常在事件后约 2s 删除这些文件，但若事件发生时应用已关闭
/// （或 socket 推送静默失败），则没有任何东西会再次触及该文件，因此
/// *反应式* `reconcile_paths` 检查永远不会触发。周期性的 `cleanup_stale`
/// 扫描会调用本函数，使这类残留物在 `cleanup_interval_sec` 内被清除，
/// 而非残留至 `stale_timeout_sec`（1h）。
fn prune_expired_oneshot(path: &Path, now: u64) -> bool {
    if now.saturating_sub(file_mtime_secs(path)) <= ONESHOT_DISPLAY_WINDOW_SEC {
        return false;
    }
    let data = match std::fs::read_to_string(path) {
        Ok(d) => d,
        Err(_) => return false,
    };
    let json: serde_json::Value = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let state = json["state"].as_str().unwrap_or("");
    if is_oneshot_state(state) {
        std::fs::remove_file(path).is_ok()
    } else {
        false
    }
}

#[derive(Debug, Clone)]
pub struct AgentActivity {
    pub state: String,
    pub dialogue: String,
    pub event: String,
    #[allow(dead_code)]
    pub source: String,
    #[allow(dead_code)]
    pub is_terminal: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StateChange {
    pub state: String,
    pub dialogue: String,
    pub event: String,
    pub active_count: usize,
    pub pending_permission_count: usize,
    pub pending_permission_version: u64,
}

/// 汇总后的显示状态——由单个 Mutex 保护以防死锁。
struct AggregatedState {
    current_state: String,
    current_dialogue: String,
    current_event: String,
    active_count: usize,
    pending_permission_count: usize,
    pending_permission_version: u64,
    pending_permission_sessions: HashSet<String>,
}

/// 所有可变状态都位于同一个 Mutex 之后。map 的键是 agent 的 session_id
/// （这里保留为 `String` 以遵从线上协议命名）。
struct Inner {
    activities: HashMap<String, AgentActivity>,
    aggregated: AggregatedState,
}

/// 将多个并发 AI agent 的实时活动聚合为宠物渲染器使用的单一显示状态。
pub struct ActivityAggregator {
    inner: Mutex<Inner>,
    sessions_dir: String,
    stale_timeout_sec: u64,
    tx: broadcast::Sender<StateChange>,
}

// ── 访问 `inner.activities` 的便捷辅助函数 ──

impl ActivityAggregator {
    /// 加锁并将所有活动原子替换。
    fn replace_all_sessions(&self, new: HashMap<String, AgentActivity>) {
        let mut inner = self.inner.lock().unwrap();
        inner.activities = new;
    }

    /// 加锁，收集孤立会话 id（不在 `file_ids` 中的那些），然后删除它们。
    /// 返回被删除的 id 以供日志记录。
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
                    current_event: String::new(),
                    active_count: 0,
                    pending_permission_count: 0,
                    pending_permission_version: 0,
                    pending_permission_sessions: HashSet::new(),
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

    /// 根据 hook 事件更新某个 agent 的活动。
    pub fn update(
        &self,
        session_id: &str,
        state: &str,
        dialogue: &str,
        event: &str,
        source: &str,
        is_terminal: bool,
    ) {
        // 单次加锁：插入/删除 + 汇总在一次持有内完成，然后在锁外广播以避免阻塞其他调用方。
        let change = {
            let mut inner = self.inner.lock().unwrap();

            if is_terminal {
                inner.activities.remove(session_id);
            } else {
                inner.activities.insert(
                    session_id.to_string(),
                    AgentActivity {
                        state: state.to_string(),
                        dialogue: dialogue.to_string(),
                        event: event.to_string(),
                        source: source.to_string(),
                        is_terminal: false,
                    },
                );
            }

            Self::compute_change(&mut inner)
        };

        // 文件删除与广播在锁外进行
        if is_terminal {
            let path = PathBuf::from(&self.sessions_dir).join(format!("{}.json", session_id));
            let _ = std::fs::remove_file(path);
        }
        if let Some(change) = change {
            let _ = self.tx.send(change);
        }
    }

    /// 仅当某 agent 的活动仍处于 `expected_state` 时才删除它。
    ///
    /// 用于 Stop 延迟清理：当 Stop 到达时，我们调度约 2s 后的删除，以便
    /// “搞定啦”庆祝可见；但仅当定时器触发时会话*仍*处于 Stop 状态（"jumping"）
    /// 时才提交删除。若在此期间有新事件（UserPromptSubmit、PreToolUse、…）更新了
    /// 活动，则其状态已改变，本次删除为空操作——实时活动得以保留。正是这种
    /// 按状态判定的取消逻辑，使得清理逻辑应放在后端（长生命周期进程）中，而非
    /// 短生命周期的 hook 脚本里——后者的定时器根本不会触发。
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

    /// 从磁盘加载所有会话文件。
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
            let event = json["event"].as_str().unwrap_or("").to_string();
            let source = json["source"].as_str().unwrap_or("").to_string();
            let is_terminal = json["isTerminal"].as_bool().unwrap_or(false);

            if is_terminal {
                continue;
            }

            // 使用文件系统 mtime 跳过陈旧文件——陈旧判定的唯一事实来源，
            // 与 `cleanup_stale` 共用。
            if is_session_file_stale(&path, now, self.stale_timeout_sec) {
                continue;
            }

            // 显示窗口已过的一次性庆祝文件。否则在（重新）启动时它们会作为
            // 活动的 "jumping"/"waving" 宠物复活；删除残留并跳过加载。
            // 这覆盖了 Stop 文件残留的常见原因：Stop 触发时应用已关闭，
            // 因此 socket 通道约 2s 的删除从未执行，此后也没有任何东西再触及该文件。
            if is_oneshot_state(&state)
                && now.saturating_sub(file_mtime_secs(&path)) > ONESHOT_DISPLAY_WINDOW_SEC
            {
                let _ = std::fs::remove_file(&path);
                continue;
            }

            loaded.insert(
                file_stem,
                AgentActivity {
                    state,
                    dialogue,
                    event,
                    source,
                    is_terminal: false,
                },
            );
        }

        self.replace_all_sessions(loaded);
        self.aggregate_and_notify();
    }

    /// 手动“全部清除”——删除会话目录下的每个 `.json` 文件，并清空内存中的活动 map。
    /// 由前端三连击交互触发，无视文件 mtime；用户是在按需要求一个干净的起点。
    /// 返回被删除的文件数，以便渲染器在气泡中展示本次调用的计数。
    ///
    /// 警告：这会清除活动 agent 在磁盘上的会话状态。在它们触发下一个事件之前，
    /// 渲染器会看到它们处于空闲态；触发下一个事件后，其条目会从新文件重新创建。
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

    /// 清理文件已被删除的活动（内存孤立项），并删除 mtime 超过 `stale_timeout_sec`
    /// 的会话文件（磁盘孤立项）。磁盘侧清理是为崩溃后从不触发 Stop 的 agent 准备的
    /// 兜底机制——否则文件会一直累积直到应用重启。
    pub fn cleanup_stale(&self) {
        let read_dir = match std::fs::read_dir(&self.sessions_dir) {
            Ok(d) => d,
            Err(_) => return,
        };

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let mut file_ids: HashSet<String> = HashSet::new();
        let mut stale_on_disk: usize = 0;
        let mut oneshot_pruned: usize = 0;

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
                // 磁盘上的陈旧文件 → 删除该文件。对应的内存条目（若有）成为孤立项，
                // 因文件已不存在，会在下面由 remove_orphaned_sessions 丢弃。
                let _ = std::fs::remove_file(&path);
                stale_on_disk += 1;
                continue;
            }

            // 超过显示窗口仍残留的一次性庆祝文件——这是反应式 reconcile_paths
            // 检查无法单独提供的时钟驱动兜底（见 `prune_expired_oneshot`）。
            // 若没有它，事件发生时应用已关闭而遗留的 Stop 文件将存活到
            // `stale_timeout_sec`（1h）。
            if prune_expired_oneshot(&path, now) {
                oneshot_pruned += 1;
                continue;
            }

            file_ids.insert(file_stem);
        }

        // 内存中没有对应存活文件的活动 → 丢弃。这既覆盖旧的内存孤立项（文件被外部删除），
        // 也覆盖刚刚被删除的磁盘陈旧文件情形。
        let orphaned = self.remove_orphaned_sessions(&file_ids);

        if !orphaned.is_empty() || stale_on_disk > 0 || oneshot_pruned > 0 {
            info!(
                "Cleaned up {} memory-orphans, {} disk-orphans, {} expired oneshot files",
                orphaned.len(),
                stale_on_disk,
                oneshot_pruned
            );
            self.aggregate_and_notify();
        }
    }

    /// 针对监视器上报的具体文件进行增量对账。这使热路径上的文件系统工作
    /// 与变更文件的数量成正比，而非每次事件突发都重新扫描并重新解析整个会话目录。
    pub fn reconcile_paths(&self, paths: Vec<PathBuf>) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let mut to_upsert: Vec<(String, AgentActivity)> = Vec::new();
        let mut to_remove: Vec<String> = Vec::new();
        let mut files_pruned = 0usize;

        for path in paths {
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };

            if !path.exists() {
                to_remove.push(stem);
                continue;
            }

            let data = match std::fs::read_to_string(&path) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let json: serde_json::Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let is_terminal = json["isTerminal"].as_bool().unwrap_or(false);

            // 终态残留：`update()` 在 socket 通道上一旦发现这些就会立即删除。
            // 仍有文件在磁盘上意味着 socket 漏掉了该事件——替它完成清理，
            // 让已死的 agent 不再显示。
            if is_terminal {
                let _ = std::fs::remove_file(&path);
                to_remove.push(stem);
                files_pruned += 1;
                continue;
            }

            // 按 mtime 判定陈旧——这里也一并修剪，避免变更过的陈旧文件
            // 在内存中残留到下一次周期性清理。
            if is_session_file_stale(&path, now, self.stale_timeout_sec) {
                let _ = std::fs::remove_file(&path);
                to_remove.push(stem);
                files_pruned += 1;
                continue;
            }

            let state = json["state"].as_str().unwrap_or("idle").to_string();

            // 显示窗口已过的一次性庆祝文件。socket 通道会在 Stop 后约 2s 通过
            // `remove_if_state` 清除这些文件；若 socket 宕机，否则宠物会一直卡在
            // "jumping"。
            if is_oneshot_state(&state)
                && now.saturating_sub(file_mtime_secs(&path)) > ONESHOT_DISPLAY_WINDOW_SEC
            {
                let _ = std::fs::remove_file(&path);
                to_remove.push(stem);
                files_pruned += 1;
                continue;
            }

            let dialogue = json["dialogue"].as_str().unwrap_or("").to_string();
            let event = json["event"].as_str().unwrap_or("").to_string();
            let source = json["source"].as_str().unwrap_or("").to_string();
            to_upsert.push((
                stem,
                AgentActivity {
                    state,
                    dialogue,
                    event,
                    source,
                    is_terminal: false,
                },
            ));
        }

        let mut upserted = 0usize;
        let mut removed = 0usize;
        {
            let mut inner = self.inner.lock().unwrap();
            for id in &to_remove {
                if inner.activities.remove(id).is_some() {
                    removed += 1;
                }
            }
            for (id, act) in to_upsert {
                let changed = inner
                    .activities
                    .get(&id)
                    .map(|existing| {
                        existing.state != act.state
                            || existing.dialogue != act.dialogue
                            || existing.event != act.event
                            || existing.source != act.source
                    })
                    .unwrap_or(true);
                if changed {
                    inner.activities.insert(id, act);
                    upserted += 1;
                }
            }
        }

        if upserted > 0 || removed > 0 {
            info!(
                "Reconciled changed paths: {} entries upserted, {} memory entries removed, {} residue files pruned",
                upserted, removed, files_pruned
            );
            self.aggregate_and_notify();
        }
    }

    /// 根据当前活动计算汇总后的状态变更。若显示状态确有变化则返回
    /// `Some(StateChange)`，否则返回 `None`。
    fn compute_change(inner: &mut Inner) -> Option<StateChange> {
        if inner.activities.is_empty() {
            let changed = inner.aggregated.current_state != "idle"
                || !inner.aggregated.current_dialogue.is_empty()
                || !inner.aggregated.current_event.is_empty()
                || inner.aggregated.active_count != 0
                || inner.aggregated.pending_permission_count != 0;
            inner.aggregated.current_state = "idle".to_string();
            inner.aggregated.current_dialogue = String::new();
            inner.aggregated.current_event = String::new();
            inner.aggregated.active_count = 0;
            inner.aggregated.pending_permission_count = 0;
            if !inner.aggregated.pending_permission_sessions.is_empty() {
                inner.aggregated.pending_permission_version =
                    inner.aggregated.pending_permission_version.wrapping_add(1);
                inner.aggregated.pending_permission_sessions.clear();
            }

            if changed {
                return Some(StateChange {
                    state: "idle".to_string(),
                    dialogue: String::new(),
                    event: String::new(),
                    active_count: 0,
                    pending_permission_count: 0,
                    pending_permission_version: inner.aggregated.pending_permission_version,
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
        let new_event = best.map(|s| s.event.clone()).unwrap_or_default();
        let new_count = inner.activities.len();
        let new_pending_permission_sessions: HashSet<String> = inner
            .activities
            .iter()
            .filter(|&(_, s)| s.state == "waiting" && s.event == "PermissionRequest")
            .map(|(id, _)| id.clone())
            .collect();
        let new_pending_permission_count = new_pending_permission_sessions.len();
        let pending_permission_sessions_changed =
            inner.aggregated.pending_permission_sessions != new_pending_permission_sessions;
        let new_pending_permission_version = if pending_permission_sessions_changed {
            inner.aggregated.pending_permission_version.wrapping_add(1)
        } else {
            inner.aggregated.pending_permission_version
        };

        let changed = inner.aggregated.current_state != new_state
            || inner.aggregated.current_dialogue != new_dialogue
            || inner.aggregated.current_event != new_event
            || inner.aggregated.active_count != new_count
            || inner.aggregated.pending_permission_count != new_pending_permission_count
            || pending_permission_sessions_changed;

        if changed {
            inner.aggregated.current_state = new_state.clone();
            inner.aggregated.current_dialogue = new_dialogue.clone();
            inner.aggregated.current_event = new_event.clone();
            inner.aggregated.active_count = new_count;
            inner.aggregated.pending_permission_count = new_pending_permission_count;
            inner.aggregated.pending_permission_version = new_pending_permission_version;
            inner.aggregated.pending_permission_sessions = new_pending_permission_sessions;

            info!(
                "state={} dialogue=\"{}\" active={}",
                new_state, new_dialogue, new_count
            );

            Some(StateChange {
                state: new_state,
                dialogue: new_dialogue,
                event: new_event,
                active_count: new_count,
                pending_permission_count: new_pending_permission_count,
                pending_permission_version: new_pending_permission_version,
            })
        } else {
            None
        }
    }

    /// 汇总所有活动，若发生变化则广播。
    fn aggregate_and_notify(&self) {
        let change = self.inner.lock().unwrap().aggregate();
        if let Some(change) = change {
            let _ = self.tx.send(change);
        }
    }
}

/// Inner 上的聚合辅助方法。
impl Inner {
    /// 计算并返回状态变更（在持有锁时调用）。
    fn aggregate(&mut self) -> Option<StateChange> {
        ActivityAggregator::compute_change(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("kotori-pet-aggregator-{label}-{unique}"))
    }

    fn write_session_file(dir: &Path, session_id: &str, state: &str, dialogue: &str) -> PathBuf {
        let path = dir.join(format!("{session_id}.json"));
        let payload = serde_json::json!({
            "state": state,
            "dialogue": dialogue,
            "event": "PermissionRequest",
            "source": "codex",
            "isTerminal": false
        });
        fs::write(&path, serde_json::to_string(&payload).unwrap()).unwrap();
        path
    }

    #[test]
    fn reconcile_paths_overwrites_existing_activity_from_disk() {
        let dir = temp_dir("reconcile");
        fs::create_dir_all(&dir).unwrap();

        let aggregator = ActivityAggregator::new(dir.to_string_lossy().to_string(), 3600);
        aggregator.update(
            "session-1",
            "running",
            "处理中...",
            "PreToolUse",
            "codex",
            false,
        );

        let session_path = write_session_file(&dir, "session-1", "waiting", "需要你的授权～");
        aggregator.reconcile_paths(vec![session_path]);

        let inner = aggregator.inner.lock().unwrap();
        let activity = inner.activities.get("session-1").unwrap();
        assert_eq!(activity.state, "waiting");
        assert_eq!(activity.dialogue, "需要你的授权～");
        assert_eq!(activity.event, "PermissionRequest");
        assert_eq!(inner.aggregated.current_state, "waiting");
        assert_eq!(inner.aggregated.current_dialogue, "需要你的授权～");
        assert_eq!(inner.aggregated.current_event, "PermissionRequest");
        assert_eq!(inner.aggregated.active_count, 1);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn pending_permission_count_does_not_increase_for_non_permission_activity() {
        let dir = temp_dir("permission-count");
        fs::create_dir_all(&dir).unwrap();

        let aggregator = ActivityAggregator::new(dir.to_string_lossy().to_string(), 3600);
        aggregator.update(
            "permission-session",
            "waiting",
            "需要你的授权～",
            "PermissionRequest",
            "codex",
            false,
        );
        aggregator.update(
            "running-session",
            "running",
            "处理中...",
            "PreToolUse",
            "codex",
            false,
        );

        let inner = aggregator.inner.lock().unwrap();
        assert_eq!(inner.aggregated.current_state, "waiting");
        assert_eq!(inner.aggregated.current_event, "PermissionRequest");
        assert_eq!(inner.aggregated.active_count, 2);
        assert_eq!(inner.aggregated.pending_permission_count, 1);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn pending_permission_version_changes_when_pending_session_identity_changes() {
        let dir = temp_dir("permission-version");
        fs::create_dir_all(&dir).unwrap();

        let aggregator = ActivityAggregator::new(dir.to_string_lossy().to_string(), 3600);
        aggregator.update(
            "permission-a",
            "waiting",
            "需要你的授权～",
            "PermissionRequest",
            "codex",
            false,
        );

        let first_version = {
            let inner = aggregator.inner.lock().unwrap();
            assert_eq!(inner.aggregated.pending_permission_count, 1);
            inner.aggregated.pending_permission_version
        };

        aggregator.update(
            "permission-a",
            "running",
            "处理中...",
            "PreToolUse",
            "codex",
            false,
        );
        aggregator.update(
            "permission-b",
            "waiting",
            "需要你的授权～",
            "PermissionRequest",
            "codex",
            false,
        );

        let inner = aggregator.inner.lock().unwrap();
        assert_eq!(inner.aggregated.pending_permission_count, 1);
        assert_ne!(
            inner.aggregated.pending_permission_version, first_version,
            "version changes even when permission count remains the same"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn compute_change_emits_when_pending_permission_identity_changes() {
        let mut inner = Inner {
            activities: HashMap::new(),
            aggregated: AggregatedState {
                current_state: "waiting".to_string(),
                current_dialogue: "需要你的授权～".to_string(),
                current_event: "PermissionRequest".to_string(),
                active_count: 1,
                pending_permission_count: 1,
                pending_permission_version: 1,
                pending_permission_sessions: HashSet::from(["permission-a".to_string()]),
            },
        };
        inner.activities.insert(
            "permission-b".to_string(),
            AgentActivity {
                state: "waiting".to_string(),
                dialogue: "需要你的授权～".to_string(),
                event: "PermissionRequest".to_string(),
                source: "codex".to_string(),
                is_terminal: false,
            },
        );

        let change = ActivityAggregator::compute_change(&mut inner).unwrap();

        assert_eq!(change.pending_permission_count, 1);
        assert_eq!(change.pending_permission_version, 2);
        assert_eq!(
            inner.aggregated.pending_permission_sessions,
            HashSet::from(["permission-b".to_string()])
        );
    }

    /// 将文件 mtime 回拨 `secs` 秒，使其看起来已超出某个窗口。
    fn backdate_mtime(path: &Path, secs: u64) {
        let past = SystemTime::now() - Duration::from_secs(secs);
        let times = std::fs::FileTimes::new().set_modified(past);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(times)
            .unwrap();
    }

    #[test]
    fn load_from_disk_prunes_expired_oneshot_file() {
        let dir = temp_dir("oneshot-load");
        fs::create_dir_all(&dir).unwrap();

        // 一个 "jumping"（Stop 庆祝）文件，其 mtime 已超出窗口。
        let path = write_session_file(&dir, "stop-sess", "jumping", "搞定啦！✨");
        backdate_mtime(&path, ONESHOT_DISPLAY_WINDOW_SEC + 5);

        let aggregator = ActivityAggregator::new(dir.to_string_lossy().to_string(), 3600);
        aggregator.load_from_disk();

        // 文件已从磁盘删除，且未被加载为活动条目。
        assert!(!path.exists());
        let inner = aggregator.inner.lock().unwrap();
        assert!(!inner.activities.contains_key("stop-sess"));
        assert_eq!(inner.aggregated.current_state, "idle");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn cleanup_stale_prunes_expired_oneshot_but_keeps_others() {
        let dir = temp_dir("oneshot-cleanup");
        fs::create_dir_all(&dir).unwrap();

        let aggregator = ActivityAggregator::new(dir.to_string_lossy().to_string(), 3600);

        // 已过期的 "jumping" 文件 → 必须被修剪。
        let stop_path = write_session_file(&dir, "stop-sess", "jumping", "搞定啦！");
        backdate_mtime(&stop_path, ONESHOT_DISPLAY_WINDOW_SEC + 5);
        // 非 one-shot 的 "running" 文件 → 必须保留（stale_timeout 为 1h）。
        let run_path = write_session_file(&dir, "run-sess", "running", "处理中...");

        aggregator.cleanup_stale();

        assert!(!stop_path.exists(), "expired oneshot file should be pruned");
        assert!(run_path.exists(), "non-oneshot file should survive");

        let _ = fs::remove_dir_all(dir);
    }
}
