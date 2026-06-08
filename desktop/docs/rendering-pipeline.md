# Hooks 渲染管线 — 从 AI 事件到桌面像素

本文档描述一个 Hook 事件从 Claude Code / Codex 发出，到最终变为桌面宠物精灵动画和对话气泡的**完整渲染路径**。

---

## 端到端数据流

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code / Codex 发出 Hook 事件                              │
│  (SessionStart, PreToolUse, Stop, StopFailure ...)              │
└──────────┬──────────────────────┬───────────────────────────────┘
           │ stdin JSON           │ stdin JSON
    pet-claude-hook.sh     pet-codex-hook.sh
           │                      │
    claude_hook.py          codex_hook.py        ← 解析各自的事件字段格式
           │                      │
           └──────────┬───────────┘
                      │
                  common.py                    ← 统一处理：配置加载 + 状态映射 + 持久化
                      │
           ┌──────────┼──────────┐
           │                     │
    ① write session.json   ② push Unix Socket
    (文件系统持久化)         (/tmp/kotori-pet.sock 实时推送)
           │                     │
           └──────────┬──────────┘
                      │
              ┌───────┴────────┐
              │ SessionManager │  ← Rust: 多会话聚合 + 优先级仲裁
              │   (Mutex)      │
              └───────┬────────┘
                      │ broadcast::channel
              ┌───────┴────────┐
              │  Tauri emit()  │  → 前端 "state-change" 事件
              └───────┬────────┘
                      │
           ┌──────────┼──────────┐
           │                     │
    SpriteAnimator        DialogueBubble     ← 前端渲染
    (精灵动画引擎)         (对话气泡)
```

下面逐层展开。

---

## 第一层：Hook 事件采集

### 注册机制

AI 工具的 Hook 系统会在特定生命周期事件时，通过 stdin 传递 JSON 给用户配置的脚本。

`setup-hooks.sh` 负责将这些脚本注册到两个平台：

| 平台 | 配置文件 | 注册的事件数 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | 11 个事件 |
| Codex | `~/.codex/hooks.json` | 9 个事件 |

注册格式（以 Claude Code 为例）：

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "command": "/path/to/pet-claude-hook.sh", "type": "command" }] }
    ],
    "Stop": [
      { "hooks": [{ "command": "/path/to/pet-claude-hook.sh", "type": "command" }] }
    ]
  }
}
```

### 双平台适配

两个 Python 入口脚本处理不同平台的输入格式差异：

**claude_hook.py** — Claude Code 格式：
```python
hook_event = input_data.get('hook_event_name', '')   # PascalCase: "PreToolUse"
session_id = input_data.get('session_id', 'unknown')
tool_name  = input_data.get('tool_name', '')
```

**codex_hook.py** — Codex 格式（多种字段名 + snake_case）：
```python
raw_event = input_data.get('hook_event_name') \
         or input_data.get('event') \
         or input_data.get('codex_event_type')      # "pre_tool_use"
hook_event = EVENT_ALIASES.get(raw_event, raw_event) # → "PreToolUse"

session_id = input_data.get('session_id') \
          or input_data.get('sessionId') \
          or input_data.get('conversation_id') \
          or input_data.get('thread_id')
```

### 事件 → 宠物状态映射

两者都调用 `common.py:process_event()`，从 `config.json` 的 `state_map` 查表：

```json
"state_map": {
  "SessionStart":      {"state": "waving",  "dialogue": "嗨！小鸟来啦～"},
  "UserPromptSubmit":  {"state": "running", "dialogue": "收到！开始工作～"},
  "PreToolUse":        {"state": "running", "dialogue": "执行中..."},
  "Stop":              {"state": "jumping", "dialogue": "搞定啦！✨"},
  "StopFailure":       {"state": "failed",  "dialogue": "呜...出了点问题"},
  "PermissionRequest": {"state": "waiting", "dialogue": "需要你的授权～"},
  "SessionEnd":        {"state": "waving",  "dialogue": "下次见！♪"}
}
```

特殊处理：`PostToolUse` 不在 state_map 中，而是硬编码映射为 `running` + `"处理中..."`。

---

## 第二层：双通道状态传输

`common.py` 将映射结果通过两个通道同时发送给渲染器：

### 通道 ①：文件系统持久化

```
write_session(session_file, payload)
```

- 路径：`desktop/cross-platform/runtime/sessions/{session_id}.json`
- **原子写入**：先写 `.tmp`，再 `os.replace()` 重命名，防止读到半写数据
- 作用：持久化、重启恢复、file watcher 兜底

### 通道 ②：Unix Socket 实时推送

```
push_socket(socket_path, payload)
```

- 路径：`/tmp/kotori-pet.sock`
- 延迟 < 100ms（best-effort，失败静默）
- 作用：实时驱动宠物状态切换

### Session 文件生命周期

