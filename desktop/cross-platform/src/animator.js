/**
 * Sprite animation engine — equivalent to FrameCache.swift + SpriteAnimator.swift
 * Loads PNG frames, drives animation loop, handles state transitions.
 */

const STATES = [
  'idle', 'running-right', 'running-left', 'waving',
  'jumping', 'failed', 'waiting', 'running', 'review'
];

const ONE_SHOT_STATES = new Set(['jumping', 'waving']);

export class SpriteAnimator {
  constructor() {
    this.frames = {};           // { stateName: [Image, ...] }
    this.currentState = 'idle';
    this.currentFrameIndex = 0;
    this.preDragState = 'idle';
    this.preOneShotState = 'idle';
    this.timer = null;
    this.fps = 10;
    this.onFrame = null;       // callback(imageElement)
  }

  /** Pre-load all sprite frames from disk via Tauri asset protocol */
  async loadFrames(framesDir, fps) {
    this.fps = fps || 10;
    const { convertFileSrc } = window.__TAURI__.core;

    for (const state of STATES) {
      const frames = [];
      let i = 0;
      while (true) {
        const padded = String(i).padStart(2, '0');
        const filePath = `${framesDir}/${state}/${padded}.png`;
        const url = convertFileSrc(filePath);
        const img = new Image();
        img.src = url;

        const loaded = await new Promise((resolve) => {
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
        });

        if (!loaded) break;
        frames.push(img);
        i++;
      }
      this.frames[state] = frames;
    }

    const total = Object.values(this.frames).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`[Animator] ✓ Loaded ${total} frames across ${Object.keys(this.frames).length} states`);
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
      if (this.currentState !== 'running-right' && this.currentState !== 'running-left') {
        this.preDragState = this.currentState;
      }
      if (this.currentState !== 'running-right') {
        this.currentState = 'running-right';
        this.currentFrameIndex = 0;
      }
    } else if (dx < -0.5) {
      if (this.currentState !== 'running-right' && this.currentState !== 'running-left') {
        this.preDragState = this.currentState;
      }
      if (this.currentState !== 'running-left') {
        this.currentState = 'running-left';
        this.currentFrameIndex = 0;
      }
    } else if (dx === 0) {
      if (this.currentState === 'running-right' || this.currentState === 'running-left') {
        const restore = (this.preDragState === 'running-right' || this.preDragState === 'running-left')
          ? 'idle' : this.preDragState;
        this.currentState = restore;
        this.currentFrameIndex = 0;
        this.showCurrentFrame();
      }
    }
  }

  // --- Private ---

  tick() {
    const frames = this.frames[this.currentState];
    if (!frames || frames.length === 0) return;

    this.currentFrameIndex++;

    // One-shot: play full cycle then return to previous state
    if (ONE_SHOT_STATES.has(this.currentState) && this.currentFrameIndex >= frames.length) {
      this.currentState = this.preOneShotState;
      this.preOneShotState = 'idle';
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
