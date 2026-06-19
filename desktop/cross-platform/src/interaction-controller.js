import { SPRITE_H, SPRITE_W } from "./animator.js";
import { isMacPlatform } from "./context-menu.js";
import { createSpriteHitTester } from "./hit-test.js";

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

const ENTER_THRESHOLD = 10; // alpha < 10 → 进入穿透模式
const EXIT_THRESHOLD = 20; // alpha >= 20 → 退出穿透模式（带迟滞）
const SOLID_CONFIRM_COUNT = 2; // 连续命中不透明像素的帧数，达到后才退出
const POLL_INTERVAL_MS = 80; // 穿透模式下的轮询频率（80ms ≈ 12Hz）
const NORMAL_HIT_TEST_POLL_MS = 120; // 近期活动窗口内的辅助轮询间隔
const NORMAL_HIT_TEST_ACTIVE_MS = 2500; // 交互后让辅助轮询短暂存活的时间
const IDLE_HIT_TEST_POLL_MS = 1000; // 空闲态低频轮询，避免长期高频轮询
const MAX_EXIT_RETRIES = 3; // setIgnoreCursorEvents(false) 失败时的重试次数
const EXIT_RETRY_BASE_MS = 100; // 退避基数：100ms、200ms、300ms
const RECOVERY_POLL_MS = 500; // 正常退出失败时的恢复轮询间隔
const DRAG_TIMEOUT_MS = 5000; // 拖拽超过此时长则强制重置
const HEALTH_CHECK_MS = 3000; // 周期性状态一致性检查
const MAX_CONSECUTIVE_POLL_ERRORS = 10; // 连续轮询错误达到此阈值则强制退出
const HOVER_JUMP_CYCLES = 2;
/**
 * 三连击处理：清除磁盘上所有会话文件并弹出反馈气泡。
 * 不做过期判定：这是用户的“给我一个干净起点”逃生口，所以无视 mtime 一律清除。
 * 两个分支都通过 DialogueBubble 的 AUTO_HIDE_MS 自动淡出（forceAutoHide=true），
 * 因此失败气泡也会淡出，即使“failed”本应是持久态。
 */
async function triggerRedundantCleanup(bubble) {
  try {
    const count = await invoke("purge_all_sessions");
    const text = count > 0 ? `清理了 ${count} 个会话～` : "没有可清理的会话～";
    bubble.show(text, 0, "waving");
  } catch (e) {
    console.error("[TripleClick] purge_all_sessions failed:", e);
    // forceAutoHide：“failed”本应是持久态，但这是一次性用户反馈，
    // 应像成功分支一样淡出。
    bubble.show("清理失败…", 0, "failed", true);
  }
}

