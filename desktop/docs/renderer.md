# Tauri 渲染器详解

## 编译与运行

```bash
cd desktop/cross-platform
npx tauri build --debug
xattr -cr src-tauri/target/debug/kotori-pet  # macOS: 清除签名限制
./src-tauri/target/debug/kotori-pet
```

或使用脚本：`./build-and-run.sh`

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
| `session.rs` | 多会话聚合、优先级排序、清理 |
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
向父级遍历查找含 kotori-minami/ 的目录 → repo root (pet_base_dir)
```

所有 `null` 值的路径自动拼接：
- `frames_dir` → `{pet_base_dir}/{pet_id}/frames`
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
| `quit_app` | 退出应用（`app.exit(0)`） |

前端通过 `window.__TAURI__.core.invoke('get_config')` 调用。

### `run_applescript` 安全机制

- **平台守卫**: 非 macOS 平台直接返回错误 `"AppleScript is only available on macOS"`
- **内容过滤**: 拒绝包含 `do shell script` 或反引号的脚本，防止通过 AppleScript 执行任意 shell 命令
- **错误处理**: 前端 `invoke` 调用均带有 `.catch()` 处理

---

## lib.rs — 应用初始化

启动顺序：

```
0. tracing subscriber   ← 初始化日志框架 (支持 RUST_LOG 环境变量)
1. PetConfig            ← 加载配置
2. NSWindow 透明化      ← macOS: objc 调用设置透明背景
3. Dock 隐藏           ← macOS: ActivationPolicy::Accessory
4. 创建 sessions 目录   ← std::fs::create_dir_all
5. SessionManager      ← 多会话聚合器 (Rust)
6. 状态变化订阅         ← broadcast channel → emit "state-change" 到前端
7. Unix Socket 服务端   ← 异步接收 hook 推送
8. 文件系统监控         ← notify crate 监听 sessions 目录变化
9. 加载磁盘会话         ← load_from_disk()
10. 定时清理            ← tokio interval, 间隔从配置读取
11. 注入配置到 Tauri    ← app.manage(config)
```

**macOS 透明窗口**: 通过 `objc` crate 直接操作 NSWindow 和 WKWebView，设置 `opaque=NO`、`backgroundColor=clearColor`、`hasShadow=NO`。

**日志系统**: 使用 `tracing` + `tracing-subscriber` 替代 `println!`/`eprintln!`，支持结构化日志和 `RUST_LOG` 环境变量过滤。

---

## session.rs — 多会话聚合

### 内部结构

所有可变状态封装在单个 `Mutex<Inner>` 中，包含 `sessions` HashMap 和 `aggregated` 显示状态，通过辅助方法操作：

| 方法 | 说明 |
|---|---|
| `remove_session(id)` | 删除指定会话 |
| `insert_session(id, state)` | 插入/更新会话 |
| `replace_all_sessions(new)` | 原子替换所有会话（用于 `load_from_disk`） |
| `remove_orphaned_sessions(file_ids)` | 批量删除无对应文件的会话 |

这种设计避免了多个独立 Mutex 导致的死锁风险。

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

1. 扫描所有活跃会话
2. 取优先级最高的会话状态作为显示状态
3. 取该会话的对话台词显示在气泡中
4. 活跃会话数（非 idle）显示为 "×N"
5. `isTerminal: true` 的会话立即删除

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
| 定时器 | `renderer.cleanup_interval_sec` (默认 5s) | 移除已被 hook 删除的 orphan 会话 |
| 磁盘加载 | 事件驱动 | 跳过 >`stale_timeout_sec` 未更新的过期会话 |
| terminal 标记 | 即时 | 收到 `isTerminal: true` 时立即删除 |

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
- 渲染器 accept → 循环读取完整 payload → 解析 → 调用 SessionManager.update()
- **安全限制**: socket 文件权限设为 `0o600`（仅 owner 可读写），防止其他用户注入伪造事件
- **缓冲区**: 动态增长，循环读取至 EOF，上限 64KB
- Best-effort：socket 不存在时不报错

### 文件监控

- 使用 `notify::recommended_watcher`（跨平台）
- 监听目录的任何变更事件
- **防抖**: 100ms 窗口内合并多个事件，只触发一次 `load_from_disk()`，避免高频写入导致的冗余 I/O
- 在独立阻塞线程中运行

---

## main.js — 前端入口 + 交互

### 初始化流程

```
1. invoke('get_config')    ← 从 Rust 获取配置
2. SpriteAnimator          ← 创建动画器，加载精灵帧
3. 窗口设置                ← 尺寸 + 定位（右下角）
4. onFrame 回调            ← 动画器 → 更新 <img> src
5. DialogueBubble          ← 创建对话气泡
6. animator.start()        ← 启动动画循环
7. 初始对话                ← "准备好了～"
8. listen('state-change')  ← 监听 Rust 状态推送
9. 右键菜单构建            ← 从 config.menu_items 动态生成
10. 鼠标交互绑定           ← 点击/拖动/右键
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
| 单击 + 拖动 | 使用 `appWindow.startDragging()` 移动窗口，按方向播放 running-left/right |
| 松开鼠标 | 停止拖动，恢复之前状态 |
| **右键** | 弹出自定义上下文菜单 |

