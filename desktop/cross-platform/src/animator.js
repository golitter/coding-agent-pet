/**
 * Sprite animation engine — equivalent to FrameCache.swift + SpriteAnimator.swift
 * Loads PNG frames, drives animation loop, handles state transitions.
 */

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

export class SpriteAnimator {
  constructor() {
    this.frames = {}; // { stateName: [Image, ...] }
    this.currentState = "idle";
    this.currentFrameIndex = 0;
    this.preDragState = "idle";
    this.preOneShotState = "idle";
    this.timer = null;
    this.fps = 10;
    this.onFrame = null; // callback(imageElement)

    // Alpha mask system for per-pixel hit testing
    this.alphaMasks = new Map(); // key: "state:idx" → Uint8Array (baseWidth×baseHeight)
    this.framePaths = {}; // { stateName: [nativePath, ...] } — raw FS paths for byte reads
    this.baseWidth = 192;
    this.baseHeight = 208;
    this.hitTestReady = false;
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
    const { convertFileSrc } = window.__TAURI__.core;

    // 1. Try loading via manifest first
    const manifestUrl = convertFileSrc(`${framesDir}/frames-manifest.json`);
    let manifestRows = null;
    try {
      const res = await fetch(manifestUrl);
      if (res.ok) {
        const manifest = await res.json();
        if (manifest && Array.isArray(manifest.rows)) {
          manifestRows = manifest.rows;
        }
      }
    } catch (e) {
      console.warn("[Animator] manifest load failed, falling back to probe:", e);
    }

    if (manifestRows) {
      for (const row of manifestRows) {
        const state = row.state;
        if (!state || !Array.isArray(row.frames)) continue;
        const frames = [];
        const paths = [];
        for (const absPath of row.frames) {
          // Extract just the filename — manifest paths are machine-specific.
          const basename = String(absPath).split("/").pop();
          const nativePath = `${framesDir}/${state}/${basename}`;
          const url = convertFileSrc(nativePath);
          const img = new Image();
          img.src = url;
          await new Promise((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
          });
          frames.push(img);
          paths.push(nativePath);
        }
        this.frames[state] = frames;
        this.framePaths[state] = paths;
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
          const url = convertFileSrc(nativePath);
          const img = new Image();
          img.src = url;
          const loaded = await new Promise((resolve) => {
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
          });
          if (!loaded) break;
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

    // Pre-compute alpha masks for per-pixel hit testing
    await this.computeAlphaMasks();
  }

  /** Start the animation loop */
  start() {
    if (this.timer) return;
    this.showCurrentFrame();
    this.timer = setInterval(() => this.tick(), 1000 / this.fps);
    console.log(`[Animator] ✓ Started at ${this.fps} FPS`);
  }

  /** Stop the animation loop */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Transition to a new animation state */
  transitionTo(state) {
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
    this.showCurrentFrame();
  }

  /** Trigger a one-shot animation (jumping, waving) */
  triggerOneShot(state) {
    if (!ONE_SHOT_STATES.has(state)) return;
    if (!this.frames[state]) return;
    // Don't interrupt an ongoing one-shot
    if (ONE_SHOT_STATES.has(this.currentState)) return;
    this.preOneShotState = this.currentState;
    this.currentState = state;
    this.currentFrameIndex = 0;
    this.showCurrentFrame();
  }

  /** Handle drag direction for running animation */
  handleDrag(dx) {
    if (dx > 0.5) {
      if (this.currentState !== "running-right" && this.currentState !== "running-left") {
        this.preDragState = this.currentState;
      }
      if (this.currentState !== "running-right") {
        this.currentState = "running-right";
        this.currentFrameIndex = 0;
      }
    } else if (dx < -0.5) {
      if (this.currentState !== "running-right" && this.currentState !== "running-left") {
        this.preDragState = this.currentState;
      }
      if (this.currentState !== "running-left") {
        this.currentState = "running-left";
        this.currentFrameIndex = 0;
      }
    } else if (dx === 0) {
      if (this.currentState === "running-right" || this.currentState === "running-left") {
        const restore =
          this.preDragState === "running-right" || this.preDragState === "running-left"
            ? "idle"
            : this.preDragState;
        this.currentState = restore;
        this.currentFrameIndex = 0;
        this.showCurrentFrame();
      }
    }
  }

  /** Pre-compute alpha masks for all loaded frames.
   *  Called once at the end of loadFrames(). Fetches each frame as a blob and
   *  loads it via an object URL so the canvas is NOT tainted (asset:// images
   *  taint the canvas and block getImageData with a SecurityError).
   *  Memory: ~57 frames × 192×208 ≈ 2.2 MB. */
  async computeAlphaMasks() {
    const canvas = document.createElement("canvas");
    canvas.width = this.baseWidth;
    canvas.height = this.baseHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    let maskCount = 0;
    let failCount = 0;
    try {
      for (const [state, frames] of Object.entries(this.frames)) {
        const paths = this.framePaths[state] || [];
        for (let i = 0; i < frames.length; i++) {
          const nativePath = paths[i];
          if (!nativePath) continue;
          // Read raw bytes via Rust (fetch() can't read asset:// in WKWebView),
          // build a blob URL that does NOT taint the canvas.
          let cleanUrl;
          try {
            const bytes = await window.__TAURI__.core.invoke("read_file_bytes", {
              path: nativePath,
            });
            // Vec<u8> arrives as a number array; normalize to Uint8Array.
            const u8 = new Uint8Array(bytes);
            const blob = new Blob([u8], { type: "image/png" });
            cleanUrl = URL.createObjectURL(blob);
          } catch {
            failCount++;
            continue;
          }

          // Load the blob into a fresh Image (untainted)
          const cleanImg = await new Promise((resolve) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => resolve(null);
            im.src = cleanUrl;
          });
          if (!cleanImg) {
            failCount++;
            URL.revokeObjectURL(cleanUrl);
            continue;
          }

          // clearRect prevents residual pixels from polluting transparent frames
          ctx.clearRect(0, 0, this.baseWidth, this.baseHeight);
          ctx.drawImage(cleanImg, 0, 0, this.baseWidth, this.baseHeight);
          URL.revokeObjectURL(cleanUrl);

          const imageData = ctx.getImageData(0, 0, this.baseWidth, this.baseHeight);
          const data = imageData.data;
          const alpha = new Uint8Array(this.baseWidth * this.baseHeight);
          for (let j = 0, k = 3; j < alpha.length; j++, k += 4) {
            alpha[j] = data[k];
          }
          this.alphaMasks.set(`${state}:${i}`, alpha);
          maskCount++;
        }
      }

      this.hitTestReady = maskCount > 0;
      console.log(
        `[Animator] ✓ Computed ${maskCount} alpha masks (${failCount} failed, hitTestReady=${this.hitTestReady})`,
      );
    } catch (e) {
      console.warn("[Animator] ⚠️ computeAlphaMasks failed, hit-test disabled:", e);
      this.hitTestReady = false;
    }
  }

  /** Look up the alpha value at a given sprite pixel coordinate.
   *  Returns 255 (opaque) as a fail-safe when the system is not ready or
   *  the mask is missing — this prevents the pet from becoming unclickable. */
  getAlphaAt(state, frameIndex, x, y) {
    if (!this.hitTestReady) return 255;
    const mask = this.alphaMasks.get(`${state}:${frameIndex}`);
    if (!mask) return 255;
    const cx = Math.max(0, Math.min(this.baseWidth - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(this.baseHeight - 1, Math.round(y)));
    return mask[cy * this.baseWidth + cx];
  }

  // --- Private ---

  tick() {
    const frames = this.frames[this.currentState];
    if (!frames || frames.length === 0) return;

    this.currentFrameIndex++;

    // One-shot: play full cycle then return to previous state
    if (ONE_SHOT_STATES.has(this.currentState) && this.currentFrameIndex >= frames.length) {
      this.currentState = this.preOneShotState;
      this.preOneShotState = "idle";
      this.currentFrameIndex = 0;
    } else {
      this.currentFrameIndex = this.currentFrameIndex % frames.length;
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
}