/** 设置点击、拖拽、右键处理器，以及逐像素命中检测 */
export function setupInteractions({ animator, menu, bubble, petSprite, jsLog }) {
  const appWindow = getCurrentWindow();
  const disposers = [];
  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    disposers.push(() => target.removeEventListener(type, handler, options));
  };
  let dragStart = null;
  let isDragging = false;
  let lastDragScreenX = null; // 上次已消费的光标 X，用于增量计算拖拽位移
  let lastWindowX = null; // 上次窗口 outerPosition().x（逻辑像素），用于拖拽方向轮询
  let dragScaleFactor = 1; // 窗口缩放系数，拖拽开始时缓存
  let dragMomX = 0; // 低通滤波后的水平速度，用于稳定方向判定
  let dragStartedAt = 0; // 调用 startDragging() 时的 performance.now()
  const DRAG_THRESHOLD = 3;
  // 在 Windows 上，startDragging() 会重新激活窗口并在几毫秒后触发 `focus`
  // 事件。该 focus 否则会命中下面的“重置卡死拖拽”守卫，在拖拽第一个 rAF
  // 帧之前就中止它——因此拖拽开始后这段时间内到达的任何 focus 都被视为
  // 拖拽引起而忽略。macOS 在*初始*点击时（未越过拖拽阈值前）触发 focus，
  // 因此永远不会与 startDragging 冲突，不受影响。
  const DRAG_FOCUS_GRACE_MS = 300;
  // 在系统拖拽循环中，逐帧的 dx 存在抖动（亚像素噪声、mousemove 投递不均），
  // 直接取其符号会让奔跑动画在左↔右之间闪烁，并在每次翻转时重置（看起来像卡顿）。
  // dragMomX 对 dx 做低通滤波：确定方向需要持续移动，短暂的反向无法克服
  // 已累积的动量。
  const DRAG_MOMENTUM_DECAY = 0.6; // 保留上一次动量的比例
  const DRAG_DIR_THRESHOLD = 1.0; // 提交方向所需的 |momentum| 阈值

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

  // --- 穿透态（命中检测）状态 ---
  let isPassThrough = false;
  let applyingPassThrough = false; // 异步守卫，防止快速反复切换
  let pendingExit = false; // 竞态条件下的延迟退出标志
  let pollTimerId = null;
  let recoveryPollTimerId = null; // 正常退出失败时的恢复轮询定时器
  let normalPollTimerId = null; // 单一交互式命中检测轮询定时器
  let normalPollingActive = false; // stop() 后置 false；门控自维持的重调度
  let passThroughPollInFlight = false;
  let lastPassThroughPollAt = 0;
  let normalPollingUntil = 0;
  let solidHitCount = 0;
  let consecutivePollErrors = 0; // 追踪 pollCursor 中连续的 IPC 错误
  let dragTimerId = null; // 拖拽安全超时定时器
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
      exitPassThrough(); // 异步，触发即忘（fire-and-forget）
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

    enterPassThrough(); // 异步，非阻塞
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
  // 合并旧的 hover-poll 与 normal-poll 守卫，使单一合并循环的运行频率
  // 不低于两者中的任何一个。这里有意去掉 !isPassThrough：worker 会根据
  // isPassThrough 分支——在穿透态下走退出路径（旧 hover-poll 的职责），
  // 否则走进入路径。
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

  /** 当前状态是否需要原有的高频（8.3Hz）轮询。
   *  活跃状态——近期交互、悬停跳跃、光标在宠物身体上、穿透态——保持高频节奏；
   *  只有纯粹的空闲稳态才降到 IDLE_HIT_TEST_POLL_MS。正是这一点阻止了宠物
   *  在无事发生时永远以 8.3Hz 轮询 cursor_in_window。 */
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

  // --- 穿透态控制 ---
  let lastExitTime = 0; // 重新进入的冷却时间戳
  const REENTRY_COOLDOWN_MS = 200;

  async function enterPassThrough() {
    if (isPassThrough || applyingPassThrough || !hitTestEnabled) return;
    // 重新进入冷却：防止在精灵边缘快速进出导致闪烁
    if (performance.now() - lastExitTime < REENTRY_COOLDOWN_MS) return;
    applyingPassThrough = true;
    armHealthCheck();
    try {
      await appWindow.setIgnoreCursorEvents(true);
      // 若在 await 期间被请求退出，则立即撤销本次进入
      if (pendingExit) {
        pendingExit = false;
        try {
          await appWindow.setIgnoreCursorEvents(false);
        } catch {}
        jsLog("warn", "HitTest", "enter cancelled — pendingExit was set");
        return; // 留在普通模式
      }
      isPassThrough = true;
      solidHitCount = 0;
      consecutivePollErrors = 0;
      lastPassThroughPollAt = performance.now();
      // 注意：这里不要解除交互式轮询。合并循环会根据 isPassThrough 分支，
      // 因此穿透态下进入路径会被自动跳过，而退出路径（光标回到宠物身体）
      // 仍继续工作——与旧 hover-poll 在穿透期间保持存活的逻辑一致。
      startPolling();
      jsLog("info", "HitTest", "ENTER pass-through");
    } finally {
      applyingPassThrough = false;
      stopHealthCheckIfIdle();
    }
  }

  async function exitPassThrough() {
    if (!isPassThrough) return;
    // 若另一个进入/退出正在进行，则延迟处理而非静默丢弃。
    if (applyingPassThrough) {
      pendingExit = true;
      return;
    }
    applyingPassThrough = true;
    armHealthCheck();
    try {
      stopPolling();
      // 带退避的重试：IPC 调用可能出现瞬时失败。
      for (let attempt = 0; attempt < MAX_EXIT_RETRIES; attempt++) {
        try {
          await appWindow.setIgnoreCursorEvents(false);
          finishPassThroughExit();
          return; // 成功
        } catch (e) {
          console.warn(`[HitTest] exitPassThrough attempt ${attempt + 1} failed:`, e);
          if (attempt < MAX_EXIT_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, EXIT_RETRY_BASE_MS * (attempt + 1)));
          }
        }
      }
      // 所有重试均失败——作为最后手段启动恢复轮询
      console.error("[HitTest] exitPassThrough failed after retries, starting recovery polling");
      jsLog("error", "HitTest", "exit FAILED after retries — recovery polling started");
      startRecoveryPolling();
    } finally {
      applyingPassThrough = false;
      // 若在运行期间收到延迟退出请求，则在此处理
      if (pendingExit && isPassThrough) {
        pendingExit = false;
        exitPassThrough();
      }
      stopHealthCheckIfIdle();
    }
  }

  /** 通过链式 setTimeout 启动轮询——避免 setInterval 在 IPC 调用超过 80ms 时
   *  产生重叠的异步调用。 */
  function startPolling() {
    if (pollTimerId !== null) return;
    stopRecoveryPolling(); // 清理任何残留的恢复定时器
    const tick = async () => {
      // 先清除 ID——我们正在执行，所以不存在挂起的超时。
      // 这防止了在 exitPassThrough() 于链中途将 isPassThrough 置为 false 后，
      // 一个陈旧的 pollTimerId 阻塞下一次 startPolling() 调用。
      pollTimerId = null;
      if (!isPassThrough) return; // 等待期间已被停止
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

  /** 恢复轮询——最后的安全网。在正常 exitPassThrough 所有重试均失败后运行。
   *  周期性地强制调用 setIgnoreCursorEvents(false) 直到成功。
   *  间隔比正常轮询慢，以避免额外开销。 */
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

  /** 穿透态下通过 Rust CGEvent 命令轮询光标位置。当光标移到不透明像素上或
   *  离开窗口时恢复正常模式。
   *
   *  为什么用自定义 Rust 命令：在 `setIgnoreCursorEvents(true)` 激活期间，
   *  tao 的 `cursorPosition()` IPC 会卡住，且 NSEvent.mouseLocation 会变陈旧
   *  （窗口停止处理事件）。CGEvent 则无论如何都能读取到实时的硬件位置。
   *  `cursor_in_window` 返回相对于窗口内容的位置（逻辑像素，Y 轴从顶部起）。 */
  async function pollCursor() {
    try {
      const [winX, winY] = await invoke("cursor_in_window");

      // 光标在透明窗口外 → 恢复，以便宠物能捕获下一次进入。
      // 窗口内部的透明填充区域保持穿透。
      if (!isPointInsideWindow(winX, winY)) {
        leavePetBodyHover();
        exitPassThrough();
        return;
      }

      const alpha = getInteractionAlphaAtCss(winX, winY);

      // 迟滞：要求达到 EXIT_THRESHOLD 且有连续不透明帧
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

  /** 交互式命中检测轮询——即便透明桌面窗口未聚焦、WKWebView 不投递 mousemove
   *  时也保持悬停响应；并在光标回到宠物身体时从穿透态恢复。
   *  替换了原先分离的 hover-poll + normal-poll 循环，那两者在每次 tick 都重复
   *  调用 cursor_in_window IPC。 */
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
        // 光标在穿透态激活期间落回到宠物身体上——把交互交还给窗口
        // （旧 hover-poll 的职责）。
        if (bodyAlpha >= EXIT_THRESHOLD) {
          exitPassThrough();
        }
      } else if (bodyAlpha < ENTER_THRESHOLD) {
        // 普通模式下光标位于透明区域——交给系统处理。
        // （上面的 updatePetBodyHover 已调用 leavePetBodyHover。）
        const alpha = getInteractionAlphaAtCss(winX, winY);
        tryEnterPassThroughAt(winX, winY, { alpha });
      }
    } catch {
      // 仅作尽力而为的辅助。即便轮询 IPC 暂时不可用，
      // mousemove 与 mousedown 守卫仍会保护交互。
    }
  }

  function startNormalHitTestPolling() {
    if (normalPollTimerId !== null) return;
    normalPollingActive = true;
    const tick = async () => {
      normalPollTimerId = null;
      if (!normalPollingActive) return;
      // 用守卫门控 IPC；否则保持 ticking，以便在守卫翻回时（如 agent 停止 →
      // 宠物回到空闲）即便没有鼠标事件来激活，轮询也能恢复——这正是旧
      // 常驻 hover-poll 提供的特性。一次不活跃的 tick 只是一次廉价的 setTimeout。
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

  // 三连击检测：在 TRIPLE_CLICK_WINDOW_MS 内 3 次左键点击会触发对会话目录的
  // 全量清除（见 aggregator.rs 中的 `purge_all`）。单击/双击有意保持无操作；
  // 悬停现在是唯一的本地跳跃触发器。窗口刻意保持紧凑（800ms）：一次清除会
  // 擦除所有活动会话，误触的代价很高。一次刻意的三连击仍能轻松落在 800ms 内；
  // 而旧的 3s 窗口会在普通交互中被触发。
  let clickCount = 0;
  let lastClickTime = 0;
  const TRIPLE_CLICK_WINDOW_MS = 800;

  // 左键点击：mousedown → mouseup 且未拖拽 = 仅计入点击计数
  // 拖拽：mousedown → mousemove 越过阈值 → 拖拽窗口 + 方向动画
  on(document, "mousedown", (e) => {
    if (e.button !== 0) return; // 仅左键
    jsLog("info", "Mouse", `down isPassThrough=${isPassThrough} hitTest=${hitTestEnabled}`);
    armNormalHitTestPolling();

    // 一次点击可能在没有任何前置 mousemove 的情况下开始，尤其是宠物窗口
    // 未聚焦时。对 mousedown 本身也加守卫，使透明像素上的首次点击无法
    // 启动拖拽序列，也不会在 mouseup 时触发跳跃。
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

    // 拖拽期间禁用命中检测，防止穿透态干扰
    beginExclusivePointerInteraction();
    dragStart = { x: e.screenX, y: e.screenY };
    isDragging = false;
    armHealthCheck();
    // 安全超时：若拖拽状态在 DRAG_TIMEOUT_MS 之后仍然存在（例如系统级
    // startDragging 之后丢失了 mouseup），则强制重置。
    clearTimeout(dragTimerId);
    dragTimerId = setTimeout(() => {
      if (isDragging || dragStart) {
        console.warn("[Drag] Timeout — force-resetting stuck drag state");
        jsLog("warn", "Drag", "Timeout — force-resetting stuck drag state");
        resetDragState();
      }
    }, DRAG_TIMEOUT_MS);
  });

  // mousemove 在 ProMotion / 高精度触控板上可达 120Hz。
  //
  // startDragging() 必须在 mousemove 处理器内同步执行：它把控制权交给系统的
  // 原生窗口拖拽循环，而该调用只在受信任的用户手势事件内才被认可。旧代码从
  // requestAnimationFrame 回调中调用它（晚一帧，已脱离事件栈），于是系统忽略它，
  // 宠物无法移动。
  //
  // 注意：方向*动画*不再由 mousemove 驱动。在 Windows 上，startDragging() 进入
  // 一个模态 Win32 拖拽循环，捕获所有鼠标输入，导致 webview 在拖拽期间停止接收
  // mousemove（tauri#10767）。旧代码从 mousemove 读取 e.screenX 增量，因此在
  // Windows 上 dragMomX 一直接近 0，向左/右奔跑的动画从未触发。下面的 rAF 循环
  // 改为轮询窗口自身的 outerPosition()——即真正被拖动的东西——它在所有平台上都可读。
  let pendingMove = null;
  on(document, "mousemove", (e) => {
    const bodyAlpha = checkHoverBodyAlphaAtCss(e.clientX, e.clientY);
    updatePetBodyHover(bodyAlpha);
    const alpha = bodyAlpha >= ENTER_THRESHOLD ? getInteractionAlphaAtCss(e.clientX, e.clientY) : 0;

    // --- 命中检测：每次移动都检查 alpha（仅普通模式） ---
    if (!dragStart && tryEnterPassThroughAt(e.clientX, e.clientY, { alpha })) {
      return;
    }

    if (!dragStart || e.button !== 0) return;

    if (!isDragging) {
      const dx = e.screenX - dragStart.x;
      const dy = e.screenY - dragStart.y;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        isDragging = true;
        lastDragScreenX = e.screenX; // 在拖拽开始时初始化增量追踪
        lastWindowX = null; // 通过 outerPosition() 在首次 rAF tick 时初始化
        dragScaleFactor = 1;
        dragMomX = 0;
        dragStartedAt = performance.now();
        // 异步缓存缩放系数，用于物理像素 → 逻辑像素的换算。
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
        // 为方向动画启动按需 rAF 循环
        rafId = requestAnimationFrame(processMove);
      }
    }
    pendingMove = e;
  });

  // 按需 rAF 循环——仅在拖拽时运行，非永久运行。
  let rafId = null;
  const processMove = async () => {
    if (isDragging) {
      let dx = 0;
      // 主信号：窗口自身的水平位移。这在 mousemove 被系统拖拽循环抑制的
      // Windows 上可用，在 macOS/Linux 上等价。outerPosition() 是物理像素，
      // 因此除以缩放系数得到与原阈值匹配的逻辑像素。
      try {
        const pos = await appWindow.outerPosition();
        const curX = pos.x / dragScaleFactor;
        if (lastWindowX !== null) {
          dx = curX - lastWindowX;
        }
        lastWindowX = curX;
      } catch {
        // outerPosition() 不可用——回退到上一次 mousemove。
        if (pendingMove) {
          if (lastDragScreenX === null) lastDragScreenX = pendingMove.screenX;
          dx = pendingMove.screenX - lastDragScreenX;
          lastDragScreenX = pendingMove.screenX;
        }
      }
      pendingMove = null;
      // 将 dx 平滑成速度（dragMomX），仅当其超过阈值时才提交方向。原始 dx 在
      // 拖拽期间符号抖动，会使动画翻转和卡顿；动量滤波滤除了它，同时在真正的、
      // 持续的反向时仍能在约 1 帧内切换。低于阈值时不调用 handleDrag，因此宠物
      // 保持上一个方向，而不是每帧重置。
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
      animator.handleDrag(0); // 信号：拖拽结束
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    } else if (dragStart) {
      // 点击计数器——在三连击窗口内递增。
      const now = performance.now();
      if (now - lastClickTime < TRIPLE_CLICK_WINDOW_MS) {
        clickCount++;
      } else {
        clickCount = 1;
      }
      lastClickTime = now;

      if (clickCount >= 3) {
        // 三连击 → 清除所有会话。重置计数器，使第 4 次点击不会
        // 连续触发又一次清除。
        clickCount = 0;
        triggerRedundantCleanup(bubble);
      }
    }

    resetDragState({ restoreAnimation: false }); // 动画已在上面按需恢复
    armNormalHitTestPolling();
  });

  // 右键 → 上下文菜单
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
    // 菜单可见期间禁用命中检测
    beginExclusivePointerInteraction();
    showContextMenuAtPetBottomLeft();
  });

  // 点击其他任意位置以关闭菜单
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

  // --- 修复 4b：针对卡死拖拽状态的窗口 focus 恢复 ---
  // 系统级 startDragging() 之后，mouseup 可能无法到达 JS。窗口重新聚焦
  // （原生拖拽完成后发生）是重置的可靠信号。
  // 重要：只检查 isDragging（不检查 dragStart）。在 macOS 上，点击未聚焦的
  // 窗口会触发：mousedown → focus（3ms 后）→ mouseup。若也检查 dragStart，
  // 则每次首次点击未聚焦窗口都会被吞掉——dragStart 在每次 mousedown 时都会
  // 设置，而非仅在实际拖拽时。
  on(window, "focus", () => {
    animator.setFocused(true);
    if (isDragging) {
      // 忽略 startDragging() 自身引起的 focus 突发（尤其在 Windows 上，它
      // 会在约 4ms 后重新激活窗口）。若不忽略，该 focus 会在拖拽首帧就中止它，
      // 向左/右奔跑的动画永无机会播放。真正卡死的拖拽（原生拖拽后丢失 mouseup）
      // 仍会被捕获：那个 focus 落在宽限窗口之外。
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

  // 健康检查仅在风险性指针状态切换期间被激活，因此宠物空闲时不会保持
  // 永久存活的定时器。
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
