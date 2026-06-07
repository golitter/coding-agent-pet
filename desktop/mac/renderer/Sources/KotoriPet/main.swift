import AppKit

// ─── Load Config ───

let config = PetConfig()

// ─── Application Setup ───

let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // Don't show in Dock

// Ensure sessions directory exists
try? FileManager.default.createDirectory(atPath: config.sessionsDir, withIntermediateDirectories: true)

// ─── Build Components ───

// 1. Frame cache — pre-load all sprite frames
print("[KotoriPet] Loading frames from \(config.framesDir) ...")
let cache = FrameCache(framesDir: config.framesDir)

// 2. Pet window — transparent floating window
let petWindow = PetWindow(config: config)
petWindow.orderFrontRegardless()
print("[KotoriPet] ✓ Window visible")

// 3. Sprite animator — drives the animation loop
let animator = SpriteAnimator(window: petWindow, cache: cache, fps: config.fps)

// 3b. Bind drag callback for directional animation
petWindow.onDrag = { dx in
    animator.handleDrag(dx: dx)
}

// 3c. Bind click callback for jumping animation
petWindow.onTap = {
    animator.triggerOneShot("jumping")
}

// 4. Session manager — aggregates multi-session state
let sessionManager = SessionManager(sessionsDir: config.sessionsDir)
sessionManager.onStateChange = { state, dialogue, count in
    DispatchQueue.main.async {
        animator.transition(to: state)
        petWindow.updateDialogue(dialogue, sessionCount: count, state: state)
    }
}

// 5. State watcher — socket + directory monitoring
let watcher = StateWatcher(sessionsDir: config.sessionsDir, socketPath: config.socketPath, sessionManager: sessionManager)
watcher.startSocketServer()
watcher.startDirectoryWatch()

// 6. Load any existing sessions from disk
sessionManager.loadFromDisk()

// 7. Start animation
animator.start()

// 8. Initial dialogue
petWindow.updateDialogue("准备好了～", sessionCount: 0, state: "idle")

// 9. Stale session cleanup timer
let cleanupInterval = config.cleanupInterval
let cleanupQueue = DispatchQueue.global(qos: .utility)
let cleanupTimer = DispatchSource.makeTimerSource(queue: cleanupQueue)
cleanupTimer.schedule(deadline: .now() + cleanupInterval, repeating: .milliseconds(Int(cleanupInterval * 1000)))
cleanupTimer.setEventHandler {
    sessionManager.cleanupStale()
}
cleanupTimer.resume()

print("[KotoriPet] ✓ Running. Press Ctrl+C to exit.")

// ─── Run Loop ───
app.run()
