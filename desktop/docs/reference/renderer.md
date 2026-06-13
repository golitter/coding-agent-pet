# Tauri 渲染器详解

## 编译与运行

```bash
cd desktop/cross-platform
npx tauri build --debug
xattr -cr src-tauri/target/debug/kotori-pet  # macOS: 清除签名限制
./src-tauri/target/debug/kotori-pet
```

或使用脚本：`./build-and-run.sh`

> **PID 稳定性**：`build-and-run.sh` 启动后进行 PID 存活检测（10 次重试），`nohup` 使用 `</dev/null` + `disown` 防止终端退出影响进程，`pgrep -x` 精确匹配进程名。

日志级别通过环境变量 `RUST_LOG` 控制（默认 `info`）：

```bash
RUST_LOG=debug ./src-tauri/target/debug/kotori-pet   # 详细日志
RUST_LOG=warn  ./src-tauri/target/debug/kotori-pet   # 仅警告
```

## 组件一览

### Rust 后端 (`src-tauri/src/`)

| 文件 | 职责 |
|---|---|
| `main.rs` | 入口，调用 `lib::run()` |
| `lib.rs` | 应用初始化，创建并串联所有组件 |
| `config.rs` | 加载配置、自动检测路径 |
| `commands.rs` | Tauri commands，向前端暴露配置和 AppleScript 执行 |
| `aggregator.rs` | 多会话聚合、优先级排序、清理 |
| `watcher.rs` | 双通道状态监听（socket + 文件）|

### 前端 (`src/`)

| 文件 | 职责 |
|---|---|
| `index.html` | 主页面，DOM 结构 |
| `main.js` | 入口，窗口设置，交互绑定 |
| `animator.js` | 精灵帧加载 + 动画循环引擎 |
| `bubble.js` | 对话气泡（normal/warning/error 三种样式）|
| `style.css` | 全局样式，气泡/菜单/精灵渲染 |

---

## config.rs — 配置加载

从 `config.json`（或降级到 `config.example.json`）加载所有配置。

**路径自动检测逻辑：**

```
可执行文件路径: .../desktop/cross-platform/src-tauri/target/debug/kotori-pet
target/debug/ → target/
target/       → src-tauri/
src-tauri/    → cross-platform/    (config 所在目录)
向父级遍历查找含 desktop/cross-platform/ 的目录 → repo root (pet_base_dir)
```

所有 `null` 值的路径自动拼接：
- `frames_dir` → `{pet_base_dir}/assets/{pet_id}/frames`
- `sessions_dir` → `{pet_base_dir}/desktop/cross-platform/runtime/sessions`

支持 `~` 展开和相对路径。

日志输出使用 `tracing::info!`，而非 `println!`。

---

## commands.rs — Tauri Commands

向前端暴露的 IPC 接口：

| Command | 说明 |
|---|---|
| `get_config` | 返回前端所需的配置子集（frames_dir, scale, fps, dialogue_\*, menu_items） |
| `run_applescript` | 执行 AppleScript 命令（**仅 macOS**，含安全检查） |
| `quit_app` | 退出应用：先显式删除 socket 文件，再 `app.exit(0)`（`process::exit` 跳过 `Drop`，故 socket 不能依赖 `SocketGuard` 清理）；前端调用时记录 `info!` 日志 |
| `purge_all_sessions` | 手动清空：删除 sessions 目录下全部 `.json` 并清空内存 activities，返回删除文件数 |
| `read_file_bytes` | 读 PNG 原始字节（hit-test alpha 蒙版），**路径校验限制在 `frames_dir` 内** |
| `read_frames_batch` | 批量读取多帧 PNG（单次 IPC 替代 57 次 `read_file_bytes`），**两级路径校验**：lexical 快路径（无 syscall）+ canonicalize 慢路径（含符号链接时降级） |
| `cursor_in_window` | CGEvent 读硬件鼠标坐标（穿透态轮询恢复，仅 macOS） |
| `js_log` | JS → Rust 日志桥接，前端诊断信息输出到 `RUST_LOG` 流 |

前端通过 `window.__TAURI__.core.invoke('get_config')` 调用。

### `run_applescript` 安全机制

- **平台守卫**: 非 macOS 平台直接返回错误 `"AppleScript is only available on macOS"`
- **内容过滤**: 拒绝包含 `do shell script`、`do script` 或反引号的脚本，防止通过 AppleScript 执行任意 shell 命令
- **错误处理**: 前端 `invoke` 调用均带有 `.catch()` 处理