```
SessionStart → 创建 session 文件
    ↓
工作期间 → 持续更新 (PreToolUse / PostToolUse / ...)
    ↓
Stop → 写入 jumping 状态，2 秒后异步删除文件 (schedule_cleanup)
StopFailure → 写入 failed 状态，3 秒后异步删除文件
SessionEnd → 立即删除 session 文件
```

延迟删除使用 `threading.Timer`（非 shell 子进程），避免路径特殊字符导致的注入风险。

---

## 第三层：Rust 后端状态聚合

### 双通道监听 — watcher.rs

两个并行的状态接收通道：

| 通道 | 实现 | 延迟 | 角色 |
|---|---|---|---|
| **Unix Socket Server** | `start_socket_server()` — Tokio 异步 | <1ms | **主通道**，实时性高 |
| **File Watcher** | `start_file_watcher()` — `notify` crate + 100ms debounce | ~100ms | **备用通道**，监听目录变化触发 `load_from_disk()` |

安全措施：
- Socket 文件权限 `0o600`（仅 owner 可读写），防止其他用户注入
- 接收上限 64KB，防止恶意超大 payload

### 多会话优先级仲裁 — session.rs

当多个 Claude Code / Codex 会话同时运行时，每个会话有独立状态。`SessionManager` 通过优先级表聚合为一个全局显示状态：

```
waiting(8) > running(7) > running-right/left(6) > review(5) > jumping(4) > waving(3) > idle(1) > failed(0)
```

**聚合规则**（`aggregate_and_notify()`）：
1. 遍历所有活跃会话（存在 `HashMap<String, SessionState>` 中，单个 `Mutex` 保护）
2. 选出优先级最高的会话，取其 `state` 和 `dialogue`
3. 统计非 idle 的活跃会话数 `active_count`
4. 与上一次聚合结果比较，有变化才推送

**状态推送**：
```rust
pub struct StateChange {
    pub state: String,       // "running"
    pub dialogue: String,    // "执行中..."
    pub active_count: usize, // 3
}
```

通过 `broadcast::channel` 发送 → Rust 端 `app_handle.emit("state-change", &change)` → 推送到 Tauri 前端。

### 清理机制

| 触发方式 | 间隔 | 行为 |
|---|---|---|
| 定时器 | `cleanup_interval_sec`（默认 5s） | 移除磁盘上已不存在的孤儿会话 |
| 磁盘加载 | 事件驱动 | 跳过 > `stale_timeout_sec`（默认 60s）的过期会话 |
| terminal 标记 | 即时 | 收到 `isTerminal: true` 立即从 HashMap 和磁盘删除 |

---

## 第四层：Tauri 应用初始化 — lib.rs

应用启动的 10 步串联：

```
0. tracing subscriber          ← 日志框架初始化 (RUST_LOG 环境变量)
1. PetConfig::load()           ← 加载 config.json
2. ActivationPolicy::Accessory ← macOS: 隐藏 Dock 图标，变为菜单栏应用
3. NSWindow + WKWebView 透明   ← objc 直接操作，setOpaque:NO + clearColor
4. 创建 sessions 目录          ← std::fs::create_dir_all
5. SessionManager::new()       ← Arc 共享引用
6. subscribe() → emit()        ← broadcast channel → "state-change" 前端事件
7. Unix Socket Server          ← Tokio async task
8. File Watcher                ← blocking thread
9. load_from_disk()            ← 恢复已有会话
10. cleanup ticker             ← tokio interval 定时清理
```

**透明窗口**是桌面宠物的关键：通过 `objc` crate 的 `msg_send!` 宏直接调用 macOS API，让 NSWindow 和 WKWebView 都变为完全透明，只显示精灵帧和气泡，无任何窗口边框或背景。

---

## 第五层：前端渲染

### 精灵动画引擎 — animator.js

#### 帧加载

通过 Tauri asset protocol 将本地 PNG 转为可加载 URL：

```js
const filePath = `${framesDir}/${state}/${padded}.png`;  // 本地路径
const url = convertFileSrc(filePath);                     // → asset://localhost/...
const img = new Image();
img.src = url;  // 预加载
```

共 9 种状态，**55 帧** PNG：

| 状态 | 帧数 | 动画类型 | 用途 |
|---|---|---|---|
| idle | 6 | 循环 | 静息、呼吸 |
| running | 6 | 循环 | 工作中 |
| running-right | 8 | 循环 | 向右拖动 |
| running-left | 8 | 循环 | 向左拖动 |
| waiting | 6 | 循环 | 等待授权 |
| review | 6 | 循环 | 审阅代码 |
| failed | 8 | 循环 | 出错 |
| waving | 4 | **一次性** | 问候/通知 |
| jumping | 5 | **一次性** | 跳跃庆祝 |

#### 动画循环

```
setInterval(1000/fps)  →  tick()  →  currentFrameIndex++
                                  →  one-shot? 播完恢复 preOneShotState
                                  →  循环? frameIndex %= frames.length
                                  →  showCurrentFrame() → onFrame callback
```

