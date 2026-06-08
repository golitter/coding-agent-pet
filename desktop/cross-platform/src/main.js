/**
 * Main entry point — equivalent to main.swift + PetWindow.swift interaction handling
 * Wires up all components and handles mouse events.
 */

import { SpriteAnimator } from './animator.js';
import { DialogueBubble } from './bubble.js';

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

async function main() {
  // 1. Fetch config from Rust backend
  const config = await invoke('get_config');
  console.log('[Main] ✓ Config loaded', config);

  // 2. Create animator
  const animator = new SpriteAnimator();
  await animator.loadFrames(config.frames_dir, config.fps);

  // 3. Get DOM elements
  const petSprite = document.getElementById('pet-sprite');
  const bubbleEl = document.getElementById('bubble');
  const contextMenu = document.getElementById('context-menu');

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
  bubble.show('准备好了～', 0, 'idle');

  // 10. Listen for state changes from backend
  await listen('state-change', (event) => {
    const { state, dialogue, active_count } = event.payload;
    animator.transitionTo(state);
    bubble.show(dialogue, active_count, state);
  });

  // 11. Build context menu from config
  buildContextMenu(contextMenu, config.menu_items);

  // 12. Setup mouse interaction handlers
  setupInteractions(animator, contextMenu);

  console.log('[Main] ✓ Pet initialized');
}

/** Set window size and position — matches mac PetWindow dimensions exactly */
async function setupWindow(config, scaledW, scaledH) {
  try {
    const appWindow = getCurrentWindow();

    // Match mac PetWindow frame: w = scale*192 + 24, h = scale*208 + 60
    const windowW = scaledW + 24;
    const windowH = scaledH + 60;

    // Resize window
    await appWindow.setSize(new window.__TAURI__.window.LogicalSize(windowW, windowH));

    // Position at bottom-right using available screen size
    const margin = config.corner_margin || 20;
    const screenWidth = window.screen.width;
    const screenHeight = window.screen.height;

    const x = screenWidth - windowW - margin;
    const y = screenHeight - windowH - margin;

    await appWindow.setPosition(new window.__TAURI__.window.LogicalPosition(x, y));
  } catch (e) {
    console.warn('[Main] ⚠️ Could not setup window:', e);
  }
}

/** Build the right-click context menu */
function buildContextMenu(menuEl, items) {
  menuEl.innerHTML = '';
  if (!items || items.length === 0) {
    // Fallback menu
    menuEl.appendChild(createMenuItem('关闭宠物', () => {
      invoke('quit_app');
    }, getQuitShortcut()));
    return;
  }

  for (const item of items) {
    if (item.action === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menuEl.appendChild(sep);
    } else if (item.action === 'quit') {
      menuEl.appendChild(createMenuItem(item.title, () => {
        invoke('quit_app');
      }, getQuitShortcut()));
    } else if (item.action === 'applescript' && item.script) {
      menuEl.appendChild(createMenuItem(item.title, () => {
        invoke('run_applescript', { script: item.script });
      }));
    }
  }
}

function createMenuItem(title, onClick, shortcut = '') {
  const el = document.createElement('div');
  el.className = 'context-menu-item';

  const label = document.createElement('span');
  label.className = 'context-menu-label';
  label.textContent = title;
  el.appendChild(label);

  if (shortcut) {
    const shortcutEl = document.createElement('span');
    shortcutEl.className = 'context-menu-shortcut';
    shortcutEl.textContent = shortcut;
    el.appendChild(shortcutEl);
  }

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    hideAllMenus();
    onClick();
  });
  return el;
}

function hideAllMenus() {
  const menus = document.querySelectorAll('.context-menu');
  menus.forEach(m => m.classList.add('hidden'));
}

function isMacPlatform() {
  return navigator.platform.toLowerCase().includes('mac');
}

function getQuitShortcut() {
  return isMacPlatform() ? '⌘ Q' : 'Ctrl Q';
}

/** Setup click, drag, and right-click handlers */
function setupInteractions(animator, contextMenu) {
  const appWindow = getCurrentWindow();
  let dragStart = null;
  let isDragging = false;
  const DRAG_THRESHOLD = 3;

  // Left click: mousedown → mouseup without drag = click → trigger jump
  // Drag: mousedown → mousemove with threshold → drag window + directional anim
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left button only
    dragStart = { x: e.screenX, y: e.screenY };
    isDragging = false;
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragStart || e.button !== 0) return;

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
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;

    if (isDragging) {
      animator.handleDrag(0); // signal: drag ended
    } else if (dragStart) {
      // Single click → trigger jump
      animator.triggerOneShot('jumping');
    }

    dragStart = null;
    isDragging = false;
  });

  // Right-click → context menu
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    contextMenu.classList.remove('hidden');
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
  document.addEventListener('click', () => {
    hideAllMenus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideAllMenus();
      return;
    }

    const quitModifierPressed = isMacPlatform() ? e.metaKey : e.ctrlKey;
    if (quitModifierPressed && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      hideAllMenus();
      invoke('quit_app');
    }
  });
}

// Start
main().catch((e) => console.error('[Main] Fatal:', e));
