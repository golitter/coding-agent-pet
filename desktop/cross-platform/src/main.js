/**
 * Main entry point — equivalent to main.swift + PetWindow.swift interaction handling
 * Wires up all components and handles mouse events.
 */

import { SpriteAnimator, SPRITE_W, SPRITE_H } from "./animator.js";
import { DialogueBubble } from "./bubble.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow, LogicalSize, LogicalPosition } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

// ---------------------------------------------------------------------------
// Layout constants (window padding; sprite dimensions imported from animator.js)
// ---------------------------------------------------------------------------
const WINDOW_PAD_W = 24;
const WINDOW_PAD_H = 60;

// ---------------------------------------------------------------------------
// Hit-test: per-pixel click-through on transparent sprite areas
// ---------------------------------------------------------------------------
const ENTER_THRESHOLD = 10; // alpha < 10 → enter pass-through
const EXIT_THRESHOLD = 20; // alpha >= 20 → exit pass-through (hysteresis)
const SOLID_CONFIRM_COUNT = 2; // consecutive solid frames before exiting
const POLL_INTERVAL_MS = 80; // polling rate while in pass-through mode (80ms ≈ 12Hz)
const NORMAL_HIT_TEST_POLL_MS = 120; // helper-only polling during recent activity windows
const NORMAL_HIT_TEST_ACTIVE_MS = 2500; // keep helper polling alive briefly after interaction
const IDLE_HIT_TEST_POLL_MS = 1000; // idle 兜底频率:失焦时仍能发现 hover,但空闲时省电

/** Bridge JS → Rust log for diagnostics. Appears in RUST_LOG output. */
function jsLog(level, tag, msg) {
  invoke("js_log", { level, tag, msg }).catch(() => {});
}
const MAX_EXIT_RETRIES = 3; // retries for setIgnoreCursorEvents(false) on failure
const EXIT_RETRY_BASE_MS = 100; // backoff base: 100ms, 200ms, 300ms
const RECOVERY_POLL_MS = 500; // recovery polling interval when normal exit fails
const DRAG_TIMEOUT_MS = 5000; // max drag duration before force-reset
const HEALTH_CHECK_MS = 3000; // periodic state consistency check
const MAX_CONSECUTIVE_POLL_ERRORS = 10; // poll error threshold to force exit
const CONTEXT_MENU_AUTO_HIDE_MS = 3000; // hide menu if untouched for 3s
const HOVER_JUMP_CYCLES = 2;

// Module-level hit-test flag — shared between setupInteractions and hideAllMenus.
// Disabled during drag / right-click menu to prevent pass-through interference.
let hitTestEnabled = true;
let contextMenuHideTimer = null;
let contextMenuLeaveTimerId = null;

async function main() {
  // 1. Fetch config from Rust backend. Fall back to safe defaults so the
  //    window stays usable even if config loading fails — better than a
  //    blank screen with no diagnostic.
  let config;
  try {
    config = await invoke("get_config");
    console.log("[Main] ✓ Config loaded", config);
  } catch (e) {
    console.error("[Main] ✗ get_config failed, using fallback:", e);
    config = {
      frames_dir: "",
      scale: 0.6,
      fps: 10,
      dialogue_font_size: 10,
      dialogue_max_width: 160,
      dialogue_corner_radius: 6,
      dialogue_fade_duration: 0.3,
      corner_margin: 20,
      style_map: {},
      menu_items: [],
    };
  }

  // 2. Create animator
  const animator = new SpriteAnimator();
  animator.setFrameTiming(config.frame_timing);
  await animator.loadFrames(config.frames_dir, config.fps);

  // 3. Get DOM elements
  const petSprite = document.getElementById("pet-sprite");
  const bubbleEl = document.getElementById("bubble");
  const contextMenu = document.getElementById("context-menu");

  // 4. Set sprite scale
  const scaledWidth = SPRITE_W * config.scale;
  const scaledHeight = SPRITE_H * config.scale;
  petSprite.style.width = `${scaledWidth}px`;
  petSprite.style.height = `${scaledHeight}px`;

  // 5. Dynamically resize and position window to match mac version
  //    Mac: windowW = scale * 192 + 24, windowH = scale * 208 + 60
  await setupWindow(config, scaledWidth, scaledHeight);

  // 6. Wire animator → image element
  animator.onFrame = (img) => {
    petSprite.src = img.src;
  };

  // 7. Create bubble
  const bubble = new DialogueBubble(bubbleEl, config);

  // 8. Start animation
  animator.start();
  jsLog("info", "Main", `Animator started — hitTestReady=${animator.hitTestReady}`);

  // 9. Show initial dialogue
  bubble.show("准备好了～", 0, "idle");

  // 10. Listen for state changes from backend
  await listen("state-change", (event) => {
    const { state, dialogue, active_count } = event.payload;
    if (state !== "idle") {
      animator.stopHoverJump({ showFrame: false });
    }
    // One-shot states (jumping on Stop, waving on SessionStart/Notification)
    // must go through triggerOneShot: it saves the prior state and restores it
    // after the animation plays once. transitionTo would skip them via its
    // same-state guard and never set preOneShotState, so Stop's jump flashed
    // for ~0.5s then vanished to a stale idle.
    if (state === "jumping" || state === "waving") {
      animator.triggerOneShot(state);
    } else {
      animator.transitionTo(state);
    }
    bubble.show(dialogue, active_count, state);
  });

  // 11. Build context menu from config
  buildContextMenu(contextMenu, config.menu_items);

  // 12. Setup mouse interaction handlers
  setupInteractions(animator, contextMenu, bubble, petSprite);

  window.addEventListener("pagehide", () => {
    jsLog("warn", "Main", "pagehide fired");
  });
  window.addEventListener("beforeunload", () => {
    jsLog("warn", "Main", "beforeunload fired");
  });

  console.log("[Main] ✓ Pet initialized");
  jsLog("info", "Main", `Pet initialized — scale=${config.scale} fps=${config.fps}`);
}