---

## lib.rs — 应用初始化

启动顺序（与 [lib.rs](../cross-platform/src-tauri/src/lib.rs) 注释一一对应）：

```
 0. tracing subscriber    ← 初始化日志框架 (支持 RUST_LOG 环境变量)
 1. PetConfig             ← 加载配置
 2. Dock 隐藏             ← macOS: ActivationPolicy::Accessory
 3. NSWindow/WKWebView 透明化 ← macOS: objc 调用设置透明背景
 4. 创建 sessions 目录    ← std::fs::create_dir_all
 5. ActivityAggregator    ← agent 活动聚合器 (Rust, 单 Mutex)
 6. 状态变化订阅          ← broadcast channel → emit "state-change" 到前端
 7. Unix Socket 服务端    ← 异步接收 hook 推送
 8. 文件系统监控          ← notify crate 监听 sessions 目录变化 (独立阻塞线程)
 9. 加载磁盘会话          ← load_from_disk()
10. 定时清理              ← tokio interval, 间隔从配置读取
11. 注入配置到 Tauri      ← app.manage(config) + SocketGuard（RAII 兜底：仅 panic 解退时 Drop 清理 socket；正常退出由 `quit_app` 显式删除）
```

**窗口生命周期**: `on_window_event` 处理 `CloseRequested`（info 日志）和 `Destroyed`（warn 日志）事件。

**macOS 透明窗口**: 通过 `objc` crate 直接操作 NSWindow 和 WKWebView，设置 `opaque=NO`、`backgroundColor=clearColor`、`hasShadow=NO`。

**日志系统**: 使用 `tracing` + `tracing-subscriber` 替代 `println!`/`eprintln!`，支持结构化日志和 `RUST_LOG` 环境变量过滤。

---

## aggregator.rs — 多会话聚合

### 内部结构

所有可变状态封装在单个 `Mutex<Inner>` 中，包含 `activities: HashMap<String, AgentActivity>` 和 `aggregated: AggregatedState` 显示状态，通过辅助方法操作：

| 方法 | 说明 |
|---|---|
| `replace_all_sessions(new)` | 原子替换所有活动会话（用于 `load_from_disk`） |
| `remove_orphaned_sessions(file_ids)` | 批量删除无对应磁盘文件的活动会话 |
| `compute_change(inner)` | 从当前 activities 计算聚合状态变化，返回 `Option<StateChange>`（锁内调用） |
| `aggregate_and_notify()` | 加锁 → 调用 `Inner::aggregate()` → 锁外广播 |
| `Inner::aggregate()` | 持锁期间调用 `compute_change`，返回变化 |

`update()` 方法在单次加锁内完成 insert/remove + 聚合计算，锁外再做文件删除和广播，避免双次加锁。

这种设计避免了多个独立 Mutex 导致的死锁风险。

> 命名：Rust 类型 `ActivityAggregator` / `AgentActivity` / HashMap 字段 `activities` 是"活动会话"的英文表达——`session_id` 在 wire 协议层和文件名层沿用（`019ea736-…json`），`ActivityAggregator` 在内存层聚合它们，描述的是同一个东西。

### 状态优先级

| 优先级 | 状态 | 含义 |
|---|---|---|
| 8 | waiting | 等待授权（最高优先级，确保不会遗漏） |
| 7 | running | 正在工作 |
| 6 | running-right | 向右拖动 |
| 6 | running-left | 向左拖动 |
| 5 | review | 审阅代码 |
| 4 | jumping | 庆祝完成 |
| 3 | waving | 问候/通知 |
| 1 | idle | 空闲 |
| 0 | failed | 出错 |

### 聚合规则

1. 扫描所有活动会话
2. 取优先级最高的会话状态作为显示状态
3. 取该会话的对话台词显示在气泡中
4. `active_count` = `inner.activities.len()`，**包含 idle 状态**（"开着"就算 1 个）
5. `isTerminal: true` 的事件立即删除对应会话

### 状态推送

使用 `tokio::sync::broadcast` channel，当聚合状态变化时发送 `StateChange`：

```rust
pub struct StateChange {
    pub state: String,
    pub dialogue: String,
    pub active_count: usize,
}
```

Rust 端通过 `app_handle.emit("state-change", &change)` 推送到前端。广播前会释放 Mutex 锁，避免阻塞其他调用者。

### 清理机制

