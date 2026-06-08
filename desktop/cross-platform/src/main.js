/**
 * Main entry point — equivalent to main.swift + PetWindow.swift interaction handling
 * Wires up all components and handles mouse events.
 */

import { SpriteAnimator } from "./animator.js";
import { DialogueBubble } from "./bubble.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow, LogicalSize, LogicalPosition } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

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

  // 4. Set sprite scale — same as mac: scaledWidth = 192 * scale, scaledHeight = 208 * scale
  const scaledWidth = 192 * config.scale;
  const scaledHeight = 208 * config.scale;
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
  setupInteractions(animator, contextMenu, bubble);

  console.log("[Main] ✓ Pet initialized");
}

/** Set window size and position — matches mac PetWindow dimensions exactly */
async function setupWindow(config, scaledW, scaledH) {
  try {
    const appWindow = getCurrentWindow();

    // Match mac PetWindow frame: w = scale*192 + 24, h = scale*208 + 60
    const windowW = scaledW + 24;
    const windowH = scaledH + 60;

    // Resize window
    await appWindow.setSize(new LogicalSize(windowW, windowH));

    // Position at bottom-right using available screen size
    const margin = config.corner_margin || 20;
    const screenWidth = window.screen.width;
    const screenHeight = window.screen.height;

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
 * slate" escape hatch, so it clears regardless of mtime. Bubble auto-fades
 * after 2.5s unless a state-change event has overwritten it in the meantime
 * (checked by comparing text).
 */
async function triggerRedundantCleanup(bubble) {
  let text;
  try {
    const count = await invoke("purge_all_sessions");
    text = count > 0 ? `清理了 ${count} 个会话～` : "没有可清理的会话～";
    bubble.show(text, 0, "waving");
  } catch (e) {
    console.error("[TripleClick] purge_all_sessions failed:", e);
    text = "清理失败…";
    bubble.show(text, 0, "failed");
  }

  // Auto-hide after 2.5s, but only if no state-change event has replaced the
  // text in the meantime — otherwise we'd clobber a fresh agent update.
  setTimeout(() => {
    if (bubble.textEl.textContent === text) {
      bubble.hide();
    }
  }, 2500);
}

/** Setup click, drag, and right-click handlers */
function setupInteractions(animator, contextMenu, bubble) {
  const appWindow = getCurrentWindow();
  let dragStart = null;
  let isDragging = false;
  const DRAG_THRESHOLD = 3;

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
    dragStart = { x: e.screenX, y: e.screenY };
    isDragging = false;
  });

  // mousemove can fire at 120Hz on ProMotion / high-precision trackpads.
  // Coalesce via rAF so drag state updates happen at most once per frame.
  let pendingMove = null;
  document.addEventListener("mousemove", (e) => {
    if (!dragStart || e.button !== 0) return;
    pendingMove = e;
  });

  const processMove = () => {
    if (pendingMove) {
      const e = pendingMove;
      pendingMove = null;
      const dx = e.screenX - dragStart.x;
      const dy = e.screenY - dragStart.y;

      if (!isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        isDragging = true;
        appWindow.startDragging();
      }

      // Direction animation
      if (isDragging && Math.abs(dx) > 0.5) {
        animator.handleDrag(dx);
      }
    }
    requestAnimationFrame(processMove);
  };
  requestAnimationFrame(processMove);

  document.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;

    if (isDragging) {
      animator.handleDrag(0); // signal: drag ended
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
  });

  // Right-click → context menu
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
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
