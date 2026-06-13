# Bugfix 计划

本目录记录已识别的 bug 及其修复方案。每个文件描述一个独立问题的诊断、根因、方案与实施清单。

## 当前计划

| 文件 | 问题 | 状态 |
|---|---|---|
| [active-count-undercount.md](active-count-undercount.md) | 同时开 3 个会话，宠物气泡只显示 ×2 | 已实施 |
| [idle-blink-too-fast.md](idle-blink-too-fast.md) | idle 状态眨眼太快、像抽搐；引擎只支持匀速轮播 | 已实施 |
| [pet-unresponsive-stuck-state.md](pet-unresponsive-stuck-state.md) | 宠物无法点击/拖动（穿透态轮询链断裂） | 已实施 |
| [stuck-jumping-after-stop.md](stuck-jumping-after-stop.md) | Stop 后宠物卡在 jumping、session 文件一直不删（5s 窗口缺时钟驱动） | 已实施 |
| [context-menu-lingers-on-mouse-leave.md](context-menu-lingers-on-mouse-leave.md) | 右键菜单在鼠标移出窗口后仍停留满 3 秒（DOM mouseleave 在透明窗口不可靠） | 已实施 |
| [drag-direction-stuck-or-flicker.md](drag-direction-stuck-or-flicker.md) | 拖动方向不跟随反向 / 单方向拖动也左右闪烁卡顿（累计 dx + 单帧抖动） | 已实施 |
