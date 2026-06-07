# Swift 渲染器详解

## 编译与运行

```bash
cd desktop/mac/renderer
swift build -c release
xattr -cr .build/release/KotoriPet  # 首次清除签名限制
.build/release/KotoriPet
```

或使用脚本：`./build-and-run.sh`

## 组件一览

| 文件 | 职责 |
|---|---|
| `Config.swift` | 加载配置、自动检测路径 |
| `main.swift` | 入口，创建并串联所有组件 |
| `PetWindow.swift` | 浮窗窗口、拖动、右键菜单 |
| `DialogueBubble.swift` | 对话气泡（normal/warning/error 三种样式）|
| `FrameCache.swift` | 预加载 55 帧 PNG 到内存 |
| `SpriteAnimator.swift` | 动画循环引擎 |
| `SessionManager.swift` | 多会话聚合、优先级排序、清理 |
| `StateWatcher.swift` | 双通道状态监听（socket + 文件）|

---

## Config.swift — 配置加载

从 `config.json`（或降级到 `config.example.json`）加载所有配置。

**路径自动检测逻辑：**

```
可执行文件路径: .../desktop/mac/renderer/.build/release/KotoriPet
release/     → .build/
.build/      → renderer/
renderer/    → mac/
mac/         → desktop/
desktop/     → repo root (pet_base_dir)
```

所有 `null` 值的路径自动拼接：
- `frames_dir` → `{pet_base_dir}/{pet_id}/frames`
- `sessions_dir` → `{pet_base_dir}/desktop/mac/runtime/sessions`

支持 `~` 展开（如 `~/my-pet`）和相对路径。

---

## main.swift — 入口

启动顺序：

```
1. PetConfig          ← 加载配置
2. FrameCache         ← 预加载精灵帧 (~8MB)
3. PetWindow          ← 创建浮窗，显示在屏幕右下角
4. SpriteAnimator     ← 绑定动画引擎 (fps 从配置读取)
5. 拖动回调绑定        ← onDrag → handleDrag
6. SessionManager     ← 多会话聚合器
7. StateWatcher       ← socket + 文件监控
8. 加载磁盘会话        ← loadFromDisk()
9. 启动动画            ← animator.start()
10. 初始对话           ← "准备好了～"
11. 清理定时器         ← 间隔从配置读取
12. NSRunLoop          ← app.run()
```

---

## PetWindow.swift — 浮窗窗口

### 窗口属性

| 属性 | 值 |
|---|---|
| 类型 | NSPanel (borderless, nonactivating) |
| 层级 | `.floating`（浮在所有窗口之上）|
| 透明 | `isOpaque=false`, `backgroundColor=clear` |
| 阴影 | `hasShadow=false` |
| 鼠标穿透 | `false`（接收交互事件）|
| 全空间 | `.canJoinAllSpaces` + `.fullScreenAuxiliary` |
| Dock 显示 | 不显示 (`.accessory` policy) |

### 显示尺寸

| 属性 | 配置项 | 默认值 |
|---|---|---|
| 原始精灵 | — | 192×208px |
| 缩放因子 | `renderer.scale` | 0.6 |
| 显示尺寸 | — | ~115×125px |
| 窗口边距 | `renderer.corner_margin` | 20px |

### 交互功能

| 操作 | 行为 |
|---|---|
| 单击 + 拖动 | 移动窗口，按方向播放 running-left/right |
| 松开鼠标 | 停止拖动，恢复之前状态 |
| **右键** | 弹出上下文菜单 |

### 拖动动画

- 拖动时实时计算水平位移 dx
- `onDrag?(dx)` 回调通知 SpriteAnimator
- 保存拖动前状态 (`preDragState`)，松手时恢复
- 方向切换时不会覆盖 `preDragState`
- `mouseUp` / `rightMouseUp` / `otherMouseUp` 均触发恢复

### 右键菜单

菜单项从配置文件的 `menu.items` 读取，支持三种类型：

