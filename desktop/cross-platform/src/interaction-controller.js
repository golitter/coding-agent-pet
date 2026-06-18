import { SPRITE_H, SPRITE_W } from "./animator.js";
import { isMacPlatform } from "./context-menu.js";
import { createSpriteHitTester } from "./hit-test.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

const ENTER_THRESHOLD = 10; // alpha < 10 -> enter pass-through
const EXIT_THRESHOLD = 20; // alpha >= 20 -> exit pass-through (hysteresis)
const SOLID_CONFIRM_COUNT = 2; // consecutive solid frames before exiting
const POLL_INTERVAL_MS = 80; // polling rate while in pass-through mode (80ms ~= 12Hz)
const NORMAL_HIT_TEST_POLL_MS = 120; // helper-only polling during recent activity windows
const NORMAL_HIT_TEST_ACTIVE_MS = 2500; // keep helper polling alive briefly after interaction
const IDLE_HIT_TEST_POLL_MS = 1000; // low idle cadence without polling hard forever
const MAX_EXIT_RETRIES = 3; // retries for setIgnoreCursorEvents(false) on failure
const EXIT_RETRY_BASE_MS = 100; // backoff base: 100ms, 200ms, 300ms
const RECOVERY_POLL_MS = 500; // recovery polling interval when normal exit fails
const DRAG_TIMEOUT_MS = 5000; // max drag duration before force-reset
const HEALTH_CHECK_MS = 3000; // periodic state consistency check
const MAX_CONSECUTIVE_POLL_ERRORS = 10; // poll error threshold to force exit
const HOVER_JUMP_CYCLES = 2;
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
export function setupInteractions({ animator, menu, bubble, petSprite, jsLog }) {
  const appWindow = getCurrentWindow();
  const disposers = [];
  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  };
  let dragStart = null;
  let isDragging = false;
  let lastDragScreenX = null; // last consumed cursor X for incremental drag-delta
  let lastWindowX = null; // last window outerPosition().x (logical px) for drag-direction polling
  let dragScaleFactor = 1; // window scale factor, cached at drag start
  let dragMomX = 0; // low-pass-filtered horizontal velocity for stable direction
  let dragStartedAt = 0; // performance.now() when startDragging() was called
  const DRAG_THRESHOLD = 3;
  // On Windows, startDragging() re-activates the window and fires a `focus`
  // event a few ms later. That focus would otherwise hit the "reset stuck drag"
  // guard below and abort the drag before its first rAF tick — so any focus
  // arriving within this window of the drag start is treated as drag-induced
  // and ignored. macOS fires focus on the *initial* click (before the drag
  // threshold), so it never collides with startDragging and is unaffected.
  const DRAG_FOCUS_GRACE_MS = 300;
  // Per-frame dx is jittery during the OS drag loop (sub-pixel noise, uneven
  // mousemove delivery), so feeding its raw sign flickered the run animation
  // left↔right and reset it on every flip (looked like stutter). dragMomX
  // low-pass-filters dx: a committed direction needs sustained movement, a
  // brief reversal can't overcome the accumulated momentum.
  const DRAG_MOMENTUM_DECAY = 0.6; // fraction of previous momentum retained
  const DRAG_DIR_THRESHOLD = 1.0; // |momentum| needed to commit a direction

  const hitTester = createSpriteHitTester({
    petSprite,
    interactiveElements: [bubble.el, bubble.badgeEl],
    animator,
    spriteWidth: SPRITE_W,
    spriteHeight: SPRITE_H,
  });
  const {
    checkAlphaAtCss,
    checkHoverBodyAlphaAtCss,
    getInteractionAlphaAtCss,
    isPointInsideWindow,
  } = hitTester;

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
  let healthCheckTimerId = null;
  let isHoveringPetBody = false;
  let hitTestEnabled = true;

  menu.setOnHide(() => {
    hitTestEnabled = true;
  });

  function needsHealthCheck() {
    return isPassThrough || applyingPassThrough || isDragging || !!dragStart;
  }

  function stopHealthCheckIfIdle() {
    if (!needsHealthCheck() && healthCheckTimerId !== null) {
      clearTimeout(healthCheckTimerId);
      healthCheckTimerId = null;
    }
  }

  function runHealthCheck() {
    healthCheckTimerId = null;

    if (isPassThrough && !applyingPassThrough) {
      const pollRecentlyActive = performance.now() - lastPassThroughPollAt < POLL_INTERVAL_MS * 4;
      if (
        pollTimerId === null &&
        recoveryPollTimerId === null &&
        !passThroughPollInFlight &&
        !pollRecentlyActive
      ) {
        console.warn("[HealthCheck] Pass-through with no active polling - forcing exit");
        jsLog("warn", "HealthCheck", "pass-through stuck with no polling - forcing exit");
        exitPassThrough();
      }
    }

    if ((isDragging || dragStart) && hitTestEnabled) {
      console.warn("[HealthCheck] Inconsistent drag/hitTest state - resetting drag");
      resetDragState({ reenableHitTest: true });
    }

    if (needsHealthCheck()) {
      healthCheckTimerId = setTimeout(runHealthCheck, HEALTH_CHECK_MS);
    }
  }

  function armHealthCheck() {
    if (healthCheckTimerId !== null) return;
    healthCheckTimerId = setTimeout(runHealthCheck, HEALTH_CHECK_MS);
  }

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
    lastWindowX = null;
    dragMomX = 0;
    if (reenableHitTest) {
      hitTestEnabled = true;
    }
    stopHealthCheckIfIdle();
  }

  function finishPassThroughExit({ logMessage = "EXIT pass-through", debugTag = "info" } = {}) {
    isPassThrough = false;
    solidHitCount = 0;
    consecutivePollErrors = 0;
    lastExitTime = performance.now();
    armNormalHitTestPolling();
    stopHealthCheckIfIdle();
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
      !menu.isVisible() &&
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

  function hideContextMenu() {
    menu.hide();
  }

  function showContextMenuAtPetBottomLeft() {
    menu.showAtPetBottomLeft(petSprite);
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
      !menu.isVisible() &&
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
    armHealthCheck();
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
      stopHealthCheckIfIdle();
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
    armHealthCheck();
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
      stopHealthCheckIfIdle();
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
        const alpha = getInteractionAlphaAtCss(winX, winY);
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
  on(document, "mousedown", (e) => {
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
    armHealthCheck();
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
  // stack), so the OS ignored it and the pet wouldn't move.
  //
  // NOTE: the direction *animation* is NOT driven by mousemove anymore. On
  // Windows, startDragging() enters a modal Win32 drag loop that captures all
  // mouse input, so the webview stops receiving mousemove during the drag
  // (tauri#10767). The old code read e.screenX deltas from mousemove, so on
  // Windows dragMomX stayed ~0 and the run-left/right animation never fired.
  // The rAF loop below now polls the window's own outerPosition() — the thing
  // actually being dragged — which is readable on every platform.
  let pendingMove = null;
  on(document, "mousemove", (e) => {
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
        lastWindowX = null; // seeded on first rAF tick via outerPosition()
        dragScaleFactor = 1;
        dragMomX = 0;
        dragStartedAt = performance.now();
        // Cache scale factor (async) for converting physical px → logical.
        appWindow
          .scaleFactor()
          .then((sf) => {
            dragScaleFactor = sf || 1;
            jsLog("info", "Drag", `scaleFactor=${sf} cached`);
          })
          .catch(() => {});
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
  const processMove = async () => {
    if (isDragging) {
      let dx = 0;
      // Primary signal: the window's own horizontal motion. This works on
      // Windows where mousemove is suppressed during the OS drag loop, and is
      // equivalent on macOS/Linux. outerPosition() is physical px, so divide
      // by scale factor to get logical px matching the original thresholds.
      try {
        const pos = await appWindow.outerPosition();
        const curX = pos.x / dragScaleFactor;
        if (lastWindowX !== null) {
          dx = curX - lastWindowX;
        }
        lastWindowX = curX;
      } catch {
        // outerPosition() unavailable — fall back to the last mousemove.
        if (pendingMove) {
          if (lastDragScreenX === null) lastDragScreenX = pendingMove.screenX;
          dx = pendingMove.screenX - lastDragScreenX;
          lastDragScreenX = pendingMove.screenX;
        }
      }
      pendingMove = null;
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

  on(document, "mouseup", (e) => {
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
  on(document, "contextmenu", (e) => {
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
  on(document, "click", () => {
    hideContextMenu();
    armNormalHitTestPolling();
  });

  on(document, "keydown", (e) => {
    if (e.key === "Escape") {
      hideContextMenu();
      return;
    }

    const quitModifierPressed = isMacPlatform() ? e.metaKey : e.ctrlKey;
    if (quitModifierPressed && e.key.toLowerCase() === "q") {
      e.preventDefault();
      hideContextMenu();
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
  on(window, "focus", () => {
    animator.setFocused(true);
    if (isDragging) {
      // Ignore the focus burst that startDragging() itself causes (notably on
      // Windows, where it re-activates the window ~4ms later). Without this,
      // that focus aborts the drag on its first tick and the run-left/right
      // animation never gets a chance to play. A genuinely stuck drag (mouseup
      // lost after a real native drag) still gets caught: that focus lands far
      // outside the grace window.
      if (performance.now() - dragStartedAt < DRAG_FOCUS_GRACE_MS) {
        jsLog("info", "Drag", "focus within drag-start grace — ignored");
      } else {
        console.log("[Drag] Reset stuck drag state on window focus");
        jsLog("warn", "Drag", "Reset stuck drag state on window focus");
        resetDragState();
      }
    }
    armNormalHitTestPolling();
  });

  on(window, "blur", () => {
    animator.setFocused(false);
    leavePetBodyHover();
    armNormalHitTestPolling();
  });

  on(document, "mouseleave", () => {
    leavePetBodyHover();
  });

  // Health checks are armed only during risky pointer transitions, so the pet
  // does not keep a permanent timer alive while sitting idle.
  return {
    stop() {
      disposers.splice(0).forEach((dispose) => dispose());
      clearTimeout(dragTimerId);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      stopPolling();
      stopRecoveryPolling();
      stopNormalHitTestPolling();
      if (healthCheckTimerId !== null) {
        clearTimeout(healthCheckTimerId);
        healthCheckTimerId = null;
      }
      resetDragState({ restoreAnimation: true, reenableHitTest: true });
      hitTester.dispose();
      menu.hide();
      menu.setOnHide(null);
      appWindow.setIgnoreCursorEvents(false).catch(() => {});
    },
  };
}
