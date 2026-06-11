# Bug：同时开 N 个会话，宠物计数却显示 N-1

## 现象

用户开了 3 个 Claude/Codex 会话，但宠物气泡上的 `×N` 只显示 2。

## 复现快照

本地时间 2026-06-08 15:30:32（UTC 07:30:32），`runtime/sessions/` 中的近期会话：

| session_id | state | event | updatedAt (UTC) | 距今 | 是否计入 |
|---|---|---|---|---|---|
| `a4aca842…` | running | UserPromptSubmit | 07:30:30 | 2s | ✅ |
| `8681dd30…` | waiting | PermissionRequest | 07:30:19 | 13s | ✅ |
| `1b05615f…` | running | PreToolUse | 07:29:53 | 39s | ✅（卡在边缘，再过 21s 就过期）|
| `9fed130c…` | waving | SessionStart | 07:22:51 | **7m41s** | ❌ 已过期 |
| `019ea5b7…` / `019ea334…` | running | … | 昨天 | ~10h+ | ❌ 残留文件 |

理论计数 3，但 `1b05615f` 只剩 21s 寿命——一旦它对应的 `TaskOutput` 调用没在 60s 内返回，状态文件超过 stale 阈值，整个会话立即从内存里被踢出，气泡降到 ×2。

---

## 根因

两个独立但叠加的问题：

### 根因 1：`active_count` 把 `idle` 状态过滤掉了

[aggregator.rs](../../cross-platform/src-tauri/src/aggregator.rs)：

```rust
let new_count = inner
    .activities
    .values()
    .filter(|s| s.state != "idle")
    .count();
```

但 `idle` 不是"不存在"，而是**存在但低优先级**。在 [config.example.json](../../cross-platform/config.example.json) 中 `SubagentStop` 被映射为 `idle`：

```json
"SubagentStop": {"state": "idle", "dialogue": ""},
```

含义：一个 Claude 会话跑了 subagent，subagent 结束时主会话还活着，只是当前没在产出可见动作。这个会话**仍然算"开着"**，但被计数逻辑误判为"没在干活"而排除。

**概念混淆**：`active_count` 把"session 是否存在"和"session 是否在 visibly working"混在一起。state 仲裁用优先级表处理 idle 就够了（priority=1，本来就压不过任何其他状态），**计数不应该看它**。

### 根因 2：`stale_timeout_sec = 60s` 太激进

[config.example.json](../../cross-platform/config.example.json) `stale_timeout_sec` + [aggregator.rs](../../cross-platform/src-tauri/src/aggregator.rs) `is_session_file_stale()`：

```rust
fn is_session_file_stale(path: &Path, now: u64, timeout: u64) -> bool {
    now.saturating_sub(file_mtime_secs(path)) > timeout
}
```

并且 `load_from_disk()` 的 `replace_all_sessions(loaded)` 会**用磁盘读到的结果整体覆盖内存**——跳过 `is_terminal` 和 mtime 过期的文件。所有 >`stale_timeout_sec` 没动静的会话文件不会被加载到内存。

`stale_timeout_sec` 这个数字本质上是在选"宁可误判哪种"——它没法区分：

| 真实情况 | 文件表现 |
|---|---|
| 用户在阅读/思考/等慢工具，会话还活着 | 文件静静躺在那，无更新 |
| Claude/Codex 进程崩了 / 强制退出 | 文件静静躺在那，无更新 |

60s 选了"宁可误删活会话"，结果就是用户最常踩坑：读完一段输出再去打下一条 prompt，会话已经"死"过几回了。

典型超过 60s 的合法场景：
- 慢工具调用（编译、长测试套件、远程拉取、Workflow 编排多 agent）
- 用户在阅读 Claude 的输出
- 用户开会 / 吃饭 / 跑开会回来继续

---

## 修复方案

三处改动，互不依赖，组合应用。

### 改动 ① — `active_count` 不再过滤 `idle`

**文件**：[aggregator.rs](../../cross-platform/src-tauri/src/aggregator.rs)

**Before**：

```rust
let new_count = inner
    .activities
    .values()
    .filter(|s| s.state != "idle")
    .count();
```

**After**：

```rust
let new_count = inner.activities.len();
```

**语义**：气泡计数表示"当前存在的会话数"，不是"正在输出的会话数"。只要 session 在 HashMap 里（最近有证据它活着），就算 1 个。state 仲裁另算。

### 改动 ② — `stale_timeout_sec` 默认值改为 3600（1h）

**文件**：[config.example.json](../../cross-platform/config.example.json)

**Before**：

```json
"stale_timeout_sec": 60,
```

**After**：

```json
"stale_timeout_sec": 3600,
```

**改名/注释建议**：字段现在的命名容易让人误以为是"会话不再活跃的阈值"，但它的真实语义是"会话文件多久没更新就被视为该会话已死"。建议在 [config.rs](../../cross-platform/src-tauri/src/config.rs) 和 config.example.json 都加注释：

```text
// How long a session file can stay unchanged before being considered dead.
// 1h covers reading/thinking/long-tool-calls; crashes get cleaned up after this TTL.
```

字段名先不改（避免破坏现有 config 文件），只补注释。

**为什么是 1h**：

- 覆盖典型阅读/思考节奏——读完一段长输出、跑开会回来继续、吃个午饭接着干，1h 内都属于"会话还活着"，符合直觉
- 会话真在工作时几乎不会触发——任何 `PreToolUse` / `PostToolUse` / `UserPromptSubmit` 都会刷新 mtime，长 Workflow 里这俩事件密集，永远 fresh
- 副作用可控——崩掉的会话最多残留 1h，比 60s 误删活会话的体验好得多（前者只是计数虚高一会儿，后者是用户看到"明明开着 N 个窗口却只显示 N-1"）

