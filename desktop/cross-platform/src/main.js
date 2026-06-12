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
const NORMAL_HIT_TEST_POLL_MS = 80; // catches "first click" with no prior mousemove

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

// Module-level hit-test flag — shared between setupInteractions and hideAllMenus.
// Disabled during drag / right-click menu to prevent pass-through interference.
let hitTestEnabled = true;

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
          getMenuPresentation(item.title, item.action),
        ),
      );
    }
  }
}

function getMenuPresentation(title, action) {
  if (action === "quit") {
    return { variant: "quit", shortcut: getQuitShortcut() };
  }
  return { variant: "app" };
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
  // Re-enable hit-test when menu closes. Menu items use click (not mouseup),
  // so this can't rely on the mouseup handler alone. The guard in enterPassThrough
  // prevents re-entering pass-through before the current click completes.
  hitTestEnabled = true;
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
  const DRAG_THRESHOLD = 3;

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
  let normalPollTimerId = null; // normal-mode helper polling (non-overlapping)
  let solidHitCount = 0;
  let consecutivePollErrors = 0; // tracks consecutive IPC errors in pollCursor
  let dragTimerId = null; // drag safety timeout

  // --- Coordinate helpers ---

  /** Check alpha at CSS-relative coords.
   *  Uses cached rect to avoid layout thrashing; invalidated on resize.
   *  Coordinates outside the rendered sprite are transparent window padding,
   *  not edge pixels of the sprite.
   */
  function checkAlphaAtCss(cssX, cssY) {
    const rect = cachedRect ?? (cachedRect = petSprite.getBoundingClientRect());
    const spriteX = (cssX - rect.left) * (SPRITE_W / rect.width);
    const spriteY = (cssY - rect.top) * (SPRITE_H / rect.height);
    if (spriteX < 0 || spriteY < 0 || spriteX >= SPRITE_W || spriteY >= SPRITE_H) {
      return 0;
    }
    return animator.getAlphaAt(animator.currentState, animator.currentFrameIndex, spriteX, spriteY);
  }

  function isPointInsideWindow(winX, winY) {
    return winX >= 0 && winY >= 0 && winX < window.innerWidth && winY < window.innerHeight;
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
          isPassThrough = false;
          solidHitCount = 0;
          consecutivePollErrors = 0;
          lastExitTime = performance.now();
          jsLog("info", "HitTest", "EXIT pass-through");
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
      await pollCursor();
      if (isPassThrough) {
        pollTimerId = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    pollTimerId = setTimeout(tick, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimerId !== null) {
      clearTimeout(pollTimerId);
      pollTimerId = null;
    }
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
        isPassThrough = false;
        solidHitCount = 0;
        consecutivePollErrors = 0;
        lastExitTime = performance.now();
        console.log("[HitTest] Recovery exit succeeded");
        jsLog("info", "HitTest", "Recovery exit succeeded");
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
        exitPassThrough();
        return;
      }

      const alpha = checkAlphaAtCss(winX, winY);

      // Hysteresis: require EXIT_THRESHOLD + consecutive solid frames
      if (alpha >= EXIT_THRESHOLD) {
        solidHitCount++;
        if (solidHitCount >= SOLID_CONFIRM_COUNT) {
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

  /** Normal-mode polling covers the edge case where the cursor is already on
   *  a transparent pixel before the first click, so no mousemove fires to arm
   *  pass-through. */
  async function pollNormalHitTest() {
    if (isPassThrough || applyingPassThrough || !hitTestEnabled || dragStart) return;
    try {
      const [winX, winY] = await invoke("cursor_in_window");
      if (!isPointInsideWindow(winX, winY)) return;

      const alpha = checkAlphaAtCss(winX, winY);
      if (alpha < ENTER_THRESHOLD) {
        enterPassThrough(); // async, non-blocking
      }
    } catch {
      // Best-effort helper only. Mousemove and mousedown guards still protect
      // interactions if the polling IPC is temporarily unavailable.
    }
  }

  function startNormalHitTestPolling() {
    if (normalPollTimerId !== null) return;
    const tick = async () => {
      normalPollTimerId = null;
      await pollNormalHitTest();
      normalPollTimerId = setTimeout(tick, NORMAL_HIT_TEST_POLL_MS);
    };
    normalPollTimerId = setTimeout(tick, NORMAL_HIT_TEST_POLL_MS);
  }

  startNormalHitTestPolling();
  pollNormalHitTest();

  // Triple-click detection: 3 left-clicks within TRIPLE_CLICK_WINDOW_MS
  // triggers a full purge of the sessions directory (see `purge_all` in
  // aggregator.rs). Below 3 clicks the counter simply biases toward the
  // regular jump animation — clicks 1 and 2 still fire jumps, click 3 swaps
  // in the purge. Window kept tight (800ms) on purpose: a purge wipes ALL
  // live sessions, so the cost of a stray trigger is high. A deliberate
  // triple-tap still lands comfortably inside 800ms; the previous 3s window
  // fired on ordinary interaction within 3s.
  let clickCount = 0;
  let lastClickTime = 0;
  const TRIPLE_CLICK_WINDOW_MS = 800;

  // Left click: mousedown → mouseup without drag = click → trigger jump
  // Drag: mousedown → mousemove with threshold → drag window + directional anim
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // left button only
    jsLog("info", "Mouse", `down isPassThrough=${isPassThrough} hitTest=${hitTestEnabled}`);

    // A click can begin without any prior mousemove, especially when the pet
    // window was unfocused. Guard mousedown itself so the first click on a
    // transparent pixel cannot start a drag sequence or trigger the jump on
    // mouseup.
    if (!isPassThrough && hitTestEnabled) {
      const alpha = checkAlphaAtCss(e.clientX, e.clientY);
      if (alpha < ENTER_THRESHOLD) {
        e.preventDefault();
        e.stopPropagation();
        dragStart = null;
        isDragging = false;
        clickCount = 0;
        enterPassThrough(); // async, non-blocking
        jsLog("info", "HitTest", `transparent mousedown ignored alpha=${alpha}`);
        return;
      }
    }

    // Disable hit-test during drag to prevent pass-through interference
    hitTestEnabled = false;
    if (isPassThrough) {
      exitPassThrough(); // async, fire-and-forget
    }
    dragStart = { x: e.screenX, y: e.screenY };
    isDragging = false;
    // Safety timeout: if drag state persists beyond DRAG_TIMEOUT_MS (e.g.
    // mouseup lost after OS-level startDragging), force-reset it.
    clearTimeout(dragTimerId);
    dragTimerId = setTimeout(() => {
      if (isDragging || dragStart) {
        console.warn("[Drag] Timeout — force-resetting stuck drag state");
        jsLog("warn", "Drag", "Timeout — force-resetting stuck drag state");
        if (isDragging) {
          animator.handleDrag(0);
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
        }
        dragStart = null;
        isDragging = false;
        hitTestEnabled = true;
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
    // --- Hit-test: check alpha on every move (normal mode only) ---
    if (!dragStart && !isPassThrough && hitTestEnabled) {
      const alpha = checkAlphaAtCss(e.clientX, e.clientY);
      if (alpha < ENTER_THRESHOLD) {
        enterPassThrough(); // async, non-blocking
        return;
      }
    }

    if (!dragStart || e.button !== 0) return;

    if (!isDragging) {
      const dx = e.screenX - dragStart.x;
      const dy = e.screenY - dragStart.y;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        isDragging = true;
        jsLog("info", "Drag", "startDragging called");
        appWindow.startDragging().catch((error) => {
          console.warn("[Drag] startDragging failed:", error);
          jsLog("error", "Drag", "startDragging failed");
          animator.handleDrag(0);
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          clearTimeout(dragTimerId);
          dragStart = null;
          isDragging = false;
          hitTestEnabled = true;
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
      const dx = e.screenX - dragStart.x;
      // Direction animation only — once startDragging() ran, the OS owns the
      // actual window movement (and may stop delivering further mousemove until
      // release), so we just feed the last-known dx to the animator.
      if (Math.abs(dx) > 0.5) {
        animator.handleDrag(dx);
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
      } else {
        // Single click → trigger jump
        animator.triggerOneShot("jumping");
      }
    }

    dragStart = null;
    isDragging = false;
    hitTestEnabled = true; // re-enable hit-test after drag/click
  });

  // Right-click → context menu
  document.addEventListener("contextmenu", (e) => {
    if (!isPassThrough && hitTestEnabled) {
      const alpha = checkAlphaAtCss(e.clientX, e.clientY);
      if (alpha < ENTER_THRESHOLD) {
        e.preventDefault();
        e.stopPropagation();
        enterPassThrough(); // async, non-blocking
        jsLog("info", "HitTest", `transparent contextmenu ignored alpha=${alpha}`);
        return;
      }
    }

    e.preventDefault();
    // Disable hit-test while menu is visible
    hitTestEnabled = false;
    if (isPassThrough) {
      exitPassThrough();
    }
    contextMenu.classList.remove("hidden");
    const MENU_MARGIN = 4;
    contextMenu.style.left = `${MENU_MARGIN}px`;
    contextMenu.style.top = `${MENU_MARGIN}px`;

    // Clamp menu fully inside the pet window, including the small-window case
    // where the menu must shrink to fit available width.
    const rect = contextMenu.getBoundingClientRect();
    const clampedLeft = Math.max(
      MENU_MARGIN,
      Math.min(e.clientX, window.innerWidth - rect.width - MENU_MARGIN),
    );
    const clampedTop = Math.max(
      MENU_MARGIN,
      Math.min(e.clientY, window.innerHeight - rect.height - MENU_MARGIN),
    );
    contextMenu.style.left = `${clampedLeft}px`;
    contextMenu.style.top = `${clampedTop}px`;
  });

  // Click anywhere else to close menu
  document.addEventListener("click", () => {
    hideAllMenus();
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
    if (isDragging) {
      console.log("[Drag] Reset stuck drag state on window focus");
      jsLog("warn", "Drag", "Reset stuck drag state on window focus");
      animator.handleDrag(0);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      clearTimeout(dragTimerId);
      dragStart = null;
      isDragging = false;
      hitTestEnabled = true;
    }
  });

  // --- Fix 5: Global health check (catch-all safety net) ---
  // Periodically verify state consistency and force-recover from any stuck state.
  setInterval(() => {
    // Pass-through stuck: isPassThrough=true but no polling running
    if (isPassThrough && !applyingPassThrough) {
      if (pollTimerId === null && recoveryPollTimerId === null) {
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
      if (isDragging) {
        animator.handleDrag(0);
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      }
      dragStart = null;
      isDragging = false;
    }
  }, HEALTH_CHECK_MS);
}

// Start
main().catch((e) => console.error("[Main] Fatal:", e));