#### 状态切换 API

| 方法 | 触发场景 | 行为 |
|---|---|---|
| `transitionTo(state)` | 收到 Rust `state-change` 事件 | 切换到目标状态，重置帧索引 |
| `triggerOneShot(state)` | 用户单击宠物 | 播放跳跃/挥手动画，播完自动恢复 |
| `handleDrag(dx)` | 用户拖动宠物 | dx>0 → running-right, dx<0 → running-left, dx==0 → 恢复 |

### 对话气泡 — bubble.js

根据状态选择三种视觉风格：

| 样式 | 状态 | 背景色 | CSS class |
|---|---|---|---|
| 正常 | idle, running, jumping, waving, review | 白色半透明 `rgba(255,255,255,0.88)` | `style-normal` |
| 警告 | waiting | 琥珀橙 `rgba(255,194,8,0.92)` | `style-warning` |
| 错误 | failed | 红色 `rgba(242,56,56,0.92)` | `style-error` |

多会话时显示 `×N` 计数（N = 非idle的活跃会话数）。

### 窗口 — main.js

| 属性 | 值 |
|---|---|
| 位置 | 屏幕右下角，margin=20px |
| 尺寸 | `(192×scale+24) × (208×scale+60)` ≈ 139×185px（scale=0.6） |
| 精灵缩放 | `image-rendering: pixelated` — 保持像素风格锐利 |
| 右键菜单 | macOS 毛玻璃效果（`backdrop-filter: blur(24px)`） |
| 置顶 | `alwaysOnTop: true`，宠物始终可见 |

### 前端初始化完整流程

```
main.js 启动
  │
  ├── invoke('get_config')         ← Rust 获取配置
  ├── new SpriteAnimator()         ← 创建动画器
  ├── animator.loadFrames()        ← 预加载 55 帧 PNG
  ├── setupWindow()                ← 定位窗口到右下角
  ├── animator.onFrame = callback  ← 绑定帧更新 → <img> src
  ├── new DialogueBubble()         ← 创建气泡
  ├── animator.start()             ← 启动 setInterval 动画循环
  ├── bubble.show('准备好了～')     ← 初始对话
  ├── listen('state-change', ...)  ← 监听 Rust 状态推送
  │     └── animator.transitionTo(state)
  │     └── bubble.show(dialogue, count, state)
  ├── buildContextMenu()           ← 从 config 构建右键菜单
  └── setupInteractions()          ← 绑定鼠标/键盘事件
```

---

## 渲染时序示例

以用户在 Claude Code 中输入一条消息为例：

```
时间轴   事件                   Hook → Python              Rust SessionManager         前端
─────────────────────────────────────────────────────────────────────────────────────────────
t=0ms   UserPromptSubmit       state_map → running         update(session, "running")  transitionTo("running")
                               "收到！开始工作～"           aggregate → running          bubble.show("收到！开始工作～")
                               write session.json
                               push socket ✓

t=50ms  PreToolUse             state_map → running         update(session, "running")  (状态未变，前端不动)
                               "执行中..."
                               write + socket

t=3s    Stop                   state_map → jumping         update(session, "jumping")  transitionTo("jumping")
                               "搞定啦！✨"                aggregate → jumping          bubble.show("搞定啦！✨")
                               write + socket
                               schedule_cleanup(2s)

t=5s    (2s timer fires)       session 文件被删除           cleanup_stale()             (session 已从 map 移除)
                                                          aggregate → idle             transitionTo("idle")
                                                                                       bubble.hide()
```

---

## 关键设计亮点

| 设计 | 动机 |
|---|---|
| **双通道冗余** | Socket 实时 + File 兜底，任一通道故障都不影响宠物响应 |
| **多会话优先级仲裁** | 同时开 N 个会话时，waiting > running > idle，确保重要状态（如等待授权）不被覆盖 |
| **一次性动画** | jumping/waving 播完自动恢复，不会锁死在瞬态 |
| **原子文件写入** | `.tmp` + `os.replace()`，防止读到半写数据导致宠物显示异常 |
| **objc 透明窗口** | 直接操作 NSWindow/WKWebView，实现真正的无边框桌面宠物效果 |
| **Mutex 单锁设计** | 所有可变状态合并为一个 `Mutex<Inner>`，消除多锁死锁风险 |
| **安全防护** | Socket 600 权限、AppleScript 内容过滤、64KB payload 上限、threading.Timer 防注入 |

---

## 相关文档

- [overview.md](overview.md) — 项目总体架构和目录结构
- [hooks.md](hooks.md) — Hook 脚本详解（事件格式、session 文件、调试）
- [renderer.md](renderer.md) — Tauri 渲染器详解（Rust 后端、前端组件）
- [spritesheet.md](spritesheet.md) — 精灵图规格（帧尺寸、布局、色键）