| 触发 | 间隔配置 | 行为 |
|---|---|---|
| 定时器 | `renderer.cleanup_interval_sec` (默认 30s) | **双向清理**：①移除已被 hook 删除的内存 orphan 会话；②删除 mtime >`stale_timeout_sec` 的磁盘孤儿文件（崩溃会话兜底）|
| 启动加载 | 一次性 | `load_from_disk()` 全量恢复磁盘会话（跳过 terminal 与过期文件）|
| 文件对账 | 事件驱动（debounce 100ms）| `reconcile_with_disk()` 增量补漏 + 清理 terminal/过期一次性状态残留，**不覆盖** socket 通道已写入的新鲜状态——socket 为主、文件为兜底 |
| terminal 标记 | 即时 | 收到 `isTerminal: true` 时立即删除 |
| `Stop` 延迟删除 | 2s | `watcher.rs` 中 `tokio::time::sleep` + `remove_if_state("jumping")` —— 期间收到新事件改变 state 则取消删除 |
| 手动 purge | 即时（`purge_all`） | **无视 mtime**：删除 sessions 目录下全部 `.json` 并清空内存 activities，返回删除数；由前端三连击触发，是用户「给我干净状态」的逃生口 |

> **手动 purge 的代价**：`purge_all` 会抹掉活跃 agent 在磁盘上的 session 状态。这些 agent 在下次触发事件前对渲染器表现为 idle，事件到达后其条目从新文件重建。

判定过期使用统一的 helper：

```rust
fn is_session_file_stale(path: &Path, now: u64, timeout: u64) -> bool
```

`load_from_disk` 与 `cleanup_stale` 共享同一判定逻辑（mtime-only，不读 JSON 内 `updatedAt`）。

`stale_timeout_sec` 默认 1h 的取舍：覆盖阅读/思考/长工具调用等合法静默期；崩溃会话最多残留 1h 后被磁盘反向清理收尸。详见 [bugfix/active-count-undercount.md](bugfix/active-count-undercount.md)。

`active_count`（气泡 `×N`）= HashMap 里所有活动会话数。`idle` 状态（如 `SubagentStop` 触发）只影响状态仲裁优先级，不影响计数——"开着"就该算 1 个。

---

## watcher.rs — 状态监听

### 双通道设计

| 通道 | 机制 | 路径配置 | 延迟 |
|---|---|---|---|
| **Unix Socket** (主) | `tokio::net::UnixListener` | `config.socket_path` | <1ms |
| **文件监控** (兜底) | `notify` crate | `config.sessions_dir` | ~100ms |

### Socket 协议

- AF_UNIX SOCK_STREAM (Tokio async)
- Hook 连接 → 发送 JSON → 关闭
- 渲染器 accept → 循环读取完整 payload → 解析 → 调用 ActivityAggregator.update()
- **安全限制**: socket 文件权限设为 `0o600`（仅 owner 可读写），防止其他用户注入伪造事件
- **启动安全**: 先 connect 探活（防止 TOCTOU symlink 攻击），仅当连接失败（死 socket）时才 remove + bind
- **缓冲区**: 动态增长，循环读取至 EOF，上限 64KB
- Best-effort：socket 不存在时不报错

### 文件监控

- 使用 `notify::recommended_watcher`（跨平台）
- 监听目录的任何变更事件
- **防抖**: 等待 100ms 静默窗口后触发一次 `reconcile_with_disk()`（经典 debounce——窗口内每来一个事件就续命，不再丢弃突发末尾事件）
- **增量对账**（非全量重载）: 只补内存缺失的会话、清理 terminal 与过期一次性状态（jumping/waving）的残留文件，**绝不覆盖** socket 通道已写入的更新鲜状态
- 在独立阻塞线程中运行

---

## main.js — 前端入口 + 交互

### 初始化流程

```
1. invoke('get_config')    ← 从 Rust 获取配置
2. SpriteAnimator          ← 创建动画器，加载精灵帧
3. 窗口设置                ← 尺寸 + 定位（右下角，`primaryMonitor()` API 支持多显示器）
4. onFrame 回调            ← 动画器 → 更新 <img> src
5. DialogueBubble          ← 创建对话气泡
6. animator.start()        ← 启动动画循环
7. 初始对话                ← "准备好了～"
8. listen('state-change')  ← 监听 Rust 状态推送
9. 右键菜单构建            ← 从 config.menu_items 动态生成
10. 鼠标交互绑定           ← 点击/拖动/右键/三连击清空
11. focus/blur 监听         ← 窗口聚焦/失焦时切换 `animator.setFocused()` + normal polling 状态
12. pagehide 监听           ← 输出诊断日志（页面卸载前）
```

