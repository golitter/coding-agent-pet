# Bug：Stop 后宠物卡在 jumping、session 文件一直不删

## 现象

Codex/Claude Code 完成一轮响应（`Stop`）后，宠物长时间停在跳跃庆祝"搞定啦！✨"不回 idle，对应的 `runtime/sessions/<id>.json` 也迟迟不被删除——远超预期的几秒钟。

## 复现快照

本地时间 2026-06-13 22:32（UTC 14:32），`runtime/sessions/` 中的残留文件：

| session_id | state | event | updatedAt (UTC) | 距观察时 | isTerminal |
|---|---|---|---|---|---|
| `019ec14f-14a6-7193-a89c-8fcbcc7a2aa9` | `jumping` | `Stop` | 14:32:04 | **~10 分钟** | `false` |

```json
{
  "state": "jumping", "dialogue": "搞定啦！✨", "event": "Stop",
  "source": "codex", "isTerminal": false,
  "updatedAt": "2026-06-13T14:32:04.907440+00:00"
}
```

按设计，`Stop` 产生的 `jumping` 是一次性庆祝，应在显示窗口（`ONESHOT_DISPLAY_WINDOW_SEC = 5s`）后清除。但该文件 10 分钟后仍在磁盘上，宠物也卡在 jumping。

## 根因

`Stop` 不在 `terminal_events`（仅 `StopFailure` / `SessionEnd`），故 `isTerminal=false`，不会走"立即删除"路径。它的清理依赖两条通道，但**两条都有盲区**：

### 根因 1（核心）：5s 窗口检查是"被动"的，没有时钟驱动

[aggregator.rs](../../cross-platform/src-tauri/src/aggregator.rs) 的 `reconcile_paths()` 里有 5s 窗口检查：

```rust
if is_oneshot_state(&state)
    && now.saturating_sub(file_mtime_secs(&path)) > ONESHOT_DISPLAY_WINDOW_SEC
{
    let _ = std::fs::remove_file(&path);
    ...
}
```

注释写明本意是 *"if socket is down, the pet would otherwise stay stuck jumping"*。但 `reconcile_paths` **只在文件发生文件系统事件时才被调用**（文件 watcher 防抖后触发）。一个 `Stop` 写完文件后**再也没人动它**，所以这个兜底检查**永远不会触发**——`ONESHOT_DISPLAY_WINDOW_SEC` 这个常量实际是"死"的。

### 根因 2：socket 通道的 2s 删除依赖应用在线

[watcher.rs](../../cross-platform/src-tauri/src/watcher.rs) 收到 `Stop` 后调度一个 2s 的 `remove_if_state("jumping")` 定时器删除文件。但前提是 hook 的 `push_socket` 成功送达——而 [common.py](../../cross-platform/hooks/scripts/common.py) 里 `if not os.path.exists(socket_path): return` 是**静默失败**的。

**本次复现的触发条件**：`Stop` 发生时（14:32）Tauri 应用未在运行 → socket 无人接收 → 2s 定时器从未启动 → 文件残留。应用之后启动时，`load_from_disk()` 又把这个过期文件当作活动状态加载进来（它只看 `stale_timeout_sec=3600` 阈值），于是宠物卡在 jumping。

### 根因 3：周期清理用的是 1h 阈值，管不到一次性文件

`cleanup_stale` 每 `cleanup_interval_sec`（30s）跑一次，但只用 `stale_timeout_sec`（1h）判定。所以这种 jumping 文件要等约 1 小时才会被它清掉。

## 方案

让**时钟驱动**的两个入口真正强制执行 5s 窗口，新增共享辅助函数 `prune_expired_oneshot()`（读文件确认仍是 `jumping`/`waving` 且 mtime 超过窗口才删）：

1. **`load_from_disk()`（启动加载）**：遇到已过期的 `jumping`/`waving` 文件直接删除并跳过——**重启即清，且不会把过期庆祝当活动状态重新加载**。
2. **`cleanup_stale()`（周期定时器）**：扫描时顺带清理超过 5s 窗口的 `jumping`/`waving` 文件——应用运行时 ≤ ~30s 内兜底清除。
3. `reconcile_paths()` 保持原样（被动清理仍有效）。

修复后的删除时机：

| 场景 | 删除延迟 |
|---|---|
| 应用在线，socket 正常送达 Stop（常见） | ~2s（socket 通道 `remove_if_state`） |
| 应用在线，但 socket 漏了那次 Stop | ≤ ~30s（`cleanup_stale` 兜底） |
| 应用当时没开，之后重启 | 立即（`load_from_disk` 启动即清） |

## 实施清单

- [x] 新增 `prune_expired_oneshot(path, now)` 辅助函数
- [x] `load_from_disk()` 跳过并删除过期 oneshot 文件
- [x] `cleanup_stale()` 周期清理过期 oneshot 文件（新增 `oneshot_pruned` 计数与日志）
- [x] 单元测试：`load_from_disk_prunes_expired_oneshot_file`、`cleanup_stale_prunes_expired_oneshot_but_keeps_others`
- 相关提交：`ccb24c3 fix: Stop/jumping 会话文件过期后由时钟驱动清理`
