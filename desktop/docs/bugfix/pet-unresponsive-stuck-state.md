# Bug：Pet 有时无法移动或点击

## 现象

宠物运行一段时间后，偶尔出现完全无响应的情况——既无法点击（单击跳跃 / 三连击清理）、也无法拖动移动位置。需要重启进程才能恢复。

## 复现快照

- 问题在 hit-test（透明像素点击穿透）功能引入后出现
- 相关提交：`c18b503 feat(hit-test)` → `16e58b9 fix: 代码审查全面修复`

---

## 根因

### 根因 1（核心）：`pollTimerId` 过期残留导致轮询链永久断裂

[main.js](../../cross-platform/src/main.js) 的 `startPolling()` 中的 `tick()` 函数：

```js
const tick = async () => {
  if (!isPassThrough) return;  // ← 提前 return 时没有清 pollTimerId！
  await pollCursor();
  if (isPassThrough) {
    pollTimerId = setTimeout(tick, POLL_INTERVAL_MS);
  }
};
```

退出 pass-through 时，`exitPassThrough()` 先调 `stopPolling()` 清除当前 timer，但 tick 中的 `await pollCursor()` 返回后会再检查 `isPassThrough`——此时仍为 `true`（exit 是 async 的），于是又调度了一个新 tick。当 `exitPassThrough()` 最终完成后 `isPassThrough` 变 `false`，新 tick 执行到 `if (!isPassThrough) return` 直接返回，**但 `pollTimerId` 保留了已执行完的旧 timeout ID（非 null）**。

下次 `enterPassThrough()` → `startPolling()` 检查 `pollTimerId !== null` → **直接 return，轮询链永远无法重启**。窗口卡在 `setIgnoreCursorEvents(true)` 状态。

日志证据（修复前）：
```
11:46:28.550  [JS:Polling]: started — timer=6    ← 第一次 enter，轮询启动
11:46:28.633  [JS:HitTest]: EXIT pass-through    ← 正常退出
11:46:32.715  [JS:HitTest]: ENTER pass-through   ← 第二次 enter
              ⛔ 没有 "Polling: started"          ← startPolling() 因 pollTimerId 残留被跳过！
```

### 根因 2：`applyingPassThrough` 异步守卫静默丢弃退出请求

`enterPassThrough()` 和 `exitPassThrough()` 共用 `applyingPassThrough` 互斥锁。当一方正在 await IPC 时，另一方的调用被直接 `return` 丢弃。

### 根因 3：`exitPassThrough` IPC 失败无恢复

`stopPolling()` 先执行后，若 `setIgnoreCursorEvents(false)` 抛异常，`isPassThrough` 保持 `true` 但轮询已死，无恢复机制。

---

## 修复

仅修改 [main.js](../../cross-platform/src/main.js) + [commands.rs](../../cross-platform/src-tauri/src/commands.rs)：

### Fix 1（核心修复）：tick() 开头立即清除 pollTimerId

```js
const tick = async () => {
  pollTimerId = null;  // ← 清除 ID，防止残留值阻塞下次 startPolling()
  if (!isPassThrough) return;
  // ...
};
```

### Fix 2：`exitPassThrough` 添加重试 + 恢复轮询 + pendingExit

- IPC 失败时最多重试 3 次（退避 100/200/300ms）
- 全部失败后启动恢复轮询（500ms 强制 exit）
- 用 `pendingExit` 标志替代静默丢弃退出请求

### Fix 3：`enterPassThrough` 检查 pendingExit

IPC 完成后检查 `pendingExit`，如有延迟退出请求则立即撤销 enter。

### Fix 4：拖拽状态安全网

- `mousedown` 启动 5 秒拖拽超时
- `window.focus` 只在 `isDragging=true` 时重置（不检查 `dragStart`，避免误吞普通点击）

### Fix 5：全局健康检查（每 3 秒）

- pass-through 激活但无轮询运行 → 强制 exit
- 不一致的拖拽状态 → 强制重置

### 诊断：JS→Rust 日志桥接

新增 `js_log` Tauri 命令，将 JS 控制台消息桥接到 Rust 日志流。
