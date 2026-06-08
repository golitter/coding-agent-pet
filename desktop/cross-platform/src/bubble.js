/**
 * Dialogue bubble — equivalent to DialogueBubble.swift
 * Shows text above the pet with 3 styles: normal, warning, error.
 */

/** How long a non-persistent bubble stays visible before auto-fading (ms). */
const AUTO_HIDE_MS = 3000;

/** States that stay visible until the next event replaces them — the agent is
 * actively working, awaiting user input, or in an error state. Everything else
 * (celebrations like jumping/waving, idle greetings, notifications) auto-fades
 * after AUTO_HIDE_MS so the bubble doesn't linger forever. */
const PERSISTENT_STATES = new Set([
  "running",
  "running-left",
  "running-right",
  "waiting",
  "failed",
]);

export class DialogueBubble {
  constructor(element, config) {
    this.el = element;
    this.textEl = element.querySelector("#bubble-text");
    this.countEl = element.querySelector("#bubble-count");
    this.config = config;
    this.currentStyle = "normal";
    this.hideTimer = null;
  }

  /** Show the bubble with text, session count, and state-based style.
   *
   * Persistent states (running/waiting/failed — agent is busy, awaiting input,
   * or errored) stay visible until the next event replaces them. All other
   * states auto-fade after AUTO_HIDE_MS. Pass forceAutoHide=true to override and
   * always fade out — used for one-shot user feedback (e.g. the triple-click
   * purge result) that should never linger even if its state is normally
   * persistent (failed). */
  show(text, sessionCount = 0, state = "idle", forceAutoHide = false) {
    if (!text && sessionCount <= 1) {
      this.hide();
      return;
    }

    // Style comes from config.dialogue.style_map (waiting → warning, failed → error).
    // Default to "normal" for unmapped states.
    const style = (this.config.style_map && this.config.style_map[state]) || "normal";

    this.applyStyle(style);
    this.textEl.textContent = text;
    this.countEl.textContent = sessionCount > 1 ? `×${sessionCount}` : "";

    this.el.classList.remove("hidden");
    this.el.classList.add("visible");

    if (PERSISTENT_STATES.has(state) && !forceAutoHide) {
      this.clearAutoHide();
    } else {
      this.scheduleAutoHide();
    }
  }

  /** Hide the bubble with fade-out */
  hide() {
    this.clearAutoHide();
    this.el.classList.remove("visible");
    this.el.classList.add("hidden");
  }

  /** Start (or reset) the auto-fade timer. Each show() resets it, so a stream
   * of events keeps the bubble alive; it only fades once events stop. */
  scheduleAutoHide() {
    this.clearAutoHide();
    this.hideTimer = setTimeout(() => this.hide(), AUTO_HIDE_MS);
  }

  clearAutoHide() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  applyStyle(style) {
    if (this.currentStyle === style) return;
    this.el.classList.remove("style-normal", "style-warning", "style-error");
    this.el.classList.add(`style-${style}`);
    this.currentStyle = style;
  }
}
