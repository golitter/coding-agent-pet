/**
 * 精灵动画引擎——等价于 FrameCache.swift + SpriteAnimator.swift
 * 加载 PNG 帧、驱动动画循环、处理状态切换。
 */

// 精灵基础尺寸——导出供 main.js 布局计算使用。
export const SPRITE_W = 192;
export const SPRITE_H = 208;

const STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];

const ONE_SHOT_STATES = new Set(["jumping", "waving"]);
const STATE_FPS = {
  idle: 7,
  waiting: 7,
  failed: 7,
  review: 8,
  waving: 8,
  jumping: 10,
  running: 10,
  "running-left": 10,
  "running-right": 10,
};
const BACKGROUND_FPS_FACTOR = 0.6;
const MIN_BACKGROUND_FPS = 4;
const ALPHA_MASK_PINNED_STATES = new Set(["idle", "running-left", "running-right"]);
const ALPHA_MASK_CACHE_LIMIT = 4;

export class SpriteAnimator {
  constructor() {
    this.frames = {}; // { 状态名: [Image, ...] }
    this.currentState = "idle";
    this.currentFrameIndex = 0;
    this.preDragState = "idle";
    this.preOneShotState = "idle";
    this.timer = null;
    this.fps = 10;
    this.isFocused = true;
    this.effectiveFps = 10;
    this.onFrame = null; // 回调（imageElement）
    this.frameTiming = {}; // { 状态名: { holds: [tickCount, ...] } }
    this.holdRemaining = 1;

    // 用于逐像素命中检测的 alpha 掩码系统
    this.alphaMasks = new Map(); // 状态名 → Uint8Array[]（按帧序号索引）
    this.alphaMaskLoadPromises = new Map(); // 状态名 → Promise<void>
    this.framePaths = {}; // { 状态名: [nativePath, ...] }——用于读取字节的原始文件系统路径
    this.baseWidth = SPRITE_W;
    this.baseHeight = SPRITE_H;
    this.hitTestReady = false;
    this.pendingOneShot = null; // 当前结束后将触发的排队一次性动画
    this.hoverJumpCyclesRemaining = 0;
  }

  async loadImage(nativePath) {
    const loadFromUrl = async (url) => {
      const img = new Image();
      const loaded = await new Promise((resolve) => {
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
      });
      return loaded ? img : null;
    };

    try {
      const bytes = await window.__TAURI__.core.invoke("read_file_bytes", {
        path: nativePath,
      });
      const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
      const blobUrl = URL.createObjectURL(blob);
      const img = await loadFromUrl(blobUrl);
      if (img) {
        // 注意：有意在该 Image 的整个生命周期内保留 object URL。
        // 精灵帧被长期缓存，并在每个动画 tick 重绘，因此在加载后（即使 img.decode()
        // 之后）撤销 blob URL 会导致 WebView2 丢弃已解码的位图，宠物会渲染为空白。
        // 该“泄漏”是有界的（每帧一个 URL，固定数量），可接受。
        img.dataset.objectUrl = blobUrl;
        return img;
      }
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      console.warn("[Animator] image byte load failed:", nativePath, e);
    }

    return null;
  }

  setFrameTiming(timing) {
    this.frameTiming = timing || {};
    this.resetHold();
  }

