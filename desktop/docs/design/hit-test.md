# 透明像素点击穿透 — 设计文档

## 背景

Kotori Pet 的 Tauri 窗口是矩形透明窗口。点击窗口内任意位置（包括精灵图透明像素）都会被宠物拦截。期望行为：**点击精灵图的透明区域时，事件穿透到桌面/下层应用**，只有点击到实体像素才触发宠物交互。

## 方案概述

**JS 侧像素级 hit-test + Tauri 窗口穿透开关 + Rust CGEvent 轮询恢复。**

动态切换 `window.setIgnoreCursorEvents(true/false)`：

- 光标在实体像素上 → 正常模式，窗口捕获事件
- 光标在透明像素上 → 穿透模式，窗口忽略事件，点击落到桌面

穿透模式下 JS 不再收到鼠标事件，但 **定时器和 IPC 仍正常工作**，通过轮询恢复。

## 数据流

```
光标移动
  │
  ├─ 正常模式 (ignore=false)
  │   mousemove 事件触发
  │   → 用 e.clientX/Y 查精灵 alpha（ENTER_THRESHOLD）
  │   → alpha < 阈值? ──→ enterPassThrough() + 开始轮询
  │   → 否则 → 继续正常交互
  │
  └─ 穿透模式 (ignore=true)
      定时器 80ms 轮询
      → invoke("cursor_in_window")  [Rust CGEvent，见下]
      → 检查精灵 alpha（EXIT_THRESHOLD + 连续确认）
      → 连续 2 帧实体 或 离开窗口? → exitPassThrough()
      → 仍透明? → 继续（点击穿透到桌面）
```

## 三个关键的技术坑（实现时踩到）

### 坑 1：`asset://` 图片污染 canvas

直接用已加载的 `<img>`（`asset://localhost/...`）drawImage 到 canvas，再 `getImageData()` 会抛 **`SecurityError: The operation is insecure`**（canvas 被跨源图片污染）。

**解决**：Rust 命令 `read_file_bytes(path)` 读原始 PNG 字节 → JS 用 `Blob` + `URL.createObjectURL` 构造**同源 blob URL** → 新建 Image 加载 → canvas 不被污染，`getImageData` 正常。

### 坑 2：`fetch()` 不能读 `asset://` 协议

WKWebView 里 `fetch("asset://localhost/...")` 抛 `TypeError: Load failed`。所以坑 1 的方案必须是 **Rust 读字节**，不能用 fetch。

### 坑 3：穿透态下 cursor 坐标会过期/挂起

进入穿透态后 `setIgnoreCursorEvents(true)`，窗口不再处理鼠标事件：

- **tao 的 `cursorPosition()` IPC 挂起**，永远不返回 → JS 轮询死锁
- **`NSEvent.mouseLocation` 返回过期位置**（停在最后一个被处理的事件处）

**解决**：Rust 命令 `cursor_in_window()` 用 **CGEvent（Core Graphics）** 直接读硬件鼠标位置 —— 它不依赖窗口事件处理，永远返回实时坐标。

## 实现细节

### 1. `src-tauri/capabilities/default.json` — 加 1 行权限

```diff
+ "core:window:allow-set-ignore-cursor-events",
```

`scaleFactor` 已包含在 `core:default` → `core:window:default` 中。

### 2. `src-tauri/tauri.conf.json` — CSP 加 `blob:`

```diff
- "csp": "default-src 'self'; img-src asset: https://asset.localhost data:; ..."
+ "csp": "default-src 'self'; img-src asset: blob: https://asset.localhost data:; ..."
```

不加 `blob:`，blob URL 图片会被 CSP 拦截（坑 1 的副作用）。

### 3. `src-tauri/src/commands.rs` — 两个 Rust 命令

**`read_file_bytes(path)`** — 读 PNG 原始字节（坑 1+2）。路径校验：只允许 `frames_dir` 内的文件，防止 webview 任意文件读取。

**`read_frames_batch(paths)`** — 批量读取多帧 PNG 字节，单次 IPC 返回 `Map<path, bytes>`。替代 57 次 `read_file_bytes` 调用，启动速度显著提升。路径校验采用两级策略：lexical 快路径（`normalize_path` 无 syscall）+ canonicalize 慢路径（含符号链接时降级）。

**`cursor_in_window(window)`** — 用 CGEvent 读实时光标，返回窗口内逻辑坐标（Y 从顶部）。坐标转换：

- CGEvent 坐标：原点在主屏左上，Y 向下
- NSWindow.frame：原点在主屏左下，Y 向上
- 转换公式：`cgY = screenHeight - nsY`（全局成立，H = 主屏高度）
- 最终 `rel_y = cursorCG.y - (screenH - (frame.origin.y + frame.size.h))`

```rust
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *mut c_void) -> *mut c_void;
    fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
    fn CFRelease(cf: *mut c_void);
}
```

