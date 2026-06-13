# Bug：拖动宠物时方向不跟随 / 单方向拖动也左右闪烁卡顿

## 现象

两个相关症状：

1. **反向不跟随**：按住宠物向右拖一段后中途反向向左拖，宠物仍朝右跑，要一直拖回越过拖拽起点才会转向。
2. **单方向闪烁卡顿**：稳稳地向单一方向拖动时，宠物动画在左右之间反复跳，并伴随卡顿/暂停。

## 根因

[`animator.handleDrag(dx)`](../../cross-platform/src/animator.js#L233) 只看 dx 的**符号**（`dx > 0.5` → `running-right`，`dx < -0.5` → `running-left`），并且每次切换方向都会 `currentFrameIndex = 0` 重置动画帧。而拖动期间喂给它的 dx 有两个独立问题：

### 根因 1（反向不跟随）：dx 是相对起点的累计位移

原 `processMove` 里 `dx = e.screenX - dragStart.x`，`dragStart.x` 是拖拽**开始**那一刻的位置。所以 dx 单调增长——反向移动时它只是变小、仍为正，符号不变，handleDrag 一直给同一个方向。要拖回越过起点（dx 变号）才会转向。

> 注：[renderer.md 的拖动示例](../reference/renderer.md#L426-L428) 本来就写的是增量语义：`handleDrag(5.0)` → 右，紧接着 `handleDrag(-3.0)` → 左。即文档记录的意图是**增量位移**，旧代码用**累计位移**是实现与文档相悖。

### 根因 2（闪烁卡顿）：单帧增量 dx 抖动

把 dx 改成「相对上一帧的增量」后，反向能跟随了，但每帧 dx 在原生拖拽期间是**抖动**的——亚像素噪声 + `mousemove` 投递不均匀（`startDragging()` 的 OS 拖拽循环里事件到来不规整）。于是 dx 符号在一帧帧之间反复跳变，handleDrag 每跳一次就把动画重置到第 0 帧 → 视觉上左右闪烁 + 卡顿暂停。

## 方案

增量 dx + 低通滤波（动量），两步分别对应两个根因：

1. 用 `lastDragScreenX` 记录上一帧消费过的光标 X，每帧算**增量** `dx = e.screenX - lastDragScreenX`（解决根因 1：反向当帧即变号）。
2. 把 dx 平滑成动量 `dragMomX = dragMomX * DRAG_MOMENTUM_DECAY + dx`（[main.js](../../cross-platform/src/main.js#L382)，衰减 0.6），只有 `|dragMomX|` 超过 `DRAG_DIR_THRESHOLD`（1.0）才提交方向给动画器（解决根因 2：单帧抖动压不过阈值，方向不变）。

效果（[processMove](../../cross-platform/src/main.js#L844)）：

| 情况 | 行为 |
|---|---|
| 稳定单向拖动 | 动量稳态远超阈值 → 方向稳定，不闪 |
| 单帧抖动（含小幅反向） | 被动量吸收，压不过阈值 → 方向不变，不重置动画 |
| 真正持续反向 | 动量约 1~2 帧（~30ms）越过阈值 → 立即转向 |
| 拖动中停住不动 | 动量衰减到阈值以下 → 不再调 handleDrag，保持当前方向（不反复重置） |

阈值/衰减在 [main.js 顶部](../../cross-platform/src/main.js#L382-L383) 集中定义，手感可调：更稳则调高 `DRAG_DIR_THRESHOLD` 或调大 `DRAG_MOMENTUM_DECAY`；更跟手则反之。

## 实施清单

- [x] 新增 `lastDragScreenX` 跟踪上一帧光标 X，`processMove` 改用增量 dx
- [x] 新增动量 `dragMomX` + `DRAG_MOMENTUM_DECAY` / `DRAG_DIR_THRESHOLD`，过阈值才提交方向
- [x] 拖拽开始初始化、`resetDragState` 清空（`lastDragScreenX` / `dragMomX`）
- [x] renderer.md「拖动动画」同步更新为增量 + 动量描述
- [x] ESLint + Prettier 通过