### 窗口属性

由 `tauri.conf.json` 配置：

| 属性 | 值 |
|---|---|
| 类型 | 无边框、透明、置顶 |
| 透明 | `transparent: true` |
| 置顶 | `alwaysOnTop: true` |
| 全空间 | `visibleOnAllWorkspaces: true` |
| 可缩放 | `resizable: false` |
| 任务栏 | `skipTaskbar: true` |
| 首次鼠标 | `acceptFirstMouse: true` |
| 阴影 | `shadow: false` |

### 显示尺寸

| 属性 | 配置项 | 默认值 |
|---|---|---|
| 原始精灵 | — | 192×208px |
| 缩放因子 | `renderer.scale` | 0.6 |
| 显示尺寸 | — | ~115×125px |
| 窗口尺寸 | — | ~139×185px (含边距) |
| 窗口边距 | `renderer.corner_margin` | 20px |

### 交互功能

| 操作 | 行为 |
|---|---|
| **单击** | 触发跳跃动画（一次性），播完后恢复之前状态 |
| 单击 + 拖动 | 使用 `appWindow.startDragging()` 移动窗口，按方向播放 running-left/right（按需 rAF 仅在拖动时运行） |
| 松开鼠标 | 停止拖动，取消 rAF，恢复之前状态 |
| **三连击** | 800ms 窗口内连续 3 次左键 → 调用 `purge_all_sessions` 清空所有会话文件，气泡反馈清理数量（`清理了 N 个会话～` / `没有可清理的会话～`），3s 后自动淡出（成功 `waving`、失败 `failed` 均传 `forceAutoHide`，机制见下文「对话气泡 → 显示逻辑」）|
| **右键** | 弹出自定义上下文菜单 |

> 三连击窗口收紧为 800ms（原 3s 过宽，正常交互 3s 内易误触）；刻意的 triple-tap 仍能从容落在窗口内。前两次点击仍播放跳跃动画，第三次切换为清理。

### Focus/Blur 与 Normal Polling

窗口聚焦/失焦通过 `focus` / `blur` 事件追踪 `windowFocused` 状态：

| 事件 | 行为 |
|---|---|
| `focus` | `windowFocused = true`；`animator.setFocused(true)` 恢复帧率；`armNormalHitTestPolling()` 恢复 hit-test 轮询 |
| `blur` | `windowFocused = false`；`animator.setFocused(false)` 降帧率；`disarmNormalHitTestPolling()` 停止 hit-test 轮询 |

Normal hit-test polling 不再永久运行，改为 **活动窗口模式**：
- `armNormalHitTestPolling(durationMs=2500)` 在鼠标/点击/拖动结束/退出穿透态等交互时刻触发，持续 `NORMAL_HIT_TEST_POLL_MS = 2500`
- `disarmNormalHitTestPolling()` 在进入穿透态/拖动/右键菜单/blur 时停止
- `shouldRunNormalHitTestPolling()` 检查 `windowFocused && hitTestEnabled && !dragStart && !isPassThrough && now < normalPollingUntil`

Health check 改进：穿透态卡死检测增加 `passThroughPollInFlight` 标记和 `pollRecentlyActive`（4× POLL_INTERVAL 内有成功 poll）两个条件，避免误判正在进行的轮询为卡死。


### 拖动动画

- 拖动时按帧计算**增量**水平位移 dx（相对上一帧，而非累计自拖拽起点），再经低通滤波成动量 `dragMomX`（衰减 `DRAG_MOMENTUM_DECAY=0.6`）后用符号决定方向——避免单帧抖动造成左右闪烁/卡顿；拖拽启动阈值 3px（防误触）
- `animator.handleDrag(dx)` 通知动画器（仅看 dx 符号）
- 保存拖动前状态 (`preDragState`)，松手时恢复
- 方向切换时不会覆盖 `preDragState`

### 右键菜单

菜单项从配置文件的 `menu.items` 读取，支持三种类型：

| action | 说明 |
|---|---|
| `applescript` | 通过 `invoke('run_applescript')` 执行 AppleScript（仅 macOS） |
| `quit` | 退出应用 (`invoke('quit_app')` → `app.exit(0)`) |
| `separator` | 分隔线 |

默认菜单：关闭宠物。仍可通过配置添加 `applescript` 项和分隔线。

所有 `invoke` 调用都带有 `.catch()` 错误处理。

#### Variant 系统