| action | 说明 |
|---|---|
| `applescript` | 执行 `script` 字段中的 AppleScript（激活/启动应用）|
| `quit` | 终止宠物应用 |
| `separator` | 分隔线 |

默认菜单：Codex、VS Code、关闭宠物。用户可在 config.json 中自定义。

---

## DialogueBubble.swift — 对话气泡

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

---

## FrameCache.swift — 帧缓存

从 `kotori-minami/frames/` 预加载所有 PNG 帧：

| 状态 | 帧数 | 用途 |
|---|---|---|
| idle | 6 | 静息、呼吸、眨眼 |
| running-right | 8 | 向右拖动 |
| running-left | 8 | 向左拖动 |
| waving | 4 | 问候/通知 |
| jumping | 5 | 任务完成庆祝 |
| failed | 8 | 出错 |
| waiting | 6 | 等待授权 |
| running | 6 | 工作中 |
| review | 6 | 审阅代码 |

总计 **55 帧**，约 **8MB** 内存。

---

## SpriteAnimator.swift — 动画引擎

### 可配置参数

| 参数 | 配置项 | 默认值 |
|---|---|---|
| 帧率 | `renderer.fps` | 10 FPS (100ms/帧) |
| 定时器 | — | DispatchSourceTimer |

### 动画类型

| 类型 | 状态 | 行为 |
|---|---|---|
| **循环** | idle, running, running-right, running-left, waiting, review, failed | 播完一轮后从头循环 |
| **一次性** | jumping, waving | 播完一轮后自动回到 idle |

### 状态切换

```swift
transition(to: "running")   // 切换到 running 动画
handleDrag(dx: 5.0)          // 向右拖动 → running-right
handleDrag(dx: -3.0)         // 向左拖动 → running-left
handleDrag(dx: 0)            // 松手 → 恢复 preDragState
```

### 拖动方向覆盖

- `dx > 0.5` → running-right
- `dx < -0.5` → running-left
- `dx == 0` → 恢复拖动前的状态
- `preDragState` 只在首次进入拖动时保存
- 如果 `preDragState` 本身是拖动状态，恢复到 idle

---

## SessionManager.swift — 多会话聚合

### 状态优先级

| 优先级 | 状态 | 含义 |
|---|---|---|
| 7 | running | 正在工作 |
| 6 | running-right | 向右拖动 |
| 6 | running-left | 向左拖动 |
| 5 | review | 审阅代码 |
| 4 | jumping | 庆祝完成 |
| 3 | waving | 问候/通知 |
| 2 | waiting | 等待授权 |
| 1 | idle | 空闲 |
| 0 | failed | 出错 |

### 聚合规则

1. 扫描所有活跃会话
2. 取优先级最高的会话状态作为显示状态
3. 取该会话的对话台词显示在气泡中
4. 活跃会话数（非 idle）显示为 "×N"
5. `isTerminal: true` 的会话立即删除

### 清理机制

| 触发 | 间隔配置 | 行为 |
|---|---|---|
| 定时器 | `renderer.cleanup_interval_sec` (默认 5s) | 移除已被 hook 删除的 orphan 会话 |
| 磁盘加载 | 事件驱动 | 跳过 >`stale_timeout_sec` 未更新的过期会话 |
| terminal 标记 | 即时 | 收到 `isTerminal: true` 时立即删除 |

---

## StateWatcher.swift — 状态监听

### 双通道设计

| 通道 | 机制 | 路径配置 | 延迟 |
|---|---|---|---|
| **Unix Socket** (主) | `config.socket_path` | `/tmp/kotori-pet.sock` | <1ms |
| **文件监控** (兜底) | DispatchSource | `config.sessions_dir` | ~100ms |

### Socket 协议

- AF_UNIX SOCK_STREAM
- Hook 连接 → 发送 JSON → 关闭
- 渲染器 accept → 解析 → 调用 SessionManager.update()
- Best-effort：socket 不存在时不报错

### 文件监控

- `DispatchSource.makeFileSystemObjectSource`
- 监听目录的 write/delete/rename 事件
- 触发时调用 `SessionManager.loadFromDisk()`