**为什么不更长**：

- 8h+ 会把"过夜没关 Claude"这种真死会话一直留着，磁盘和计数都会脏
- 用户重启宠物 app 时也会拖累冷启动恢复

### 改动 ③ — `cleanup_stale` 加反向清理（删磁盘孤儿文件）

**文件**：[aggregator.rs](../../cross-platform/src-tauri/src/aggregator.rs) `cleanup_stale()`

**当前行为**：只清"内存有 / 磁盘无"的孤儿，不清磁盘上的陈旧文件。改动 ② 把 timeout 调到 1h 后，崩掉的会话文件会留 1h，磁盘和内存都会脏。

**新行为**：磁盘上有但 mtime > `stale_timeout_sec` 的孤儿文件也删掉（含磁盘文件 + 内存条目）。

**抽公共 helper**：原本 `load_from_disk` 用 JSON 内的 `updatedAt` 判定过期，`cleanup_stale` 又得自己写一遍 mtime 判定，两处逻辑容易分叉。抽一个工具函数共用：

```rust
/// A session file is stale if its mtime is older than `timeout` seconds.
/// Uses filesystem mtime (source of truth), not the JSON's updatedAt field.
fn is_session_file_stale(path: &Path, now: u64, timeout: u64) -> bool {
    let mtime = path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    now.saturating_sub(mtime) > timeout
}
```

`load_from_disk` 和 `cleanup_stale` 都走它，判定逻辑收敛到一处。

**cleanup_stale 伪代码**：

```rust
pub fn cleanup_stale(&self) {
    let read_dir = match std::fs::read_dir(&self.sessions_dir) {
        Ok(d) => d,
        Err(_) => return,
    };
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

    let mut file_ids: HashSet<String> = HashSet::new();
    let mut stale_on_disk: usize = 0;

    for entry in read_dir.flatten() {
        let path = entry.path();
        if /* not *.json */ { continue; }
        if is_session_file_stale(&path, now, self.stale_timeout_sec) {
            let _ = std::fs::remove_file(&path);
            stale_on_disk += 1;
            continue;
        }
        file_ids.insert(/* file_stem */);
    }

    // 内存中有但磁盘已无 → 清除孤儿
    let orphaned = self.remove_orphaned_sessions(&file_ids);

    if !orphaned.is_empty() || stale_on_disk > 0 {
        info!(
            "Cleaned up {} memory-orphans, {} disk-orphans",
            orphaned.len(), stale_on_disk
        );
        self.aggregate_and_notify();
    }
}
```

注意：磁盘 mtime 直接用 `metadata().modified()`，不需要 parse JSON 里的 `updatedAt`——文件系统本身就是真相。

---

## 实施清单

按这个顺序改，每步独立可验证：

- [x] 改动 ①：[aggregator.rs](../../cross-platform/src-tauri/src/aggregator.rs) `active_count = inner.activities.len()`
- [x] 改动 ②：[config.json](../../cross-platform/config.json) + [config.example.json](../../cross-platform/config.example.json) `stale_timeout_sec: 3600`，[config.rs](../../cross-platform/src-tauri/src/config.rs) 字段加文档注释，JSON 文件加 `_stale_timeout_sec_comment` 说明
- [x] 改动 ③：扩展 [aggregator.rs `cleanup_stale`](../../cross-platform/src-tauri/src/aggregator.rs)，抽 `is_session_file_stale` helper 让 `load_from_disk` 也共用
- [x] 更新 [renderer.md](../renderer.md) "清理机制"表格
- [x] 手动验证：
  - [x] 开 3 个会话，气泡稳定显示 ×3
  - [x] 杀掉其中一个（不触发 SessionEnd），等待 1h，确认被自动清理
  - [x] 触发 `SubagentStop`，确认主会话仍被计数

---

## 不做的事情

明确列出**考虑过但决定不做**的方案，避免后人反复纠结：

| 方案 | 不做的原因 |
|---|---|
| 进程存活探测（用 PID 判断 Claude/Codex 是否还活着） | hook 拿不到父 PID，要改 hook schema + 跨平台 `kill -0`，工程量过大。留作后续优化。|
| 冷启动 vs 运行时分开 timeout（app 启动那一刻用短 timeout 跳过陈旧文件，运行时用长 timeout） | 逻辑上更干净但代码复杂度上升一档。先靠 1h 统一 timeout 验证效果。|
| `SessionStart → waving` 后短期没动静降级到 `idle`（避免 waving 长时间占据高优先级状态） | 不是当前 bug 的根因，等真实痛点出现再加。|
| 改 `state_map` 把 `SubagentStop` 映射到非 idle 状态 | 错误地把"subagent 停了"伪装成"还在干活"，破坏状态仲裁语义。改动 ① 已经解决这个映射的副作用。|

---

## 风险

| 风险 | 缓解 |
|---|---|
| 1h 内崩掉的会话持续被计数，气泡虚高 | 改动 ③ 在 1h 后兜底清理 |
| 磁盘文件残留 1h 才被清，目录看起来"脏" | 改动 ③ 已覆盖；测试残留文件（`test-123.json` 等）需手动清一次 |
| 用户改了 `stale_timeout_sec` 但仍踩 60s 老坑 | config.example.json 已加 `_stale_timeout_sec_comment` 字段说明推荐值 |