/** Set window size and position — matches mac PetWindow dimensions exactly */
async function setupWindow(config, scaledW, scaledH) {
  try {
    const appWindow = getCurrentWindow();

    const windowW = scaledW + WINDOW_PAD_W;
    const windowH = scaledH + WINDOW_PAD_H;

    // Resize window
    await appWindow.setSize(new LogicalSize(windowW, windowH));

    // Position at bottom-right — use Tauri monitor API for multi-display support.
    // Falls back to window.screen (primary display only) if unavailable.
    const margin = config.corner_margin || 20;
    let screenWidth, screenHeight;
    try {
      const monitor = await window.__TAURI__.window.primaryMonitor();
      if (monitor) {
        screenWidth = monitor.size.width / monitor.scaleFactor;
        screenHeight = monitor.size.height / monitor.scaleFactor;
      }
    } catch {
      /* primaryMonitor not available — fallback below */
    }
    screenWidth ??= window.screen.width;
    screenHeight ??= window.screen.height;

    const x = screenWidth - windowW - margin;
    const y = screenHeight - windowH - margin;

    await appWindow.setPosition(new LogicalPosition(x, y));
  } catch (e) {
    console.warn("[Main] ⚠️ Could not setup window:", e);
  }
}

/** Build the right-click context menu */
function buildContextMenu(menuEl, items) {
  menuEl.innerHTML = "";
  if (!items || items.length === 0) {
    // Fallback menu
    menuEl.appendChild(
      createMenuItem(
        "关闭宠物",
        () => {
          invoke("quit_app").catch((e) => console.error("[Menu] quit_app failed:", e));
        },
        { shortcut: getQuitShortcut(), variant: "quit" },
      ),
    );
    return;
  }

  for (const item of items) {
    if (item.action === "separator") {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      menuEl.appendChild(sep);
    } else if (item.action === "quit") {
      menuEl.appendChild(
        createMenuItem(
          item.title,
          () => {
            invoke("quit_app").catch((e) => console.error("[Menu] quit_app failed:", e));
          },
          { shortcut: getQuitShortcut(), variant: "quit" },
        ),
      );
    } else if (item.action === "applescript" && item.script) {
      menuEl.appendChild(
        createMenuItem(
          item.title,
          () => {
            invoke("run_applescript", { script: item.script }).catch((e) =>
              console.error("[Menu] run_applescript failed:", e),
            );
          },
          { variant: "app" },
        ),
      );
    }
  }
}

function createMenuItem(title, onClick, options = {}) {
  const { shortcut = "", icon = "", variant = "app" } = options;
  const el = document.createElement("div");
  el.className = "context-menu-item";
  el.dataset.variant = variant;

  if (icon) {
    const iconEl = document.createElement("span");
    iconEl.className = "context-menu-icon";
    iconEl.textContent = icon;
    el.appendChild(iconEl);
  }

  const label = document.createElement("span");
  label.className = "context-menu-label";
  label.textContent = title;
  el.appendChild(label);

  if (shortcut) {
    const shortcutEl = document.createElement("span");
    shortcutEl.className = "context-menu-shortcut";
    shortcutEl.textContent = shortcut;
    el.appendChild(shortcutEl);
  }

  el.addEventListener("click", (e) => {
    e.stopPropagation();
    hideAllMenus();
    onClick();
  });
  return el;
}

function hideAllMenus() {
  const menus = document.querySelectorAll(".context-menu");
  menus.forEach((m) => m.classList.add("hidden"));
  if (contextMenuHideTimer !== null) {
    clearTimeout(contextMenuHideTimer);
    contextMenuHideTimer = null;
  }
  stopContextMenuLeavePoll();
  // Re-enable hit-test when menu closes. Menu items use click (not mouseup),
  // so this can't rely on the mouseup handler alone. The guard in enterPassThrough
  // prevents re-entering pass-through before the current click completes.
  hitTestEnabled = true;
}

function scheduleContextMenuAutoHide() {
  if (contextMenuHideTimer !== null) {
    clearTimeout(contextMenuHideTimer);
  }
  contextMenuHideTimer = setTimeout(() => {
    hideAllMenus();
  }, CONTEXT_MENU_AUTO_HIDE_MS);
  startContextMenuLeavePoll();
}