### 4. `src/animator.js` — alpha 蒙版系统

- 构造函数加 `alphaMasks: Map<string, Uint8Array[]>`（stateName → 按帧索引的 alpha 数组）、`framePaths`、`baseWidth/Height`、`hitTestReady`
- `loadFrames()` **并行**加载所有帧（`Promise.all`），同时记录每帧原生路径到 `framePaths`
- `computeAlphaMasks()`（async，loadFrames 末尾 await）：
  - **单次批量 IPC** `invoke("read_frames_batch")` 读取所有帧字节，替代逐帧 `read_file_bytes`
  - **两阶段处理**：Phase 1 并行加载所有 Image（`Promise.all`，消除串行 await 瓶颈）；Phase 2 顺序在离屏 canvas（`willReadFrequently`）上 drawImage → 提取 alpha 通道为 `Uint8Array`
  - 数据结构：`Map<stateName, Uint8Array[]>`，按帧索引直接查找，热路径零字符串拼接
  - **先本地构建再提交**：蒙版写入局部数组，循环结束后才 `alphaMasks.set`；批量读取失败时**不缓存任何内容**，下次请求会重试（避免半成品被误判为完成）
  - **完整性校验** `hasCompleteAlphaMaskState` 用密集索引遍历（稀疏空洞读作 `undefined`），而非 `Array.every`（会跳过空洞）——部分加载能被正确识别并重试
  - try-catch 包裹，失败时 `hitTestReady = false`
- `getAlphaAt(state, frame, x, y)` — 查 `alphaMasks.get(state)?.[frame]`；**mask 缺失/unready 返回 255**（fail-safe，宠物不会失联）

### 5. `src/main.js` — 穿透控制

**常量：** `ENTER_THRESHOLD=10`、`EXIT_THRESHOLD=20`（双阈值 hysteresis）、`SOLID_CONFIRM_COUNT=2`、`POLL_INTERVAL_MS=80`、`REENTRY_COOLDOWN_MS=200`

**状态：** `isPassThrough`、`applyingPassThrough`（async 防抖锁）、`hitTestEnabled`、`solidHitCount`、`lastExitTime`

**关键函数：**

- `enterPassThrough()` — 幂等 + 防抖锁 + 重入冷却；`setIgnoreCursorEvents(true)` + startPolling
- `exitPassThrough()` — 幂等 + 防抖锁；stopPolling + `setIgnoreCursorEvents(false)` + 记录 lastExitTime
- `pollCursor()` — `invoke("cursor_in_window")` → 用缓存的 `getBoundingClientRect()` 算精灵坐标（resize 时失效）→ 查 alpha → 双阈值+连续确认决定退出
- `startPolling()` / `stopPolling()` — 链式 `setTimeout`（非 `setInterval`），await 完才调度下一轮，防止 async 重叠

**mousemove 命中检测：** 正常模式下用 `e.clientX/Y` + 缓存的 `getBoundingClientRect()` 查 alpha（缓存 rect 避免 120Hz 布局抖动，`resize` 事件时自动失效），透明则 enterPassThrough

**与现有交互集成：**
| 交互 | 处理 |
|---|---|
| 拖拽 | mousedown → `hitTestEnabled=false` + 若穿透中先退出；mouseup → 恢复 |
| 右键菜单 | contextmenu → `hitTestEnabled=false`；`hideAllMenus()` → 恢复 |
| 帧切换 | 轮询每次读 `currentState`+`currentFrameIndex`，天然跟随 |

## 防抖/稳定性措施

1. **async 防抖锁** `applyingPassThrough` — 防止连续 mousemove 的 Promise 竞态
2. **双阈值 hysteresis** — 进入用 10，退出用 20，避免边缘半透明像素闪烁
3. **连续确认** — 退出需连续 2 帧实体
4. **重入冷却 200ms** — 退出后 200ms 内不重新进入，防止边缘快速闪烁

## 验证

1. `cd desktop/cross-platform && ./build-and-run.sh`
2. 光标悬停宠物身体 → 自动触发跳跃（无需点击）
3. 光标移到透明区域 → 点击穿透到桌面/下层应用
4. 拖拽宠物 → 正常移动，拖拽期间不触发穿透
5. 三连击 → 清理会话正常
6. 右键菜单 → 显示和点击正常
7. 精灵动画帧切换时穿透行为跟随更新

## 局限

- **仅 macOS**：`cursor_in_window` 的 CGEvent/objc 实现是 macOS 专属。其他平台需另写（Windows 用 `GetCursorPos`，Linux 用 X11/Wayland API）。
- **多屏定位**：初始定位使用 `primaryMonitor()` API（支持多显示器），但 CG↔NS 坐标转换仍用主屏高度 H，窗口在副屏时 hit-test 坐标可能偏移。
- **内存**：~57 帧 × 192×208 ≈ 2.2 MB alpha 蒙版常驻。
