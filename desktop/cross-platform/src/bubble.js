/**
 * Dialogue bubble — equivalent to DialogueBubble.swift
 * Shows text above the pet with 3 styles: normal, warning, error.
 */

export class DialogueBubble {
  constructor(element, config) {
    this.el = element;
    this.textEl = element.querySelector("#bubble-text");
    this.countEl = element.querySelector("#bubble-count");
    this.config = config;
    this.currentStyle = "normal";
  }

  /** Show the bubble with text, session count, and state-based style */
  show(text, sessionCount = 0, state = "idle") {
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
  }

  /** Hide the bubble with fade-out */
  hide() {
    this.el.classList.remove("visible");
    this.el.classList.add("hidden");
  }

  applyStyle(style) {
    if (this.currentStyle === style) return;
    this.el.classList.remove("style-normal", "style-warning", "style-error");
    this.el.classList.add(`style-${style}`);
    this.currentStyle = style;
  }
}