  /** 通过 Tauri asset 协议从磁盘预加载所有精灵帧。
   *
   * 使用 `frames-manifest.json`（与各状态目录同级）来精确获知每个状态有多少帧，
   * 从而避免旧的“逐个尝试加载直到失败”的探测方式——那种方式每次启动会在 Tauri
   * 日志里留下 9 行 ERROR。
   *
   * 清单中的路径在生成机器上是绝对路径，因此我们将它们改写为
   * `${framesDir}/${state}/${basename}`——清单是加载*什么*的事实来源，运行时负责
   * 解析*从哪*加载。
   */
  async loadFrames(framesDir, fps) {
    this.fps = fps || 10;
    this.effectiveFps = this.getTargetFps();

    // 1. 优先尝试通过清单加载。通过 IPC 读取字节而非 fetch()：
    // WKWebView 对 JSON 的 asset 响应可能不一致，否则会让我们悄悄落入旧的探测
    // 路径，重新引入缺失哨兵帧导致的启动期“file does not exist”噪声。
    const manifestPath = `${framesDir}/frames-manifest.json`;
    let manifestRows = null;
    try {
      const manifestBytes = await window.__TAURI__.core.invoke("read_file_bytes", {
        path: manifestPath,
      });
      if (manifestBytes) {
        const manifestText = new TextDecoder().decode(new Uint8Array(manifestBytes));
        const manifest = JSON.parse(manifestText);
        if (manifest && Array.isArray(manifest.rows)) {
          manifestRows = manifest.rows;
        } else {
          console.warn("[Animator] manifest missing rows array, falling back to probe");
        }
      }
    } catch (e) {
      console.warn("[Animator] manifest load failed, falling back to probe:", e);
    }

    if (manifestRows) {
      for (const row of manifestRows) {
        const state = row.state;
        if (!state || !Array.isArray(row.frames)) continue;
        // 并行加载所有帧——避免对每张图片顺序 await
        const loadResults = await Promise.all(
          row.frames.map(async (absPath) => {
            const basename = String(absPath).split(/[\\/]/).pop();
            const nativePath = `${framesDir}/${state}/${basename}`;
            const img = await this.loadImage(nativePath);
            return img ? { img, nativePath } : null;
          }),
        );
        const validResults = loadResults.filter(Boolean);
        this.frames[state] = validResults.map((result) => result.img);
        this.framePaths[state] = validResults.map((result) => result.nativePath);
      }
    } else {
      // 回退：旧式探测（保留以便清单缺失时不会导致应用不可用）
      for (const state of STATES) {
        const frames = [];
        const paths = [];
        let i = 0;
        while (true) {
          const padded = String(i).padStart(2, "0");
          const nativePath = `${framesDir}/${state}/${padded}.png`;
          const img = await this.loadImage(nativePath);
          if (!img) break;
          frames.push(img);
          paths.push(nativePath);
          i++;
        }
        this.frames[state] = frames;
        this.framePaths[state] = paths;
      }
    }

    const total = Object.values(this.frames).reduce((sum, arr) => sum + arr.length, 0);
    console.log(
      `[Animator] ✓ Loaded ${total} frames across ${Object.keys(this.frames).length} states`,
    );
    window.__TAURI__.core
      .invoke("js_log", {
        level: total > 0 ? "info" : "error",
        tag: "Animator",
        msg: `Loaded ${total} frames from ${framesDir}`,
      })
      .catch(() => {});

    // 预热启动期 / 拖拽时最常用的交互状态。
    await this.ensureAlphaMasksForStates(["idle", "running-left", "running-right"]);
    this.pruneAlphaMasks();
  }

  /** 启动动画循环 */
  start() {
    if (this.timer) return;
    this.resetHold();
    this.showCurrentFrame();
    this.restartTimer();
    console.log(`[Animator] ✓ Started at ${this.effectiveFps} FPS`);
  }

  /** 停止动画循环 */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setFocused(isFocused) {
    if (this.isFocused === isFocused) return;
    this.isFocused = isFocused;
    this.updatePlaybackRate();
  }

  /** 切换到新的动画状态 */
  transitionTo(state) {
    if (this.isHoverJumping()) {
      if (state === "idle") return;
      this.stopHoverJump({ showFrame: false });
    }
    if (state === this.currentState) return;
    if (!this.frames[state]) {
      console.warn(`[Animator] ⚠️ Unknown state: ${state}`);
      return;
    }
    // 若当前处于一次性动画中，则更新还原目标
    if (ONE_SHOT_STATES.has(this.currentState) && !ONE_SHOT_STATES.has(state)) {
      this.preOneShotState = state;
    }
    this.currentState = state;
    this.currentFrameIndex = 0;
    this.resetHold();
    this.showCurrentFrame();
    this.ensureAlphaMasksForStates([state]).catch(() => {});
    this.pruneAlphaMasks();
    this.updatePlaybackRate();
  }