每项通过 `getMenuPresentation(title, action)` 推导视觉变体（`data-variant` 属性）：

| variant | 触发条件 | 视觉效果 |
|---|---|---|
| `quit` | action 为 `quit` | 红色文字 + 悬浮粉色高亮 |
| `app` | 其他 | 默认样式 |

#### 定位

菜单定位使用 clamp 算法，以宠物主体左下角为锚点，通过 `Math.max/Math.min` 将菜单完全限制在窗口内部（`MENU_MARGIN = 4px`），适配小窗口场景。菜单设置 `max-width: calc(100vw - 8px)` 确保不超出视口。

#### 视觉

菜单使用渐变背景 + `backdrop-filter: blur(28px)` 毛玻璃效果，入场动画 `context-menu-in`（0.16s ease-out 缩放+淡入）。各项使用圆角高亮 + `transform: translateY(-1px)` 微动效。

#### 关闭

菜单通过以下途径关闭：

| 触发 | 机制 |
|---|---|
| 鼠标移出窗口 | `cursor_in_window` 轮询（`POLL_INTERVAL_MS = 80ms`）检测到坐标越界即隐藏 |
| 3 秒未操作 | `CONTEXT_MENU_AUTO_HIDE_MS` 定时器兜底（鼠标停在窗口内不动时） |
| 点击窗口任意处 / 菜单项 / 按 `Esc` | 立即隐藏 |

> 鼠标移出检测用 Rust 命令 `cursor_in_window`（CGEvent 读实时硬件位置）轮询，**而非 DOM `mouseleave`**——透明无边框窗口在 `setIgnoreCursorEvents` 按像素切换时不会可靠派发该事件。诊断与方案见 [bugfix：右键菜单在鼠标移出窗口后仍停留满 3 秒](../bugfix/context-menu-lingers-on-mouse-leave.md)。

### 平台检测

使用 `navigator.userAgentData?.platform`（现代 API）搭配 `navigator.userAgent` 降级检测 macOS，替代已废弃的 `navigator.platform`。

---

## animator.js — 动画引擎

### 帧加载

帧 manifest 通过 IPC `read_file_bytes` 读取（不再使用 `fetch` + `convertFileSrc`，规避 WKWebView asset protocol 的可靠性问题），然后 `convertFileSrc` 用于并行预加载 PNG 帧（`Promise.all`，57 帧同时加载）。

| 状态 | 帧数 | 用途 |
|---|---|---|
| idle | 6 | 静息、呼吸、眨眼 |
| running-right | 8 | 向右拖动 |
| running-left | 8 | 向左拖动 |
| waving | 4 | 问候/通知 |
| jumping | 5 | 跳跃庆祝动画 |
| failed | 8 | 出错 |
| waiting | 6 | 等待授权 |
| running | 6 | 工作中 |
| review | 6 | 审阅代码 |

总计 **57 帧**。

### 逐状态帧率 (STATE_FPS)

不同状态使用不同帧率，全局 `renderer.fps` 为 fallback，按状态通过 `STATE_FPS` 表覆盖：

| 状态 | FPS |
|---|---|
| idle | 7 |
| waiting | 7 |
| failed | 7 |
| review | 8 |
| waving | 8 |
| jumping | 10 |
| running | 10 |
| running-left | 10 |
| running-right | 10 |

**后台节流**：窗口失焦时 `setFocused(false)` → `BACKGROUND_FPS_FACTOR = 0.6` 降帧（最低 `MIN_BACKGROUND_FPS = 4`），聚焦时恢复。`updatePlaybackRate()` 在每次状态切换/拖动/焦点变化时调用。

### Alpha Mask 懒加载

不再启动时一次性预计算全部 57 帧的 alpha mask，改为 **按需懒加载 + 剪枝**：

- `ensureAlphaMasksForState(state)` 按状态计算 mask，带去重（`alphaMaskLoadPromises` 防止并发重复计算）
- 启动时仅预加载 `ALPHA_MASK_PINNED_STATES`（`idle`、`running-left`、`running-right`）
- 状态切换/拖动时调用 `ensureAlphaMasksForStates([state])`，然后 `pruneAlphaMasks()`
- `pruneAlphaMasks()` 保留当前状态 + pinned + preDrag/preOneShot，超过 `ALPHA_MASK_CACHE_LIMIT = 4` 时淘汰最久未用

### 可配置参数

