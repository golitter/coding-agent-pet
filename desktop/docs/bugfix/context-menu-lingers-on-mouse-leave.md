# Bug：右键菜单在鼠标移出窗口后仍停留满 3 秒

## 现象

右键宠物弹出右键菜单后，即使鼠标已经移出宠物窗口、移到别处，菜单也不会立刻消失，仍会停留满 `CONTEXT_MENU_AUTO_HIDE_MS`（3 秒）的自动隐藏窗口才关闭。期望行为：鼠标一脱离宠物窗口，菜单即消失。

## 根因

### 根因 1（直接）：菜单缺少"鼠标离开窗口"的关闭通道

菜单原本只有以下关闭途径，没有任何一条与"鼠标是否还在窗口内"相关：

- 3 秒自动隐藏定时器（[scheduleContextMenuAutoHide](../../cross-platform/src/main.js)，`CONTEXT_MENU_AUTO_HIDE_MS = 3000`）；
- 点击窗口任意处（`document` `click`）；
- 按 `Esc`；
- 点击某个菜单项。

所以无论鼠标跑到哪里，菜单都至少要等满 3 秒。

### 根因 2（第一次修复失败的原因）：DOM `mouseleave` 在透明窗口里不可靠

最初的修复尝试是监听 `document` 的 `mouseleave`。但宠物是**透明无边框窗口**，且 `setIgnoreCursorEvents` 会**按像素逐个切换**以实现点击穿透（见 [beginExclusivePointerInteraction](../../cross-platform/src/main.js) / `enterPassThrough` / `exitPassThrough`）。在这种窗口下，光标离开窗口边界时 WKWebView **不会可靠地派发 `mouseleave`**，事件根本送不到 JS。

这并非代码没生效，而是该事件类型在此窗口模型下不可靠。代码库其实早已有同样结论：[pollCursor()](../../cross-platform/src/main.js) 的注释写明——`tao` 的 `cursorPosition()` IPC 在 `setIgnoreCursorEvents(true)` 期间会挂起，NSEvent 位置会变陈旧，所以才改用自定义 Rust 命令 `cursor_in_window`（走 CGEvent 读实时硬件位置）。

## 方案

复用已被验证可用的 `cursor_in_window`：菜单打开后每 `POLL_INTERVAL_MS`（80ms）轮询一次鼠标的窗口相对坐标，一旦坐标越界（`< 0` 或 `≥ innerWidth/innerHeight`）就立即 `hideAllMenus()`。从光标离开窗口到菜单消失最多约 80ms，体感即消失。

新增三个函数（均在 [main.js](../../cross-platform/src/main.js) 顶层）：

- [`startContextMenuLeavePoll()`](../../cross-platform/src/main.js)：菜单显示时启动；每 80ms 调一次 `cursor_in_window`，越界即隐藏。
- [`stopContextMenuLeavePoll()`](../../cross-platform/src/main.js)：菜单关闭时停止，清掉定时器。
- [`contextMenuIsVisible()`](../../cross-platform/src/main.js)：可见性守卫。

接入点：

- [scheduleContextMenuAutoHide()](../../cross-platform/src/main.js) 启动 3s 定时器的同时一并 `startContextMenuLeavePoll()`；
- [hideAllMenus()](../../cross-platform/src/main.js) 关闭菜单的同时 `stopContextMenuLeavePoll()` 并重新启用 hit-test。

### 健壮性处理

- **防空转**：`tick` 开头先检查 `contextMenuIsVisible()`。若菜单在 `await invoke(...)` 期间被别处关闭（点击 / Esc / 菜单项），直接返回不再 reschedule，避免对着已隐藏的菜单无限轮询。
- **平台回退**：`cursor_in_window` 仅 macOS（其余平台返回错误）。catch 到错误即停止轮询，回退到原有 3s 定时器兜底，不会在非 macOS 上刷日志空转。
- **保留 3s 定时器**：仍作为"鼠标停在窗口内不动 / 事件偶发丢失"时的兜底，未删除。

修复后菜单关闭时机：

| 场景 | 关闭延迟 |
|---|---|
| 鼠标移出窗口（本次目标） | ≤ ~80ms（轮询命中越界） |
| 鼠标停在窗口内不动 | ~3s（`CONTEXT_MENU_AUTO_HIDE_MS` 兜底） |
| 点击窗口内任意处 / 菜单项 / 按 Esc | 立即 |

## 实施清单

- [x] 新增 `contextMenuLeaveTimerId` 模块级定时器变量
- [x] 新增 `startContextMenuLeavePoll()` / `stopContextMenuLeavePoll()` / `contextMenuIsVisible()`
- [x] `scheduleContextMenuAutoHide()` 启动轮询，`hideAllMenus()` 停止轮询
- [x] `tick` 加可见性守卫；`cursor_in_window` 出错时回退到 3s 定时器
- [x] ESLint + Prettier 通过