  /** 触发一次性动画（jumping、waving）。
   *  若已有一次性动画在播放，则新的会被排队，在当前动画结束后触发——避免
   *  重复的 Stop 事件被静默吞掉。 */
  triggerOneShot(state) {
    if (!ONE_SHOT_STATES.has(state)) return;
    if (!this.frames[state]) return;
    if (this.isHoverJumping()) {
      this.stopHoverJump({ showFrame: false });
    }
    // 若已有一次性动画在播放，则排队
    if (ONE_SHOT_STATES.has(this.currentState)) {
      this.pendingOneShot = state;
      return;
    }
    this.preOneShotState = this.currentState;
    this.currentState = state;
    this.currentFrameIndex = 0;
    this.resetHold();
    this.showCurrentFrame();
    this.ensureAlphaMasksForStates([state]).catch(() => {});
    this.pruneAlphaMasks();
    this.updatePlaybackRate();
  }

  /** 仅在 idle 态播放悬停跳跃，固定整周期数。 */
  triggerHoverJump(cycles = 2) {
    const cycleCount = Math.max(1, Math.floor(Number(cycles) || 0));
    if (!this.frames.jumping || this.currentState !== "idle") return false;

    this.hoverJumpCyclesRemaining = cycleCount;
    this.currentState = "jumping";
    this.currentFrameIndex = 0;
    this.resetHold();
    this.showCurrentFrame();
    this.ensureAlphaMasksForStates(["jumping"]).catch(() => {});
    this.pruneAlphaMasks();
    this.updatePlaybackRate();
    return true;
  }

  stopHoverJump({ showFrame = true } = {}) {
    if (!this.isHoverJumping()) return false;

    this.hoverJumpCyclesRemaining = 0;
    this.currentState = "idle";
    this.currentFrameIndex = 0;
    this.resetHold();
    if (showFrame) {
      this.showCurrentFrame();
    }
    this.ensureAlphaMasksForStates(["idle"]).catch(() => {});
    this.pruneAlphaMasks();
    this.updatePlaybackRate();
    return true;
  }

  isHoverJumping() {
    return this.hoverJumpCyclesRemaining > 0;
  }

  /** 根据拖拽方向处理奔跑动画 */
  handleDrag(dx) {
    if (dx !== 0 && this.isHoverJumping()) {
      this.stopHoverJump({ showFrame: false });
    }
    if (dx > 0.5) {
      if (this.currentState !== "running-right" && this.currentState !== "running-left") {
        this.preDragState = this.currentState;
      }
      if (this.currentState !== "running-right") {
        this.currentState = "running-right";
        this.currentFrameIndex = 0;
        this.resetHold();
        this.ensureAlphaMasksForStates(["running-right"]).catch(() => {});
        this.pruneAlphaMasks();
        this.updatePlaybackRate();
      }
    } else if (dx < -0.5) {
      if (this.currentState !== "running-right" && this.currentState !== "running-left") {
        this.preDragState = this.currentState;
      }
      if (this.currentState !== "running-left") {
        this.currentState = "running-left";
        this.currentFrameIndex = 0;
        this.resetHold();
        this.ensureAlphaMasksForStates(["running-left"]).catch(() => {});
        this.pruneAlphaMasks();
        this.updatePlaybackRate();
      }
    } else if (dx === 0) {
      if (this.currentState === "running-right" || this.currentState === "running-left") {
        const restore =
          this.preDragState === "running-right" || this.preDragState === "running-left"
            ? "idle"
            : this.preDragState;
        this.currentState = restore;
        this.currentFrameIndex = 0;
        this.resetHold();
        this.showCurrentFrame();
        this.ensureAlphaMasksForStates([restore]).catch(() => {});
        this.pruneAlphaMasks();
        this.updatePlaybackRate();
      }
    }
  }

  async ensureAlphaMasksForStates(states) {
    const uniqueStates = [...new Set(states)].filter(
      (state) => state && this.framePaths[state]?.length,
    );
    await Promise.all(uniqueStates.map((state) => this.ensureAlphaMasksForState(state)));
    this.hitTestReady = this.alphaMasks.size > 0;
  }