### 拖动动画

- 拖动时实时计算水平位移 dx（3px 阈值防误触）
- `animator.handleDrag(dx)` 通知动画器
- 保存拖动前状态 (`preDragState`)，松手时恢复
- 方向切换时不会覆盖 `preDragState`

### 右键菜单

菜单项从配置文件的 `menu.items` 读取，支持三种类型：

| action | 说明 |
|---|---|
| `applescript` | 通过 `invoke('run_applescript')` 执行 AppleScript（仅 macOS） |
| `quit` | 退出应用 (`invoke('quit_app')` → `app.exit(0)`) |
| `separator` | 分隔线 |

默认菜单：打开 Codex、打开 VS Code、分隔线、关闭宠物。

所有 `invoke` 调用都带有 `.catch()` 错误处理。

### 平台检测

使用 `navigator.userAgentData?.platform`（现代 API）搭配 `navigator.userAgent` 降级检测 macOS，替代已废弃的 `navigator.platform`。

---

## animator.js — 动画引擎

### 帧加载

通过 Tauri 的 `convertFileSrc` 将本地文件路径转为 asset protocol URL，预加载所有 PNG 帧：

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

总计 **55 帧**。

### 可配置参数

| 参数 | 配置项 | 默认值 |
|---|---|---|
| 帧率 | `renderer.fps` | 10 FPS (100ms/帧) |
| 定时器 | — | setInterval |

### 动画类型

| 类型 | 状态 | 行为 |
|---|---|---|
| **循环** | idle, running, running-right, running-left, waiting, review, failed | 播完一轮后从头循环 |
| **一次性** | jumping, waving | 播完一轮后自动回到触发前的状态 |

### 状态切换

```js
animator.transitionTo('running')   // 切换到 running 动画
animator.triggerOneShot('jumping') // 触发跳跃动画，播完后恢复之前状态
animator.handleDrag(5.0)           // 向右拖动 → running-right
animator.handleDrag(-3.0)          // 向左拖动 → running-left
animator.handleDrag(0)             // 松手 → 恢复 preDragState
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
| 淡入/淡出 | `dialogue.fade_duration_sec` | 0.3s |

### 显示逻辑

- 有文字或多会话时显示，否则隐藏
- 多会话时显示 `×N` 计数
- 根据状态自动切换 normal/warning/error 样式

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
| `tauri` v2 | 桌面应用框架 |
| `tauri-plugin-shell` | Shell 命令执行 |
| `tokio` | 异步运行时 (socket, broadcast, timer) |
| `notify` | 跨平台文件系统监控 |
| `chrono` | 时间解析 |
| `objc` (macOS) | NSWindow/WKWebView 透明化 |
| `tracing` | 结构化日志框架 |
| `tracing-subscriber` | 日志输出（支持 `RUST_LOG` 环境变量过滤） |
