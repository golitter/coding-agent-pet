/**
 * 主入口。
 * 将后端配置/事件连接到动画、对话气泡、菜单与交互模块。
 */

import { SpriteAnimator, SPRITE_W, SPRITE_H } from "./animator.js";
import { DialogueBubble } from "./bubble.js";
import { createContextMenu } from "./context-menu.js";
import { setupInteractions } from "./interaction-controller.js";
import { PermissionSound } from "./permission-sound.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow, LogicalSize, LogicalPosition } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const WINDOW_PAD_W = 24;
const WINDOW_PAD_H = 60;

/** 将 JS 桥接到 Rust 日志，用于诊断。会出现在 RUST_LOG 输出中。 */
function jsLog(level, tag, msg) {
  invoke("js_log", { level, tag, msg }).catch(() => {});
}

async function main() {
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

  const animator = new SpriteAnimator();
  animator.setFrameTiming(config.frame_timing);
  await animator.loadFrames(config.frames_dir, config.fps);

  const petSprite = document.getElementById("pet-sprite");
  const bubbleEl = document.getElementById("bubble");
  const bubbleBadgeEl = document.getElementById("bubble-badge");
  const contextMenuEl = document.getElementById("context-menu");

  const scaledWidth = SPRITE_W * config.scale;
  const scaledHeight = SPRITE_H * config.scale;
  petSprite.style.width = `${scaledWidth}px`;
  petSprite.style.height = `${scaledHeight}px`;

  await setupWindow(config, scaledWidth, scaledHeight);

  animator.onFrame = (img) => {
    petSprite.src = img.src;
  };

  const bubble = new DialogueBubble(bubbleEl, bubbleBadgeEl, config);
  const menu = createContextMenu(contextMenuEl);
  const permissionSound = new PermissionSound({ jsLog });

  animator.start();
  jsLog("info", "Main", `Animator started - hitTestReady=${animator.hitTestReady}`);

  bubble.show("准备好了～", 0, "idle");

  let lastPendingPermissionVersion = null;
  const unlistenStateChange = await listen("state-change", (event) => {
    const {
      state,
      dialogue,
      active_count,
      event: hookEvent,
      pending_permission_count = 0,
      pending_permission_version = 0,
    } = event.payload;
    if (
      pending_permission_count > 0 &&
      pending_permission_version !== lastPendingPermissionVersion
    ) {
      permissionSound.play();
    }
    lastPendingPermissionVersion = pending_permission_version;

    if (state !== "idle") {
      animator.stopHoverJump({ showFrame: false });
    }
    if (state === "jumping" || state === "waving") {
      animator.triggerOneShot(state);
    } else {
      animator.transitionTo(state);
    }
    bubble.show(dialogue, active_count, state, false, hookEvent, pending_permission_count);
  });

  menu.build(config.menu_items);
  const interactions = setupInteractions({ animator, menu, bubble, petSprite, jsLog });

  let cleanedUp = false;
  const cleanupMain = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    unlistenStateChange();
    interactions.stop();
    menu.stop();
    animator.stop();
  };

  window.addEventListener("pagehide", () => {
    jsLog("warn", "Main", "pagehide fired");
    cleanupMain();
  });
  window.addEventListener("beforeunload", () => {
    jsLog("warn", "Main", "beforeunload fired");
    cleanupMain();
  });

  console.log("[Main] ✓ Pet initialized");
  jsLog("info", "Main", `Pet initialized - scale=${config.scale} fps=${config.fps}`);
}

/** 设置窗口尺寸与位置——与 mac 端 PetWindow 尺寸完全一致 */
async function setupWindow(config, scaledW, scaledH) {
  try {
    const appWindow = getCurrentWindow();

    const windowW = scaledW + WINDOW_PAD_W;
    const windowH = scaledH + WINDOW_PAD_H;

    // 调整窗口大小
    await appWindow.setSize(new LogicalSize(windowW, windowH));

    // 定位到右下角——使用 Tauri monitor API 以支持多显示器。
    // 不可用时回退到 window.screen（仅主显示器）。
    const margin = config.corner_margin || 20;
    let screenWidth, screenHeight;
    try {
      const monitor = await window.__TAURI__.window.primaryMonitor();
      if (monitor) {
        screenWidth = monitor.size.width / monitor.scaleFactor;
        screenHeight = monitor.size.height / monitor.scaleFactor;
      }
    } catch {
      /* primaryMonitor 不可用——下方回退 */
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

// 启动
main().catch((e) => console.error("[Main] Fatal:", e));
