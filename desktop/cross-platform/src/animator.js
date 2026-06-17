/**
 * Sprite animation engine — equivalent to FrameCache.swift + SpriteAnimator.swift
 * Loads PNG frames, drives animation loop, handles state transitions.
 */

// Sprite base dimensions — exported for use in main.js layout calculations.
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
    this.frames = {}; // { stateName: [Image, ...] }
    this.currentState = "idle";
    this.currentFrameIndex = 0;
    this.preDragState = "idle";
    this.preOneShotState = "idle";
    this.timer = null;
    this.fps = 10;
    this.isFocused = true;
    this.effectiveFps = 10;
    this.onFrame = null; // callback(imageElement)
    this.frameTiming = {}; // { stateName: { holds: [tickCount, ...] } }
    this.holdRemaining = 1;

    // Alpha mask system for per-pixel hit testing
    this.alphaMasks = new Map(); // stateName → Uint8Array[] (indexed by frame number)
    this.alphaMaskLoadPromises = new Map(); // stateName → Promise<void>
    this.framePaths = {}; // { stateName: [nativePath, ...] } — raw FS paths for byte reads
    this.baseWidth = SPRITE_W;
    this.baseHeight = SPRITE_H;
    this.hitTestReady = false;
    this.pendingOneShot = null; // queued one-shot to fire after current finishes
    this.hoverJumpCyclesRemaining = 0;
  }

  async loadImage(nativePath) {
    const { convertFileSrc } = window.__TAURI__.core;
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
        img.dataset.objectUrl = blobUrl;
        return img;
      }
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Fall back to the Tauri asset protocol for older builds/configs where
      // the byte-read IPC is unavailable.
    }

    return loadFromUrl(convertFileSrc(nativePath));
  }

  setFrameTiming(timing) {
    this.frameTiming = timing || {};
    this.resetHold();
  }

  /** Pre-load all sprite frames from disk via Tauri asset protocol.
   *
   * Uses `frames-manifest.json` (sibling of state directories) to know exactly
   * how many frames each state has, avoiding the legacy "fetch-and-fail"
   * probing that polluted the Tauri log with 9 ERROR lines per startup.
   *
   * Manifest paths are absolute on the generation machine, so we rewrite them
   * to `${framesDir}/${state}/${basename}` — manifest acts as the source of
   * truth for *what* to load; the runtime resolves *where*.
   */
  async loadFrames(framesDir, fps) {
    this.fps = fps || 10;
    this.effectiveFps = this.getTargetFps();

    // 1. Try loading via manifest first. Read bytes via IPC instead of fetch():
    // WKWebView asset responses can be inconsistent for JSON, which would
    // silently drop us into the legacy probe path and reintroduce startup
    // "file does not exist" noise for the missing sentinel frame.
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
        // Load all frames in parallel — avoids sequential await on each image
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
      // Fallback: legacy probe (kept so a missing manifest doesn't break the app)
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

    // Warm the interactive states used most often at startup / drag time.
    await this.ensureAlphaMasksForStates(["idle", "running-left", "running-right"]);
    this.pruneAlphaMasks();
  }

  /** Start the animation loop */
  start() {
    if (this.timer) return;
    this.resetHold();
    this.showCurrentFrame();
    this.restartTimer();
    console.log(`[Animator] ✓ Started at ${this.effectiveFps} FPS`);
  }

  /** Stop the animation loop */
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

  /** Transition to a new animation state */
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
    // If currently in a one-shot, update restore target
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

  /** Trigger a one-shot animation (jumping, waving).
   *  If a one-shot is already playing, the new one is queued and fires
   *  when the current animation finishes — preventing double-Stop events
   *  from being silently swallowed. */
  triggerOneShot(state) {
    if (!ONE_SHOT_STATES.has(state)) return;
    if (!this.frames[state]) return;
    if (this.isHoverJumping()) {
      this.stopHoverJump({ showFrame: false });
    }
    // Queue if a one-shot is already playing
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

  /** Play the idle-only hover jump for a fixed number of full cycles. */
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

  /** Handle drag direction for running animation */
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

  /** Compute alpha masks only for requested states.
   *  This keeps startup cheaper and avoids pinning every frame's mask in
   *  memory when only the current / nearby states are interactable. */
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
    // Dense check: a plain index read treats sparse-array holes as undefined
    // (falsy), so this rejects partially-filled arrays — which
    // Array.prototype.every skips and would falsely accept as complete.
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

  /** Look up the alpha value at a given sprite pixel coordinate.
   *  Returns 255 (opaque) as a fail-safe when the system is not ready or
   *  the mask is missing — this prevents the pet from becoming unclickable. */
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

  // --- Private ---

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
      // One-shot: play full cycle then return to previous state (or fire queued one-shot)
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