| 参数 | 配置项 | 默认值 |
|---|---|---|
| 基础帧率 | `renderer.fps` | 10 FPS |
| 实际帧率 | `STATE_FPS[state]` | 见上表（失焦时 × 0.6） |
| 精灵尺寸 | — | 192×208px |
| Alpha mask 缓存 | `ALPHA_MASK_CACHE_LIMIT` | 4 个状态 |

### 状态切换

```js
animator.transitionTo('running')   // 切换到 running 动画
animator.triggerOneShot('jumping') // 触发跳跃动画，播完后恢复之前状态
animator.handleDrag(5.0)           // 向右拖动 → running-right
animator.handleDrag(-3.0)          // 向左拖动 → running-left
animator.handleDrag(0)             // 松手 → 恢复 preDragState
animator.setFocused(true)          // 窗口聚焦 → 恢复帧率
```

### 拖动方向覆盖

- `dx > 0.5` → running-right
- `dx < -0.5` → running-left
- `dx == 0` → 恢复拖动前的状态
- `preDragState` 只在首次进入拖动时保存
- 如果 `preDragState` 本身是拖动状态，恢复到 idle

---

## bubble.js — 对话气泡

### 三种样式

| 样式 | 背景色 | 文字色 | 触发状态 |
|---|---|---|---|
| `normal` | ⚪ 白色半透明 (0.88) | 深灰 | idle, running, review, jumping, waving |
| `warning` | 🟡 琥珀橙 (0.92) | 深色 | **waiting** (需要授权) |
| `error` | 🔴 红色 (0.92) | 白色 | **failed** (出错) |

### 可配置参数

| 参数 | 配置项 | 默认值 |
|---|---|---|
| 字体大小 | `dialogue.font_size` | 10pt |
| 最大宽度 | `dialogue.max_width` | 160px |
| 圆角 | `dialogue.cornerRadius` | 6px |
| 淡入/淡出过渡 | `dialogue.fade_duration_sec` | 0.3s |
| 瞬时态自动淡出延时 | `AUTO_HIDE_MS`（`bubble.js` 源码常量，非 config） | 3000ms |

### 显示逻辑

- 有文字或多会话时显示，否则隐藏
- 多会话时显示 `×N` 计数
- 根据状态自动切换 normal/warning/error 样式
- **持久态常驻 / 瞬时态 3s 自动淡出**：`running` / `waiting` / `failed`（agent 活跃、等待授权、出错）保持显示，直到下一个事件替换；其余状态（`idle` / `waving` / `jumping` 等问候与庆祝）显示 3s（`AUTO_HIDE_MS`）后自动淡出。每次 `show()` 重置定时器——事件持续期间不会提前消失，停下 3s 才淡出
- `forceAutoHide` 参数强制瞬时淡出，覆盖持久态判定（三连击清理的失败分支用它让 `failed` 也淡出）

---

## Tauri 配置文件

### tauri.conf.json

关键安全配置：

```json
{
  "app": {
    "withGlobalTauri": true,       // 前端直接使用 window.__TAURI__
    "macOSPrivateApi": true,       // macOS 透明窗口所需
    "security": {
      "assetProtocol": {           // 允许加载本地精灵帧
        "enable": true,
        "scope": { "allow": ["**/*"] }
      }
    }
  }
}
```

### capabilities/default.json

声明前端所需的最小权限集：窗口拖动、尺寸设置、事件监听。

> **注意**: `shell:allow-execute` 权限已移除——前端不直接使用 shell plugin，AppleScript 执行通过 Rust 端 `run_applescript` command（IPC）完成。

### Cargo.toml 关键依赖

| crate | 用途 |
|---|---|
| `tauri` v2 | 桌面应用框架（启用 `protocol-asset`、`macos-private-api`、`tray-icon` features） |
| `serde` / `serde_json` | 序列化 |
| `tokio` | 异步运行时 (socket, broadcast, timer) |
| `notify` v7 | 跨平台文件系统监控 |
| `chrono` | 时间解析 |
| `objc` (macOS) | NSWindow/WKWebView 透明化 |
| `tracing` | 结构化日志框架 |
| `tracing-subscriber` | 日志输出（支持 `RUST_LOG` 环境变量过滤） |

> **已移除**：`tauri-plugin-shell` —— 之前虽然注册了插件，但 capabilities 从未授予任何 `shell:*` 权限，前端也未使用。AppleScript 通过 `commands::run_applescript` 直接调用 `std::process::Command::new("osascript")` 实现，无需 shell plugin。详见 [Cargo.toml](../cross-platform/src-tauri/Cargo.toml) 注释。
