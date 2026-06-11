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
const POLL_INTERVAL_MS = 50; // polling rate while in pass-through mode

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
        getQuitShortcut(),
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
          getQuitShortcut(),
        ),
      );
    } else if (item.action === "applescript" && item.script) {
      menuEl.appendChild(
        createMenuItem(item.title, () => {
          invoke("run_applescript", { script: item.script }).catch((e) =>
            console.error("[Menu] run_applescript failed:", e),
          );
        }),
      );
    }
  }
}

function createMenuItem(title, onClick, shortcut = "") {
  const el = document.createElement("div");
  el.className = "context-menu-item";

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

  // --- Pass-through (hit-test) state ---
  let isPassThrough = false;
  let applyingPassThrough = false; // async guard against rapid toggling
  let pollTimerId = null;
  let solidHitCount = 0;

  // --- Coordinate helpers ---

  /** Check alpha at CSS-relative coords (for normal-mode mousemove).
   *  Uses live getBoundingClientRect() to stay correct across DPI changes. */
  function checkAlphaAtCss(cssX, cssY) {
    const rect = petSprite.getBoundingClientRect();
    const spriteX = (cssX - rect.left) * (SPRITE_W / rect.width);
    const spriteY = (cssY - rect.top) * (SPRITE_H / rect.height);
    return animator.getAlphaAt(animator.currentState, animator.currentFrameIndex, spriteX, spriteY);
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
      isPassThrough = true;
      solidHitCount = 0;
      startPolling();
    } finally {
      applyingPassThrough = false;
    }
  }

  async function exitPassThrough() {
    if (!isPassThrough || applyingPassThrough) return;
    applyingPassThrough = true;
    try {
      stopPolling();
      await appWindow.setIgnoreCursorEvents(false);
      isPassThrough = false;
      solidHitCount = 0;
      lastExitTime = performance.now();
    } finally {
      applyingPassThrough = false;
    }
  }

  /** Start polling via chained setTimeout — prevents overlapping async calls
   *  that could occur with setInterval if the IPC call takes >50ms. */
  function startPolling() {
    if (pollTimerId !== null) return;
    const tick = async () => {
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

      const rect = petSprite.getBoundingClientRect();
      const spriteX = (winX - rect.left) * (SPRITE_W / rect.width);
      const spriteY = (winY - rect.top) * (SPRITE_H / rect.height);

      // Cursor outside sprite bounds → restore
      if (spriteX < 0 || spriteY < 0 || spriteX >= SPRITE_W || spriteY >= SPRITE_H) {
        exitPassThrough();
        return;
      }

      const alpha = animator.getAlphaAt(
        animator.currentState,
        animator.currentFrameIndex,
        spriteX,
        spriteY,
      );

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
      console.warn("[HitTest] Poll error:", e);
    }
  }

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
    // Disable hit-test during drag to prevent pass-through interference
    hitTestEnabled = false;
    if (isPassThrough) {
      exitPassThrough(); // async, fire-and-forget
    }
    dragStart = { x: e.screenX, y: e.screenY };
    isDragging = false;
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
        appWindow.startDragging();
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
    e.preventDefault();
    // Disable hit-test while menu is visible
    hitTestEnabled = false;
    if (isPassThrough) {
      exitPassThrough();
    }
    contextMenu.classList.remove("hidden");
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;

    // Adjust position if menu goes off-screen
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      contextMenu.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      contextMenu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
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
}

// Start
main().catch((e) => console.error("[Main] Fatal:", e));