/**
 * Poll cursor position via the Rust `cursor_in_window` command while the menu
 * is open, and hide it the instant the cursor leaves the window bounds.
 *
 * Why a poll instead of a DOM `mouseleave`: this is a transparent window
 * whose `setIgnoreCursorEvents` toggles per-pixel for click pass-through.
 * WKWebView does not deliver a reliable `mouseleave` when the cursor exits a
 * borderless transparent Tauri window (or when ignore-cursor-events flips).
 * `cursor_in_window` reads the live hardware position via CGEvent regardless,
 * so it is the only dependable "did the mouse leave?" signal — the same one
 * pollCursor() relies on for pass-through exit.
 */
function contextMenuIsVisible() {
  return Array.from(document.querySelectorAll(".context-menu")).some(
    (m) => !m.classList.contains("hidden"),
  );
}

function startContextMenuLeavePoll() {
  stopContextMenuLeavePoll();
  const tick = async () => {
    // Menu may have been closed externally (click / Escape / item) while this
    // tick was awaiting the IPC — bail before rescheduling to avoid polling
    // a hidden menu forever.
    if (!contextMenuIsVisible()) return;
    try {
      const [winX, winY] = await invoke("cursor_in_window");
      if (winX < 0 || winY < 0 || winX >= window.innerWidth || winY >= window.innerHeight) {
        // Cursor left the window → hide immediately.
        hideAllMenus();
        return;
      }
    } catch (e) {
      // cursor_in_window is macOS-only; on other platforms or on IPC error,
      // stop polling and let the CONTEXT_MENU_AUTO_HIDE_MS timer handle it.
      console.warn("[ContextMenu] leave-poll stopping, falling back to auto-hide:", e);
      return;
    }
    contextMenuLeaveTimerId = setTimeout(tick, POLL_INTERVAL_MS);
  };
  contextMenuLeaveTimerId = setTimeout(tick, POLL_INTERVAL_MS);
}

function stopContextMenuLeavePoll() {
  if (contextMenuLeaveTimerId !== null) {
    clearTimeout(contextMenuLeaveTimerId);
    contextMenuLeaveTimerId = null;
  }
}

function isMacPlatform() {
  if (navigator.userAgentData) {
    return navigator.userAgentData.platform === "macOS";
  }
  return /mac/i.test(navigator.userAgent);
}

function getQuitShortcut() {
  return isMacPlatform() ? "⌘ Q" : "Ctrl Q";
}

/**
 * Triple-click handler — wipe every session file on disk and bubble up
 * feedback. No staleness threshold: this is the user's "give me a clean
 * slate" escape hatch, so it clears regardless of mtime. Both branches
 * auto-fade via DialogueBubble's AUTO_HIDE_MS (forceAutoHide=true), so the
 * failed bubble fades even though "failed" is normally a persistent state.
 */
async function triggerRedundantCleanup(bubble) {
  try {
    const count = await invoke("purge_all_sessions");
    const text = count > 0 ? `清理了 ${count} 个会话～` : "没有可清理的会话～";
    bubble.show(text, 0, "waving");
  } catch (e) {
    console.error("[TripleClick] purge_all_sessions failed:", e);
    // forceAutoHide: "failed" is normally a persistent state, but this is
    // one-shot user feedback and should fade out like the success branch.
    bubble.show("清理失败…", 0, "failed", true);
  }
}

