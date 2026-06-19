const { invoke } = window.__TAURI__.core;

const CONTEXT_MENU_AUTO_HIDE_MS = 3000;
const POLL_INTERVAL_MS = 80;

export function createContextMenu(menuEl, { invokeFn = invoke, windowRef = window } = {}) {
  let hideTimer = null;
  let leaveTimerId = null;
  let onHide = () => {};

  function build(items) {
    menuEl.innerHTML = "";
    if (!items || items.length === 0) {
      appendQuitMenuItem();
      return;
    }

    let actionableItems = 0;
    for (const item of items) {
      if (item.action === "separator") {
        const sep = document.createElement("div");
        sep.className = "context-menu-separator";
        menuEl.appendChild(sep);
      } else if (item.action === "quit") {
        appendQuitMenuItem(item.title);
        actionableItems++;
      } else if (item.action === "applescript" && item.script) {
        menuEl.appendChild(
          createMenuItem(
            item.title,
            () => {
              invokeFn("run_applescript", { script: item.script }).catch((e) =>
                console.error("[Menu] run_applescript failed:", e),
              );
            },
            { variant: "app" },
          ),
        );
        actionableItems++;
      }
    }

    if (actionableItems === 0) {
      menuEl.innerHTML = "";
      appendQuitMenuItem();
    }
  }

  function appendQuitMenuItem(title = "关闭宠物") {
    menuEl.appendChild(
      createMenuItem(
        title,
        () => {
          invokeFn("quit_app").catch((e) => console.error("[Menu] quit_app failed:", e));
        },
        { shortcut: getQuitShortcut(), variant: "quit" },
      ),
    );
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
      hide();
      onClick();
    });
    return el;
  }

  function showAtPetBottomLeft(petSprite) {
    menuEl.classList.remove("hidden");
    const menuMargin = 4;
    menuEl.style.left = `${menuMargin}px`;
    menuEl.style.top = `${menuMargin}px`;

    // 将菜单锚定到已渲染的宠物身体，而非点击位置。
    const spriteRect = petSprite.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();
    const clampedLeft = Math.max(
      menuMargin,
      Math.min(spriteRect.left, windowRef.innerWidth - menuRect.width - menuMargin),
    );
    const clampedTop = Math.max(
      menuMargin,
      Math.min(
        spriteRect.bottom - menuRect.height,
        windowRef.innerHeight - menuRect.height - menuMargin,
      ),
    );
    menuEl.style.left = `${clampedLeft}px`;
    menuEl.style.top = `${clampedTop}px`;
    scheduleAutoHide();
  }

  function hide() {
    menuEl.classList.add("hidden");
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    stopLeavePoll();
    onHide();
  }

  function isVisible() {
    return !menuEl.classList.contains("hidden");
  }

  function scheduleAutoHide() {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
    }
    hideTimer = setTimeout(() => {
      hide();
    }, CONTEXT_MENU_AUTO_HIDE_MS);
    startLeavePoll();
  }

  function startLeavePoll() {
    stopLeavePoll();
    const tick = async () => {
      if (!isVisible()) return;
      try {
        const [winX, winY] = await invokeFn("cursor_in_window");
        if (winX < 0 || winY < 0 || winX >= windowRef.innerWidth || winY >= windowRef.innerHeight) {
          hide();
          return;
        }
      } catch (e) {
        console.warn("[ContextMenu] leave-poll stopping, falling back to auto-hide:", e);
        return;
      }
      leaveTimerId = setTimeout(tick, POLL_INTERVAL_MS);
    };
    leaveTimerId = setTimeout(tick, POLL_INTERVAL_MS);
  }

  function stopLeavePoll() {
    if (leaveTimerId !== null) {
      clearTimeout(leaveTimerId);
      leaveTimerId = null;
    }
  }

  return {
    build,
    showAtPetBottomLeft,
    hide,
    isVisible,
    setOnHide(callback) {
      onHide = callback || (() => {});
    },
    stop() {
      hide();
      onHide = () => {};
    },
  };
}

export function isMacPlatform() {
  if (navigator.userAgentData) {
    return navigator.userAgentData.platform === "macOS";
  }
  return /mac/i.test(navigator.userAgent);
}

export function getQuitShortcut() {
  return isMacPlatform() ? "⌘ Q" : "Ctrl Q";
}
