# Bug：idle 状态眨眼太快，像在抽搐

## 现象

宠物处于 `idle`（静止）状态时，眨眼动作频率极高、节奏也不对——眼睛几乎每隔零点几秒就「唰」地眨一下，看起来像在抽搐，而不是真人那种「长时间睁眼、偶尔一瞬」的自然节奏。整体帧切换也偏快，画面一直在动，没有「静止呼吸」的感觉。

## 复现快照

- `idle` 只有 **6 帧**（[frames-manifest.json](../../../kotori-minami/frames/frames-manifest.json) `idle` 行，`00.png`~`05.png`），且设计意图就是 [pet_request.json:19](../../../kotori-minami/pet_request.json#L19) 里写的 `"calm resting, breathing, and blinking loop"`——6 帧同时编码了「呼吸 + 眨眼」一整套循环。
- 全局帧率写死 **10 fps**（[config.json:10](../../cross-platform/config.json#L10) `"fps": 10`），所以每一帧固定停留 100ms。

于是整段 idle 循环耗时 = 6 帧 × 100ms = **600ms 转一圈**，眨眼动作大约每秒重复 1~2 次。真人眨眼频率是 3~4 秒一次，差了一个数量级。

---

## 根因

三个原因叠加，缺一不可：

### 根因 1：动画引擎只支持「等间隔轮播」，没有「某帧多停留」的能力

[animator.js:142-158](../../cross-platform/src/animator.js#L142-L158) 的 `tick()`：

```js
tick() {
  const frames = this.frames[this.currentState];
  this.currentFrameIndex++;
  // one-shot 分支略
  this.currentFrameIndex = this.currentFrameIndex % frames.length;
  this.showCurrentFrame();
}
```

每一帧占用的时间都是一样的 100ms。引擎里**没有「这张图多停一会儿」的概念**——睁眼帧和闭眼帧停留时间完全相同。结果：睁眼帧被快速略过，眨眼本身也一闪而过，紧接着又来一次。

这是核心问题。眨眼天生是非匀速的（长时间睁眼 + 偶尔一瞬），用匀速轮播表达必然失真。

### 根因 2：idle 把「呼吸」和「眨眼」塞进同一条 6 帧循环

[pet_request.json:19](../../../kotori-minami/pet_request.json#L19) 把 idle 的 purpose 写成 `breathing, and blinking loop`——两个节奏完全不同的动作被压进同一条轨道。呼吸应该是慢周期（1~2s），眨眼是偶发事件（几秒一次），但这里两者共享同一组 6 帧、同一个 100ms/帧 的节拍，于是眨眼被呼吸的循环频率拖着一起变快。

### 根因 3：全局 fps=10 对所有状态一刀切

[config.json:10](../../cross-platform/config.json#L10) 的 `fps` 是全局的，`running` / `jumping` 这种动作状态需要 10fps 才流畅，但 idle 用 10fps 就太快了。引擎没有「按 state 区分帧率」的机制，无法对慢节奏状态单独降速。

---

## 修复方案

推荐组合 **改动 ① + ②**：① 给引擎加「每帧停留时长」(frame hold)，② 用它把 idle 的睁眼帧拉长。两者互为依赖。改动 ③ 是更轻量的临时方案，不想改引擎时可用。

### 改动 ① — 引擎支持「每帧停留时长」(frame hold)

**涉及文件**：[animator.js](../../cross-platform/src/animator.js)

**思路**：给当前 state 的每一帧一个「hold 倍数」，`tick()` 里维护一个「剩余停留 tick 数」计数器，只有计数归零才前进到下一帧。

**配置 schema**（config.json `renderer` 下新增）：

```json
"frame_timing": {
  "default": { "holds": [1] },
  "idle": { "holds": [3, 2, 1, 1, 1, 10] }
}
```

- `holds` 是与帧一一对应的整数数组，单位是「tick」（1 tick = `1/fps` 秒 = 100ms）。
- `[1]` 表示每帧停 1 个 tick（即旧行为，匀速）。
- `idle` 例子里第 0 帧停 300ms、第 5 帧停 1000ms（长睁眼），中间眨眼帧各 100ms，模拟「长时间睁眼 → 快速眨一下 → 再长睁眼」。

**animator.js Before**（[tick()](../../cross-platform/src/animator.js#L142-L158) 精简版）：

```js
tick() {
  const frames = this.frames[this.currentState];
  this.currentFrameIndex++;
  this.currentFrameIndex = this.currentFrameIndex % frames.length;
  this.showCurrentFrame();
}
```

**animator.js After**：

```js
constructor() {
  // ...existing...
  this.frameTiming = {};        // { state: [hold, ...] }
  this.holdRemaining = 1;       // 当前帧还剩几个 tick 才前进
}

setFrameTiming(timing) {        // 从 config 灌入
  this.frameTiming = timing || {};
}

// 取当前帧的 hold 倍数，缺省 1
holdFor(state, idx) {
  const holds = this.frameTiming[state]?.holds;
  if (!holds || idx >= holds.length) return 1;
  return Math.max(1, holds[idx]);
}

tick() {
  const frames = this.frames[this.currentState];
  if (!frames || frames.length === 0) return;

  this.holdRemaining--;
  if (this.holdRemaining > 0) return;   // 当前帧还没停够，不切换

  // 前进到下一帧（one-shot 分支保持原样，略）
  this.currentFrameIndex++;
  if (ONE_SHOT_STATES.has(this.currentState) && this.currentFrameIndex >= frames.length) {
    this.currentState = this.preOneShotState;
    this.preOneShotState = "idle";
    this.currentFrameIndex = 0;
  } else {
    this.currentFrameIndex = this.currentFrameIndex % frames.length;
  }
  this.holdRemaining = this.holdFor(this.currentState, this.currentFrameIndex);
  this.showCurrentFrame();
}
```

注意：`transitionTo` / `triggerOneShot` / `handleDrag` 等切换状态的地方，切完后要把 `holdRemaining` 重置为新状态第 0 帧的 hold 值，否则切进来会多停一拍。

### 改动 ② — 给 idle 配上「长睁眼 + 快眨眼」的 holds 表

**文件**：[config.json](../../cross-platform/config.json) + [config.example.json](../../cross-platform/config.example.json)

**Before**：`renderer` 下只有 `"fps": 10`，无 `frame_timing`。

**After**：

```json
"frame_timing": {
  "default": { "holds": [1] },
  "idle": { "holds": [3, 2, 1, 1, 1, 10] }
}
```

**⚠️ 前置确认**：上面 `idle.holds` 的具体数组**需要先用肉眼看一遍 [idle/](../../../kotori-minami/frames/idle) 的 6 帧到底是哪几帧睁眼、哪几帧半闭、哪几帧全闭**，再据此分配 hold 值（睁眼帧给大值、眨眼帧给 1）。当前文档里的 `[3,2,1,1,1,10]` 是占位示例，不代表真实帧序。确认后把数组写实，并在本文件补一行注明「第 N 帧是睁眼」。

**效果**：以 `[3,2,1,1,1,10]` 为例，idle 一圈 = (3+2+1+1+1+10) × 100ms = **1.8s**，其中眨眼那几帧只占 300ms，睁眼停留 1s+，节奏接近真人。

### 改动 ③ — （可选临时方案）给 idle 单独降速

**适用**：不想改引擎、能接受「呼吸也变慢」时。

**思路**：把全局 `fps` 改成「按 state 可配」，idle 跑 3fps（一圈 2s），动作状态仍 10fps。实现上把 `setInterval` 的周期改成读 `stateFps[currentState]`，切换状态时重建 timer。

**为什么不作为主方案**：它只是把整条循环拉慢，呼吸和眨眼一起慢，**没有解决「眨眼应该偶发」这个本质**——idle 会变成「每 2 秒慢动作眨一次」，比现在好但仍不自然。优先用改动 ①+②。

---

## 实施清单

- [ ] 改动 ①：[animator.js](../../cross-platform/src/animator.js) 加 `frameTiming` / `holdRemaining` / `holdFor`，改 `tick()`；`transitionTo`/`triggerOneShot`/`handleDrag` 切换后重置 `holdRemaining`
- [ ] 改动 ①：[main.js](../../cross-platform/src/main.js) 从 config 灌入 `frame_timing`
- [ ] 改动 ②：肉眼确认 [idle/](../../../kotori-minami/frames/idle) 6 帧的睁眼/闭眼分布，把真实 `holds` 数组写实
- [ ] 改动 ②：[config.json](../../cross-platform/config.json) + [config.example.json](../../cross-platform/config.example.json) 加 `frame_timing` 字段及注释
- [ ] 手动验证：
  - [ ] idle 状态下眨眼间隔 ≥ 2~3s，睁眼帧明显停留
  - [ ] `running` / `jumping` 等动作状态帧率不变、仍流畅
  - [ ] 从 idle 切到 running 再切回 idle，hold 计数器正确重置（不卡帧、不多停一拍）

---

## 不做的事情

明确列出**考虑过但决定不做**的方案，避免后人反复纠结：

| 方案 | 不做的原因 |
|---|---|
| 把全局 `fps` 直接降到 3~4 | 会拖慢 `running`/`jumping` 这些动作状态，整体变卡。问题本质是 idle 缺 hold，不是全局太快。|
| 重新生成 idle 素材，把「睁眼帧重复 20 次」烘焙进 PNG 序列 | 不用改代码，但要重新跑图像生成流程、重出素材，成本高且不可调。引擎层加 hold 后这个可随时回退兜底。|
| 引入随机眨眼间隔（每 N 秒以概率 P 触发一次眨眼） | 更拟真，但要拆分「常驻呼吸帧」和「眨眼事件帧」两套素材，工程量大。等 hold 方案落地、确有「太规律」的真实痛点再加。|
| 把「呼吸」和「眨眼」拆成两条独立动画轨道 | 根因 2 的彻底解法，但需要重做素材分层（base + 眼睛 overlay），改动画引擎的状态合成逻辑。先靠 hold 表压住节奏，分层留作后续优化。|

---

## 风险

| 风险 | 缓解 |
|---|---|
| `holds` 数组长度和实际帧数对不上（改了素材但没改 config） | `holdFor()` 里 `idx >= holds.length` 时回退到 1，宁可匀速也不崩；读取 config 时校验并 warn。|
| 切换状态时 `holdRemaining` 没重置，导致进新状态多停一拍 / 卡帧 | 所有切状态入口（`transitionTo`/`triggerOneShot`/`handleDrag`）切完后统一调用一个 `resetToFrame0()`，集中收敛。|
| `holds` 具体值靠肉眼定的，可能仍偏快/偏慢 | 全部走 config，不改代码即可调；交付时附一组推荐值并在 example 里注释说明。|