/** Setup click, drag, right-click handlers, and per-pixel hit-test */
function setupInteractions(animator, contextMenu, bubble, petSprite) {
  const appWindow = getCurrentWindow();
  let dragStart = null;
  let isDragging = false;
  let lastDragScreenX = null; // last consumed cursor X for incremental drag-delta
  let dragMomX = 0; // low-pass-filtered horizontal velocity for stable direction
  const DRAG_THRESHOLD = 3;
  // Per-frame dx is jittery during the OS drag loop (sub-pixel noise, uneven
  // mousemove delivery), so feeding its raw sign flickered the run animation
  // left↔right and reset it on every flip (looked like stutter). dragMomX
  // low-pass-filters dx: a committed direction needs sustained movement, a
  // brief reversal can't overcome the accumulated momentum.
  const DRAG_MOMENTUM_DECAY = 0.6; // fraction of previous momentum retained
  const DRAG_DIR_THRESHOLD = 1.0; // |momentum| needed to commit a direction

  // --- Sprite rect cache (avoids layout thrashing on every mousemove) ---
  let cachedRect = null;
  const invalidateRect = () => {
    cachedRect = null;
  };
  window.addEventListener("resize", invalidateRect);

  // --- Pass-through (hit-test) state ---
  let isPassThrough = false;
  let applyingPassThrough = false; // async guard against rapid toggling
  let pendingExit = false; // deferred exit flag for race conditions
  let pollTimerId = null;
  let recoveryPollTimerId = null; // recovery polling when normal exit fails
  let normalPollTimerId = null; // single interactive hit-test poll timer
  let normalPollingActive = false; // false after stop(); gates self-sustaining reschedule
  let passThroughPollInFlight = false;
  let lastPassThroughPollAt = 0;
  let normalPollingUntil = 0;
  let solidHitCount = 0;
  let consecutivePollErrors = 0; // tracks consecutive IPC errors in pollCursor
  let dragTimerId = null; // drag safety timeout
  let isHoveringPetBody = false;

  function resetDragState({ restoreAnimation = true, reenableHitTest = true } = {}) {
    clearTimeout(dragTimerId);
    if (restoreAnimation && isDragging) {
      animator.handleDrag(0);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }
    dragStart = null;
    isDragging = false;
    lastDragScreenX = null;
    dragMomX = 0;
    if (reenableHitTest) {
      hitTestEnabled = true;
    }
  }

  function finishPassThroughExit({ logMessage = "EXIT pass-through", debugTag = "info" } = {}) {
    isPassThrough = false;
    solidHitCount = 0;
    consecutivePollErrors = 0;
    lastExitTime = performance.now();
    armNormalHitTestPolling();
    jsLog(debugTag, "HitTest", logMessage);
  }

  function beginExclusivePointerInteraction() {
    hitTestEnabled = false;
    animator.stopHoverJump();
    disarmNormalHitTestPolling();
    if (isPassThrough) {
      exitPassThrough(); // async, fire-and-forget
    }
  }

  function canTriggerHoverJump() {
    return (
      hitTestEnabled &&
      !dragStart &&
      !isDragging &&
      !contextMenuIsVisible() &&
      animator.currentState === "idle"
    );
  }

  function enterPetBodyHover() {
    if (isHoveringPetBody) return;
    isHoveringPetBody = true;
    if (canTriggerHoverJump()) {
      animator.triggerHoverJump(HOVER_JUMP_CYCLES);
    }
  }

  function leavePetBodyHover() {
    if (!isHoveringPetBody && !animator.isHoverJumping()) return;
    isHoveringPetBody = false;
    animator.stopHoverJump();
  }

  function updatePetBodyHover(alpha) {
    if (alpha >= EXIT_THRESHOLD) {
      enterPetBodyHover();
    } else if (alpha < ENTER_THRESHOLD) {
      leavePetBodyHover();
    }
  }

  function getInteractionAlphaAtCss(cssX, cssY) {
    return Math.max(checkAlphaAtCss(cssX, cssY), checkHoverBodyAlphaAtCss(cssX, cssY));
  }

  function tryEnterPassThroughAt(
    clientX,
    clientY,
    {
      event = null,
      resetDrag = false,
      resetClickCounter = false,
      logMessage = "",
      alpha = null,
    } = {},
  ) {
    if (isPassThrough || !hitTestEnabled) return false;
    const hitAlpha = alpha ?? checkAlphaAtCss(clientX, clientY);
    if (hitAlpha >= ENTER_THRESHOLD) return false;

    leavePetBodyHover();

    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (resetDrag) {
      dragStart = null;
      isDragging = false;
    }
    if (resetClickCounter) {
      clickCount = 0;
    }

    enterPassThrough(); // async, non-blocking
    if (logMessage) {
      jsLog("info", "HitTest", `${logMessage} alpha=${hitAlpha}`);
    }
    return true;
  }

  function showContextMenuAtPetBottomLeft() {
    contextMenu.classList.remove("hidden");
    const MENU_MARGIN = 4;
    contextMenu.style.left = `${MENU_MARGIN}px`;
    contextMenu.style.top = `${MENU_MARGIN}px`;

    // Anchor the menu to the rendered pet body, not the click position. This
    // keeps the menu spatially tied to Kotori even when users right-click
    // different opaque pixels in the sprite.
    const spriteRect = petSprite.getBoundingClientRect();
    const menuRect = contextMenu.getBoundingClientRect();
    const clampedLeft = Math.max(
      MENU_MARGIN,
      Math.min(spriteRect.left, window.innerWidth - menuRect.width - MENU_MARGIN),
    );
    const clampedTop = Math.max(
      MENU_MARGIN,
      Math.min(
        spriteRect.bottom - menuRect.height,
        window.innerHeight - menuRect.height - MENU_MARGIN,
      ),
    );
    contextMenu.style.left = `${clampedLeft}px`;
    contextMenu.style.top = `${clampedTop}px`;
    scheduleContextMenuAutoHide();
  }

  // --- Coordinate helpers ---

  /** Check alpha at CSS-relative coords.
   *  Uses cached rect to avoid layout thrashing; invalidated on resize.
   *  Coordinates outside the rendered sprite are transparent window padding,
   *  not edge pixels of the sprite.
   */
  function checkAlphaAtCss(cssX, cssY) {
    return checkAlphaAtCssForState(cssX, cssY, animator.currentState, animator.currentFrameIndex);
  }

  function checkHoverBodyAlphaAtCss(cssX, cssY) {
    return checkAlphaAtCssForState(cssX, cssY, "idle", 0);
  }

  function checkAlphaAtCssForState(cssX, cssY, state, frameIndex) {
    const rect = cachedRect ?? (cachedRect = petSprite.getBoundingClientRect());
    const spriteX = (cssX - rect.left) * (SPRITE_W / rect.width);
    const spriteY = (cssY - rect.top) * (SPRITE_H / rect.height);
    if (spriteX < 0 || spriteY < 0 || spriteX >= SPRITE_W || spriteY >= SPRITE_H) {
      return 0;
    }
    return animator.getAlphaAt(state, frameIndex, spriteX, spriteY);
  }

  function isPointInsideWindow(winX, winY) {
    return winX >= 0 && winY >= 0 && winX < window.innerWidth && winY < window.innerHeight;
  }

  // Union of the former hover-poll and normal-poll guards so the single merged
  // loop runs at least as often as either did. !isPassThrough is intentionally
  // dropped: the worker branches on isPassThrough to run the exit path while in
  // pass-through (formerly the hover-poll's job) and the enter path otherwise.
  function shouldRunNormalHitTestPolling() {
    return (
      hitTestEnabled &&
      !dragStart &&
      !applyingPassThrough &&
      !contextMenuIsVisible() &&
      (performance.now() < normalPollingUntil ||
        animator.currentState === "idle" ||
        animator.isHoverJumping() ||
        isHoveringPetBody)
    );
  }

  /** Whether the current state needs the original fast (8.3Hz) polling rate.
   *  Active states — recent interaction, hover jumping, cursor on the pet body,
   *  pass-through — keep the fast cadence; only the pure idle steady state drops
   *  to IDLE_HIT_TEST_POLL_MS. This is what stops the pet from polling
   *  cursor_in_window at 8.3Hz forever when nothing is happening. */
  function needsHighFreqHitTestPolling() {
    return (
      performance.now() < normalPollingUntil ||
      animator.isHoverJumping() ||
      isHoveringPetBody ||
      isPassThrough
    );
  }

  function nextHitTestIntervalMs() {
    return needsHighFreqHitTestPolling() ? NORMAL_HIT_TEST_POLL_MS : IDLE_HIT_TEST_POLL_MS;
  }

  function stopNormalHitTestPolling() {
    normalPollingActive = false;
    if (normalPollTimerId !== null) {
      clearTimeout(normalPollTimerId);
      normalPollTimerId = null;
    }
  }

  function armNormalHitTestPolling(durationMs = NORMAL_HIT_TEST_ACTIVE_MS) {
    if (!animator.hitTestReady) return;
    normalPollingUntil = Math.max(normalPollingUntil, performance.now() + durationMs);
    if (shouldRunNormalHitTestPolling()) {
      startNormalHitTestPolling();
    }
  }

  function disarmNormalHitTestPolling() {
    normalPollingUntil = 0;
    stopNormalHitTestPolling();
  }

  // --- Pass-through control ---
  let lastExitTime = 0; // re-entry cooldown timestamp
  const REENTRY_COOLDOWN_MS = 200;

  async function enterPassThrough() {
    if (isPassThrough || applyingPassThrough || !hitTestEnabled) return;
    // Re-entry cooldown: prevent rapid enter/exit flicker at sprite edges
    if (performance.now() - lastExitTime < REENTRY_COOLDOWN_MS) return;
    applyingPassThrough = true;
    try {
      await appWindow.setIgnoreCursorEvents(true);
      // If exit was requested while we were awaiting, undo the enter immediately
      if (pendingExit) {
        pendingExit = false;
        try {
          await appWindow.setIgnoreCursorEvents(false);
        } catch {}
        jsLog("warn", "HitTest", "enter cancelled — pendingExit was set");
        return; // stay in normal mode
      }
      isPassThrough = true;
      solidHitCount = 0;
      consecutivePollErrors = 0;
      lastPassThroughPollAt = performance.now();
      // Note: do NOT disarm the interactive poll here. The merged loop branches
      // on isPassThrough, so its enter path is skipped automatically while the
      // exit path (cursor returning to the pet body) keeps working — matching
      // the former hover-poll, which stayed alive during pass-through.
      startPolling();
      jsLog("info", "HitTest", "ENTER pass-through");
    } finally {
      applyingPassThrough = false;
    }
  }

  async function exitPassThrough() {
    if (!isPassThrough) return;
    // If another enter/exit is in progress, defer instead of silently dropping.
    if (applyingPassThrough) {
      pendingExit = true;
      return;
    }
    applyingPassThrough = true;
    try {
      stopPolling();
      // Retry with backoff: the IPC call can fail transiently.
      for (let attempt = 0; attempt < MAX_EXIT_RETRIES; attempt++) {
        try {
          await appWindow.setIgnoreCursorEvents(false);
          finishPassThroughExit();
          return; // success
        } catch (e) {
          console.warn(`[HitTest] exitPassThrough attempt ${attempt + 1} failed:`, e);
          if (attempt < MAX_EXIT_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, EXIT_RETRY_BASE_MS * (attempt + 1)));
          }
        }
      }
      // All retries failed — start recovery polling as last resort
      console.error("[HitTest] exitPassThrough failed after retries, starting recovery polling");
      jsLog("error", "HitTest", "exit FAILED after retries — recovery polling started");
      startRecoveryPolling();
    } finally {
      applyingPassThrough = false;
      // Process deferred exit if it was requested while we were running
      if (pendingExit && isPassThrough) {
        pendingExit = false;
        exitPassThrough();
      }
    }
  }

  /** Start polling via chained setTimeout — prevents overlapping async calls
   *  that could occur with setInterval if the IPC call takes >80ms. */
  function startPolling() {
    if (pollTimerId !== null) return;
    stopRecoveryPolling(); // clean up any lingering recovery timer
    const tick = async () => {
      // Clear ID first — we're executing right now, so no pending timeout exists.
      // This prevents a stale pollTimerId from blocking the next startPolling() call
      // after an exitPassThrough() sets isPassThrough=false mid-chain.
      pollTimerId = null;
      if (!isPassThrough) return; // stopped while waiting
      passThroughPollInFlight = true;
      try {
        await pollCursor();
      } finally {
        passThroughPollInFlight = false;
        lastPassThroughPollAt = performance.now();
        if (isPassThrough) {
          pollTimerId = setTimeout(tick, POLL_INTERVAL_MS);
        }
      }
    };
    pollTimerId = setTimeout(tick, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimerId !== null) {
      clearTimeout(pollTimerId);
      pollTimerId = null;
    }
    passThroughPollInFlight = false;
  }

  /** Recovery polling — last-resort safety net. Runs when normal exitPassThrough
   *  fails after all retries. Periodically forces setIgnoreCursorEvents(false)
   *  until it succeeds. Slower interval than normal polling to avoid overhead. */
  function startRecoveryPolling() {
    if (recoveryPollTimerId !== null) return;
    const tick = async () => {
      if (!isPassThrough) {
        recoveryPollTimerId = null;
        return;
      }
      try {
        await appWindow.setIgnoreCursorEvents(false);
        finishPassThroughExit({ logMessage: "Recovery exit succeeded" });
        console.log("[HitTest] Recovery exit succeeded");
        recoveryPollTimerId = null;
        return;
      } catch (e) {
        console.warn("[HitTest] Recovery exit failed:", e);
      }
      recoveryPollTimerId = setTimeout(tick, RECOVERY_POLL_MS);
    };
    recoveryPollTimerId = setTimeout(tick, RECOVERY_POLL_MS);
  }

  function stopRecoveryPolling() {
    if (recoveryPollTimerId !== null) {
      clearTimeout(recoveryPollTimerId);
      recoveryPollTimerId = null;
    }
  }

  /** Poll cursor position via the Rust CGEvent command while in pass-through
   *  mode. Restores normal mode when the cursor moves onto an opaque pixel or
   *  leaves the window.
   *
   *  Why a custom Rust command: tao's `cursorPosition()` IPC hangs while
   *  `setIgnoreCursorEvents(true)` is active, and NSEvent.mouseLocation goes
   *  stale (the window stops processing events). CGEvent polls the live
   *  hardware position regardless. `cursor_in_window` returns the position
   *  relative to the window content in logical pixels, Y from top. */
  async function pollCursor() {
    try {
      const [winX, winY] = await invoke("cursor_in_window");

      // Cursor outside the transparent window → restore so the pet can catch
      // the next entry. Transparent padding inside the window remains
      // pass-through.
      if (!isPointInsideWindow(winX, winY)) {
        leavePetBodyHover();
        exitPassThrough();
        return;
      }

      const alpha = getInteractionAlphaAtCss(winX, winY);

      // Hysteresis: require EXIT_THRESHOLD + consecutive solid frames
      if (alpha >= EXIT_THRESHOLD) {
        solidHitCount++;
        if (solidHitCount >= SOLID_CONFIRM_COUNT) {
          enterPetBodyHover();
          exitPassThrough();
        }
      } else {
        solidHitCount = 0;
      }
    } catch (e) {
      consecutivePollErrors++;
      console.warn("[HitTest] Poll error:", e);
      if (consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        console.error("[HitTest] Too many consecutive poll errors, forcing exit");
        exitPassThrough();
      }
    }
  }

  /** Interactive hit-test polling — keeps hover responsive even when the
   *  transparent desktop window is unfocused and WKWebView does not deliver
   *  mousemove, and recovers from pass-through when the cursor returns to the
   *  pet body. Replaces the former separate hover-poll + normal-poll loops,
   *  which duplicated the cursor_in_window IPC on every tick. */
  async function pollNormalHitTest() {
    if (!shouldRunNormalHitTestPolling()) return;
    try {
      const [winX, winY] = await invoke("cursor_in_window");
      if (!isPointInsideWindow(winX, winY)) {
        leavePetBodyHover();
        return;
      }

      const bodyAlpha = checkHoverBodyAlphaAtCss(winX, winY);
      updatePetBodyHover(bodyAlpha);
      if (isPassThrough) {
        // Cursor landed back on the pet body while pass-through was active —
        // hand interaction back to the window (formerly the hover-poll's job).
        if (bodyAlpha >= EXIT_THRESHOLD) {
          exitPassThrough();
        }
      } else if (bodyAlpha < ENTER_THRESHOLD) {
        // Cursor over a transparent area in normal mode — hand it to the OS.
        // (updatePetBodyHover above already called leavePetBodyHover.)
        const alpha = checkAlphaAtCss(winX, winY);
        tryEnterPassThroughAt(winX, winY, { alpha });
      }
    } catch {
      // Best-effort helper only. Mousemove and mousedown guards still protect
      // interactions if the polling IPC is temporarily unavailable.
    }
  }

  function startNormalHitTestPolling() {
    if (normalPollTimerId !== null) return;
    normalPollingActive = true;
    const tick = async () => {
      normalPollTimerId = null;
      if (!normalPollingActive) return;
      // Gate the IPC by the guard; keep ticking otherwise so polling resumes
      // when the guard flips back (e.g. agent stops → pet returns to idle) even
      // without a mouse event to arm it — the property the former always-on
      // hover-poll gave us. An inactive tick is just a cheap setTimeout.
      if (shouldRunNormalHitTestPolling()) {
        await pollNormalHitTest();
      }
      if (normalPollingActive) {
        normalPollTimerId = setTimeout(tick, nextHitTestIntervalMs());
      }
    };
    normalPollTimerId = setTimeout(tick, nextHitTestIntervalMs());
  }

  armNormalHitTestPolling();
  startNormalHitTestPolling();
  pollNormalHitTest();

  // Triple-click detection: 3 left-clicks within TRIPLE_CLICK_WINDOW_MS
  // triggers a full purge of the sessions directory (see `purge_all` in
  // aggregator.rs). Single/double clicks are intentionally inert; hover is
  // now the only local jump trigger. Window kept tight (800ms) on purpose:
  // a purge wipes ALL live sessions, so the cost of a stray trigger is high.
  // A deliberate triple-tap still lands comfortably inside 800ms; the
  // previous 3s window fired on ordinary interaction within 3s.
  let clickCount = 0;
  let lastClickTime = 0;
  const TRIPLE_CLICK_WINDOW_MS = 800;

  // Left click: mousedown → mouseup without drag = click counter only
  // Drag: mousedown → mousemove with threshold → drag window + directional anim
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // left button only
    jsLog("info", "Mouse", `down isPassThrough=${isPassThrough} hitTest=${hitTestEnabled}`);
    armNormalHitTestPolling();

    // A click can begin without any prior mousemove, especially when the pet
    // window was unfocused. Guard mousedown itself so the first click on a
    // transparent pixel cannot start a drag sequence or trigger the jump on
    // mouseup.
    if (
      tryEnterPassThroughAt(e.clientX, e.clientY, {
        event: e,
        resetDrag: true,
        resetClickCounter: true,
        logMessage: "transparent mousedown ignored",
        alpha: getInteractionAlphaAtCss(e.clientX, e.clientY),
      })
    ) {
      return;
    }

    // Disable hit-test during drag to prevent pass-through interference
    beginExclusivePointerInteraction();
    dragStart = { x: e.screenX, y: e.screenY };
    isDragging = false;
    // Safety timeout: if drag state persists beyond DRAG_TIMEOUT_MS (e.g.
    // mouseup lost after OS-level startDragging), force-reset it.
    clearTimeout(dragTimerId);
    dragTimerId = setTimeout(() => {
      if (isDragging || dragStart) {
        console.warn("[Drag] Timeout — force-resetting stuck drag state");
        jsLog("warn", "Drag", "Timeout — force-resetting stuck drag state");
        resetDragState();
      }
    }, DRAG_TIMEOUT_MS);
  });

  // mousemove can fire at 120Hz on ProMotion / high-precision trackpads.
  //
  // startDragging() MUST run synchronously inside the mousemove handler: it
  // hands control to the OS's native window-drag loop, which only honors the
  // call within the trusted user-gesture event. The previous code called it
  // from a requestAnimationFrame callback (one frame later, outside the event
  // stack), so the OS ignored it and the pet wouldn't move. The rAF loop below
  // now only throttles the directional *animation*, not the drag itself.
  let pendingMove = null;
  document.addEventListener("mousemove", (e) => {
    const bodyAlpha = checkHoverBodyAlphaAtCss(e.clientX, e.clientY);
    updatePetBodyHover(bodyAlpha);
    const alpha = bodyAlpha >= ENTER_THRESHOLD ? getInteractionAlphaAtCss(e.clientX, e.clientY) : 0;

    // --- Hit-test: check alpha on every move (normal mode only) ---
    if (!dragStart && tryEnterPassThroughAt(e.clientX, e.clientY, { alpha })) {
      return;
    }

    if (!dragStart || e.button !== 0) return;

    if (!isDragging) {
      const dx = e.screenX - dragStart.x;
      const dy = e.screenY - dragStart.y;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        isDragging = true;
        lastDragScreenX = e.screenX; // seed incremental tracking at drag start
        dragMomX = 0;
        jsLog("info", "Drag", "startDragging called");
        appWindow.startDragging().catch((error) => {
          console.warn("[Drag] startDragging failed:", error);
          jsLog("error", "Drag", "startDragging failed");
          resetDragState();
          armNormalHitTestPolling();
        });
        // Start on-demand rAF loop for direction animation
        rafId = requestAnimationFrame(processMove);
      }
    }
    pendingMove = e;
  });

  // On-demand rAF loop — only runs while dragging, not permanently.
  let rafId = null;
  const processMove = () => {
    if (pendingMove && isDragging) {
      const e = pendingMove;
      pendingMove = null;
      // Incremental delta since the last consumed frame (NOT cumulative from
      // dragStart) — so reversing the mouse flips the run direction instead
      // of waiting for the cumulative displacement to cross zero.
      if (lastDragScreenX === null) lastDragScreenX = e.screenX;
      const dx = e.screenX - lastDragScreenX;
      lastDragScreenX = e.screenX;
      // Smooth dx into a velocity (dragMomX) and only commit a direction once
      // it exceeds threshold. Raw dx flickers sign during a drag, which made
      // the animation flip and stutter; momentum filters that out while still
      // switching within ~1 frame on a real, sustained reversal. Below
      // threshold we don't call handleDrag, so the pet holds its last
      // direction instead of resetting every frame.
      dragMomX = dragMomX * DRAG_MOMENTUM_DECAY + dx;
      if (dragMomX > DRAG_DIR_THRESHOLD || dragMomX < -DRAG_DIR_THRESHOLD) {
        animator.handleDrag(dragMomX);
      }
    }
    if (isDragging) {
      rafId = requestAnimationFrame(processMove);
    } else {
      rafId = null;
    }
  };

  document.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    clearTimeout(dragTimerId);
    jsLog("info", "Mouse", `up isDragging=${isDragging} dragStart=${!!dragStart}`);

    if (isDragging) {
      animator.handleDrag(0); // signal: drag ended
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    } else if (dragStart) {
      // Click counter — increments while within the triple-click window.
      const now = performance.now();
      if (now - lastClickTime < TRIPLE_CLICK_WINDOW_MS) {
        clickCount++;
      } else {
        clickCount = 1;
      }
      lastClickTime = now;

      if (clickCount >= 3) {
        // Triple-click → purge all sessions. Reset counter so a 4th tap
        // doesn't chain into another purge.
        clickCount = 0;
        triggerRedundantCleanup(bubble);
      }
    }

    resetDragState({ restoreAnimation: false }); // animation already restored above if needed
    armNormalHitTestPolling();
  });

  // Right-click → context menu
  document.addEventListener("contextmenu", (e) => {
    armNormalHitTestPolling();
    if (
      tryEnterPassThroughAt(e.clientX, e.clientY, {
        event: e,
        logMessage: "transparent contextmenu ignored",
        alpha: getInteractionAlphaAtCss(e.clientX, e.clientY),
      })
    ) {
      return;
    }

    e.preventDefault();
    // Disable hit-test while menu is visible
    beginExclusivePointerInteraction();
    showContextMenuAtPetBottomLeft();
  });

  // Click anywhere else to close menu
  document.addEventListener("click", () => {
    hideAllMenus();
    armNormalHitTestPolling();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideAllMenus();
      return;
    }

    const quitModifierPressed = isMacPlatform() ? e.metaKey : e.ctrlKey;
    if (quitModifierPressed && e.key.toLowerCase() === "q") {
      e.preventDefault();
      hideAllMenus();
      invoke("quit_app").catch((e) => console.error("[Keyboard] quit_app failed:", e));
    }
  });

  // --- Fix 4b: window focus recovery for stuck drag state ---
  // After OS-level startDragging(), mouseup may not reach JS. Window refocus
  // (which happens after native drag completes) is a reliable signal to reset.
  // IMPORTANT: Only check isDragging (not dragStart). On macOS, clicking an
  // unfocused window fires: mousedown → focus (3ms later) → mouseup. If we
  // checked dragStart too, every first click on an unfocused window would be
  // swallowed — dragStart is set on every mousedown, not just actual drags.
  window.addEventListener("focus", () => {
    animator.setFocused(true);
    if (isDragging) {
      console.log("[Drag] Reset stuck drag state on window focus");
      jsLog("warn", "Drag", "Reset stuck drag state on window focus");
      resetDragState();
    }
    armNormalHitTestPolling();
  });

  window.addEventListener("blur", () => {
    animator.setFocused(false);
    leavePetBodyHover();
    armNormalHitTestPolling();
  });

  document.addEventListener("mouseleave", () => {
    leavePetBodyHover();
  });

  // --- Fix 5: Global health check (catch-all safety net) ---
  // Periodically verify state consistency and force-recover from any stuck state.
  setInterval(() => {
    // Pass-through stuck: isPassThrough=true but no polling running
    if (isPassThrough && !applyingPassThrough) {
      const pollRecentlyActive = performance.now() - lastPassThroughPollAt < POLL_INTERVAL_MS * 4;
      if (
        pollTimerId === null &&
        recoveryPollTimerId === null &&
        !passThroughPollInFlight &&
        !pollRecentlyActive
      ) {
        console.warn("[HealthCheck] Pass-through with no active polling — forcing exit");
        jsLog("warn", "HealthCheck", "pass-through stuck with no polling — forcing exit");
        exitPassThrough();
      }
    }
    // Inconsistent drag state (should never happen, but catch it)
    if ((isDragging || dragStart) && hitTestEnabled) {
      // hitTestEnabled should be false during any drag/click sequence
      // If it's true while dragStart is set, the mouseup was lost
      console.warn("[HealthCheck] Inconsistent drag/hitTest state — resetting drag");
      resetDragState({ reenableHitTest: true });
    }
  }, HEALTH_CHECK_MS);
}

// Start
main().catch((e) => console.error("[Main] Fatal:", e));
