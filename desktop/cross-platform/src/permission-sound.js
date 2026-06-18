/**
 * Permission request sound cue.
 *
 * Plays a short local chime when the pet needs user confirmation. If the
 * packaged WAV cannot be played, a tiny Web Audio chime keeps the cue alive.
 */

const SOUND_PATH = "./sounds/permission-request.wav";
const MIN_REPLAY_INTERVAL_MS = 1200;

export class PermissionSound {
  constructor({ jsLog } = {}) {
    this.jsLog = jsLog || (() => {});
    this.audio = new Audio(SOUND_PATH);
    this.audio.preload = "auto";
    this.lastPlayedAt = 0;
  }

  play() {
    const now = Date.now();
    if (now - this.lastPlayedAt < MIN_REPLAY_INTERVAL_MS) return;
    this.lastPlayedAt = now;

    this.audio.currentTime = 0;
    this.audio.play().catch((error) => {
      this.jsLog("warn", "PermissionSound", `Audio element failed: ${error}`);
      this.playFallbackChime();
    });
  }

  playFallbackChime() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);

      const start = ctx.currentTime;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.72);

      [
        [659.255, 0, 0.22],
        [987.767, 0.2, 0.28],
        [880, 0.42, 0.24],
      ].forEach(([frequency, offset, duration]) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(frequency, start + offset);
        osc.connect(gain);
        osc.start(start + offset);
        osc.stop(start + offset + duration);
      });

      window.setTimeout(() => ctx.close().catch(() => {}), 900);
    } catch (error) {
      this.jsLog("warn", "PermissionSound", `Fallback chime failed: ${error}`);
    }
  }
}