  /** 仅对请求的状态计算 alpha 掩码。
   *  这样启动开销更低，避免在仅当前/邻近状态可交互时把每一帧的掩码都钉在
   *  内存里。 */
  async ensureAlphaMasksForState(state) {
    if (this.hasCompleteAlphaMaskState(state)) return;
    if (this.alphaMaskLoadPromises.has(state)) {
      await this.alphaMaskLoadPromises.get(state);
      return;
    }

    const task = this.computeAlphaMasksForState(state).finally(() => {
      this.alphaMaskLoadPromises.delete(state);
      this.hitTestReady = this.alphaMasks.size > 0;
    });
    this.alphaMaskLoadPromises.set(state, task);
    await task;
  }

  async computeAlphaMasksForState(state) {
    const paths = this.framePaths[state];
    if (!paths || paths.length === 0) return;

    const canvas = document.createElement("canvas");
    canvas.width = this.baseWidth;
    canvas.height = this.baseHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    let stateMaskCount = 0;
    let failCount = 0;
    const masks = new Array(paths.length);

    try {
      let bytesMap;
      try {
        bytesMap = await window.__TAURI__.core.invoke("read_frames_batch", {
          paths,
        });
      } catch (e) {
        console.warn(`[Animator] Batch read failed for state ${state}, hit-test disabled:`, e);
        return;
      }

      const loadedImages = await Promise.all(
        paths.map(async (nativePath, i) => {
          const bytes = bytesMap[nativePath];
          if (!bytes) return null;

          const u8 = new Uint8Array(bytes);
          const blob = new Blob([u8], { type: "image/png" });
          const cleanUrl = URL.createObjectURL(blob);

          const cleanImg = await new Promise((resolve) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => resolve(null);
            im.src = cleanUrl;
          });
          if (!cleanImg) {
            URL.revokeObjectURL(cleanUrl);
            return null;
          }
          return { i, cleanImg, cleanUrl };
        }),
      );

      for (const item of loadedImages) {
        if (!item) {
          failCount++;
          continue;
        }
        const { i, cleanImg, cleanUrl } = item;

        ctx.clearRect(0, 0, this.baseWidth, this.baseHeight);
        ctx.drawImage(cleanImg, 0, 0, this.baseWidth, this.baseHeight);
        URL.revokeObjectURL(cleanUrl);

        const imageData = ctx.getImageData(0, 0, this.baseWidth, this.baseHeight);
        const data = imageData.data;
        const alpha = new Uint8Array(this.baseWidth * this.baseHeight);
        for (let j = 0, k = 3; j < alpha.length; j++, k += 4) {
          alpha[j] = data[k];
        }
        masks[i] = alpha;
        stateMaskCount++;
      }

      this.alphaMasks.set(state, masks);

      console.log(
        `[Animator] ✓ Computed ${stateMaskCount} alpha masks for ${state} (${failCount} failed)`,
      );
    } catch (e) {
      console.warn(`[Animator] ⚠️ computeAlphaMasksForState failed for ${state}:`, e);
      this.alphaMasks.delete(state);
    }
  }

  hasCompleteAlphaMaskState(state) {
    const stateMasks = this.alphaMasks.get(state);
    const frameCount = this.framePaths[state]?.length ?? 0;
    if (!Array.isArray(stateMasks) || frameCount === 0) return false;
    if (stateMasks.length !== frameCount) return false;
    // 稠密检查：直接按下标读取会把稀疏数组的空洞视为 undefined（falsy），
    // 因此能拒绝部分填充的数组——而 Array.prototype.every 会跳过空洞，
    // 错误地把它们当作完整。
    for (let i = 0; i < frameCount; i++) {
      if (!stateMasks[i]) return false;
    }
    return true;
  }

  pruneAlphaMasks() {
    const preserve = new Set([
      ...ALPHA_MASK_PINNED_STATES,
      this.currentState,
      this.preDragState,
      this.preOneShotState,
      this.pendingOneShot,
    ]);
    const removableStates = [...this.alphaMasks.keys()].filter((state) => !preserve.has(state));
    while (this.alphaMasks.size > ALPHA_MASK_CACHE_LIMIT && removableStates.length > 0) {
      const state = removableStates.shift();
      this.alphaMasks.delete(state);
    }
    this.hitTestReady = this.alphaMasks.size > 0;
  }

  /** 查询给定精灵像素坐标处的 alpha 值。
   *  当系统未就绪或掩码缺失时，作为兜底返回 255（不透明）——防止宠物变得
   *  无法点击。 */
  getAlphaAt(state, frameIndex, x, y) {
    if (!this.hitTestReady) return 255;
    const stateMasks = this.alphaMasks.get(state);
    if (!stateMasks) return 255;
    const mask = stateMasks[frameIndex];
    if (!mask) return 255;
    const cx = Math.max(0, Math.min(this.baseWidth - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(this.baseHeight - 1, Math.round(y)));
    return mask[cy * this.baseWidth + cx];
  }

  getTargetFps() {
    const stateFps = STATE_FPS[this.currentState] ?? this.fps;
    if (this.isFocused) return stateFps;
    return Math.max(MIN_BACKGROUND_FPS, Math.round(stateFps * BACKGROUND_FPS_FACTOR));
  }

  updatePlaybackRate() {
    const nextFps = this.getTargetFps();
    if (Math.abs(nextFps - this.effectiveFps) < 0.01) return;
    this.effectiveFps = nextFps;
    if (this.timer) {
      this.restartTimer();
    }
  }

  restartTimer() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => this.tick(), 1000 / this.effectiveFps);
  }

  // --- 私有方法 ---

  tick() {
    const frames = this.frames[this.currentState];
    if (!frames || frames.length === 0) return;

    this.holdRemaining--;
    if (this.holdRemaining > 0) return;

    this.currentFrameIndex++;

    if (
      this.isHoverJumping() &&
      this.currentState === "jumping" &&
      this.currentFrameIndex >= frames.length
    ) {
      this.hoverJumpCyclesRemaining--;
      if (this.hoverJumpCyclesRemaining > 0) {
        this.currentFrameIndex = 0;
        this.resetHold();
      } else {
        this.currentState = "idle";
        this.currentFrameIndex = 0;
        this.resetHold();
        this.ensureAlphaMasksForStates(["idle"]).catch(() => {});
        this.pruneAlphaMasks();
        this.updatePlaybackRate();
      }
      // 一次性：播放完整一轮后回到之前的状态（或触发排队的一次性动画）
    } else if (ONE_SHOT_STATES.has(this.currentState) && this.currentFrameIndex >= frames.length) {
      if (this.pendingOneShot) {
        const next = this.pendingOneShot;
        this.pendingOneShot = null;
        this.currentState = next;
        this.currentFrameIndex = 0;
        this.resetHold();
      } else {
        this.currentState = this.preOneShotState;
        this.preOneShotState = "idle";
        this.currentFrameIndex = 0;
        this.resetHold();
      }
    } else {
      this.currentFrameIndex = this.currentFrameIndex % frames.length;
      this.resetHold();
    }

    this.showCurrentFrame();
  }

  showCurrentFrame() {
    const frames = this.frames[this.currentState];
    if (!frames || this.currentFrameIndex >= frames.length) return;
    if (this.onFrame) {
      this.onFrame(frames[this.currentFrameIndex]);
    }
  }

  holdFor(state, frameIndex) {
    const stateTiming = this.frameTiming?.[state];
    const defaultTiming = this.frameTiming?.default;
    const stateHolds = stateTiming?.holds;
    const defaultHolds = defaultTiming?.holds;
    let rawHold = 1;
    if (Array.isArray(stateHolds) && frameIndex < stateHolds.length) {
      rawHold = stateHolds[frameIndex];
    } else if (Array.isArray(defaultHolds) && defaultHolds.length > 0) {
      rawHold = defaultHolds[frameIndex] ?? defaultHolds[0];
    }
    const hold = Number(rawHold);
    return Number.isFinite(hold) ? Math.max(1, Math.floor(hold)) : 1;
  }

  resetHold() {
    this.holdRemaining = this.holdFor(this.currentState, this.currentFrameIndex);
  }
}
